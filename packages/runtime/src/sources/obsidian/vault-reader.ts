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
 *   - READ-ONLY: this module exposes only `read` + `list` + `search`. There is
 *     no write, rename, delete, or execute path at all.
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

/**
 * PURE lexical path-confinement (no filesystem) — the SHARED traversal-rejecting
 * normalize that both `confineToVault` (below) and the scope-constraint enforcer
 * (`src/core/constraint.ts`, AUTHZ-UX §3) build on, so confinement logic lives in
 * ONE place rather than a naive `startsWith`.
 *
 * Treats `requestPath` as a root-relative path and returns its POSIX-normalized,
 * root-relative form (forward slashes, no leading "./"). Returns `undefined` (DENY)
 * when the path is absolute or escapes the root via `..` — fail-closed.
 *
 *   lexicalConfine("a/b/../c")     → "a/c"
 *   lexicalConfine("")             → ""        (the root itself)
 *   lexicalConfine("../x")         → undefined (escapes)
 *   lexicalConfine("/etc/passwd")  → undefined (absolute)
 */
export function lexicalConfine(requestPath: string): string | undefined {
  const raw = (requestPath ?? "").trim();
  // Treat "", "/", "." and "./" as the root itself.
  const rel = raw === "" || raw === "/" || raw === "." || raw === "./" ? "" : raw;
  // An absolute request path is never allowed (it ignores the root).
  if (isAbsolute(rel)) return undefined;
  // Normalize lexically against a virtual root, then verify containment.
  const normalized = normalize(rel);
  const target = resolve(sep, normalized); // resolve under a virtual absolute root
  const lexicalRel = relative(sep, target);
  if (lexicalRel === ".." || lexicalRel.startsWith(".." + sep) || isAbsolute(lexicalRel)) {
    return undefined;
  }
  // POSIX-ize for stable prefix comparison.
  return lexicalRel.split(sep).join("/");
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

// ── SEARCH (read-only, path-confined) ────────────────────────────────────────────

/** One search hit: the matched note + a short snippet around the first match. */
export interface VaultSearchHit {
  /** Vault-relative POSIX path of the matched note. Never an absolute path. */
  relativePath: string;
  /** 1-based line number of the first content match; 0 for a path-only match. */
  line: number;
  /** A short excerpt around the first match (trimmed to SNIPPET_MAX chars). */
  snippet: string;
}

/** The result of a vault search. */
export interface VaultSearchResult {
  type: "search";
  query: string;
  hits: VaultSearchHit[];
  /** True when the hit cap was reached — more matches may exist beyond `hits`. */
  truncated: boolean;
}

/** Default / maximum number of hits a single search returns. */
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;
/** Files larger than this are skipped (huge exports, embedded blobs). */
const SEARCH_MAX_FILE_BYTES = 1_000_000;
/** Max snippet length returned per hit. */
const SNIPPET_MAX = 200;

/** Clamp a requested limit into [1, SEARCH_MAX_LIMIT]; default when absent/invalid. */
export function clampSearchLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : SEARCH_DEFAULT_LIMIT;
  return Math.min(SEARCH_MAX_LIMIT, Math.max(1, n));
}

/** Build a short one-line snippet around the first occurrence of `query` (ci). */
function snippetAround(content: string, index: number, queryLen: number): string {
  // Expand to the enclosing line, then trim around the match if the line is huge.
  const lineStart = content.lastIndexOf("\n", index) + 1;
  const lineEndRaw = content.indexOf("\n", index + queryLen);
  const lineEnd = lineEndRaw === -1 ? content.length : lineEndRaw;
  const line = content.slice(lineStart, lineEnd);
  if (line.length <= SNIPPET_MAX) return line.trim();
  const inLine = index - lineStart;
  const half = Math.floor((SNIPPET_MAX - queryLen) / 2);
  const from = Math.max(0, inLine - half);
  const to = Math.min(line.length, inLine + queryLen + half);
  return `${from > 0 ? "…" : ""}${line.slice(from, to).trim()}${to < line.length ? "…" : ""}`;
}

/**
 * SEARCH the vault's `.md` notes for a case-insensitive substring — read-only and
 * PATH-CONFINED like every other vault access:
 *
 *   - The walk starts at the (realpath'd) vault root and every entry is re-confined
 *     via `confineToVault` — a symlink pointing OUTSIDE the vault is skipped, never
 *     followed, so a search can never read or leak content beyond the vault root.
 *   - Only `.md` files are scanned; files over ~1 MB and binary-looking content
 *     (NUL byte) are skipped.
 *   - Matches on the note PATH (e.g. the note title) or its content. Hits carry the
 *     vault-relative path + a short snippet around the first content match.
 *   - Hit count is capped (`limit`, default 20, max 100) — `truncated` says whether
 *     the cap cut the result short.
 */
export async function searchVault(
  vaultRoot: string,
  query: string,
  opts: { limit?: number } = {},
): Promise<VaultSearchResult> {
  const q = (query ?? "").trim();
  if (!q) return { type: "search", query: q, hits: [], truncated: false };
  const needle = q.toLowerCase();
  const limit = clampSearchLimit(opts.limit);

  const hits: VaultSearchHit[] = [];
  let truncated = false;

  /** Depth-first walk; returns false when the hit cap stops the search. */
  const walk = async (relDir: string): Promise<boolean> => {
    let abs: string;
    try {
      abs = confineToVault(vaultRoot, relDir); // re-confine EVERY level (symlink-safe)
    } catch {
      return true; // escapes the vault → skip, never follow
    }
    let names: string[];
    try {
      names = (await readdir(abs)).sort();
    } catch {
      return true; // unreadable dir; skip
    }
    for (const name of names) {
      if (name === ".obsidian" || name === ".trash") continue;
      const rel = relDir === "" ? name : `${relDir}/${name}`;
      let childAbs: string;
      try {
        childAbs = confineToVault(vaultRoot, rel); // reject symlinks that point out
      } catch {
        continue;
      }
      let info;
      try {
        info = await stat(childAbs);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (!(await walk(rel))) return false;
        continue;
      }
      if (!name.toLowerCase().endsWith(".md")) continue;
      if (info.size > SEARCH_MAX_FILE_BYTES) continue; // huge file — skip

      const pathMatch = rel.toLowerCase().includes(needle);
      let contentIndex = -1;
      let content = "";
      try {
        content = await readFile(childAbs, "utf-8");
      } catch {
        continue;
      }
      if (content.includes("\u0000")) continue; // binary-looking (NUL byte) - skip
      contentIndex = content.toLowerCase().indexOf(needle);
      if (!pathMatch && contentIndex === -1) continue;

      const hit: VaultSearchHit =
        contentIndex >= 0
          ? {
              relativePath: rel,
              line: content.slice(0, contentIndex).split("\n").length,
              snippet: snippetAround(content, contentIndex, needle.length),
            }
          : { relativePath: rel, line: 0, snippet: content.split("\n", 1)[0]?.trim().slice(0, SNIPPET_MAX) ?? "" };
      hits.push(hit);
      if (hits.length >= limit) {
        truncated = true;
        return false;
      }
    }
    return true;
  };

  await walk("");
  return { type: "search", query: q, hits, truncated };
}
