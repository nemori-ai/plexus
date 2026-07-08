/**
 * The jail-root BEHAVIOR CONTRACT for sandbox-confined exec tools (codex / claude).
 *
 * Both tools read a conventions file from their cwd (`AGENTS.md` for codex,
 * `CLAUDE.md` for claude). Before a REAL launch, the launcher materializes this
 * contract at the jail root so the spawned tool knows the context it runs in: its
 * stdout is returned VERBATIM to a possibly-remote caller (the gateway never
 * rewrites tool output), so what the tool chooses to say is the last unguarded
 * surface for machine-fingerprint leaks (absolute paths, usernames, layout).
 *
 * The gateway-added result metadata is already wire-redacted at the bridge
 * (`toData` vs `toAuditDiagnostics`); this file steers the TOOL's own words.
 *
 * An OWNER-authored file always wins — we only write when the file is absent
 * (the owner owns the machine; their conventions outrank ours).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Marker on the FIRST line of a gateway-written contract. Its presence means "Plexus
 * wrote this, safe to upgrade"; its absence means the file is the OWNER's own and must
 * be left untouched. Bump `v1` when the contract text changes so an older gateway-written
 * file is replaced (not frozen forever) while an owner file still wins.
 */
const CONTRACT_MARKER = "<!-- plexus-jail-contract v2 -->";

/** The contract body — tool-neutral, short enough to never crowd a context. */
const JAIL_CONTRACT = `${CONTRACT_MARKER}
# Plexus-confined run

You are running inside a sandboxed workspace directory on someone's machine. Do all of
your work in THIS directory — it is the project root, and the place your files are
created and modified. Your output is returned verbatim to a caller that may be a REMOTE
agent.

Ground rules for your output:

- Treat this directory as the project root. Refer to files by RELATIVE path
  (e.g. \`notes/plan.md\`) — never by absolute path.
- Never volunteer the host machine's absolute paths, home directory, username,
  tool install locations, versions, or system configuration.
- Keep your answer about the TASK and its products; the caller cannot see this
  machine and does not need to.
`;

/**
 * Write the contract at `<authorizedRoot>/<filename>`. Pass the authorized-dir ROOT
 * (never a per-call cwd) so the file lands once at the jail root, not scattered into
 * whatever subdirectory an agent named. Behavior:
 *   - file absent            → write it;
 *   - file is OURS (marker)  → overwrite (upgrade to the current contract text);
 *   - file is the OWNER's    → leave it untouched (their conventions win).
 * Best-effort: a write failure never blocks the launch (the tool's own sandbox still
 * write-confines it; only the advisory steering is lost).
 */
export function materializeJailContract(authorizedRoot: string, filename: "AGENTS.md" | "CLAUDE.md"): void {
  try {
    const path = join(authorizedRoot, filename);
    if (existsSync(path)) {
      const head = readFileSync(path, "utf8").slice(0, CONTRACT_MARKER.length);
      if (head !== CONTRACT_MARKER) return; // the owner's own file — never clobber it
      // else: a gateway-written file from a prior (possibly older) run — refresh it.
    }
    writeFileSync(path, JAIL_CONTRACT, { mode: 0o644 });
  } catch {
    /* best-effort — see above */
  }
}
