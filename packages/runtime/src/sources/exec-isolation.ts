/**
 * The exec-isolation contract shared by `claudecode.run` and `codex.run`: what a run
 * may reach, stated the same way on the wire, in the audit, in the console and in the
 * docs.
 *
 * Two owner-chosen policies:
 *
 *  - `jail` (the default): Plexus runs the tool inside its own kernel sandbox
 *    (`sandbox-exec` on macOS, `bwrap` on Linux). Reads, writes and temp files stay
 *    inside the authorized directory; the tool's own login state is readable and the
 *    parts of its state that change its behaviour are read-only; the network is open
 *    (the model API). Before every real launch a canary runs under the identical wrap
 *    and must prove the jail holds; if it cannot, the call fails instead of launching.
 *  - `host`: the tool runs exactly as if the owner had started it in a terminal, with
 *    the owner's user permissions and no Plexus wrap. Nothing is enforced and the
 *    report says so.
 *
 * `enforced` is true only for a jail run whose canary passed AND whose tool was then
 * spawned inside that wrap; it is derived from the launch outcome in one place
 * (`jailIsolation`), never set by hand.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { JsonSchema } from "@plexus/protocol";

import type { SandboxMechanism } from "../platform/sandbox-backend.ts";
import type { CaptureSpawn, ResolveBinary } from "./exec-capture.ts";

/** The owner-chosen execution policy for an exec source. Agents can never change it. */
export type ExecPolicy = "jail" | "host";

export const EXEC_POLICIES: readonly ExecPolicy[] = ["jail", "host"];

export function isExecPolicy(v: unknown): v is ExecPolicy {
  return v === "jail" || v === "host";
}

/** A jail run's report: what confines it and whether that was proven for this run. */
export interface JailIsolation {
  policy: "jail";
  mechanism: SandboxMechanism;
  scope: {
    /** Reads AND writes. */
    files: "authorized-dir";
    temp: "authorized-dir";
    network: "open";
    /** The tool's login/state is usable; the config that changes its behaviour is not writable. */
    toolState: "own-config-read-only";
  };
  /** True only when the canary passed under the identical wrap AND the tool was spawned inside it. */
  enforced: boolean;
}

/** A host run's report: the owner's own permissions, nothing to enforce. */
export interface HostIsolation {
  policy: "host";
  mechanism: "none";
  scope: {
    files: "host-user";
    temp: "host-user";
    network: "open";
    toolState: "host-user";
  };
  enforced: false;
}

export type ExecIsolation = JailIsolation | HostIsolation;

export function jailIsolation(mechanism: SandboxMechanism, enforced: boolean): JailIsolation {
  return {
    policy: "jail",
    mechanism,
    scope: {
      files: "authorized-dir",
      temp: "authorized-dir",
      network: "open",
      toolState: "own-config-read-only",
    },
    enforced,
  };
}

export const HOST_ISOLATION: HostIsolation = {
  policy: "host",
  mechanism: "none",
  scope: { files: "host-user", temp: "host-user", network: "open", toolState: "host-user" },
  enforced: false,
};

/**
 * The environment a run gets, under BOTH policies: the owner's shell basics, locale,
 * proxy and CA settings, plus the tool's own documented variables ({@link ExecToolSpec}'s
 * `env`). Nothing else from the gateway's environment reaches a prompt-driven tool with
 * an open network: not its join token, not whatever the owner exported.
 */
export const BASE_CHILD_ENV: readonly string[] = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "LANG",
  "TERM",
  "TZ",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];

export function childEnv(source: NodeJS.ProcessEnv, toolVars: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (BASE_CHILD_ENV.includes(k) || toolVars.includes(k) || k.startsWith("LC_")) out[k] = v;
  }
  return out;
}

/** The `isolation` field of a run result, as the capability's `io.output` schema states it. */
export const EXEC_ISOLATION_SCHEMA: JsonSchema = {
  type: "object",
  description:
    "What the run could reach. `policy` is the owner's choice: `jail` (Plexus's kernel sandbox " +
    "around the authorized directory: reads, writes and temp files stay inside it, the tool's " +
    "own login works, the network is open) or `host` (the owner's own user permissions). " +
    "`enforced` is true only for a jail run that was verified and launched inside it.",
  properties: {
    policy: { type: "string", enum: ["jail", "host"] },
    mechanism: { type: "string", enum: ["sandbox-exec", "bwrap", "none"] },
    scope: {
      type: "object",
      properties: {
        files: { type: "string", enum: ["authorized-dir", "host-user"] },
        temp: { type: "string", enum: ["authorized-dir", "host-user"] },
        network: { type: "string", enum: ["open"] },
        toolState: { type: "string", enum: ["own-config-read-only", "host-user"] },
      },
      required: ["files", "temp", "network", "toolState"],
    },
    enforced: { type: "boolean" },
  },
  required: ["policy", "mechanism", "scope", "enforced"],
};

/**
 * The three read-only dirs the profiles name. Each is a real dir or, when it has no
 * meaning for this tool, the jail root (a grant the jail already has, so a no-op).
 */
export interface ToolBinaryDirs {
  /** The dir holding the resolved entry point (symlinks followed). */
  bin: string;
  /**
   * The enclosing `node_modules` when the entry point is an npm package (the platform
   * binary package lives beside or under it), else the bin dir again. Never a parent of
   * the bin dir: for a tool at `~/bin/x` that would grant the owner's whole home.
   */
  pkg: string;
  /** The interpreter's dir when the entry point is a `#!` script (`#!/usr/bin/env node` resolves `node` on PATH). */
  interp: string;
}

export const TOOL_DIR_PARAMS: readonly { name: string; key: keyof ToolBinaryDirs }[] = [
  { name: "TOOL_BIN_DIR", key: "bin" },
  { name: "TOOL_PKG_DIR", key: "pkg" },
  { name: "TOOL_INTERP_DIR", key: "interp" },
];

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function nodeModulesAncestor(p: string): string | undefined {
  let cur = dirname(p);
  while (cur !== dirname(cur)) {
    if (basename(cur) === "node_modules") return cur;
    cur = dirname(cur);
  }
  return undefined;
}

/** Parse a `#!` line into the interpreter to resolve: an absolute path, or a name after `env`. */
export function shebangInterpreter(head: string): { path: string } | { name: string } | undefined {
  if (!head.startsWith("#!")) return undefined;
  const line = head.slice(2).split(/\r?\n/, 1)[0] ?? "";
  const [first, second] = line.trim().split(/\s+/);
  if (!first) return undefined;
  if (basename(first) === "env" && second && !second.startsWith("-")) return { name: second };
  return { path: first };
}

export async function resolveToolBinaryDirs(
  binPath: string,
  deps: { resolveOnPath: ResolveBinary; fallback: string },
): Promise<ToolBinaryDirs> {
  const real = realpathOr(binPath);
  const bin = dirname(real);
  const pkg = nodeModulesAncestor(real) ?? bin;
  let interp = deps.fallback;
  let head = "";
  try {
    head = readFileSync(real, { encoding: "utf8", flag: "r" }).slice(0, 256);
  } catch {}
  const she = shebangInterpreter(head);
  if (she) {
    const target = "path" in she ? she.path : await deps.resolveOnPath(she.name);
    if (target) interp = dirname(realpathOr(target));
  }
  return { bin, pkg, interp };
}

/** What the canary observed. Owner audit only. */
export interface CanaryOutcome {
  ok: boolean;
  exitCode: number | null;
  reason?: string;
  insideWrite: boolean;
  /** The outside write landed on the host (checked from outside the jail, so a private tmpfs cannot fake it). */
  outsideWriteLanded: boolean;
  outsideReadSucceeded: boolean;
}

/**
 * The script runs `/bin/sh` under the IDENTICAL wrap the tool will get. `$1` is a file
 * inside the jail's temp dir, `$2` and `$3` are files outside the jail. It reports each
 * attempt on stdout; the host side judges (a write that "succeeded" into a private tmpfs
 * is caught by checking the host for the file).
 */
export const CANARY_SCRIPT = [
  'if printf ok > "$1" 2>/dev/null; then echo IN=1; rm -f "$1"; else echo IN=0; fi',
  'if printf x > "$2" 2>/dev/null; then echo W=1; else echo W=0; fi',
  'if cat "$3" >/dev/null 2>&1; then echo R=1; else echo R=0; fi',
].join("\n");

export interface CanaryArgs {
  /** Wrap an inner command exactly as the tool will be wrapped. */
  wrap: (inner: { command: string; args: string[] }) => { command: string; args: string[] };
  /** The authorized root (the kernel JAIL). */
  root: string;
  /** The jail's temp dir (inside the root). */
  tmpdir: string;
  /** The cwd + env the tool will get. */
  cwd: string;
  env: Record<string, string>;
  capture: CaptureSpawn;
  /** A dir OUTSIDE the jail that Plexus can write (default: a sibling of the root, else the system temp). */
  outsideDir?: string;
  timeoutMs?: number;
}

/** A writable dir outside `root`: a sibling first (not under the system temp, which Linux shadows with a tmpfs). */
export function canaryOutsideDir(root: string): string {
  try {
    return mkdtempSync(join(dirname(root), ".plexus-canary-"));
  } catch {
    return mkdtempSync(join(tmpdir(), "plexus-canary-"));
  }
}

export async function runJailCanary(args: CanaryArgs): Promise<CanaryOutcome> {
  const outside = args.outsideDir ?? canaryOutsideDir(args.root);
  const nonce = basename(outside);
  const inside = join(args.tmpdir, `.plexus-canary-${nonce}`);
  const outsideWrite = join(outside, "w");
  const outsideRead = join(outside, "r");
  const failed = (partial: Partial<CanaryOutcome>, reason: string): CanaryOutcome => ({
    ok: false,
    exitCode: null,
    insideWrite: false,
    outsideWriteLanded: false,
    outsideReadSucceeded: false,
    ...partial,
    reason,
  });
  try {
    writeFileSync(outsideRead, "secret\n", { mode: 0o600 });
    const inner = { command: "/bin/sh", args: ["-c", CANARY_SCRIPT, "plexus-canary", inside, outsideWrite, outsideRead] };
    const { command, args: wrapped } = args.wrap(inner);
    let res;
    try {
      res = await args.capture({ command, args: wrapped, cwd: args.cwd, env: args.env, timeoutMs: args.timeoutMs ?? 20_000 });
    } catch (err) {
      return failed({}, `isolation canary could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
    const flag = (k: string): boolean => new RegExp(`^${k}=1$`, "m").test(res.stdout);
    const observed = {
      exitCode: res.exitCode,
      insideWrite: flag("IN"),
      outsideWriteLanded: existsSync(outsideWrite),
      outsideReadSucceeded: flag("R"),
    };
    if (res.exitCode !== 0) {
      return failed(observed, `isolation canary did not run (exit ${res.exitCode}): ${res.stderr.trim().slice(-400)}`);
    }
    if (!observed.insideWrite) return failed(observed, "isolation canary could not write inside the authorized directory");
    if (observed.outsideWriteLanded) return failed(observed, "isolation canary wrote OUTSIDE the authorized directory: the jail does not hold");
    if (observed.outsideReadSucceeded) return failed(observed, "isolation canary read a file OUTSIDE the authorized directory: the jail does not hold");
    return { ok: true, ...observed };
  } finally {
    try {
      rmSync(outside, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(inside, { force: true });
    } catch {}
  }
}
