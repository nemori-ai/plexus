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
import { existingPrivateState, type PrivateStateEntry } from "../exec-isolation.ts";
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
 * The owner's private state under the Claude Code home: unreadable in the jail. Everything
 * Claude Code writes AS the owner works (the "Application data" tables of
 * code.claude.com/docs/en/claude-directory, which say: "Anything that passes through a
 * tool is written to a transcript on disk: file contents, command output, pasted text")
 * and the state of the owner's other Claude Code processes. Login, settings, plugins,
 * skills, rules and the rest of the configuration stay readable, so the run works as the
 * owner's own. The order is the profile's deny list and bwrap's mount order.
 *
 *  - `projects/`: every transcript, subagent transcript, spilled tool result and auto-memory.
 *    This run's own `<slug>/<sessionId>.jsonl` + `<slug>/<sessionId>/` are re-granted after.
 *  - `history.jsonl`: every prompt the owner typed, with its project path.
 *  - `file-history/`: pre-edit snapshots of the files the owner's sessions changed.
 *  - `paste-cache/`: the contents of large pastes. `uploads/`, `image-cache/`: attachments.
 *  - `plans/`, `tasks/`, `todos/`, `dev-mods/`, `usage-data/`, `feedback/`,
 *    `feedback-bundles/`, `debug/`, `logs/`: plan text, task lists, mods, insight reports,
 *    feedback drafts and transcript archives, debug logs.
 *  - `session-env/`, `shell-snapshots/`: per-session hook scripts and the owner's shell
 *    aliases, functions and options as captured at each session's start.
 *  - `agent-memory/`: subagents' persistent memory (the subagent twin of the auto-memory).
 *  - `transcripts/`, `teams/`, `jobs/`, `daemon/`, `daemon.log`, `sessions/`, `ide/`,
 *    `channels/`, `backups/`, `downloads/`: remote/background-session transcripts, team
 *    inboxes, background-session state and its control key, running sessions' socket keys,
 *    IDE lock files (auth tokens), channel access state, earlier `~/.claude.json` copies,
 *    downloads (seen in a real `~/.claude` on claude 2.1.306, names only).
 */
export const CC_PRIVATE_STATE: readonly PrivateStateEntry[] = [
  { name: "projects", kind: "dir" },
  { name: "history.jsonl", kind: "file" },
  { name: "file-history", kind: "dir" },
  { name: "paste-cache", kind: "dir" },
  { name: "uploads", kind: "dir" },
  { name: "image-cache", kind: "dir" },
  { name: "plans", kind: "dir" },
  { name: "tasks", kind: "dir" },
  { name: "todos", kind: "dir" },
  { name: "dev-mods", kind: "dir" },
  { name: "usage-data", kind: "dir" },
  { name: "feedback", kind: "dir" },
  { name: "feedback-bundles", kind: "dir" },
  { name: "debug", kind: "dir" },
  { name: "logs", kind: "dir" },
  { name: "session-env", kind: "dir" },
  { name: "shell-snapshots", kind: "dir" },
  { name: "agent-memory", kind: "dir" },
  { name: "transcripts", kind: "dir" },
  { name: "teams", kind: "dir" },
  { name: "jobs", kind: "dir" },
  { name: "daemon", kind: "dir" },
  { name: "daemon.log", kind: "file" },
  { name: "sessions", kind: "dir" },
  { name: "ide", kind: "dir" },
  { name: "channels", kind: "dir" },
  { name: "backups", kind: "dir" },
  { name: "downloads", kind: "dir" },
];

/**
 * The only state this run can read back and write: THIS run's transcript
 * (`<slug>/<sid>.jsonl`, the owner's `--resume` handle) and its per-session dir, granted
 * after `projects/` is hidden. `memory/` under the slug is Claude Code's auto-memory,
 * injected into the owner's future sessions, so it is never writable.
 *
 * The seatbelt grants the two paths by name without needing them to exist; bwrap can bind
 * only existing nodes and Claude Code refuses a pre-created transcript ("Session ID … is
 * already in use"), so Linux binds the slug dir rw (over the empty tmpfs that hides
 * `projects/`) with `memory/` pre-created and hidden under its own empty tmpfs.
 */
function sessionMounts({ toolHome, root, cwd, sessionId, mechanism }: JailContext): ToolStateMount[] {
  const slug = join(toolHome, "projects", ccProjectSlug(cwd));
  if (mechanism === "bwrap") {
    return [
      { path: slug, access: "rw" },
      { path: join(slug, "memory"), access: "hidden", kind: "dir" },
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
    ...existingPrivateState(ctx.toolHome, CC_PRIVATE_STATE),
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
  // Claude Code's own auth + endpoint + state-dir variables. Bedrock/Vertex (AWS_*/GOOGLE_*)
  // are not passed: cloud credentials have no business inside a prompt-driven run.
  env: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"],
  jailEnv: (tmpdir) => ({ CLAUDE_CODE_TMPDIR: tmpdir }),
  sessionId: { mint: true },
};

export class ClaudeCodeLauncher extends ExecLauncher {
  constructor(deps: ExecLauncherDeps) {
    super(CLAUDE_TOOL, deps);
  }
}
