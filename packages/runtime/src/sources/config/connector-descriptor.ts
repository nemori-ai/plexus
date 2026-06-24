/**
 * Connector catalog — ADMIN-LAYER descriptor types ("怎么接" / how Plexus connects).
 *
 * A `ConnectorDescriptor` is the UI-facing projection of a CONNECTOR (连接器): the
 * TYPE Plexus knows how to talk to. It declares the config fields that drive the
 * dynamic "Add…" form, its provenance class, the resulting transport, and an advisory
 * one-liner of what capabilities it exposes. It is purely DESCRIPTIVE catalog data:
 * it never carries a secret value, never registers anything — it just tells the admin
 * UI what the user CAN connect (managed kinds from `SOURCE_KINDS`) and what Plexus
 * SHIPS with (first-party builtins, `wireable:false`).
 *
 * These types live in the runtime/admin layer (NOT the frozen `@plexus/protocol`):
 * additive, zero frozen-type edits. The descriptor for a managed kind hangs off the
 * optional `SourceKindAdapter.descriptor`; first-party builtins (cc-master) get
 * descriptors derived in the catalog assembler (`catalog.ts`).
 */

/**
 * One input field on a connector's dynamic config form. `target` says WHERE the
 * submitted value lands on the resulting `ConfiguredSource`:
 *   - "label"  → `cfg.label`
 *   - "route"  → `cfg.route[name]` (e.g. baseUrl, vaultPath)
 *   - "secret" → written WRITE-ONLY to the secret store under `name`, then
 *                referenced by `cfg.secretRef = name` (the value never round-trips).
 */
export interface ConnectorConfigField {
  /** Field key — e.g. "baseUrl", "vaultPath", "label", "apiKey". */
  name: string;
  /** Human label rendered above the input. */
  label: string;
  /** Input type — drives the rendered control (password is never echoed back). */
  type: "text" | "password" | "url" | "path";
  /** Whether submit is blocked until this field is non-empty. */
  required: boolean;
  /** Placeholder text for the input. */
  placeholder?: string;
  /** A default the form pre-fills (e.g. the loopback REST URL). */
  default?: string;
  /** One-line guidance shown under the input. */
  help?: string;
  /** Where the value maps on the `ConfiguredSource` (see interface doc). */
  target: "label" | "route" | "secret";
}

/**
 * The UI-facing description of a CONNECTOR (连接器, the TYPE). Drives the connector
 * catalog ("What Plexus can connect to") and, for `wireable` connectors, the dynamic
 * config form. First-party builtins surface as informational entries (`wireable:false`,
 * `fields:[]`).
 */
export interface ConnectorDescriptor {
  /** The connector kind — e.g. "obsidian-rest". For builtins, the first-party source id. */
  kind: string;
  /** Display name — e.g. "Obsidian — Local REST API". */
  label: string;
  /** One-line "what this connects to". */
  blurb: string;
  /** Provenance class inherited connector→source→capability. */
  provenanceClass: "first-party" | "managed" | "extension";
  /** The resulting transport (informational). */
  transport: string;
  /** The fields driving the dynamic form. Empty for non-wireable builtins. */
  fields: ConnectorConfigField[];
  /** Whether a detector exists that can find an instance on this machine. */
  detectable: boolean;
  /** Advisory one-liner of the capabilities it exposes (e.g. "read · list · write notes"). */
  exposesSummary?: string;
  /** Whether the user can create a NEW instance via the form (false for builtins). */
  wireable: boolean;
}
