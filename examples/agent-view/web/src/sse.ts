/**
 * sse.ts — consume the backend's `POST /api/chat` Server-Sent-Events stream.
 *
 * The contract uses POST (with a JSON body) rather than the EventSource GET-only
 * API, so we read the response body as a stream and parse `data: <JSON>\n\n` frames
 * by hand. Each frame is one AgentEvent (see contract.ts).
 */

import type { AgentEvent, ChatRequest } from './contract';

export interface ChatStreamHandlers {
  onEvent: (event: AgentEvent) => void;
  onError?: (err: Error) => void;
  onDone?: () => void;
}

/**
 * Start a chat run. Returns an `abort` function that cancels the in-flight stream.
 */
export function streamChat(req: ChatRequest, handlers: ChatStreamHandlers): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`chat request failed: HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = drainFrames(buffer, handlers);
      }
      // flush any trailing frame
      drainFrames(buffer + '\n\n', handlers);
      handlers.onDone?.();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      handlers.onError?.(err as Error);
    }
  })();

  return () => controller.abort();
}

/** Split a buffer into complete `\n\n`-terminated SSE frames; return the remainder. */
function drainFrames(buffer: string, handlers: ChatStreamHandlers): string {
  let idx: number;
  // SSE frames are separated by a blank line (\n\n). Tolerate \r\n too.
  // eslint-disable-next-line no-cond-assign
  while ((idx = indexOfFrameEnd(buffer)) !== -1) {
    const frame = buffer.slice(0, idx);
    buffer = buffer.slice(idx).replace(/^(\r?\n)+/, '');
    const event = parseFrame(frame);
    if (event) handlers.onEvent(event);
  }
  return buffer;
}

function indexOfFrameEnd(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

/** Parse the `data:` payload(s) of one SSE frame into an AgentEvent. */
function parseFrame(frame: string): AgentEvent | null {
  const dataLines = frame
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  const json = dataLines.join('\n');
  if (!json || json === '[DONE]') return null;
  try {
    return JSON.parse(json) as AgentEvent;
  } catch {
    return null;
  }
}
