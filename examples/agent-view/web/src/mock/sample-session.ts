/**
 * sample-session.ts — a hardcoded AgentEvent[] so the Agent View runs & demos
 * STANDALONE (no backend, no gateway, no LLM/CC). This is the canonical demo
 * narrative the e2e replays:
 *
 *   "Build a pomodoro app" → agent installs Plexus, DISCOVERS host capabilities,
 *   orchestrates Claude Code + Codex, hits a HUMAN-APPROVAL gate on an execute
 *   capability (claudecode.run), the human approves, the invoke streams stdout,
 *   completes with an auditId — and an orchestration board tracks the sub-DAG.
 *
 * Mirrors the live contract exactly, so the same store reducer folds both.
 */

import type { AgentEvent, Board } from '../contract';

const demoBoard: Board = {
  schema: 'cc-master/v1',
  goal: 'Build the 番茄喵 pomodoro app (PRD → Claude Code build → Codex review)',
  wip_limit: 3,
  tasks: [
    { id: 'T0', status: 'verified', deps: [], title: 'Discover host capabilities via Plexus', mechanism: 'self', verified: true },
    { id: 'T1', status: 'done', deps: ['T0'], title: 'Synthesize notes → PRD.html', mechanism: 'sub-agent', handle: 'bg-prd', artifact: 'PRD.html' },
    { id: 'B1', status: 'in_flight', deps: ['T1'], kind: 'owner', title: 'Build app with Claude Code', mechanism: 'claudecode.run', handle: 'cc-1' },
    { id: 'B1.a', status: 'done', deps: [], parent: 'B1', title: 'Scaffold index.html + timer core' },
    { id: 'B1.b', status: 'in_flight', deps: ['B1.a'], parent: 'B1', title: 'Wire 番茄喵 mascot + 4th-pomodoro walk' },
    { id: 'R1', status: 'blocked', deps: ['B1'], kind: 'owner', title: 'Review build with Codex', mechanism: 'codex.run', blocked_on: 'B1' },
    { id: 'D1', status: 'blocked', deps: [], blocked_on: 'user', title: 'Approve: run Claude Code in authorized folder?' },
  ],
  log: [
    { ts: '2026-06-29T10:00:00Z', kind: 'dispatch', task: 'T1', summary: 'Synthesized PRD from seeded notes' },
    { ts: '2026-06-29T10:04:00Z', kind: 'dispatch', task: 'B1', summary: 'Dispatched build to Claude Code' },
    { ts: '2026-06-29T10:05:00Z', kind: 'decision', task: 'D1', summary: 'Pended claudecode.run for human approval' },
  ],
};

const boardAfterApproval: Board = {
  ...demoBoard,
  tasks: demoBoard.tasks.map((t) => {
    if (t.id === 'D1') return { ...t, status: 'verified', title: 'Approved: run Claude Code', verified: true };
    if (t.id === 'B1.b') return { ...t, status: 'done' };
    if (t.id === 'B1') return { ...t, status: 'done' };
    if (t.id === 'R1') return { ...t, status: 'in_flight', blocked_on: undefined };
    return t;
  }),
};

export const sampleSession: AgentEvent[] = [
  {
    type: 'session.start',
    sessionId: 'demo-0xCAFE',
    agentName: 'Plexus DeepAgent',
    model: 'claude-opus-4-8',
    ts: '2026-06-29T10:00:00Z',
  },

  // ── discover ───────────────────────────────────────────────────────────────
  { type: 'agent.state', phase: 'discovering', note: 'Installing Plexus — reading the host capability manifest' },
  {
    type: 'capabilities.discovered',
    capabilities: [
      { id: 'workspace.read', label: 'Read workspace files', source: 'workspace', provenance: 'first-party', sensitivity: 'low', grants: ['read'], describe: 'Read files inside the one authorized folder.' },
      { id: 'workspace.write', label: 'Write workspace files', source: 'workspace', provenance: 'first-party', sensitivity: 'medium', grants: ['write'], describe: 'Create or modify files inside the authorized folder. Pends for owner approval.' },
      { id: 'claudecode.run', label: 'Run Claude Code', source: 'claudecode', provenance: 'first-party', sensitivity: 'high', grants: ['execute'], describe: 'Drive the desktop Claude Code agent, sandbox-confined to the authorized folder.' },
      { id: 'codex.run', label: 'Run Codex', source: 'codex', provenance: 'first-party', sensitivity: 'high', grants: ['execute'], describe: 'Drive the desktop Codex CLI headless, sandbox-confined to the authorized folder.' },
      { id: 'memory.note', label: 'Persist agent memory', source: 'memory', provenance: 'first-party', sensitivity: 'low', grants: ['write'], describe: 'Persist durable notes across the session.' },
    ],
  },
  { type: 'memory.update', items: [
    { key: 'goal', value: 'Build the 番茄喵 pomodoro app', kind: 'goal' },
    { key: 'authorized_dir', value: '~/PlexusDemo/pomodoro', kind: 'fact' },
  ] },

  // ── think + first assistant turn ─────────────────────────────────────────────
  { type: 'agent.state', phase: 'thinking', note: 'Planning the build' },
  { type: 'assistant.delta', text: 'After installing **Plexus**, I can now see this machine’s ' },
  { type: 'assistant.delta', text: 'capabilities — including the desktop **Claude Code** and **Codex** agents. ' },
  { type: 'assistant.delta', text: 'Here’s my plan:\n\n' },
  { type: 'assistant.delta', text: '1. Synthesize your notes into a PRD\n2. Drive **Claude Code** to build it\n3. Have **Codex** review the result\n\n' },
  { type: 'assistant.delta', text: 'I cannot self-authorize the powerful steps — you’ll approve them in Plexus.' },
  { type: 'assistant.message', id: 'm-plan', text: 'After installing **Plexus**, I can now see this machine’s capabilities — including the desktop **Claude Code** and **Codex** agents. Here’s my plan:\n\n1. Synthesize your notes into a PRD\n2. Drive **Claude Code** to build it\n3. Have **Codex** review the result\n\nI cannot self-authorize the powerful steps — you’ll approve them in Plexus.' },

  // ── invoke #1: workspace.write (PRD) — low friction, auto-streamed ────────────
  { type: 'agent.state', phase: 'invoking', note: 'Writing PRD.html' },
  { type: 'tool.call.start', callId: 'c1', capabilityId: 'workspace.write', label: 'Write PRD.html', input: { path: 'PRD.html', bytes: 4213 }, provenance: 'first-party', sensitivity: 'medium', source: 'workspace' },
  { type: 'tool.call.grant_pending', callId: 'c1', pendingId: 'pend-c1', summary: 'The agent wants to write PRD.html into ~/PlexusDemo/pomodoro', verbs: ['write'] },
  { type: 'tool.call.grant_resolved', callId: 'c1', decision: 'approved' },
  { type: 'tool.call.delta', callId: 'c1', chunk: 'wrote PRD.html (4.2 KB)\n' },
  { type: 'tool.call.result', callId: 'c1', ok: true, output: { path: 'PRD.html', ok: true }, auditId: 'audit-c1-7731' },
  { type: 'audit.event', id: 'audit-c1-7731', capabilityId: 'workspace.write', outcome: 'approved · written', at: '2026-06-29T10:03:10Z' },
  { type: 'memory.update', items: [{ key: 'prd', value: 'PRD.html written & approved', kind: 'artifact' }] },

  { type: 'assistant.message', id: 'm-prd', text: 'PRD written and approved ✅. Now I’ll drive **Claude Code** to build the app. This is an *execute* capability, so it will pause for your approval.' },

  // ── orchestration board appears ──────────────────────────────────────────────
  { type: 'orchestration.board', board: demoBoard },

  // ── invoke #2: claudecode.run — THE human-approval gate centerpiece ──────────
  { type: 'agent.state', phase: 'awaiting_grant', note: 'Waiting for you to approve claudecode.run in Plexus' },
  { type: 'tool.call.start', callId: 'c2', capabilityId: 'claudecode.run', label: 'Build app with Claude Code', input: { prompt: 'Build index.html per PRD.html; pixel-art 番茄喵 fattens each cycle; 4th-pomodoro forced walk → grayscale until "我回来了".', cwd: '~/PlexusDemo/pomodoro' }, provenance: 'first-party', sensitivity: 'high', source: 'claudecode' },
  { type: 'tool.call.grant_pending', callId: 'c2', pendingId: 'pend-c2', summary: 'The agent wants to run Claude Code inside your authorized folder (~/PlexusDemo/pomodoro). It cannot reach a raw shell.', verbs: ['execute', 'spawn-agent'] },

  // (the card visibly WAITS here — see the replay pause before this resolves)
  { type: 'tool.call.grant_resolved', callId: 'c2', decision: 'approved' },
  { type: 'agent.state', phase: 'invoking', note: 'Claude Code is building' },
  { type: 'tool.call.delta', callId: 'c2', chunk: '› reading PRD.html\n' },
  { type: 'tool.call.delta', callId: 'c2', chunk: '› scaffolding index.html + timer core\n' },
  { type: 'tool.call.delta', callId: 'c2', chunk: '› drawing pixel-art 番茄喵 (5 fatness levels)\n' },
  { type: 'tool.call.delta', callId: 'c2', chunk: '› wiring 4th-pomodoro forced walk (grayscale + "我回来了")\n' },
  { type: 'tool.call.delta', callId: 'c2', chunk: '✓ build complete — index.html (11.4 KB)\n' },
  { type: 'tool.call.result', callId: 'c2', ok: true, output: { file: 'index.html', bytes: 11683, ran: 'claude-code v2' }, auditId: 'audit-c2-9920' },
  { type: 'audit.event', id: 'audit-c2-9920', capabilityId: 'claudecode.run', outcome: 'approved · built index.html', at: '2026-06-29T10:09:42Z' },
  { type: 'memory.update', items: [{ key: 'build', value: 'index.html built by Claude Code', kind: 'artifact' }] },
  { type: 'orchestration.board', board: boardAfterApproval },

  // ── invoke #3 + #4: codex.run review RUNS CONCURRENTLY with a workspace.write
  //    of the review notes. The two calls OVERLAP in time (c4 starts before c3's
  //    result lands), so the Activity-flow graph renders them as a parallel
  //    branch (fork → rejoin) instead of a single spine. ──────────────────────
  { type: 'agent.state', phase: 'invoking', note: 'Codex reviewing while notes are written in parallel' },
  { type: 'tool.call.start', callId: 'c3', capabilityId: 'codex.run', label: 'Review build with Codex', input: { prompt: 'Review index.html for a11y + the forced-walk logic.', cwd: '~/PlexusDemo/pomodoro' }, provenance: 'first-party', sensitivity: 'high', source: 'codex' },
  { type: 'tool.call.grant_pending', callId: 'c3', pendingId: 'pend-c3', summary: 'The agent wants to run Codex inside your authorized folder.', verbs: ['execute'] },
  { type: 'tool.call.grant_resolved', callId: 'c3', decision: 'approved' },
  { type: 'tool.call.delta', callId: 'c3', chunk: '› auditing index.html\n' },

  // c4 begins while c3 is still streaming → concurrency
  { type: 'tool.call.start', callId: 'c4', capabilityId: 'workspace.write', label: 'Write REVIEW.md', input: { path: 'REVIEW.md', bytes: 612 }, provenance: 'first-party', sensitivity: 'medium', source: 'workspace' },
  { type: 'tool.call.grant_pending', callId: 'c4', pendingId: 'pend-c4', summary: 'The agent wants to write REVIEW.md into ~/PlexusDemo/pomodoro', verbs: ['write'] },
  { type: 'tool.call.grant_resolved', callId: 'c4', decision: 'approved' },

  { type: 'tool.call.delta', callId: 'c3', chunk: '✓ a11y: focus ring present\n' },
  { type: 'tool.call.delta', callId: 'c4', chunk: 'collecting findings…\n' },
  { type: 'tool.call.delta', callId: 'c3', chunk: '⚠ suggest aria-live on the timer readout\n' },
  { type: 'tool.call.result', callId: 'c3', ok: true, output: { findings: 1, severity: 'low' }, auditId: 'audit-c3-3380' },
  { type: 'audit.event', id: 'audit-c3-3380', capabilityId: 'codex.run', outcome: 'approved · 1 low finding', at: '2026-06-29T10:12:05Z' },

  { type: 'tool.call.delta', callId: 'c4', chunk: 'wrote REVIEW.md (612 B)\n' },
  { type: 'tool.call.result', callId: 'c4', ok: true, output: { path: 'REVIEW.md', ok: true }, auditId: 'audit-c4-5512' },
  { type: 'audit.event', id: 'audit-c4-5512', capabilityId: 'workspace.write', outcome: 'approved · written', at: '2026-06-29T10:12:20Z' },

  // ── wrap up ──────────────────────────────────────────────────────────────────
  { type: 'agent.state', phase: 'idle', note: 'Done' },
  { type: 'assistant.message', id: 'm-done', text: '🍅 Done. **Claude Code** built `index.html` and **Codex** reviewed it (one low-severity a11y suggestion). Every powerful step was approved by you and is in the audit log. The app never had a raw shell and never left `~/PlexusDemo/pomodoro`.' },
  { type: 'session.end', reason: 'completed' },
];

/**
 * Replay the sample session as if it were arriving over SSE. Emits events with a
 * small inter-event delay, and a longer pause before each grant resolves so the
 * human-approval gate is visibly "waiting" (the centerpiece of the demo).
 *
 * Returns an abort function.
 */
export function replaySampleSession(
  onEvent: (e: AgentEvent) => void,
  opts: { speed?: number } = {},
): () => void {
  const speed = opts.speed ?? 1;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  let i = 0;
  const step = () => {
    if (cancelled || i >= sampleSession.length) return;
    const event = sampleSession[i];
    onEvent(event);
    i++;
    // pause longer right before a gate resolves, so the WAITING gate is felt
    const next = sampleSession[i];
    let delay = 180;
    if (next?.type === 'tool.call.grant_resolved') delay = 1400;
    else if (next?.type === 'tool.call.delta') delay = 90;
    else if (next?.type === 'assistant.delta') delay = 110;
    timer = setTimeout(step, delay / speed);
  };
  step();

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
