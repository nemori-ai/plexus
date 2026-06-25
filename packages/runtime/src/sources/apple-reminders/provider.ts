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

/** A raw spawn-and-capture (mirrors cc-master `launch.ts`; injectable for tests). */
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
    const listFilter = query.list ? `reminders of list ${asLiteral(query.list)}` : "reminders";
    const lines: string[] = [
      'set out to ""',
      'tell application "Reminders"',
      `  repeat with r in (${listFilter})`,
      '    set theDue to ""',
      "    try",
      "      if due date of r is not missing value then set theDue to (due date of r) as «class isot» as string",
      "    end try",
      `    set out to out & (id of r) & ${FLD_AS} & (name of container of r) & ${FLD_AS} & (name of r) & ${FLD_AS} & (body of r) & ${FLD_AS} & (completed of r) & ${FLD_AS} & theDue & ${REC_AS}`,
      "  end repeat",
      "end tell",
      "return out",
    ];
    const raw = await this.exec(lines.join("\n"), "listReminders");
    let items = parseRecords(raw).map(([id, list, title, notes, completed, due]) => {
      const item: Reminder = {
        id: id ?? "",
        list: list ?? "",
        title: title ?? "",
        completed: completed === "true",
      };
      if (notes) item.notes = notes;
      if (due) item.dueDate = due;
      return item;
    });
    if (typeof query.completed === "boolean") {
      items = items.filter((r) => r.completed === query.completed);
    }
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
