/**
 * ContactsProvider — the OS-ACCESS SEAM for the Apple Contacts source (READ-ONLY).
 *
 * Everything that touches the macOS Contacts app lives behind this single interface
 * so the rest of the source (entries, bridge, health) is OS-agnostic and hermetically
 * testable. Two implementations:
 *
 *  - `RealContactsProvider` (real): shells FIXED `osascript -l JavaScript` (JXA)
 *    programs against Contacts.app via Apple Events. The FIRST such call triggers the
 *    macOS TCC Automation consent prompt (System Settings ▸ Privacy & Security ▸
 *    Automation ▸ Contacts); a denial surfaces as a precise, actionable reason.
 *
 *  - `FakeContactsProvider` (fake): a deterministic IN-MEMORY fixture store. Needs NO
 *    macOS permission — used by the unit tests and the hermetic e2e.
 *
 * SELECTION (`selectContactsProvider`): real by default; the FAKE when
 * `PLEXUS_FAKE_APPLE === "1"` (the repo-wide fake-Apple convention). A caller may
 * also inject a provider directly via the source/bridge constructor.
 *
 * READ-ONLY BY CONSTRUCTION: the seam has NO create/update/delete method, and the JXA
 * templates contain no mutating verb (`make`, `delete`, `save`, `set` never appear) —
 * this source CANNOT change the user's contacts, at the seam.
 *
 * PERFORMANCE: an address book is small next to a mailbox (hundreds to a few thousand
 * cards), so the search script does a CONSTANT number of BULK Apple Events — one per
 * property across ALL people (`people.id()`, `people.name()`, `people.organization()`,
 * and the nested bulk `people.emails.value()` / `people.phones.value()`) — then
 * substring-filters IN-SCRIPT and caps at `limit`. That is ~5 round trips total,
 * independent of contact count; there is never a per-person Apple-Event loop.
 * TRADEOFF (documented): the full name/email/phone arrays cross the pipe once per
 * search (a few hundred KB on a large book) — chosen over `whose` because Apple's
 * `whose` cannot express "substring across nested emails/phones", and per-person
 * probing is O(N) round trips. A hard subprocess timeout (SIGKILL) caps the damage.
 * `contacts.read` touches ONE person by id (`people.byId`) — a handful of reads.
 */

import { spawn } from "node:child_process";

// ── §1  Bounds + validation ───────────────────────────────────────────────────

/** Default number of search results when the agent does not pass `limit`. */
export const CONTACTS_SEARCH_LIMIT_DEFAULT = 20;
/** HARD CAP on search results — a larger `limit` is clamped, never honored. */
export const CONTACTS_SEARCH_LIMIT_MAX = 50;
/** Max length of the search query string. */
export const CONTACTS_QUERY_MAX_CHARS = 128;
/** Max length of a contact id. */
export const CONTACTS_ID_MAX_CHARS = 256;

/** Hard subprocess timeouts (ms). */
export const CONTACTS_PROBE_TIMEOUT_MS = 20_000;
export const CONTACTS_SEARCH_TIMEOUT_MS = 30_000;
export const CONTACTS_READ_TIMEOUT_MS = 20_000;

/** Raised when search/read input fails validation. */
export class ContactsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactsInputError";
  }
}

/** Raised for a recognized macOS TCC (Automation) denial — mapped gracefully upstream. */
export class ContactsNotAuthorizedError extends Error {
  constructor(message: string = USER_FACING_CONTACTS_TCC_MESSAGE) {
    super(message);
    this.name = "ContactsNotAuthorizedError";
  }
}

/** The precise onboarding instruction surfaced when Automation access is denied. */
export const USER_FACING_CONTACTS_TCC_MESSAGE =
  "Contacts access not granted — approve the Plexus host app in System Settings ▸ " +
  "Privacy & Security ▸ Automation ▸ Contacts, then retry.";

/** A VALIDATED search query. */
export interface ContactsSearchQuery {
  /** Trimmed, length-capped substring — matched against name, emails, phones. */
  query: string;
  /** Result cap — ALWAYS present after validation (default 20, hard cap 50). */
  limit: number;
}

/** Clamp `limit` into [1, CONTACTS_SEARCH_LIMIT_MAX]; default CONTACTS_SEARCH_LIMIT_DEFAULT. */
export function clampContactsLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return CONTACTS_SEARCH_LIMIT_DEFAULT;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return CONTACTS_SEARCH_LIMIT_DEFAULT;
  return Math.max(1, Math.min(CONTACTS_SEARCH_LIMIT_MAX, Math.floor(n)));
}

/** Parse + validate a `contacts.search` input (`query` required; `limit` clamped). */
export function validateContactsSearchInput(input: Record<string, unknown>): ContactsSearchQuery {
  const q = input.query;
  if (typeof q !== "string" || q.trim() === "") {
    throw new ContactsInputError("`query` is required and must be a non-empty string (name/email/phone substring)");
  }
  if (q.length > CONTACTS_QUERY_MAX_CHARS) {
    throw new ContactsInputError(`\`query\` is too long (max ${CONTACTS_QUERY_MAX_CHARS} chars)`);
  }
  return { query: q.trim(), limit: clampContactsLimit(input.limit) };
}

/** Parse + validate a `contacts.read` input (`id` required). */
export function validateContactsReadInput(input: Record<string, unknown>): { id: string } {
  const id = input.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new ContactsInputError("`id` is required and must be a contact id string (from contacts.search)");
  }
  if (id.length > CONTACTS_ID_MAX_CHARS) {
    throw new ContactsInputError(`\`id\` is too long (max ${CONTACTS_ID_MAX_CHARS} chars)`);
  }
  return { id: id.trim() };
}

// ── §2  Output shapes ─────────────────────────────────────────────────────────

/** One search hit — enough to pick a person; use contacts.read for the full card. */
export interface ContactSummary {
  id: string;
  name: string;
  organization: string | null;
  emails: string[];
  phones: string[];
}

export interface ContactsSearchResult {
  contacts: ContactSummary[];
  /** Total matches (may exceed contacts.length). */
  total: number;
  /** True when more matched than the `limit` cap returned. */
  truncated: boolean;
}

export interface LabeledValue {
  label: string | null;
  value: string;
}

/** A full contact card (everything read-only). */
export interface ContactCard {
  id: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  organization: string | null;
  /** ISO date (yyyy-mm-dd) when set. */
  birthday: string | null;
  emails: LabeledValue[];
  phones: LabeledValue[];
  /** Postal addresses, formatted by Contacts. */
  addresses: LabeledValue[];
}

export interface ContactReadResult {
  contact: ContactCard;
}

/** Result of the availability probe — the source's health() reads this. */
export interface ContactsAvailability {
  ok: boolean;
  reason?: string;
}

// ── §3  The OS-access seam ────────────────────────────────────────────────────

/** Every method is READ-ONLY — no create/update/delete exists on the interface. */
export interface ContactsProvider {
  /** Probe reachability + TCC. NEVER throws — degrades to `{ ok:false, reason }`. */
  available(): Promise<ContactsAvailability>;
  /** READ-ONLY: bounded substring search across name/email/phone. */
  searchContacts(query: ContactsSearchQuery): Promise<ContactsSearchResult>;
  /** READ-ONLY: the full card for one contact id. */
  readContact(args: { id: string }): Promise<ContactReadResult>;
}

// ── §4  FIXED JXA script templates (no agent-controlled script body) ──────────
//
// CONSTANT `osascript -l JavaScript` programs. The ONLY dynamic data they receive is
// one JSON document of VALIDATED values via the JXA `run(argv)` argument vector —
// agent text is DATA, never interpolated into script source. No mutating verb appears
// in any template — read-only by construction.

/** Strip Apple's internal label wrapper (`_$!<Home>!$_` → `Home`). */
const CONTACTS_LABEL_JS = `
function cleanLabel(l) {
  if (l === null || l === undefined) return null;
  return String(l).split("_$!<").join("").split(">!$_").join("");
}
`.trim();

/** Liveness probe: count people (triggers the Automation TCC prompt on first run). */
export const CONTACTS_PROBE_JS = `
function run() {
  var app = Application("Contacts");
  return JSON.stringify({ ok: true, people: app.people.length });
}
`.trim();

/**
 * Bounded search: argv[0] = validated {query, limit} JSON. FIVE bulk Apple Events
 * (ids, names, organizations, nested emails.value, nested phones.value) — never a
 * per-person round trip — then case-insensitive substring filtering in-script:
 * name/email match the raw needle; phones match on digits (needle must contain ≥ 3
 * digits to phone-match, so a short name query never matches every number).
 */
export const CONTACTS_SEARCH_JS = `
function run(argv) {
  var q = JSON.parse(argv[0]);
  var app = Application("Contacts");
  var people = app.people;
  var ids = people.id();                 // bulk
  var names = people.name();             // bulk
  var orgs = people.organization();      // bulk
  var emails = people.emails.value();    // bulk nested (array of arrays)
  var phones = people.phones.value();    // bulk nested
  var needle = String(q.query).toLowerCase();
  var digitRe = new RegExp("[^0-9]", "g");
  var digits = needle.replace(digitRe, "");
  var out = [];
  var total = 0;
  for (var i = 0; i < ids.length; i++) {
    var name = names[i] ? String(names[i]) : "";
    var em = emails[i] || [];
    var ph = phones[i] || [];
    var hit = name.toLowerCase().indexOf(needle) !== -1;
    if (!hit) {
      for (var j = 0; j < em.length; j++) {
        if (String(em[j]).toLowerCase().indexOf(needle) !== -1) { hit = true; break; }
      }
    }
    if (!hit && digits.length >= 3) {
      for (var k = 0; k < ph.length; k++) {
        if (String(ph[k]).replace(digitRe, "").indexOf(digits) !== -1) { hit = true; break; }
      }
    }
    if (!hit) continue;
    total++;
    if (out.length < q.limit) {
      var emOut = [];
      for (var j2 = 0; j2 < em.length; j2++) emOut.push(String(em[j2]));
      var phOut = [];
      for (var k2 = 0; k2 < ph.length; k2++) phOut.push(String(ph[k2]));
      out.push({
        id: String(ids[i]),
        name: name,
        organization: orgs[i] ? String(orgs[i]) : null,
        emails: emOut,
        phones: phOut
      });
    }
  }
  return JSON.stringify({ contacts: out, total: total, truncated: total > out.length });
}
`.trim();

/**
 * Full card by id: argv[0] = validated {id} JSON. Touches ONE person via
 * \`people.byId\` — bulk label/value reads on that person's emails/phones/addresses.
 */
export const CONTACTS_READ_JS = `
${CONTACTS_LABEL_JS}
function run(argv) {
  var q = JSON.parse(argv[0]);
  var app = Application("Contacts");
  var p = app.people.byId(q.id);
  var name;
  try { name = String(p.name()); } catch (e) {
    throw new Error("apple-contacts: no contact with id " + q.id);
  }
  function opt(fn) { try { var v = fn(); return (v === null || v === undefined || String(v) === "") ? null : String(v); } catch (e) { return null; } }
  var emails = [];
  try {
    var eLabels = p.emails.label();
    var eValues = p.emails.value();
    for (var i = 0; i < eValues.length; i++) emails.push({ label: cleanLabel(eLabels[i]), value: String(eValues[i]) });
  } catch (e) {}
  var phones = [];
  try {
    var pLabels = p.phones.label();
    var pValues = p.phones.value();
    for (var j = 0; j < pValues.length; j++) phones.push({ label: cleanLabel(pLabels[j]), value: String(pValues[j]) });
  } catch (e) {}
  var addresses = [];
  try {
    var aLabels = p.addresses.label();
    var aFmt = p.addresses.formattedAddress();
    for (var k = 0; k < aFmt.length; k++) {
      addresses.push({ label: cleanLabel(aLabels[k]), value: String(aFmt[k] || "") });
    }
  } catch (e) {}
  var birthday = null;
  try {
    var bd = p.birthDate();
    if (bd) birthday = bd.toISOString().slice(0, 10);
  } catch (e) {}
  return JSON.stringify({ contact: {
    id: String(p.id()),
    name: name,
    firstName: opt(function () { return p.firstName(); }),
    lastName: opt(function () { return p.lastName(); }),
    organization: opt(function () { return p.organization(); }),
    birthday: birthday,
    emails: emails,
    phones: phones,
    addresses: addresses
  } });
}
`.trim();

// ── §5  Shared helpers + runner ───────────────────────────────────────────────

/** Recognize the macOS TCC / Automation denial in osascript stderr. */
export function isContactsNotAuthorized(stderr: string): boolean {
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
  timedOut: boolean;
}

/** Injectable runner for `osascript -l JavaScript -e <script> [jsonArg]` with a HARD timeout. */
export type OsaRunner = (script: string, args: string[], timeoutMs: number) => Promise<OsaCapture>;

/** DEFAULT runner: spawn real osascript (argv array, NO shell) and SIGKILL on timeout. */
export const defaultContactsOsascript: OsaRunner = (script, args, timeoutMs) =>
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
  if (trimmed === "") throw new Error(`apple-contacts: empty ${what} output from osascript`);
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`apple-contacts: could not parse ${what} output as JSON: ${trimmed.slice(0, 200)}`);
  }
}

// ── §6  REAL provider ─────────────────────────────────────────────────────────

/** Construction knobs (timeouts injectable for tests). */
export interface RealContactsProviderOptions {
  run?: OsaRunner;
  searchTimeoutMs?: number;
  readTimeoutMs?: number;
  probeTimeoutMs?: number;
}

/** REAL provider — shells the fixed JXA templates under HARD timeouts. */
export class RealContactsProvider implements ContactsProvider {
  private readonly run: OsaRunner;
  private readonly timeouts: { probe: number; search: number; read: number };

  constructor(opts: RealContactsProviderOptions = {}) {
    this.run = opts.run ?? defaultContactsOsascript;
    this.timeouts = {
      probe: opts.probeTimeoutMs ?? CONTACTS_PROBE_TIMEOUT_MS,
      search: opts.searchTimeoutMs ?? CONTACTS_SEARCH_TIMEOUT_MS,
      read: opts.readTimeoutMs ?? CONTACTS_READ_TIMEOUT_MS,
    };
  }

  private async exec(script: string, args: string[], timeoutMs: number, op: string): Promise<string> {
    const res = await this.run(script, args, timeoutMs);
    if (res.timedOut) {
      throw new Error(`apple-contacts: ${op} timed out after ${Math.round(timeoutMs / 1000)}s — is Contacts responsive?`);
    }
    if (isContactsNotAuthorized(res.stderr)) throw new ContactsNotAuthorizedError();
    if (res.exitCode !== 0) {
      throw new Error(`apple-contacts: ${op} failed (code ${res.exitCode}): ${res.stderr.trim().slice(0, 200)}`);
    }
    return res.stdout;
  }

  async available(): Promise<ContactsAvailability> {
    try {
      const res = await this.run(CONTACTS_PROBE_JS, [], this.timeouts.probe);
      if (res.timedOut) return { ok: false, reason: "Contacts unavailable — probe timed out (is Contacts responsive?)" };
      if (isContactsNotAuthorized(res.stderr)) return { ok: false, reason: USER_FACING_CONTACTS_TCC_MESSAGE };
      if (res.exitCode !== 0) {
        return { ok: false, reason: `Contacts unavailable — osascript failed (code ${res.exitCode}): ${res.stderr.trim().slice(0, 160)}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `Contacts unavailable — could not run osascript: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async searchContacts(query: ContactsSearchQuery): Promise<ContactsSearchResult> {
    const stdout = await this.exec(CONTACTS_SEARCH_JS, [JSON.stringify(query)], this.timeouts.search, "contacts.search");
    const parsed = parseJson(stdout, "search") as { contacts?: unknown; total?: unknown; truncated?: unknown };
    if (!Array.isArray(parsed.contacts)) throw new Error("apple-contacts: malformed search payload");
    const contacts: ContactSummary[] = parsed.contacts.map((raw) => {
      const c = (raw ?? {}) as Record<string, unknown>;
      return {
        id: typeof c.id === "string" ? c.id : String(c.id ?? ""),
        name: typeof c.name === "string" ? c.name : "",
        organization: typeof c.organization === "string" ? c.organization : null,
        emails: Array.isArray(c.emails) ? c.emails.map(String) : [],
        phones: Array.isArray(c.phones) ? c.phones.map(String) : [],
      };
    });
    return {
      contacts,
      total: typeof parsed.total === "number" ? parsed.total : contacts.length,
      truncated: parsed.truncated === true,
    };
  }

  async readContact(args: { id: string }): Promise<ContactReadResult> {
    const stdout = await this.exec(CONTACTS_READ_JS, [JSON.stringify(args)], this.timeouts.read, "contacts.read");
    const parsed = parseJson(stdout, "read") as { contact?: unknown };
    const c = (parsed.contact ?? {}) as Record<string, unknown>;
    const labeled = (v: unknown): LabeledValue[] =>
      Array.isArray(v)
        ? v.map((raw) => {
            const lv = (raw ?? {}) as Record<string, unknown>;
            return {
              label: typeof lv.label === "string" ? lv.label : null,
              value: typeof lv.value === "string" ? lv.value : "",
            };
          })
        : [];
    return {
      contact: {
        id: typeof c.id === "string" ? c.id : String(c.id ?? ""),
        name: typeof c.name === "string" ? c.name : "",
        firstName: typeof c.firstName === "string" ? c.firstName : null,
        lastName: typeof c.lastName === "string" ? c.lastName : null,
        organization: typeof c.organization === "string" ? c.organization : null,
        birthday: typeof c.birthday === "string" ? c.birthday : null,
        emails: labeled(c.emails),
        phones: labeled(c.phones),
        addresses: labeled(c.addresses),
      },
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// FAKE PROVIDER — deterministic in-memory fixtures (PLEXUS_FAKE_APPLE=1 / tests).
// ════════════════════════════════════════════════════════════════════════════════

/** Deterministic sample cards (stable + assertable). */
export function fakeContactCards(): ContactCard[] {
  return [
    {
      id: "person-1",
      name: "Dana Chen",
      firstName: "Dana",
      lastName: "Chen",
      organization: "Chen Design Co",
      birthday: "1990-03-14",
      emails: [
        { label: "Home", value: "dana@example.com" },
        { label: "Work", value: "dana@chendesign.example" },
      ],
      phones: [{ label: "Mobile", value: "+1 (415) 555-0134" }],
      addresses: [{ label: "Home", value: "12 Main St\nSan Francisco CA 94110\nUnited States" }],
    },
    {
      id: "person-2",
      name: "Maya Ortiz",
      firstName: "Maya",
      lastName: "Ortiz",
      organization: "Plexus Labs",
      birthday: null,
      emails: [{ label: "Work", value: "maya@work.example" }],
      phones: [
        { label: "Work", value: "+1 (628) 555-0199" },
        { label: "Mobile", value: "+1 (628) 555-0107" },
      ],
      addresses: [],
    },
    {
      id: "person-3",
      name: "Alex Kim",
      firstName: "Alex",
      lastName: "Kim",
      organization: null,
      birthday: "1988-06-27",
      emails: [{ label: "Home", value: "alex.kim@example.org" }],
      phones: [],
      addresses: [],
    },
  ];
}

/** Construction options for the fake provider. */
export interface FakeContactsProviderOptions {
  cards?: ContactCard[];
  /** Force the un-granted (Automation TCC) state — available() reports, reads throw. */
  notAuthorized?: boolean;
}

/**
 * In-memory fake. Mirrors the real search semantics: case-insensitive substring on
 * name/email, digit-normalized substring on phones (needle needs ≥ 3 digits), `limit`
 * cap + `truncated` flag.
 */
export class FakeContactsProvider implements ContactsProvider {
  private readonly cards: ContactCard[];
  private readonly notAuthorized: boolean;

  constructor(opts: FakeContactsProviderOptions = {}) {
    this.cards = opts.cards ?? fakeContactCards();
    this.notAuthorized = opts.notAuthorized ?? false;
  }

  async available(): Promise<ContactsAvailability> {
    return this.notAuthorized ? { ok: false, reason: USER_FACING_CONTACTS_TCC_MESSAGE } : { ok: true };
  }

  async searchContacts(query: ContactsSearchQuery): Promise<ContactsSearchResult> {
    if (this.notAuthorized) throw new ContactsNotAuthorizedError();
    const needle = query.query.toLowerCase();
    const digits = needle.replace(/[^0-9]/g, "");
    const matches = this.cards.filter((c) => {
      if (c.name.toLowerCase().includes(needle)) return true;
      if (c.emails.some((e) => e.value.toLowerCase().includes(needle))) return true;
      if (digits.length >= 3 && c.phones.some((p) => p.value.replace(/[^0-9]/g, "").includes(digits))) return true;
      return false;
    });
    const page = matches.slice(0, query.limit);
    return {
      contacts: page.map((c) => ({
        id: c.id,
        name: c.name,
        organization: c.organization,
        emails: c.emails.map((e) => e.value),
        phones: c.phones.map((p) => p.value),
      })),
      total: matches.length,
      truncated: matches.length > page.length,
    };
  }

  async readContact(args: { id: string }): Promise<ContactReadResult> {
    if (this.notAuthorized) throw new ContactsNotAuthorizedError();
    const found = this.cards.find((c) => c.id === args.id);
    if (!found) throw new Error(`apple-contacts: no contact with id ${args.id}`);
    return {
      contact: {
        ...found,
        emails: found.emails.map((e) => ({ ...e })),
        phones: found.phones.map((p) => ({ ...p })),
        addresses: found.addresses.map((a) => ({ ...a })),
      },
    };
  }
}

/**
 * SELECT the provider: an explicitly-injected one wins; otherwise the FAKE when
 * `PLEXUS_FAKE_APPLE === "1"`, else the REAL osascript provider. Read fresh each call.
 */
export function selectContactsProvider(injected?: ContactsProvider): ContactsProvider {
  if (injected) return injected;
  if (process.env.PLEXUS_FAKE_APPLE === "1") return new FakeContactsProvider();
  return new RealContactsProvider();
}
