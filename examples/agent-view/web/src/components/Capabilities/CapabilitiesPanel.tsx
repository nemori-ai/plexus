/**
 * CapabilitiesPanel.tsx — "what the agent can do after installing Plexus".
 * Renders the discovered capabilities grouped by source/provenance, each with a
 * sensitivity badge and its grant verbs. This is the DISCOVER half of the
 * lifecycle (the manifest the agent compiled into skills).
 */

import { useMemo } from 'react';
import type { CapabilityCard } from '../../contract';

const SENS_COLOR: Record<string, string> = {
  low: 'var(--sens-low)',
  medium: 'var(--sens-medium)',
  high: 'var(--sens-high)',
};
function sensColor(s: string) {
  return SENS_COLOR[s.toLowerCase()] ?? 'var(--ink-dim)';
}

function CapRow({ cap }: { cap: CapabilityCard }) {
  return (
    <div
      data-testid="capability-row"
      className="rounded-[var(--r-sm)] px-[10px] py-[8px]"
      style={{ background: 'var(--inset)', border: '1px solid var(--hair-soft)' }}
    >
      <div className="flex items-center gap-2">
        <span className="lamp" style={{ ['--lamp' as string]: sensColor(cap.sensitivity), width: 7, height: 7 }} />
        <span className="flex-1 truncate text-[12px] font-medium" style={{ color: 'var(--ink)' }}>
          {cap.label}
        </span>
        <span
          className="font-tele text-[8px] uppercase tracking-[0.1em]"
          style={{ color: sensColor(cap.sensitivity) }}
          title="sensitivity"
        >
          {cap.sensitivity}
        </span>
      </div>
      <div className="font-tele mt-[3px] text-[9px]" style={{ color: 'var(--ink-faint)' }}>
        {cap.id}
      </div>
      {cap.describe && (
        <div className="mt-[5px] text-[11px] leading-[1.4]" style={{ color: 'var(--ink-dim)' }}>
          {cap.describe}
        </div>
      )}
      <div className="mt-[6px] flex flex-wrap gap-[5px]">
        {cap.grants.map((g) => (
          <span
            key={g}
            className="font-tele rounded-[var(--r-sm)] px-[6px] py-[1px] text-[8px] uppercase tracking-[0.08em]"
            style={{ background: 'var(--chip-bg)', border: '1px solid var(--hair-soft)', color: 'var(--ink-dim)' }}
          >
            {g}
          </span>
        ))}
      </div>
    </div>
  );
}

export function CapabilitiesPanel({ capabilities }: { capabilities: CapabilityCard[] }) {
  const groups = useMemo(() => {
    const by = new Map<string, CapabilityCard[]>();
    for (const c of capabilities) {
      const key = `${c.source}`;
      if (!by.has(key)) by.set(key, []);
      by.get(key)!.push(c);
    }
    return Array.from(by.entries());
  }, [capabilities]);

  return (
    <section className="flex flex-col">
      <div
        className="font-tele flex items-center justify-between px-3 py-[9px] text-[8px] uppercase tracking-[0.22em]"
        style={{ color: 'var(--ink-faint)', borderBottom: '1px solid var(--hair-soft)' }}
      >
        <span>Discovered capabilities</span>
        <span style={{ color: 'var(--ink-dim)' }}>{capabilities.length}</span>
      </div>
      {capabilities.length === 0 ? (
        <div className="px-3 py-4 text-[11px] italic" style={{ color: 'var(--ink-faint)' }}>
          Nothing discovered yet — the agent reads the host manifest after installing Plexus.
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-3 py-3">
          {groups.map(([source, caps]) => (
            <div key={source} className="flex flex-col gap-[6px]">
              <div className="font-tele flex items-center gap-2 text-[8px] uppercase tracking-[0.16em]" style={{ color: 'var(--ink-faint)' }}>
                <span>{source}</span>
                <span style={{ flex: 1, height: 1, background: 'var(--hair-soft)' }} />
                <span style={{ color: 'var(--ink-dim)' }}>{caps[0]?.provenance}</span>
              </div>
              {caps.map((c) => (
                <CapRow key={c.id} cap={c} />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
