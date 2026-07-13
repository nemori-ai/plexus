/**
 * Headless Claude Code launcher (the `claudecode.run` capability core).
 *
 * It runs headless Claude Code NATIVELY — Plexus does NOT wrap it in its own
 * `sandbox-exec` seatbelt. Claude Code sandboxes ITSELF: `--dangerously-skip-permissions`
 * bypasses CC's per-action approval GATE while KEEPING CC's own OS sandbox, which
 * WRITE-confines the run to its cwd (the authorized directory). Plexus's old seatbelt
 * wrap conflicted with that native sandbox (double-jail ⇒ EPERM on CC's own scratch), so
 * it is dropped. The calling agent NEVER sees a shell or the launch command — only the
 * capability.
 *
 * LAUNCH (VERIFIED): with cwd = the authorized dir, NO wrapper,
 *
 *     claude -p "<task>" --dangerously-skip-permissions --permission-mode bypassPermissions
 *
 * CC's native sandbox blocks WRITES outside the cwd. Reads are NOT confined — CC can still
 * scan other files on the machine. That is an OWNER concern surfaced in the console; it is
 * NEVER revealed to the agent (describe/instruction/output).
 *
 * CONFINEMENT (defense-in-depth, the path layer): the authorized dir and the spawn cwd are
 * validated with `realpathSync` + `confineToVault` / `lexicalConfine` reused from
 * `sources/obsidian/vault-reader.ts`, so a traversal / absolute / symlink-escape sub-path
 * is rejected with `VaultConfinementError` BEFORE any spawn — the lexical guard on the cwd.
 *
 * TESTABILITY: the real spawn is gated behind `PLEXUS_CC_HEADLESS_LAUNCH=1` (default OFF =
 * record-mode, no spawn). When OFF, `run()` returns the exact native argv it WOULD have
 * spawned. The raw spawn is injectable, so tests drive a fake `claude` shim without a real CC.
 */

import { randomUUID } from "node:crypto";
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
} from "./launch.ts";
import {
  confineToVault,
  lexicalConfine,
  VaultConfinementError,
} from "../obsidian/vault-reader.ts";

/** CC's autonomous-headless flags (proven for this `claude` version — see findings §1). */
export const BYPASS_FLAGS = [
  "--dangerously-skip-permissions",
  "--permission-mode",
  "bypassPermissions",
] as const;

/**
 * The confinement mechanism recorded in audit — honest about what jails the run. CC
 * sandboxes itself natively (macOS seatbelt internally); Plexus does not wrap it.
 */
export type ClaudeConfinementMechanism = "claude-native";
export const CLAUDE_NATIVE_MECHANISM = "claude-native" as const;

/** Default authorized directory (the one dir this source confines CC's writes to). */
export function defaultAuthorizedDir(): string {
  return join(homedir(), ".plexus", "workspace", "claudecode");
}

/**
 * SAFETY GATE: only really spawn when explicitly enabled.
 * The persisted console setting (Sources → Claude Code → "Real launch") wins when
 * set; the env flag stays as the recipe/test fallback. Consulted PER CALL — live toggle.
 */
export function headlessLaunchEnabled(): boolean {
  return realLaunchEnabled("claudecode", "PLEXUS_CC_HEADLESS_LAUNCH");
}

/** The audit/diagnostic shape returned by a (record-mode or real) native run. */
export interface SandboxedRunResult {
  /** True iff CC resolved, ran natively, and exited 0. */
  ok: boolean;
  /** True iff a real spawn happened (false in record-mode — the guardrail). */
  launched: boolean;
  /** ALWAYS true — CC runs under its OWN native sandbox (write-confined to cwd). */
  sandboxed: true;
  /** The authorized dir CC's writes are confined to (realpath). */
  jail: string;
  /** The FULL argv that was (or would have been) spawned: <claude> -p <prompt> …bypass. */
  argv: string[];
  /** Captured stdout (empty in record-mode). */
  output: string;
  /** Process exit code (null if killed / record-mode). */
  exitCode: number | null;
  /** Confinement metadata for audit. */
  confinement: {
    /** The mechanism actually confining the run (CC's own native sandbox). */
    mechanism: ClaudeConfinementMechanism;
    /** The authorized dir writes are confined to. */
    jail: string;
    homedir: string;
  };
  /** Populated when the run could not proceed (claude absent, bad cwd, etc.). */
  reason?: string;
  /**
   * The CC session id (`--session-id <uuid>`, minted per REAL launch) — the OWNER's
   * proof handle: `claude --resume <uuid>` from the jail replays the full session in a
   * terminal. Absent in record-mode (no session exists). Audit-only; never on the wire.
   */
  sessionId?: string;
}

/** Options for one headless launch. */
export interface SandboxedRunOptions {
  /** The task prompt handed to `claude -p`. */
  prompt: string;
  /**
   * The cwd CC runs in — REQUIRED + realpath-confined to the authorized dir.
   * Defaults to the authorized dir itself. Any sub-path is validated; a traversal /
   * absolute escape / symlink-out is rejected with `VaultConfinementError`.
   */
  cwd?: string;
  /** Hard timeout (ms). Default 10 minutes (CC hangs without network). */
  timeoutMs?: number;
}

/** Injected deps (all defaulted; tests substitute). */
export interface SandboxedLauncherDeps {
  /** The authorized dir CC's writes are confined to. Default `~/.plexus/workspace/claudecode`. */
  authorizedDir?: string;
  /** Resolve `claude` to an absolute path (the platform seam). */
  resolveBinary: ResolveBinary;
  /**
   * The RAW spawn-and-capture (the thing `run()` ultimately calls). Default:
   * `defaultCapture` (node:child_process.spawn). Tests inject a fake to assert the argv
   * WITHOUT spawning, or a real spawn of a fake `claude` shim.
   */
  rawCapture?: CaptureSpawn;
}

/**
 * Build the FULL native argv (the thing actually exec'd):
 *
 *   <claudeBin> -p <prompt> --dangerously-skip-permissions --permission-mode bypassPermissions
 *
 * PURE + deterministic — the core the record-mode test asserts. NO wrapper.
 */
export function buildNativeArgv(spec: {
  claudeBin: string;
  prompt: string;
  /** Pin the CC session id (real launches) so the owner can `claude --resume` it later. */
  sessionId?: string;
}): { command: string; args: string[] } {
  return {
    command: spec.claudeBin,
    args: [
      "-p",
      spec.prompt,
      ...BYPASS_FLAGS,
      ...(spec.sessionId ? ["--session-id", spec.sessionId] : []),
    ],
  };
}

/**
 * The headless Claude Code launcher. Runs the real `claude` NATIVELY (CC's own sandbox
 * write-confines it to the cwd); confines the authorized dir + cwd lexically; gates the
 * real spawn behind `PLEXUS_CC_HEADLESS_LAUNCH=1`.
 */
export class SandboxedClaudeLauncher {
  private readonly authorizedDir: string;
  private readonly resolveBinary: ResolveBinary;
  private readonly rawCapture: CaptureSpawn;

  constructor(deps: SandboxedLauncherDeps) {
    this.authorizedDir = deps.authorizedDir ?? defaultAuthorizedDir();
    this.resolveBinary = deps.resolveBinary;
    this.rawCapture = deps.rawCapture ?? defaultCapture;
  }

  /** The authorized dir this launcher confines CC's writes to. */
  get jail(): string {
    return this.authorizedDir;
  }

  /** The confinement mechanism in use (CC's own native sandbox). */
  get mechanism(): ClaudeConfinementMechanism {
    return CLAUDE_NATIVE_MECHANISM;
  }

  /**
   * Validate + realpath-confine a requested cwd to the authorized dir. A cwd EQUAL
   * to the authorized dir is the common case (default). A SUB-path is allowed; an
   * absolute path outside, a `..` traversal, or a symlink whose real target escapes
   * is rejected with `VaultConfinementError`. The authorized root must already exist
   * (realpath needs it); callers create `~/.plexus/workspace/claudecode` at setup.
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

    // An absolute request must be the root itself or a descendant of it — express it
    // as a root-relative path, then reuse confineToVault for the symlink-safe check.
    let rel: string;
    if (isAbsolute(requestedCwd)) {
      const target = resolve(requestedCwd);
      const targetReal = existsSync(target) ? realpathSync(target) : target;
      if (targetReal === rootReal) return rootReal;
      if (!targetReal.startsWith(rootReal + "/")) {
        throw new VaultConfinementError(
          `cwd escapes the authorized dir: ${requestedCwd}`,
        );
      }
      rel = targetReal.slice(rootReal.length + 1);
    } else {
      // A relative request. lexicalConfine CLAMPS a leading `..` at the virtual root
      // (so "../x" lexically normalizes to "x") — too lenient for a cwd that must NOT
      // escape. So reject any segment-wise `..` outright (fail-closed) BEFORE handing
      // the path to confineToVault for the symlink-safe realpath containment check.
      if (requestedCwd.split(/[\\/]+/).includes("..")) {
        throw new VaultConfinementError(`cwd escapes the authorized dir: ${requestedCwd}`);
      }
      const lex = lexicalConfine(requestedCwd);
      if (lex === undefined) {
        throw new VaultConfinementError(`cwd escapes the authorized dir: ${requestedCwd}`);
      }
      rel = lex;
    }
    // confineToVault re-checks lexical + realpath containment under the root.
    return confineToVault(this.authorizedDir, rel);
  }

  /** Run one native headless launch (record-mode unless the gate is ON). */
  async run(opts: SandboxedRunOptions): Promise<SandboxedRunResult> {
    const prompt = (opts.prompt ?? "").trim();

    // 1. Confine the cwd to the authorized dir (throws VaultConfinementError on escape).
    const jail = this.confineCwd(opts.cwd);

    // 2. Resolve `claude` (so we can compute a precise argv).
    const claude = await this.resolveBinary("claude");

    const confinement: SandboxedRunResult["confinement"] = {
      mechanism: CLAUDE_NATIVE_MECHANISM,
      jail,
      homedir: homedir(),
    };

    // The native argv — the agent binary directly, no wrapper. The bypass flags make the
    // headless run autonomous while KEEPING CC's own sandbox (write-confined to cwd).
    const { command, args } = buildNativeArgv({ claudeBin: claude ?? "claude", prompt });
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
        reason:
          "record mode: the owner has not enabled real launch for this source (Plexus console → What I expose → Claude Code → Real launch), so the native command was assembled and audited but not spawned",
      };
    }

    if (!claude) {
      return {
        ok: false,
        launched: false,
        sandboxed: true,
        jail,
        argv: predictedFullArgv,
        output: "",
        exitCode: null,
        confinement,
        reason: "Claude Code (`claude`) not found on PATH — cannot launch a session.",
      };
    }

    // 4. BEHAVIOR CONTRACT at the AUTHORIZED-DIR ROOT (not the per-call cwd `jail`, which
    //    may be an agent-named subdir): CC reads CLAUDE.md up the tree from its cwd. Output
    //    returns to a possibly-remote caller — relative paths only, no machine fingerprint.
    //    Owner file wins; a prior gateway file is refreshed. See jail-contract.
    materializeJailContract(this.authorizedDir, "CLAUDE.md");

    // 5. Real launch: spawn the real `claude` NATIVELY with cwd = jail. CC's own sandbox
    //    write-confines it. The raw spawn is injectable (tests substitute a fake claude).
    //    The session id is PINNED (`--session-id <uuid>`) so the owner can later replay
    //    the run in a terminal (`claude --resume <uuid>` from the jail) — the demo-grade
    //    proof that a remote call really drove local CC.
    const sessionId = randomUUID();
    const real = buildNativeArgv({ claudeBin: claude, prompt, sessionId });
    const realFullArgv = [real.command, ...real.args];
    let res: CaptureResult;
    try {
      res = await this.rawCapture({
        command: real.command,
        args: real.args,
        cwd: jail,
        timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000,
      });
    } catch (err) {
      return {
        ok: false,
        launched: false,
        sandboxed: true,
        jail,
        argv: realFullArgv,
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
      argv: realFullArgv,
      output: res.stdout,
      exitCode: res.exitCode,
      confinement,
      sessionId,
      ...(ok ? {} : { reason: res.stderr.trim() || `claude exited ${res.exitCode}` }),
    };
  }
}
