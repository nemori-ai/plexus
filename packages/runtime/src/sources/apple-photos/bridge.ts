/**
 * Apple Photos PER-SESSION bridge (READ-ONLY posture, v1).
 *
 * Mirrors the apple-calendar in-process-handler pattern: the three read capabilities are
 * served by REAL in-process handlers that go through the injected `PhotosProvider` (real
 * osascript/JXA by default; fake fixtures under `PLEXUS_FAKE_APPLE=1` or when injected).
 * The how-to-use SKILL takes the standard base path (read-as-context, never invoked).
 *
 *  - `apple-photos.albums.list` → `provider.listAlbums()` (no input).
 *  - `apple-photos.search`      → validate `{album?,start?,end?,query?,limit?}` FIRST
 *    (dates parsed + re-serialized, limit clamped-by-rejection to 1..100), then
 *    `provider.search(query)`.
 *  - `apple-photos.export`      → validate the media-item `id` FIRST (path-shaped ids —
 *    `..`, leading `/`, backslash — are rejected as invalid_input BEFORE the provider),
 *    then `provider.exportItem(id)`; the provider confines the write to the jail.
 *
 * Bad input never reaches osascript; a TCC denial surfaces as a graceful not-authorized
 * transport_error (clear onboarding message); a confinement violation surfaces as its
 * own reason. Never a crash.
 */

import type {
  BridgeDeps,
  CapabilityEntry,
  InvokeContext,
  InvokeRequest,
  InvokeResponse,
  TransportResult,
} from "@plexus/protocol";
import { BaseCapabilityBridge, normalizeResult } from "../base.ts";
import {
  APPLE_PHOTOS_SOURCE_ID,
  PHOTOS_ALBUMS_LIST_ID,
  PHOTOS_EXPORT_ID,
  PHOTOS_SEARCH_ID,
  applePhotosEntries,
} from "./entries.ts";
import {
  PhotosConfinementError,
  PhotosInputError,
  PhotosNotAuthorizedError,
  PhotosNotFoundError,
  selectPhotosProvider,
  validateExportId,
  validateSearchInput,
  type PhotosProvider,
} from "./provider.ts";

const HANDLED_IDS: ReadonlySet<string> = new Set([
  PHOTOS_ALBUMS_LIST_ID,
  PHOTOS_SEARCH_ID,
  PHOTOS_EXPORT_ID,
]);

/** Map a provider/validation error to a graceful, structured `transport_error`. */
function photosErrorResult(entry: CapabilityEntry, err: unknown): TransportResult {
  const fail = (message: string, reason?: string): TransportResult => ({
    ok: false,
    error: {
      code: "transport_error",
      message,
      capabilityId: entry.id,
      ...(reason ? { detail: { reason } } : {}),
    },
  });
  if (err instanceof PhotosNotAuthorizedError) return fail(err.message, "not_authorized");
  if (err instanceof PhotosInputError) return fail(`apple-photos: invalid input: ${err.message}`, "invalid_input");
  if (err instanceof PhotosConfinementError) return fail(err.message, "confinement_violation");
  if (err instanceof PhotosNotFoundError) return fail(err.message, "not_found");
  return fail(err instanceof Error ? err.message : String(err));
}

export class ApplePhotosBridge extends BaseCapabilityBridge {
  private readonly provider: PhotosProvider;

  constructor(deps: BridgeDeps, sessionId: string, entries: CapabilityEntry[], provider?: PhotosProvider) {
    super(APPLE_PHOTOS_SOURCE_ID, deps, sessionId, entries);
    // Inject the provider (tests substitute a fake); default selects real/fake by env.
    this.provider = selectPhotosProvider(provider);
  }

  override async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    if (!HANDLED_IDS.has(req.id)) {
      // The skill (and anything else) takes the standard base path.
      return super.invoke(req, ctx);
    }

    const entry = this.deps.getEntry(req.id) ?? this.getCapabilities().find((e) => e.id === req.id);
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

    const input = req.input ?? {};
    let result: TransportResult;
    try {
      if (req.id === PHOTOS_ALBUMS_LIST_ID) {
        result = { ok: true, data: await this.provider.listAlbums() };
      } else if (req.id === PHOTOS_SEARCH_ID) {
        // VALIDATE before touching the provider (bad input never reaches osascript).
        const query = validateSearchInput(input);
        result = { ok: true, data: await this.provider.search(query) };
      } else {
        // export: a path-shaped id dies here, BEFORE the provider.
        const id = validateExportId(input);
        result = { ok: true, data: await this.provider.exportItem(id) };
      }
    } catch (err) {
      result = photosErrorResult(entry, err);
    }

    const audit = await this.deps.audit({
      type: "invoke",
      jti: ctx.jti,
      sessionId: ctx.sessionId,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      capabilityId: entry.id,
      verbs: entry.grants,
      outcome: result.ok ? "ok" : "error",
      // Redaction-safe: op name + kind only, never query text or item metadata.
      detail: { transport: "in-process", kind: entry.kind, op: req.id },
      // Request + result for the Activity view (writer redacts + truncates).
      input,
      output: result.ok ? result.data : result.error,
    });
    return normalizeResult(entry.id, result, audit.id);
  }
}

/** Re-export so the module factory can build the full entry set. */
export { applePhotosEntries };
