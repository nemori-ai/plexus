/**
 * store.ts — a pure reducer over the AgentEvent stream → the UI view-model.
 *
 * Every visible piece of the Agent View is derived here from the contract events.
 * The reducer is deliberately framework-free (no React) so it is trivially testable
 * and so the same fold runs over the live SSE stream and the local mock replay.
 */

import type {
  AgentEvent,
  AgentPhase,
  Board,
  CapabilityCard,
  MemoryItem,
} from './contract';

// ── tool-call lifecycle ───────────────────────────────────────────────────────
// The ToolCallCard renders these states; they ARE the Plexus invoke lifecycle.
export type ToolCallStatus =
  | 'starting' // tool.call.start seen; agent is about to invoke
  | 'grant_pending' // human must approve in Plexus (the gate is visible & WAITING)
  | 'approved' // grant_resolved: approved — invoke proceeds
  | 'denied' // grant_resolved: denied — invoke aborted
  | 'invoking' // streaming tool.call.delta output
  | 'ok' // tool.call.result ok:true
  | 'error'; // tool.call.result ok:false

export interface ToolCallState {
  callId: string;
  capabilityId: string;
  label: string;
  input: unknown;
  provenance: string;
  sensitivity: string;
  source: string;
  status: ToolCallStatus;
  grant?: { pendingId: string; summary: string; verbs: string[] };
  decision?: 'approved' | 'denied';
  /** accumulated tool.call.delta chunks (e.g. CC/Codex stdout) */
  outputLog: string;
  result?: { ok: boolean; output?: unknown; error?: string; auditId: string };
  /** monotonic lifecycle markers (a logical clock, not wall time) used by the
   *  Activity-flow graph to detect concurrency: two calls overlap iff their
   *  [tStart, tEnd] intervals intersect (an unfinished call's tEnd is open). */
  tStart: number;
  tEnd?: number;
}

// ── chat timeline ─────────────────────────────────────────────────────────────
// A single ordered stream interleaving assistant/user messages with tool-call
// cards, so the invoke lifecycle renders inline where the agent reached for it.
export interface ChatMessage {
  kind: 'message';
  id: string;
  role: 'user' | 'assistant';
  text: string;
  streaming: boolean;
}
export interface ChatToolCall {
  kind: 'tool';
  callId: string;
}
export type TimelineItem = ChatMessage | ChatToolCall;

export interface AuditEntry {
  id: string;
  capabilityId: string;
  outcome: string;
  at: string;
}

export interface AppState {
  session: { sessionId: string; agentName: string; model: string; ts: string } | null;
  phase: AgentPhase;
  phaseNote?: string;
  timeline: TimelineItem[];
  toolCalls: Record<string, ToolCallState>;
  capabilities: CapabilityCard[];
  memory: MemoryItem[];
  board: Board | null;
  audit: AuditEntry[];
  error: string | null;
  ended: boolean;
  endReason?: string;
  /** logical clock, advanced on every tool lifecycle transition */
  clock: number;
}

export const initialState: AppState = {
  session: null,
  phase: 'idle',
  phaseNote: undefined,
  timeline: [],
  toolCalls: {},
  capabilities: [],
  memory: [],
  board: null,
  audit: [],
  error: null,
  ended: false,
  clock: 0,
};

/** Local-only action: the user sent a message (not part of the SSE contract). */
export type LocalAction =
  | { type: '__user.send'; id: string; text: string }
  | { type: '__reset' };

export type StoreAction = AgentEvent | LocalAction;

function activeAssistant(state: AppState): ChatMessage | null {
  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const item = state.timeline[i];
    if (item.kind === 'tool') break; // a tool call closes the current bubble
    if (item.kind === 'message' && item.role === 'assistant' && item.streaming) return item;
    if (item.kind === 'message') break;
  }
  return null;
}

function patchTool(
  state: AppState,
  callId: string,
  patch: Partial<ToolCallState>,
): Record<string, ToolCallState> {
  const prev = state.toolCalls[callId];
  if (!prev) return state.toolCalls;
  return { ...state.toolCalls, [callId]: { ...prev, ...patch } };
}

export function reducer(state: AppState, action: StoreAction): AppState {
  switch (action.type) {
    case '__reset':
      return initialState;

    case '__user.send':
      return {
        ...state,
        timeline: [
          ...state.timeline,
          { kind: 'message', id: action.id, role: 'user', text: action.text, streaming: false },
        ],
      };

    case 'session.start':
      return {
        ...state,
        session: {
          sessionId: action.sessionId,
          agentName: action.agentName,
          model: action.model,
          ts: action.ts,
        },
        ended: false,
        error: null,
      };

    case 'agent.state':
      return { ...state, phase: action.phase, phaseNote: action.note };

    case 'assistant.delta': {
      const cur = activeAssistant(state);
      if (cur) {
        const timeline = state.timeline.map((it) =>
          it === cur ? { ...cur, text: cur.text + action.text } : it,
        );
        return { ...state, timeline };
      }
      // begin a fresh streaming assistant bubble
      const id = `a-${state.timeline.length}-${Date.now()}`;
      return {
        ...state,
        timeline: [
          ...state.timeline,
          { kind: 'message', id, role: 'assistant', text: action.text, streaming: true },
        ],
      };
    }

    case 'assistant.message': {
      const cur = activeAssistant(state);
      if (cur) {
        const timeline = state.timeline.map((it) =>
          it === cur ? { ...cur, id: action.id, text: action.text, streaming: false } : it,
        );
        return { ...state, timeline };
      }
      return {
        ...state,
        timeline: [
          ...state.timeline,
          { kind: 'message', id: action.id, role: 'assistant', text: action.text, streaming: false },
        ],
      };
    }

    case 'capabilities.discovered':
      return { ...state, capabilities: action.capabilities };

    case 'tool.call.start': {
      // finalize any streaming assistant bubble so the card renders after it
      const timeline = state.timeline.map((it) =>
        it.kind === 'message' && it.role === 'assistant' && it.streaming
          ? { ...it, streaming: false }
          : it,
      );
      const clock = state.clock + 1;
      const tool: ToolCallState = {
        callId: action.callId,
        capabilityId: action.capabilityId,
        label: action.label,
        input: action.input,
        provenance: action.provenance,
        sensitivity: action.sensitivity,
        source: action.source,
        status: 'starting',
        outputLog: '',
        tStart: clock,
      };
      return {
        ...state,
        clock,
        timeline: [...timeline, { kind: 'tool', callId: action.callId }],
        toolCalls: { ...state.toolCalls, [action.callId]: tool },
      };
    }

    case 'tool.call.grant_pending':
      return {
        ...state,
        toolCalls: patchTool(state, action.callId, {
          status: 'grant_pending',
          grant: { pendingId: action.pendingId, summary: action.summary, verbs: action.verbs },
        }),
      };

    case 'tool.call.grant_resolved': {
      const denied = action.decision !== 'approved';
      const clock = denied ? state.clock + 1 : state.clock;
      return {
        ...state,
        clock,
        toolCalls: patchTool(state, action.callId, {
          status: denied ? 'denied' : 'approved',
          decision: action.decision,
          ...(denied ? { tEnd: clock } : {}),
        }),
      };
    }

    case 'tool.call.delta': {
      const prev = state.toolCalls[action.callId];
      if (!prev) return state;
      const terminal = prev.status === 'ok' || prev.status === 'error' || prev.status === 'denied';
      return {
        ...state,
        toolCalls: patchTool(state, action.callId, {
          outputLog: prev.outputLog + action.chunk,
          status: terminal ? prev.status : 'invoking',
        }),
      };
    }

    case 'tool.call.result': {
      const clock = state.clock + 1;
      return {
        ...state,
        clock,
        toolCalls: patchTool(state, action.callId, {
          status: action.ok ? 'ok' : 'error',
          tEnd: clock,
          result: {
            ok: action.ok,
            output: action.output,
            error: action.error,
            auditId: action.auditId,
          },
        }),
      };
    }

    case 'orchestration.board':
      return { ...state, board: action.board as Board };

    case 'memory.update': {
      // upsert by key, preserving first-seen order
      const byKey = new Map(state.memory.map((m) => [m.key, m]));
      for (const item of action.items) byKey.set(item.key, item);
      return { ...state, memory: Array.from(byKey.values()) };
    }

    case 'audit.event':
      return {
        ...state,
        audit: [
          ...state.audit,
          { id: action.id, capabilityId: action.capabilityId, outcome: action.outcome, at: action.at },
        ],
      };

    case 'session.end':
      return { ...state, ended: true, endReason: action.reason, phase: 'done' };

    case 'error':
      return { ...state, error: action.message };

    default:
      return state;
  }
}
