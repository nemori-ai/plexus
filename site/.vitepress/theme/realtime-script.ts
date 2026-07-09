/**
 * The scripted scenario for the home-page Realtime demo (RealtimeDemo.vue) —
 * pure data + types, no DOM. The world (agents + capability constellation),
 * the ~66 s five-act beat table with bilingual {en, zh} captions, the chrome
 * strings, and the loop length. Copy is VERBATIM from
 * docs/design/site-realtime-demo.md — change wording only by updating the spec.
 */

import type { EngineAgent, EngineCap } from "./realtime-engine";

/** A bilingual string pair — picked by `useData().lang.startsWith("zh")`. */
export interface Bi {
  en: string;
  zh: string;
}

export const LOOP_LEN = 66_000;

// ── the world (set once via engine.setWorld) ─────────────────────────────────

export const AGENTS: EngineAgent[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "mail-assistant", label: "Mail assistant" },
  { id: "research-agent", label: "Research agent" },
  { id: "monitor", label: "Monitor" },
];

export const CAPS: EngineCap[] = [
  { id: "apple-calendar.events.list", source: "apple-calendar", verb: "read" },
  { id: "apple-calendar.calendars.list", source: "apple-calendar", verb: "read" },
  { id: "things.todos.list", source: "things", verb: "read" },
  { id: "things.todos.add", source: "things", verb: "write" },
  { id: "claudecode.run", source: "claudecode", verb: "execute" },
  { id: "codex.run", source: "codex", verb: "execute" },
  { id: "workspace.list", source: "workspace", verb: "read" },
  { id: "workspace.read", source: "workspace", verb: "read" },
  { id: "workspace.write", source: "workspace", verb: "write" },
  { id: "sysinfo.resources.read", source: "sysinfo", verb: "read" },
  { id: "sysinfo.processes.list", source: "sysinfo", verb: "read" },
  { id: "sysinfo.log.read", source: "sysinfo", verb: "read" },
  { id: "obsidian-rest.vault.read", source: "obsidian-rest", verb: "read" },
  { id: "obsidian-rest.vault.write", source: "obsidian-rest", verb: "write" },
];

// ── beat types ────────────────────────────────────────────────────────────────

/** The demo renders only these TrustWindowKind literals — never `session`. */
export type DemoWindow = "1d" | "once";

interface BeatBase {
  id: string;
  /** Seconds since loop start. */
  t: number;
}

/** A wall-crossing call: invoke ok (pass) or invoke denied (blocked bounce). */
export interface FlowBeat extends BeatBase {
  kind: "flow";
  agent: string;
  cap: string;
  outcome: "ok" | "denied";
  caption?: Bi;
  /** Fire only when the branch flag has this value… */
  requires?: { flag: string; value: boolean };
  /** …otherwise swap to this variant; absent → skip the beat entirely. */
  otherwise?: { outcome: "ok" | "denied"; caption?: Bi };
}

/** A write/execute stopped at the wall — spawns an interactive card. */
export interface PendBeat extends BeatBase {
  kind: "pend";
  agent: string;
  cap: string;
  window: DemoWindow;
  flag: string;
  /** Seconds since loop start at which the script auto-resolves (approve). */
  resolveAt: number;
  caption: Bi;
  onApprove: Bi;
  onDeny: Bi;
}

/** Caption-only (optionally a ledger row) — no canvas flow (control-plane). */
export interface NoteBeat extends BeatBase {
  kind: "note";
  caption?: Bi;
  ledger?: { ev: "revoke"; agent: string; cap: string; out: string };
}

export type Beat = FlowBeat | PendBeat | NoteBeat;

// ── act rail ──────────────────────────────────────────────────────────────────

/** Act start times (s) — rail highlight tracking + chapter-click jump targets. */
export const ACT_STARTS = [0, 10, 24, 40, 50] as const;

export const ACTS: { title: Bi; sub: Bi }[] = [
  {
    title: { en: "Reads flow", zh: "读，直接放行" },
    sub: { en: "standing grants, audited", zh: "常驻授权，全程留痕" },
  },
  {
    title: { en: "A write pends", zh: "写，先挂起" },
    sub: { en: "you set the trust window", zh: "信任窗口由你给" },
  },
  {
    title: { en: "Execute, per call", zh: "execute，按次批" },
    sub: { en: "once means once", zh: "once 就是 once" },
  },
  {
    title: { en: "Off-subset bounces", zh: "子集外，弹回" },
    sub: { en: "default-deny holds", zh: "默认拒绝不松动" },
  },
  {
    title: { en: "Revoke cuts it off", zh: "撤销，即刻切断" },
    sub: { en: "surgical, immediate", zh: "外科手术式" },
  },
];

// ── the beat table (§1 of the spec — captions verbatim) ───────────────────────

export const BEATS: Beat[] = [
  // Act I — Reads flow (0–10 s)
  {
    kind: "flow",
    id: "a1.1",
    t: 0.8,
    agent: "monitor",
    cap: "sysinfo.resources.read",
    outcome: "ok",
    caption: {
      en: "<b>Monitor</b> called <code>sysinfo.resources.read</code> — a first-party read on a <b>standing grant</b>. It flows; you weren't interrupted.",
      zh: "<b>Monitor</b> 调用了 <code>sysinfo.resources.read</code>——第一方读能力，走<b>常驻授权</b>。直接放行，没有打扰你。",
    },
  },
  {
    kind: "flow",
    id: "a1.2",
    t: 2.2,
    agent: "mail-assistant",
    cap: "apple-calendar.events.list",
    outcome: "ok",
    caption: {
      en: "Reads inside an agent's <b>authorized subset</b> pass straight through the wall — and every one still lands on its <b>audit trail</b>.",
      zh: "在 agent <b>授权子集</b>之内的读操作直接过墙——但每一笔仍落在它自己的<b>审计轨迹</b>上。",
    },
  },
  { kind: "flow", id: "a1.3", t: 3.6, agent: "claude-code", cap: "workspace.list", outcome: "ok" },
  {
    kind: "flow",
    id: "a1.4",
    t: 5.0,
    agent: "research-agent",
    cap: "obsidian-rest.vault.read",
    outcome: "ok",
    caption: {
      en: "<b>Research agent</b> reads a managed source, <code>obsidian-rest.vault.read</code> — same posture: reads flow.",
      zh: "<b>Research agent</b> 读取 managed 来源 <code>obsidian-rest.vault.read</code>——同样的姿态：读操作放行。",
    },
  },
  { kind: "flow", id: "a1.5", t: 6.4, agent: "monitor", cap: "sysinfo.processes.list", outcome: "ok" },
  {
    kind: "flow",
    id: "a1.6",
    t: 8.0,
    agent: "mail-assistant",
    cap: "apple-calendar.calendars.list",
    outcome: "ok",
  },

  // Act II — A write pends → trust window (10–24 s)
  {
    kind: "pend",
    id: "a2.pend",
    t: 10.5,
    agent: "mail-assistant",
    cap: "things.todos.add",
    window: "1d",
    flag: "todosGranted",
    resolveAt: 17.0,
    caption: {
      en: "A write. <b>Mail assistant</b> wants <code>things.todos.add</code>, and the wall holds it — no standing grant yet. Your call.",
      zh: "写入来了。<b>Mail assistant</b> 想调用 <code>things.todos.add</code>，墙把它拦住——还没有常驻授权。由你决定。",
    },
    onApprove: {
      en: "Approved with a <b>trust window</b> of <code>1d</code> — a <b>standing grant</b> that lasts until it expires or you revoke it.",
      zh: "已批准，<b>信任窗口</b> <code>1d</code>——一条<b>常驻授权</b>，到期或被<b>撤销</b>前一直有效。",
    },
    onDeny: {
      en: "You held the wall. Denied — and everything stays <b>default-deny</b>.",
      zh: "你按住了墙。已拒绝——一切保持<b>默认拒绝</b>。",
    },
  },
  {
    kind: "flow",
    id: "a2.ok1",
    t: 19.5,
    agent: "mail-assistant",
    cap: "things.todos.add",
    outcome: "ok",
    requires: { flag: "todosGranted", value: true },
    caption: {
      en: "The window stands, so later writes flow without asking again — each one still audited.",
      zh: "窗口在，后续写入不再逐次询问——但每一笔仍然留痕。",
    },
    otherwise: {
      outcome: "denied",
      caption: {
        en: "No grant, no passage — the same write bounces off the wall.",
        zh: "没有授权就没有通行——同样的写入被墙弹回。",
      },
    },
  },
  {
    kind: "flow",
    id: "a2.ok2",
    t: 21.5,
    agent: "mail-assistant",
    cap: "things.todos.add",
    outcome: "ok",
    requires: { flag: "todosGranted", value: true },
  },

  // Act III — Execute, per call (24–40 s)
  {
    kind: "pend",
    id: "a3.pend1",
    t: 24.5,
    agent: "claude-code",
    cap: "claudecode.run",
    window: "once",
    flag: "run1",
    resolveAt: 30.0,
    caption: {
      en: "<b>Claude Code</b> asks to run code. <code>claudecode.run</code> is <em>execute</em> — by default it stops at the wall <b>every time</b>, and approval is <code>once</code>.",
      zh: "<b>Claude Code</b> 请求运行代码。<code>claudecode.run</code> 是 <em>execute</em>——默认每次都停在墙前，批准就是 <code>once</code>。",
    },
    onApprove: {
      en: "Approved for <code>once</code> — this run, and only this run.",
      zh: "已批准 <code>once</code>——只放行这一次运行。",
    },
    onDeny: {
      en: "Denied — the run never happened. Nothing standing, nothing to clean up.",
      zh: "已拒绝——这次运行没有发生。没有常驻，也没有残留。",
    },
  },
  { kind: "flow", id: "a3.amb", t: 27.0, agent: "monitor", cap: "sysinfo.resources.read", outcome: "ok" },
  {
    kind: "pend",
    id: "a3.pend2",
    t: 33.5,
    agent: "claude-code",
    cap: "claudecode.run",
    window: "once",
    flag: "run2",
    resolveAt: 38.0,
    caption: {
      en: "It runs again — it pends again. Execute is approved per call <b>by default</b> — lifting that is the owner's call alone.",
      zh: "再运行一次——就再挂起一次。execute <b>默认按次批准</b>——要解除，只能由拥有者亲自开启。",
    },
    onApprove: {
      en: "Approved for <code>once</code> — this run, and only this run.",
      zh: "已批准 <code>once</code>——只放行这一次运行。",
    },
    onDeny: {
      en: "Denied — the run never happened. Nothing standing, nothing to clean up.",
      zh: "已拒绝——这次运行没有发生。没有常驻，也没有残留。",
    },
  },

  // Act IV — Off-subset bounces (40–50 s)
  {
    kind: "flow",
    id: "a4.deny",
    t: 41.0,
    agent: "research-agent",
    cap: "apple-calendar.events.list",
    outcome: "denied",
    caption: {
      en: "<b>Research agent</b> reached for <code>apple-calendar.events.list</code> — outside its <b>authorized subset</b>. <b>Default-deny</b>: the wall bounces it, and the attempt itself is audited.",
      zh: "<b>Research agent</b> 伸手 <code>apple-calendar.events.list</code>——在它的<b>授权子集</b>之外。<b>默认拒绝</b>：墙直接弹回，这次尝试本身也被审计。",
    },
  },
  {
    kind: "flow",
    id: "a4.contrast",
    t: 45.5,
    agent: "mail-assistant",
    cap: "apple-calendar.events.list",
    outcome: "ok",
    caption: {
      en: "The same capability flows for <b>Mail assistant</b>. Subsets are drawn per agent — so is the <b>blast radius</b>.",
      zh: "同一个能力，<b>Mail assistant</b> 调用就直接放行。授权子集按 agent 划定——<b>爆炸半径</b>也是。",
    },
  },

  // Act V — Revoke cuts it off (50–62 s)
  {
    kind: "note",
    id: "a5.revoke",
    t: 50.5,
    caption: {
      en: "You revoke <b>Monitor</b>'s standing grant — one move.",
      zh: "你<b>撤销</b>了 <b>Monitor</b> 的常驻授权——一个动作。",
    },
    ledger: { ev: "revoke", agent: "monitor", cap: "sysinfo.resources.read", out: "revoked" },
  },
  {
    kind: "flow",
    id: "a5.blocked",
    t: 52.5,
    agent: "monitor",
    cap: "sysinfo.resources.read",
    outcome: "denied",
    caption: {
      en: "Cut off mid-loop: the very next call bounces, and its scoped token dies with the grant.",
      zh: "回环中途被切断：下一次调用直接弹回，受限 token 也随授权一起失效。",
    },
  },
  {
    kind: "flow",
    id: "a5.surgical",
    t: 55.5,
    agent: "mail-assistant",
    cap: "things.todos.add",
    outcome: "ok",
    requires: { flag: "todosGranted", value: true },
    caption: {
      en: "<b>Mail assistant</b>'s window still stands. Revoke is surgical — one grant, one agent, nothing else disturbed.",
      zh: "<b>Mail assistant</b> 的信任窗口仍然有效。撤销是外科手术式的——只动一条授权、一个 agent，其余不受影响。",
    },
    otherwise: {
      outcome: "denied",
      caption: {
        en: "<b>Mail assistant</b> never got a window — its write still bounces. Default-deny doesn't drift.",
        zh: "<b>Mail assistant</b> 没拿到窗口——它的写入仍被弹回。默认拒绝不会悄悄松动。",
      },
    },
  },

  // Coda — Audit (62–66 s)
  { kind: "flow", id: "c.1", t: 62.0, agent: "claude-code", cap: "workspace.read", outcome: "ok" },
  {
    kind: "note",
    id: "c.2",
    t: 63.0,
    caption: {
      en: "Sixty seconds, and every event is accounted for — one <b>audit trail</b> per agent. This is a simulation; run the real <b>trust loop</b> in the guide.",
      zh: "六十秒，每个事件都有账——每个 agent 各一条<b>审计轨迹</b>。这是模拟演示；到指南里跑一遍真实的<b>信任回环</b>。",
    },
  },
];

// ── chrome strings ────────────────────────────────────────────────────────────

export const STRINGS = {
  /** The honesty pill — the green pulsing dot is kept, the word is always "Simulated". */
  pill: { en: "Simulated demo", zh: "模拟演示" } as Bi,
  eyebrow: { en: "SIXTY SECONDS, SIMULATED", zh: "六十秒 · 模拟信号" } as Bi,
  heading: { en: "Watch it govern", zh: "看它如何把关" } as Bi,
  sub: {
    en: "Five agents reaching real capabilities through the Plexus wall — a scripted loop of the exact event shapes the real monitor renders.",
    zh: "五个 agent 穿过 Plexus 之墙调用真实能力——用真实监控渲染的事件形状，编排成一段循环脚本。",
  } as Bi,
  run: { en: "run it for real →", zh: "跑一遍真的 →" } as Bi,
  runHref: { en: "/guide/", zh: "/zh/guide/" } as Bi,
  cardEyebrow: { en: "At the wall — your call", zh: "停在墙前——由你决定" } as Bi,
  /** who: `{agent}` + this middle + `{cap}` (agent-then-cap in both locales). */
  cardWhoMid: { en: " wants to run ", zh: " 想调用 " } as Bi,
  cardMetaWrite: {
    en: "approving opens a trust window (<code>1d</code>); denying keeps default-deny",
    zh: "批准会打开一个信任窗口（<code>1d</code>）；拒绝则保持默认拒绝",
  } as Bi,
  cardMetaExecute: {
    en: "execute is per-call by default — approving grants <code>once</code>",
    zh: "execute 默认按次批准——通过即 <code>once</code>",
  } as Bi,
  approve: { en: "Approve", zh: "批准" } as Bi,
  deny: { en: "Deny", zh: "拒绝" } as Bi,
  ledgerLabel: { en: "Recent activity", zh: "最近活动" } as Bi,
  /** count reads `· {n} events` / `· {n} 条`. */
  ledgerCountPre: { en: "· ", zh: "· " } as Bi,
  ledgerCountPost: { en: " events", zh: " 条" } as Bi,
  ledgerHint: {
    en: "— hover a row to replay it above ↑",
    zh: "——悬停一行，在上方重放 ↑",
  } as Bi,
  ariaCanvas: {
    en: "Simulated activity: five agents calling capabilities through the Plexus wall; writes and execute pend for approval",
    zh: "模拟演示：五个 agent 穿过 Plexus 之墙调用能力；写入与 execute 会挂起等待批准",
  } as Bi,
};

/** Agent id → display label (captions/ledger show labels, the engine gets ids). */
export const AGENT_LABEL: Record<string, string> = Object.fromEntries(
  AGENTS.map((a) => [a.id, a.label]),
);
