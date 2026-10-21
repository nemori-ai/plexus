/**
 * The one launcher behind `claudecode.run` and `codex.run`.
 *
 * A tool is a table entry ({@link ExecToolSpec}): which binary, which seatbelt profile,
 * where its own state lives and which parts of it may change, and the args it takes
 * under each policy. Everything else is shared: cwd confinement, the record-mode gate,
 * the kernel wrap, the canary, the spawn, the report.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { assetPath } from "../core/assets.ts";
import {
  selectSandboxBackend,
  type SandboxBackend,
  type SandboxMechanism,
  type SandboxSpec,
  type ToolStateMount,
} from "../platform/sandbox-backend.ts";
import { execPolicyFor, realLaunchEnabled } from "./config/settings.ts";
import { defaultCapture, type CaptureResult, type CaptureSpawn, type ResolveBinary } from "./exec-capture.ts";
import {
  childEnv,
  HOST_ISOLATION,
  jailIsolation,
  resolveToolBinaryDirs,
  runJailCanary,
  TOOL_DIR_PARAMS,
  type CanaryOutcome,
  type ExecIsolation,
  type ExecPolicy,
  type ToolBinaryDirs,
} from "./exec-isolation.ts";
import { materializeJailContract } from "./jail-contract.ts";
import { confineToVault, lexicalConfine, VaultConfinementError } from "./obsidian/vault-reader.ts";

/** What makes one coding tool different from the other. */
export interface ExecToolSpec {
  sourceId: string;
  /** The binary name resolved on PATH. */
  binary: string;
  /** How the console names the source (the record-mode reason points the agent at it). */
  consoleName: string;
  contractFile: "AGENTS.md" | "CLAUDE.md";
  defaultAuthorizedDir: () => string;
  realLaunchEnv: string;
  execPolicyEnv: string;
  /** The seatbelt profile: its packaged asset path, its checkout location, and an env override. */
  profile: { packaged: string; checkout: URL; env: string };
  /** The tool's own state dir (`~/.claude`, `$CODEX_HOME`). */
  toolHome: () => string;
  /** The state entries and their access under the jail, in bind order (see `ToolStateMount`). */
  toolState: (ctx: JailContext) => ToolStateMount[];
  /** Create what the jail needs before launch (e.g. protected dirs so Linux can ro-bind them). Throwing refuses the launch with the message. */
  prepareJail?: (ctx: JailContext) => void;
  /** Inner args under the jail: the tool's own prompts and sandbox OFF (the kernel jail is the boundary). */
  jailArgs: (prompt: string, sessionId?: string) => string[];
  /** Args under the host policy: as the owner would run it. */
  hostArgs: (prompt: string, sessionId?: string) => string[];
  /** The tool's own documented variables (auth, endpoint, state dir) passed through on top of `BASE_CHILD_ENV`. */
  env: readonly string[];
  /** Extra env under the jail (the tool's own temp knob). */
  jailEnv: (tmpdir: string) => Record<string, string>;
  /** Pin a session id on real launches (claude) or parse it from the output (codex). */
  sessionId: { mint: true } | { parse: (stdout: string, stderr: string) => string | undefined };
}

/** What one jail run is made of, for the per-tool state grants. */
export interface JailContext {
  toolHome: string;
  homedir: string;
  /** The authorized root (the kernel JAIL). */
  root: string;
  /** The per-call cwd (the tool's process cwd). */
  cwd: string;
  /** The pinned session id (claude, real launches only). */
  sessionId?: string;
  mechanism: SandboxMechanism;
}

/** Owner-only diagnostics: everything that names the host. Audit `detail`, never the wire. */
export interface ExecConfinementDetail {
  policy: ExecPolicy;
  mechanism: SandboxMechanism | "none";
  /** The authorized root (the kernel JAIL param). */
  root: string;
  /** The per-call cwd (root or a confined sub-dir). */
  jail: string;
  homedir: string;
  toolHome: string;
  profile?: string;
  binaryDirs?: ToolBinaryDirs;
  canary?: CanaryOutcome;
}

/** The result of one run (record mode or real). */
export interface ExecRunResult {
  /** True iff the tool exited 0 (record mode counts as a clean no-op success). */
  ok: boolean;
  /** True iff a real spawn happened. */
  launched: boolean;
  /** The isolation contract this run had. `enforced` is true only for a launched jail run. */
  isolation: ExecIsolation;
  /** The per-call cwd (realpath). */
  jail: string;
  /** The FULL argv that was (or would have been) spawned. */
  argv: string[];
  /** Captured stdout (empty when not launched). */
  output: string;
  exitCode: number | null;
  confinement: ExecConfinementDetail;
  /** The tool is not on PATH (the bridge degrades to `source_unavailable`). */
  binaryMissing?: boolean;
  /** Why the run did not proceed, or the tool's stderr when it exited non-zero. */
  reason?: string;
  /** The owner's resume handle (`claude --resume` / `codex resume`), real launches only. */
  sessionId?: string;
}

export interface ExecRunOptions {
  prompt: string;
  /** The cwd, confined to the authorized dir (default: the dir itself). */
  cwd?: string;
  /** Hard timeout (ms). Default 10 minutes. */
  timeoutMs?: number;
}

export interface ExecLauncherDeps {
  authorizedDir?: string;
  resolveBinary: ResolveBinary;
  rawCapture?: CaptureSpawn;
  /** The kernel-jail backend (default: platform-selected). */
  sandbox?: SandboxBackend;
  profilePath?: string;
  /** The owner's $HOME and the tool's state dir (tests point these at fakes). */
  homedir?: string;
  toolHome?: string;
  /** The policy and real-launch readers (default: the owner's persisted settings). */
  policy?: () => ExecPolicy;
  realLaunch?: () => boolean;
  canaryOutsideDir?: (root: string) => string;
}

/** The two shapes a launch can take. The unwrapped one needs the literal `"host"`. */
export type LaunchPlan =
  | { policy: "jail"; backend: SandboxBackend; spec: SandboxSpec }
  | { policy: "host"; command: string; args: string[] };

export function launchArgv(plan: LaunchPlan): { command: string; args: string[] } {
  return plan.policy === "jail"
    ? plan.backend.wrap(plan.spec)
    : { command: plan.command, args: plan.args };
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export class ExecLauncher {
  readonly spec: ExecToolSpec;
  private readonly authorizedDir: string;
  private readonly resolveBinary: ResolveBinary;
  private readonly rawCapture: CaptureSpawn;
  private readonly sandbox: SandboxBackend;
  private readonly profilePath: string;
  private readonly home: string;
  private readonly toolHomeOverride: string | undefined;
  private readonly readPolicy: () => ExecPolicy;
  private readonly readRealLaunch: () => boolean;
  private readonly canaryOutsideDir: ((root: string) => string) | undefined;

  constructor(spec: ExecToolSpec, deps: ExecLauncherDeps) {
    this.spec = spec;
    this.authorizedDir = deps.authorizedDir ?? spec.defaultAuthorizedDir();
    this.resolveBinary = deps.resolveBinary;
    this.rawCapture = deps.rawCapture ?? defaultCapture;
    this.sandbox = deps.sandbox ?? selectSandboxBackend(process.platform === "linux" ? "linux" : "darwin");
    this.profilePath =
      deps.profilePath ??
      process.env[spec.profile.env] ??
      assetPath(spec.profile.packaged, spec.profile.checkout);
    this.home = deps.homedir ?? realpathOr(homedir());
    this.toolHomeOverride = deps.toolHome;
    this.readPolicy = deps.policy ?? (() => execPolicyFor(spec.sourceId, spec.execPolicyEnv));
    this.readRealLaunch = deps.realLaunch ?? (() => realLaunchEnabled(spec.sourceId, spec.realLaunchEnv));
    this.canaryOutsideDir = deps.canaryOutsideDir;
  }

  get jail(): string {
    return this.authorizedDir;
  }

  get mechanism(): SandboxMechanism {
    return this.sandbox.mechanism;
  }

  /** The owner's current policy (read live, per call). */
  policy(): ExecPolicy {
    return this.readPolicy();
  }

  /**
   * Validate + realpath-confine a requested cwd to the authorized dir. A cwd EQUAL to the
   * authorized dir is the common case (default). A SUB-path is allowed; an absolute path
   * outside, a `..` traversal, or a symlink whose real target escapes is rejected with
   * `VaultConfinementError`.
   */
  confineCwd(requestedCwd?: string): string {
    try {
      mkdirSync(this.authorizedDir, { recursive: true });
    } catch {}
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
      const lex = lexicalConfine(requestedCwd);
      if (lex === undefined) {
        throw new VaultConfinementError(`cwd escapes the authorized dir: ${requestedCwd}`);
      }
      rel = lex;
    }
    return confineToVault(this.authorizedDir, rel);
  }

  async run(opts: ExecRunOptions): Promise<ExecRunResult> {
    const prompt = (opts.prompt ?? "").trim();
    const jail = this.confineCwd(opts.cwd);
    const root = realpathSync(this.authorizedDir);
    const bin = await this.resolveBinary(this.spec.binary);
    const policy = this.readPolicy();
    const realLaunch = this.readRealLaunch();
    const sessionId = realLaunch && "mint" in this.spec.sessionId ? randomUUID() : undefined;
    const toolHome = this.toolHomeOverride ?? realpathOr(this.spec.toolHome());
    const tmp = join(root, ".tmp");
    const command = bin ?? this.spec.binary;

    const jailCtx: JailContext = {
      toolHome,
      homedir: this.home,
      root,
      cwd: jail,
      ...(sessionId ? { sessionId } : {}),
      mechanism: this.sandbox.mechanism,
    };

    let plan: LaunchPlan;
    const baseEnv = childEnv(process.env, this.spec.env);
    let env: Record<string, string>;
    let confinement: ExecConfinementDetail;
    if (policy === "host") {
      plan = { policy: "host", command, args: this.spec.hostArgs(prompt, sessionId) };
      env = baseEnv;
      confinement = { policy, mechanism: "none", root, jail, homedir: this.home, toolHome };
    } else {
      const binaryDirs = bin
        ? await resolveToolBinaryDirs(bin, { resolveOnPath: this.resolveBinary, fallback: root })
        : { bin: root, pkg: root, interp: root };
      const spec: SandboxSpec = {
        innerCommand: command,
        innerArgs: this.spec.jailArgs(prompt, sessionId),
        jail: root,
        cwd: jail,
        homedir: this.home,
        toolHome,
        tmpdir: tmp,
        network: true,
        profilePath: this.profilePath,
        params: TOOL_DIR_PARAMS.map((p) => ({ name: p.name, path: binaryDirs[p.key] })),
        toolState: this.spec.toolState(jailCtx),
      };
      plan = { policy: "jail", backend: this.sandbox, spec };
      env = { ...baseEnv, TMPDIR: tmp, ...this.spec.jailEnv(tmp) };
      confinement = {
        policy,
        mechanism: this.sandbox.mechanism,
        root,
        jail,
        homedir: this.home,
        toolHome,
        profile: this.profilePath,
        binaryDirs,
      };
    }
    const launch = launchArgv(plan);
    const argv = [launch.command, ...launch.args];
    const isolation = (launched: boolean): ExecIsolation =>
      policy === "host" ? HOST_ISOLATION : jailIsolation(this.sandbox.mechanism, launched);
    const notLaunched = (reason: string, extra: Partial<ExecRunResult> = {}): ExecRunResult => ({
      ok: false,
      launched: false,
      isolation: isolation(false),
      jail,
      argv,
      output: "",
      exitCode: null,
      confinement,
      reason,
      ...extra,
    });

    if (!realLaunch) {
      return notLaunched(
        `record mode: the owner has not enabled real launch for this source (Plexus console → What I expose → ${this.spec.consoleName} → Real launch), so the launch command was assembled and audited but not spawned`,
        { ok: true },
      );
    }
    if (!bin) {
      return notLaunched(`${this.spec.consoleName} (\`${this.spec.binary}\`) not found on PATH — cannot launch a session.`, {
        binaryMissing: true,
      });
    }

    materializeJailContract(this.authorizedDir, this.spec.contractFile);

    if (plan.policy === "jail") {
      if (!this.sandbox.isAvailableSync()) {
        return notLaunched(
          `the isolation backend (${this.sandbox.mechanism}) is not available on this host, so the run was not started`,
        );
      }
      try {
        mkdirSync(tmp, { recursive: true });
      } catch {}
      try {
        this.spec.prepareJail?.(jailCtx);
      } catch (err) {
        return notLaunched(`${err instanceof Error ? err.message : String(err)}; the run was not started`);
      }
      const jailSpec = plan.spec;
      const canary = await runJailCanary({
        wrap: (inner) => this.sandbox.wrap({ ...jailSpec, innerCommand: inner.command, innerArgs: inner.args }),
        root,
        tmpdir: tmp,
        cwd: jail,
        env,
        capture: this.rawCapture,
        ...(this.canaryOutsideDir ? { outsideDir: this.canaryOutsideDir(root) } : {}),
      });
      confinement.canary = canary;
      if (!canary.ok) return notLaunched(`${canary.reason}; the run was not started`);
    }

    let res: CaptureResult;
    try {
      res = await this.rawCapture({
        command: launch.command,
        args: launch.args,
        cwd: jail,
        env,
        timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000,
      });
    } catch (err) {
      return notLaunched(`launch failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
    }

    const ok = res.exitCode === 0;
    const sid =
      sessionId ?? ("parse" in this.spec.sessionId ? this.spec.sessionId.parse(res.stdout, res.stderr) : undefined);
    return {
      ok,
      launched: true,
      isolation: isolation(true),
      jail,
      argv,
      output: res.stdout,
      exitCode: res.exitCode,
      confinement,
      ...(sid ? { sessionId: sid } : {}),
      ...(ok ? {} : { reason: res.stderr.trim() || `${this.spec.binary} exited ${res.exitCode}` }),
    };
  }
}
