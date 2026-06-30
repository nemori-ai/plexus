/**
 * Composer.tsx — the message input. Submitting starts a run (live SSE or mock
 * replay, depending on the App-level mode toggle).
 */

import { useState } from 'react';

export function Composer({
  onSend,
  disabled,
  busy,
}: {
  onSend: (text: string) => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const [text, setText] = useState('');

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText('');
  };

  return (
    <div className="px-5 pb-4 pt-2" style={{ borderTop: '1px solid var(--hair)' }}>
      <div className="mx-auto flex max-w-[760px] items-end gap-2">
        <textarea
          data-testid="composer-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Ask the agent to build something…"
          className="scrollthin max-h-[140px] min-h-[42px] flex-1 resize-none rounded-[var(--r-md)] px-3 py-[10px] text-[13px] outline-none"
          style={{ background: 'var(--inset)', border: '1px solid var(--hair)', color: 'var(--ink)' }}
        />
        <button
          data-testid="composer-send"
          onClick={submit}
          disabled={disabled || !text.trim()}
          className="font-tele h-[42px] rounded-[var(--r-md)] px-4 text-[10px] uppercase tracking-[0.14em] disabled:opacity-40"
          style={{
            background: 'linear-gradient(180deg, var(--panel-hi), var(--panel))',
            border: '1px solid var(--tint-ready-line)',
            color: 'var(--ready)',
          }}
        >
          {busy ? 'running' : 'send'}
        </button>
      </div>
    </div>
  );
}
