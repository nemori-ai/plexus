/**
 * Obsidian vault reader — the path-confined, READ-ONLY filesystem access behind
 * the `obsidian.vault.read` capability (Acceptance Scenario B).
 *
 * MECHANISM CHOICE (t9): a vault is just a folder of `.md` files + attachments.
 * We read those files directly off disk rather than going through the Obsidian
 * Local REST API plugin. This is the MOST ROBUST mechanism for a demo because it
 *   - has NO dependency on the Obsidian app running or the REST plugin installed,
 *   - has NO secret/bearer-key setup,
 *   - is trivially enforced read-only (we only ever `readFile`/`readdir`),
 *   - and is path-confined in pure code we own + test.
 *
 * SECURITY CONTRACT (must be a real assertion, not a comment):
 *   - READ-ONLY: this module exposes only `read` + `list`. There is no write,
 *     rename, delete, or execute path at all.
 *   - PATH-CONFINEMENT: every requested path is resolved against the vault root
 *     and REJECTED if it escapes the vault — `..` traversal, an absolute path, or
 *     a symlink whose real target lands outside the vault root. We compare REAL
 *     (symlink-resolved) paths, so a symlink inside the vault that points out is
 *     also denied.
 */

import { realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

/** A traversal / confinement violation — surfaced as a `transport_error`. */
export class VaultConfinementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultConfinementError";
  }
}

/** A read of a single note. */
export interface VaultFileResult {
  type: "file";
  /** Path relative to the vault root, POSIX-normalized. Never an absolute path. */
  relativePath: string;
  /** UTF-8 file content. */
  content: string;
  bytes: number;
  modifiedAt: string;
}

/** One entry in a directory listing. */
export interface VaultDirEntry {
  name: string;
  relativePath: string;
  kind: "file" | "dir";
}

/** A listing of a vault directory. */
export interface VaultDirResult {
  type: "dir";
  relativePath: string;
  entries: VaultDirEntry[];
}

export type VaultReadResult = VaultFileResult | VaultDirResult;

/**
 * Resolve & confine a vault-relative request path to an absolute path that
 * provably lives inside the vault root. Throws `VaultConfinementError` otherwise.
 *
 * Defense layers (all enforced):
 *   1. Reject absolute request paths outright (a vault read is always relative).
 *   2. normalize() + join under the root, then verify the lexical result is still
 *      under the root (`relative(root, target)` must not start with `..`).
 *   3. realpath() the target (and root) and re-verify containment — defeats a
 *      symlink inside the vault that points outside it.
 */
export function confineToVault(vaultRoot: string, requestPath: string): string {
  const rootReal = realpathSync(vaultRoot);

  const raw = (requestPath ?? "").trim();
  // Treat "", "/", "." and "./" as the vault root itself.
  const rel = raw === "" || raw === "/" || raw === "." ? "" : raw;

  // 1. An absolute request path is never allowed (it ignores the vault root).
  if (isAbsolute(rel)) {
    throw new VaultConfinementError(`absolute paths are not allowed: ${requestPath}`);
  }

  // 2. Lexical containment check against the root.
  const normalized = normalize(rel);
  const target = resolve(rootReal, normalized);
  const lexicalRel = relative(rootReal, target);
  if (lexicalRel === ".." || lexicalRel.startsWith(".." + sep) || isAbsolute(lexicalRel)) {
    throw new VaultConfinementError(`path escapes the vault: ${requestPath}`);
  }

  // 3. Real-path containment check (symlink-safe). The target may not exist yet
  //    for a read of a missing file — in that case fall back to the lexical check
  //    above (already passed). When it exists, its REAL path must be under the
  //    vault's REAL root.
  let targetReal: string;
  try {
    targetReal = realpathSync(target);
  } catch {
    return target; // does not exist; lexical confinement already guaranteed it.
  }
  const realRel = relative(rootReal, targetReal);
  if (realRel !== "" && (realRel === ".." || realRel.startsWith(".." + sep) || isAbsolute(realRel))) {
    throw new VaultConfinementError(`path resolves outside the vault (symlink?): ${requestPath}`);
  }
  return targetReal;
}

/** POSIX-style relative path (always forward slashes) for the wire. */
function toPosixRel(vaultRoot: string, abs: string): string {
  const rootReal = realpathSync(vaultRoot);
  const rel = relative(rootReal, abs);
  return rel.split(sep).join("/");
}

/**
 * READ a vault path (file → content, directory → listing). Path-confined and
 * read-only. Throws `VaultConfinementError` on any traversal/escape attempt.
 */
export async function readVaultPath(
  vaultRoot: string,
  requestPath: string,
): Promise<VaultReadResult> {
  const abs = confineToVault(vaultRoot, requestPath);
  const info = await stat(abs); // throws ENOENT for a missing path → transport_error

  if (info.isDirectory()) {
    const names = await readdir(abs);
    const entries: VaultDirEntry[] = [];
    for (const name of names.sort()) {
      // Skip Obsidian's internal config dir from the agent-facing listing.
      if (name === ".obsidian" || name === ".trash") continue;
      const childAbs = join(abs, name);
      let kind: "file" | "dir" = "file";
      try {
        kind = (await stat(childAbs)).isDirectory() ? "dir" : "file";
      } catch {
        continue; // unreadable child; omit it.
      }
      entries.push({ name, relativePath: toPosixRel(vaultRoot, childAbs), kind });
    }
    return { type: "dir", relativePath: toPosixRel(vaultRoot, abs), entries };
  }

  const content = await readFile(abs, "utf-8");
  return {
    type: "file",
    relativePath: toPosixRel(vaultRoot, abs),
    content,
    bytes: info.size,
    modifiedAt: info.mtime.toISOString(),
  };
}
