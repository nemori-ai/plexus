// ── Audit request/result panes ("不能没有参数" — audit review needs the payload) ──
// Shared by the Activity tab (inline expander) and the Realtime ledger (fetch-on-open),
// so an owner can always see WHAT a call did — its invoke params and its return value.
import { useMemo, useState } from "react";
import type { AuditEvent } from "./api";

/** Does this event carry an `input` (request params) and/or `output` (result)? */
export function hasAuditIO(e: AuditEvent): boolean {
  // A grant denial carries its WHY in `detail` (reason/policy) rather than input/output
  // — without this, the deny row is not expandable and the reason is invisible.
  if (e.type === "grant.deny" && e.detail !== undefined) return true;
  return e.input !== undefined || e.output !== undefined;
}

/** Extract a denial/error envelope from an event's `output` (`{ error: { code, message } }`). */
export function auditError(output: unknown): { code?: string; message?: string } | null {
  if (output && typeof output === "object" && "error" in output) {
    const err = (output as { error?: unknown }).error;
    if (err && typeof err === "object") return err as { code?: string; message?: string };
  }
  return null;
}

/** A one-line "top-level keys" summary used as the collapsed view of a large value. */
function summarizeValue(value: unknown): string {
  if (Array.isArray(value)) return `[ ${value.length} item${value.length === 1 ? "" : "s"} … ]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length ? `{ ${keys.join(", ")} … }` : "{ }";
  }
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return (s ?? "").length > 120 ? `${(s ?? "").slice(0, 117)}…` : String(s);
}

/**
 * A compact, theme-aware JSON code block. The backend already redacts + truncates,
 * but very large values are further collapsed here to their top-level keys with a
 * "show full" affordance so a row stays scannable. Tokens only — flips with the theme.
 */
export function JsonBlock({ value }: { value: unknown }) {
  const full = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return String(value);
    }
  }, [value]);
  const large = full.length > 480 || full.split("\n").length > 14;
  const [expanded, setExpanded] = useState(!large);
  return (
    <pre className="json-block" data-collapsed={!expanded || undefined}>
      <code>{expanded ? full : summarizeValue(value)}</code>
      {large && (
        <button
          type="button"
          className="json-more"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "collapse" : "… show full"}
        </button>
      )}
    </pre>
  );
}

/**
 * The expandable request/result detail for one audit row. Shows `input` (the invoke
 * params) and `output` (the result); for denials it renders the error code + message.
 * Events without input/output (older / non-invoke) render nothing.
 */
export function AuditDetail({ event }: { event: AuditEvent }) {
  const err = auditError(event.output);
  if (!hasAuditIO(event)) return null;
  // grant.deny: the reason lives in `detail` — render it as the (error-toned) pane.
  const denyDetail =
    event.type === "grant.deny" && event.detail !== undefined ? event.detail : null;
  const denyReason =
    denyDetail && typeof (denyDetail as { reason?: unknown }).reason === "string"
      ? ((denyDetail as { reason?: string }).reason ?? null)
      : null;
  return (
    <div className="audit-detail">
      {denyDetail && (
        <div className="audit-pane">
          <span className="audit-pane-label" data-error>
            denied
          </span>
          {denyReason ? (
            <div className="audit-error">
              <code className="audit-error-code">grant.deny</code>
              <span className="audit-error-msg">{denyReason}</span>
            </div>
          ) : (
            <JsonBlock value={denyDetail} />
          )}
        </div>
      )}
      {event.input !== undefined && (
        <div className="audit-pane">
          <span className="audit-pane-label">params</span>
          <JsonBlock value={event.input} />
        </div>
      )}
      {event.output !== undefined && (
        <div className="audit-pane">
          <span className="audit-pane-label" data-error={err ? true : undefined}>
            {err ? "error" : "result"}
          </span>
          {err ? (
            <div className="audit-error">
              <code className="audit-error-code">{err.code ?? "error"}</code>
              {err.message ? <span className="audit-error-msg">{err.message}</span> : null}
            </div>
          ) : (
            <JsonBlock value={event.output} />
          )}
        </div>
      )}
    </div>
  );
}
