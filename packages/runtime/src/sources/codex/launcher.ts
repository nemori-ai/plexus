/**
 * Headless Codex (the `codex.run` capability core): the Codex entry of the shared
 * {@link ExecLauncher} table. See `sources/exec-launcher.ts` for the launch and
 * `sources/exec-isolation.ts` for the contract.
 *
 * The inner command under both policies is
 *
 *     codex exec --sandbox danger-full-access --skip-git-repo-check "<task>"
 *
 * Under `jail` it runs inside Plexus's kernel jail with `TMPDIR` inside the authorized
 * root. Codex's own sandbox is OFF there BECAUSE the kernel jail is the boundary: its
 * `workspace-write` seatbelt nested inside Plexus's makes every shell command fail with
 * "sandbox initialization denied". Under `host` the same command runs with no wrap: the
 * owner's own permissions, as in a terminal.
 *
 * Codex's state (`$CODEX_HOME`, or `~/.codex`) stays writable under the jail (Codex hangs
 * when it cannot write its sqlite state and logs) except the entries that change its
 * behaviour, {@link CODEX_PROTECTED_STATE}, and its cross-session stores,
 * {@link CODEX_PROTECTED_SQLITE}, which stay read-only.
 */

import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { realLaunchEnabled } from "../config/settings.ts";
import { ExecLauncher, type ExecLauncherDeps, type ExecToolSpec } from "../exec-launcher.ts";

export type { ExecRunResult, ExecRunOptions } from "../exec-launcher.ts";

export function defaultAuthorizedDir(): string {
  return join(homedir(), ".plexus", "workspace", "codex");
}

export function headlessLaunchEnabled(): boolean {
  return realLaunchEnabled("codex", "PLEXUS_CODEX_HEADLESS_LAUNCH");
}

/**
 * The entries of Codex's state dir that change what Codex does (config, hooks, plugins,
 * skills, rules, prompts, instructions). Read-only under the jail; `codex-confine.sb`'s
 * deny block lists the same names.
 */
export const CODEX_PROTECTED_STATE = [
  "config.toml",
  "hooks.json",
  "AGENTS.md",
  "hooks",
  "plugins",
  "skills",
  "rules",
  "prompts",
] as const;

const CODEX_PROTECTED_DIRS = ["hooks", "plugins", "skills", "rules", "prompts"] as const;

/**
 * Codex's cross-session stores, `<family>_<n>.sqlite` (+ `-wal`/`-shm`/`-journal`):
 * `memories` is rendered into future sessions' prompts (the binary's
 * `ext/memories/src/prompts.rs`, `use_memories`/`generate_memories` config), `goals` is
 * the owner's goal list (`goals = true`, `max_goal_token_budget`). Both are the same
 * injection class as Claude Code's auto-memory, so they stay read-only; `state`, `logs`,
 * `queue` and `thread_history` stay writable (Codex hangs without them).
 * `codex-confine.sb` denies the families by regex; bwrap binds the files that exist.
 */
export const CODEX_PROTECTED_SQLITE = ["memories", "goals"] as const;

const PROTECTED_SQLITE_RE = new RegExp(`^(${CODEX_PROTECTED_SQLITE.join("|")})[^/]*\\.sqlite`);

/** The existing protected store files under `toolHome` (none when the dir is unreadable). */
export function codexProtectedSqliteFiles(toolHome: string): string[] {
  try {
    return readdirSync(toolHome)
      .filter((f) => PROTECTED_SQLITE_RE.test(f))
      .sort()
      .map((f) => join(toolHome, f));
  } catch {
    return [];
  }
}

/**
 * The profile's regex is `^<TOOL_HOME>/(memories|goals)…`, with the tool home spliced in
 * raw, so a home containing a regex metacharacter would silently narrow or break the deny.
 * `.` only widens it (any char), so `~/.codex` is fine; the rest refuse the launch.
 */
const REGEX_UNSAFE = /[\\^$|?*+()[\]{}]/;
export function assertRegexSafeToolHome(toolHome: string): void {
  if (REGEX_UNSAFE.test(toolHome)) {
    throw new Error(
      `the Codex state dir ${toolHome} contains a character the jail profile cannot match safely (one of \\ ^ $ | ? * + ( ) [ ] { }); set CODEX_HOME to a plain path`,
    );
  }
}

/** The resume handle, parsed from `codex exec`'s banner (`session id: <uuid>`), either stream. */
export function parseSessionId(stdout: string, stderr: string): string | undefined {
  const m = /session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
    stdout + "\n" + stderr,
  );
  return m?.[1];
}

function codexArgs(prompt: string): string[] {
  return ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", prompt];
}

export const CODEX_TOOL: ExecToolSpec = {
  sourceId: "codex",
  binary: "codex",
  consoleName: "Codex",
  contractFile: "AGENTS.md",
  defaultAuthorizedDir,
  realLaunchEnv: "PLEXUS_CODEX_HEADLESS_LAUNCH",
  execPolicyEnv: "PLEXUS_CODEX_EXEC_POLICY",
  profile: {
    packaged: "runtime/sources/codex/sandbox/codex-confine.sb",
    checkout: new URL("./sandbox/codex-confine.sb", import.meta.url),
    env: "PLEXUS_CODEX_CONFINE_PROFILE",
  },
  toolHome: () => process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  toolState: ({ toolHome }) => [
    { path: toolHome, access: "rw" },
    ...CODEX_PROTECTED_STATE.map((entry) => ({ path: join(toolHome, entry), access: "ro" as const })),
    ...codexProtectedSqliteFiles(toolHome).map((path) => ({ path, access: "ro" as const })),
  ],
  // bwrap can only make an EXISTING node read-only, so the protected dirs are created
  // (empty, which is what Codex treats an absent dir as) before they are ro-bound.
  prepareJail: ({ toolHome, mechanism }) => {
    if (mechanism === "sandbox-exec") assertRegexSafeToolHome(toolHome);
    if (mechanism !== "bwrap") return;
    for (const d of CODEX_PROTECTED_DIRS) {
      try {
        mkdirSync(join(toolHome, d), { recursive: true });
      } catch {}
    }
  },
  jailArgs: codexArgs,
  hostArgs: codexArgs,
  env: ["CODEX_HOME", "OPENAI_API_KEY", "OPENAI_BASE_URL"],
  jailEnv: () => ({}),
  sessionId: { parse: parseSessionId },
};

export class CodexLauncher extends ExecLauncher {
  constructor(deps: ExecLauncherDeps) {
    super(CODEX_TOOL, deps);
  }
}
