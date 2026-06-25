/**
 * ============================================================================
 * LRA request builders — the URL/body/headers for the runtime calls we make
 * ============================================================================
 *
 * The desktop main process is just another LRA client (REDESIGN §2). It calls:
 *   - POST /v1/admin/api/pending/:id   (approve/deny + trustWindow)  — §2.2
 *   - GET  /v1/admin/api/pending       (re-snapshot for the badge)   — P1 note
 *   - GET  /v1/health                  (supervisor readiness probe)  — §3.3
 *   - GET  /v1/events                  (management SSE, key-gated)    — §2.3
 *
 * Every mutating/management call carries `X-Plexus-Connection-Key` (the key main
 * reads from `~/.plexus/connection-key`, §3.5) and the loopback `Host` header so
 * the runtime's Host/Origin guard passes (mirrors the CLI client).
 *
 * Pure builders — no fetch, no Electron, no fs — so the URL/body/headers shape is
 * directly unit-testable. The supervisor wires these to a real `fetch`.
 */

import type { TrustWindow } from "@plexus/protocol";
import { baseUrlFor } from "./port-discovery.ts";

/** The decision a notification action resolves to, threaded to the approve call. */
export interface PendingDecision {
  readonly action: "approve" | "deny";
  /** Present iff action==="approve": the human-authoritative trust-window. */
  readonly trustWindow?: TrustWindow;
  /** Optional re-target of which agent the grant is minted for. */
  readonly agentId?: string;
  /** Optional deny reason. */
  readonly reason?: string;
}

/** A built HTTP request: everything `fetch(url, init)` needs. */
export interface BuiltRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  /** JSON-stringified body, or undefined for GETs. */
  readonly body?: string;
}

/** The loopback Host the runtime's guard expects (mirrors the CLI). */
const LOOPBACK_HOST = "127.0.0.1";

function managementHeaders(connectionKey: string, port: number): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Plexus-Connection-Key": connectionKey,
    Host: `${LOOPBACK_HOST}:${port}`,
  };
}

/**
 * Build the `POST /v1/admin/api/pending/:id` request that resolves a pending item.
 * The body shape matches the runtime admin handler:
 *   { action: "approve"|"deny", trustWindow?, agentId?, reason? }
 */
export function buildResolvePendingRequest(args: {
  readonly port: number;
  readonly connectionKey: string;
  readonly pendingId: string;
  readonly decision: PendingDecision;
}): BuiltRequest {
  const { port, connectionKey, pendingId, decision } = args;
  const body: Record<string, unknown> = { action: decision.action };
  if (decision.action === "approve" && decision.trustWindow) {
    body.trustWindow = decision.trustWindow;
  }
  if (decision.agentId) body.agentId = decision.agentId;
  if (decision.action === "deny" && decision.reason) body.reason = decision.reason;

  return {
    url: `${baseUrlFor(port)}/v1/admin/api/pending/${encodeURIComponent(pendingId)}`,
    method: "POST",
    headers: managementHeaders(connectionKey, port),
    body: JSON.stringify(body),
  };
}

/** Build the `GET /v1/admin/api/pending` snapshot request (re-seed the badge). */
export function buildPendingSnapshotRequest(args: {
  readonly port: number;
  readonly connectionKey: string;
}): BuiltRequest {
  const { port, connectionKey } = args;
  return {
    url: `${baseUrlFor(port)}/v1/admin/api/pending`,
    method: "GET",
    headers: managementHeaders(connectionKey, port),
  };
}

/** Build the `GET /v1/health` supervisor readiness probe (no key needed; loopback-only). */
export function buildHealthRequest(args: { readonly port: number }): BuiltRequest {
  const { port } = args;
  return {
    url: `${baseUrlFor(port)}/v1/health`,
    method: "GET",
    headers: { Host: `${LOOPBACK_HOST}:${port}` },
  };
}

/** Build the `GET /v1/events` management SSE subscription request (key-gated, §2.3). */
export function buildEventsRequest(args: {
  readonly port: number;
  readonly connectionKey: string;
}): BuiltRequest {
  const { port, connectionKey } = args;
  return {
    url: `${baseUrlFor(port)}/v1/events`,
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      "X-Plexus-Connection-Key": connectionKey,
      Host: `${LOOPBACK_HOST}:${port}`,
    },
  };
}

/** The admin URL the renderer BrowserWindow loads (the served SPA). */
export function adminUrl(port: number): string {
  return `${baseUrlFor(port)}/admin`;
}
