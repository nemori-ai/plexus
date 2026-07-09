<script setup lang="ts">
/**
 * RealtimeDemo — the home-page "Watch it govern" simulated monitor.
 *
 * Chrome (header pill, framed stage, pending cards, caption line, act rail,
 * compact ledger) + the script driver around the verbatim-copied admin
 * RealtimeEngine. The scenario itself (world, beats, strings) lives in
 * realtime-script.ts; the spec is docs/design/site-realtime-demo.md.
 *
 * All browser APIs live inside onMounted — vitepress build SSR-renders the
 * home page, so module/setup scope must stay DOM-free.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useData } from "vitepress";
import { RealtimeEngine, type FlowKind } from "./realtime-engine";
import {
  ACT_STARTS,
  ACTS,
  AGENT_LABEL,
  AGENTS,
  BEATS,
  CAPS,
  LOOP_LEN,
  STRINGS,
  type Beat,
  type Bi,
  type PendBeat,
} from "./realtime-script";

const { lang } = useData();
const zh = computed(() => lang.value.startsWith("zh"));
const t = (b: Bi): string => (zh.value ? b.zh : b.en);

// ── reactive chrome state ─────────────────────────────────────────────────────
type Cls = "invoke" | "allow" | "deny" | "pend";
interface LedgerRow {
  key: string;
  timeStr: string;
  ev: string;
  cls: Cls;
  agentId: string;
  agentLabel: string;
  capId: string;
  oc: "ok" | "no" | "wait";
  out: string;
  bounced: boolean;
}
interface OpenCard {
  key: string;
  beat: PendBeat;
}

const MAX_ROWS = 40;
const rootEl = ref<HTMLElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const rows = ref<LedgerRow[]>([]);
const cards = ref<OpenCard[]>([]);
const caption = ref<Bi | null>(null);
const actIndex = ref(0);
const litKey = ref<string | null>(null);

const captionHtml = computed(() => (caption.value ? t(caption.value) : ""));

// ── driver state (non-reactive; only ever touched client-side) ───────────────
let engine: RealtimeEngine | null = null;
let elapsed = 0; // ms since loop start — advanced per frame, frozen while paused
let fired = new Set<string>();
let flags: Record<string, boolean> = {};
let loopIndex = 0;
let inView = true;
let raf = 0;
let mo: MutationObserver | null = null;
let io: IntersectionObserver | null = null;

function hhmmss(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
}

function pushRow(key: string, row: Omit<LedgerRow, "key" | "timeStr">): void {
  rows.value = [{ key, timeStr: hhmmss(Date.now()), ...row }, ...rows.value].slice(0, MAX_ROWS);
}

// classify() table from the admin monitor: invoke/ok → ✓ ok; invoke/denied →
// ⊘ blocked (bounced); allow → ✓ allowed; deny → ⊘ denied; pend → ⏳ waiting.
function runBeat(b: Beat): void {
  if (b.kind === "flow") {
    let outcome = b.outcome;
    let cap = b.caption;
    if (b.requires && (flags[b.requires.flag] ?? false) !== b.requires.value) {
      if (!b.otherwise) return; // skip
      outcome = b.otherwise.outcome;
      cap = b.otherwise.caption;
    }
    engine?.fire(b.agent, b.cap, outcome === "ok" ? "invoke" : "deny");
    pushRow(`${loopIndex}:${b.id}`, {
      ev: outcome === "ok" ? "invoke" : "deny",
      cls: outcome === "ok" ? "invoke" : "deny",
      oc: outcome === "ok" ? "ok" : "no",
      out: outcome === "ok" ? "ok" : "blocked",
      bounced: outcome !== "ok",
      agentId: b.agent,
      agentLabel: AGENT_LABEL[b.agent] ?? b.agent,
      capId: b.cap,
    });
    if (cap) caption.value = cap;
  } else if (b.kind === "pend") {
    engine?.fire(b.agent, b.cap, "pend");
    pushRow(`${loopIndex}:${b.id}`, {
      ev: "pend",
      cls: "pend",
      oc: "wait",
      out: "waiting",
      bounced: true,
      agentId: b.agent,
      agentLabel: AGENT_LABEL[b.agent] ?? b.agent,
      capId: b.cap,
    });
    cards.value = [...cards.value, { key: `${loopIndex}:${b.id}`, beat: b }];
    caption.value = b.caption;
  } else {
    // note beat — control-plane: caption and/or a ledger row, no canvas flow.
    if (b.ledger) {
      pushRow(`${loopIndex}:${b.id}`, {
        ev: b.ledger.ev,
        cls: "deny",
        oc: "no",
        out: b.ledger.out,
        bounced: false,
        agentId: b.ledger.agent,
        agentLabel: AGENT_LABEL[b.ledger.agent] ?? b.ledger.agent,
        capId: b.ledger.cap,
      });
    }
    if (b.caption) caption.value = b.caption;
  }
}

/** Resolve a pending card (visitor click or the script's auto-approve). */
function resolveCard(card: OpenCard, approved: boolean): void {
  cards.value = cards.value.filter((c) => c.key !== card.key);
  engine?.resolveWaiting(card.beat.agent, card.beat.cap, approved);
  pushRow(`${card.key}:res`, {
    ev: approved ? "allow" : "deny",
    cls: approved ? "allow" : "deny",
    oc: approved ? "ok" : "no",
    out: approved ? "allowed" : "denied",
    bounced: !approved,
    agentId: card.beat.agent,
    agentLabel: AGENT_LABEL[card.beat.agent] ?? card.beat.agent,
    capId: card.beat.cap,
  });
  caption.value = approved ? card.beat.onApprove : card.beat.onDeny;
  flags[card.beat.flag] = approved;
}

/** Act-rail chapter click — jump the loop clock to that act's start. */
function jumpToAct(n: number): void {
  for (const c of [...cards.value]) resolveCard(c, true); // force-resolve as default
  // In-flight canvas flows self-expire — nothing else to clear. Bump loopIndex so
  // any beat re-fired by a rewind mints fresh ledger/card keys (no collisions).
  loopIndex++;
  const start = ACT_STARTS[n] ?? 0;
  elapsed = start * 1000;
  fired = new Set(BEATS.filter((b) => b.t < start).map((b) => b.id));
  actIndex.value = n;
}

/** Row hover — purely visual replay (a pend row replays as a bounce). */
function replayRow(e: LedgerRow): void {
  litKey.value = e.key;
  engine?.replay(e.agentId, e.capId, (e.cls === "pend" ? "deny" : e.cls) as FlowKind);
}

function step(): void {
  for (const b of BEATS) {
    if (fired.has(b.id) || b.t * 1000 > elapsed) continue;
    fired.add(b.id);
    runBeat(b);
  }
  for (const c of [...cards.value]) {
    if (elapsed >= c.beat.resolveAt * 1000) resolveCard(c, true);
  }
  let idx = 0;
  for (let i = 0; i < ACT_STARTS.length; i++) {
    if (elapsed >= (ACT_STARTS[i] ?? 0) * 1000) idx = i;
  }
  if (actIndex.value !== idx) actIndex.value = idx;
  if (elapsed >= LOOP_LEN) {
    for (const c of [...cards.value]) resolveCard(c, true); // as their default
    fired.clear();
    flags = {};
    loopIndex++;
    elapsed = 0;
    actIndex.value = 0; // ledger persists across loops
  }
}

onMounted(() => {
  const cv = canvas.value;
  const root = rootEl.value;
  if (!cv || !root) return;

  engine = new RealtimeEngine(cv);
  engine.setWorld(AGENTS, CAPS);
  engine.start();

  // Palette re-read on `.dark` class flips — PlexusHero's pattern.
  mo = new MutationObserver(() => engine?.refreshPalette());
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  // Out-of-view → engine off + clock frozen; back in view → resume mid-act.
  io = new IntersectionObserver(
    (entries) => {
      const vis = entries[0]?.isIntersecting ?? true;
      if (vis === inView) return;
      inView = vis;
      if (vis) engine?.start();
      else engine?.stop();
    },
    { threshold: 0 },
  );
  io.observe(root);

  // One shared rAF clock — never setTimeout. The dt clamp means a background
  // gap (rAF starved while hidden) resumes with no event burst.
  let last = performance.now();
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(now - last, 100);
    last = now;
    if (!inView || document.hidden) return; // clock paused
    elapsed += dt;
    step();
  };
  raf = requestAnimationFrame(tick);
});

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  io?.disconnect();
  io = null;
  mo?.disconnect();
  mo = null;
  engine?.destroy();
  engine = null;
});
</script>

<template>
  <section ref="rootEl" class="rt-demo">
    <header class="rt-head">
      <div class="rt-head-text">
        <span class="rt-live"><span class="dot"></span>{{ t(STRINGS.pill) }}</span>
        <p class="rt-eyebrow">{{ t(STRINGS.eyebrow) }}</p>
        <h2 class="rt-title">{{ t(STRINGS.heading) }}</h2>
        <p class="rt-sub">{{ t(STRINGS.sub) }}</p>
      </div>
      <a class="rt-run" :href="t(STRINGS.runHref)">{{ t(STRINGS.run) }}</a>
    </header>

    <div class="rt-stagewrap">
      <div class="rt-stage">
        <canvas ref="canvas" class="rt-canvas" role="img" :aria-label="t(STRINGS.ariaCanvas)"></canvas>
      </div>
      <div v-if="cards.length" class="rt-pends">
        <div v-for="c in cards" :key="c.key" class="rt-pend">
          <div class="eyebrow"><span class="pd"></span>{{ t(STRINGS.cardEyebrow) }}</div>
          <div class="who">
            <span class="ag">{{ AGENT_LABEL[c.beat.agent] }}</span>{{ t(STRINGS.cardWhoMid) }}<code>{{ c.beat.cap }}</code>
          </div>
          <div
            class="meta"
            v-html="t(c.beat.window === 'once' ? STRINGS.cardMetaExecute : STRINGS.cardMetaWrite)"
          ></div>
          <div class="acts">
            <button class="approve" @click="resolveCard(c, true)">
              {{ t(STRINGS.approve) }} · {{ c.beat.window }}
            </button>
            <button class="deny" @click="resolveCard(c, false)">{{ t(STRINGS.deny) }}</button>
          </div>
        </div>
      </div>
    </div>

    <div class="rt-capline">
      <p class="rt-cap" aria-live="polite" v-html="captionHtml"></p>
    </div>

    <div class="rt-rail">
      <button
        v-for="(a, i) in ACTS"
        :key="i"
        class="rt-act"
        :class="{ on: actIndex === i }"
        :aria-current="actIndex === i ? 'step' : undefined"
        @click="jumpToAct(i)"
      >
        <span class="i">{{ String(i + 1).padStart(2, "0") }}</span>
        <span class="t">{{ t(a.title) }}</span>
        <span class="s">{{ t(a.sub) }}</span>
      </button>
    </div>

    <div class="rt-ledger">
      <div class="rt-ledger-head">
        {{ t(STRINGS.ledgerLabel) }}
        <span class="count">{{ t(STRINGS.ledgerCountPre) }}{{ rows.length }}{{ t(STRINGS.ledgerCountPost) }}</span>
        <span class="rh">{{ t(STRINGS.ledgerHint) }}</span>
      </div>
      <div class="rt-rows">
        <div
          v-for="e in rows"
          :key="e.key"
          class="rt-row"
          :class="{ lit: litKey === e.key }"
          @mouseenter="replayRow(e)"
          @mouseleave="litKey = null"
        >
          <span class="t">{{ e.timeStr }}</span>
          <span :class="`ev ${e.cls}`">{{ e.ev }}</span>
          <span class="path">
            <span class="ag">{{ e.agentLabel }}</span>
            <span :class="e.bounced ? 'sep b' : 'sep'">{{ e.bounced ? "⊗" : "→" }}</span>
            <code>{{ e.capId }}</code>
          </span>
          <span :class="`out ${e.oc}`">{{ e.oc === "ok" ? "✓" : e.oc === "no" ? "⊘" : "⏳" }} {{ e.out }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ── admin-token shim (chrome only — the engine reads documentElement, where
   these element-scoped vars are invisible; it got the direct token edit). ── */
.rt-demo {
  --ink: var(--vp-c-text-1);
  --ink-dim: var(--vp-c-text-2);
  --ink-faint: var(--vp-c-text-3);
  --ink-ghost: var(--vp-c-text-3);
  --hairline: var(--vp-c-divider);
  --hairline-strong: var(--vp-c-border);
  --amber: var(--vp-c-brand-1);
  --grant: var(--plx-green);
  --deny: var(--plx-clay);
  --bg: var(--vp-c-bg);
  --bg-deep: var(--vp-c-bg-alt);
  --surface: var(--vp-c-bg-soft);
  --surface-raised: var(--vp-c-bg-elv);
  --font-mono: var(--vp-font-family-mono);
  --font-ui: var(--vp-font-family-base);
}

/* ── component frame (matches .plx-hero's measure) ── */
.rt-demo {
  max-width: 1152px;
  margin: 0 auto;
  padding: 0 24px 8px;
  box-sizing: border-box;
  color: var(--ink);
}

/* ── header row: pill + eyebrow/heading/sub + escape hatch ── */
.rt-head {
  display: flex;
  align-items: flex-end;
  gap: 18px;
  margin: 4px 0 14px;
}
.rt-head-text {
  flex: 1 1 auto;
  min-width: 0;
}
.rt-eyebrow {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--amber);
  margin: 12px 0 6px;
}
.rt-title {
  font-size: clamp(1.5rem, 2.6vw, 2rem);
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.15;
  color: var(--ink);
  margin: 0 0 8px;
  border: none;
  padding: 0;
}
.rt-sub {
  margin: 0;
  color: var(--ink-dim);
  font-size: 14.5px;
  line-height: 1.55;
  max-width: 60ch;
}
.rt-run {
  flex: none;
  font-weight: 600;
  font-size: 14px;
  color: var(--amber);
  text-decoration: none;
  white-space: nowrap;
  padding-bottom: 2px;
}
.rt-run:hover {
  color: var(--vp-c-brand-2);
}

/* ── lifted: the live pill (word swapped to "Simulated" in the template) ── */
.rt-live {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink-dim);
}
.rt-live .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--grant);
  animation: rt-lp 2.4s ease-out infinite;
}
@keyframes rt-lp {
  0% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--grant) 55%, transparent); }
  70%, 100% { box-shadow: 0 0 0 7px transparent; }
}

/* ── lifted: stage + canvas (restyled as a framed panel, not a full frame) ── */
.rt-stagewrap {
  position: relative;
}
.rt-stage {
  position: relative;
  height: clamp(340px, 46vh, 460px);
  border: 1px solid var(--hairline);
  border-radius: 12px;
  background: var(--bg-deep);
  overflow: hidden;
}
.rt-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

/* ── lifted: pending cards (stack top-right; static below the stage on phones) ── */
.rt-pends {
  position: absolute;
  top: 16px;
  right: 22px;
  width: 300px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  z-index: 5;
  max-height: calc(100% - 32px);
  overflow-y: auto;
}
.rt-pend {
  width: 100%;
  background: color-mix(in oklch, var(--surface-raised) 92%, transparent);
  backdrop-filter: blur(10px);
  border: 1px solid color-mix(in oklch, var(--amber) 42%, var(--hairline));
  border-radius: 13px;
  padding: 15px 16px;
  box-shadow: 0 12px 40px -12px oklch(0% 0 0 / 0.5);
  animation: rt-pin 0.35s cubic-bezier(0.2, 0.9, 0.3, 1);
  flex: none;
}
@keyframes rt-pin {
  from { opacity: 0; transform: translateY(-8px) scale(0.97); }
}
.rt-pend .eyebrow {
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--amber);
  display: flex;
  align-items: center;
  gap: 6px;
}
.rt-pend .eyebrow .pd {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--amber);
  animation: rt-lp 1.6s ease-out infinite;
}
.rt-pend .who {
  margin-top: 10px;
  font-size: 13.5px;
  color: var(--ink);
}
.rt-pend .who .ag {
  font-weight: 600;
}
.rt-pend .who code {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--amber);
}
.rt-pend .meta {
  margin-top: 5px;
  font-size: 11.5px;
  color: var(--ink-faint);
}
.rt-pend .meta :deep(code) {
  font-family: var(--font-mono);
  color: var(--amber);
}
.rt-pend .acts {
  margin-top: 13px;
  display: flex;
  gap: 8px;
}
.rt-pend .acts button {
  flex: 1;
  font-family: var(--font-ui);
  font-size: 12.5px;
  font-weight: 600;
  border-radius: 8px;
  padding: 8px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: filter 0.15s, background 0.15s;
}
.rt-pend .approve {
  background: var(--amber);
  color: var(--bg-deep);
}
.rt-pend .approve:hover {
  filter: brightness(1.08);
}
.rt-pend .deny {
  background: transparent;
  border-color: color-mix(in oklch, var(--deny) 60%, transparent);
  color: var(--deny);
}
.rt-pend .deny:hover {
  background: color-mix(in oklch, var(--deny) 12%, transparent);
}

/* ── lifted: caption — restyled as the dedicated line below the stage
   (plx-caption pattern; <b>/<code> styled like plx-vislabel). ── */
.rt-capline {
  min-height: 3em;
  margin: 14px auto 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.rt-cap {
  margin: 0;
  max-width: 68ch;
  text-align: center;
  font-size: 13px;
  line-height: 1.6;
  letter-spacing: 0.01em;
  color: var(--ink-dim);
}
.rt-cap :deep(b) {
  color: var(--amber);
  font-weight: 700;
}
.rt-cap :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  color: var(--ink);
  background: var(--surface);
  padding: 1px 5px;
  border-radius: 5px;
}

/* ── act rail — the pillar strip's visual language, now clickable chapters ── */
.rt-rail {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  border-top: 1px solid var(--hairline);
  margin: 14px 0 16px;
}
.rt-act {
  position: relative;
  appearance: none;
  background: none;
  border: none;
  font-family: var(--font-ui);
  color: inherit;
  text-align: left;
  padding: 14px 16px 12px;
  cursor: pointer;
  border-radius: 0 0 10px 10px;
  transition: background-color 0.3s ease;
}
.rt-act + .rt-act {
  box-shadow: -1px 0 0 var(--hairline);
}
.rt-act::before {
  content: "";
  position: absolute;
  top: -1px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--amber);
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
.rt-act:hover {
  background: color-mix(in oklch, var(--amber) 5%, transparent);
}
.rt-act.on {
  background: var(--vp-c-brand-softer);
}
.rt-act.on::before {
  transform: scaleX(1);
}
.rt-act:focus-visible {
  outline: 2px solid var(--amber);
  outline-offset: -2px;
}
.rt-act .i {
  display: block;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-faint);
  letter-spacing: 0.04em;
  margin-bottom: 7px;
  transition: color 0.3s ease;
}
.rt-act.on .i {
  color: var(--amber);
}
.rt-act .t {
  display: block;
  font-size: 14px;
  font-weight: 700;
  color: var(--ink);
  letter-spacing: -0.01em;
  margin-bottom: 3px;
}
.rt-act .s {
  display: block;
  font-size: 12px;
  line-height: 1.45;
  color: var(--ink-dim);
}

/* ── lifted: ledger (compact — 5 visible rows; row click does nothing) ── */
.rt-ledger {
  height: 176px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--hairline);
  border-radius: 12px;
  background: var(--bg);
  overflow: hidden;
}
.rt-ledger-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 10px 18px 8px;
  font-size: 10.5px;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  color: var(--ink-ghost);
}
.rt-ledger-head .count {
  color: var(--ink-faint);
  letter-spacing: normal;
  text-transform: none;
  font-family: var(--font-mono);
  font-size: 11px;
}
.rt-ledger-head .rh {
  margin-left: auto;
  text-transform: none;
  letter-spacing: normal;
  font-size: 11px;
  color: var(--ink-ghost);
}
.rt-rows {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}
.rt-rows::-webkit-scrollbar {
  width: 9px;
}
.rt-rows::-webkit-scrollbar-thumb {
  background: var(--hairline);
  border-radius: 6px;
  border: 2px solid var(--bg);
}
.rt-row {
  display: grid;
  grid-template-columns: 74px 88px 1fr 92px;
  align-items: center;
  gap: 14px;
  padding: 6px 18px;
  border-bottom: 1px solid color-mix(in oklch, var(--hairline) 45%, transparent);
  font-size: 12.5px;
  transition: background 0.12s;
  animation: rt-rin 0.4s cubic-bezier(0.2, 0.9, 0.3, 1);
}
@keyframes rt-rin {
  from { opacity: 0; transform: translateX(-6px); }
}
.rt-row:hover {
  background: color-mix(in oklch, var(--amber) 8%, transparent);
}
.rt-row.lit {
  background: color-mix(in oklch, var(--amber) 13%, transparent);
}
.rt-row .t {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-ghost);
  font-variant-numeric: tabular-nums;
}
.rt-row .ev {
  font-family: var(--font-mono);
  font-size: 10.5px;
  justify-self: start;
  padding: 2px 8px;
  border-radius: 5px;
  border: 1px solid var(--hairline);
  color: var(--ink-dim);
}
.rt-row .ev.allow {
  color: var(--grant);
  border-color: color-mix(in oklch, var(--grant) 42%, transparent);
  background: color-mix(in oklch, var(--grant) 9%, transparent);
}
.rt-row .ev.deny {
  color: var(--deny);
  border-color: color-mix(in oklch, var(--deny) 48%, transparent);
  background: color-mix(in oklch, var(--deny) 10%, transparent);
}
.rt-row .ev.pend {
  color: var(--amber);
  border-color: color-mix(in oklch, var(--amber) 45%, transparent);
  background: color-mix(in oklch, var(--amber) 10%, transparent);
}
.rt-row .path {
  color: var(--ink-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rt-row .path .ag {
  color: var(--ink);
}
.rt-row .path code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--amber);
}
.rt-row .path .sep {
  color: var(--ink-ghost);
  margin: 0 5px;
}
.rt-row .path .sep.b {
  color: var(--deny);
}
.rt-row .out {
  justify-self: end;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.rt-row .out.ok {
  color: var(--grant);
}
.rt-row .out.no {
  color: var(--deny);
}
.rt-row .out.wait {
  color: var(--amber);
}

/* ── responsive ── */
@media (max-width: 720px) {
  .rt-head {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .rt-stage {
    height: 300px;
  }
  .rt-ledger {
    height: 150px; /* 4 visible rows */
  }
  .rt-rail {
    grid-template-columns: repeat(2, 1fr);
  }
  .rt-act:nth-child(n + 3) {
    border-top: 1px solid var(--hairline);
  }
}
@media (max-width: 560px) {
  /* cards leave the overlay: static, full width, between stage and caption */
  .rt-pends {
    position: static;
    width: 100%;
    max-height: none;
    overflow: visible;
    margin-top: 10px;
  }
  .rt-row {
    grid-template-columns: 58px 64px 1fr 78px;
    gap: 8px;
    padding: 6px 12px;
  }
  .rt-ledger-head {
    padding: 10px 12px 8px;
  }
}

/* ── lifted: reduced motion (the engine collapses flow durations itself) ── */
@media (prefers-reduced-motion: reduce) {
  .rt-row, .rt-pend, .rt-live .dot, .rt-pend .pd { animation: none !important; }
}
</style>
