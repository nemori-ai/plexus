/**
 * Workspace-dir — "expose a directory" MANIFEST BUILDER (managed multi-instance).
 *
 * The `workspace-dir` kind is the managed counterpart of the compile-time `workspace`
 * singleton: `workspaceDirExtension(root, sourceId, label?)` turns ONE authorized
 * directory + a user-chosen source id into an `ExtensionManifest` (list/read/write +
 * the how-to-use skill) plus the in-process handlers that drive a path-confined
 * `RealWorkspaceProvider(root)` — the SAME three-layer confinement (absolute reject,
 * lexical `..` reject, realpath re-check) the singleton and the Obsidian vault reader
 * use. Mirrors `openVaultExtension` (sources/obsidian/open-vault.ts).
 *
 * KEY DIFFERENCE from the obsidian-fs handler: the handlers here are CLOSED OVER the
 * configured root (one provider per instance), not global functions reading the entry
 * route — so two instances registered side-by-side each confine to their OWN root and
 * can never serve each other's filesystem.
 *
 * The entry set is derived from the SAME parameterized builders the singleton uses
 * (`workspaceEntries(sourceId)`), so ids (`<sourceId>.list|read|write|how-to-use`),
 * `extras.route.op`, and the skill back-link are all re-keyed per instance.
 */

import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

import type {
  CapabilityEntry,
  ExtensionCapabilityDecl,
  ExtensionManifest,
  SourceHealth,
  SourceId,
} from "@plexus/protocol";
import type { ExtensionHandler } from "../extension.ts";
import { MODULES } from "../index.ts";
import {
  workspaceEntries,
  WORKSPACE_VERB_HOW_TO_USE,
  WORKSPACE_VERB_LIST,
  WORKSPACE_VERB_READ,
  WORKSPACE_VERB_WRITE,
} from "./entries.ts";
import { RealWorkspaceProvider, type WorkspaceProvider } from "./provider.ts";
import { wsList, wsRead, wsWrite } from "./ops.ts";

/** The managed kind name. Deliberately NOT `workspace` (a reserved first-party id). */
export const WORKSPACE_DIR_KIND = "workspace-dir" as const;

/**
 * The in-process first-party ids that self-register without a compile-time MODULE
 * (obsidian/mock) — mirrors the literals `capability-registry.RESERVED_SOURCE_IDS` folds
 * in alongside the MODULES ids. Kept here so the reservation check can read the id set
 * LAZILY (inside the guard, at registration time) without importing capability-registry —
 * which would form an eager init cycle (capability-registry builds RESERVED_SOURCE_IDS
 * from MODULES at module load, and this module is in the MODULES import chain).
 */
const EXTRA_RESERVED_IN_PROCESS_IDS: ReadonlySet<string> = new Set(["obsidian", "mock"]);

/**
 * Is `id` a reserved FIRST-PARTY source id (any compile-time MODULE, or an in-process
 * first-party id)? Reads `MODULES` LAZILY at CALL time (never at module init), so the
 * `sources/index → open-dir → sources/index` re-export cycle never touches `MODULES`
 * before it is assigned. Identical membership to `capability-registry.RESERVED_SOURCE_IDS`.
 */
function isReservedSourceId(id: string): boolean {
  return EXTRA_RESERVED_IN_PROCESS_IDS.has(id) || MODULES.some((m) => m.id === id);
}

/**
 * Normalize a configured directory root to a STABLE ABSOLUTE path (P1 — security
 * boundary). Expands a leading `~` / `~/` to the home dir, then REQUIRES the result to
 * be absolute — a relative path is rejected, never silently resolved against the process
 * cwd (which would confine to a different directory after a restart, or land under the
 * gateway's cwd). Deterministic + cwd-independent, so the persisted `route.path` confines
 * to the SAME directory on every boot. The single choke point every workspace-dir
 * registration path (kind adapter, demo endpoint, CLI) funnels through.
 */
export function normalizeWorkspaceDirRoot(root: string): string {
  const raw = typeof root === "string" ? root.trim() : "";
  if (!raw) {
    throw new Error("workspace-dir: `route.path` (the authorized directory) is required");
  }
  const expanded =
    raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) {
    throw new Error(
      `workspace-dir: \`route.path\` must be an ABSOLUTE path (got "${root}") — a relative path would confine to the process working directory, which is unsafe and unstable across restarts`,
    );
  }
  return normalize(expanded);
}

/**
 * Build the in-process handlers for one instance, CLOSED OVER its provider. Keyed by
 * DECLARATION NAME (`list`/`read`/`write`) — the extension materializer binds each to
 * its entry, so the handler map of instance A is never consulted for instance B. The op
 * bodies are the SHARED `ops.ts` core (identical to the singleton bridge — no drift).
 */
export function workspaceDirHandlers(
  provider: WorkspaceProvider,
): Record<string, ExtensionHandler> {
  return {
    [WORKSPACE_VERB_LIST]: (_entry, input) => wsList(provider, input),
    [WORKSPACE_VERB_READ]: (_entry, input) => wsRead(provider, input),
    [WORKSPACE_VERB_WRITE]: (_entry, input) => wsWrite(provider, input),
  };
}

/** Project a parameterized workspace entry into an `ExtensionCapabilityDecl`. */
function entryToDecl(entry: CapabilityEntry, sourceId: SourceId, root: string): ExtensionCapabilityDecl {
  const name = entry.id.slice(sourceId.length + 1);
  const decl: ExtensionCapabilityDecl = {
    name,
    kind: entry.kind,
    label: entry.label,
    describe: entry.describe,
    grants: entry.grants,
    transport: entry.transport as ExtensionCapabilityDecl["transport"],
  };
  if (entry.io) decl.io = entry.io;
  if (entry.body) decl.body = entry.body;
  if (entry.kind === "capability") {
    // route is read ONLY by the handler/bridge + the structural liveness probe:
    //   - `path` confines every op (and drives the health stat below);
    //   - `op` mirrors the singleton's per-instance op key;
    //   - `workspaceDir` is the explicit structural marker for `manifestWorkspaceDirLiveness`
    //     (no name-based guessing, zero false positives on foreign extensions);
    //   - `attachSkills` links the bundled usage skill to this capability.
    const op = (entry.extras?.route as { op?: string } | undefined)?.op ?? `${sourceId}.${name}`;
    decl.route = { path: root, op, workspaceDir: true, attachSkills: [WORKSPACE_VERB_HOW_TO_USE] };
  }
  return decl;
}

/**
 * Build the `ExtensionManifest` for exposing one directory under a managed source id.
 * The `root` is baked into each capability's `route.path` (read by the liveness probe;
 * the handlers are closed over the provider, not the route).
 */
export function workspaceDirManifest(
  root: string,
  sourceId: SourceId,
  label?: string,
): ExtensionManifest {
  if (!sourceId) {
    throw new Error("workspace-dir: source id is required");
  }
  // FIRST-PARTY IMPERSONATION GUARD (S1). A managed workspace-dir registers with
  // `trusted:true`, which BYPASSES the wire-register first-party-id reservation in
  // `capability-registry.registerExtension`. So this builder is the ONLY gate: reject
  // the ENTIRE reserved set (the compile-time MODULES + obsidian/mock), not just
  // `workspace`. Otherwise `--id obsidian` / `--id apple-calendar` / `--id codex` would
  // register a user folder under a reserved id — misclassified as FIRST-PARTY by
  // `provenanceFor` (reads auto-allow, "first-party trust" on the approval card), and for
  // an id that is an ACTIVE module a `trusted` re-register would HOT-SWAP the real
  // first-party source. A managed instance MUST use its own, non-reserved id.
  if (isReservedSourceId(sourceId)) {
    throw new Error(
      `workspace-dir: source id "${sourceId}" is a reserved first-party id and cannot be used for a managed directory source — choose a different id`,
    );
  }
  // Normalize to a stable ABSOLUTE root (expands ~, rejects relative/empty). An empty
  // root must NEVER fall back to the singleton's PLEXUS_WORKSPACE_DIR — a managed
  // instance confines to ITS configured root only.
  const absRoot = normalizeWorkspaceDirRoot(root);
  const entries = workspaceEntries(sourceId, label);
  return {
    manifest: "plexus-extension/0.1",
    source: sourceId,
    label: label || `Workspace (${sourceId})`,
    // Served by in-process, path-confined fs handlers — same "ipc" labeling as the
    // singleton and the obsidian-fs vault (the bridge runs the handler directly).
    transport: "ipc",
    capabilities: entries.map((e) => entryToDecl(e, sourceId, absRoot)),
  };
}

/**
 * LIVENESS probe for a workspace-dir root (HEALTH, not a registration gate). Mirrors
 * `vaultPathHealth`: a missing/unmounted directory registers fine but shows
 * `unavailable` with a precise reason. Delegates to the provider's `available()`
 * (exists + is-a-directory, never throws).
 */
export async function workspaceDirHealth(root: string): Promise<SourceHealth> {
  if (!root) {
    // Never let an empty root fall back to the env-driven singleton root.
    return { status: "unavailable", detail: "no directory configured (route.path)" };
  }
  const a = await new RealWorkspaceProvider(root).available();
  return a.ok ? { status: "ok" } : { status: "unavailable", ...(a.reason ? { detail: a.reason } : {}) };
}

/**
 * If `manifest` is a workspace-dir manifest, return a liveness HEALTH probe for its
 * root; else `undefined` (the generic ExtensionSource falls back to its default
 * derivation). Recognized STRUCTURALLY by the explicit `route.workspaceDir` marker +
 * a string `route.path` — never by source id, so a re-id'd instance is still probed.
 */
export function manifestWorkspaceDirLiveness(
  manifest: ExtensionManifest,
): (() => Promise<SourceHealth>) | undefined {
  const marked = manifest.capabilities?.find((d) => {
    const route = d.route as { workspaceDir?: unknown; path?: unknown } | undefined;
    return d.transport === "ipc" && route?.workspaceDir === true && typeof route?.path === "string";
  });
  const root = (marked?.route as { path?: string } | undefined)?.path;
  if (typeof root !== "string") return undefined;
  return () => workspaceDirHealth(root);
}
