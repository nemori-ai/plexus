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
 * project it to the management event stream (`audit_appended`). The hook is fed
 * the same redaction-safe record that was written to disk — never raw input.
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
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = keys.has(k.toLowerCase()) ? REDACTION_MASK : walk(v);
      }
      return out;
    }
    return value;
  };
  return walk(detail) as Record<string, unknown>;
}

/** UTC day stamp `YYYY-MM-DD` for daily log rotation. */
function dayStamp(at: Date): string {
  return at.toISOString().slice(0, 10);
}

class JsonlAuditWriter implements AuditWriter {
  readonly policy: AuditRedactionPolicy;
  private readonly dir: string;
  private onAppend?: AuditAppendHook;

  constructor(dir: string, policy: AuditRedactionPolicy, onAppend?: AuditAppendHook) {
    this.dir = dir;
    this.policy = policy;
    this.onAppend = onAppend;
  }

  /** Register/replace the post-append hook (wired after construction by the state). */
  setOnAppend(hook: AuditAppendHook): void {
    this.onAppend = hook;
  }

  async write(event: AuditEventInput): Promise<AuditEvent> {
    const now = new Date();
    const persisted: AuditEvent = {
      ...event,
      ...(event.detail !== undefined
        ? { detail: redactDetail(event.detail, this.policy) }
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
    // Project to the management event stream (audit_appended) — best-effort, never
    // breaks the write path. Fed the REDACTED persisted record (no raw input).
    if (this.onAppend) {
      try {
        this.onAppend(persisted);
      } catch {
        /* a broken subscriber must not break the audit write */
      }
    }
    return persisted;
  }
}

/** The concrete writer type exposing `setOnAppend` (used by the state to wire the bus). */
export interface JsonlAuditWriterLike extends AuditWriter {
  setOnAppend(hook: AuditAppendHook): void;
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
