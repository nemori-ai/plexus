/**
 * ChatPanel.tsx — the center column: the streaming transcript + the composer.
 * The transcript is where the invoke lifecycle (ToolCallCard) lives, so this is
 * the visual centerpiece of the Agent View.
 */

import type { AppState } from '../../store';
import { Composer } from './Composer';
import { MessageList } from './MessageList';

export function ChatPanel({
  state,
  onSend,
  busy,
}: {
  state: AppState;
  onSend: (text: string) => void;
  busy: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <MessageList state={state} />
      <Composer onSend={onSend} disabled={busy} busy={busy} />
    </div>
  );
}
