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

import type {
  CapabilityEntry,
  ExtensionCapabilityDecl,
  ExtensionManifest,
  SourceHealth,
  SourceId,
  TransportResult,
} from "@plexus/protocol";
import type { ExtensionHandler } from "../extension.ts";
import {
  workspaceEntries,
  WORKSPACE_SOURCE_ID,
  WORKSPACE_VERB_HOW_TO_USE,
  WORKSPACE_VERB_LIST,
  WORKSPACE_VERB_READ,
  WORKSPACE_VERB_WRITE,
} from "./entries.ts";
import {
  RealWorkspaceProvider,
  WorkspaceConfinementError,
  type WorkspaceProvider,
} from "./provider.ts";

/** The managed kind name. Deliberately NOT `workspace` (a reserved first-party id). */
export const WORKSPACE_DIR_KIND = "workspace-dir" as const;

/** Map a confinement violation to a transport_error (out-of-dir content never returned). */
function denyConfinement(err: WorkspaceConfinementError): TransportResult {
  return {
    ok: false,
    error: {
      code: "transport_error",
      message: `workspace-dir: path denied (confinement): ${err.message}`,
      detail: { reason: "path_confinement" },
    },
  };
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Build the in-process handlers for one instance, CLOSED OVER its provider. Keyed by
 * DECLARATION NAME (`list`/`read`/`write`) — the extension materializer binds each to
 * its entry, so the handler map of instance A is never consulted for instance B.
 */
export function workspaceDirHandlers(
  provider: WorkspaceProvider,
): Record<string, ExtensionHandler> {
  const list: ExtensionHandler = async (_entry, input) => {
    const path = typeof input.path === "string" ? input.path : "";
    try {
      return { ok: true, data: await provider.read(path) };
    } catch (err) {
      if (err instanceof WorkspaceConfinementError) return denyConfinement(err);
      throw err;
    }
  };
  const read: ExtensionHandler = async (_entry, input) => {
    const path = strOf(input.path);
    if (!path) {
      return { ok: false, error: { code: "schema_validation_failed", message: "`path` is required" } };
    }
    try {
      return { ok: true, data: await provider.read(path) };
    } catch (err) {
      if (err instanceof WorkspaceConfinementError) return denyConfinement(err);
      throw err;
    }
  };
  const write: ExtensionHandler = async (_entry, input) => {
    const path = strOf(input.path);
    if (!path) {
      return { ok: false, error: { code: "schema_validation_failed", message: "`path` is required" } };
    }
    const content = typeof input.content === "string" ? input.content : undefined;
    if (content === undefined) {
      return { ok: false, error: { code: "schema_validation_failed", message: "`content` is required" } };
    }
    try {
      return { ok: true, data: await provider.write(path, content) };
    } catch (err) {
      if (err instanceof WorkspaceConfinementError) return denyConfinement(err);
      throw err;
    }
  };
  return {
    [WORKSPACE_VERB_LIST]: list,
    [WORKSPACE_VERB_READ]: read,
    [WORKSPACE_VERB_WRITE]: write,
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
  if (!sourceId || sourceId === WORKSPACE_SOURCE_ID) {
    // The reserved compile-time singleton keeps its env-driven registration; a managed
    // instance must use its own id (colliding here would shadow/fight the singleton).
    throw new Error(
      `workspace-dir: source id must be set and must not be the reserved "${WORKSPACE_SOURCE_ID}"`,
    );
  }
  if (!root || root.trim().length === 0) {
    // An empty root must NEVER fall back to the singleton's PLEXUS_WORKSPACE_DIR (the
    // provider's env fallback) — a managed instance confines to ITS configured root only.
    throw new Error("workspace-dir: `route.path` (the authorized directory) is required");
  }
  const entries = workspaceEntries(sourceId, label);
  return {
    manifest: "plexus-extension/0.1",
    source: sourceId,
    label: label || `Workspace (${sourceId})`,
    // Served by in-process, path-confined fs handlers — same "ipc" labeling as the
    // singleton and the obsidian-fs vault (the bridge runs the handler directly).
    transport: "ipc",
    capabilities: entries.map((e) => entryToDecl(e, sourceId, root)),
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

/**
 * The full "expose a directory" entrypoint: the manifest + the handler map ready to
 * hand to `capabilities.registerExtension(manifest, { handlers })`. The handlers are
 * closed over a `RealWorkspaceProvider(root)` built HERE — per instance, per root.
 */
export function workspaceDirExtension(
  root: string,
  sourceId: SourceId,
  label?: string,
): { manifest: ExtensionManifest; handlers: Record<string, ExtensionHandler> } {
  const manifest = workspaceDirManifest(root, sourceId, label);
  return { manifest, handlers: workspaceDirHandlers(new RealWorkspaceProvider(root)) };
}
