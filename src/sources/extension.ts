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
  // Bake any in-process handlers onto the matching declarations' route config so
  // both scan() (lifecycle) and createBridge() (per-session) see them.
  const withHandlers: ExtensionManifest = handlers
    ? {
        ...manifest,
        capabilities: manifest.capabilities.map((decl) => {
          const handler = handlers[decl.name];
          if (!handler) return decl;
          return { ...decl, route: { ...(decl.route ?? {}), handler } };
        }),
      }
    : manifest;

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
