/**
 * NotesProvider — the OS-ACCESS SEAM for the Apple Notes source.
 *
 * Everything that touches the macOS Notes app lives behind this single interface so
 * the rest of the source (entries, bridge, health) is OS-agnostic and HERMETICALLY
 * TESTABLE. Two implementations:
 *
 *  - `RealNotesProvider` (real): shells `osascript -l JavaScript` (JXA) against the
 *    Notes app. The FIRST such call triggers the macOS Automation (Apple Events)
 *    consent prompt; a denial surfaces as a precise, actionable reason — never a
 *    crash. NEEDS macOS + a granted Automation permission to actually read/create.
 *
 *  - `FakeNotesProvider` (fake): a deterministic IN-MEMORY fixture store. `createNote`
 *    mutates the store; a subsequent search/read reflects the change. Needs NO macOS
 *    permission — used by the unit tests AND the hermetic probe.
 *
 * SELECTION (`selectNotesProvider`): real by default; the FAKE when
 * `PLEXUS_FAKE_APPLE === "1"` (the shared env all apple-* sources honor). A caller may
 * also inject a provider directly via the source/bridge constructor.
 *
 * CREATE-ONLY WRITE SURFACE — BY CONSTRUCTION AT THE SEAM: the interface has
 * `createNote` and NOTHING ELSE that mutates. There is no update / delete / move /
 * rename method on `NotesProvider`, no JXA template that calls one, and no capability
 * entry that could route to one. An existing note CANNOT be modified or removed
 * through this source — that is the product decision, enforced structurally (the
 * mutation paths do not exist), not merely denied.
 *
 * PERFORMANCE — bounding AppleScript enumeration: Notes libraries can hold thousands
 * of notes and Apple-Event round trips are slow. Every enumeration here is bounded:
 *  - search narrows IN JXA via a `whose` filter (name/plaintext `_contains`) so
 *    non-matching notes never cross the Apple-Event boundary, bulk-reads the id /
 *    title / folder / modification-date columns (ONE Apple Event per property, not
 *    per note), and only then reads the snippet `plaintext` per note for the ≤ limit
 *    (≤ MAX_SEARCH_LIMIT) survivors;
 *  - read resolves ONE note by id (or exact-title `whose`) — never a library scan;
 *  - every osascript spawn carries a hard kill-timeout (`OSASCRIPT_TIMEOUT_MS`) so a
 *    runaway query degrades to a clear error instead of a hung bridge.
 */

import { spawn } from "node:child_process";

// ── DOMAIN SHAPES (provider-neutral; both impls return these) ────────────────────

/** A Notes folder, qualified by the account that owns it ("iCloud", "On My Mac", …). */
export interface NoteFolder {
  /** Display name of the folder (e.g. "Notes", "Recipes"). */
  name: string;
  /** The account the folder belongs to (e.g. "iCloud"). */
  account: string;
}

/** One search hit — a bounded projection, never the full body. */
export interface NoteHit {
  /** Stable Notes id (Core Data URL, e.g. "x-coredata://…/ICNote/p123"). */
  id: string;
  title: string;
  /** Containing folder name ("" when it could not be read). */
  folder: string;
  /** ISO-8601 modification date ("" when unavailable). */
  modifiedAt: string;
  /** A short plain-text excerpt of the body (whitespace-normalized, ≤ ~200 chars). */
  snippet: string;
}

/** The full content of ONE note. Notes bodies are HTML; both forms are returned. */
export interface NoteContent {
  id: string;
  title: string;
  folder: string;
  /** ISO-8601 creation date ("" when unavailable). */
  createdAt: string;
  /** ISO-8601 modification date ("" when unavailable). */
  modifiedAt: string;
  /** Plain-text extraction of the body (Notes' own `plaintext` in the real impl). */
  text: string;
  /** The raw HTML body exactly as Notes stores it. */
  html: string;
}

/** Args to create a NEW note (the ONLY write this seam has). */
export interface CreateNoteArgs {
  title: string;
  /** Plain-text body; converted to HTML paragraphs by the provider. Optional. */
  body?: string;
  /** Target folder by name. Omit ⇒ the default Notes folder. */
  folder?: string;
}

/** The created note, echoed back for citation. */
export interface CreatedNote {
  id: string;
  title: string;
  folder: string;
}

/** Search query, validated + clamped by the bridge before it reaches a provider. */
export interface SearchNotesQuery {
  /** Substring matched case-insensitively against note titles AND body text. */
  query: string;
  /** Max hits to return (bridge clamps to 1..MAX_SEARCH_LIMIT; default 20). */
  limit: number;
}

/** An availability probe result (drives source `health()` / `checkRequirements()`). */
export interface AvailabilityResult {
  ok: boolean;
  /** Precise, actionable reason when `ok:false` (e.g. the Automation-denied message). */
  reason?: string;
}

/**
 * The OS-access seam. READ methods + ONE create — deliberately NO update, NO delete,
 * NO move, NO rename anywhere on this interface (create-only write surface).
 */
export interface NotesProvider {
  /** Is the Notes backend reachable + permitted? (Automation/TCC probe for the real impl.) */
  available(): Promise<AvailabilityResult>;
  /** READ: enumerate the folders per account. */
  listFolders(): Promise<NoteFolder[]>;
  /** READ: bounded search by title/body substring. */
  searchNotes(query: SearchNotesQuery): Promise<NoteHit[]>;
  /** READ: one note's full content by id, or by EXACT title when id is absent. */
  readNote(ref: { id?: string; title?: string }): Promise<NoteContent>;
  /** WRITE (the only one): create a NEW note. Never touches an existing note. */
  createNote(args: CreateNoteArgs): Promise<CreatedNote>;
}

// ── Limits (hard caps — anti-runaway) ─────────────────────────────────────────────

/** Default number of search hits when the agent omits `limit`. */
export const DEFAULT_SEARCH_LIMIT = 20;
/** Hard ceiling on search hits per call. */
export const MAX_SEARCH_LIMIT = 50;
/** Max snippet length (plain-text excerpt in search hits). */
export const SNIPPET_MAX_CHARS = 200;
/** Hard kill-timeout for every osascript spawn (a slow library query degrades, never hangs). */
export const OSASCRIPT_TIMEOUT_MS = 45_000;

/** Clamp a raw `limit` input to 1..MAX_SEARCH_LIMIT, defaulting when absent/invalid. */
export function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, n));
}

/** Whitespace-normalize + truncate body text into a search snippet. */
export function makeSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > SNIPPET_MAX_CHARS ? `${collapsed.slice(0, SNIPPET_MAX_CHARS)}…` : collapsed;
}

/** Escape plain text for embedding into an HTML note body. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Convert a plain-text body to the `<div>`-per-line HTML Notes expects. An empty body
 * yields an empty string (Notes then shows just the title line).
 */
export function textToNotesHtml(text: string): string {
  if (!text) return "";
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() === "" ? "<div><br></div>" : `<div>${escapeHtml(line)}</div>`))
    .join("");
}

/**
 * Best-effort plain-text extraction from a Notes HTML body (used by the FAKE provider
 * and as a fallback; the REAL provider returns Notes' own `plaintext`).
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ════════════════════════════════════════════════════════════════════════════════
// REAL PROVIDER — osascript -l JavaScript (JXA) against the Notes app.
// ════════════════════════════════════════════════════════════════════════════════

/** A raw spawn-and-capture result (mirrors apple-calendar's `RunResult`). */
export interface OsascriptCapture {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Injectable runner for `osascript -l JavaScript -e <script> [argv…]`. Dynamic values
 * cross ONLY via the argv vector (the JXA `run(argv)` argument list) — agent text is
 * NEVER string-interpolated into a script body, so "no arbitrary script execution"
 * holds by construction.
 */
export type JxaRunner = (script: string, argv: string[]) => Promise<OsascriptCapture>;

/** DEFAULT runner: spawn osascript with a hard kill-timeout (anti-hang). */
export const defaultJxaRunner: JxaRunner = (script, argv) =>
  new Promise<OsascriptCapture>((resolve) => {
    const child = spawn("osascript", ["-l", "JavaScript", "-e", script, ...argv], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (res: OsascriptCapture) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        stdout,
        stderr: `${stderr}\napple-notes: osascript timed out after ${OSASCRIPT_TIMEOUT_MS}ms (query too broad or Notes unresponsive)`,
        exitCode: null,
      });
    }, OSASCRIPT_TIMEOUT_MS);
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", (err) => finish({ stdout, stderr: stderr + String(err), exitCode: -1 }));
    child.on("close", (code) => finish({ stdout, stderr, exitCode: code }));
  });

/**
 * The precise onboarding instruction for an un-granted Automation permission. Notes
 * scripting is gated by the Automation (Apple Events) TCC bucket — the host app that
 * spawns osascript must be allowed to control Notes.
 */
export const NOTES_TCC_MESSAGE =
  "Notes access not granted — allow Plexus (or your terminal) to control Notes in " +
  "System Settings › Privacy & Security › Automation, then retry.";

/**
 * Recognize the Apple-Event TIMEOUT (-1712) — in practice the signature of a
 * SUPPRESSED/PENDING Automation prompt (a headless caller can't show the consent
 * dialog, so the event stalls) or an unresponsive Notes. Surfaced with the same
 * actionable Automation instruction rather than a bare "timed out".
 */
export function isAppleEventTimeout(stderr: string): boolean {
  return stderr.includes("-1712") || stderr.toLowerCase().includes("applevent timed out");
}

/** Recognize a macOS Automation/TCC denial in osascript stderr. */
export function isNotesNotAuthorized(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    stderr.includes("-1743") ||
    s.includes("not authorized") ||
    s.includes("not allowed to send apple events") ||
    s.includes("doesn't have permission") ||
    s.includes("does not have permission") ||
    s.includes("not permitted")
  );
}

/** Raised for a recognized Automation denial — mapped to a graceful error upstream. */
export class NotesNotAuthorizedError extends Error {
  constructor(message: string = NOTES_TCC_MESSAGE) {
    super(message);
    this.name = "NotesNotAuthorizedError";
  }
}

/** Raised when a note lookup finds nothing (bad id / no exact-title match). */
export class NoteNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteNotFoundError";
  }
}

// ── FIXED JXA script templates (no agent-controlled body — argv only) ────────────
//
// Each template is a CONSTANT program; dynamic values arrive via `run(argv)` as
// strings the script parses itself. Every script returns one JSON line on stdout.
// A missing-note lookup returns {"notFound":true} (an in-band sentinel, so the
// provider can distinguish it from a transport failure).

/** List folders per account: emit { folders: [{ name, account }] }. Bulk name reads. */
export const JXA_LIST_FOLDERS = `
function run() {
  var app = Application("Notes");
  var out = [];
  var accounts = app.accounts();
  for (var i = 0; i < accounts.length; i++) {
    var acctName = accounts[i].name();
    // BULK: one Apple Event returns every folder name in this account.
    var names = accounts[i].folders.name();
    for (var j = 0; j < names.length; j++) {
      out.push({ name: names[j], account: acctName });
    }
  }
  return JSON.stringify({ folders: out });
}
`.trim();

/**
 * Bounded search: argv = [query, limit]. A \`whose\` filter (title OR plaintext
 * contains, case-insensitive per JXA string comparison) narrows IN Notes so
 * non-matches never cross the Apple-Event boundary; the id/name/date columns are
 * BULK-read (one Apple Event per property); only the first \`limit\` hits get a
 * per-note plaintext read for the snippet. Emits { notes: [{ id, title, folder,
 * modifiedAt, snippet }] }.
 */
export const JXA_SEARCH_NOTES = `
function run(argv) {
  var query = argv[0];
  var limit = parseInt(argv[1], 10);
  var app = Application("Notes");
  var hits = app.notes.whose({ _or: [
    { name: { _contains: query } },
    { plaintext: { _contains: query } }
  ] });
  // BULK column reads: ONE Apple Event per property across all matches.
  var ids = hits.id();
  var names = hits.name();
  var mods = hits.modificationDate();
  var n = Math.min(ids.length, limit);
  var out = [];
  for (var i = 0; i < n; i++) {
    var folder = "";
    var snippet = "";
    try { folder = hits[i].container.name(); } catch (e) {}
    try {
      var text = hits[i].plaintext() || "";
      snippet = text.replace(/\\s+/g, " ").trim().slice(0, ${SNIPPET_MAX_CHARS});
    } catch (e) {}
    out.push({
      id: ids[i],
      title: names[i],
      folder: folder,
      modifiedAt: mods[i] ? mods[i].toISOString() : "",
      snippet: snippet
    });
  }
  return JSON.stringify({ notes: out, total: ids.length });
}
`.trim();

/**
 * Read ONE note: argv = [mode, value] where mode is "id" | "title". Resolves byId or
 * by EXACT title (\`whose({ name: value })\`, first match) — never a library scan.
 * Emits { note: { id, title, folder, createdAt, modifiedAt, text, html } } or
 * { notFound: true }.
 */
export const JXA_READ_NOTE = `
function run(argv) {
  var mode = argv[0];
  var value = argv[1];
  var app = Application("Notes");
  var note = null;
  if (mode === "id") {
    try { note = app.notes.byId(value); note.name(); } catch (e) { note = null; }
  } else {
    var matches = app.notes.whose({ name: value });
    if (matches.length > 0) note = matches[0];
  }
  if (!note) return JSON.stringify({ notFound: true });
  var folder = "";
  try { folder = note.container.name(); } catch (e) {}
  var created = null, modified = null;
  try { created = note.creationDate(); } catch (e) {}
  try { modified = note.modificationDate(); } catch (e) {}
  return JSON.stringify({ note: {
    id: note.id(),
    title: note.name(),
    folder: folder,
    createdAt: created ? created.toISOString() : "",
    modifiedAt: modified ? modified.toISOString() : "",
    text: note.plaintext() || "",
    html: note.body() || ""
  } });
}
`.trim();

/**
 * Create a NEW note: argv = [title, htmlBody, folderName] (folderName "" ⇒ default
 * folder). Uses \`make new note\` semantics via the JXA push — the ONLY mutating
 * template in this source; there is no update/delete/move script anywhere. Emits
 * { note: { id, title, folder } } or { notFound: true } when the target folder does
 * not exist (no silent folder creation).
 */
export const JXA_CREATE_NOTE = `
function run(argv) {
  var title = argv[0];
  var htmlBody = argv[1];
  var folderName = argv[2];
  var app = Application("Notes");
  var target = null;
  if (folderName === "") {
    target = app.defaultAccount.defaultFolder ? app.defaultAccount.defaultFolder() : null;
    if (!target) target = app.folders[0];
  } else {
    var matches = app.folders.whose({ name: folderName });
    if (matches.length === 0) return JSON.stringify({ notFound: true, folder: folderName });
    target = matches[0];
  }
  var note = app.Note({ name: title, body: htmlBody });
  target.notes.push(note);
  var folder = "";
  try { folder = note.container.name(); } catch (e) { folder = folderName; }
  return JSON.stringify({ note: { id: note.id(), title: note.name(), folder: folder } });
}
`.trim();

/** Parse one-line JSON stdout defensively. */
function parseJson(stdout: string, op: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (trimmed === "") throw new Error(`apple-notes ${op}: empty output from osascript`);
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    throw new Error(`apple-notes ${op}: could not parse osascript output as JSON: ${trimmed.slice(0, 200)}`);
  }
}

/**
 * The REAL provider. Every method runs a FIXED JXA template via the injected runner
 * (default spawns osascript with a kill-timeout). `available()` NEVER throws — a
 * denial/timeout degrades to `{ ok:false, reason }` with the precise Automation
 * onboarding message. Read/create methods throw typed errors the bridge maps to
 * graceful transport errors.
 */
export class RealNotesProvider implements NotesProvider {
  constructor(private readonly run: JxaRunner = defaultJxaRunner) {}

  async available(): Promise<AvailabilityResult> {
    try {
      const res = await this.run(JXA_LIST_FOLDERS, []);
      if (res.exitCode === 0) return { ok: true };
      if (isNotesNotAuthorized(res.stderr)) return { ok: false, reason: NOTES_TCC_MESSAGE };
      if (isAppleEventTimeout(res.stderr)) {
        return {
          ok: false,
          reason:
            "Notes did not respond (Apple Event timed out) — usually a pending Automation approval: " +
            "allow Plexus (or your terminal) to control Notes in System Settings › Privacy & Security › " +
            "Automation, make sure Notes can launch, then retry.",
        };
      }
      return {
        ok: false,
        reason: `Notes unavailable — osascript failed (code ${res.exitCode}): ${res.stderr.trim().slice(0, 160)}`,
      };
    } catch (err) {
      return {
        ok: false,
        reason: `Notes unavailable — could not run osascript: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async exec(script: string, argv: string[], op: string): Promise<Record<string, unknown>> {
    const res = await this.run(script, argv);
    if (isNotesNotAuthorized(res.stderr)) throw new NotesNotAuthorizedError();
    if (res.exitCode !== 0) {
      throw new Error(`apple-notes ${op}: osascript failed (code ${res.exitCode}): ${res.stderr.trim().slice(0, 200)}`);
    }
    return parseJson(res.stdout, op);
  }

  async listFolders(): Promise<NoteFolder[]> {
    const parsed = await this.exec(JXA_LIST_FOLDERS, [], "folders.list");
    const raw = Array.isArray(parsed.folders) ? parsed.folders : [];
    return raw.map((f) => {
      const r = (f ?? {}) as Record<string, unknown>;
      return {
        name: typeof r.name === "string" ? r.name : "",
        account: typeof r.account === "string" ? r.account : "",
      };
    });
  }

  async searchNotes(query: SearchNotesQuery): Promise<NoteHit[]> {
    const parsed = await this.exec(JXA_SEARCH_NOTES, [query.query, String(query.limit)], "notes.search");
    const raw = Array.isArray(parsed.notes) ? parsed.notes : [];
    return raw.map((h) => {
      const r = (h ?? {}) as Record<string, unknown>;
      return {
        id: typeof r.id === "string" ? r.id : "",
        title: typeof r.title === "string" ? r.title : "",
        folder: typeof r.folder === "string" ? r.folder : "",
        modifiedAt: typeof r.modifiedAt === "string" ? r.modifiedAt : "",
        snippet: typeof r.snippet === "string" ? r.snippet : "",
      };
    });
  }

  async readNote(ref: { id?: string; title?: string }): Promise<NoteContent> {
    const mode = ref.id ? "id" : "title";
    const value = ref.id ?? ref.title ?? "";
    const parsed = await this.exec(JXA_READ_NOTE, [mode, value], "notes.read");
    if (parsed.notFound === true) {
      throw new NoteNotFoundError(`apple-notes: no note found by ${mode}: ${JSON.stringify(value)}`);
    }
    const n = (parsed.note ?? {}) as Record<string, unknown>;
    return {
      id: typeof n.id === "string" ? n.id : "",
      title: typeof n.title === "string" ? n.title : "",
      folder: typeof n.folder === "string" ? n.folder : "",
      createdAt: typeof n.createdAt === "string" ? n.createdAt : "",
      modifiedAt: typeof n.modifiedAt === "string" ? n.modifiedAt : "",
      text: typeof n.text === "string" ? n.text : "",
      html: typeof n.html === "string" ? n.html : "",
    };
  }

  async createNote(args: CreateNoteArgs): Promise<CreatedNote> {
    const html = textToNotesHtml(args.body ?? "");
    const parsed = await this.exec(
      JXA_CREATE_NOTE,
      [args.title, html, args.folder ?? ""],
      "notes.create",
    );
    if (parsed.notFound === true) {
      throw new NoteNotFoundError(
        `apple-notes: target folder not found: ${JSON.stringify(args.folder)} — use folders.list to pick an existing folder`,
      );
    }
    const n = (parsed.note ?? {}) as Record<string, unknown>;
    return {
      id: typeof n.id === "string" ? n.id : "",
      title: typeof n.title === "string" ? n.title : args.title,
      folder: typeof n.folder === "string" ? n.folder : (args.folder ?? ""),
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// FAKE PROVIDER — deterministic in-memory fixtures; create mutates the store.
// ════════════════════════════════════════════════════════════════════════════════

/** One stored fixture note (html is authoritative; text derives when omitted). */
export interface FakeNote {
  id: string;
  title: string;
  folder: string;
  createdAt: string;
  modifiedAt: string;
  html: string;
  text: string;
}

/** Seeded deterministic fixtures for the fake provider + the hermetic probe. */
function seedFixtures(): { folders: NoteFolder[]; notes: FakeNote[] } {
  const mk = (
    id: string,
    title: string,
    folder: string,
    html: string,
    createdAt: string,
    modifiedAt: string,
  ): FakeNote => ({ id, title, folder, createdAt, modifiedAt, html, text: htmlToText(html) });
  return {
    folders: [
      { name: "Notes", account: "iCloud" },
      { name: "Recipes", account: "iCloud" },
      { name: "Work", account: "iCloud" },
    ],
    notes: [
      mk(
        "note-1",
        "Focaccia recipe",
        "Recipes",
        "<div><h1>Focaccia recipe</h1></div><div>500g flour, 400ml water, 10g salt</div><div>Proof overnight in the fridge.</div>",
        "2026-05-01T10:00:00.000Z",
        "2026-05-02T18:30:00.000Z",
      ),
      mk(
        "note-2",
        "Meeting notes 2026-06-20",
        "Work",
        "<div><h1>Meeting notes 2026-06-20</h1></div><div>Discussed the Plexus gateway rollout.</div><div>Action: draft the ADR.</div>",
        "2026-06-20T09:00:00.000Z",
        "2026-06-20T09:45:00.000Z",
      ),
      mk(
        "note-3",
        "Packing list",
        "Notes",
        "<div><h1>Packing list</h1></div><div>Passport</div><div>Chargers</div><div>Focaccia for the road</div>",
        "2026-06-01T08:00:00.000Z",
        "2026-06-15T12:00:00.000Z",
      ),
    ],
  };
}

/** Construction options for the fake provider. */
export interface FakeNotesProviderOptions {
  folders?: NoteFolder[];
  notes?: FakeNote[];
  /** Force the un-granted (Automation) state — available() reports the reason, calls throw. */
  notAuthorized?: boolean;
}

/**
 * In-memory fake. `available()` is always ok (no macOS permission needed) unless
 * forced `notAuthorized`. `createNote` MUTATES the store so a later search/read
 * reflects it — the create→read round-trip the tests assert. Like the seam itself,
 * there is NO update/delete/move method here.
 */
export class FakeNotesProvider implements NotesProvider {
  private readonly folders: NoteFolder[];
  private readonly notes: FakeNote[];
  private readonly notAuthorized: boolean;
  private seq = 0;

  constructor(opts: FakeNotesProviderOptions = {}) {
    const base = seedFixtures();
    this.folders = opts.folders ?? base.folders;
    this.notes = opts.notes ?? base.notes;
    this.notAuthorized = opts.notAuthorized ?? false;
  }

  private gate(): void {
    if (this.notAuthorized) throw new NotesNotAuthorizedError();
  }

  async available(): Promise<AvailabilityResult> {
    return this.notAuthorized ? { ok: false, reason: NOTES_TCC_MESSAGE } : { ok: true };
  }

  async listFolders(): Promise<NoteFolder[]> {
    this.gate();
    return this.folders.map((f) => ({ ...f }));
  }

  async searchNotes(query: SearchNotesQuery): Promise<NoteHit[]> {
    this.gate();
    const q = query.query.toLowerCase();
    return this.notes
      .filter((n) => n.title.toLowerCase().includes(q) || n.text.toLowerCase().includes(q))
      .slice(0, query.limit)
      .map((n) => ({
        id: n.id,
        title: n.title,
        folder: n.folder,
        modifiedAt: n.modifiedAt,
        snippet: makeSnippet(n.text),
      }));
  }

  async readNote(ref: { id?: string; title?: string }): Promise<NoteContent> {
    this.gate();
    const found = ref.id
      ? this.notes.find((n) => n.id === ref.id)
      : this.notes.find((n) => n.title === ref.title);
    if (!found) {
      const by = ref.id ? `id: ${JSON.stringify(ref.id)}` : `title: ${JSON.stringify(ref.title)}`;
      throw new NoteNotFoundError(`apple-notes: no note found by ${by}`);
    }
    return { ...found };
  }

  async createNote(args: CreateNoteArgs): Promise<CreatedNote> {
    this.gate();
    const folder = args.folder ?? this.folders[0]?.name ?? "Notes";
    if (args.folder && !this.folders.some((f) => f.name === args.folder)) {
      throw new NoteNotFoundError(
        `apple-notes: target folder not found: ${JSON.stringify(args.folder)} — use folders.list to pick an existing folder`,
      );
    }
    const now = new Date().toISOString();
    const html = `<div><h1>${escapeHtml(args.title)}</h1></div>${textToNotesHtml(args.body ?? "")}`;
    const note: FakeNote = {
      id: `note-fake-${++this.seq}`,
      title: args.title,
      folder,
      createdAt: now,
      modifiedAt: now,
      html,
      text: htmlToText(html),
    };
    this.notes.push(note);
    return { id: note.id, title: note.title, folder: note.folder };
  }
}

/**
 * SELECT the provider: an explicitly-injected one wins; otherwise the FAKE when
 * `PLEXUS_FAKE_APPLE === "1"` (the shared env every apple-* source honors — hermetic
 * tests + probes), else the REAL osascript/JXA provider. Selection lives here so the
 * source/bridge never branch on the env var themselves.
 */
export function selectNotesProvider(injected?: NotesProvider): NotesProvider {
  if (injected) return injected;
  if (process.env.PLEXUS_FAKE_APPLE === "1") return new FakeNotesProvider();
  return new RealNotesProvider();
}
