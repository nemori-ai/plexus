/**
 * OrchestrationBoard.tsx — the orchestration DAG.
 *
 * Renders the `orchestration.board` payload (a cc-master/v1 board JSON snapshot)
 * with xyflow + dagre, lifting cc-master's mission-control node/edge design and
 * status→color mapping. board(tasks/deps) → xyflow(nodes/edges) → dagre layout.
 *
 * deps[] are upstream ids; an edge runs dep → task. parent links draw a softer
 * "contains" edge. The whole view is read-only.
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
import type { Board, BoardTask, BoardTaskStatus } from '../../contract';

const STATUS_VAR: Record<BoardTaskStatus, string> = {
  ready: '--ready',
  in_flight: '--inflight',
  blocked: '--blocked',
  done: '--done',
  verified: '--done',
  uncertain: '--uncertain',
  escalated: '--escalated',
  failed: '--failed',
  stale: '--stale',
};

const STATUS_LABEL: Record<BoardTaskStatus, string> = {
  ready: 'ready',
  in_flight: 'in flight',
  blocked: 'blocked',
  done: 'done',
  verified: 'verified',
  uncertain: 'uncertain',
  escalated: 'escalated',
  failed: 'failed',
  stale: 'stale',
};

type TaskNodeData = { task: BoardTask };

function TaskNode({ data }: NodeProps<Node<TaskNodeData>>) {
  const t = data.task;
  const isGate = t.blocked_on === 'user';
  const color = `var(${STATUS_VAR[t.status] ?? '--blocked'})`;
  const cls = ['cc-node', `s-${t.status}`, isGate ? 'usergate' : ''].join(' ');
  return (
    <div className={cls} style={{ ['--lamp' as string]: isGate ? 'var(--alert)' : color }}>
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center gap-[7px]">
        <span className="lamp" />
        <span className="font-tele text-[8.5px] font-medium uppercase tracking-[0.16em]" style={{ color: isGate ? 'var(--alert)' : color }}>
          {isGate ? 'awaiting you' : STATUS_LABEL[t.status]}
        </span>
        <span className="font-tele ml-auto text-[10px] tracking-[0.04em]" style={{ color: 'var(--ink-dim)' }}>
          {t.id}
        </span>
      </div>
      <div className="mt-[7px] text-[12px] leading-[1.3]" style={{ color: 'var(--ink)' }}>
        {t.title ?? t.id}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-[6px]">
        {t.mechanism && (
          <span
            className="font-tele rounded-[var(--r-sm)] px-[6px] py-[2px] text-[8px] uppercase tracking-[0.08em]"
            style={{ background: 'var(--chip-bg)', border: '1px solid var(--hair-soft)', color: 'var(--ink-dim)' }}
          >
            {t.mechanism}
          </span>
        )}
        {t.kind === 'owner' && (
          <span
            className="font-tele rounded-[var(--r-sm)] px-[6px] py-[2px] text-[8px] uppercase tracking-[0.08em]"
            style={{ background: 'var(--tint-ready-bg)', border: '1px solid var(--tint-ready-line)', color: 'var(--ready)' }}
          >
            owner
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { task: TaskNode };

const NODE_W = 210;
const NODE_H = 96;

function buildGraph(board: Board): { nodes: Node[]; edges: Edge[] } {
  const tasks = Array.isArray(board.tasks) ? board.tasks : [];
  const ids = new Set(tasks.map((t) => t.id));

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 44, ranksep: 72, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const t of tasks) g.setNode(t.id, { width: NODE_W, height: NODE_H });

  const edges: Edge[] = [];
  const seen = new Set<string>();
  const addEdge = (s: string, t: string, kind: 'dep' | 'parent') => {
    if (s === t || !ids.has(s) || !ids.has(t)) return;
    const key = `${kind}:${s}->${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    g.setEdge(s, t);
    edges.push({
      id: key,
      source: s,
      target: t,
      animated: kind === 'dep',
      style: {
        stroke: kind === 'parent' ? 'var(--tint-ready-line)' : 'var(--edge)',
        strokeWidth: 1.4,
        strokeDasharray: kind === 'parent' ? '4 4' : undefined,
      },
    });
  };
  for (const t of tasks) {
    for (const d of t.deps ?? []) addEdge(d, t.id, 'dep');
    if (t.parent) addEdge(t.parent, t.id, 'parent');
  }

  dagre.layout(g);

  const nodes: Node[] = tasks.map((t) => {
    const n = g.node(t.id);
    return {
      id: t.id,
      type: 'task',
      position: { x: (n?.x ?? 0) - NODE_W / 2, y: (n?.y ?? 0) - NODE_H / 2 },
      data: { task: t },
      draggable: false,
    };
  });

  return { nodes, edges };
}

export function OrchestrationBoard({ board }: { board: Board }) {
  const { nodes, edges } = useMemo(() => buildGraph(board), [board]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="orchestration-board">
      <div
        className="font-tele flex items-center justify-between px-3 py-[9px] text-[8px] uppercase tracking-[0.22em]"
        style={{ color: 'var(--ink-faint)', borderBottom: '1px solid var(--hair-soft)' }}
      >
        <span>Orchestration</span>
        <span style={{ color: 'var(--ink-dim)' }} className="normal-case tracking-normal">
          {board.tasks.length} tasks
        </span>
      </div>
      {board.goal && (
        <div className="px-3 py-2 text-[11px] leading-[1.4]" style={{ color: 'var(--ink-dim)', borderBottom: '1px solid var(--hair-soft)' }}>
          {board.goal}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
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
    </div>
  );
}
