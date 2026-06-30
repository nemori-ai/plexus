/**
 * Sandboxed headless Codex launcher (the `codex.run` capability core).
 *
 * The analog of `sources/claudecode/launcher.ts`, for the local **Codex CLI**. It
 * runs `codex exec` HEADLESS, CONFINED by macOS `sandbox-exec` to a single
 * authorized directory (the JAIL). Codex does real work inside the jail; every
 * read/write OUTSIDE the jail fails at the kernel level. The calling agent NEVER
 * sees a shell or the launch command — only the `codex.run` capability.
 *
 * MECHANISM — we rewrite the inner Codex spawn
 *
 *     codex exec --dangerously-bypass-approvals-and-sandbox "<task>"
 *
 * into
 *
 *     TMPDIR="$JAIL/.tmp" sandbox-exec -f <codex-confine.sb> \
 *       -D JAIL=$JAIL -D HOMEDIR=$HOME -D CODEX_BIN_DIR=<...> \
 *       codex exec --dangerously-bypass-approvals-and-sandbox "<task>"
 *
 * with cwd = $JAIL. Because the kernel seatbelt is the real jail, telling Codex to
 * bypass its OWN approval prompts + internal sandbox is SAFE — Plexus (not Codex)
 * decides which directory Codex may touch.
 *
 * CONFINEMENT (defense-in-depth, the path layer): the authorized dir and the spawn
 * cwd are validated with `realpathSync` + `confineToVault` / `lexicalConfine`
 * (reused from `sources/obsidian/vault-reader.ts`), so a traversal / absolute /
 * symlink-escape sub-path is rejected with `VaultConfinementError` BEFORE any spawn.
 *
 * TESTABILITY: the real spawn is gated behind `PLEXUS_CODEX_HEADLESS_LAUNCH=1`
 * (default OFF = record-mode, no spawn). When OFF, `run()` returns the exact argv +
 * sandbox-exec wrapper it WOULD have spawned. The underlying raw spawn is itself
 * injectable, so tests can drive a fake `codex` shim under a real `sandbox-exec`.
 */

import { realpathSync } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultCapture,
  type CaptureResult,
  type CaptureSpawn,
  type ResolveBinary,
} from "../cc-master/launch.ts";
import {
  confineToVault,
  lexicalConfine,
  VaultConfinementError,
} from "../obsidian/vault-reader.ts";

/** The macOS sandbox wrapper binary. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec" as const;

/** The binary name Plexus launches (the local Codex CLI). */
export const CODEX_BINARY = "codex" as const;

/**
 * Codex's non-interactive headless flags. `exec` is the non-interactive subcommand;
 * `--dangerously-bypass-approvals-and-sandbox` skips Codex's own approval prompts +
 * internal sandbox — SAFE here because the macOS seatbelt is the real jail.
 */
export const CODEX_EXEC_SUBCOMMAND = "exec" as const;
export const BYPASS_FLAGS = ["--dangerously-bypass-approvals-and-sandbox"] as const;

/** Default authorized directory (the one jail the source confines Codex to). */
export function defaultAuthorizedDir(): string {
  return join(homedir(), "PlexusDemo", "pomodoro");
}

/**
 * Resolve the absolute path to the bundled `codex-confine.sb` profile (next to this
 * module, under `sandbox/`). An env override (`PLEXUS_CODEX_CONFINE_PROFILE`) lets a
 * packaged build point at an extracted resource; dev resolves relative to here.
 */
export function resolveConfineProfile(): string {
  const env = process.env.PLEXUS_CODEX_CONFINE_PROFILE;
  if (env && env.length > 0) return env;
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), "sandbox", "codex-confine.sb");
}

/** SAFETY GATE: only really spawn when explicitly enabled (mirrors claudecode). */
export function headlessLaunchEnabled(): boolean {
  return process.env.PLEXUS_CODEX_HEADLESS_LAUNCH === "1";
}

/** The audit/diagnostic shape returned by a (record-mode or real) sandboxed run. */
export interface SandboxedRunResult {
  /** True iff Codex resolved, spawned under the sandbox, and exited 0. */
  ok: boolean;
  /** True iff a real spawn happened (false in record-mode — the guardrail). */
  launched: boolean;
  /** ALWAYS true — every run path is mediated by the seatbelt profile. */
  sandboxed: true;
  /** The authorized dir Codex was confined to (realpath). */
  jail: string;
  /** The seatbelt profile path used. */
  profile: string;
  /** The FULL argv that was (or would have been) spawned: sandbox-exec … codex …. */
  argv: string[];
  /** Captured stdout (empty in record-mode). */
  output: string;
  /** Process exit code (null if killed / record-mode). */
  exitCode: number | null;
  /** Confinement metadata for audit. */
  confinement: {
    /** "sandbox-exec" — the kernel mechanism. */
    mechanism: "sandbox-exec";
    /** The injected -D params (jail / homedir / codex-bin). */
    jail: string;
    homedir: string;
    codexBinDir?: string;
  };
  /**
   * True iff the run could not proceed because the local `codex` CLI is ABSENT.
   * The bridge maps this to the `source_unavailable` ErrorCode (advisory, not a crash).
   */
  binaryMissing?: boolean;
  /** Populated when the run could not proceed (codex absent, bad cwd, etc.). */
  reason?: string;
}

/** Options for one sandboxed headless launch. */
export interface SandboxedRunOptions {
  /** The task prompt handed to `codex exec`. */
  prompt: string;
  /**
   * The cwd Codex runs in — realpath-confined to the authorized dir. Defaults to the
   * authorized dir itself. A traversal / absolute escape / symlink-out is rejected
   * with `VaultConfinementError`.
   */
  cwd?: string;
  /** Hard timeout (ms). Default 10 minutes. */
  timeoutMs?: number;
}

/** Injected deps (all defaulted; tests substitute). */
export interface SandboxedLauncherDeps {
  /** The authorized dir Codex is confined to. Default `~/PlexusDemo/pomodoro`. */
  authorizedDir?: string;
  /** Resolve `codex` to an absolute path (the platform seam). */
  resolveBinary: ResolveBinary;
  /** The seatbelt profile path. Default: the bundled `sandbox/codex-confine.sb`. */
  profilePath?: string;
  /**
   * The RAW spawn-and-capture (the thing the sandbox wrapper ultimately calls).
   * Default: `defaultCapture` (node:child_process.spawn). Tests inject a fake to
   * assert the wrapped argv WITHOUT spawning, or a real spawn of a fake `codex`
   * shim under a real `sandbox-exec` (the hermetic negative test).
   */
  rawCapture?: CaptureSpawn;
  /** Resolve the `sandbox-exec` binary path (default the fixed system path). */
  sandboxExec?: string;
}

/**
 * Build the FULL sandboxed argv (the thing actually exec'd):
 *
 *   sandbox-exec -f <profile> -D JAIL=.. -D HOMEDIR=.. -D CODEX_BIN_DIR=.. \
 *     <codexBin> exec --dangerously-bypass-approvals-and-sandbox <prompt>
 *
 * PURE + deterministic — the core the record-mode test asserts.
 */
export function buildSandboxedArgv(spec: {
  sandboxExec: string;
  profilePath: string;
  jail: string;
  homedir: string;
  codexBinDir: string;
  codexBin: string;
  codexArgs: string[];
}): { command: string; args: string[] } {
  const args = [
    "-f",
    spec.profilePath,
    "-D",
    `JAIL=${spec.jail}`,
    "-D",
    `HOMEDIR=${spec.homedir}`,
    "-D",
    `CODEX_BIN_DIR=${spec.codexBinDir}`,
    spec.codexBin,
    ...spec.codexArgs,
  ];
  return { command: spec.sandboxExec, args };
}

/** The inner Codex args (the non-interactive headless invocation). */
export function buildCodexArgs(prompt: string): string[] {
  return [CODEX_EXEC_SUBCOMMAND, ...BYPASS_FLAGS, prompt];
}

/**
 * Resolve the dir holding the `codex` binary, following a symlink when the resolved
 * `codex` is one. On any error, fall back to the dir of the resolved path.
 */
function resolveCodexBinDir(codexPath: string): string {
  try {
    return dirname(realpathSync(codexPath));
  } catch {
    return dirname(codexPath);
  }
}

/**
 * The sandboxed headless Codex launcher. Confines the authorized dir + cwd, wraps the
 * `codex exec` spawn in `sandbox-exec`, and gates the real spawn behind
 * `PLEXUS_CODEX_HEADLESS_LAUNCH=1`.
 */
export class SandboxedCodexLauncher {
  private readonly authorizedDir: string;
  private readonly resolveBinary: ResolveBinary;
  private readonly profilePath: string;
  private readonly rawCapture: CaptureSpawn;
  private readonly sandboxExec: string;

  constructor(deps: SandboxedLauncherDeps) {
    this.authorizedDir = deps.authorizedDir ?? defaultAuthorizedDir();
    this.resolveBinary = deps.resolveBinary;
    this.profilePath = deps.profilePath ?? resolveConfineProfile();
    this.rawCapture = deps.rawCapture ?? defaultCapture;
    this.sandboxExec = deps.sandboxExec ?? SANDBOX_EXEC;
  }

  /** The authorized (jail) dir this launcher confines Codex to. */
  get jail(): string {
    return this.authorizedDir;
  }

  /**
   * Validate + realpath-confine a requested cwd to the authorized dir. A cwd EQUAL to
   * the authorized dir is the common case (default). A SUB-path is allowed; an
   * absolute path outside, a `..` traversal, or a symlink whose real target escapes is
   * rejected with `VaultConfinementError`.
   */
  confineCwd(requestedCwd?: string): string {
    const rootReal = realpathSync(this.authorizedDir);
    if (requestedCwd === undefined || requestedCwd.trim() === "") return rootReal;

    let rel: string;
    if (isAbsolute(requestedCwd)) {
      const target = resolve(requestedCwd);
      const targetReal = existsSync(target) ? realpathSync(target) : target;
      if (targetReal === rootReal) return rootReal;
      if (!targetReal.startsWith(rootReal + "/")) {
        throw new VaultConfinementError(`cwd escapes the authorized dir: ${requestedCwd}`);
      }
      rel = targetReal.slice(rootReal.length + 1);
    } else {
      // Reject any segment-wise `..` outright (fail-closed) BEFORE the symlink-safe check.
      if (requestedCwd.split(/[\\/]+/).includes("..")) {
        throw new VaultConfinementError(`cwd escapes the authorized dir: ${requestedCwd}`);
      }
      const lex = lexicalConfine(requestedCwd);
      if (lex === undefined) {
        throw new VaultConfinementError(`cwd escapes the authorized dir: ${requestedCwd}`);
      }
      rel = lex;
    }
    return confineToVault(this.authorizedDir, rel);
  }

  /** Run one sandboxed headless launch (record-mode unless the gate is ON). */
  async run(opts: SandboxedRunOptions): Promise<SandboxedRunResult> {
    const prompt = (opts.prompt ?? "").trim();

    // 1. Confine the cwd to the authorized dir (throws VaultConfinementError on escape).
    const jail = this.confineCwd(opts.cwd);

    // 2. Resolve `codex` (so we can compute CODEX_BIN_DIR + a precise argv).
    const codex = await this.resolveBinary(CODEX_BINARY);
    const codexBinDir = codex ? resolveCodexBinDir(codex) : "";

    const confinement: SandboxedRunResult["confinement"] = {
      mechanism: "sandbox-exec",
      jail,
      homedir: homedir(),
      ...(codexBinDir ? { codexBinDir } : {}),
    };

    const codexArgs = buildCodexArgs(prompt);
    const predicted = buildSandboxedArgv({
      sandboxExec: this.sandboxExec,
      profilePath: this.profilePath,
      jail,
      homedir: homedir(),
      codexBinDir,
      codexBin: codex ?? CODEX_BINARY,
      codexArgs,
    });
    const predictedFullArgv = [predicted.command, ...predicted.args];

    // 3. SAFETY GATE: record-mode (no spawn) unless explicitly enabled.
    if (!headlessLaunchEnabled()) {
      return {
        ok: true,
        launched: false,
        sandboxed: true,
        jail,
        profile: this.profilePath,
        argv: predictedFullArgv,
        output: "",
        exitCode: null,
        confinement,
        reason:
          "headless launch disabled (set PLEXUS_CODEX_HEADLESS_LAUNCH=1 to spawn a real sandboxed codex session)",
      };
    }

    // 4. The local Codex CLI must be present to launch. ABSENT ⇒ advisory unavailable.
    if (!codex) {
      return {
        ok: false,
        launched: false,
        sandboxed: true,
        jail,
        profile: this.profilePath,
        argv: predictedFullArgv,
        output: "",
        exitCode: null,
        confinement,
        binaryMissing: true,
        reason: "Codex CLI (`codex`) not found on PATH — cannot launch a sandboxed session.",
      };
    }

    // 5. Real launch: wrap the `codex exec` spawn in sandbox-exec, cwd = jail, TMPDIR
    //    inside the jail. The raw spawn is injectable (tests substitute a fake codex).
    const tmpdir = join(jail, ".tmp");
    try {
      if (!existsSync(tmpdir)) mkdirSync(tmpdir, { recursive: true });
    } catch {
      /* best-effort — codex will fail loudly if its temp is unwritable */
    }

    let res: CaptureResult;
    try {
      res = await this.rawCapture({
        command: predicted.command,
        args: predicted.args,
        cwd: jail,
        env: { TMPDIR: tmpdir },
        timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000,
      });
    } catch (err) {
      return {
        ok: false,
        launched: false,
        sandboxed: true,
        jail,
        profile: this.profilePath,
        argv: predictedFullArgv,
        output: "",
        exitCode: null,
        confinement,
        reason: `sandboxed launch failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const ok = res.exitCode === 0;
    return {
      ok,
      launched: true,
      sandboxed: true,
      jail,
      profile: this.profilePath,
      argv: predictedFullArgv,
      output: res.stdout,
      exitCode: res.exitCode,
      confinement,
      ...(ok ? {} : { reason: res.stderr.trim() || `codex exited ${res.exitCode}` }),
    };
  }
}
