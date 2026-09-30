/** First-party filesystem resources cannot expose Plexus or Product custody. */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { plexusHome } from "../core/paths.ts";

export class ProtectedPathError extends Error {}
const INVALID = "Invalid protected filesystem configuration.";
const DENIED = "Filesystem resource overlaps protected application storage.";

/** Resolve existing symlinks, including parents of files that will be created. */
export function canonicalFilesystemPath(path: string, depth = 0): string {
  if (depth > 128) throw new ProtectedPathError("Unable to verify filesystem resource path.");
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ProtectedPathError("Unable to verify filesystem resource path.");
  }
  // A dangling symlink must follow its target, never become a lexical write bypass.
  try {
    if (lstatSync(absolute).isSymbolicLink()) return canonicalFilesystemPath(resolve(dirname(absolute), readlinkSync(absolute)), depth + 1);
  } catch (error) {
    if (error instanceof ProtectedPathError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ProtectedPathError("Unable to verify filesystem resource path.");
  }
  const parent = dirname(absolute);
  if (parent === absolute) throw new ProtectedPathError("Unable to verify filesystem resource path.");
  return join(canonicalFilesystemPath(parent, depth + 1), basename(absolute));
}
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Optional host policy is private JSON, never supplied by an agent request. */
function protectedRoots(): string[] {
  let extras: unknown = [];
  const configured = process.env.PLEXUS_PROTECTED_PATHS;
  if (configured !== undefined) {
    try { extras = JSON.parse(configured); } catch { throw new ProtectedPathError(INVALID); }
    if (!Array.isArray(extras) || extras.some((path) => typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))) throw new ProtectedPathError(INVALID);
  }
  return [plexusHome(), ...(extras as string[])].map((path) => canonicalFilesystemPath(path));
}

/** Refuse the whole root when it is inside OR contains any protected directory. */
export function assertUnprotectedFilesystemPath(path: string): string {
  const roots = protectedRoots();
  const canonical = canonicalFilesystemPath(path);
  if (roots.some((root) => inside(root, canonical) || inside(canonical, root))) throw new ProtectedPathError(DENIED);
  return canonical;
}
