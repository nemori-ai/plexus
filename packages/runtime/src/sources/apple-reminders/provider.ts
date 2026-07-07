/**
 * RemindersProvider — the OS-ACCESS SEAM for the Apple Reminders source.
 *
 * Everything that touches the macOS Reminders app lives behind this single
 * interface so the rest of the source (entries, bridge, health) is OS-agnostic and
 * HERMETICALLY TESTABLE. There are TWO implementations:
 *
 *  - `RealRemindersProvider` (real): shells out to `osascript` running AppleScript
 *    against the Reminders app (`tell application "Reminders" ...`). The FIRST such
 *    call triggers the macOS TCC consent prompt (Privacy ▸ Reminders); a denial
 *    surfaces as a precise, actionable reason rather than a crash. NEEDS macOS + a
 *    granted TCC permission to actually read/write.
 *
 *  - `FakeRemindersProvider` (fake): a deterministic IN-MEMORY fixture store.
 *    create/complete mutate the store; a subsequent list reflects the change.
 *    Needs NO macOS permission — used by the unit tests AND the hermetic live probe.
 *
 * SELECTION (`selectRemindersProvider`): real by default; the FAKE when
 * `PLEXUS_FAKE_APPLE === "1"` (so the automated probe never hits real TCC). A caller
 * may also inject a provider directly via the source/bridge constructor.
 */

import { spawn } from "node:child_process";

// ── DOMAIN SHAPES (provider-neutral; both impls return these) ────────────────────

/** A Reminders list ("Reminders", "Groceries", …). */
export interface ReminderList {
  /** Stable id (AppleScript `id` of the list; a synthetic id in the fake). */
  id: string;
  /** Display name of the list. */
  name: string;
}

/** A single reminder item. */
export interface Reminder {
  id: string;
  /** The list this reminder belongs to (by name). */
  list: string;
  title: string;
  notes?: string;
  completed: boolean;
  /** ISO-8601 due date if set. */
  dueDate?: string;
}

/** An availability probe result (drives source `health()` / `checkRequirements()`). */
export interface AvailabilityResult {
  ok: boolean;
  /** Precise, actionable reason when `ok:false` (e.g. a TCC-denied message). */
  reason?: string;
}

/** Filter for listing reminders. */
export interface ListRemindersQuery {
  /** Restrict to one list (by name). Omit ⇒ all lists. */
  list?: string;
  /** Filter by completion state. Omit ⇒ both. */
  completed?: boolean;
}

/** Args to create a reminder (the sensitive native WRITE). */
export interface CreateReminderArgs {
  /** Target list by name. Omit ⇒ the default list. */
  list?: string;
  title: string;
  notes?: string;
  /** ISO-8601 due date. */
  dueDate?: string;
}

/** The OS-access seam. */
export interface RemindersProvider {
  /** Is the Reminders backend reachable + permitted? (TCC probe for the real impl.) */
  available(): Promise<AvailabilityResult>;
  /** Enumerate the reminder lists. */
  listLists(): Promise<ReminderList[]>;
  /** List reminders, optionally filtered by list / completion. */
  listReminders(query?: ListRemindersQuery): Promise<Reminder[]>;
  /** Create a reminder (WRITE — mutates the user's Reminders). Returns the new item. */
  createReminder(args: CreateReminderArgs): Promise<Reminder>;
  /** Mark a reminder complete (WRITE). Returns the updated item. */
  completeReminder(args: { id: string }): Promise<Reminder>;
}

// ════════════════════════════════════════════════════════════════════════════════
// REAL PROVIDER — osascript / AppleScript against the Reminders app.
// ════════════════════════════════════════════════════════════════════════════════

/** A raw spawn-and-capture (mirrors claudecode `launch.ts`; injectable for tests). */
export interface OsascriptCapture {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Inject-able runner for `osascript -e <script>` (default below spawns real osascript). */
export type OsascriptRunner = (script: string) => Promise<OsascriptCapture>;

/** DEFAULT runner: spawn `osascript -e <script>` and capture stdout/stderr/exit. */
export const defaultOsascript: OsascriptRunner = (script: string) =>
  new Promise<OsascriptCapture>((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
  });

/**
 * Unambiguous separators for parsing AppleScript list output: ASCII Record Separator
 * (0x1E) between rows, Unit Separator (0x1F) between fields — so reminder titles with
 * spaces, commas, or newlines parse safely.
 */
const REC = String.fromCharCode(0x1e);
const FLD = String.fromCharCode(0x1f);
/** AppleScript literal for a single char by code, e.g. `(ASCII character 30)`. */
const REC_AS = "(ASCII character 30)";
const FLD_AS = "(ASCII character 31)";

/**
 * Map an osascript stderr/exit signal to a precise availability reason. A TCC denial
 * shows up as an error mentioning "Not authorized" / errAEEventNotPermitted (-1743) /
 * "doesn't have permission" — we surface the actionable System-Settings instruction.
 */
function tccReasonFrom(stderr: string): string {
  const s = stderr.toLowerCase();
  if (
    s.includes("-1743") ||
    s.includes("not authorized") ||
    s.includes("not allowed") ||
    s.includes("doesn't have permission") ||
    s.includes("does not have permission") ||
    s.includes("not permitted")
  ) {
    return "Reminders access not granted — approve Plexus in System Settings ▸ Privacy ▸ Reminders";
  }
  return stderr.trim() || "Reminders is not reachable via osascript";
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
function asLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The REAL provider. Every method runs a small AppleScript via the injected runner.
 * It NEVER throws on a permission/avail failure for `available()` — that returns a
 * structured reason. The mutating methods do throw on failure (the bridge maps that
 * to a transport_error).
 */
export class RealRemindersProvider implements RemindersProvider {
  constructor(private readonly run: OsascriptRunner = defaultOsascript) {}

  async available(): Promise<AvailabilityResult> {
    // Cheapest meaningful probe that still trips TCC: count the lists.
    try {
      const res = await this.run('tell application "Reminders" to return count of lists');
      if (res.exitCode === 0) return { ok: true };
      return { ok: false, reason: tccReasonFrom(res.stderr) };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      // osascript missing ⇒ not macOS / no Reminders scripting bridge.
      return { ok: false, reason: `Reminders unavailable: ${why}` };
    }
  }

  private async exec(script: string, op: string): Promise<string> {
    const res = await this.run(script);
    if (res.exitCode !== 0) {
      throw new Error(`apple-reminders ${op} failed: ${tccReasonFrom(res.stderr)}`);
    }
    return res.stdout;
  }

  async listLists(): Promise<ReminderList[]> {
    const script = [
      'set out to ""',
      'tell application "Reminders"',
      "  repeat with l in lists",
      `    set out to out & (name of l) & ${FLD_AS} & (id of l) & ${REC_AS}`,
      "  end repeat",
      "end tell",
      "return out",
    ].join("\n");
    const raw = await this.exec(script, "listLists");
    return parseRecords(raw).map(([name, id]) => ({ name: name ?? "", id: id ?? name ?? "" }));
  }

  async listReminders(query: ListRemindersQuery = {}): Promise<Reminder[]> {
    // SENSIBLE DEFAULT: when no explicit `completed` filter is given, scope to
    // INCOMPLETE reminders only — the overwhelmingly common case, and on a real
    // machine a tiny fraction of the (potentially thousands of) completed items.
    // An explicit `completed:true`/`false` overrides this default. This is filtered
    // in AppleScript via a `whose` clause so completed items never even cross the
    // Apple-Event boundary.
    const completedFilter = typeof query.completed === "boolean" ? query.completed : false;

    // The set of reminders to read, narrowed in AppleScript itself. `whose completed
    // is X` keeps the result set (and therefore every bulk property list below) small.
    const base = query.list ? `reminders of list ${asLiteral(query.list)}` : "reminders";
    const reminderSet = `(${base} whose completed is ${completedFilter ? "true" : "false"})`;

    // PERFORMANCE: BULK property access — one Apple Event PER PROPERTY across ALL
    // matching reminders, instead of the old O(N×6) per-item-per-property loop.
    // `<prop> of reminders ...` returns a LIST in a single Apple Event, so this is
    // ~6 events total regardless of how many reminders match. Each property list is
    // emitted as one REC-terminated block of FLD-joined values; the six parallel
    // lists are then ZIPPED back into Reminder records in TypeScript.
    const lines: string[] = [
      'set out to ""',
      'tell application "Reminders"',
      // Read each property DIRECTLY off the `whose`-filtered specifier (NOT via an
      // intermediate `set theReminders to (...)` variable). Capturing the filtered set
      // into a variable forces it into a LIST OF REFERENCES, and `id of {ref, ...}`
      // then errors -1728 ("Can't get id of {...}"). Applied directly, `id of (reminders
      // ... whose ...)` is the bulk specifier form that returns a value list in ONE
      // Apple Event. EMPTY-SET GUARD first: an empty set ⇒ return "" ⇒ parser yields [].
      `  if (count of ${reminderSet}) is 0 then return ""`,
      `  set theIds to id of ${reminderSet}`,
      `  set theContainers to name of container of ${reminderSet}`,
      `  set theNames to name of ${reminderSet}`,
      `  set theBodies to body of ${reminderSet}`,
      `  set theCompleted to completed of ${reminderSet}`,
      `  set theDues to due date of ${reminderSet}`,
      "end tell",
      // Emit six blocks, one per property: each is its values FLD-joined, terminated
      // by REC. The block ORDER is the parser contract (ids, lists, names, bodies,
      // completed, dues). `due date` may contain `missing value`, which AppleScript
      // coerces to an empty string inside the joined text below.
      `set AppleScript's text item delimiters to ${FLD_AS}`,
      `set out to out & (theIds as text) & ${REC_AS}`,
      `set out to out & (theContainers as text) & ${REC_AS}`,
      `set out to out & (theNames as text) & ${REC_AS}`,
      `set out to out & (joinBodies(theBodies)) & ${REC_AS}`,
      `set out to out & (theCompleted as text) & ${REC_AS}`,
      `set out to out & (joinDues(theDues)) & ${REC_AS}`,
      'set AppleScript\'s text item delimiters to ""',
      "return out",
      "",
      // Join the body list to FLD-separated text, mapping a `missing value` (absent
      // notes) to an empty string so the field count stays aligned with the ids list.
      "on joinBodies(theList)",
      "  set acc to {}",
      "  repeat with x in theList",
      "    if (contents of x) is missing value then",
      '      set end of acc to ""',
      "    else",
      "      set end of acc to (contents of x) as text",
      "    end if",
      "  end repeat",
      `  set AppleScript's text item delimiters to ${FLD_AS}`,
      "  set joined to acc as text",
      `  set AppleScript's text item delimiters to ""`,
      "  return joined",
      "end joinBodies",
      "",
      // Join the due-date list, mapping `missing value` (no due date) to an empty
      // string and a real date to a canonical ISO («class isot») string.
      "on joinDues(theList)",
      "  set acc to {}",
      "  repeat with x in theList",
      "    if (contents of x) is missing value then",
      '      set end of acc to ""',
      "    else",
      "      set end of acc to ((contents of x) as «class isot» as string)",
      "    end if",
      "  end repeat",
      `  set AppleScript's text item delimiters to ${FLD_AS}`,
      "  set joined to acc as text",
      `  set AppleScript's text item delimiters to ""`,
      "  return joined",
      "end joinDues",
    ];
    const raw = await this.exec(lines.join("\n"), "listReminders");
    const items = parseBulkReminders(raw, completedFilter);
    return items;
  }

  async createReminder(args: CreateReminderArgs): Promise<Reminder> {
    const props: string[] = [`name:${asLiteral(args.title)}`];
    if (args.notes) props.push(`body:${asLiteral(args.notes)}`);
    if (args.dueDate) props.push(`due date:(date ${asLiteral(args.dueDate)})`);
    const target = args.list ? `list ${asLiteral(args.list)}` : "default list";
    const script = [
      'tell application "Reminders"',
      `  set newR to make new reminder at end of ${target} with properties {${props.join(", ")}}`,
      `  return (id of newR) & ${FLD_AS} & (name of container of newR)`,
      "end tell",
    ].join("\n");
    const raw = await this.exec(script, "createReminder");
    const [id, list] = raw.trim().split(FLD);
    const out: Reminder = {
      id: id ?? "",
      list: list ?? args.list ?? "",
      title: args.title,
      completed: false,
    };
    if (args.notes) out.notes = args.notes;
    if (args.dueDate) out.dueDate = args.dueDate;
    return out;
  }

  async completeReminder(args: { id: string }): Promise<Reminder> {
    const script = [
      'tell application "Reminders"',
      `  set theR to first reminder whose id is ${asLiteral(args.id)}`,
      "  set completed of theR to true",
      `  return (id of theR) & ${FLD_AS} & (name of container of theR) & ${FLD_AS} & (name of theR)`,
      "end tell",
    ].join("\n");
    const raw = await this.exec(script, "completeReminder");
    const [id, list, title] = raw.trim().split(FLD);
    return { id: id ?? args.id, list: list ?? "", title: title ?? "", completed: true };
  }
}

/** Parse REC-delimited rows of FLD-delimited fields from AppleScript output. */
function parseRecords(raw: string): string[][] {
  return raw
    .split(REC)
    .map((r) => r.replace(/\n$/, ""))
    .filter((r) => r.length > 0)
    .map((r) => r.split(FLD));
}

/**
 * Parse the BULK listReminders output: SIX REC-terminated blocks, each a FLD-joined
 * list of one property across all matching reminders, in this fixed order —
 *   ids, lists(container names), titles(names), bodies, completed, dues.
 * The blocks are PARALLEL: field i of every block describes reminder i. We split each
 * block on FLD and ZIP the columns back into Reminder records.
 *
 * Robustness:
 *  - An EMPTY result set ⇒ AppleScript emits six empty blocks (just RECs) ⇒ no items.
 *  - The block delimiter is REC, but a block's own contents are FLD-joined, so the
 *    two never collide. We DON'T `.filter(length>0)` here (unlike parseRecords) because
 *    an empty property block is meaningful (it must still occupy its slot).
 *  - `completed` already filtered in AppleScript via `whose`; we pass the known value
 *    through rather than re-parsing a possibly-empty completed column ambiguously.
 */
function parseBulkReminders(raw: string, completed: boolean): Reminder[] {
  // Split into exactly the six property blocks (ignore any trailing fragment after the
  // last REC, e.g. a stray newline). Each block is the text BEFORE a REC.
  const blocks = raw.split(REC);
  const ids = splitBlock(blocks[0]);
  const lists = splitBlock(blocks[1]);
  const titles = splitBlock(blocks[2]);
  const bodies = splitBlock(blocks[3]);
  const completedCol = splitBlock(blocks[4]);
  const dues = splitBlock(blocks[5]);

  const n = ids.length;
  const items: Reminder[] = [];
  for (let i = 0; i < n; i++) {
    const item: Reminder = {
      id: ids[i] ?? "",
      list: lists[i] ?? "",
      title: titles[i] ?? "",
      // Prefer the per-item completed column when present (defends against any future
      // mixed query); fall back to the known filter value the script was built with.
      completed: completedCol[i] !== undefined ? completedCol[i] === "true" : completed,
    };
    const notes = bodies[i];
    if (notes) item.notes = notes;
    const due = dues[i];
    if (due) item.dueDate = due;
    items.push(item);
  }
  return items;
}

/**
 * Split ONE bulk property block (FLD-joined) into its field values. An empty block
 * (no reminders) yields ZERO fields, not one empty string — so the zip produces no
 * rows. A non-empty block of k items yields exactly k fields (AppleScript joins k
 * values with k-1 delimiters). Strip any trailing newline osascript appends.
 */
function splitBlock(block: string | undefined): string[] {
  if (block === undefined) return [];
  const cleaned = block.replace(/\n$/, "");
  if (cleaned === "") return [];
  return cleaned.split(FLD);
}

// ════════════════════════════════════════════════════════════════════════════════
// FAKE PROVIDER — deterministic in-memory fixture; mutations persist in the store.
// ════════════════════════════════════════════════════════════════════════════════

/** Seeded deterministic fixtures for the fake provider + the hermetic probe. */
function seedFixtures(): { lists: ReminderList[]; reminders: Reminder[] } {
  return {
    lists: [
      { id: "list-reminders", name: "Reminders" },
      { id: "list-groceries", name: "Groceries" },
    ],
    reminders: [
      { id: "rem-1", list: "Reminders", title: "Ship Plexus v1", notes: "the gateway", completed: false },
      { id: "rem-2", list: "Reminders", title: "Review ADR-018", completed: true },
      { id: "rem-3", list: "Groceries", title: "Oat milk", completed: false, dueDate: "2026-06-26T09:00:00" },
    ],
  };
}

/**
 * In-memory fake. `available()` is always ok (no macOS permission needed).
 * `createReminder`/`completeReminder` MUTATE the store so a later `listReminders`
 * reflects the change — the create→list round-trip the tests + probe assert.
 */
export class FakeRemindersProvider implements RemindersProvider {
  private lists: ReminderList[];
  private reminders: Reminder[];
  private seq = 0;

  constructor(seed?: { lists?: ReminderList[]; reminders?: Reminder[] }) {
    const base = seedFixtures();
    this.lists = seed?.lists ?? base.lists;
    this.reminders = seed?.reminders ?? base.reminders;
  }

  async available(): Promise<AvailabilityResult> {
    return { ok: true };
  }

  async listLists(): Promise<ReminderList[]> {
    return this.lists.map((l) => ({ ...l }));
  }

  async listReminders(query: ListRemindersQuery = {}): Promise<Reminder[]> {
    return this.reminders
      .filter((r) => (query.list ? r.list === query.list : true))
      .filter((r) => (typeof query.completed === "boolean" ? r.completed === query.completed : true))
      .map((r) => ({ ...r }));
  }

  async createReminder(args: CreateReminderArgs): Promise<Reminder> {
    const list = args.list ?? this.lists[0]?.name ?? "Reminders";
    const item: Reminder = {
      id: `rem-fake-${++this.seq}`,
      list,
      title: args.title,
      completed: false,
    };
    if (args.notes) item.notes = args.notes;
    if (args.dueDate) item.dueDate = args.dueDate;
    this.reminders.push(item);
    return { ...item };
  }

  async completeReminder(args: { id: string }): Promise<Reminder> {
    const found = this.reminders.find((r) => r.id === args.id);
    if (!found) throw new Error(`apple-reminders: no reminder with id ${args.id}`);
    found.completed = true;
    return { ...found };
  }
}

/**
 * SELECT the provider: an explicitly-injected one wins; otherwise the FAKE when
 * `PLEXUS_FAKE_APPLE === "1"` (hermetic tests + the live probe), else the REAL
 * osascript provider. Keeping selection here means the source/bridge never branch on
 * the env var themselves.
 */
export function selectRemindersProvider(injected?: RemindersProvider): RemindersProvider {
  if (injected) return injected;
  if (process.env.PLEXUS_FAKE_APPLE === "1") return new FakeRemindersProvider();
  return new RealRemindersProvider();
}
