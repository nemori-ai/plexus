/**
 * MessageList.tsx — the streaming chat transcript. Walks the store timeline and
 * renders each item: user bubbles, assistant turns (markdown), and inline
 * ToolCallCards (the invoke lifecycle, rendered exactly where the agent reached
 * for the capability).
 */

import { useEffect, useRef } from 'react';
import type { AppState, TimelineItem } from '../../store';
import { Markdown } from './Markdown';
import { ToolCallCard } from './ToolCallCard';

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end" data-testid="user-message">
      <div
        className="max-w-[80%] rounded-[var(--r-md)] px-[13px] py-[9px] text-[13px] leading-[1.5]"
        style={{ background: 'var(--tint-ready-bg)', border: '1px solid var(--tint-ready-line-soft)', color: 'var(--ink)' }}
      >
        {text}
      </div>
    </div>
  );
}

function AssistantTurn({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="flex flex-col gap-1" data-testid="assistant-message">
      <div className="font-tele text-[8px] uppercase tracking-[0.2em]" style={{ color: 'var(--ink-faint)' }}>
        agent
      </div>
      <div className="text-[13px]">
        <Markdown text={text} />
        {streaming && (
          <span
            className="ml-[2px] inline-block align-middle"
            style={{ width: 7, height: 14, background: 'var(--ready)', opacity: 0.8, animation: 'beacon 1.1s steps(2) infinite' }}
          />
        )}
      </div>
    </div>
  );
}

export function MessageList({ state }: { state: AppState }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [state.timeline]);

  const render = (item: TimelineItem) => {
    if (item.kind === 'tool') {
      const tool = state.toolCalls[item.callId];
      return tool ? <ToolCallCard key={`tool-${item.callId}`} tool={tool} /> : null;
    }
    if (item.role === 'user') return <UserBubble key={item.id} text={item.text} />;
    return <AssistantTurn key={item.id} text={item.text} streaming={item.streaming} />;
  };

  return (
    <div className="scrollthin flex-1 overflow-y-auto px-5 py-5">
      <div className="mx-auto flex max-w-[760px] flex-col gap-4">
        {state.timeline.length === 0 && (
          <div className="mt-10 text-center text-[13px]" style={{ color: 'var(--ink-faint)' }}>
            Ask the agent to build something. It will install Plexus, discover this machine’s
            capabilities, and orchestrate Claude Code + Codex — pausing for your approval on the
            powerful steps.
          </div>
        )}
        {state.timeline.map(render)}
        {state.error && (
          <div
            className="rounded-[var(--r-md)] px-3 py-2 text-[12px]"
            style={{ background: 'var(--tint-failed-bg)', border: '1px solid var(--tint-failed-line)', color: 'var(--failed)' }}
          >
            {state.error}
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
