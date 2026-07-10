/**
 * MailProvider — the OS-ACCESS SEAM for the Apple Mail source (STRICTLY READ-ONLY).
 *
 * Everything that touches the macOS Mail app lives behind this single interface so
 * the rest of the source (entries, bridge, health) is OS-agnostic and HERMETICALLY
 * TESTABLE. Two implementations:
 *
 *  - `RealMailProvider` (real): shells FIXED `osascript -l JavaScript` (JXA) programs
 *    against Mail.app via Apple Events. The FIRST such call triggers the macOS TCC
 *    Automation consent prompt (System Settings ▸ Privacy & Security ▸ Automation ▸
 *    Mail); a denial surfaces as a precise, actionable reason — never a crash.
 *
 *  - `FakeMailProvider` (fake): a deterministic IN-MEMORY fixture store. Needs NO
 *    macOS permission — used by the unit tests and the hermetic e2e.
 *
 * SELECTION (`selectMailProvider`): real by default; the FAKE when
 * `PLEXUS_FAKE_APPLE === "1"` (the repo-wide fake-Apple convention). A caller may
 * also inject a provider directly via the source/bridge constructor.
 *
 * READ-ONLY BY CONSTRUCTION: the seam has NO draft/send/move/delete/flag method, and
 * the JXA templates below contain no mutating verb (`make`, `send`, `delete`, `move`,
 * `set` never appear) — this source CANNOT change or send mail, at the seam, not just
 * in one implementation.
 *
 * PERFORMANCE (the risk with Mail + AppleScript): big mailboxes are brutally slow to
 * enumerate over Apple Events, so NO script here ever enumerates a whole mailbox:
 *
 *  - `messages.search` narrows in Mail itself via a `whose` filter (sender contains /
 *    subject contains / dateReceived range) — the unfiltered set never crosses the
 *    Apple-Event boundary. Only the FIRST `limit` (hard-capped ≤ 50) matches are read,
 *    ~5 property reads each ⇒ ≤ ~250 round trips worst case.
 *  - With NO filter the script reads messages by INDEX from position 1 — Mail orders a
 *    mailbox newest-first, so "first `limit`" = the newest `limit` messages, without a
 *    count-independent scan.
 *  - TRADEOFF (documented): a `whose … contains` filter is evaluated by Mail per
 *    message; on a very large mailbox it can take seconds-to-tens-of-seconds. We keep
 *    it because the alternative (bulk-reading every message property and filtering in
 *    process) is strictly worse, and we CAP the damage with a hard subprocess timeout
 *    (SIGKILL) per call plus the date-range filter agents are told to prefer. Result
 *    pages are re-sorted newest-first in TS; we trust Mail's index order only for
 *    picking the page (Mail's documented newest-first mailbox order).
 *  - `message.read` locates ONE message via `whose({ id })` (an indexed equality, not
 *    a scan) and truncates the body IN-SCRIPT so an enormous body never crosses the
 *    pipe.
 *  - `mailboxes.list` uses BULK property reads (one Apple Event per property per
 *    account: `mailboxes.name()`, `mailboxes.unreadCount()`), never per-mailbox trips.
 *
 * Every osascript call runs under a HARD TIMEOUT (SIGKILL) so a pathological mailbox
 * degrades to a clear timeout error, never a hung gateway.
 */

import { spawn } from "node:child_process";

// ── §1  Bounds + validation ───────────────────────────────────────────────────

/** Default number of search results when the agent does not pass `limit`. */
export const MAIL_SEARCH_LIMIT_DEFAULT = 20;
/** HARD CAP on search results — a larger `limit` is clamped, never honored. */
export const MAIL_SEARCH_LIMIT_MAX = 50;
/** Snippet length (chars) on each search result. */
export const MAIL_SNIPPET_CHARS = 200;
/** HARD CAP on a message body read (chars) — longer bodies are truncated in-script. */
export const MAIL_CONTENT_MAX_CHARS = 20_000;
/** Smallest honored `maxChars` on message.read (below is clamped up). */
export const MAIL_CONTENT_MIN_CHARS = 200;
/** Max length for sender/subject filter substrings and mailbox/account names. */
export const MAIL_QUERY_MAX_CHARS = 256;

/** Hard subprocess timeouts (ms) — a slow Mail query is killed, never hangs the gateway. */
export const MAIL_PROBE_TIMEOUT_MS = 20_000;
export const MAIL_LIST_TIMEOUT_MS = 30_000;
export const MAIL_SEARCH_TIMEOUT_MS = 60_000;
export const MAIL_READ_TIMEOUT_MS = 30_000;

/** Raised when search/read input fails validation. Carries an agent-legible message. */
export class MailInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailInputError";
  }
}

/** Raised for a recognized macOS TCC (Automation) denial — mapped gracefully upstream. */
export class MailNotAuthorizedError extends Error {
  constructor(message: string = USER_FACING_MAIL_TCC_MESSAGE) {
    super(message);
    this.name = "MailNotAuthorizedError";
  }
}

/** The precise onboarding instruction surfaced when Automation access to Mail is denied. */
export const USER_FACING_MAIL_TCC_MESSAGE =
  "Mail access not granted — approve the Plexus host app in System Settings ▸ " +
  "Privacy & Security ▸ Automation ▸ Mail, then retry.";

/** A VALIDATED search query — only this (re-serialized) shape ever reaches a provider. */
export interface MailSearchQuery {
  /** Mailbox to search (REQUIRED scope — defaults to "INBOX", never "all mail"). */
  mailbox: string;
  /** Optional account name; without it "INBOX" means the unified inbox. */
  account?: string;
  /** Case-insensitive substring filter on the sender header. */
  sender?: string;
  /** Case-insensitive substring filter on the subject. */
  subject?: string;
  /** Inclusive lower bound on dateReceived, epoch ms (validated + re-serialized). */
  sinceMs?: number;
  /** Exclusive-ish upper bound on dateReceived, epoch ms. */
  beforeMs?: number;
  /** Result cap — ALWAYS present after validation (default 20, hard cap 50). */
  limit: number;
}

/** VALIDATED args for reading one message. */
export interface MailReadArgs {
  /** Mail's numeric per-message id (from messages.search). */
  id: number;
  mailbox: string;
  account?: string;
  /** Body char cap (clamped to [200, 20000]; default 20000). */
  maxChars: number;
}

function optionalCappedString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.trim() === "") {
    throw new MailInputError(`\`${key}\`, when present, must be a non-empty string`);
  }
  if (v.length > MAIL_QUERY_MAX_CHARS) {
    throw new MailInputError(`\`${key}\` is too long (max ${MAIL_QUERY_MAX_CHARS} chars)`);
  }
  return v.trim();
}

/** Clamp `limit` into [1, MAIL_SEARCH_LIMIT_MAX]; default MAIL_SEARCH_LIMIT_DEFAULT. */
export function clampSearchLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return MAIL_SEARCH_LIMIT_DEFAULT;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return MAIL_SEARCH_LIMIT_DEFAULT;
  return Math.max(1, Math.min(MAIL_SEARCH_LIMIT_MAX, Math.floor(n)));
}

/**
 * Parse + validate a `messages.search` input. The agent's raw values NEVER flow
 * onward: strings are trimmed + length-capped, dates are parsed to epoch-ms and
 * re-serialized, `limit` is clamped into [1, 50] (default 20 — the search is ALWAYS
 * bounded). `mailbox` defaults to "INBOX" so a search is always mailbox-scoped.
 */
export function validateSearchInput(input: Record<string, unknown>): MailSearchQuery {
  const mailbox = optionalCappedString(input, "mailbox") ?? "INBOX";
  const account = optionalCappedString(input, "account");
  const sender = optionalCappedString(input, "sender");
  const subject = optionalCappedString(input, "subject");

  let sinceMs: number | undefined;
  let beforeMs: number | undefined;
  const since = optionalCappedString(input, "since");
  const before = optionalCappedString(input, "before");
  if (since !== undefined) {
    sinceMs = Date.parse(since);
    if (!Number.isFinite(sinceMs)) {
      throw new MailInputError(`\`since\` is not a valid ISO date: ${JSON.stringify(since)}`);
    }
  }
  if (before !== undefined) {
    beforeMs = Date.parse(before);
    if (!Number.isFinite(beforeMs)) {
      throw new MailInputError(`\`before\` is not a valid ISO date: ${JSON.stringify(before)}`);
    }
  }
  if (sinceMs !== undefined && beforeMs !== undefined && beforeMs <= sinceMs) {
    throw new MailInputError("`before` must be strictly after `since`");
  }

  return {
    mailbox,
    ...(account ? { account } : {}),
    ...(sender ? { sender } : {}),
    ...(subject ? { subject } : {}),
    ...(sinceMs !== undefined ? { sinceMs } : {}),
    ...(beforeMs !== undefined ? { beforeMs } : {}),
    limit: clampSearchLimit(input.limit),
  };
}

/** Parse + validate a `message.read` input (`id` required; `maxChars` clamped). */
export function validateReadInput(input: Record<string, unknown>): MailReadArgs {
  const rawId = input.id;
  const id =
    typeof rawId === "number"
      ? rawId
      : typeof rawId === "string" && rawId.trim() !== ""
        ? Number.parseInt(rawId.trim(), 10)
        : Number.NaN;
  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
    throw new MailInputError("`id` is required and must be a positive integer message id (from messages.search)");
  }
  const mailbox = optionalCappedString(input, "mailbox") ?? "INBOX";
  const account = optionalCappedString(input, "account");

  let maxChars = MAIL_CONTENT_MAX_CHARS;
  if (input.maxChars !== undefined && input.maxChars !== null) {
    const n = typeof input.maxChars === "number" ? input.maxChars : Number.parseInt(String(input.maxChars), 10);
    if (!Number.isFinite(n)) throw new MailInputError("`maxChars`, when present, must be a number");
    maxChars = Math.max(MAIL_CONTENT_MIN_CHARS, Math.min(MAIL_CONTENT_MAX_CHARS, Math.floor(n)));
  }
  return { id, mailbox, ...(account ? { account } : {}), maxChars };
}

// ── §2  Output shapes ─────────────────────────────────────────────────────────

export interface MailboxInfo {
  name: string;
  unreadCount: number;
}

export interface MailAccountMailboxes {
  account: string;
  mailboxes: MailboxInfo[];
}

export interface MailboxesListResult {
  accounts: MailAccountMailboxes[];
}

export interface MailMessageSummary {
  /** Mail's numeric message id, stringified (pass to message.read). */
  id: string;
  sender: string;
  subject: string;
  /** ISO-8601 dateReceived. */
  date: string;
  /** First ~200 chars of the plain-text body, whitespace-normalized. */
  snippet: string;
  mailbox: string;
}

export interface MessagesSearchResult {
  messages: MailMessageSummary[];
  /** Total matches in the mailbox (may exceed messages.length). */
  total: number;
  /** True when more matched than the `limit` cap returned. */
  truncated: boolean;
}

export interface MessageReadResult {
  id: string;
  sender: string;
  subject: string;
  date: string;
  mailbox: string;
  /** Plain-text body, truncated to the char cap. */
  content: string;
  /** True when the body was longer than the cap and got cut. */
  truncated: boolean;
  /** The body's full length before truncation. */
  totalChars: number;
}

/** Result of the availability probe — the source's health() reads this. */
export interface MailAvailability {
  ok: boolean;
  /** Precise, actionable reason when !ok (e.g. the Automation onboarding message). */
  reason?: string;
}

// ── §3  The OS-access seam ────────────────────────────────────────────────────

/**
 * The seam the apple-mail source reads through. EVERY method is READ-ONLY — there is
 * no draft/send/move/delete/flag anywhere on the interface, so the read-only guarantee
 * holds at the seam, not just in one implementation.
 */
export interface MailProvider {
  /**
   * Probe whether Mail is reachable RIGHT NOW (app scriptable + Automation TCC granted
   * for the real provider; always ok for the fake). NEVER throws — a denial/timeout
   * degrades to `{ ok:false, reason }` with a precise onboarding message.
   */
  available(): Promise<MailAvailability>;
  /** READ-ONLY: accounts + their mailboxes with unread counts. */
  listMailboxes(): Promise<MailboxesListResult>;
  /** READ-ONLY: bounded search within ONE mailbox (validated query). */
  searchMessages(query: MailSearchQuery): Promise<MessagesSearchResult>;
  /** READ-ONLY: one message's plain-text content by id (validated, char-capped). */
  readMessage(args: MailReadArgs): Promise<MessageReadResult>;
}

// ── §4  FIXED JXA script templates (no agent-controlled script body) ──────────
//
// CONSTANT `osascript -l JavaScript` programs. The ONLY dynamic data they receive is
// one JSON document of VALIDATED, re-serialized values, fed via the JXA `run(argv)`
// argument vector — agent text is passed as DATA (argv), never string-interpolated
// into the script source, so "no arbitrary script execution" is true by construction.
// None of these templates contains a mutating verb — read-only by construction.

/** Shared mailbox-locator, inlined into the search/read scripts. Bulk name reads only. */
const MAIL_FINDBOX_JS = `
function mailboxByName(container, name) {
  var names = container.mailboxes.name(); // ONE bulk Apple Event
  for (var i = 0; i < names.length; i++) {
    if (String(names[i]) === name) return container.mailboxes[i];
  }
  throw new Error("apple-mail: no mailbox named " + name);
}
function findBox(Mail, account, name) {
  if (account) {
    var accts = Mail.accounts;
    var names = accts.name();
    for (var i = 0; i < names.length; i++) {
      if (String(names[i]) === account) return mailboxByName(accts[i], name);
    }
    throw new Error("apple-mail: no account named " + account);
  }
  if (name.toUpperCase() === "INBOX") return Mail.inbox; // the unified inbox
  var accts2 = Mail.accounts;
  var n2 = accts2.length;
  for (var j = 0; j < n2; j++) {
    try { return mailboxByName(accts2[j], name); } catch (e) {}
  }
  return mailboxByName(Mail, name); // top-level local ("On My Mac") mailboxes
}
`.trim();

/** Liveness probe: count accounts (triggers the Automation TCC prompt on first run). */
export const MAIL_PROBE_JS = `
function run() {
  var Mail = Application("Mail");
  return JSON.stringify({ ok: true, accounts: Mail.accounts.length });
}
`.trim();

/**
 * Accounts + mailboxes with unread counts. BULK property reads only — one Apple Event
 * per property per account (mailboxes.name(), mailboxes.unreadCount()), never a
 * per-mailbox round trip.
 */
export const MAIL_LIST_MAILBOXES_JS = `
function run() {
  var Mail = Application("Mail");
  var accts = Mail.accounts;
  var acctNames = accts.name(); // bulk
  var out = [];
  for (var i = 0; i < acctNames.length; i++) {
    var names = accts[i].mailboxes.name();          // bulk
    var unread = accts[i].mailboxes.unreadCount();  // bulk
    var boxes = [];
    for (var j = 0; j < names.length; j++) {
      boxes.push({ name: String(names[j]), unreadCount: Number(unread[j]) || 0 });
    }
    out.push({ account: String(acctNames[i]), mailboxes: boxes });
  }
  return JSON.stringify({ accounts: out });
}
`.trim();

/**
 * Bounded search: argv[0] = the validated query JSON. Narrows via \`whose\` INSIDE Mail
 * (sender/subject contains — case-insensitive per Apple-Event semantics — and a
 * dateReceived range) so the unfiltered mailbox never crosses the wire; with no filter
 * it reads by index from position 1 (Mail orders mailboxes newest-first). Reads AT MOST
 * \`limit\` (≤ 50) messages, ~5 properties each. \`total\` is one count Apple Event.
 */
export const MAIL_SEARCH_JS = `
${MAIL_FINDBOX_JS}
function run(argv) {
  var q = JSON.parse(argv[0]);
  var Mail = Application("Mail");
  var box = findBox(Mail, q.account || null, q.mailbox);
  var msgs = box.messages;
  var conds = [];
  if (q.sender) conds.push({ sender: { _contains: q.sender } });
  if (q.subject) conds.push({ subject: { _contains: q.subject } });
  if (q.sinceMs) conds.push({ dateReceived: { _greaterThan: new Date(q.sinceMs) } });
  if (q.beforeMs) conds.push({ dateReceived: { _lessThan: new Date(q.beforeMs) } });
  if (conds.length === 1) msgs = msgs.whose(conds[0]);
  if (conds.length > 1) msgs = msgs.whose({ _and: conds });
  var total = msgs.length; // one count Apple Event — never a full enumeration
  var n = Math.min(total, q.limit);
  var out = [];
  for (var i = 0; i < n; i++) {
    var m = msgs[i];
    var snippet = "";
    try { snippet = String(m.content() || "").slice(0, 400); } catch (e) { snippet = ""; }
    out.push({
      id: String(m.id()),
      sender: String(m.sender() || ""),
      subject: String(m.subject() || ""),
      date: m.dateReceived().toISOString(),
      snippet: snippet,
      mailbox: q.mailbox
    });
  }
  return JSON.stringify({ messages: out, total: total, truncated: total > n });
}
`.trim();

/**
 * Read ONE message by numeric id: argv[0] = the validated args JSON. Locates the
 * message via \`whose({ id })\` (an equality lookup, not a scan) and truncates the body
 * IN-SCRIPT to \`maxChars\` so an enormous body never crosses the pipe.
 */
export const MAIL_READ_MESSAGE_JS = `
${MAIL_FINDBOX_JS}
function run(argv) {
  var q = JSON.parse(argv[0]);
  var Mail = Application("Mail");
  var box = findBox(Mail, q.account || null, q.mailbox);
  var matches = box.messages.whose({ id: q.id });
  if (matches.length === 0) {
    throw new Error("apple-mail: no message with id " + q.id + " in mailbox " + q.mailbox);
  }
  var m = matches[0];
  var content = "";
  try { content = String(m.content() || ""); } catch (e) { content = ""; }
  var totalChars = content.length;
  var truncated = totalChars > q.maxChars;
  if (truncated) content = content.slice(0, q.maxChars);
  return JSON.stringify({
    id: String(m.id()),
    sender: String(m.sender() || ""),
    subject: String(m.subject() || ""),
    date: m.dateReceived().toISOString(),
    mailbox: q.mailbox,
    content: content,
    truncated: truncated,
    totalChars: totalChars
  });
}
`.trim();

// ── §5  Shared helpers ────────────────────────────────────────────────────────

/** Whitespace-normalize + cap a body slice into a search snippet. */
export function makeSnippet(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, MAIL_SNIPPET_CHARS);
}

/** Recognize the macOS TCC / Automation denial in osascript stderr. */
export function isMailNotAuthorized(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    stderr.includes("-1743") ||
    s.includes("not authorized") ||
    s.includes("not allowed") ||
    s.includes("doesn't have permission") ||
    s.includes("does not have permission") ||
    s.includes("not permitted")
  );
}

/** A raw spawn-and-capture result. */
export interface OsaCapture {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True when the hard timeout killed the process. */
  timedOut: boolean;
}

/** Injectable runner for `osascript -l JavaScript -e <script> [jsonArg]` with a HARD timeout. */
export type OsaRunner = (script: string, args: string[], timeoutMs: number) => Promise<OsaCapture>;

/** DEFAULT runner: spawn real osascript (argv array, NO shell) and SIGKILL on timeout. */
export const defaultMailOsascript: OsaRunner = (script, args, timeoutMs) =>
  new Promise<OsaCapture>((resolve) => {
    const child = spawn("osascript", ["-l", "JavaScript", "-e", script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* best-effort */
      }
    }, timeoutMs);
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (c: string) => (stdout += c));
    child.stderr?.on("data", (c: string) => (stderr += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), exitCode: -1, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });
  });

function parseJson(stdout: string, what: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === "") throw new Error(`apple-mail: empty ${what} output from osascript`);
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`apple-mail: could not parse ${what} output as JSON: ${trimmed.slice(0, 200)}`);
  }
}

// ── §6  REAL provider — shells the fixed JXA templates ────────────────────────

/** Construction knobs (timeouts injectable for tests). */
export interface RealMailProviderOptions {
  run?: OsaRunner;
  searchTimeoutMs?: number;
  readTimeoutMs?: number;
  listTimeoutMs?: number;
  probeTimeoutMs?: number;
}

/**
 * REAL provider. Every method shells one FIXED JXA template under a HARD timeout.
 * A TCC/Automation denial → `MailNotAuthorizedError` (graceful upstream); a timeout →
 * a clear "narrow your search" error, never a hang.
 */
export class RealMailProvider implements MailProvider {
  private readonly run: OsaRunner;
  private readonly timeouts: { probe: number; list: number; search: number; read: number };

  constructor(opts: RealMailProviderOptions = {}) {
    this.run = opts.run ?? defaultMailOsascript;
    this.timeouts = {
      probe: opts.probeTimeoutMs ?? MAIL_PROBE_TIMEOUT_MS,
      list: opts.listTimeoutMs ?? MAIL_LIST_TIMEOUT_MS,
      search: opts.searchTimeoutMs ?? MAIL_SEARCH_TIMEOUT_MS,
      read: opts.readTimeoutMs ?? MAIL_READ_TIMEOUT_MS,
    };
  }

  private async exec(script: string, args: string[], timeoutMs: number, op: string): Promise<string> {
    const res = await this.run(script, args, timeoutMs);
    if (res.timedOut) {
      throw new Error(
        `apple-mail: ${op} timed out after ${Math.round(timeoutMs / 1000)}s — the mailbox may be very ` +
          "large; narrow the search (add sender/subject/date filters or pick a smaller mailbox)",
      );
    }
    if (isMailNotAuthorized(res.stderr)) throw new MailNotAuthorizedError();
    if (res.exitCode !== 0) {
      throw new Error(`apple-mail: ${op} failed (code ${res.exitCode}): ${res.stderr.trim().slice(0, 200)}`);
    }
    return res.stdout;
  }

  async available(): Promise<MailAvailability> {
    try {
      const res = await this.run(MAIL_PROBE_JS, [], this.timeouts.probe);
      if (res.timedOut) return { ok: false, reason: "Mail unavailable — probe timed out (is Mail responsive?)" };
      if (isMailNotAuthorized(res.stderr)) return { ok: false, reason: USER_FACING_MAIL_TCC_MESSAGE };
      if (res.exitCode !== 0) {
        return { ok: false, reason: `Mail unavailable — osascript failed (code ${res.exitCode}): ${res.stderr.trim().slice(0, 160)}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `Mail unavailable — could not run osascript: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async listMailboxes(): Promise<MailboxesListResult> {
    const stdout = await this.exec(MAIL_LIST_MAILBOXES_JS, [], this.timeouts.list, "mailboxes.list");
    const parsed = parseJson(stdout, "mailboxes") as { accounts?: unknown };
    if (!Array.isArray(parsed.accounts)) throw new Error("apple-mail: malformed mailboxes payload");
    const accounts: MailAccountMailboxes[] = parsed.accounts.map((raw) => {
      const a = (raw ?? {}) as Record<string, unknown>;
      const boxes = Array.isArray(a.mailboxes) ? a.mailboxes : [];
      return {
        account: typeof a.account === "string" ? a.account : "",
        mailboxes: boxes.map((b) => {
          const box = (b ?? {}) as Record<string, unknown>;
          return {
            name: typeof box.name === "string" ? box.name : "",
            unreadCount: typeof box.unreadCount === "number" ? box.unreadCount : 0,
          };
        }),
      };
    });
    return { accounts };
  }

  async searchMessages(query: MailSearchQuery): Promise<MessagesSearchResult> {
    // Only the VALIDATED, re-serialized query crosses into the script — as argv DATA.
    const stdout = await this.exec(MAIL_SEARCH_JS, [JSON.stringify(query)], this.timeouts.search, "messages.search");
    const parsed = parseJson(stdout, "search") as { messages?: unknown; total?: unknown; truncated?: unknown };
    if (!Array.isArray(parsed.messages)) throw new Error("apple-mail: malformed search payload");
    const messages: MailMessageSummary[] = parsed.messages.map((raw) => {
      const m = (raw ?? {}) as Record<string, unknown>;
      return {
        id: typeof m.id === "string" ? m.id : String(m.id ?? ""),
        sender: typeof m.sender === "string" ? m.sender : "",
        subject: typeof m.subject === "string" ? m.subject : "",
        date: typeof m.date === "string" ? m.date : "",
        snippet: makeSnippet(typeof m.snippet === "string" ? m.snippet : ""),
        mailbox: typeof m.mailbox === "string" ? m.mailbox : query.mailbox,
      };
    });
    // Trust Mail's order only for page selection; present the page newest-first.
    messages.sort((a, b) => Date.parse(b.date || "") - Date.parse(a.date || ""));
    return {
      messages,
      total: typeof parsed.total === "number" ? parsed.total : messages.length,
      truncated: parsed.truncated === true,
    };
  }

  async readMessage(args: MailReadArgs): Promise<MessageReadResult> {
    const stdout = await this.exec(MAIL_READ_MESSAGE_JS, [JSON.stringify(args)], this.timeouts.read, "message.read");
    const parsed = parseJson(stdout, "read") as Record<string, unknown>;
    return {
      id: typeof parsed.id === "string" ? parsed.id : String(parsed.id ?? ""),
      sender: typeof parsed.sender === "string" ? parsed.sender : "",
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      date: typeof parsed.date === "string" ? parsed.date : "",
      mailbox: typeof parsed.mailbox === "string" ? parsed.mailbox : args.mailbox,
      content: typeof parsed.content === "string" ? parsed.content : "",
      truncated: parsed.truncated === true,
      totalChars: typeof parsed.totalChars === "number" ? parsed.totalChars : 0,
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// FAKE PROVIDER — deterministic in-memory fixtures (PLEXUS_FAKE_APPLE=1 / tests).
// ════════════════════════════════════════════════════════════════════════════════

/** One fixture message (internal shape; account+mailbox locate it like real Mail). */
export interface FakeMailMessage {
  id: string;
  account: string;
  mailbox: string;
  sender: string;
  subject: string;
  /** ISO dateReceived. */
  date: string;
  /** Full plain-text body. */
  content: string;
  read: boolean;
}

/** Deterministic sample accounts/mailboxes/messages (mid-2026, stable + assertable). */
export function fakeMailFixtures(): { accounts: MailAccountMailboxes[]; messages: FakeMailMessage[] } {
  return {
    accounts: [
      {
        account: "iCloud",
        mailboxes: [
          { name: "INBOX", unreadCount: 2 },
          { name: "Archive", unreadCount: 0 },
        ],
      },
      {
        account: "Work",
        mailboxes: [
          { name: "INBOX", unreadCount: 1 },
          { name: "Newsletters", unreadCount: 3 },
        ],
      },
    ],
    messages: [
      {
        id: "101",
        account: "iCloud",
        mailbox: "INBOX",
        sender: "Dana Chen <dana@example.com>",
        subject: "Lunch tomorrow?",
        date: "2026-06-24T18:00:00.000Z",
        content: "Hey — want to grab lunch tomorrow at noon?\n\n— Dana",
        read: false,
      },
      {
        id: "102",
        account: "iCloud",
        mailbox: "INBOX",
        sender: "Plexus CI <ci@example.com>",
        subject: "Build #442 passed",
        date: "2026-06-25T09:15:00.000Z",
        content: "All 731 tests green. Coverage 89.6%.",
        read: false,
      },
      {
        id: "103",
        account: "Work",
        mailbox: "INBOX",
        sender: "Maya Ortiz <maya@work.example>",
        subject: "Q3 roadmap review",
        date: "2026-06-23T14:30:00.000Z",
        // A LONG body so content-truncation is deterministically testable.
        content: `Hi team,\n\nAhead of Thursday's Q3 roadmap review, please read the attached brief. ${"Roadmap item detail. ".repeat(60)}\n\nThanks,\nMaya`,
        read: true,
      },
      {
        id: "104",
        account: "Work",
        mailbox: "Newsletters",
        sender: "API Weekly <digest@apiweekly.example>",
        subject: "Issue 88: local-first gateways",
        date: "2026-06-20T07:00:00.000Z",
        content: "This week: local-first capability gateways, scoped tokens, and more.",
        read: false,
      },
      {
        id: "105",
        account: "iCloud",
        mailbox: "Archive",
        sender: "Dana Chen <dana@example.com>",
        subject: "Re: weekend plans",
        date: "2026-05-30T12:00:00.000Z",
        content: "Sounds good, see you Saturday!",
        read: true,
      },
    ],
  };
}

/** Construction options for the fake provider. */
export interface FakeMailProviderOptions {
  accounts?: MailAccountMailboxes[];
  messages?: FakeMailMessage[];
  /** Force the un-granted (Automation TCC) state — available() reports, reads throw. */
  notAuthorized?: boolean;
}

/**
 * In-memory fake. Mirrors the real provider's semantics: mailbox-scoped search with
 * case-insensitive sender/subject contains + date range, newest-first, `limit` cap +
 * `truncated` flag; message.read honors `maxChars`. `available()` is always ok unless
 * constructed `notAuthorized` (which mirrors the real denial path without macOS).
 */
export class FakeMailProvider implements MailProvider {
  private readonly accounts: MailAccountMailboxes[];
  private readonly messages: FakeMailMessage[];
  private readonly notAuthorized: boolean;

  constructor(opts: FakeMailProviderOptions = {}) {
    const base = fakeMailFixtures();
    this.accounts = opts.accounts ?? base.accounts;
    this.messages = opts.messages ?? base.messages;
    this.notAuthorized = opts.notAuthorized ?? false;
  }

  async available(): Promise<MailAvailability> {
    return this.notAuthorized ? { ok: false, reason: USER_FACING_MAIL_TCC_MESSAGE } : { ok: true };
  }

  async listMailboxes(): Promise<MailboxesListResult> {
    if (this.notAuthorized) throw new MailNotAuthorizedError();
    return { accounts: this.accounts.map((a) => ({ account: a.account, mailboxes: a.mailboxes.map((m) => ({ ...m })) })) };
  }

  /** Scope like the real script: account+mailbox, or the unified INBOX, or first account owning the mailbox. */
  private inScope(m: FakeMailMessage, query: { account?: string; mailbox: string }): boolean {
    if (query.account) return m.account === query.account && m.mailbox === query.mailbox;
    if (query.mailbox.toUpperCase() === "INBOX") return m.mailbox.toUpperCase() === "INBOX";
    const owner = this.accounts.find((a) => a.mailboxes.some((b) => b.name === query.mailbox));
    return owner !== undefined && m.account === owner.account && m.mailbox === query.mailbox;
  }

  async searchMessages(query: MailSearchQuery): Promise<MessagesSearchResult> {
    if (this.notAuthorized) throw new MailNotAuthorizedError();
    const sender = query.sender?.toLowerCase();
    const subject = query.subject?.toLowerCase();
    const matches = this.messages
      .filter((m) => this.inScope(m, query))
      .filter((m) => (sender ? m.sender.toLowerCase().includes(sender) : true))
      .filter((m) => (subject ? m.subject.toLowerCase().includes(subject) : true))
      .filter((m) => (query.sinceMs !== undefined ? Date.parse(m.date) > query.sinceMs : true))
      .filter((m) => (query.beforeMs !== undefined ? Date.parse(m.date) < query.beforeMs : true))
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date)); // newest-first
    const page = matches.slice(0, query.limit);
    return {
      messages: page.map((m) => ({
        id: m.id,
        sender: m.sender,
        subject: m.subject,
        date: m.date,
        snippet: makeSnippet(m.content),
        mailbox: m.mailbox,
      })),
      total: matches.length,
      truncated: matches.length > page.length,
    };
  }

  async readMessage(args: MailReadArgs): Promise<MessageReadResult> {
    if (this.notAuthorized) throw new MailNotAuthorizedError();
    const found = this.messages.find((m) => m.id === String(args.id) && this.inScope(m, args));
    if (!found) {
      throw new Error(`apple-mail: no message with id ${args.id} in mailbox ${args.mailbox}`);
    }
    const totalChars = found.content.length;
    const truncated = totalChars > args.maxChars;
    return {
      id: found.id,
      sender: found.sender,
      subject: found.subject,
      date: found.date,
      mailbox: found.mailbox,
      content: truncated ? found.content.slice(0, args.maxChars) : found.content,
      truncated,
      totalChars,
    };
  }
}

/**
 * SELECT the provider: an explicitly-injected one wins; otherwise the FAKE when
 * `PLEXUS_FAKE_APPLE === "1"` (the repo-wide fake-Apple convention — hermetic tests +
 * e2e), else the REAL osascript provider. Read fresh each call.
 */
export function selectMailProvider(injected?: MailProvider): MailProvider {
  if (injected) return injected;
  if (process.env.PLEXUS_FAKE_APPLE === "1") return new FakeMailProvider();
  return new RealMailProvider();
}
