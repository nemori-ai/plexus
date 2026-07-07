/**
 * Managed HEADLESS launcher for Claude Code (managed-headless launch, v1).
 *
 * The CONNECTOR is Claude Code (a first-party app Plexus launches). This module is
 * the launch primitive: given `{ prompt }` it runs the user's existing `claude`
 * binary headless (`claude -p <prompt>`), captures stdout + the exit code, and
 * returns a structured result.
 *
 * TESTABILITY / SAFETY: the `claude` resolver and the spawn-and-capture primitive
 * are BOTH injected, so tests substitute a FAKE spawner (assert the argv). The
 * default capture uses `node:child_process.spawn` for RAW stdout capture (the
 * platform seam's `spawnProcess` is NDJSON line-framed — wrong shape for a one-shot
 * `claude -p` text capture; the frozen `PlatformServices` interface is NOT
 * extended). This module NEVER reads or writes `~/.claude`.
 */

import { spawn } from "node:child_process";

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
  /** Populated when the launch could not run (claude absent). */
  reason?: string;
}

/** The dependencies a `ClaudeLauncher` closes over (all injected for tests). */
export interface LauncherDeps {
  /** Resolve `claude` to an absolute path (the platform seam's `resolveBinary`). */
  resolveBinary: ResolveBinary;
  /** The spawn-and-capture primitive (defaults to raw `node:child_process.spawn`). */
  capture?: CaptureSpawn;
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

/** The binary name Plexus launches (the first-party app it exposes). */
export const CLAUDE_BINARY = "claude" as const;

/**
 * Build the headless argv for a launch. PURE + deterministic — the core the argv
 * tests assert against.
 */
export function buildLaunchArgv(opts: { prompt: string }): string[] {
  return ["-p", opts.prompt];
}

/**
 * The managed headless launcher. Resolves `claude`, builds the argv, and spawns-
 * and-captures one headless run. Returns a structured result. NEVER touches
 * `~/.claude`.
 */
export class ClaudeLauncher {
  private readonly resolveBinary: ResolveBinary;
  private readonly capture: CaptureSpawn;

  constructor(deps: LauncherDeps) {
    this.resolveBinary = deps.resolveBinary;
    this.capture = deps.capture ?? defaultCapture;
  }

  /** Resolve the argv this launcher WOULD spawn (no spawn). For audit/diagnostics. */
  argvFor(prompt: string): string[] {
    return buildLaunchArgv({ prompt });
  }

  /** Run one managed headless `claude` launch. */
  async launch(opts: LaunchOptions): Promise<LaunchResult> {
    const argv = this.argvFor(opts.prompt);

    // 1. resolve the user's existing `claude` binary — fail cleanly if absent.
    const claude = await this.resolveBinary(CLAUDE_BINARY);
    if (!claude) {
      return {
        ok: false,
        output: "",
        exitCode: null,
        argv,
        reason: "Claude Code (`claude`) not found on PATH — cannot launch a managed headless session.",
      };
    }

    // 2. spawn-and-capture the headless run.
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
        reason: `headless launch failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const ok = res.exitCode === 0;
    return {
      ok,
      output: res.stdout,
      exitCode: res.exitCode,
      argv,
      ...(ok ? {} : { reason: res.stderr.trim() || `claude exited ${res.exitCode}` }),
    };
  }
}
