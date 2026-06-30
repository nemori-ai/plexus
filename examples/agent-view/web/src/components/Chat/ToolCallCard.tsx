/**
 * ToolCallCard.tsx — THE differentiator.
 *
 * A "tool call" in this chat IS a Plexus invoke. This card renders the full
 * lifecycle from the contract events (ARCHITECTURE.md §"Lifecycle mapping"):
 *
 *   start  → capabilityId + input + provenance/sensitivity/source badges
 *   grant_pending → a VISIBLE human-approval gate ("waiting for you to approve
 *                   in Plexus") that holds, showing the gateway-authored summary
 *   grant_resolved → approved / denied
 *   delta* → streamed invoke stdout (e.g. Claude Code / Codex)
 *   result → ok/error + the auditId (the "audited result" proof)
 *
 * This is the "the agent cannot self-authorize; the human approved; here's the
 * audited result" story, made visible.
 */

import { useState } from 'react';
import type { ToolCallState, ToolCallStatus } from '../../store';

const SENS_COLOR: Record<string, string> = {
  low: 'var(--sens-low)',
  medium: 'var(--sens-medium)',
  high: 'var(--sens-high)',
};

function sensColor(s: string): string {
  return SENS_COLOR[s.toLowerCase()] ?? 'var(--ink-dim)';
}

function StatusIcon({ status }: { status: ToolCallStatus }) {
  if (status === 'ok')
    return (
      <span className="text-[15px] leading-none" style={{ color: 'var(--done)' }} title="completed">
        ✓
      </span>
    );
  if (status === 'error' || status === 'denied')
    return (
      <span className="text-[15px] leading-none" style={{ color: 'var(--failed)' }} title={status}>
        ✕
      </span>
    );
  if (status === 'grant_pending')
    return <span className="gate-dot" title="awaiting human approval" />;
  return <span className="spin" title="invoking" />;
}

function Badge({
  children,
  color,
  title,
}: {
  children: React.ReactNode;
  color?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="font-tele inline-flex items-center gap-1 rounded px-[6px] py-[2px] text-[8px] uppercase tracking-[0.08em]"
      style={{
        background: 'var(--chip-bg)',
        border: '1px solid var(--hair-soft)',
        color: color ?? 'var(--ink-dim)',
      }}
    >
      {children}
    </span>
  );
}

function pretty(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const STATUS_LABEL: Record<ToolCallStatus, string> = {
  starting: 'starting',
  grant_pending: 'awaiting approval',
  approved: 'approved',
  denied: 'denied',
  invoking: 'invoking',
  ok: 'completed',
  error: 'failed',
};

export function ToolCallCard({ tool }: { tool: ToolCallState }) {
  const [open, setOpen] = useState(false);
  const gatePending = tool.status === 'grant_pending';
  const denied = tool.status === 'denied';

  return (
    <div
      data-testid="tool-call-card"
      data-call-id={tool.callId}
      data-status={tool.status}
      className="rounded-[var(--r-md)] border"
      style={{
        background: 'linear-gradient(180deg, var(--panel-hi), var(--panel))',
        borderColor: gatePending ? 'var(--tint-alert-line)' : 'var(--hair)',
      }}
    >
      {/* header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-[13px]" style={{ color: 'var(--ready)' }}>
          ⚡
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium" style={{ color: 'var(--ink)' }}>
              {tool.label}
            </span>
          </div>
          <div className="font-tele mt-[3px] flex flex-wrap items-center gap-[6px] text-[8px] uppercase tracking-[0.08em]" style={{ color: 'var(--ink-faint)' }}>
            <span style={{ color: 'var(--ink-dim)' }}>{tool.capabilityId}</span>
          </div>
        </div>
        <span
          className="font-tele text-[8px] uppercase tracking-[0.14em]"
          style={{ color: 'var(--ink-faint)' }}
        >
          {STATUS_LABEL[tool.status]}
        </span>
        <StatusIcon status={tool.status} />
      </div>

      {/* provenance / sensitivity / source / grants badges */}
      <div className="flex flex-wrap items-center gap-[6px] px-3 pb-2">
        <Badge color={sensColor(tool.sensitivity)} title="sensitivity">
          <span className="lamp" style={{ ['--lamp' as string]: sensColor(tool.sensitivity), width: 6, height: 6 }} />
          {tool.sensitivity} sensitivity
        </Badge>
        <Badge title="provenance">{tool.provenance}</Badge>
        <Badge title="source">src · {tool.source}</Badge>
        {tool.grant?.verbs?.map((v) => (
          <Badge key={v} title="requested verb" color="var(--escalated)">
            {v}
          </Badge>
        ))}
      </div>

      {/* the HUMAN-APPROVAL gate — the centerpiece */}
      {gatePending && (
        <div className="mx-3 mb-2 rounded-[var(--r-md)] px-3 py-[10px] gate-alarm" data-testid="grant-gate">
          <div className="flex items-center gap-2">
            <span className="gate-dot" />
            <span className="font-tele text-[10px] font-medium uppercase tracking-[0.14em]">
              Waiting for you to approve in Plexus
            </span>
          </div>
          {tool.grant?.summary && (
            <div className="mt-2 text-[12px] leading-[1.5]" style={{ color: 'var(--ink)' }}>
              {tool.grant.summary}
            </div>
          )}
          <div className="font-tele mt-[6px] text-[8px] uppercase tracking-[0.1em]" style={{ color: 'var(--ink-faint)' }}>
            pending · {tool.grant?.pendingId} — the agent cannot self-authorize
          </div>
        </div>
      )}

      {/* resolved-decision line */}
      {tool.decision && (
        <div className="px-3 pb-1">
          <span
            className="font-tele text-[9px] uppercase tracking-[0.1em]"
            style={{ color: tool.decision === 'approved' ? 'var(--done)' : 'var(--failed)' }}
          >
            {tool.decision === 'approved' ? '✓ human approved the grant' : '✕ human denied the grant'}
          </span>
        </div>
      )}

      {/* streamed invoke output (CC / Codex stdout) */}
      {tool.outputLog && (
        <div className="px-3 pb-2">
          <div className="font-tele mb-1 text-[8px] uppercase tracking-[0.18em]" style={{ color: 'var(--ink-faint)' }}>
            {tool.source} output
          </div>
          <pre
            data-testid="tool-output"
            className="font-tele scrollthin max-h-[180px] overflow-auto whitespace-pre-wrap break-words rounded-[var(--r-sm)] px-[10px] py-[8px] text-[10.5px] leading-[1.5]"
            style={{ background: 'var(--inset)', border: '1px solid var(--hair-soft)', color: 'var(--ink-dim)' }}
          >
            {tool.outputLog}
          </pre>
        </div>
      )}

      {/* result + auditId */}
      {tool.result && (
        <div
          className="flex flex-wrap items-center gap-2 px-3 py-[8px]"
          style={{ borderTop: '1px solid var(--hair-soft)' }}
        >
          <span
            className="font-tele text-[9px] uppercase tracking-[0.12em]"
            style={{ color: tool.result.ok ? 'var(--done)' : 'var(--failed)' }}
          >
            {tool.result.ok ? 'result · ok' : 'result · error'}
          </span>
          {tool.result.error && (
            <span className="text-[11px]" style={{ color: 'var(--failed)' }}>
              {tool.result.error}
            </span>
          )}
          <span
            data-testid="audit-id"
            className="font-tele ml-auto rounded-[var(--r-sm)] px-[6px] py-[2px] text-[9px] tracking-[0.04em]"
            style={{
              background: 'var(--tint-done-bg)',
              border: '1px solid var(--tint-done-line)',
              color: 'var(--done)',
            }}
            title="audit log entry id"
          >
            audit · {tool.result.auditId}
          </span>
        </div>
      )}

      {/* collapsible input/output detail */}
      <div className="px-3 pb-2">
        <button
          onClick={() => setOpen((o) => !o)}
          className="font-tele text-[8px] uppercase tracking-[0.14em]"
          style={{ color: 'var(--ink-faint)' }}
        >
          {open ? '▾ hide invoke detail' : '▸ invoke detail'}
        </button>
        {open && (
          <div className="mt-2 flex flex-col gap-2">
            <div>
              <div className="font-tele mb-1 text-[8px] uppercase tracking-[0.18em]" style={{ color: 'var(--ink-faint)' }}>
                input
              </div>
              <pre
                className="font-tele scrollthin max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded-[var(--r-sm)] px-[10px] py-[8px] text-[10.5px] leading-[1.5]"
                style={{ background: 'var(--inset)', border: '1px solid var(--hair-soft)', color: 'var(--ink-dim)' }}
              >
                {pretty(tool.input)}
              </pre>
            </div>
            {tool.result?.output != null && (
              <div>
                <div className="font-tele mb-1 text-[8px] uppercase tracking-[0.18em]" style={{ color: 'var(--ink-faint)' }}>
                  result output
                </div>
                <pre
                  className="font-tele scrollthin max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded-[var(--r-sm)] px-[10px] py-[8px] text-[10.5px] leading-[1.5]"
                  style={{ background: 'var(--inset)', border: '1px solid var(--hair-soft)', color: 'var(--ink-dim)' }}
                >
                  {pretty(tool.result.output)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>

      {denied && (
        <div className="px-3 pb-2 text-[11px]" style={{ color: 'var(--failed)' }}>
          Invoke aborted — the grant was denied. The agent did not run.
        </div>
      )}
    </div>
  );
}
