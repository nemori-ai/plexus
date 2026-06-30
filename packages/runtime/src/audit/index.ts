/**
 * Append-only JSONL audit writer (§7, ADR-009 + amendment).
 *
 * SINGLE WRITE PATH: every grant change and every invocation flows through ONE
 * writer that applies the redaction CONTRACT before persisting — `detail` MUST NOT
 * carry raw call input, token strings, connection-keys, or resolved secrets.
 * Append-only JSONL under `~/.plexus/audit/` (daily-rotated), retention default 90d.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AuditEvent,
  AuditEventInput,
  AuditRedactionPolicy,
} from "@plexus/protocol";
import { plexusHome, ensureDir, appendLine } from "../core/paths.ts";

/** Audit retention default — 90 days (§5 security model). */
export const AUDIT_RETENTION_DAYS = 90;

/**
 * The default redaction policy the single writer enforces (ADR-009 amendment).
 * `forbidRawInput` is a CONTRACT, not aspirational.
 */
export const DEFAULT_REDACTION_POLICY: AuditRedactionPolicy = {
  redactedKeys: ["input", "token", "connectionKey", "secret", "secretValue", "args"],
  forbidRawInput: true,
};

const REDACTION_MASK = "[redacted]";

// ── Size caps for the captured invoke `input`/`output` (cheap + safe) ─────────
// The audit trail must NOT store unbounded blobs (a 10MB tool result must not land
// in the JSONL). The writer clips every captured request/result to a bounded shape
// BEFORE persisting: long strings are clipped, arrays/objects are capped in length
// and depth, and every clip is MARKED so a reviewer knows truncation happened.
const AUDIT_MAX_STRING = 500;
const AUDIT_MAX_ARRAY = 50;
const AUDIT_MAX_KEYS = 50;
const AUDIT_MAX_DEPTH = 6;

/**
 * Recursively scrub redacted keys from ANY value (the value of a key in
 * `redactedKeys` is masked; the key survives so the shape stays auditable). Shared
 * by `detail` redaction and the `input`/`output` capture so secrets can never leak
 * through the new fields either.
 */
function redactValue(value: unknown, keys: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => redactValue(v, keys));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = keys.has(k.toLowerCase()) ? REDACTION_MASK : redactValue(v, keys);
    }
    return out;
  }
  return value;
}

/**
 * Clip a (already-redacted) value to a bounded shape so the audit JSONL never
 * stores an unbounded blob. Keeps top-level JSON keys; clips long strings to
 * `AUDIT_MAX_STRING`; caps arrays/objects in length and recursion depth. Every
 * clip is MARKED (a trailing string for strings/arrays, a `__truncated__` key for
 * objects, `[truncated]` past the depth ceiling) so truncation is visible.
 */
function truncateForAudit(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > AUDIT_MAX_STRING
      ? `${value.slice(0, AUDIT_MAX_STRING)}…[+${value.length - AUDIT_MAX_STRING} chars]`
      : value;
  }
  if (value === null || typeof value !== "object") return value; // number/boolean/undefined
  if (depth >= AUDIT_MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    const clipped: unknown[] = value
      .slice(0, AUDIT_MAX_ARRAY)
      .map((v) => truncateForAudit(v, depth + 1));
    if (value.length > AUDIT_MAX_ARRAY) {
      clipped.push(`…[+${value.length - AUDIT_MAX_ARRAY} items]`);
    }
    return clipped;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries.slice(0, AUDIT_MAX_KEYS)) {
    out[k] = truncateForAudit(v, depth + 1);
  }
  if (entries.length > AUDIT_MAX_KEYS) {
    out.__truncated__ = `+${entries.length - AUDIT_MAX_KEYS} more keys`;
  }
  return out;
}

/**
 * Redact (per the policy's `redactedKeys`) THEN truncate a captured `input`/
 * `output`. Redaction runs FIRST so a secret is masked before it could be clipped
 * into the persisted record. This is the single safety pass for the new fields.
 */
function redactAndTruncate(value: unknown, policy: AuditRedactionPolicy): unknown {
  const keys = new Set(policy.redactedKeys.map((k) => k.toLowerCase()));
  return truncateForAudit(redactValue(value, keys));
}

/**
 * THE SINGLE AUDIT WRITE PATH. Callers (sources, bridges, core) hand an
 * `AuditEventInput`; the writer stamps `id` + `at`, applies the redaction pass,
 * and appends one JSON line. Returns the persisted `AuditEvent` (its `id` becomes
 * `InvokeResponse.auditId`).
 */
export interface AuditWriter {
  readonly policy: AuditRedactionPolicy;
  /** Append one event (single write path). */
  write(event: AuditEventInput): Promise<AuditEvent>;
}

/**
 * Optional post-append hook (REDESIGN-ARCHITECTURE §2.3). Invoked with the
 * REDACTED, persisted `AuditEvent` AFTER it is appended, so the gateway can
 * project it to the management event stream (`audit_appended`) AND (on a proxy)
 * BUBBLE a copy up the mesh tunnel (mesh §3.5 / Invariant D). The hook is fed the
 * same redaction-safe record that was written to disk — never raw input. MULTIPLE
 * independent subscribers may register (the management projection + the mesh
 * bubble); each runs guarded so one throwing subscriber never breaks the write or
 * the others.
 */
export type AuditAppendHook = (event: AuditEvent) => void;

/**
 * Recursively scrub redacted keys from a detail object. The VALUE of any key in
 * `redactedKeys` is masked (the key survives so the shape stays auditable).
 */
function redactDetail(
  detail: Record<string, unknown>,
  policy: AuditRedactionPolicy,
): Record<string, unknown> {
  const keys = new Set(policy.redactedKeys.map((k) => k.toLowerCase()));
  return redactValue(detail, keys) as Record<string, unknown>;
}

/** UTC day stamp `YYYY-MM-DD` for daily log rotation. */
function dayStamp(at: Date): string {
  return at.toISOString().slice(0, 10);
}

class JsonlAuditWriter implements AuditWriter {
  readonly policy: AuditRedactionPolicy;
  private readonly dir: string;
  /**
   * Post-append subscribers (multi-subscriber, REDESIGN-ARCHITECTURE §2.3 + mesh §3.5):
   * the management `audit_appended` projection AND (on a proxy) the tunnel audit bubble
   * each register independently. A `Set` so re-registering is idempotent and unsubscribe
   * is exact.
   */
  private readonly appendHooks = new Set<AuditAppendHook>();

  constructor(dir: string, policy: AuditRedactionPolicy, onAppend?: AuditAppendHook) {
    this.dir = dir;
    this.policy = policy;
    if (onAppend) this.appendHooks.add(onAppend);
  }

  /**
   * Register a post-append subscriber; returns an UNSUBSCRIBE function. Additive — a
   * second subscriber does NOT replace the first (the management projection and the mesh
   * bubble coexist). Each subscriber is invoked guarded on every append.
   */
  setOnAppend(hook: AuditAppendHook): () => void {
    this.appendHooks.add(hook);
    return () => {
      this.appendHooks.delete(hook);
    };
  }

  async write(event: AuditEventInput): Promise<AuditEvent> {
    const now = new Date();
    const persisted: AuditEvent = {
      ...event,
      ...(event.detail !== undefined
        ? { detail: redactDetail(event.detail, this.policy) }
        : {}),
      // The captured request/result get the SAME redaction pass (so a secret in
      // call input can never leak through these new fields) PLUS a size cap, in the
      // ONE write path — callers hand raw input/output, the writer makes it safe.
      ...(event.input !== undefined
        ? { input: redactAndTruncate(event.input, this.policy) }
        : {}),
      ...(event.output !== undefined
        ? { output: redactAndTruncate(event.output, this.policy) }
        : {}),
      id: `evt_${randomUUID()}`,
      at: now.toISOString(),
    };
    try {
      ensureDir(this.dir);
      const file = join(this.dir, `audit-${dayStamp(now)}.jsonl`);
      appendLine(file, JSON.stringify(persisted));
    } catch {
      // Audit persistence is best-effort durability; the event id is still
      // returned so the call chain (InvokeResponse.auditId) stays intact even if
      // the FS is unwritable. (A single-writer local process; no concurrency.)
    }
    // Fan out to every post-append subscriber (management projection + mesh bubble) —
    // best-effort, never breaks the write path. Fed the REDACTED persisted record (no
    // raw input). Each subscriber is isolated: one throwing never blocks the others or
    // the write (Invariant D — the bubble can never break the hot path).
    for (const hook of this.appendHooks) {
      try {
        hook(persisted);
      } catch {
        /* a broken subscriber must not break the audit write or sibling subscribers */
      }
    }
    return persisted;
  }
}

/** The concrete writer type exposing `setOnAppend` (used by the state to wire the bus). */
export interface JsonlAuditWriterLike extends AuditWriter {
  /** Register a post-append subscriber (additive); returns an unsubscribe function. */
  setOnAppend(hook: AuditAppendHook): () => void;
}

/**
 * Construct the JSONL audit writer rooted at a directory (default
 * `~/.plexus/audit/`). Daily-rotated append + redaction pass.
 */
export function createAuditWriter(
  dir?: string,
  policy: AuditRedactionPolicy = DEFAULT_REDACTION_POLICY,
): AuditWriter {
  return new JsonlAuditWriter(dir ?? join(plexusHome(), "audit"), policy);
}
