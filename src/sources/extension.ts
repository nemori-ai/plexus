/**
 * Generic user-EXTENSION source materializer (Flow B — "one sentence → extension").
 *
 * A user extension is declared as an `ExtensionManifest` (a source + the capability
 * / skill / workflow entries it contributes). `materializeExtension()` turns that
 * manifest into a runtime `SourceModule` — IDENTICAL in shape to a compile-time
 * first-party source — so the gateway treats a user extension exactly like any
 * other capability source:
 *
 *   - the lifecycle layer (`ExtensionSource`) `scan()`s the manifest into
 *     `CapabilityEntry[]` (applying the ID-DERIVATION RULE: id = `<sourceSlug>.<name>`),
 *   - the per-session layer (`ExtensionBridge`) `invoke()`s a capability either
 *     through the registered `Transport` for its `transport` kind (cli/local-rest/…)
 *     OR — for entries carrying an in-process handler in `extras.route` (e.g. the
 *     path-confined Obsidian vault read) — by running that handler directly.
 *
 * This is the SOURCE-AGNOSTIC mechanism `CapabilityRegistry.registerExtension`
 * instantiates. The Obsidian concrete flow (`sources/obsidian/`) is just one
 * producer of an `ExtensionManifest` fed through here.
 */

import type {
  BridgeDeps,
  CapabilityBridge,
  CapabilityEntry,
  CapabilityId,
  ExtensionCapabilityDecl,
  ExtensionManifest,
  InvokeContext,
  InvokeRequest,
  InvokeResponse,
  PlatformServices,
  RouteResult,
  SourceId,
  SourceModule,
  SourceRequirementResult,
  TransportResult,
} from "../protocol/index.ts";
import { BaseCapabilitySource, normalizeResult } from "./base.ts";

/** Slugify a SourceId per the ID-DERIVATION RULE (`:` → `.`). */
export function sourceSlug(source: SourceId): string {
  return source.replace(/:/g, ".");
}

// ── §8 manifest validation limits (security review must-fix #5) ──────────────
/** Max serialized size of a whole wire manifest (anti-DoS). */
export const MAX_MANIFEST_BYTES = 256 * 1024; // 256 KiB
/** Max size of a single skill `body.markdown` (anti context-stuffing / DoS). */
export const MAX_SKILL_BODY_BYTES = 64 * 1024; // 64 KiB
/** Max number of capability declarations in one manifest (anti fan-out DoS). */
export const MAX_MANIFEST_CAPABILITIES = 256;

/** Byte length of a string (UTF-8), for size-limit checks. */
function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * VALIDATE-vs-COMMIT SEAM (for m4sec-auth). A PURE predicate over a wire manifest:
 * returns the reasons it would be rejected (empty ⇒ valid). It NEVER mutates the
 * registry and NEVER materializes anything. m4sec-auth calls this to compute the
 * reasons to surface to the user, then commits (via `registerExtension`) only after
 * the user confirms. `registerExtension` ALSO calls it so a direct programmatic
 * register cannot bypass the rules.
 *
 * Rules (all default-deny, reject-don't-skip):
 *  - schema shape: manifest version + a non-empty source.
 *  - size limits: whole manifest, per-skill body markdown, capability count.
 *  - secret refs: `name` must not path-traverse out of `~/.plexus/secrets/`.
 *
 * NOTE: first-party-id reservation and `route.handler` stripping are enforced by
 * `registerExtension`/`materializeExtension` (they depend on trust context / are
 * structural sanitization, not a pure predicate over the wire manifest).
 */
export function validateManifest(manifest: ExtensionManifest): string[] {
  const reasons: string[] = [];

  if (manifest?.manifest !== "plexus-extension/0.1" || !manifest.source) {
    reasons.push(
      "invalid extension manifest (expected manifest 'plexus-extension/0.1' + a source)",
    );
    // Without a well-formed shape the rest of the checks are not meaningful.
    return reasons;
  }

  // Whole-manifest size (anti-DoS / context-stuffing).
  let serialized = "";
  try {
    serialized = JSON.stringify(manifest);
  } catch {
    reasons.push("manifest is not JSON-serializable");
    return reasons;
  }
  if (byteLen(serialized) > MAX_MANIFEST_BYTES) {
    reasons.push(
      `manifest too large (${byteLen(serialized)} bytes > ${MAX_MANIFEST_BYTES} limit)`,
    );
  }

  const caps = manifest.capabilities ?? [];
  if (caps.length > MAX_MANIFEST_CAPABILITIES) {
    reasons.push(
      `manifest declares too many capabilities (${caps.length} > ${MAX_MANIFEST_CAPABILITIES} limit)`,
    );
  }

  // Per-skill body size.
  for (const decl of caps) {
    const md = decl.body?.markdown;
    if (typeof md === "string" && byteLen(md) > MAX_SKILL_BODY_BYTES) {
      reasons.push(
        `skill ${decl.name} body.markdown too large (${byteLen(md)} bytes > ${MAX_SKILL_BODY_BYTES} limit)`,
      );
    }
  }

  // Secret refs must not escape ~/.plexus/secrets/ (path traversal).
  for (const ref of manifest.secrets ?? []) {
    if (!isSafeSecretName(ref.name)) {
      reasons.push(
        `secret ref name "${ref.name}" is unsafe (must be a plain name within ~/.plexus/secrets/, no path traversal)`,
      );
    }
  }

  return reasons;
}

/**
 * A secret ref `name` is safe iff it resolves to a plain file directly under
 * `~/.plexus/secrets/` — no `..`, no absolute path, no path separators, no NUL.
 * Defeats `name: "../../.ssh/id_rsa"` style escapes (security review must-fix #5).
 */
export function isSafeSecretName(name: unknown): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name.includes("\0")) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.includes("..")) return false;
  // Reject any leading dot/whitespace or absolute-looking forms defensively.
  if (name.startsWith(".") || /^[a-zA-Z]:/.test(name)) return false;
  return true;
}

/**
 * Strip any `route.handler` from a wire manifest's declarations (security review
 * lesser-fix / §11 "no function over the wire" by construction). JSON can't encode a
 * function so a genuine wire register can't carry one, but a programmatic caller
 * could — this makes the invariant TRUE BY CONSTRUCTION rather than by JSON's
 * accident. The TRUSTED in-process path (Obsidian) supplies handlers via the
 * `handlers` argument to `materializeExtension`, which is bound AFTER stripping.
 */
export function stripWireHandlers(manifest: ExtensionManifest): ExtensionManifest {
  if (!manifest.capabilities?.some((d) => d.route && "handler" in d.route)) {
    return manifest;
  }
  return {
    ...manifest,
    capabilities: manifest.capabilities.map((decl) => {
      if (!decl.route || !("handler" in decl.route)) return decl;
      const { handler: _dropped, ...safeRoute } = decl.route as Record<string, unknown>;
      return { ...decl, route: safeRoute };
    }),
  };
}

/** Derive the full, stable entry id for an extension capability declaration. */
export function extensionEntryId(source: SourceId, decl: ExtensionCapabilityDecl): CapabilityId {
  return `${sourceSlug(source)}.${decl.name}`;
}

/**
 * An in-process capability handler an extension can carry on `extras.route.handler`.
 * Used for capabilities that are best served by gateway-owned code with bespoke
 * enforcement (e.g. the path-confined Obsidian vault read) rather than an external
 * wire. The handler returns a `TransportResult` (ok/data/error) the bridge
 * normalizes exactly like any transport result.
 */
export type ExtensionHandler = (
  entry: CapabilityEntry,
  input: Record<string, unknown>,
) => Promise<TransportResult>;

/** Project one manifest capability declaration into a full `CapabilityEntry`. */
export function declToEntry(
  manifest: ExtensionManifest,
  decl: ExtensionCapabilityDecl,
): CapabilityEntry {
  const entry: CapabilityEntry = {
    id: extensionEntryId(manifest.source, decl),
    source: manifest.source,
    kind: decl.kind,
    label: decl.label,
    describe: decl.describe,
    grants: decl.grants,
    transport: decl.transport ?? manifest.transport,
  };
  if (decl.io) entry.io = decl.io;
  if (decl.members) entry.members = decl.members;
  if (decl.body) entry.body = decl.body;
  if (decl.route) entry.extras = { route: decl.route };
  return entry;
}

/**
 * Materialize all entries from a manifest. Skills are linked back to the
 * capabilities they teach: any capability whose `extras.route.attachSkills` lists a
 * skill name gets an `AttachedSkillRef` to the corresponding materialized skill
 * entry, so the skill is discoverable BOTH as a `kind:"skill"` entry AND from the
 * capability it documents.
 */
export function manifestEntries(manifest: ExtensionManifest): CapabilityEntry[] {
  const entries = manifest.capabilities.map((decl) => declToEntry(manifest, decl));

  // Wire attached-skill back-links from any capability declaring `attachSkills`.
  const byName = new Map<string, CapabilityEntry>();
  for (const decl of manifest.capabilities) {
    byName.set(decl.name, entries.find((e) => e.id === extensionEntryId(manifest.source, decl))!);
  }
  for (const decl of manifest.capabilities) {
    const route = decl.route as { attachSkills?: string[] } | undefined;
    const attach = route?.attachSkills;
    if (!attach || attach.length === 0) continue;
    const entry = byName.get(decl.name)!;
    const refs = attach
      .map((skillName) => byName.get(skillName))
      .filter((s): s is CapabilityEntry => !!s && s.kind === "skill")
      .map((s) => ({ id: s.id, label: s.label }));
    if (refs.length > 0) entry.skills = refs;
  }
  return entries;
}

/**
 * CROSS-SOURCE SKILL ATTACH (P-1, security review must-fix #6).
 *
 * A skill may declare `route.attachTo: ["<foreign-capability-id>", ...]` to attach
 * its free-text body onto a capability owned by a DIFFERENT source — a
 * prompt-injection channel (a malicious skill body misleading the agent into
 * misusing a trusted, powerful capability). Therefore:
 *   - SAME-SOURCE attach (the host capability belongs to the skill's own source) is
 *     safe and applied unconditionally.
 *   - CROSS-SOURCE attach is GATED OFF by default; it is applied only when
 *     `allowCrossSource` is true (m4sec-auth flips this behind a user-confirm), and
 *     even then the attachment is PROVENANCE-MARKED on the host entry so a foreign
 *     skill is distinguishable from a first-party describe.
 *
 * Provenance is stamped on the HOST entry's `extras.attachedSkillProvenance` (an
 * array of `{ skillId, authoringSource }`) — `extras` is the sanctioned escape hatch
 * core never reads, so no frozen-type edit (`AttachedSkillRef` stays `{id,label}`).
 *
 * Returns the set of host entry ids that were mutated (for diagnostics/tests). The
 * `entries` array is mutated in place (skills back-link + provenance).
 */
export interface AttachedSkillProvenance {
  /** The skill entry id being attached. */
  skillId: CapabilityId;
  /** The source that AUTHORED the skill (≠ the host capability's source). */
  authoringSource: SourceId;
}

export function applyCrossSourceAttach(
  entries: CapabilityEntry[],
  opts?: { allowCrossSource?: boolean | ((skillSource: SourceId) => boolean) },
): { attached: CapabilityId[]; rejected: Array<{ skillId: CapabilityId; hostId: CapabilityId }> } {
  const gate = opts?.allowCrossSource;
  const allows = (skillSource: SourceId): boolean =>
    typeof gate === "function" ? gate(skillSource) : gate === true;
  const byId = new Map<CapabilityId, CapabilityEntry>();
  for (const e of entries) byId.set(e.id, e);

  const attached: CapabilityId[] = [];
  const rejected: Array<{ skillId: CapabilityId; hostId: CapabilityId }> = [];

  for (const skill of entries) {
    if (skill.kind !== "skill") continue;
    const route = skill.extras?.route as { attachTo?: unknown } | undefined;
    const targets = Array.isArray(route?.attachTo) ? (route!.attachTo as unknown[]) : [];
    for (const t of targets) {
      if (typeof t !== "string") continue;
      const host = byId.get(t);
      if (!host) continue; // dangling attach target — nothing to attach onto.
      const sameSource = host.source === skill.source;
      if (!sameSource && !allows(skill.source)) {
        // Default-deny: cross-source attach is OFF unless gated on.
        rejected.push({ skillId: skill.id, hostId: host.id });
        continue;
      }
      // Apply the back-link.
      const ref = { id: skill.id, label: skill.label };
      host.skills = [...(host.skills ?? []).filter((r) => r.id !== ref.id), ref];
      if (!sameSource) {
        // Stamp authoring-source provenance so a foreign skill is distinguishable.
        const prov = (host.extras?.attachedSkillProvenance as AttachedSkillProvenance[] | undefined) ?? [];
        const next: AttachedSkillProvenance[] = [
          ...prov.filter((p) => p.skillId !== skill.id),
          { skillId: skill.id, authoringSource: skill.source },
        ];
        host.extras = { ...(host.extras ?? {}), attachedSkillProvenance: next };
      }
      attached.push(host.id);
    }
  }
  return { attached, rejected };
}

/** LIFECYCLE layer for a user extension — `scan()` returns the manifest's entries. */
export class ExtensionSource extends BaseCapabilitySource {
  readonly id: SourceId;
  readonly label: string;
  readonly transport;

  constructor(
    private readonly manifest: ExtensionManifest,
    private readonly _platform: PlatformServices,
  ) {
    super();
    this.id = manifest.source;
    this.label = manifest.label;
    this.transport = manifest.transport;
  }

  override async checkRequirements(): Promise<SourceRequirementResult> {
    return { ok: true, resolved: `extension:${this.id}` };
  }

  async scan(): Promise<CapabilityEntry[]> {
    return manifestEntries(this.manifest);
  }
}

/**
 * PER-SESSION layer for a user extension. Custom bridge (not BaseCapabilityBridge)
 * because an extension entry may carry an in-process handler. The invoke path:
 *   1. look up the full entry,
 *   2. skills are read-as-context → not invocable (contract),
 *   3. if the entry carries an in-process handler (`extras.route.handler`) run it,
 *   4. otherwise dispatch through the registered `Transport` for `entry.transport`.
 * Exactly ONE redaction-safe audit event is emitted, and the MCP/normalization
 * mapping is reused via `normalizeResult`.
 */
export class ExtensionBridge implements CapabilityBridge {
  readonly source: SourceId;
  private readonly ownedIds: Set<CapabilityId>;

  constructor(
    source: SourceId,
    private readonly deps: BridgeDeps,
    private readonly sessionId: string,
    private readonly snapshot: CapabilityEntry[],
  ) {
    this.source = source;
    this.ownedIds = new Set(snapshot.map((e) => e.id));
  }

  getCapabilities(): CapabilityEntry[] {
    return this.snapshot;
  }

  route(id: CapabilityId): RouteResult {
    return this.ownedIds.has(id) ? "handled" : "passthrough";
  }

  async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    const entry = this.deps.getEntry(req.id) ?? this.snapshot.find((e) => e.id === req.id);
    if (!entry) {
      const audit = await this.deps.audit({
        type: "invoke",
        jti: ctx.jti,
        sessionId: ctx.sessionId,
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        capabilityId: req.id,
        outcome: "error",
        detail: { reason: "unknown_capability" },
      });
      return {
        id: req.id,
        ok: false,
        error: { code: "unknown_capability", message: `no such entry: ${req.id}`, capabilityId: req.id },
        auditId: audit.id,
      };
    }

    // Skills are read-as-context, never invoked (contract).
    if (entry.kind === "skill") {
      const audit = await this.deps.audit({
        type: "invoke",
        jti: ctx.jti,
        sessionId: ctx.sessionId,
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        capabilityId: entry.id,
        outcome: "error",
        detail: { reason: "skill_not_invocable" },
      });
      return {
        id: entry.id,
        ok: false,
        error: {
          code: "transport_error",
          message: "skill entries are read-as-context, not invoked",
          capabilityId: entry.id,
        },
        auditId: audit.id,
      };
    }

    const input = req.input ?? {};
    const handler = (entry.extras?.route as { handler?: ExtensionHandler } | undefined)?.handler;

    let result: TransportResult;
    try {
      if (typeof handler === "function") {
        // In-process handler (e.g. path-confined vault read). Enforcement lives in
        // the handler; the bridge only normalizes + audits.
        result = await handler(entry, input);
      } else {
        const transport = this.deps.getTransport(entry.transport);
        result = await transport.dispatch(entry, input, {
          invokeById: this.deps.invokeById,
          invoke: ctx,
        });
      }
    } catch (err) {
      const audit = await this.deps.audit({
        type: "invoke",
        jti: ctx.jti,
        sessionId: ctx.sessionId,
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        capabilityId: entry.id,
        verbs: entry.grants,
        outcome: "error",
        detail: { reason: "handler_threw", transport: entry.transport },
      });
      return {
        id: entry.id,
        ok: false,
        error: {
          code: "transport_error",
          message: err instanceof Error ? err.message : String(err),
          capabilityId: entry.id,
        },
        auditId: audit.id,
      };
    }

    const audit = await this.deps.audit({
      type: "invoke",
      jti: ctx.jti,
      sessionId: ctx.sessionId,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      capabilityId: entry.id,
      verbs: entry.grants,
      outcome: result.ok && result.mcpResult?.isError !== true ? "ok" : "error",
      detail: { transport: entry.transport, kind: entry.kind },
    });
    return normalizeResult(entry.id, result, audit.id);
  }

  async disconnect(): Promise<void> {}
}

/**
 * Turn an `ExtensionManifest` into a runtime `SourceModule` — the source-agnostic
 * core of `registerExtension`. The optional `handlers` map binds an in-process
 * `ExtensionHandler` to a capability by its declaration `name` (e.g. the Obsidian
 * vault read), so capabilities best served by gateway-owned, bespoke-enforced code
 * route through it instead of an external transport. The handler is attached to the
 * materialized entry's `extras.route.handler` — a field core NEVER reads.
 */
export function materializeExtension(
  manifest: ExtensionManifest,
  platform: PlatformServices,
  handlers?: Record<string, ExtensionHandler>,
): SourceModule {
  // SECURITY: strip any route.handler the wire manifest carried FIRST (make §11
  // "no function over the wire" true by construction), THEN bind only the
  // gateway-supplied in-process handlers (the trusted path). A wire caller can never
  // smuggle a handler in: it is removed before any trusted handler is attached.
  const wireSafe = stripWireHandlers(manifest);

  // Bake any in-process handlers onto the matching declarations' route config so
  // both scan() (lifecycle) and createBridge() (per-session) see them.
  const withHandlers: ExtensionManifest = handlers
    ? {
        ...wireSafe,
        capabilities: wireSafe.capabilities.map((decl) => {
          const handler = handlers[decl.name];
          if (!handler) return decl;
          return { ...decl, route: { ...(decl.route ?? {}), handler } };
        }),
      }
    : wireSafe;

  const entries = manifestEntries(withHandlers);

  return {
    id: manifest.source,
    label: manifest.label,
    transport: manifest.transport,
    createSource: (deps: PlatformServices) => new ExtensionSource(withHandlers, deps),
    createBridge: (deps: BridgeDeps, sessionId: string) =>
      new ExtensionBridge(manifest.source, deps, sessionId, entries),
  };
}
