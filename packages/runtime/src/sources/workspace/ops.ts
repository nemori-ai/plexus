/**
 * Workspace confined-fs OPS — the ONE implementation of list/read/write over a
 * {@link WorkspaceProvider}, shared by BOTH dispatch sites so they can never drift:
 *   - the compile-time singleton `WorkspaceBridge` (`bridge.ts`), and
 *   - the managed `workspace-dir` in-process handlers (`open-dir.ts`).
 *
 * Each op path-confines through the provider (absolute reject, lexical `..` reject,
 * realpath re-check — the provider owns that) and maps a `WorkspaceConfinementError`
 * to a `transport_error` with `detail.reason:"path_confinement"` — NEVER a thrown
 * exception, and the out-of-dir content is never returned. Any OTHER error is
 * rethrown for the caller's audit path to record as `handler_threw`.
 */

import type { TransportResult } from "@plexus/protocol";
import { WorkspaceConfinementError, type WorkspaceProvider } from "./provider.ts";

/** A non-empty string, else undefined (schema-guard helper). */
export function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Map a confinement violation to a transport_error (out-of-dir content never returned). */
export function denyConfinement(err: WorkspaceConfinementError): TransportResult {
  return {
    ok: false,
    error: {
      code: "transport_error",
      message: `workspace: path denied (confinement): ${err.message}`,
      detail: { reason: "path_confinement" },
    },
  };
}

/** LIST: enumerate a directory under the confined root (path "" ⇒ root). */
export async function wsList(
  provider: WorkspaceProvider,
  input: Record<string, unknown>,
): Promise<TransportResult> {
  const path = typeof input.path === "string" ? input.path : "";
  try {
    return { ok: true, data: await provider.read(path) };
  } catch (err) {
    if (err instanceof WorkspaceConfinementError) return denyConfinement(err);
    throw err;
  }
}

/** READ: read a file under the confined root (path required). */
export async function wsRead(
  provider: WorkspaceProvider,
  input: Record<string, unknown>,
): Promise<TransportResult> {
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
}

/** WRITE: write a file under the confined root (path + content required). */
export async function wsWrite(
  provider: WorkspaceProvider,
  input: Record<string, unknown>,
): Promise<TransportResult> {
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
}
