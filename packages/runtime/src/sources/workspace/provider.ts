/**
 * Workspace filesystem provider — the INJECTABLE seam (hermetic tests + live).
 *
 * The workspace is ONE authorized directory. This provider abstracts the path-confined
 * filesystem access (list / read / write) behind one interface so the source/bridge
 * never touch the OS directly. EVERY operation is path-confined to the authorized root
 * via the SAME three-layer defense the Obsidian vault reader uses
 * (`confineToVault` / `readVaultPath` in `../obsidian/vault-reader.ts`):
 *   1. reject absolute request paths,
 *   2. lexical `..`-traversal rejection (normalize + relative-under-root),
 *   3. realpath() re-check to defeat a symlink that points outside the root.
 *
 * TWO IMPLEMENTATIONS:
 *   - {@link RealWorkspaceProvider}: real fs under a configured authorized directory.
 *   - {@link FakeWorkspaceProvider}: a hermetic provider backed by a throwaway temp
 *     directory (real fs confinement, but isolated) for tests + the e2e probe.
 *
 * SELECTION ({@link selectWorkspaceProvider}): real by default; the FAKE when
 * `process.env.PLEXUS_FAKE_WORKSPACE === "1"`, or an explicit provider injected via the
 * source/bridge constructor. So the automated probe NEVER reaches a real user dir.
 */

import { existsSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import {
  confineToVault,
  readVaultPath,
  VaultConfinementError,
  type VaultReadResult,
} from "../obsidian/vault-reader.ts";

/** The result of a confined write. */
export interface WorkspaceWriteResult {
  ok: boolean;
  /** Path relative to the workspace root, POSIX-normalized. */
  relativePath: string;
  /** Bytes written. */
  bytes: number;
}

/** Availability probe result (drives source HEALTH). */
export interface WorkspaceAvailability {
  ok: boolean;
  /** Why unavailable (when `ok:false`) or a resolved note (when `ok:true`). */
  reason?: string;
}

/** A read/list result mirrors the vault reader's projection (file or dir). */
export type WorkspaceReadResult = VaultReadResult;

/** Re-export the confinement error so callers/tests can assert against it. */
export { VaultConfinementError as WorkspaceConfinementError } from "../obsidian/vault-reader.ts";

/**
 * The filesystem-access seam. The source/bridge depend on THIS, never on `fs` directly —
 * so tests inject the fake and the e2e probe stays hermetic. Every method is confined to
 * the authorized root.
 */
export interface WorkspaceProvider {
  /** The absolute authorized directory this provider is confined to. */
  readonly root: string;
  /** Is the authorized directory reachable (exists + is a directory)? Drives health(). */
  available(): Promise<WorkspaceAvailability>;
  /** READ/LIST: list a directory (path = "" ⇒ root) or read a file. Path-confined. */
  read(requestPath: string): Promise<WorkspaceReadResult>;
  /** WRITE: write/overwrite a file under the authorized root. Path-confined. */
  write(requestPath: string, content: string): Promise<WorkspaceWriteResult>;
}

// ──────────────────────────────────────────────────────────────────────────
// REAL provider — confined fs under a configured authorized directory.
// ──────────────────────────────────────────────────────────────────────────

/** Resolve the configured authorized workspace root (env override). */
export function resolveWorkspaceRoot(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit;
  const fromEnv = process.env.PLEXUS_WORKSPACE_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return "";
}

/**
 * REAL provider: confined fs (list/read/write) under one authorized directory. READ/LIST
 * reuse the vault reader's `readVaultPath`; WRITE confines via `confineToVault` THEN
 * `writeFile`. The root comes from the constructor or `PLEXUS_WORKSPACE_DIR`.
 */
export class RealWorkspaceProvider implements WorkspaceProvider {
  readonly root: string;

  constructor(root?: string) {
    this.root = resolveWorkspaceRoot(root);
  }

  async available(): Promise<WorkspaceAvailability> {
    if (!this.root) {
      return { ok: false, reason: "no workspace directory configured (set PLEXUS_WORKSPACE_DIR)" };
    }
    try {
      if (!existsSync(this.root)) {
        return { ok: false, reason: `workspace directory not found: ${this.root}` };
      }
      if (!statSync(this.root).isDirectory()) {
        return { ok: false, reason: `workspace path is not a directory: ${this.root}` };
      }
      return { ok: true, reason: `workspace at ${this.root}` };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `workspace directory unreadable: ${this.root} (${why})` };
    }
  }

  async read(requestPath: string): Promise<WorkspaceReadResult> {
    // readVaultPath confines (confineToVault) then reads/list — throws VaultConfinementError
    // on traversal/absolute/symlink-escape; ENOENT for a genuinely missing in-bounds path.
    return readVaultPath(this.root, requestPath);
  }

  async write(requestPath: string, content: string): Promise<WorkspaceWriteResult> {
    // CONFINE FIRST (reject absolute / `..` / symlink-escape), THEN write. The confined
    // absolute path provably lives under the authorized root.
    const abs = confineToVault(this.root, requestPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
    const bytes = statSync(abs).size;
    // Derive the POSIX workspace-relative path for the wire (symlink-safe).
    const rootReal = realpathSync(this.root);
    const rel = relative(rootReal, abs).split(sep).join("/");
    return { ok: true, relativePath: rel, bytes };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// FAKE provider — temp-dir backed (real confinement, isolated) for tests/probe.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Hermetic fake: a throwaway temp directory as the authorized root. Confinement is REAL
 * (it delegates to the same confined fs ops), but nothing touches a user dir. Seed files
 * may be supplied; otherwise the dir starts empty. `available()` is always ok.
 */
export class FakeWorkspaceProvider implements WorkspaceProvider {
  readonly root: string;
  private readonly real: RealWorkspaceProvider;

  constructor(opts?: { root?: string }) {
    this.root = opts?.root ?? mkdtempSync(join(tmpdir(), "plexus-workspace-fake-"));
    this.real = new RealWorkspaceProvider(this.root);
  }

  async available(): Promise<WorkspaceAvailability> {
    return { ok: true, reason: `fake workspace provider (temp dir ${this.root})` };
  }

  read(requestPath: string): Promise<WorkspaceReadResult> {
    return this.real.read(requestPath);
  }

  write(requestPath: string, content: string): Promise<WorkspaceWriteResult> {
    return this.real.write(requestPath, content);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Selection.
// ──────────────────────────────────────────────────────────────────────────

/** True when the fake provider is forced via the env switch. */
export function fakeWorkspaceForced(): boolean {
  return process.env.PLEXUS_FAKE_WORKSPACE === "1";
}

/**
 * Pick the provider: an explicitly injected one wins; else the FAKE when
 * `PLEXUS_FAKE_WORKSPACE=1`; else the REAL confined-fs provider (root from
 * `PLEXUS_WORKSPACE_DIR` or the constructor). Keeps the automated probe hermetic.
 */
export function selectWorkspaceProvider(injected?: WorkspaceProvider): WorkspaceProvider {
  if (injected) return injected;
  if (fakeWorkspaceForced()) return new FakeWorkspaceProvider();
  return new RealWorkspaceProvider();
}
