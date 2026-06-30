/**
 * contract.ts — the Plexus Agent-View EVENT CONTRACT (TS side).
 *
 * MUST mirror backend/events.py 1:1. See examples/agent-view/ARCHITECTURE.md §"THE
 * EVENT CONTRACT". The backend streams `text/event-stream`; each `data:` line is one
 * JSON-encoded AgentEvent, discriminated on `type`.
 *
 * The lifecycle these events describe (discover → grant(pending → human approves) →
 * invoke → audit) is THE thing this UI makes visible — a chat "tool call" IS a Plexus
 * invoke. See ToolCallCard for the lifecycle rendering.
 */

export type AgentPhase =
  | 'discovering'
  | 'thinking'
  | 'awaiting_grant'
  | 'invoking'
  | 'idle'
  | 'done';

export interface CapabilityCard {
  id: string;
  label: string;
  source: string;
  provenance: string;
  sensitivity: string;
  grants: string[];
  describe?: string;
}

export interface MemoryItem {
  key: string;
  value: string;
  kind?: string;
}

export type AgentEvent =
  | { type: 'session.start'; sessionId: string; agentName: string; model: string; ts: string }
  | { type: 'agent.state'; phase: AgentPhase; note?: string }
  | { type: 'assistant.delta'; text: string }
  | { type: 'assistant.message'; id: string; text: string }
  | { type: 'capabilities.discovered'; capabilities: CapabilityCard[] }
  | {
      type: 'tool.call.start';
      callId: string;
      capabilityId: string;
      label: string;
      input: unknown;
      provenance: string;
      sensitivity: string;
      source: string;
    }
  | {
      type: 'tool.call.grant_pending';
      callId: string;
      pendingId: string;
      summary: string;
      verbs: string[];
    }
  | { type: 'tool.call.grant_resolved'; callId: string; decision: 'approved' | 'denied' }
  | { type: 'tool.call.delta'; callId: string; chunk: string }
  | {
      type: 'tool.call.result';
      callId: string;
      ok: boolean;
      output?: unknown;
      error?: string;
      auditId: string;
    }
  | { type: 'orchestration.board'; board: unknown }
  | { type: 'memory.update'; items: MemoryItem[] }
  | { type: 'audit.event'; id: string; capabilityId: string; outcome: string; at: string }
  | { type: 'session.end'; reason?: string }
  | { type: 'error'; message: string };

export type AgentEventType = AgentEvent['type'];

/** Request body for POST /api/chat. */
export interface ChatRequest {
  message: string;
  mode?: 'demo' | 'live';
  scenario?: string;
}

/** Response of GET /api/health. */
export interface HealthResponse {
  ok: boolean;
  mode: 'demo' | 'live';
}

// ───────────────────────────────────────────────────────────────────────────
// cc-master/v1 board shape (the orchestration.board payload). A loose mirror of
// cc-master's board schema — only the fields the DAG view reads. `board` arrives
// as `unknown` on the wire; OrchestrationBoard narrows it through this type.
// ───────────────────────────────────────────────────────────────────────────

export type BoardTaskStatus =
  | 'ready'
  | 'in_flight'
  | 'blocked'
  | 'done'
  | 'verified'
  | 'uncertain'
  | 'escalated'
  | 'failed'
  | 'stale';

export interface BoardTask {
  id: string;
  status: BoardTaskStatus;
  deps?: string[];
  title?: string;
  mechanism?: string;
  handle?: string;
  artifact?: string;
  blocked_on?: string;
  kind?: string;
  parent?: string;
  verified?: boolean;
}

export interface Board {
  schema?: string;
  goal?: string;
  wip_limit?: number;
  tasks: BoardTask[];
  log?: Array<{ ts?: string; kind?: string; task?: string; summary?: string }>;
}
