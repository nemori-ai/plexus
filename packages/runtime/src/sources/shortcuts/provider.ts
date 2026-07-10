/**
 * ShortcutsProvider — the OS-ACCESS SEAM for the Apple Shortcuts source.
 *
 * Everything that touches the macOS `shortcuts` CLI lives behind this single
 * interface so the rest of the source (entries, bridge, health) is OS-agnostic and
 * HERMETICALLY TESTABLE. There are TWO implementations:
 *
 *  - `RealShortcutsProvider` (real): shells out to the system `shortcuts` CLI —
 *    `shortcuts list` (+ `--folders`) for discovery, `shortcuts run <name> [-i <file>]`
 *    for execution. macOS-only: on any other OS the binary is absent and `available()`
 *    reports a precise, actionable reason rather than crashing.
 *
 *  - `FakeShortcutsProvider` (fake): a deterministic in-memory fixture — a canned
 *    shortcut list plus canned run results — so tests and headless probes run green
 *    with no macOS and no real automation ever executed.
 *
 * SELECTION (`selectShortcutsProvider`): real by default; the FAKE when
 * `PLEXUS_FAKE_SHORTCUTS === "1"` (mirrors the `PLEXUS_FAKE_APPLE` pattern). A caller
 * may also inject a provider directly via the source/bridge constructor.
 *
 * THE EXECUTE GATE lives ABOVE this seam (see `shortcutsLaunchEnabled` + the bridge):
 * `shortcuts.run` follows the claudecode/codex record-mode precedent — the REAL (or
 * fake) execution only happens when the owner has opted in (persisted console setting,
 * `PLEXUS_SHORTCUTS_LAUNCH=1` as the env fallback); default OFF = record-mode, where
 * the bridge returns the exact command that WOULD have run without calling the
 * provider at all. Gating above the seam means the fake is gated exactly like the real.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { realLaunchEnabled } from "../config/settings.ts";

// ── DOMAIN SHAPES (provider-neutral; both impls return these) ────────────────────

/** One Apple Shortcut as discovered by `shortcuts list`. */
export interface ShortcutInfo {
  /** The shortcut's display name (the handle `shortcuts run` takes). */
  name: string;
  /** The folder the shortcut lives in, when known (the fake knows; the CLI list does not say). */
  folder?: string;
}

/** The discovery result: the shortcut names plus the folder names (when listable). */
export interface ShortcutsListing {
  shortcuts: ShortcutInfo[];
  /** Folder names from `shortcuts list --folders` (best-effort; empty when unavailable). */
  folders: string[];
}

/** An availability probe result (drives source `health()` / `checkRequirements()`). */
export interface AvailabilityResult {
  ok: boolean;
  /** Precise, actionable reason when `ok:false`. */
  reason?: string;
}

/** Args for one shortcut run (the sensitive EXECUTE). */
export interface RunShortcutArgs {
  /** The shortcut name (as listed) to run. */
  name: string;
  /** Optional text input handed to the shortcut as its input. */
  input?: string;
  /** Hard timeout (ms). Defaults to {@link DEFAULT_RUN_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** The structured outcome of one (real or fake) shortcut run. */
export interface ShortcutRunOutcome {
  /** True iff the shortcut ran to completion and exited 0 (and did not time out). */
  ok: boolean;
  /** True iff an execution actually happened (false when the binary was absent). */
  launched: boolean;
  /** The shortcut's captured stdout, verbatim. */
  output: string;
  /** Process exit code (null when killed / never spawned). */
  exitCode: number | null;
  /** True iff the run was killed at the timeout. */
  timedOut: boolean;
  /**
   * True iff the run could not proceed because the `shortcuts` CLI is ABSENT
   * (non-macOS). The bridge maps this to the `source_unavailable` ErrorCode.
   */
  binaryMissing?: boolean;
  /** Populated when the run could not proceed or failed. */
  reason?: string;
}

/** The OS-access seam. */
export interface ShortcutsProvider {
  /** Is the `shortcuts` CLI present + working? (Binary probe for the real impl.) */
  available(): Promise<AvailabilityResult>;
  /** Enumerate the user's shortcuts (names) + folder names. READ-ONLY. */
  listShortcuts(): Promise<ShortcutsListing>;
  /**
   * EXECUTE one named shortcut. Callers MUST gate this behind
   * {@link shortcutsLaunchEnabled} — the provider itself always executes.
   */
  runShortcut(args: RunShortcutArgs): Promise<ShortcutRunOutcome>;
}

// ── THE EXECUTE GATE + the pure argv builder ─────────────────────────────────────

/** The binary this source shells out to (Apple's first-party Shortcuts CLI). */
export const SHORTCUTS_BINARY = "shortcuts" as const;

/** Default hard timeout for one run (shortcuts are quick automations). */
export const DEFAULT_RUN_TIMEOUT_MS = 60_000;
/** Hard ceiling on the per-call timeout override. */
export const MAX_RUN_TIMEOUT_MS = 600_000;
/** Floor on the per-call timeout override. */
export const MIN_RUN_TIMEOUT_MS = 1_000;

/** Clamp an agent-supplied timeout override into [MIN, MAX]; absent ⇒ the default. */
export function clampRunTimeout(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_RUN_TIMEOUT_MS;
  return Math.min(MAX_RUN_TIMEOUT_MS, Math.max(MIN_RUN_TIMEOUT_MS, Math.floor(v)));
}

/**
 * The placeholder that stands in for the agent's input text in the PREDICTED /
 * audited argv. The real run passes `-i <temp file carrying the text>`; the raw
 * input text itself never appears in an argv (it rides the audit `input`, where
 * the single writer redacts + truncates).
 */
export const INPUT_PLACEHOLDER = "«input»" as const;

/**
 * Build the `shortcuts` subcommand args for one run:
 *
 *   run <name> [-i <input-path>]
 *
 * PURE + deterministic — the core the record-mode test asserts. `-i` takes a FILE
 * PATH per the CLI contract; the real runner materializes the agent's text input
 * into a temp file, record-mode predicts with {@link INPUT_PLACEHOLDER}.
 */
export function buildRunArgs(name: string, inputPath?: string): string[] {
  return ["run", name, ...(inputPath !== undefined ? ["-i", inputPath] : [])];
}

/**
 * SAFETY GATE: `shortcuts.run` only really executes when the owner opted in —
 * EXACTLY the claudecode/codex precedent (`realLaunchEnabled`): the persisted
 * console setting (Sources → Shortcuts → "Real launch") wins when set; the
 * `PLEXUS_SHORTCUTS_LAUNCH=1` env flag stays as the recipe/test fallback; absent
 * both ⇒ OFF (record-mode). Consulted PER CALL — live toggle, no restart.
 */
export function shortcutsLaunchEnabled(): boolean {
  return realLaunchEnabled("shortcuts", "PLEXUS_SHORTCUTS_LAUNCH");
}

// ════════════════════════════════════════════════════════════════════════════════
// REAL PROVIDER — the macOS `shortcuts` CLI.
// ════════════════════════════════════════════════════════════════════════════════

/** A raw CLI capture (mirrors claudecode's CaptureResult, plus the timeout flag). */
export interface CliCapture {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True iff the process was killed at the timeout. */
  timedOut: boolean;
}

/** Injectable spawn-and-capture runner (default below; tests substitute). */
export type CliRunner = (spec: {
  command: string;
  args: string[];
  timeoutMs?: number;
}) => Promise<CliCapture>;

/**
 * DEFAULT runner: `node:child_process.spawn`, raw stdout/stderr capture, SIGKILL at
 * the timeout (reported as `timedOut:true`, never a throw). A spawn failure (binary
 * absent ⇒ ENOENT) REJECTS — callers map that to a structured availability outcome.
 */
export const defaultCliRunner: CliRunner = (spec) =>
  new Promise<CliCapture>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (spec.timeoutMs && spec.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
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
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });
  });

/** True iff a spawn error means "the binary does not exist" (non-macOS / no CLI). */
function isBinaryMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** The one actionable unavailable reason (non-macOS / CLI absent). */
export const SHORTCUTS_UNAVAILABLE_REASON =
  "the `shortcuts` CLI is not available — Apple Shortcuts requires macOS" as const;

/** Split CLI list output into trimmed, non-empty lines. */
function lines(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * The REAL provider. Discovery shells `shortcuts list` / `shortcuts list --folders`;
 * execution shells `shortcuts run <name> [-i <temp input file>]` with a hard timeout.
 * `available()` NEVER throws — a missing binary returns a structured reason.
 */
export class RealShortcutsProvider implements ShortcutsProvider {
  constructor(private readonly run: CliRunner = defaultCliRunner) {}

  async available(): Promise<AvailabilityResult> {
    // The cheapest meaningful probe: list the shortcuts (read-only, no execution).
    try {
      const res = await this.run({ command: SHORTCUTS_BINARY, args: ["list"], timeoutMs: 15_000 });
      if (res.exitCode === 0) return { ok: true };
      return {
        ok: false,
        reason: res.stderr.trim() || "the `shortcuts` CLI is present but not responding",
      };
    } catch (err) {
      if (isBinaryMissing(err)) return { ok: false, reason: SHORTCUTS_UNAVAILABLE_REASON };
      const why = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `Shortcuts unavailable: ${why}` };
    }
  }

  async listShortcuts(): Promise<ShortcutsListing> {
    const res = await this.run({ command: SHORTCUTS_BINARY, args: ["list"], timeoutMs: 30_000 });
    if (res.exitCode !== 0) {
      throw new Error(`shortcuts list failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
    }
    const shortcuts: ShortcutInfo[] = lines(res.stdout).map((name) => ({ name }));

    // Folders are best-effort enrichment — an older CLI without `--folders` (or any
    // hiccup) degrades to an empty folder list, never a failed listing.
    let folders: string[] = [];
    try {
      const f = await this.run({
        command: SHORTCUTS_BINARY,
        args: ["list", "--folders"],
        timeoutMs: 30_000,
      });
      if (f.exitCode === 0) folders = lines(f.stdout);
    } catch {
      /* best-effort */
    }
    return { shortcuts, folders };
  }

  async runShortcut(args: RunShortcutArgs): Promise<ShortcutRunOutcome> {
    const timeoutMs = args.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

    // `-i` takes a FILE PATH (the CLI contract), so materialize the agent's text
    // input into a private temp file for the duration of the run.
    let tempDir: string | undefined;
    let inputPath: string | undefined;
    if (args.input !== undefined) {
      tempDir = mkdtempSync(join(tmpdir(), "plexus-shortcuts-input-"));
      inputPath = join(tempDir, "input.txt");
      writeFileSync(inputPath, args.input, "utf-8");
    }

    try {
      const res = await this.run({
        command: SHORTCUTS_BINARY,
        args: buildRunArgs(args.name, inputPath),
        timeoutMs,
      });
      const ok = res.exitCode === 0 && !res.timedOut;
      return {
        ok,
        launched: true,
        output: res.stdout,
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        ...(ok
          ? {}
          : {
              reason: res.timedOut
                ? `shortcut run timed out after ${timeoutMs}ms and was killed`
                : res.stderr.trim() || `shortcuts exited ${res.exitCode}`,
            }),
      };
    } catch (err) {
      if (isBinaryMissing(err)) {
        return {
          ok: false,
          launched: false,
          output: "",
          exitCode: null,
          timedOut: false,
          binaryMissing: true,
          reason: SHORTCUTS_UNAVAILABLE_REASON,
        };
      }
      return {
        ok: false,
        launched: false,
        output: "",
        exitCode: null,
        timedOut: false,
        reason: `shortcut run failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      if (tempDir) {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// FAKE PROVIDER — deterministic canned fixtures; no macOS, nothing real ever runs.
// ════════════════════════════════════════════════════════════════════════════════

/** Seeded deterministic fixtures for the fake provider + hermetic tests. */
function seedFixtures(): ShortcutsListing {
  return {
    shortcuts: [
      { name: "Good Morning", folder: "Routines" },
      { name: "Add to Grocery List", folder: "Home" },
      { name: "Make QR Code" },
    ],
    folders: ["Routines", "Home"],
  };
}

/**
 * In-memory fake. `available()` is always ok (no macOS needed). `runShortcut`
 * returns a deterministic canned outcome that echoes the name (+ input when given),
 * so the gate-ON test can assert a real execution happened THROUGH the gate without
 * any real automation running.
 */
export class FakeShortcutsProvider implements ShortcutsProvider {
  private readonly listing: ShortcutsListing;
  /** Every runShortcut call, recorded — tests assert the gate kept this empty. */
  readonly runs: RunShortcutArgs[] = [];

  constructor(seed?: Partial<ShortcutsListing>) {
    const base = seedFixtures();
    this.listing = {
      shortcuts: seed?.shortcuts ?? base.shortcuts,
      folders: seed?.folders ?? base.folders,
    };
  }

  async available(): Promise<AvailabilityResult> {
    return { ok: true };
  }

  async listShortcuts(): Promise<ShortcutsListing> {
    return {
      shortcuts: this.listing.shortcuts.map((s) => ({ ...s })),
      folders: [...this.listing.folders],
    };
  }

  async runShortcut(args: RunShortcutArgs): Promise<ShortcutRunOutcome> {
    this.runs.push({ ...args });
    const known = this.listing.shortcuts.some((s) => s.name === args.name);
    if (!known) {
      return {
        ok: false,
        launched: true,
        output: "",
        exitCode: 1,
        timedOut: false,
        reason: `no shortcut named "${args.name}"`,
      };
    }
    return {
      ok: true,
      launched: true,
      output:
        args.input !== undefined
          ? `fake-ran: ${args.name} ← ${args.input}`
          : `fake-ran: ${args.name}`,
      exitCode: 0,
      timedOut: false,
    };
  }
}

/**
 * SELECT the provider: an explicitly-injected one wins; otherwise the FAKE when
 * `PLEXUS_FAKE_SHORTCUTS === "1"` (hermetic tests, headless probes), else the REAL
 * CLI provider. Keeping selection here means the source/bridge never branch on the
 * env var themselves (the PLEXUS_FAKE_APPLE pattern).
 */
export function selectShortcutsProvider(injected?: ShortcutsProvider): ShortcutsProvider {
  if (injected) return injected;
  if (process.env.PLEXUS_FAKE_SHORTCUTS === "1") return new FakeShortcutsProvider();
  return new RealShortcutsProvider();
}
