/**
 * Headless Claude Code (the `claudecode.run` capability core): the Claude Code entry of
 * the shared {@link ExecLauncher} table. See `sources/exec-launcher.ts` for the launch
 * and `sources/exec-isolation.ts` for the contract.
 *
 * Under the `jail` policy the inner command is
 *
 *     claude -p "<task>" --dangerously-skip-permissions --permission-mode bypassPermissions
 *            --session-id <uuid> --settings '{"sandbox":{"enabled":false}}'
 *
 * run inside Plexus's kernel jail with `CLAUDE_CODE_TMPDIR` and `TMPDIR` inside the
 * authorized root. Claude Code's own per-action prompts are bypassed and its own sandbox
 * is turned off BECAUSE the kernel jail is the boundary: Claude Code hardcodes
 * `/tmp/claude-<uid>` unless `CLAUDE_CODE_TMPDIR` is set, and an owner who enabled its
 * sandbox in `settings.json` would otherwise nest two sandboxes and break its shell tool.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ToolStateMount } from "../../platform/sandbox-backend.ts";
import { realLaunchEnabled } from "../config/settings.ts";
import { ExecLauncher, type ExecLauncherDeps, type ExecToolSpec, type JailContext } from "../exec-launcher.ts";

export type { ExecRunResult, ExecRunOptions } from "../exec-launcher.ts";

export function defaultAuthorizedDir(): string {
  return join(homedir(), ".plexus", "workspace", "claudecode");
}

export function headlessLaunchEnabled(): boolean {
  return realLaunchEnabled("claudecode", "PLEXUS_CC_HEADLESS_LAUNCH");
}

/** Claude Code's own sandbox OFF, as a CLI settings layer that outranks the owner's settings.json. */
export const CC_INNER_SANDBOX_OFF = ["--settings", JSON.stringify({ sandbox: { enabled: false } })] as const;

/**
 * Claude Code keeps a cwd's sessions under `~/.claude/projects/<slug>/`, the cwd with every
 * character outside `[A-Za-z0-9]` replaced by `-` (claude 2.1.306 resolved a transcript
 * pre-created at this slug for a cwd with `_`, `.` and `/` in it).
 */
export function ccProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** The seatbelt params `cc-confine.sb` reaches this run's transcript by. */
export const CC_SESSION_PARAMS = { file: "CC_SESSION_FILE", dir: "CC_SESSION_DIR" } as const;

/**
 * The only writable state: THIS run's transcript (`<slug>/<sid>.jsonl`, the owner's
 * `--resume` handle) and its per-session dir. `memory/` under the slug is Claude Code's
 * auto-memory, injected into the owner's future sessions, so it is never writable.
 *
 * The seatbelt grants the two paths by name without needing them to exist; bwrap can bind
 * only existing nodes and Claude Code refuses a pre-created transcript ("Session ID … is
 * already in use"), so Linux binds the slug dir rw with `memory/` pre-created and ro.
 */
function sessionMounts({ toolHome, root, cwd, sessionId, mechanism }: JailContext): ToolStateMount[] {
  const slug = join(toolHome, "projects", ccProjectSlug(cwd));
  if (mechanism === "bwrap") {
    return [
      { path: slug, access: "rw" },
      { path: join(slug, "memory"), access: "ro" },
    ];
  }
  // Record mode has no session: the params still need a value, and the jail root is a grant it already has.
  const file = sessionId ? join(slug, `${sessionId}.jsonl`) : root;
  const dir = sessionId ? join(slug, sessionId) : root;
  return [
    { path: file, access: "rw", name: CC_SESSION_PARAMS.file },
    { path: dir, access: "rw", name: CC_SESSION_PARAMS.dir },
  ];
}

function nativeArgs(prompt: string, sessionId?: string): string[] {
  return [
    "-p",
    prompt,
    "--dangerously-skip-permissions",
    "--permission-mode",
    "bypassPermissions",
    ...(sessionId ? ["--session-id", sessionId] : []),
  ];
}

export const CLAUDE_TOOL: ExecToolSpec = {
  sourceId: "claudecode",
  binary: "claude",
  consoleName: "Claude Code",
  contractFile: "CLAUDE.md",
  defaultAuthorizedDir,
  realLaunchEnv: "PLEXUS_CC_HEADLESS_LAUNCH",
  execPolicyEnv: "PLEXUS_CC_EXEC_POLICY",
  profile: {
    packaged: "runtime/sources/claudecode/sandbox/cc-confine.sb",
    checkout: new URL("./sandbox/cc-confine.sb", import.meta.url),
    env: "PLEXUS_CC_CONFINE_PROFILE",
  },
  toolHome: () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  toolState: (ctx) => [
    { path: ctx.toolHome, access: "ro" },
    ...sessionMounts(ctx),
    { path: join(ctx.homedir, ".claude.json"), access: "ro" },
  ],
  prepareJail: ({ toolHome, cwd, mechanism }) => {
    const slug = join(toolHome, "projects", ccProjectSlug(cwd));
    for (const d of mechanism === "bwrap" ? [slug, join(slug, "memory")] : [slug]) {
      try {
        mkdirSync(d, { recursive: true });
      } catch {}
    }
  },
  jailArgs: (prompt, sessionId) => [...nativeArgs(prompt, sessionId), ...CC_INNER_SANDBOX_OFF],
  hostArgs: nativeArgs,
  jailEnv: (tmpdir) => ({ CLAUDE_CODE_TMPDIR: tmpdir }),
  sessionId: { mint: true },
};

export class ClaudeCodeLauncher extends ExecLauncher {
  constructor(deps: ExecLauncherDeps) {
    super(CLAUDE_TOOL, deps);
  }
}
