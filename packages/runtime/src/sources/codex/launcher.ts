/**
 * Headless Codex launcher (the `codex.run` capability core).
 *
 * The analog of `sources/claudecode/launcher.ts`, for the local **Codex CLI**. It runs
 * `codex exec` HEADLESS and NATIVELY — Plexus does NOT wrap it in its own `sandbox-exec`
 * seatbelt. Codex sandboxes ITSELF: `--sandbox workspace-write` keeps Codex's own
 * write-confinement (to its cwd, the authorized dir) while skipping the interactive
 * approval prompts. Plexus's old seatbelt wrap conflicted with that native sandbox
 * (double-jail ⇒ EPERM on Codex's own scratch), so it is dropped. The calling agent
 * NEVER sees a shell or the launch command — only the `codex.run` capability.
 *
 * LAUNCH (VERIFIED): with cwd = the authorized dir, NO wrapper,
 *
 *     codex exec --sandbox workspace-write --skip-git-repo-check "<task>"
 *
 * Codex's native sandbox blocks WRITES outside the cwd. Reads are NOT confined — Codex can
 * still scan other files on the machine. That is an OWNER concern surfaced in the console;
 * it is NEVER revealed to the agent (describe/instruction/output).
 *
 * CONFINEMENT (defense-in-depth, the path layer): the authorized dir and the spawn cwd are
 * validated with `realpathSync` + `confineToVault` / `lexicalConfine` (reused from
 * `sources/obsidian/vault-reader.ts`), so a traversal / absolute / symlink-escape sub-path
 * is rejected with `VaultConfinementError` BEFORE any spawn.
 *
 * TESTABILITY: the real spawn is gated behind `PLEXUS_CODEX_HEADLESS_LAUNCH=1` (default
 * OFF = record-mode, no spawn). When OFF, `run()` returns the exact native argv it WOULD
 * have spawned. The raw spawn is injectable, so tests drive a fake `codex` shim.
 */

import { realpathSync } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { realLaunchEnabled } from "../config/settings.ts";
import { materializeJailContract } from "../jail-contract.ts";

import {
  defaultCapture,
  type CaptureResult,
  type CaptureSpawn,
  type ResolveBinary,
} from "../claudecode/launch.ts";
import {
  confineToVault,
  lexicalConfine,
  VaultConfinementError,
} from "../obsidian/vault-reader.ts";

/** The binary name Plexus launches (the local Codex CLI). */
export const CODEX_BINARY = "codex" as const;

/**
 * Codex's non-interactive headless flags. `exec` is the non-interactive subcommand;
 * `--sandbox workspace-write` KEEPS Codex's own write-confinement (to cwd) while skipping
 * the interactive approval prompts; `--skip-git-repo-check` lets it run in a non-git dir.
 */
export const CODEX_EXEC_SUBCOMMAND = "exec" as const;
export const CODEX_SANDBOX_FLAGS = [
  "--sandbox",
  "workspace-write",
  "--skip-git-repo-check",
] as const;

/**
 * The confinement mechanism recorded in audit — honest about what jails the run. Codex
 * sandboxes itself natively (`--sandbox workspace-write`); Plexus does not wrap it.
 */
export type CodexConfinementMechanism = "codex-workspace-write";
export const CODEX_WORKSPACE_WRITE_MECHANISM = "codex-workspace-write" as const;

/** Default authorized directory (the one dir the source confines Codex's writes to). */
export function defaultAuthorizedDir(): string {
  return join(homedir(), ".plexus", "workspace", "codex");
}

/**
 * SAFETY GATE: only really spawn when explicitly enabled (mirrors claudecode).
 * The persisted console setting (Sources → Codex → "Real launch") wins when set;
 * the env flag stays as the recipe/test fallback. Consulted PER CALL — live toggle.
 */
export function headlessLaunchEnabled(): boolean {
  return realLaunchEnabled("codex", "PLEXUS_CODEX_HEADLESS_LAUNCH");
}

/** The audit/diagnostic shape returned by a (record-mode or real) native run. */
export interface SandboxedRunResult {
  /** True iff Codex resolved, ran natively, and exited 0. */
  ok: boolean;
  /** True iff a real spawn happened (false in record-mode — the guardrail). */
  launched: boolean;
  /** ALWAYS true — Codex runs under its OWN native sandbox (write-confined to cwd). */
  sandboxed: true;
  /** The authorized dir Codex's writes are confined to (realpath). */
  jail: string;
  /** The FULL argv that was (or would have been) spawned: <codex> exec --sandbox … <prompt>. */
  argv: string[];
  /** Captured stdout (empty in record-mode). */
  output: string;
  /** Process exit code (null if killed / record-mode). */
  exitCode: number | null;
  /** Confinement metadata for audit. */
  confinement: {
    /** The mechanism actually confining the run (Codex's own native sandbox). */
    mechanism: CodexConfinementMechanism;
    /** The authorized dir writes are confined to. */
    jail: string;
    homedir: string;
  };
  /**
   * True iff the run could not proceed because the local `codex` CLI is ABSENT.
   * The bridge maps this to the `source_unavailable` ErrorCode (advisory, not a crash).
   */
  binaryMissing?: boolean;
  /** Populated when the run could not proceed (codex absent, bad cwd, etc.). */
  reason?: string;
}

/** Options for one headless launch. */
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
  /** The authorized dir Codex's writes are confined to. Default `~/.plexus/workspace/codex`. */
  authorizedDir?: string;
  /** Resolve `codex` to an absolute path (the platform seam). */
  resolveBinary: ResolveBinary;
  /**
   * The RAW spawn-and-capture (the thing `run()` ultimately calls). Default:
   * `defaultCapture` (node:child_process.spawn). Tests inject a fake to assert the argv
   * WITHOUT spawning, or a real spawn of a fake `codex` shim.
   */
  rawCapture?: CaptureSpawn;
}

/** The inner Codex args (the non-interactive headless invocation). */
export function buildCodexArgs(prompt: string): string[] {
  return [CODEX_EXEC_SUBCOMMAND, ...CODEX_SANDBOX_FLAGS, prompt];
}

/**
 * Build the FULL native argv (the thing actually exec'd):
 *
 *   <codexBin> exec --sandbox workspace-write --skip-git-repo-check <prompt>
 *
 * PURE + deterministic — the core the record-mode test asserts. NO wrapper.
 */
export function buildNativeArgv(spec: {
  codexBin: string;
  prompt: string;
}): { command: string; args: string[] } {
  return { command: spec.codexBin, args: buildCodexArgs(spec.prompt) };
}

/**
 * The headless Codex launcher. Runs the real `codex exec` NATIVELY (Codex's own sandbox
 * write-confines it to the cwd); confines the authorized dir + cwd lexically; gates the
 * real spawn behind `PLEXUS_CODEX_HEADLESS_LAUNCH=1`.
 */
export class SandboxedCodexLauncher {
  private readonly authorizedDir: string;
  private readonly resolveBinary: ResolveBinary;
  private readonly rawCapture: CaptureSpawn;

  constructor(deps: SandboxedLauncherDeps) {
    this.authorizedDir = deps.authorizedDir ?? defaultAuthorizedDir();
    this.resolveBinary = deps.resolveBinary;
    this.rawCapture = deps.rawCapture ?? defaultCapture;
  }

  /** The authorized dir this launcher confines Codex's writes to. */
  get jail(): string {
    return this.authorizedDir;
  }

  /** The confinement mechanism in use (Codex's own native sandbox). */
  get mechanism(): CodexConfinementMechanism {
    return CODEX_WORKSPACE_WRITE_MECHANISM;
  }

  /**
   * Validate + realpath-confine a requested cwd to the authorized dir. A cwd EQUAL to
   * the authorized dir is the common case (default). A SUB-path is allowed; an
   * absolute path outside, a `..` traversal, or a symlink whose real target escapes is
   * rejected with `VaultConfinementError`.
   */
  confineCwd(requestedCwd?: string): string {
    // Self-heal a missing configured/default root: best-effort create it BEFORE realpath
    // (which needs it to exist) so a fresh install / demo path doesn't ENOENT on the first
    // line of run(). realpathSync still runs AFTER — it resolves symlinks + validates the
    // (now-present) root.
    try {
      mkdirSync(this.authorizedDir, { recursive: true });
    } catch {
      /* best-effort — realpathSync below surfaces a genuinely unusable root */
    }
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

  /** Run one native headless launch (record-mode unless the gate is ON). */
  async run(opts: SandboxedRunOptions): Promise<SandboxedRunResult> {
    const prompt = (opts.prompt ?? "").trim();

    // 1. Confine the cwd to the authorized dir (throws VaultConfinementError on escape).
    const jail = this.confineCwd(opts.cwd);

    // 2. Resolve `codex` (so we can compute a precise argv).
    const codex = await this.resolveBinary(CODEX_BINARY);

    const confinement: SandboxedRunResult["confinement"] = {
      mechanism: CODEX_WORKSPACE_WRITE_MECHANISM,
      jail,
      homedir: homedir(),
    };

    // The native argv — the agent binary directly, no wrapper. `--sandbox workspace-write`
    // keeps Codex's own write-confinement to the cwd.
    const { command, args } = buildNativeArgv({ codexBin: codex ?? CODEX_BINARY, prompt });
    const predictedFullArgv = [command, ...args];

    // 3. SAFETY GATE: record-mode (no spawn) unless explicitly enabled.
    if (!headlessLaunchEnabled()) {
      return {
        ok: true,
        launched: false,
        sandboxed: true,
        jail,
        argv: predictedFullArgv,
        output: "",
        exitCode: null,
        confinement,
        // This rides toData to the calling AGENT, so point at the owner-side control the
        // agent CAN reason about — the console — not the env var (which the agent can't set,
        // and which a persisted console setting overrides anyway, per ADR-021 precedence).
        reason:
          "record mode: the owner has not enabled real launch for this source (Plexus console → What I expose → Codex → Real launch), so the native command was assembled and audited but not spawned",
      };
    }

    // 4. The local Codex CLI must be present to launch. ABSENT ⇒ advisory unavailable.
    if (!codex) {
      return {
        ok: false,
        launched: false,
        sandboxed: true,
        jail,
        argv: predictedFullArgv,
        output: "",
        exitCode: null,
        confinement,
        binaryMissing: true,
        reason: "Codex CLI (`codex`) not found on PATH — cannot launch a session.",
      };
    }

    // 5. BEHAVIOR CONTRACT: materialize an AGENTS.md at the AUTHORIZED-DIR ROOT (not the
    //    per-call cwd `jail`, which may be an agent-named subdir — writing there would litter
    //    the owner's tree). Codex reads AGENTS.md up the tree from its cwd, so a root file
    //    still applies. It steers the tool to reference files by RELATIVE path and never
    //    volunteer absolute paths / usernames / machine layout — its output returns to a
    //    possibly-remote caller. An owner-authored file wins; a prior gateway-written one is
    //    refreshed (see jail-contract).
    materializeJailContract(this.authorizedDir, "AGENTS.md");

    // 6. Real launch: spawn the real `codex exec` NATIVELY with cwd = jail. Codex's own
    //    sandbox write-confines it. The raw spawn is injectable (tests substitute a fake codex).
    let res: CaptureResult;
    try {
      res = await this.rawCapture({
        command,
        args,
        cwd: jail,
        timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000,
      });
    } catch (err) {
      return {
        ok: false,
        launched: false,
        sandboxed: true,
        jail,
        argv: predictedFullArgv,
        output: "",
        exitCode: null,
        confinement,
        reason: `native launch failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const ok = res.exitCode === 0;
    return {
      ok,
      launched: true,
      sandboxed: true,
      jail,
      argv: predictedFullArgv,
      output: res.stdout,
      exitCode: res.exitCode,
      confinement,
      ...(ok ? {} : { reason: res.stderr.trim() || `codex exited ${res.exitCode}` }),
    };
  }
}
