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
  { id: "apple-notes.notes.search", source: "apple-notes", verb: "read" },
  { id: "apple-notes.notes.create", source: "apple-notes", verb: "write" },
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
    title: { en: "Reads flow", zh: "读，凭已有授权放行" },
    sub: { en: "standing grants, audited", zh: "常驻授权，每次留痕" },
  },
  {
    title: { en: "A write pends", zh: "写，先挂起" },
    sub: { en: "you set the trust window", zh: "信任窗口由你定" },
  },
  {
    title: { en: "Execute, per call", zh: "execute，默认逐次批准" },
    sub: { en: "once means once", zh: "once，只准这一次" },
  },
  {
    title: { en: "Off-subset bounces", zh: "子集外，拒绝" },
    sub: { en: "default-deny holds", zh: "默认拒绝不变" },
  },
  {
    title: { en: "Revoke cuts it off", zh: "撤销，立即生效" },
    sub: { en: "surgical, immediate", zh: "精确撤销" },
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
      zh: "<b>Monitor</b> 调用了 <code>sysinfo.resources.read</code>，这是第一方读能力。已有适用的<b>常驻授权</b>，能力也仍开放，因此直接放行，没有打扰你。",
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
      zh: "读操作在 agent 的<b>授权子集</b>内，只说明它被选中。这里放行还依靠适用的常驻授权；若拥有者关闭能力开放，授权有效也不能调用。每次调用仍记在它自己的<b>审计轨迹</b>里。",
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
      zh: "<b>Research agent</b> 读取 managed 来源的 <code>obsidian-rest.vault.read</code>。这项能力也在所选子集内，仍对它开放，已有适用的常驻授权，所以放行。不能只凭来源或读取类型判断是否获准。",
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
    cap: "apple-notes.notes.create",
    window: "1d",
    flag: "notesGranted",
    resolveAt: 17.0,
    caption: {
      en: "A write. <b>Mail assistant</b> wants <code>apple-notes.notes.create</code>, and the wall holds it — no standing grant yet. Your call.",
      zh: "写入来了。<b>Mail assistant</b> 想调用 <code>apple-notes.notes.create</code>，但还没有适用的常驻授权。请求先挂起，等你决定。",
    },
    onApprove: {
      en: "Approved with a <b>trust window</b> of <code>1d</code> — a <b>standing grant</b> that lasts until it expires or you revoke it.",
      zh: "你已批准，<b>信任窗口</b>为 <code>1d</code>，这条<b>常驻授权</b>在到期或被<b>撤销</b>前有效。窗口记录的是授权决定的有效期；会话和作用域令牌另有各自的有效期。",
    },
    onDeny: {
      en: "You held the wall. Denied — and everything stays <b>default-deny</b>.",
      zh: "你选择了拒绝。这次请求仍未获授权，按<b>默认拒绝</b>处理。",
    },
  },
  {
    kind: "flow",
    id: "a2.ok1",
    t: 19.5,
    agent: "mail-assistant",
    cap: "apple-notes.notes.create",
    outcome: "ok",
    requires: { flag: "notesGranted", value: true },
    caption: {
      en: "The window stands, so later writes flow without asking again — each one still audited.",
      zh: "授权仍在窗口内有效，且能力保持开放，后续符合授权范围和条件的写入就不再逐次询问，每一笔仍然留痕。",
    },
    otherwise: {
      outcome: "denied",
      caption: {
        en: "No grant, no passage — the same write bounces off the wall.",
        zh: "没有获得授权，同样的写入仍被拒绝。",
      },
    },
  },
  {
    kind: "flow",
    id: "a2.ok2",
    t: 21.5,
    agent: "mail-assistant",
    cap: "apple-notes.notes.create",
    outcome: "ok",
    requires: { flag: "notesGranted", value: true },
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
      zh: "<b>Claude Code</b> 请求运行代码。<code>claudecode.run</code> 属于 <em>execute</em>，默认每次先挂起，批准只给 <code>once</code>；除非拥有者已为这个 agent 的这项能力明确开启常驻授权。",
    },
    onApprove: {
      en: "Approved for <code>once</code> — this run, and only this run.",
      zh: "已批准 <code>once</code>，只放行这一次运行。",
    },
    onDeny: {
      en: "Denied — the run never happened. Nothing standing, nothing to clean up.",
      zh: "已拒绝。这次代码没有运行，也没有因此留下常驻授权或后续可用的权限。拒绝仍有审计记录。",
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
      zh: "又一次运行请求来了，再次挂起。execute <b>默认按次批准</b>；只有拥有者能为这个 agent 的这项能力明确开启常驻授权，agent 不能靠自己的请求解除限制。",
    },
    onApprove: {
      en: "Approved for <code>once</code> — this run, and only this run.",
      zh: "已批准 <code>once</code>，只放行这一次运行。",
    },
    onDeny: {
      en: "Denied — the run never happened. Nothing standing, nothing to clean up.",
      zh: "已拒绝。这次代码没有运行，也没有因此留下常驻授权或后续可用的权限。拒绝仍有审计记录。",
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
      zh: "<b>Research agent</b> 请求调用 <code>apple-calendar.events.list</code>，超出了它的<b>授权子集</b>。这次按<b>默认拒绝</b>直接挡回，不进入待批准流程，尝试本身也记入审计。",
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
      zh: "同一项能力，<b>Mail assistant</b> 调用时获准通过：能力在它的子集内，仍对它开放，它也已有适用的常驻授权。每个 agent 的授权分别划定，<b>爆炸半径</b>也受各自授权范围限制。",
    },
  },

  // Act V — Revoke cuts it off (50–62 s)
  {
    kind: "note",
    id: "a5.revoke",
    t: 50.5,
    caption: {
      en: "You revoke <b>Monitor</b>'s standing grant — one move.",
      zh: "你<b>撤销</b>了 <b>Monitor</b> 的这条常驻授权，只需一个动作。",
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
      zh: "与这条授权关联的受限 token 随即失效。Monitor 下一次凭这条授权调用时，会被直接拒绝，不能再沿用它继续工作。",
    },
  },
  {
    kind: "flow",
    id: "a5.surgical",
    t: 55.5,
    agent: "mail-assistant",
    cap: "apple-notes.notes.create",
    outcome: "ok",
    requires: { flag: "notesGranted", value: true },
    caption: {
      en: "<b>Mail assistant</b>'s window still stands. Revoke is surgical — one grant, one agent, nothing else disturbed.",
      zh: "<b>Mail assistant</b> 的信任窗口仍然有效。这次只撤销 Monitor 的那一条常驻授权，同一 agent 的其他授权，以及其他 agent 的授权，都不受影响。",
    },
    otherwise: {
      outcome: "denied",
      caption: {
        en: "<b>Mail assistant</b> never got a window — its write still bounces. Default-deny doesn't drift.",
        zh: "<b>Mail assistant</b> 没拿到信任窗口，写入仍未获授权，这次调用也就仍被拒绝。默认拒绝的规则没有放宽。",
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
      zh: "这段模拟演示持续六十秒，每个事件都有记录，每个 agent 各有一条<b>审计轨迹</b>。要亲手跑一遍真实的<b>信任闭环</b>，请跟着指南操作。",
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
    zh: "这里展示五个 agent 穿过 Plexus 之墙调用能力的过程。能力标识是真实的，事件形状也沿用真实监控的格式。但显示的事件都是脚本编排的，循环播放，不代表 agent 此刻正在调用这些能力。",
  } as Bi,
  run: { en: "run it for real →", zh: "跟着指南跑一遍 →" } as Bi,
  runHref: { en: "/guide/", zh: "/zh/guide/" } as Bi,
  cardEyebrow: { en: "At the wall — your call", zh: "停在墙前，等你决定" } as Bi,
  /** who: `{agent}` + this middle + `{cap}` (agent-then-cap in both locales). */
  cardWhoMid: { en: " wants to run ", zh: "想调用" } as Bi,
  cardMetaWrite: {
    en: "approving opens a trust window (<code>1d</code>); denying keeps default-deny",
    zh: "批准这次写入，会开启信任窗口（<code>1d</code>）；拒绝则仍按默认拒绝处理",
  } as Bi,
  cardMetaExecute: {
    en: "execute is per-call by default — approving grants <code>once</code>",
    zh: "execute 默认按次批准——本次批准为 <code>once</code>，只准这一次；常驻授权须由拥有者另行明确开启",
  } as Bi,
  approve: { en: "Approve", zh: "批准" } as Bi,
  deny: { en: "Deny", zh: "拒绝" } as Bi,
  ledgerLabel: { en: "Recent activity", zh: "最近活动" } as Bi,
  /** count reads `· {n} events` / `· {n} 条`. */
  ledgerCountPre: { en: "· ", zh: "· " } as Bi,
  ledgerCountPost: { en: " events", zh: "条" } as Bi,
  ledgerHint: {
    en: "— hover a row to replay it above ↑",
    zh: "——悬停在一行上，在上方重放 ↑",
  } as Bi,
  ariaCanvas: {
    en: "Simulated activity: five agents calling capabilities through the Plexus wall; writes and execute pend for approval",
    zh: "模拟演示：五个 agent 穿过 Plexus 之墙调用能力。脚本中的首次写入与逐次 execute 请求会挂起，等你批准或拒绝。",
  } as Bi,
};

/** Agent id → display label (captions/ledger show labels, the engine gets ids). */
export const AGENT_LABEL: Record<string, string> = Object.fromEntries(
  AGENTS.map((a) => [a.id, a.label]),
);
