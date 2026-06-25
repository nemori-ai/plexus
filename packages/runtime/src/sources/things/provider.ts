/**
 * Things 3 OS-access provider — the INJECTABLE seam (hermetic tests + live).
 *
 * Things 3 has two DISTINCT access surfaces, and this provider abstracts BOTH behind
 * one interface so the source/bridge never touch the OS directly:
 *
 *   READ  via the AppleScript dictionary — `osascript` queries `application "Things3"`
 *         for to-dos / projects. A pure read; no mutation.
 *   WRITE via the Things URL-scheme — `things:///add?title=...&notes=...&when=...` is a
 *         well-blast-radius "append a to-do" mechanism (NOT arbitrary AppleScript
 *         mutation). On darwin we `open` the URL; Things consumes it and adds the to-do.
 *
 * TWO IMPLEMENTATIONS:
 *   - {@link RealThingsProvider}: READ via osascript/AppleScript, WRITE via the
 *     `things:///add` URL-scheme — both routed through an injected spawn-and-capture
 *     primitive (the platform seam shape), never a bare global.
 *   - {@link FakeThingsProvider}: an in-memory fixture (sample to-dos/projects;
 *     `addTodo` mutates the store) for tests + the e2e probe. NO real OS access.
 *
 * SELECTION ({@link selectThingsProvider}): real by default; the FAKE when
 * `process.env.PLEXUS_FAKE_APPLE === "1"`, or an explicit provider injected via the
 * source/bridge constructor. So the automated probe NEVER reaches real Things.
 */

/** A single Things to-do (the read projection — the fields agents actually cite). */
export interface ThingsTodo {
  /** Stable Things id (AppleScript `id of to do`); synthetic in the fake store. */
  id: string;
  title: string;
  /** Free-text notes body (may be empty). */
  notes: string;
  /** Status: open / completed / canceled. */
  status: "open" | "completed" | "canceled";
  /** The list/area/project this to-do lives under (best-effort label). */
  list?: string;
  /** ISO-ish due date string if set, else undefined. */
  due?: string;
}

/** A single Things project (the read projection). */
export interface ThingsProject {
  id: string;
  title: string;
  /** The area this project belongs to, if any. */
  area?: string;
  status: "open" | "completed" | "canceled";
}

/** Arguments for the URL-scheme `things:///add`. */
export interface AddTodoArgs {
  title: string;
  notes?: string;
  /** Things `when` value: today | tomorrow | evening | anytime | someday | a date. */
  when?: string;
  /** Target list/project name (Things `list` param). */
  list?: string;
}

/** The result of an add (URL-scheme write). `id` is present only for the fake store. */
export interface AddTodoResult {
  ok: boolean;
  /** The `things:///add?...` URL that was (or would be) opened — for audit/diagnostics. */
  url: string;
  /** Synthetic id of the created to-do (fake store only; the URL-scheme returns none). */
  id?: string;
  reason?: string;
}

/** Availability probe result (drives source HEALTH). */
export interface ThingsAvailability {
  ok: boolean;
  /** Why unavailable (when `ok:false`) or a resolved note (when `ok:true`). */
  reason?: string;
}

/**
 * The OS-access seam. The source/bridge depend on THIS, never on osascript / open /
 * a URL-scheme directly — so tests inject the fake and the e2e probe stays hermetic.
 */
export interface ThingsProvider {
  /** Is Things 3 reachable? (installed app / automation access). Drives health(). */
  available(): Promise<ThingsAvailability>;
  /** READ: list to-dos (optionally confined to a named list). AppleScript in real. */
  listTodos(opts?: { list?: string }): Promise<ThingsTodo[]>;
  /** READ: list projects. AppleScript in real. */
  listProjects(): Promise<ThingsProject[]>;
  /** WRITE: append a to-do via the `things:///add` URL-scheme. */
  addTodo(args: AddTodoArgs): Promise<AddTodoResult>;
}

// ──────────────────────────────────────────────────────────────────────────
// Spawn-and-capture seam (the platform shape) — injected so the real provider
// is testable and nothing reaches a bare global.
// ──────────────────────────────────────────────────────────────────────────

/** A raw spawn-and-capture (mirrors cc-master's `CaptureSpawn`). */
export interface CaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** The injectable spawn-and-capture primitive (default uses node:child_process). */
export type CaptureSpawn = (spec: {
  command: string;
  args: string[];
  timeoutMs?: number;
}) => Promise<CaptureResult>;

/** DEFAULT raw spawn-and-capture over `node:child_process.spawn` (lazy import). */
export const defaultCapture: CaptureSpawn = async (spec) => {
  const { spawn } = await import("node:child_process");
  return new Promise<CaptureResult>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (spec.timeoutMs && spec.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* best-effort */
        }
      }, spec.timeoutMs);
    }
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
};

// ──────────────────────────────────────────────────────────────────────────
// REAL provider — AppleScript READ + URL-scheme WRITE.
// ──────────────────────────────────────────────────────────────────────────

/** A field separator unlikely to appear in titles/notes — used to parse osascript rows. */
const FIELD = ""; // ASCII Unit Separator
const ROW = ""; // ASCII Record Separator

/**
 * Build the AppleScript that emits to-dos as `FIELD`-separated rows. We collect into a
 * delimited string rather than an AppleScript list literal so parsing is robust against
 * titles containing quotes/commas. `whose` filters confine to a named list when given.
 */
function listTodosScript(list?: string): string {
  const sel = list
    ? `to dos of list ${asAppleScriptString(list)}`
    : `to dos`;
  return [
    `tell application "Things3"`,
    `  set out to ""`,
    `  repeat with t in (${sel})`,
    `    set theStatus to (status of t) as text`,
    `    set theList to ""`,
    `    try`,
    `      set theList to (name of (project of t))`,
    `    end try`,
    `    set out to out & (id of t) & "${FIELD}" & (name of t) & "${FIELD}" & (notes of t) & "${FIELD}" & theStatus & "${FIELD}" & theList & "${ROW}"`,
    `  end repeat`,
    `  return out`,
    `end tell`,
  ].join("\n");
}

function listProjectsScript(): string {
  return [
    `tell application "Things3"`,
    `  set out to ""`,
    `  repeat with p in projects`,
    `    set theStatus to (status of p) as text`,
    `    set theArea to ""`,
    `    try`,
    `      set theArea to (name of (area of p))`,
    `    end try`,
    `    set out to out & (id of p) & "${FIELD}" & (name of p) & "${FIELD}" & theStatus & "${FIELD}" & theArea & "${ROW}"`,
    `  end repeat`,
    `  return out`,
    `end tell`,
  ].join("\n");
}

/** Quote a string as an AppleScript string literal (escape backslash + double-quote). */
function asAppleScriptString(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function normStatus(s: string): "open" | "completed" | "canceled" {
  const v = s.toLowerCase();
  if (v.includes("complete")) return "completed";
  if (v.includes("cancel")) return "canceled";
  return "open";
}

/** Build the `things:///add?...` URL for a write (the well-blast-radius add mechanism). */
export function buildAddUrl(args: AddTodoArgs): string {
  const q = new URLSearchParams();
  q.set("title", args.title);
  if (args.notes) q.set("notes", args.notes);
  if (args.when) q.set("when", args.when);
  if (args.list) q.set("list", args.list);
  return `things:///add?${q.toString()}`;
}

/** Dependencies for {@link RealThingsProvider} (all injected → testable). */
export interface RealThingsDeps {
  /** Spawn-and-capture (default: node:child_process). */
  capture?: CaptureSpawn;
  /** Resolve a binary to an absolute path (the platform seam). Optional. */
  resolveBinary?: (name: string) => Promise<string | undefined>;
  /** Hard timeout for an osascript read (ms). */
  timeoutMs?: number;
}

/**
 * REAL provider: READ through `osascript` (AppleScript dictionary), WRITE through the
 * `things:///add` URL-scheme (`open` on darwin). Both go through the injected capture
 * primitive (the platform spawn shape) — nothing reaches a bare global.
 */
export class RealThingsProvider implements ThingsProvider {
  private readonly capture: CaptureSpawn;
  private readonly resolveBinary?: (name: string) => Promise<string | undefined>;
  private readonly timeoutMs: number;

  constructor(deps: RealThingsDeps = {}) {
    this.capture = deps.capture ?? defaultCapture;
    this.resolveBinary = deps.resolveBinary;
    this.timeoutMs = deps.timeoutMs ?? 15_000;
  }

  /** Run an osascript snippet and return raw stdout (throws on non-zero exit). */
  private async runOsascript(script: string): Promise<string> {
    const bin = (await this.resolveBinary?.("osascript")) ?? "osascript";
    const res = await this.capture({ command: bin, args: ["-e", script], timeoutMs: this.timeoutMs });
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `osascript exited ${res.exitCode}`);
    }
    return res.stdout;
  }

  async available(): Promise<ThingsAvailability> {
    // Probe: does `application "Things3"` exist? `osascript` returns its version when
    // the app is installed/scriptable; an error means not installed or no automation.
    try {
      const out = await this.runOsascript(
        `tell application "Things3" to return version`,
      );
      const v = out.trim();
      return { ok: true, ...(v ? { reason: `Things3 ${v}` } : {}) };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        reason: `Things 3 not found — install it / grant automation access (${why})`,
      };
    }
  }

  async listTodos(opts?: { list?: string }): Promise<ThingsTodo[]> {
    const out = await this.runOsascript(listTodosScript(opts?.list));
    return out
      .split(ROW)
      .map((r) => r.trim())
      .filter((r) => r.length > 0)
      .map((r) => {
        const [id, title, notes, status, list] = r.split(FIELD);
        const todo: ThingsTodo = {
          id: id ?? "",
          title: title ?? "",
          notes: notes ?? "",
          status: normStatus(status ?? ""),
        };
        if (list) todo.list = list;
        return todo;
      });
  }

  async listProjects(): Promise<ThingsProject[]> {
    const out = await this.runOsascript(listProjectsScript());
    return out
      .split(ROW)
      .map((r) => r.trim())
      .filter((r) => r.length > 0)
      .map((r) => {
        const [id, title, status, area] = r.split(FIELD);
        const project: ThingsProject = {
          id: id ?? "",
          title: title ?? "",
          status: normStatus(status ?? ""),
        };
        if (area) project.area = area;
        return project;
      });
  }

  async addTodo(args: AddTodoArgs): Promise<AddTodoResult> {
    const url = buildAddUrl(args);
    // WRITE via the URL-scheme: on darwin `open <url>` hands it to Things, which adds the
    // to-do. The URL-scheme returns no id, so we report ok by exit code only.
    const bin = (await this.resolveBinary?.("open")) ?? "open";
    try {
      const res = await this.capture({ command: bin, args: [url], timeoutMs: this.timeoutMs });
      if (res.exitCode !== 0) {
        return { ok: false, url, reason: res.stderr.trim() || `open exited ${res.exitCode}` };
      }
      return { ok: true, url };
    } catch (err) {
      return { ok: false, url, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// FAKE provider — in-memory fixture for tests + the e2e probe.
// ──────────────────────────────────────────────────────────────────────────

/** Seed fixture: a couple of sample to-dos + projects so reads return real shapes. */
function seedTodos(): ThingsTodo[] {
  return [
    { id: "fake-todo-1", title: "Buy oat milk", notes: "the barista kind", status: "open", list: "Groceries" },
    { id: "fake-todo-2", title: "Email the dentist", notes: "", status: "open", list: "Errands" },
  ];
}

function seedProjects(): ThingsProject[] {
  return [
    { id: "fake-proj-1", title: "Ship Plexus", area: "Work", status: "open" },
    { id: "fake-proj-2", title: "Plan vacation", area: "Personal", status: "open" },
  ];
}

/**
 * In-memory fake. `addTodo` MUTATES the store (so an add→list round-trip really shows
 * the new to-do), and `available()` is always ok. Constructed with a fresh seed unless
 * a starting fixture is supplied.
 */
export class FakeThingsProvider implements ThingsProvider {
  private todos: ThingsTodo[];
  private projects: ThingsProject[];
  private seq = 0;

  constructor(opts?: { todos?: ThingsTodo[]; projects?: ThingsProject[] }) {
    this.todos = opts?.todos ? [...opts.todos] : seedTodos();
    this.projects = opts?.projects ? [...opts.projects] : seedProjects();
  }

  async available(): Promise<ThingsAvailability> {
    return { ok: true, reason: "fake Things provider (in-memory fixture)" };
  }

  async listTodos(opts?: { list?: string }): Promise<ThingsTodo[]> {
    const all = this.todos.map((t) => ({ ...t }));
    if (opts?.list) return all.filter((t) => t.list === opts.list);
    return all;
  }

  async listProjects(): Promise<ThingsProject[]> {
    return this.projects.map((p) => ({ ...p }));
  }

  async addTodo(args: AddTodoArgs): Promise<AddTodoResult> {
    const url = buildAddUrl(args);
    const id = `fake-todo-${++this.seq + 100}`;
    const todo: ThingsTodo = {
      id,
      title: args.title,
      notes: args.notes ?? "",
      status: "open",
      ...(args.list ? { list: args.list } : {}),
      ...(args.when ? { due: args.when } : {}),
    };
    this.todos.push(todo);
    return { ok: true, url, id };
  }

  /** Test helper: current store size. */
  count(): number {
    return this.todos.length;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Selection.
// ──────────────────────────────────────────────────────────────────────────

/** True when the fake provider is forced via the env switch. */
export function fakeAppleForced(): boolean {
  return process.env.PLEXUS_FAKE_APPLE === "1";
}

/**
 * Pick the provider: an explicitly injected one wins; else the FAKE when
 * `PLEXUS_FAKE_APPLE=1`; else the REAL osascript/URL-scheme provider. Keeps the
 * automated probe hermetic (no real Things access) while defaulting to live.
 */
export function selectThingsProvider(injected?: ThingsProvider): ThingsProvider {
  if (injected) return injected;
  if (fakeAppleForced()) return new FakeThingsProvider();
  return new RealThingsProvider();
}
