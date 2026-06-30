/**
 * ActivityGraph.tsx — the DYNAMIC invoke-lifecycle flow (the graph form of the
 * chat transcript's invoke story). A session/discover root feeds one node per
 * tool call. Each node carries a live STATUS in the cc-master lamp language
 * (muted = not yet, amber pulse = in progress, alert halo = awaiting human, jade
 * = completed, red = denied/error). The human-approval gate is visually distinct.
 *
 * Concurrency cue: calls are grouped into STAGES by time overlap (two calls
 * overlap iff their [tStart, tEnd] logical-clock intervals intersect). A stage
 * with >1 call renders as a parallel branch — a fork from the previous stage and
 * a rejoin into the next — so concurrency is visible at a glance; sequential
 * calls stay on a single spine.
 */

import { useMemo } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import dagre from 'dagre';
import '@xyflow/react/dist/style.css';
import type { AppState, ToolCallState, ToolCallStatus } from '../../store';

type StatusMeta = { label: string; color: string; pulse: boolean; gate?: boolean };

const STATUS_META: Record<ToolCallStatus, StatusMeta> = {
  starting: { label: 'starting', color: 'var(--inflight)', pulse: true },
  grant_pending: { label: 'awaiting you', color: 'var(--alert)', pulse: true, gate: true },
  approved: { label: 'approved · running', color: 'var(--inflight)', pulse: true },
  invoking: { label: 'in progress', color: 'var(--inflight)', pulse: true },
  denied: { label: 'denied', color: 'var(--failed)', pulse: false },
  ok: { label: 'completed', color: 'var(--done)', pulse: false },
  error: { label: 'error', color: 'var(--failed)', pulse: false },
};

const TERMINAL: ToolCallStatus[] = ['ok', 'error', 'denied'];

type RootData = { agentName: string; sessionId?: string; capCount: number };
type CallData = { tool: ToolCallState; gated: boolean };

function RootNode({ data }: NodeProps<Node<RootData>>) {
  return (
    <div className="cc-node" style={{ ['--lamp' as string]: 'var(--ready)', minWidth: 180, borderColor: 'var(--tint-ready-line)' }}>
      <div className="flex items-center gap-[7px]">
        <span className="lamp" style={{ ['--lamp' as string]: 'var(--ready)' }} />
        <span className="font-tele text-[8.5px] font-medium uppercase tracking-[0.16em]" style={{ color: 'var(--ready)' }}>
          session · discover
        </span>
      </div>
      <div className="mt-[7px] text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
        {data.agentName}
      </div>
      <div className="font-tele mt-[5px] text-[8px] uppercase tracking-[0.1em]" style={{ color: 'var(--ink-faint)' }}>
        {data.capCount} capabilities · {data.sessionId ?? 'session'}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function CallNode({ data }: NodeProps<Node<CallData>>) {
  const t = data.tool;
  const meta = STATUS_META[t.status];
  const isGate = t.status === 'grant_pending';
  const cls = ['cc-node', isGate ? 'usergate' : ''].join(' ').trim();
  return (
    <div
      className={cls}
      data-testid="activity-graph-node"
      data-status={t.status}
      style={{ ['--lamp' as string]: meta.color, borderColor: isGate ? 'var(--tint-alert-line)' : 'var(--hair)' }}
    >
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center gap-[7px]">
        <span className={`lamp ${meta.pulse ? 'pulse' : ''}`} style={{ ['--lamp' as string]: meta.color }} />
        <span className="font-tele text-[8.5px] font-medium uppercase tracking-[0.16em]" style={{ color: meta.color }}>
          {meta.label}
        </span>
        <span className="font-tele ml-auto text-[10px]" style={{ color: 'var(--ink-dim)' }}>
          {t.source}
        </span>
      </div>
      <div className="mt-[7px] text-[12px] font-medium leading-[1.3]" style={{ color: 'var(--ink)' }}>
        {t.label}
      </div>
      <div className="font-tele mt-[3px] text-[9px]" style={{ color: 'var(--ink-faint)' }}>
        {t.capabilityId}
      </div>
      <div className="mt-[6px] flex flex-wrap items-center gap-[5px]">
        {data.gated && (
          <span
            className="font-tele rounded-[var(--r-sm)] px-[6px] py-[1px] text-[8px] uppercase tracking-[0.08em]"
            style={{ background: 'var(--tint-alert-bg)', border: '1px solid var(--tint-alert-line)', color: 'var(--alert)' }}
            title="this invoke required human approval"
          >
            ⊘ gate
          </span>
        )}
        {t.decision && (
          <span
            className="font-tele rounded-[var(--r-sm)] px-[6px] py-[1px] text-[8px] uppercase tracking-[0.08em]"
            style={{ color: t.decision === 'approved' ? 'var(--done)' : 'var(--failed)' }}
          >
            {t.decision === 'approved' ? '✓ approved' : '✕ denied'}
          </span>
        )}
        {t.result && (
          <span
            className="font-tele rounded-[var(--r-sm)] px-[6px] py-[1px] text-[8px] tracking-[0.04em]"
            style={{ background: 'var(--tint-done-bg)', border: '1px solid var(--tint-done-line)', color: 'var(--done)' }}
            title="audit log entry id"
          >
            audit · {t.result.auditId}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { root: RootNode, call: CallNode };

const NODE_W = 224;
const NODE_H = 128;
const ROOT_H = 104;

/** Group calls (ordered by start) into stages of mutually time-overlapping calls. */
function toStages(calls: ToolCallState[]): ToolCallState[][] {
  const ordered = [...calls].sort((a, b) => a.tStart - b.tStart);
  const stages: ToolCallState[][] = [];
  let cur: ToolCallState[] = [];
  let stageMaxEnd = -Infinity;
  for (const c of ordered) {
    const end = c.tEnd ?? Infinity;
    if (cur.length === 0 || c.tStart < stageMaxEnd) {
      cur.push(c);
      stageMaxEnd = Math.max(stageMaxEnd, end);
    } else {
      stages.push(cur);
      cur = [c];
      stageMaxEnd = end;
    }
  }
  if (cur.length) stages.push(cur);
  return stages;
}

function buildGraph(state: AppState): { nodes: Node[]; edges: Edge[] } {
  const calls = Object.values(state.toolCalls);
  const stages = toStages(calls);

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 64, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  const ROOT = '__root';
  g.setNode(ROOT, { width: NODE_W, height: ROOT_H });
  for (const stage of stages) for (const c of stage) g.setNode(c.callId, { width: NODE_W, height: NODE_H });

  const edges: Edge[] = [];
  const link = (s: string, target: ToolCallState) => {
    const active = !TERMINAL.includes(target.status);
    g.setEdge(s, target.callId);
    edges.push({
      id: `e:${s}->${target.callId}`,
      source: s,
      target: target.callId,
      animated: active,
      style: { stroke: active ? 'var(--inflight)' : 'var(--edge)', strokeWidth: 1.4 },
    });
  };

  let prev: ToolCallState[] = [];
  stages.forEach((stage, i) => {
    for (const c of stage) {
      if (i === 0) link(ROOT, c);
      else for (const p of prev) link(p.callId, c);
    }
    prev = stage;
  });

  dagre.layout(g);

  const place = (id: string, w: number, h: number) => {
    const n = g.node(id);
    return { x: (n?.x ?? 0) - w / 2, y: (n?.y ?? 0) - h / 2 };
  };

  const gatedIds = new Set(calls.filter((c) => c.grant || c.decision || c.status === 'grant_pending').map((c) => c.callId));

  const nodes: Node[] = [
    {
      id: ROOT,
      type: 'root',
      position: place(ROOT, NODE_W, ROOT_H),
      data: {
        agentName: state.session?.agentName ?? 'Plexus DeepAgent',
        sessionId: state.session?.sessionId,
        capCount: state.capabilities.length,
      },
      draggable: false,
    },
    ...calls.map((c) => ({
      id: c.callId,
      type: 'call',
      position: place(c.callId, NODE_W, NODE_H),
      data: { tool: c, gated: gatedIds.has(c.callId) },
      draggable: false,
    })),
  ];

  return { nodes, edges };
}

export function ActivityGraph({ state }: { state: AppState }) {
  const { nodes, edges } = useMemo(() => buildGraph(state), [state.toolCalls, state.session, state.capabilities.length]);

  if (Object.keys(state.toolCalls).length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[12px]" style={{ color: 'var(--ink-faint)' }}>
        No invokes yet — run the demo to watch the lifecycle flow populate.
      </div>
    );
  }

  return (
    <div className="h-full min-h-0" data-testid="activity-graph">
      <ReactFlow
        // remount when the node set grows so fitView reframes as invokes stream in
        key={nodes.length}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        minZoom={0.2}
      >
        <Background color="var(--grid)" gap={22} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
