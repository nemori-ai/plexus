/**
 * Managed capability-sources — CONFIG LAYER types (Task 0, "the seam").
 *
 * These types are the PERSISTENCE / MANAGEMENT model for capability sources. They
 * are deliberately SEPARATE from the frozen wire `ExtensionManifest` in
 * `protocol/types.ts` (which is NOT touched). A `ConfiguredSource` is inert data
 * (persisted in `~/.plexus/sources.json`); a `SourceKindAdapter` PROJECTS it into a
 * frozen `ExtensionManifest` (+ optional trusted in-process handlers) that the
 * existing `registerExtension` already accepts (DESIGN §1.2–§1.4).
 *
 * Security invariant carried in the shape: `secretRef` is a NAME only — never a
 * secret VALUE. The value lives in `~/.plexus/secrets/<name>`, resolved by the
 * transport at dispatch. `sources.json` contains no secret values.
 *
 * All additive: zero frozen-type edits.
 */

import type {
  ExtensionManifest,
  SourceId,
  TransportKind,
} from "@plexus/protocol";
import type { ExtensionHandler } from "../extension.ts";
import type { ConnectorDescriptor } from "./connector-descriptor.ts";

/**
 * Which materializer turns a `ConfiguredSource` → an `ExtensionManifest`. The
 * first-party kinds ship adapters in `kinds.ts`; the open string keeps the kind
 * registry pluggable (same discipline as `MODULES`).
 */
export type ConfiguredSourceKind = "obsidian-rest" | "obsidian-fs" | (string & {});

/**
 * A persisted, managed capability source. The unit the `ManagedSources` service
 * adds/removes/enables/disables/reconfigures and the unit `sources.json` stores.
 */
export interface ConfiguredSource {
  /** SourceId — the registry id AND the materialized extension's source id. */
  id: SourceId;
  /** Which `SourceKindAdapter` turns this config → an `ExtensionManifest`. */
  kind: ConfiguredSourceKind;
  /** Human label (UI/CLI). */
  label: string;
  /** Disabled ⇒ persisted but NOT registered into the live registry (skipped at boot). */
  enabled: boolean;
  /** Mirrors the resulting manifest transport (informational + UI). Never "mcp". */
  transport: Exclude<TransportKind, "mcp">;
  /** Kind-specific, NON-SECRET route config (baseUrl, vaultPath, …). */
  route?: {
    /** Loopback HTTPS base URL for `local-rest` kinds (e.g. obsidian-rest). */
    baseUrl?: string;
    /** Path-confined filesystem root for fs kinds (e.g. obsidian-fs). */
    vaultPath?: string;
    /** Path-confined directory root for the `workspace-dir` kind. */
    path?: string;
    /** Open for kind-specific extras (read only by the owning kind adapter). */
    [k: string]: unknown;
  };
  /** NAME of a secret under `~/.plexus/secrets/`. NEVER the value. */
  secretRef?: string;
  /**
   * Per-instance APPROVAL POSTURE (default `"auto"` = today's behavior).
   *   - `"auto"`: reads on this (managed) source auto-allow; write/exec still pend.
   *   - `"ask"`:  EVERY verb on this source PENDS for the owner on first use
   *     (extension-posture parity) — the owner picks a trust window on the approval
   *     card exactly like any other pend. STRICTLY TIGHTENING: "ask" can only turn
   *     an auto-allow into a pend; it never relaxes any existing check.
   */
  approval?: "auto" | "ask";
  /** Free-form provenance / UI hints; never load-bearing for security. */
  metadata?: Record<string, unknown>;
}

/** The on-disk `~/.plexus/sources.json` document (versioned list). */
export interface SourcesConfigFile {
  version: 1;
  sources: ConfiguredSource[];
}

/**
 * Adapter that interprets a `kind`. The SINGLE place a kind is interpreted (no
 * `if (kind === …)` branching elsewhere — same registry discipline as `MODULES`).
 * It projects a `ConfiguredSource` into the inputs `registerExtension` accepts.
 */
export interface SourceKindAdapter {
  kind: ConfiguredSourceKind;
  /** Build the wire manifest from persisted config (secretRef projected by NAME). */
  toManifest(cfg: ConfiguredSource): ExtensionManifest;
  /**
   * OPTIONAL: trusted in-process handlers bound by declaration name (e.g. the
   * obsidian-fs path-confined vault read). Absent ⇒ pure transport-backed source.
   */
  handlers?(cfg: ConfiguredSource): Record<string, ExtensionHandler> | undefined;
  /**
   * OPTIONAL (Task 4): contributes a detector to the scan/detect framework. Left
   * as a hook here — Task 0 does NOT implement detectors.
   */
  detector?: unknown;
  /**
   * OPTIONAL: the UI-facing connector catalog descriptor (config fields → dynamic
   * form, provenance class, exposes-summary). Populated for the wireable first-party
   * kinds so `GET /admin/api/connectors` can present "what Plexus can connect to".
   * Pure advisory data — no secret values, no security surface.
   */
  descriptor?: ConnectorDescriptor;
}

/** Trust/approval context for a mutating `ManagedSources` call (DESIGN §3/§7). */
export interface ManageOpts {
  /**
   * The trusted local path (admin UI/CLI, connection-key authenticated) and the
   * boot-load path set this; the local user IS the human approver. The agent/wire
   * path leaves it falsy so a write-capable add can pend (Task 2/Task 5 wire pend).
   */
  approvedByHuman?: boolean;
}

/** Result of an add/enable/reconfigure (DESIGN §3). */
export interface AddResult {
  ok: boolean;
  /** The configured source as persisted (desired state). */
  source: ConfiguredSource;
  /** The capability ids that actually registered LIVE. */
  registered: string[];
  /** New manifest revision (agents compare to know to re-fetch). */
  revision: number;
  /** Populated when the operation could not be applied (rejected / rollback). */
  reason?: string;
}
