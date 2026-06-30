/**
 * App.tsx — the Agent View shell.
 *
 * Mission-control layout: a header rail (agent identity + phase), then three
 * instrument columns —
 *   left  : Agent state + memory + audit, and the discovered capabilities
 *   center: the chat transcript with inline ToolCallCards (the invoke lifecycle —
 *           the visual centerpiece)
 *   right : the orchestration DAG (shown once an orchestration.board arrives)
 *
 * Two run modes (toggle in the header):
 *   DEMO  — replay the local hardcoded mock session (zero setup, drives the e2e)
 *   LIVE  — POST /api/chat and consume the real backend SSE stream
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { AgentEvent } from './contract';
import { reducer, initialState, type StoreAction } from './store';
import { streamChat } from './sse';
import { replaySampleSession } from './mock/sample-session';
import { ChatPanel } from './components/Chat/ChatPanel';
import { CapabilitiesPanel } from './components/Capabilities/CapabilitiesPanel';
import { AgentStatePanel } from './components/AgentState/AgentStatePanel';
import { OrchestrationBoard } from './components/Orchestration/OrchestrationBoard';
import { GraphView } from './components/Graph/GraphView';

type Mode = 'demo' | 'live';
type Theme = 'dark' | 'light';
type View = 'list' | 'graph';

const THEME_KEY = 'plexus-agent-view.theme';

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* localStorage may be unavailable */
  }
  return 'dark';
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [mode, setMode] = useState<Mode>('demo');
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [view, setView] = useState<View>('list');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);

  // apply + persist the theme on the document root (drives every CSS var)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const dispatchEvent = useCallback((e: AgentEvent) => {
    dispatch(e as StoreAction);
    if (e.type === 'session.end' || e.type === 'error') setBusy(false);
  }, []);

  const handleSend = useCallback(
    (text: string) => {
      // cancel any in-flight run, reset transcript for a clean demo each time
      abortRef.current?.();
      dispatch({ type: '__reset' });
      dispatch({ type: '__user.send', id: `u-${Date.now()}`, text });
      setBusy(true);

      if (mode === 'demo') {
        abortRef.current = replaySampleSession(dispatchEvent);
      } else {
        abortRef.current = streamChat(
          { message: text, mode: 'live' },
          {
            onEvent: dispatchEvent,
            onError: (err) => {
              dispatch({ type: 'error', message: err.message });
              setBusy(false);
            },
            onDone: () => setBusy(false),
          },
        );
      }
    },
    [mode, dispatchEvent],
  );

  const hasBoard = !!state.board;

  const modeBtn = useMemo(
    () =>
      (['demo', 'live'] as Mode[]).map((m) => (
        <button
          key={m}
          onClick={() => setMode(m)}
          data-testid={`mode-${m}`}
          className="font-tele rounded-[var(--r-sm)] px-[10px] py-[5px] text-[9px] uppercase tracking-[0.14em]"
          style={
            mode === m
              ? { background: 'linear-gradient(180deg, var(--panel-hi), var(--panel))', border: '1px solid var(--tint-ready-line)', color: 'var(--ready)' }
              : { background: 'transparent', border: '1px solid transparent', color: 'var(--ink-faint)' }
          }
        >
          {m}
        </button>
      )),
    [mode],
  );

  return (
    <div className="flex h-full flex-col">
      {/* header rail */}
      <header
        className="flex flex-none items-center gap-3 px-4"
        style={{ height: 54, background: 'linear-gradient(180deg, var(--panel-hi), var(--panel))', borderBottom: '1px solid var(--hair)' }}
      >
        <div className="flex items-center gap-[10px] pr-4" style={{ borderRight: '1px solid var(--hair-soft)' }}>
          <span className="beacon" />
          <div className="flex flex-col leading-none">
            <span className="text-[13px] font-bold uppercase tracking-[0.15em]" style={{ color: 'var(--ink)' }}>
              Plexus
            </span>
            <span className="font-tele mt-[3px] text-[8px] uppercase tracking-[0.26em]" style={{ color: 'var(--ink-faint)' }}>
              agent view
            </span>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-tele text-[8px] uppercase tracking-[0.22em]" style={{ color: 'var(--ink-faint)' }}>
            agent
          </span>
          <span className="truncate text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
            {state.session?.agentName ?? 'Plexus DeepAgent'}
            {state.session?.model && (
              <span className="font-tele ml-2 text-[10px] font-normal" style={{ color: 'var(--ink-faint)' }}>
                {state.session.model}
              </span>
            )}
          </span>
        </div>

        {/* view toggle — LIST | GRAPH */}
        <div className="flex items-center gap-1 rounded-[var(--r-md)] p-[3px]" style={{ background: 'var(--inset)', border: '1px solid var(--hair)' }}>
          {(['list', 'graph'] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              data-testid={`view-${v}`}
              aria-pressed={view === v}
              className="font-tele inline-flex items-center gap-[6px] rounded-[var(--r-sm)] px-[10px] py-[5px] text-[9px] uppercase tracking-[0.14em]"
              style={
                view === v
                  ? { background: 'linear-gradient(180deg, var(--panel-hi), var(--panel))', border: '1px solid var(--tint-ready-line)', color: 'var(--ready)' }
                  : { background: 'transparent', border: '1px solid transparent', color: 'var(--ink-faint)' }
              }
            >
              <span className="text-[11px] leading-none">{v === 'list' ? '☰' : '⬡'}</span>
              {v}
            </button>
          ))}
        </div>

        {/* mode toggle — demo | live */}
        <div className="flex items-center gap-1 rounded-[var(--r-md)] p-[3px]" style={{ background: 'var(--inset)', border: '1px solid var(--hair)' }}>
          {modeBtn}
        </div>

        {/* theme toggle — shows the destination glyph (☀ when dark → day) */}
        <button
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          data-testid="theme-toggle"
          aria-pressed={theme === 'light'}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-[var(--r-md)] text-[14px]"
          style={{ background: 'var(--inset)', border: '1px solid var(--hair)', color: 'var(--ink-dim)' }}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>

      {/* three-column stage */}
      <div className="flex min-h-0 flex-1">
        {/* left rail */}
        <aside
          className="scrollthin flex w-[296px] flex-none flex-col overflow-y-auto"
          style={{ background: 'linear-gradient(180deg, var(--panel), var(--ground) 92%)', borderRight: '1px solid var(--hair)' }}
        >
          <AgentStatePanel
            phase={state.phase}
            phaseNote={state.phaseNote}
            memory={state.memory}
            audit={state.audit}
            agentName={state.session?.agentName}
            model={state.session?.model}
          />
          <CapabilitiesPanel capabilities={state.capabilities} />
        </aside>

        {view === 'list' ? (
          <>
            {/* center — the centerpiece */}
            <ChatPanel state={state} onSend={handleSend} busy={busy} />

            {/* right — orchestration DAG (only when a board exists) */}
            {hasBoard && (
              <aside
                className="flex w-[460px] flex-none flex-col"
                style={{ background: 'linear-gradient(180deg, var(--panel), var(--ground) 96%)', borderLeft: '1px solid var(--hair)' }}
              >
                <OrchestrationBoard board={state.board!} />
              </aside>
            )}
          </>
        ) : (
          /* GRAPH view — the two xyflow graphs (capability map + activity flow) */
          <GraphView state={state} />
        )}
      </div>
    </div>
  );
}
