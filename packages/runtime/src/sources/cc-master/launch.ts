/**
 * Managed HEADLESS launcher for Claude Code (managed-headless launch, v1).
 *
 * The CONNECTOR is Claude Code (a first-party app Plexus launches + augments). This
 * module is the launch primitive: given `{ loadCcMaster, prompt }` it runs the
 * user's existing `claude` binary headless —
 *
 *   loadCcMaster:true  → `claude --plugin-dir <EMBEDDED cc-master> -p <prompt>`
 *   loadCcMaster:false → `claude -p <prompt>`
 *
 * captures stdout + the exit code, and returns a structured result. The embedded
 * plugin is injected via `--plugin-dir`, so the cc-master orchestration loads into a
 * Plexus-managed session WITHOUT ever mutating the user's `~/.claude` (no
 * settings.json merge, no enabledPlugins/marketplace writes).
 *
 * TESTABILITY / SAFETY: the `claude` resolver, the embedded-plugin dir resolver, and
 * the spawn-and-capture primitive are ALL injected, so tests substitute a FAKE
 * spawner (assert the argv) or a real spawn of a SYNTHETIC fixture plugin (marker
 * file proof). The default capture uses `node:child_process.spawn` for RAW stdout
 * capture (the platform seam's `spawnProcess` is NDJSON line-framed — wrong shape for
 * a one-shot `claude -p` text capture; the frozen `PlatformServices` interface is NOT
 * extended). This module NEVER reads or writes `~/.claude`.
 */

import { spawn } from "node:child_process";

import {
  EMBEDDED_PLUGIN_DIR,
  validateEmbeddedPlugin,
} from "./embedded-plugin.ts";

/** A raw spawn-and-capture: run argv to completion, capture stdout/stderr/exit. */
export interface CaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** The injectable spawn-and-capture primitive (default below; tests substitute). */
export type CaptureSpawn = (spec: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}) => Promise<CaptureResult>;

/** The minimal binary-resolver surface the launcher needs (the platform seam). */
export type ResolveBinary = (name: string) => Promise<string | undefined>;

/** Options for one managed headless launch. */
export interface LaunchOptions {
  /** When true, inject the embedded cc-master plugin via `--plugin-dir`. */
  loadCcMaster: boolean;
  /** The prompt handed to `claude -p`. */
  prompt: string;
  /** Extra working dir for the spawned process (optional). */
  cwd?: string;
  /** Hard timeout for the headless run (ms). Default 10 minutes. */
  timeoutMs?: number;
}

/** The structured result of a managed headless launch. */
export interface LaunchResult {
  /** True iff `claude` resolved, spawned, and exited 0. */
  ok: boolean;
  /** Captured stdout (the headless model output / NDJSON, verbatim). */
  output: string;
  /** Process exit code (null if killed). */
  exitCode: number | null;
  /** The argv that was (or would have been) spawned — for audit + diagnostics. */
  argv: string[];
  /** Whether the embedded cc-master plugin was injected. */
  ccMasterLoaded: boolean;
  /** Populated when the launch could not run (claude absent, embedded plugin bad). */
  reason?: string;
}

/** The dependencies a `ClaudeLauncher` closes over (all injected for tests). */
export interface LauncherDeps {
  /** Resolve `claude` to an absolute path (the platform seam's `resolveBinary`). */
  resolveBinary: ResolveBinary;
  /** The embedded plugin dir (defaults to the vendored cc-master copy). */
  embeddedPluginDir?: string;
  /** The spawn-and-capture primitive (defaults to raw `node:child_process.spawn`). */
  capture?: CaptureSpawn;
  /** Structural validator for the embedded plugin (defaults to the real one). */
  validate?: (dir: string) => { ok: boolean; reason?: string };
}

/** DEFAULT raw spawn-and-capture over `node:child_process.spawn`. */
export const defaultCapture: CaptureSpawn = (spec) =>
  new Promise<CaptureResult>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

/** The binary name Plexus launches (the first-party app it augments). */
export const CLAUDE_BINARY = "claude" as const;

/**
 * Build the headless argv for a launch. PURE + deterministic — the core of the
 * test that asserts `--plugin-dir <dir> -p` is present when `loadCcMaster:true` and
 * ABSENT when false. The embedded dir is injected so a SYNTHETIC fixture can stand in.
 */
export function buildLaunchArgv(opts: {
  loadCcMaster: boolean;
  prompt: string;
  embeddedPluginDir: string;
}): string[] {
  const args: string[] = [];
  if (opts.loadCcMaster) {
    args.push("--plugin-dir", opts.embeddedPluginDir);
  }
  args.push("-p", opts.prompt);
  return args;
}

/**
 * The managed headless launcher. Resolves `claude`, (when loading cc-master)
 * structurally validates the embedded plugin, builds the argv, and spawns-and-
 * captures one headless run. Returns a structured result. NEVER touches `~/.claude`.
 */
export class ClaudeLauncher {
  private readonly resolveBinary: ResolveBinary;
  private readonly embeddedPluginDir: string;
  private readonly capture: CaptureSpawn;
  private readonly validate: (dir: string) => { ok: boolean; reason?: string };

  constructor(deps: LauncherDeps) {
    this.resolveBinary = deps.resolveBinary;
    this.embeddedPluginDir = deps.embeddedPluginDir ?? EMBEDDED_PLUGIN_DIR;
    this.capture = deps.capture ?? defaultCapture;
    this.validate = deps.validate ?? ((dir) => validateEmbeddedPlugin(dir));
  }

  /** Resolve the argv this launcher WOULD spawn (no spawn). For audit/diagnostics. */
  argvFor(loadCcMaster: boolean, prompt: string): string[] {
    return buildLaunchArgv({ loadCcMaster, prompt, embeddedPluginDir: this.embeddedPluginDir });
  }

  /** Run one managed headless `claude` launch. */
  async launch(opts: LaunchOptions): Promise<LaunchResult> {
    const argv = this.argvFor(opts.loadCcMaster, opts.prompt);

    // 1. resolve the user's existing `claude` binary — fail cleanly if absent.
    const claude = await this.resolveBinary(CLAUDE_BINARY);
    if (!claude) {
      return {
        ok: false,
        output: "",
        exitCode: null,
        argv,
        ccMasterLoaded: opts.loadCcMaster,
        reason: "Claude Code (`claude`) not found on PATH — cannot launch a managed headless session.",
      };
    }

    // 2. when loading cc-master, STRUCTURALLY validate the embedded plugin first
    //    (files-on-disk only — never launches it). A bad embedded copy fails clean.
    if (opts.loadCcMaster) {
      const v = this.validate(this.embeddedPluginDir);
      if (!v.ok) {
        return {
          ok: false,
          output: "",
          exitCode: null,
          argv,
          ccMasterLoaded: true,
          reason: `embedded cc-master plugin invalid: ${v.reason ?? "unknown"}`,
        };
      }
    }

    // 3. spawn-and-capture the headless run.
    let res: CaptureResult;
    try {
      res = await this.capture({
        command: claude,
        args: argv,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000,
      });
    } catch (err) {
      return {
        ok: false,
        output: "",
        exitCode: null,
        argv,
        ccMasterLoaded: opts.loadCcMaster,
        reason: `headless launch failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const ok = res.exitCode === 0;
    return {
      ok,
      output: res.stdout,
      exitCode: res.exitCode,
      argv,
      ccMasterLoaded: opts.loadCcMaster,
      ...(ok ? {} : { reason: res.stderr.trim() || `claude exited ${res.exitCode}` }),
    };
  }
}
