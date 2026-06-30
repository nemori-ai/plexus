/**
 * AgentStatePanel.tsx — the agent's live phase (discovering / thinking /
 * awaiting_grant / invoking / idle / done) plus its memory.update items and a
 * compact audit trail. The "who/why/state" rail of the instrument.
 */

import type { AgentPhase, MemoryItem } from '../../contract';
import type { AuditEntry } from '../../store';

const PHASE_META: Record<AgentPhase, { label: string; color: string; pulse?: boolean }> = {
  discovering: { label: 'discovering', color: 'var(--ready)', pulse: true },
  thinking: { label: 'thinking', color: 'var(--ready)', pulse: true },
  awaiting_grant: { label: 'awaiting your approval', color: 'var(--alert)', pulse: true },
  invoking: { label: 'invoking', color: 'var(--inflight)', pulse: true },
  idle: { label: 'idle', color: 'var(--blocked)' },
  done: { label: 'done', color: 'var(--done)' },
};

export function AgentStatePanel({
  phase,
  phaseNote,
  memory,
  audit,
  agentName,
  model,
}: {
  phase: AgentPhase;
  phaseNote?: string;
  memory: MemoryItem[];
  audit: AuditEntry[];
  agentName?: string;
  model?: string;
}) {
  const meta = PHASE_META[phase];
  return (
    <section className="flex flex-col" style={{ borderBottom: '1px solid var(--hair)' }}>
      <div
        className="font-tele px-3 py-[9px] text-[8px] uppercase tracking-[0.22em]"
        style={{ color: 'var(--ink-faint)', borderBottom: '1px solid var(--hair-soft)' }}
      >
        Agent state
      </div>

      <div className="px-3 py-3">
        <div
          className="flex items-center gap-2 rounded-[var(--r-md)] px-3 py-[10px]"
          data-testid="agent-phase"
          data-phase={phase}
          style={{ background: 'var(--inset)', border: '1px solid var(--hair-soft)' }}
        >
          <span className={`lamp ${meta.pulse ? 'pulse' : ''}`} style={{ ['--lamp' as string]: meta.color }} />
          <div className="min-w-0">
            <div className="font-tele text-[10px] uppercase tracking-[0.14em]" style={{ color: meta.color }}>
              {meta.label}
            </div>
            {phaseNote && (
              <div className="mt-[2px] truncate text-[11px]" style={{ color: 'var(--ink-dim)' }} title={phaseNote}>
                {phaseNote}
              </div>
            )}
          </div>
        </div>

        {(agentName || model) && (
          <div className="font-tele mt-2 flex items-center justify-between text-[9px] uppercase tracking-[0.08em]" style={{ color: 'var(--ink-faint)' }}>
            <span style={{ color: 'var(--ink-dim)' }}>{agentName}</span>
            <span>{model}</span>
          </div>
        )}
      </div>

      {/* memory */}
      <div className="px-3 pb-3">
        <div className="font-tele mb-2 text-[8px] uppercase tracking-[0.2em]" style={{ color: 'var(--ink-faint)' }}>
          Memory
        </div>
        {memory.length === 0 ? (
          <div className="text-[11px] italic" style={{ color: 'var(--ink-faint)' }}>
            empty
          </div>
        ) : (
          <div className="flex flex-col gap-[6px]" data-testid="memory-list">
            {memory.map((m) => (
              <div key={m.key} className="flex items-baseline gap-2" data-testid="memory-item">
                <span className="font-tele text-[9px] uppercase tracking-[0.06em]" style={{ color: 'var(--ink-faint)', flex: '0 0 auto' }}>
                  {m.key}
                </span>
                <span className="flex-1 text-[11px]" style={{ color: 'var(--ink-dim)' }}>
                  {m.value}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* audit trail */}
      {audit.length > 0 && (
        <div className="px-3 pb-3">
          <div className="font-tele mb-2 text-[8px] uppercase tracking-[0.2em]" style={{ color: 'var(--ink-faint)' }}>
            Audit log
          </div>
          <div className="flex flex-col gap-[6px]">
            {audit.map((a) => (
              <div key={a.id} className="flex items-center gap-2" data-testid="audit-entry">
                <span className="lamp" style={{ ['--lamp' as string]: 'var(--done)', width: 6, height: 6 }} />
                <span className="flex-1 truncate text-[11px]" style={{ color: 'var(--ink-dim)' }} title={`${a.capabilityId} · ${a.outcome}`}>
                  {a.capabilityId}
                </span>
                <span className="font-tele text-[8px]" style={{ color: 'var(--ink-faint)' }}>
                  {a.id}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
