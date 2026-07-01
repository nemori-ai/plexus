/**
 * Frame codec + correlation helpers for the tunnel multiplexer (federated-mesh §7,
 * phase-1 plan seam (b) / T4).
 *
 * This module owns ONLY the wire-encoding and correlation-id plumbing for the
 * messages multiplexed over the single persistent proxy↔primary tunnel. The shape
 * of those messages — the `Frame` discriminated union — is the PUBLISHED LANGUAGE
 * of that boundary and lives in `@plexus/protocol` (landed by T1). We import and
 * reuse it verbatim; we never redefine the Frame variants here.
 *
 * Scope note (T4): this is the RAW, UNAUTHENTICATED multiplexer. Enrollment and
 * Ed25519 mutual auth (the `enroll` handshake, key pinning) are T5 and deliberately
 * absent here — the codec is identity-agnostic.
 */

import type { Frame, HealthFramePayload, HealthReportSource, HealthStatus } from "@plexus/protocol";

/** The discriminant tags of the mesh `Frame` union (`"enroll" | "invoke" | …`). */
export type FrameType = Frame["t"];

/** A frame narrowed to a single variant `T` (e.g. `FrameOf<"invoke-result">`). */
export type FrameOf<T extends FrameType> = Extract<Frame, { t: T }>;

/**
 * Anything the underlying socket may hand us as an inbound message: a decoded
 * text frame (the common case — we always SEND text) or a binary payload Bun may
 * surface as a `Buffer`/typed array/`ArrayBuffer`.
 */
export type RawMessage = string | Uint8Array | ArrayBuffer | ArrayBufferView;

/** Serialize a `Frame` to the on-the-wire text form (newline-free JSON). */
export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

/**
 * Normalize any inbound socket payload to its UTF-8 text. Exported for the
 * connection-auth handshake layer, which exchanges its (non-`Frame`) lock-step
 * messages as raw text on the socket BEFORE the mux is wired.
 */
export function decodeText(data: RawMessage): string {
  return toText(data);
}

/** Normalize any inbound socket payload to its UTF-8 text. */
function toText(data: RawMessage): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  // ArrayBufferView (Buffer / Uint8Array / DataView …)
  const view = data as ArrayBufferView;
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("utf8");
}

/**
 * Decode an inbound socket payload into a `Frame`. Throws on malformed input
 * (non-JSON, or JSON missing the `t`/`corr` discriminants) — callers on the hot
 * path catch-and-drop so a single garbage frame can never wedge the mux.
 */
export function decodeFrame(data: RawMessage): Frame {
  const parsed = JSON.parse(toText(data)) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { t?: unknown }).t !== "string" ||
    typeof (parsed as { corr?: unknown }).corr !== "string"
  ) {
    throw new Error("mesh/frames: malformed frame (missing t/corr)");
  }
  return parsed as Frame;
}

/** A fresh, process-unique correlation id for a new request. */
export function newCorr(): string {
  return crypto.randomUUID();
}

/**
 * Type-narrowing predicate over the `Frame` union: `isFrame(f, "invoke")` narrows
 * `f` to the `InvokeFrame` variant. The published way to switch on `t` without a
 * hand-rolled cast.
 */
export function isFrame<T extends FrameType>(frame: Frame, t: T): frame is FrameOf<T> {
  return frame.t === t;
}

/**
 * Return a copy of `frame` stamped with `corr` (preserving its variant). Used by
 * the mux to bind a reply frame to its request's correlation id.
 */
export function withCorr(frame: Frame, corr: string): Frame {
  return { ...frame, corr } as Frame;
}

// ── Health-frame validation (mesh-health-reporting.md §3) ───────────────────────

const HEALTH_STATUSES = new Set<HealthStatus>(["ok", "degraded", "unavailable", "unknown"]);
const OVERALL_STATUSES = new Set<HealthFramePayload["overall"]>(["ok", "degraded", "down"]);

/**
 * Fail-closed DoS CAPS on a `health` frame's contents (mesh-health-reporting.md §3). A report is
 * stored by reference at the primary, so an unbounded `sources[]` or an unbounded string is a
 * memory/CPU amplification vector a hostile proxy could arm with one frame. A frame that exceeds
 * ANY cap is REJECTED wholesale (returns `undefined`) rather than truncated — fail-closed.
 */
const MAX_HEALTH_SOURCES = 64;
const MAX_HEALTH_STRING = 256;

/** True when `v` is a string within the fail-closed length cap. */
function isBoundedString(v: unknown): v is string {
  return typeof v === "string" && v.length <= MAX_HEALTH_STRING;
}

/**
 * Validate + narrow a `health` frame's payload — fail-closed. A frame arriving on the tunnel
 * is decoded generically by `decodeFrame`; this asserts the health-specific shape AND bounds its
 * size before the primary attributes it (so a malformed OR oversized report can never corrupt /
 * amplify the health store). Returns the typed payload, or `undefined` when the shape is wrong or
 * a cap is exceeded (the caller drops it silently).
 */
export function validateHealthPayload(payload: unknown): HealthFramePayload | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (!isBoundedString(p.reporter)) return undefined;
  if (typeof p.overall !== "string" || !OVERALL_STATUSES.has(p.overall as HealthFramePayload["overall"]))
    return undefined;
  if (typeof p.seq !== "number" || !Number.isFinite(p.seq)) return undefined;
  if (typeof p.ts !== "string") return undefined;
  if (!Array.isArray(p.sources)) return undefined;
  if (p.sources.length > MAX_HEALTH_SOURCES) return undefined; // fail-closed cap on row count.
  const sources: HealthReportSource[] = [];
  for (const raw of p.sources) {
    if (!raw || typeof raw !== "object") return undefined;
    const s = raw as Record<string, unknown>;
    if (!isBoundedString(s.source)) return undefined;
    if (typeof s.status !== "string" || !HEALTH_STATUSES.has(s.status as HealthStatus)) return undefined;
    if (s.detail !== undefined && !isBoundedString(s.detail)) return undefined; // bound the detail string.
    sources.push({
      source: s.source,
      status: s.status as HealthStatus,
      ...(typeof s.detail === "string" ? { detail: s.detail } : {}),
      ...(typeof s.checkedAt === "string" ? { checkedAt: s.checkedAt } : {}),
    });
  }
  return {
    reporter: p.reporter as HealthFramePayload["reporter"],
    overall: p.overall as HealthFramePayload["overall"],
    sources,
    seq: p.seq,
    ts: p.ts,
  };
}
