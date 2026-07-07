/**
 * Managed sources — KIND ADAPTER registry (Task 0).
 *
 * `SOURCE_KINDS` is the single, registry-style table that interprets a
 * `ConfiguredSource.kind` (mirrors the `MODULES` discipline: no `if (kind === …)`
 * branching anywhere else). Each adapter PROJECTS a `ConfiguredSource` into a frozen
 * `ExtensionManifest` (+ optional trusted in-process handlers) by REUSING the
 * existing Obsidian manifest builders verbatim (DESIGN §1.3):
 *
 *   - `obsidian-rest` → `openVaultRestManifest({ baseUrl, secretName: secretRef })`
 *   - `obsidian-fs`   → `openVaultExtension(vaultPath)` (manifest + vaultRead handler)
 *
 * The config layer just feeds these builders persisted route data instead of CLI
 * flags. ZERO change to the Obsidian builders. The optional `detector` hook is left
 * unimplemented — Task 4 wires detectors here.
 */

import type { ExtensionManifest } from "@plexus/protocol";
import type { ExtensionHandler } from "../extension.ts";
import {
  openVaultExtension,
  VAULT_READ_NAME,
  vaultReadHandler,
} from "../obsidian/open-vault.ts";
import {
  openVaultRestManifest,
  DEFAULT_OBSIDIAN_REST_URL,
} from "../obsidian/open-vault-rest.ts";
import {
  workspaceDirManifest,
  workspaceDirHandlers,
  normalizeWorkspaceDirRoot,
  WORKSPACE_DIR_KIND,
} from "../workspace/open-dir.ts";
import { RealWorkspaceProvider } from "../workspace/provider.ts";
import { obsidianRestDetector, registerKindAdaptersForDetect } from "./detect.ts";
import type { ConfiguredSource, SourceKindAdapter } from "./types.ts";

/**
 * `obsidian-rest` — read-write Obsidian Local REST API over loopback HTTPS. Pure
 * `local-rest` transport (no in-process handlers). The Bearer key is referenced by
 * NAME (`secretRef`); its value lives in `~/.plexus/secrets/<name>`.
 */
export const obsidianRestKind: SourceKindAdapter = {
  kind: "obsidian-rest",
  toManifest(cfg: ConfiguredSource): ExtensionManifest {
    const baseUrl =
      (typeof cfg.route?.baseUrl === "string" && cfg.route.baseUrl) || DEFAULT_OBSIDIAN_REST_URL;
    // Reuse the EXISTING builder verbatim; secretRef projected by NAME only.
    const manifest = openVaultRestManifest({
      baseUrl,
      ...(cfg.secretRef ? { secretName: cfg.secretRef } : {}),
    });
    // Honor the configured source id + label so the managed path and the (Task 1) flag
    // path project to IDENTICAL sources for the default id, and a relabeled/re-id'd
    // managed source surfaces consistently. Capability ids derive from `source`, so an
    // id override re-keys the capabilities (e.g. a second REST vault under a new id).
    return overrideIdentity(manifest, cfg);
  },
  // No in-process handlers — every capability routes through the local-rest transport.
  // Task 4: contribute the reachability-only Obsidian Local REST detector. The hook
  // is auto-collected into `DETECTORS` (detect.ts) — no core branching.
  //
  // LAZY by getter to break the `kinds.ts ⇄ detect.ts` import cycle: `manage.ts`
  // imports `detect.ts` before `kinds.ts`, so reading `obsidianRestDetector` eagerly
  // at object-literal init lands in its temporal dead zone. A getter defers the read
  // until first detect, by which point both modules are fully initialized.
  get detector() {
    return obsidianRestDetector;
  },
  // UI catalog descriptor — drives the dynamic "Add Obsidian (REST)" form. Pure
  // advisory: the apiKey field is `target:"secret"` (written write-only, referenced
  // by NAME), baseUrl is `target:"route"`, label is `target:"label"`.
  descriptor: {
    kind: "obsidian-rest",
    label: "Obsidian — Local REST API",
    blurb: "Your Obsidian vault via the Local REST API plugin",
    provenanceClass: "managed",
    transport: "local-rest",
    detectable: true,
    wireable: true,
    exposesSummary: "read · list · write notes",
    fields: [
      {
        name: "label",
        label: "Label",
        type: "text",
        required: false,
        default: "Obsidian",
        placeholder: "Obsidian",
        target: "label",
      },
      {
        name: "baseUrl",
        label: "Base URL",
        type: "url",
        required: false,
        default: DEFAULT_OBSIDIAN_REST_URL,
        placeholder: DEFAULT_OBSIDIAN_REST_URL,
        help: "The loopback HTTPS address the Local REST API plugin listens on.",
        target: "route",
      },
      {
        name: "apiKey",
        label: "API key",
        type: "password",
        required: true,
        placeholder: "paste the Local REST API key",
        help: "Stored write-only in the local secret store and referenced by name.",
        target: "secret",
      },
    ],
  },
};

/**
 * `obsidian-fs` — read-only, path-confined direct filesystem read of a vault folder.
 * Trusted in-process handler (the vault read) bound by declaration name.
 */
export const obsidianFsKind: SourceKindAdapter = {
  kind: "obsidian-fs",
  toManifest(cfg: ConfiguredSource): ExtensionManifest {
    const vaultPath = typeof cfg.route?.vaultPath === "string" ? cfg.route.vaultPath : "";
    const { manifest } = openVaultExtension(vaultPath);
    return overrideIdentity(manifest, cfg);
  },
  handlers(_cfg: ConfiguredSource): Record<string, ExtensionHandler> {
    // The path-confined fs read handler (the trusted in-process path).
    return { [VAULT_READ_NAME]: vaultReadHandler };
  },
  // UI catalog descriptor — drives the dynamic "Add Obsidian (folder)" form. Read-only
  // direct filesystem read; no secret (no apiKey field). Not detectable (the user must
  // point at a folder), so the catalog offers a plain "Add…".
  descriptor: {
    kind: "obsidian-fs",
    label: "Obsidian — vault folder (read-only)",
    blurb: "An Obsidian vault folder on disk (read-only)",
    provenanceClass: "managed",
    transport: "ipc",
    detectable: false,
    wireable: true,
    exposesSummary: "read notes",
    fields: [
      {
        name: "label",
        label: "Label",
        type: "text",
        required: false,
        default: "Obsidian (folder)",
        placeholder: "Obsidian (folder)",
        target: "label",
      },
      {
        name: "vaultPath",
        label: "Vault folder",
        type: "path",
        required: true,
        placeholder: "/path/to/your/vault",
        help: "An absolute path to the vault folder on disk. Reads are path-confined to it.",
        target: "route",
      },
    ],
  },
};

/**
 * `workspace-dir` — a MANAGED directory source (read/list/write, path-confined) — the
 * managed multi-instance counterpart of the compile-time `workspace` singleton. Two
 * instances under different ids + different `route.path` roots expose two independent
 * capability sets (`<id>.list|read|write`), each confined to its OWN root.
 *
 * Kind name is deliberately `workspace-dir` (NOT the reserved id `workspace`): the
 * env-driven singleton keeps its compile-time registration; managed instances use
 * their own ids (the manifest builder rejects the reserved id).
 *
 * HANDLERS ARE PER-CONFIG CLOSURES: `handlers(cfg)` builds a fresh provider over
 * `cfg.route.path` — never a global function, never the env-selected root — so a
 * second instance's handler can never serve the first instance's directory.
 */
export const workspaceDirKind: SourceKindAdapter = {
  kind: WORKSPACE_DIR_KIND,
  toManifest(cfg: ConfiguredSource): ExtensionManifest {
    const path = typeof cfg.route?.path === "string" ? cfg.route.path : "";
    // The builder bakes identity (id + label) directly — throws on a missing path or
    // the reserved id, which `manage.ts` surfaces as a clean `materialize failed`.
    return workspaceDirManifest(path, cfg.id, cfg.label);
  },
  handlers(cfg: ConfiguredSource): Record<string, ExtensionHandler> {
    const path = typeof cfg.route?.path === "string" ? cfg.route.path : "";
    // Normalize IDENTICALLY to `toManifest` (expand ~, require absolute) so the provider
    // confines to the SAME directory the manifest's `route.path` advertises for health.
    const absRoot = normalizeWorkspaceDirRoot(path);
    // Closed over THIS config's root (see the adapter doc above).
    return workspaceDirHandlers(new RealWorkspaceProvider(absRoot));
  },
  // UI catalog descriptor — drives the dynamic "Add folder" form. The `path` field is
  // `target:"route"`, so the existing data-driven ConnectorForm renders it with zero
  // UI changes. Not detectable (the user must point at a folder).
  descriptor: {
    kind: WORKSPACE_DIR_KIND,
    label: "Folder — workspace directory",
    blurb: "A folder on this machine, exposed as a path-confined read/list/write surface",
    provenanceClass: "managed",
    transport: "ipc",
    detectable: false,
    wireable: true,
    exposesSummary: "list · read · write files (path-confined)",
    fields: [
      {
        name: "label",
        label: "Label",
        type: "text",
        required: false,
        default: "Folder",
        placeholder: "Project notes",
        target: "label",
      },
      {
        name: "path",
        label: "Folder",
        type: "path",
        required: true,
        placeholder: "/path/to/the/folder",
        help: "An absolute path on this machine. Every list/read/write is confined to it.",
        target: "route",
      },
    ],
  },
};

/**
 * The compile-time kind registry. A new source kind ships its adapter and is added
 * here — no core branching (same discipline as `MODULES`). Tasks 4/5 extend this
 * (detector hooks / parity tweaks) AFTER Task 0.
 */
export const SOURCE_KINDS: SourceKindAdapter[] = [obsidianRestKind, obsidianFsKind, workspaceDirKind];

// Task 4: register the kind adapters with the detect framework (one-directional
// `kinds.ts` → `detect.ts`) so `collectDetectors()` picks up each adapter's optional
// `detector` hook without `detect.ts` ever importing this module (avoids a cycle).
registerKindAdaptersForDetect(SOURCE_KINDS);

/** Resolve a kind adapter by `kind`; `undefined` for an unknown kind. */
export function resolveKind(kind: string): SourceKindAdapter | undefined {
  return SOURCE_KINDS.find((k) => k.kind === kind);
}

/**
 * Project a configured source's IDENTITY (id + label) onto the builder-produced
 * manifest WITHOUT touching its security surface (transport / route / secrets /
 * capability shape stay exactly as the unchanged Obsidian builders emit them). The
 * default-id/default-label case returns the manifest verbatim — so the managed path
 * and the flag path (Task 1) materialize to IDENTICAL sources — and a re-id'd /
 * relabeled managed source carries its chosen identity. Zero change to the builders.
 */
function overrideIdentity(manifest: ExtensionManifest, cfg: ConfiguredSource): ExtensionManifest {
  const idChanged = Boolean(cfg.id) && cfg.id !== manifest.source;
  const labelChanged = Boolean(cfg.label) && cfg.label !== manifest.label;
  if (!idChanged && !labelChanged) return manifest;
  return {
    ...manifest,
    ...(idChanged ? { source: cfg.id } : {}),
    ...(labelChanged ? { label: cfg.label } : {}),
  };
}
