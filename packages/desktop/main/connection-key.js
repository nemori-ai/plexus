/**
 * Connection-key reader (REDESIGN §3.5) — main reads `~/.plexus/connection-key`
 * (it has fs access to the user's home, same trust domain) and uses it for the
 * SSE subscription + approve calls. The key never leaves the box; it is NOT shown
 * to the user. For P2 we host the runtime's served `/admin` SPA, which fetches its
 * OWN key — so the renderer never needs it injected. Main keeps it only for its
 * own management calls.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** @param {string} [plexusHome] Override (smoke uses a temp dir). */
export function readConnectionKey(plexusHome) {
  const home = plexusHome ?? join(homedir(), ".plexus");
  const path = join(home, "connection-key");
  if (!existsSync(path)) return null;
  const key = readFileSync(path, "utf-8").trim();
  return key || null;
}
