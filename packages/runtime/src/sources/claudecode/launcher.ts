/**
 * Sandboxed headless Claude Code launcher (the `claudecode.run` capability core).
 *
 * This is the VALUE LINCHPIN of the pomodoro demo (GOAL §4 / AC5 / AC6): it runs
 * headless Claude Code CONFINED by macOS `sandbox-exec` to a single authorized
 * directory (the JAIL). CC does real work inside the jail; every read/write OUTSIDE
 * the jail fails at the kernel level. The calling agent NEVER sees a shell or the
 * launch command — only the capability.
 *
 * MECHANISM (proven by `examples/pomodoro-demo/spikes/SANDBOX-FINDINGS.md`): we do
 * NOT modify cc-master's launcher. We REUSE `ClaudeLauncher` from
 * `sources/cc-master/launch.ts` by INJECTING a custom `CaptureSpawn` — the
 * "sandbox wrapper" — that rewrites the spawn of
 *
 *     claude -p "<task>" --dangerously-skip-permissions --permission-mode bypassPermissions
 *
 * into
 *
 *     TMPDIR="$JAIL/.tmp" sandbox-exec -f <cc-confine.sb> \
 *       -D JAIL=$JAIL -D HOMEDIR=$HOME -D CLAUDE_BIN_DIR=<...> -D PLUGIN_DIR=<...> \
 *       claude -p "<task>" --dangerously-skip-permissions --permission-mode bypassPermissions
 *
 * with cwd = $JAIL. Because the kernel seatbelt is the real jail, bypassing CC's own
 * per-action gate (`--dangerously-skip-permissions`) is SAFE — Plexus (not CC)
 * decides which dir CC may touch.
 *
 * CONFINEMENT (defense-in-depth, the path layer): the authorized dir and the spawn
 * cwd are validated with `realpathSync` + `confineToVault` / `lexicalConfine` reused
 * from `sources/obsidian/vault-reader.ts`, so a traversal / absolute / symlink-escape
 * sub-path is rejected with `VaultConfinementError` BEFORE any spawn — the seatbelt
 * is the kernel jail, this is the lexical guard on top.
 *
 * TESTABILITY: the real spawn is gated behind `PLEXUS_CC_HEADLESS_LAUNCH=1` (default
 * OFF = record-mode, no spawn — the test guardrail, exactly like
 * `sources/cc-master/bridge.ts`). When OFF, `run()` returns the exact argv +
 * sandbox-exec wrapper it WOULD have spawned (the wiring proof). The underlying raw
 * spawn is itself injectable, so tests can drive a fake `claude` shim under a real
 * `sandbox-exec` (a hermetic negative test).
 */

import { realpathSync } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ClaudeLauncher,
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

/** CC's autonomous-headless flags (proven for this `claude` version — see findings §1). */
export const BYPASS_FLAGS = [
  "--dangerously-skip-permissions",
  "--permission-mode",
  "bypassPermissions",
] as const;

/** Default authorized directory (the one jail the demo confines CC to). */
export function defaultAuthorizedDir(): string {
  return join(homedir(), "PlexusDemo", "pomodoro");
}

/**
 * Resolve the absolute path to the bundled `cc-confine.sb` profile (next to this
 * module, under `sandbox/`). An env override (`PLEXUS_CC_CONFINE_PROFILE`) lets a
 * packaged build point at an extracted resource; dev resolves relative to here.
 */
export function resolveConfineProfile(): string {
  const env = process.env.PLEXUS_CC_CONFINE_PROFILE;
  if (env && env.length > 0) return env;
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), "sandbox", "cc-confine.sb");
}

/** SAFETY GATE: only really spawn when explicitly enabled (mirrors cc-master). */
export function headlessLaunchEnabled(): boolean {
  return process.env.PLEXUS_CC_HEADLESS_LAUNCH === "1";
}

/** The audit/diagnostic shape returned by a (record-mode or real) sandboxed run. */
export interface SandboxedRunResult {
  /** True iff CC resolved, spawned under the sandbox, and exited 0. */
  ok: boolean;
  /** True iff a real spawn happened (false in record-mode — the guardrail). */
  launched: boolean;
  /** ALWAYS true — every run path is mediated by the seatbelt profile (AC5/AC8). */
  sandboxed: true;
  /** The authorized dir CC was confined to (realpath). */
  jail: string;
  /** The seatbelt profile path used. */
  profile: string;
  /** The FULL argv that was (or would have been) spawned: sandbox-exec … claude …. */
  argv: string[];
  /** Captured stdout (empty in record-mode). */
  output: string;
  /** Process exit code (null if killed / record-mode). */
  exitCode: number | null;
  /** Whether the embedded cc-master plugin was injected via --plugin-dir. */
  ccMasterLoaded: boolean;
  /** Confinement metadata for audit (AC5/AC8). */
  confinement: {
    /** "sandbox-exec" — the kernel mechanism. */
    mechanism: "sandbox-exec";
    /** The injected -D params (jail / homedir / claude-bin / plugin). */
    jail: string;
    homedir: string;
    claudeBinDir?: string;
    pluginDir?: string;
  };
  /** Populated when the run could not proceed (claude absent, bad cwd, etc.). */
  reason?: string;
}

/** Options for one sandboxed headless launch. */
export interface SandboxedRunOptions {
  /** The task prompt handed to `claude -p`. */
  prompt: string;
  /**
   * The cwd CC runs in — REQUIRED + realpath-confined to the authorized dir.
   * Defaults to the authorized dir itself. Any sub-path is validated; a traversal /
   * absolute escape / symlink-out is rejected with `VaultConfinementError`.
   */
  cwd?: string;
  /** When true, inject the embedded cc-master plugin via --plugin-dir. Default false. */
  loadCcMaster?: boolean;
  /** Hard timeout (ms). Default 10 minutes (CC hangs without network — see findings §5). */
  timeoutMs?: number;
}

/** Injected deps (all defaulted; tests substitute). */
export interface SandboxedLauncherDeps {
  /** The authorized dir CC is confined to. Default `~/PlexusDemo/pomodoro`. */
  authorizedDir?: string;
  /** Resolve `claude` to an absolute path (the platform seam). */
  resolveBinary: ResolveBinary;
  /** The seatbelt profile path. Default: the bundled `sandbox/cc-confine.sb`. */
  profilePath?: string;
  /** The embedded cc-master plugin dir (only used when loadCcMaster:true). */
  embeddedPluginDir?: string;
  /**
   * The RAW spawn-and-capture (the thing the sandbox wrapper ultimately calls).
   * Default: `defaultCapture` (node:child_process.spawn). Tests inject a fake to
   * assert the wrapped argv WITHOUT spawning, or a real spawn of a fake `claude`
   * shim under a real `sandbox-exec` (the hermetic negative test).
   */
  rawCapture?: CaptureSpawn;
  /** Resolve the `sandbox-exec` binary path (default the fixed system path). */
  sandboxExec?: string;
}

/**
 * Build the FULL sandboxed argv (the thing actually exec'd):
 *
 *   sandbox-exec -f <profile> -D JAIL=.. -D HOMEDIR=.. -D CLAUDE_BIN_DIR=.. \
 *     [-D PLUGIN_DIR=..] <claudeBin> <ccArgs...>
 *
 * PURE + deterministic — the core the record-mode test asserts. `command` is
 * `sandbox-exec`; `args[0..]` carry the profile + -D params, then the real `claude`
 * absolute path, then CC's own args.
 */
export function buildSandboxedArgv(spec: {
  sandboxExec: string;
  profilePath: string;
  jail: string;
  homedir: string;
  claudeBinDir: string;
  pluginDir: string;
  claudeBin: string;
  ccArgs: string[];
}): { command: string; args: string[] } {
  const args = [
    "-f",
    spec.profilePath,
    "-D",
    `JAIL=${spec.jail}`,
    "-D",
    `HOMEDIR=${spec.homedir}`,
    "-D",
    `CLAUDE_BIN_DIR=${spec.claudeBinDir}`,
    "-D",
    `PLUGIN_DIR=${spec.pluginDir}`,
    spec.claudeBin,
    ...spec.ccArgs,
  ];
  return { command: spec.sandboxExec, args };
}

/**
 * Resolve the dir holding the `claude` version binaries, following a symlink when
 * the resolved `claude` is one (matches the spike:
 * `dirname(readlink(command -v claude))`). On any error, fall back to the dir of the
 * resolved path — still a valid read-only grant subpath.
 */
function resolveClaudeBinDir(claudePath: string): string {
  try {
    return dirname(realpathSync(claudePath));
  } catch {
    return dirname(claudePath);
  }
}

/**
 * The sandboxed headless Claude Code launcher. Wraps cc-master's `ClaudeLauncher` by
 * injecting a sandbox-wrapping `CaptureSpawn`; confines the authorized dir + cwd;
 * gates the real spawn behind `PLEXUS_CC_HEADLESS_LAUNCH=1`.
 */
export class SandboxedClaudeLauncher {
  private readonly authorizedDir: string;
  private readonly resolveBinary: ResolveBinary;
  private readonly profilePath: string;
  private readonly embeddedPluginDir?: string;
  private readonly rawCapture: CaptureSpawn;
  private readonly sandboxExec: string;

  constructor(deps: SandboxedLauncherDeps) {
    this.authorizedDir = deps.authorizedDir ?? defaultAuthorizedDir();
    this.resolveBinary = deps.resolveBinary;
    this.profilePath = deps.profilePath ?? resolveConfineProfile();
    if (deps.embeddedPluginDir !== undefined) this.embeddedPluginDir = deps.embeddedPluginDir;
    this.rawCapture = deps.rawCapture ?? defaultCapture;
    this.sandboxExec = deps.sandboxExec ?? SANDBOX_EXEC;
  }

  /** The authorized (jail) dir this launcher confines CC to. */
  get jail(): string {
    return this.authorizedDir;
  }

  /**
   * Validate + realpath-confine a requested cwd to the authorized dir. A cwd EQUAL
   * to the authorized dir is the common case (default). A SUB-path is allowed; an
   * absolute path outside, a `..` traversal, or a symlink whose real target escapes
   * is rejected with `VaultConfinementError`. The authorized root must already exist
   * (realpath needs it); callers create `~/PlexusDemo/pomodoro` at setup.
   */
  confineCwd(requestedCwd?: string): string {
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

  /**
   * Build the sandbox-wrapping `CaptureSpawn`: it takes the inner `claude` spawn that
   * `ClaudeLauncher` produced and re-emits it as a `sandbox-exec -f <profile> -D ...
   * claude ...` spawn, with TMPDIR pointed INSIDE the jail and cwd = jail.
   */
  private sandboxWrapper(args: {
    jail: string;
    claudeBinDir: string;
    pluginDir: string;
    onArgv: (full: string[]) => void;
  }): CaptureSpawn {
    return (spec): Promise<CaptureResult> => {
      // spec.command = absolute `claude`; spec.args = the inner launcher's CC args
      // (`[--plugin-dir? -p <prompt>]`). We APPEND the bypass flags here so the
      // autonomous-headless run never blocks on CC's own per-action gate (safe — the
      // seatbelt is the real jail). This makes the spawned argv match the predicted one.
      const claudeBin = spec.command;
      const ccArgs = [...spec.args, ...BYPASS_FLAGS];
      const { command, args: wrappedArgs } = buildSandboxedArgv({
        sandboxExec: this.sandboxExec,
        profilePath: this.profilePath,
        jail: args.jail,
        homedir: homedir(),
        claudeBinDir: args.claudeBinDir,
        pluginDir: args.pluginDir,
        claudeBin,
        ccArgs,
      });
      args.onArgv([command, ...wrappedArgs]);

      const tmpdir = join(args.jail, ".tmp");
      try {
        if (!existsSync(tmpdir)) mkdirSync(tmpdir, { recursive: true });
      } catch {
        /* best-effort — CC will fail loudly if its temp is unwritable */
      }
      return this.rawCapture({
        command,
        args: wrappedArgs,
        // cwd = jail (the spike requirement); TMPDIR inside the jail (the §3 bug fix).
        cwd: args.jail,
        env: { TMPDIR: tmpdir },
        ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
      });
    };
  }

  /** Run one sandboxed headless launch (record-mode unless the gate is ON). */
  async run(opts: SandboxedRunOptions): Promise<SandboxedRunResult> {
    const prompt = (opts.prompt ?? "").trim();
    const loadCcMaster = opts.loadCcMaster === true;

    // 1. Confine the cwd to the authorized dir (throws VaultConfinementError on escape).
    const jail = this.confineCwd(opts.cwd);

    // 2. Resolve `claude` (so we can compute CLAUDE_BIN_DIR + a precise argv).
    const claude = await this.resolveBinary("claude");
    const claudeBinDir = claude ? resolveClaudeBinDir(claude) : "";
    const pluginDir = loadCcMaster && this.embeddedPluginDir ? this.embeddedPluginDir : jail;

    const confinement: SandboxedRunResult["confinement"] = {
      mechanism: "sandbox-exec",
      jail,
      homedir: homedir(),
      ...(claudeBinDir ? { claudeBinDir } : {}),
      ...(loadCcMaster && this.embeddedPluginDir ? { pluginDir: this.embeddedPluginDir } : {}),
    };

    // The CC-level args the inner launcher will build (for argv reporting). We append
    // the bypass flags so the headless run is autonomous (safe — the seatbelt is the jail).
    const innerCcArgs = [
      ...(loadCcMaster && this.embeddedPluginDir ? ["--plugin-dir", this.embeddedPluginDir] : []),
      "-p",
      prompt,
      ...BYPASS_FLAGS,
    ];
    const predictedArgv = buildSandboxedArgv({
      sandboxExec: this.sandboxExec,
      profilePath: this.profilePath,
      jail,
      homedir: homedir(),
      claudeBinDir,
      pluginDir,
      claudeBin: claude ?? "claude",
      ccArgs: innerCcArgs,
    });
    const predictedFullArgv = [predictedArgv.command, ...predictedArgv.args];

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
        ccMasterLoaded: loadCcMaster && !!this.embeddedPluginDir,
        confinement,
        reason:
          "headless launch disabled (set PLEXUS_CC_HEADLESS_LAUNCH=1 to spawn a real sandboxed cc session)",
      };
    }

    if (!claude) {
      return {
        ok: false,
        launched: false,
        sandboxed: true,
        jail,
        profile: this.profilePath,
        argv: predictedFullArgv,
        output: "",
        exitCode: null,
        ccMasterLoaded: false,
        confinement,
        reason: "Claude Code (`claude`) not found on PATH — cannot launch a sandboxed session.",
      };
    }

    // 4. Real launch: reuse cc-master's ClaudeLauncher, injecting our sandbox wrapper.
    let spawnedArgv: string[] = predictedFullArgv;
    const launcher = new ClaudeLauncher({
      resolveBinary: this.resolveBinary,
      ...(this.embeddedPluginDir ? { embeddedPluginDir: this.embeddedPluginDir } : {}),
      // The inner launcher must not re-validate flags; we extend its argv via the
      // wrapper. It appends the bypass flags through a thin argv post-step below.
      capture: this.sandboxWrapper({
        jail,
        claudeBinDir,
        pluginDir,
        onArgv: (full) => {
          spawnedArgv = full;
        },
      }),
      // Skip embedded structural validation when not loading the plugin.
      ...(loadCcMaster ? {} : { validate: () => ({ ok: true }) }),
    });

    // The inner ClaudeLauncher builds `[--plugin-dir? -p <prompt>]` and hands it to
    // our injected sandbox wrapper, which appends the bypass flags + re-emits the spawn
    // as `sandbox-exec … claude …` with cwd=jail + TMPDIR inside the jail.
    const res = await launcher.launch({
      loadCcMaster,
      prompt,
      cwd: jail,
      timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000,
    });

    return {
      ok: res.ok,
      launched: true,
      sandboxed: true,
      jail,
      profile: this.profilePath,
      argv: spawnedArgv,
      output: res.output,
      exitCode: res.exitCode,
      ccMasterLoaded: res.ccMasterLoaded,
      confinement,
      ...(res.reason ? { reason: res.reason } : {}),
    };
  }
}
