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
 *
 * Under the `host` policy the same command runs without the `--settings` override and
 * without any wrap: the owner's own permissions, as in a terminal.
 *
 * Claude Code's state: `$CLAUDE_CONFIG_DIR` (or `~/.claude`) and `~/.claude.json` are
 * readable so login, plugins and settings work; only `<state>/projects` is writable (the
 * session transcript the owner's `claude --resume <sessionId>` replays).
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { realLaunchEnabled } from "../config/settings.ts";
import { ExecLauncher, type ExecLauncherDeps, type ExecToolSpec } from "../exec-launcher.ts";

export type { ExecRunResult, ExecRunOptions } from "../exec-launcher.ts";

/** Default authorized directory. */
export function defaultAuthorizedDir(): string {
  return join(homedir(), ".plexus", "workspace", "claudecode");
}

/** The owner's Real-launch setting for this source (persisted console setting > env). */
export function headlessLaunchEnabled(): boolean {
  return realLaunchEnabled("claudecode", "PLEXUS_CC_HEADLESS_LAUNCH");
}

/** Claude Code's own sandbox OFF, as a CLI settings layer that outranks the owner's settings.json. */
export const CC_INNER_SANDBOX_OFF = ["--settings", JSON.stringify({ sandbox: { enabled: false } })] as const;

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
  toolState: (toolHome, home) => [
    { path: toolHome, access: "ro" },
    { path: join(toolHome, "projects"), access: "rw" },
    { path: join(home, ".claude.json"), access: "ro" },
  ],
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
