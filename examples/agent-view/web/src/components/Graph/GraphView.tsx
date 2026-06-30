/**
 * GraphView.tsx — the GRAPH view's central stage. A sub-toggle switches between
 * the two graphs, both built on the same xyflow + dagre setup as the
 * Orchestration board:
 *
 *   CAPABILITY MAP — static topology: Source → Capability (what the agent can reach)
 *   ACTIVITY FLOW  — dynamic lifecycle: session → invokes with live status + parallelism
 */

import { useState } from 'react';
import type { AppState } from '../../store';
import { CapabilityGraph } from './CapabilityGraph';
import { ActivityGraph } from './ActivityGraph';

type GraphMode = 'capabilities' | 'activity';

const TABS: { id: GraphMode; label: string; glyph: string }[] = [
  { id: 'capabilities', label: 'capability map', glyph: '⬡' },
  { id: 'activity', label: 'activity flow', glyph: '⌁' },
];

export function GraphView({ state }: { state: AppState }) {
  const [graph, setGraph] = useState<GraphMode>('capabilities');

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="graph-view">
      <div
        className="flex flex-none items-center gap-2 px-3 py-[9px]"
        style={{ borderBottom: '1px solid var(--hair-soft)' }}
      >
        <span className="font-tele text-[8px] uppercase tracking-[0.22em]" style={{ color: 'var(--ink-faint)' }}>
          graph
        </span>
        <div
          className="ml-1 flex items-center gap-1 rounded-[var(--r-md)] p-[3px]"
          style={{ background: 'var(--inset)', border: '1px solid var(--hair)' }}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setGraph(t.id)}
              data-testid={`graph-tab-${t.id}`}
              aria-pressed={graph === t.id}
              className="font-tele inline-flex items-center gap-[6px] rounded-[var(--r-sm)] px-[11px] py-[5px] text-[9.5px] uppercase tracking-[0.14em]"
              style={
                graph === t.id
                  ? { background: 'linear-gradient(180deg, var(--panel-hi), var(--panel))', border: '1px solid var(--tint-ready-line)', color: 'var(--ready)' }
                  : { background: 'transparent', border: '1px solid transparent', color: 'var(--ink-faint)' }
              }
            >
              <span className="text-[12px] leading-none">{t.glyph}</span>
              {t.label}
            </button>
          ))}
        </div>
        <span className="font-tele ml-auto text-[8px] uppercase tracking-[0.14em]" style={{ color: 'var(--ink-faint)' }}>
          {graph === 'capabilities'
            ? `${state.capabilities.length} capabilities`
            : `${Object.keys(state.toolCalls).length} invokes`}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        {graph === 'capabilities' ? (
          <CapabilityGraph capabilities={state.capabilities} />
        ) : (
          <ActivityGraph state={state} />
        )}
      </div>
    </div>
  );
}
