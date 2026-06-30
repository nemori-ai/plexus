/**
 * CapabilityGraph.tsx — the STATIC capability topology (the graph form of the
 * Capabilities list). A calm "org chart" of what the agent can reach:
 *
 *   Source node (workspace / claudecode / codex / …) → its Capability nodes.
 *
 * Two levels, no more. Capability nodes are colored by sensitivity and carry
 * provenance + grant-verb badges. Deliberately structural — NO invoke activity,
 * audit links, or animation live here (that story is the Activity-flow graph).
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
import type { CapabilityCard } from '../../contract';

const SENS_VAR: Record<string, string> = {
  low: '--sens-low',
  medium: '--sens-medium',
  high: '--sens-high',
};
function sensColor(s: string): string {
  return `var(${SENS_VAR[s.toLowerCase()] ?? '--ink-dim'})`;
}

type SourceData = { source: string; provenance?: string; count: number };
type CapData = { cap: CapabilityCard };

function SourceNode({ data }: NodeProps<Node<SourceData>>) {
  return (
    <div
      className="cc-node"
      style={{ ['--lamp' as string]: 'var(--ready)', minWidth: 150, borderColor: 'var(--tint-ready-line)' }}
    >
      <Handle type="source" position={Position.Right} />
      <div className="flex items-center gap-[7px]">
        <span className="lamp" style={{ ['--lamp' as string]: 'var(--ready)' }} />
        <span className="font-tele text-[8.5px] font-medium uppercase tracking-[0.16em]" style={{ color: 'var(--ready)' }}>
          source
        </span>
        <span className="font-tele ml-auto text-[10px]" style={{ color: 'var(--ink-dim)' }}>
          {data.count}
        </span>
      </div>
      <div className="mt-[7px] text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
        {data.source}
      </div>
      {data.provenance && (
        <div className="font-tele mt-[5px] text-[8px] uppercase tracking-[0.1em]" style={{ color: 'var(--ink-faint)' }}>
          {data.provenance}
        </div>
      )}
    </div>
  );
}

function CapabilityNode({ data }: NodeProps<Node<CapData>>) {
  const cap = data.cap;
  const color = sensColor(cap.sensitivity);
  return (
    <div className="cc-node" data-testid="cap-graph-node" style={{ ['--lamp' as string]: color, borderColor: 'var(--hair)' }}>
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-[7px]">
        <span className="lamp" style={{ ['--lamp' as string]: color, width: 7, height: 7 }} />
        <span className="flex-1 truncate text-[12px] font-medium" style={{ color: 'var(--ink)' }}>
          {cap.label}
        </span>
        <span className="font-tele text-[8px] uppercase tracking-[0.1em]" style={{ color }} title="sensitivity">
          {cap.sensitivity}
        </span>
      </div>
      <div className="font-tele mt-[3px] text-[9px]" style={{ color: 'var(--ink-faint)' }}>
        {cap.id}
      </div>
      <div className="mt-[6px] flex flex-wrap items-center gap-[5px]">
        <span
          className="font-tele rounded-[var(--r-sm)] px-[6px] py-[1px] text-[8px] uppercase tracking-[0.08em]"
          style={{ background: 'var(--chip-bg)', border: '1px solid var(--hair-soft)', color: 'var(--ink-faint)' }}
        >
          {cap.provenance}
        </span>
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

const nodeTypes = { source: SourceNode, capability: CapabilityNode };

const SRC_W = 168;
const SRC_H = 88;
const CAP_W = 230;
const CAP_H = 104;

function buildGraph(capabilities: CapabilityCard[]): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 26, ranksep: 90, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  // group capabilities by source, preserving first-seen order
  const bySource = new Map<string, CapabilityCard[]>();
  for (const c of capabilities) {
    if (!bySource.has(c.source)) bySource.set(c.source, []);
    bySource.get(c.source)!.push(c);
  }

  const edges: Edge[] = [];
  for (const [source, caps] of bySource) {
    const sid = `src:${source}`;
    g.setNode(sid, { width: SRC_W, height: SRC_H });
    for (const c of caps) {
      const cid = `cap:${c.id}`;
      g.setNode(cid, { width: CAP_W, height: CAP_H });
      g.setEdge(sid, cid);
      edges.push({
        id: `e:${sid}->${cid}`,
        source: sid,
        target: cid,
        style: { stroke: 'var(--edge)', strokeWidth: 1.4 },
      });
    }
  }

  dagre.layout(g);

  const nodes: Node[] = [];
  for (const [source, caps] of bySource) {
    const sid = `src:${source}`;
    const sn = g.node(sid);
    nodes.push({
      id: sid,
      type: 'source',
      position: { x: (sn?.x ?? 0) - SRC_W / 2, y: (sn?.y ?? 0) - SRC_H / 2 },
      data: { source, provenance: caps[0]?.provenance, count: caps.length },
      draggable: false,
    });
    for (const c of caps) {
      const cid = `cap:${c.id}`;
      const cn = g.node(cid);
      nodes.push({
        id: cid,
        type: 'capability',
        position: { x: (cn?.x ?? 0) - CAP_W / 2, y: (cn?.y ?? 0) - CAP_H / 2 },
        data: { cap: c },
        draggable: false,
      });
    }
  }

  return { nodes, edges };
}

export function CapabilityGraph({ capabilities }: { capabilities: CapabilityCard[] }) {
  const { nodes, edges } = useMemo(() => buildGraph(capabilities), [capabilities]);

  if (capabilities.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[12px]" style={{ color: 'var(--ink-faint)' }}>
        No capabilities discovered yet — run the demo to populate the map.
      </div>
    );
  }

  return (
    <div className="h-full min-h-0" data-testid="capability-graph">
      <ReactFlow
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
