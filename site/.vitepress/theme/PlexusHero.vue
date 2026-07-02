<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from "vue";
import { useData } from "vitepress";

const { lang } = useData();
const zh = computed(() => lang.value.startsWith("zh"));

// ── the four pillars, woven into the visual (fewer words, on purpose) ──
type Pillar = { key: string; en: string; enSub: string; zh: string; zhSub: string };
const pillars: Pillar[] = [
  { key: "shape", en: "Any shape", enSub: "your world, as it is", zh: "任意结构", zhSub: "你的世界本来的样子" },
  { key: "contract", en: "Self-describing", enSub: "an agent-native contract", zh: "自描述", zhSub: "Agent-Native 的能力契约" },
  { key: "revoke", en: "Revocable", enSub: "granted by a human, taken back anytime", zh: "可撤销", zhSub: "由人授予，随时收回" },
  { key: "audit", en: "Audited", enSub: "every call on the record", zh: "全审计", zhSub: "每一次调用都留痕" },
];

const active = ref(-1);
const canvas = ref<HTMLCanvasElement | null>(null);

let raf = 0;
let ro: ResizeObserver | null = null;
let mo: MutationObserver | null = null;

onMounted(() => {
  const cv = canvas.value!;
  const ctx = cv.getContext("2d")!;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let isDark = document.documentElement.classList.contains("dark");
  let pal = readPalette();
  function readPalette() {
    const cs = getComputedStyle(document.documentElement);
    const g = (v: string, f: string) => cs.getPropertyValue(v).trim() || f;
    return {
      amber: g("--vp-c-brand-1", "oklch(0.8 0.135 74)"),
      ink: g("--vp-c-text-1", "#eee"),
      dim: g("--vp-c-text-3", "#888"),
      green: g("--plx-green", "oklch(0.78 0.12 158)"),
      clay: g("--plx-clay", "oklch(0.66 0.15 32)"),
    };
  }
  mo = new MutationObserver(() => {
    isDark = document.documentElement.classList.contains("dark");
    pal = readPalette();
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  let W = 0, H = 0, dpr = 1;
  type Mote = { sx: number; sy: number; ty: number; label: string; cap: string; exec?: boolean; delay: number; sec?: boolean };
  let motes: Mote[] = [];
  type Amb = { ox: number; oy: number; ty: number; period: number; phase: number };
  let ambient: Amb[] = [];
  let strandX = 0, top = 0, bot = 0, agentX = 0, agentY = 0, weaveAmp = 0;

  const rnd = (i: number, salt: number) => {
    const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };

  function layout() {
    const rect = cv.getBoundingClientRect();
    W = rect.width; H = rect.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    strandX = (W < 560 ? 0.5 : 0.52) * W;
    weaveAmp = Math.min(W * 0.028, 20);
    const objH = Math.min(H * 0.82, 340);
    top = H * 0.5 - objH / 2;
    bot = H * 0.5 + objH / 2;
    agentX = W * 0.24;
    agentY = H * 0.5;

    const names = [
      { label: "notes", cap: "notes.read" },
      { label: "calendar", cap: "calendar.list" },
      { label: "IoT", cap: "iot.toggle" },
      { label: "workspace", cap: "workspace.write" },
      { label: "files", cap: "files.read" },
      { label: "run", cap: "run.exec", exec: true },
    ];
    const n = names.length;
    motes = names.map((nm, i) => {
      const ty = top + ((bot - top) * i) / (n - 1);
      // scatter origin: spread across the right & top/bottom so convergence uses the whole plate
      const sx = W * (0.56 + rnd(i, 1) * 0.4);
      const sy = H * (0.06 + rnd(i, 2) * 0.88);
      return { sx, sy, ty, label: nm.label, cap: nm.cap, exec: nm.exec, delay: 0.5 + i * 0.11 };
    });
    for (let k = 0; k < 5; k++) {
      motes.push({
        sx: W * (0.56 + rnd(k, 3) * 0.4), sy: H * (0.04 + rnd(k, 4) * 0.92),
        ty: top + (bot - top) * rnd(k, 7), label: "", cap: "", delay: 0.35 + k * 0.06, sec: true,
      });
    }
    // ambient: resources keep flowing in from the right forever (life at rest)
    ambient = Array.from({ length: 7 }, (_, k) => ({
      ox: W * (0.72 + rnd(k, 11) * 0.26),
      oy: H * (0.08 + rnd(k, 12) * 0.84),
      ty: top + (bot - top) * rnd(k, 13),
      period: 5 + rnd(k, 14) * 5,
      phase: rnd(k, 15) * 6,
    }));
  }
  layout();
  ro = new ResizeObserver(() => layout());
  ro.observe(cv);

  let mx = 0, my = 0;
  const onMove = (e: PointerEvent) => {
    const r = cv.getBoundingClientRect();
    mx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    my = ((e.clientY - r.top) / r.height - 0.5) * 2;
  };
  cv.addEventListener("pointermove", onMove);

  const infl = { shape: 0, contract: 0, revoke: 0, audit: 0 };
  const keys = ["shape", "contract", "revoke", "audit"] as const;
  const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
  const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  const start = performance.now();

  // resolved bead x on the woven strand (a gentle S so it reads as a braid, not a bar)
  const beadX = (i: number, t: number, breathe: number) =>
    strandX + Math.sin(i * 0.85 + 0.5 + breathe) * weaveAmp;

  function frame(now: number) {
    const t = (now - start) / 1000;
    ctx.clearRect(0, 0, W, H);

    for (let i = 0; i < keys.length; i++) {
      const target = active.value === i ? 1 : 0;
      infl[keys[i]] += (target - infl[keys[i]]) * 0.12;
    }

    const marksProg = reduced ? 1 : clamp01((t - 1.7) / 0.7);
    const threadProg = reduced ? 1 : clamp01((t - 2.2) / 0.7);
    const settled = reduced || t > 2.7;
    const breathe = settled ? Math.sin(t * 0.6) * 0.15 : 0;
    const p = settled ? { x: mx * 5, y: my * 5 } : { x: 0, y: 0 };

    const narrow = W < 560;

    // ── ambient: faint resources drifting in from the right and dissolving into
    //    the strand — keeps the plate alive and balances the empty right side ──
    if (settled && !reduced && !narrow) {
      const easeIO = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
      for (const a of ambient) {
        const c = ((t + a.phase) / a.period) % 1;
        const e = easeIO(c);
        const cx = lerp(a.ox, strandX, e) + p.x;
        const cy = lerp(a.oy, a.ty, e) + p.y;
        const al = Math.sin(c * Math.PI) * 0.22;
        if (al <= 0.01) continue;
        ctx.save();
        ctx.globalAlpha = al;
        ctx.strokeStyle = pal.dim;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(lerp(cx, strandX + p.x, 0.25), lerp(cy, a.ty + p.y, 0.25)); ctx.stroke();
        ctx.fillStyle = pal.amber;
        ctx.globalAlpha = al * 1.4;
        ctx.beginPath(); ctx.arc(cx, cy, 1.6, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    }

    // resolve each primary mote → its current position (scatter → bead), collect beads
    type P = { x: number; y: number; prog: number; m: Mote };
    const beads: P[] = [];
    let bi = 0;
    for (const m of motes) {
      const local = reduced ? 1 : easeOutExpo(clamp01((t - m.delay) / 0.95));
      const disperse = infl.shape * (settled ? 0.4 : 0);
      const prog = clamp01(local * (1 - disperse));
      if (m.sec) {
        const cx = lerp(m.sx, strandX, prog) + p.x;
        const cy = lerp(m.sy, m.ty, prog) + p.y;
        const a = (1 - prog) * 0.45 * (reduced ? 0 : 1);
        if (a > 0.01) {
          ctx.save();
          ctx.globalAlpha = a;
          ctx.fillStyle = pal.dim;
          ctx.beginPath(); ctx.arc(cx, cy, 1.8, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
        continue;
      }
      const bx0 = beadX(bi, t, breathe);
      const wobble = infl.shape * Math.sin(t * 3 + bi) * 10;
      const cx = lerp(m.sx, bx0 + wobble, prog) + p.x;
      const cy = lerp(m.sy, m.ty, prog) + p.y;
      beads.push({ x: cx, y: cy, prog, m });
      bi++;
    }

    // ── the woven strand of light through the beads (the "plexus") ──
    // two interwoven filaments, phase-offset, so it reads as a braid not a bar
    if (beads.length > 1) {
      const revoke = infl.revoke;
      const drawFilament = (xoff: (i: number) => number, width: number, alpha: number, glow: number) => {
        ctx.save();
        ctx.strokeStyle = pal.amber;
        ctx.lineWidth = width;
        ctx.globalAlpha = alpha * clamp01((t - 0.9) / 0.8);
        if (isDark) { ctx.shadowColor = pal.amber; ctx.shadowBlur = glow; }
        ctx.beginPath();
        ctx.moveTo(beads[0].x + xoff(0), beads[0].y);
        for (let i = 0; i < beads.length - 1; i++) {
          const cutHere = revoke > 0.15 && (beads[i].m.exec || beads[i + 1].m.exec);
          const xc = (beads[i].x + xoff(i) + beads[i + 1].x + xoff(i + 1)) / 2;
          const yc = (beads[i].y + beads[i + 1].y) / 2;
          if (cutHere) {
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(beads[i + 1].x + xoff(i + 1), beads[i + 1].y);
          } else {
            ctx.quadraticCurveTo(beads[i].x + xoff(i), beads[i].y, xc, yc);
          }
        }
        const last = beads.length - 1;
        ctx.lineTo(beads[last].x + xoff(last), beads[last].y);
        ctx.stroke();
        ctx.restore();
      };
      const braid = Math.min(weaveAmp * 0.5, 9);
      drawFilament((i) => Math.sin(i * 1.7 + 1.2 + breathe) * braid, 1.5, 0.85, 12);
      drawFilament((i) => -Math.sin(i * 1.7 + 1.2 + breathe) * braid, 1, 0.4, 6);
    }

    // audit ledger line drawn alongside the strand on "Audited" hover
    if (infl.audit > 0.02 && beads.length) {
      const lx = strandX + weaveAmp + 26 + p.x;
      ctx.save();
      ctx.globalAlpha = infl.audit * 0.8;
      ctx.strokeStyle = pal.green;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(lx, top + p.y); ctx.lineTo(lx, bot + p.y); ctx.stroke();
      // a dot travelling the ledger, logging each call
      const yy = lerp(top, bot, (t * 0.4) % 1) + p.y;
      ctx.setLineDash([]);
      ctx.globalAlpha = infl.audit;
      ctx.fillStyle = pal.green;
      ctx.beginPath(); ctx.arc(lx, yy, 2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // ── beads + labels ──
    for (const b of beads) {
      const { x: cx, y: cy, prog, m } = b;
      // in-flight human name (the scattered thing)
      if (prog < 0.98 && !reduced) {
        ctx.save();
        ctx.globalAlpha = clamp01((0.9 - prog) * 1.5) * 0.85;
        ctx.fillStyle = pal.dim;
        ctx.font = '500 12px "Hanken Grotesk", sans-serif';
        ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(m.label, cx, cy - 9);
        ctx.restore();
      }
      const revoke = m.exec ? infl.revoke : 0;
      const r = 2.5 + prog * 3;
      const beadColor = revoke > 0.02 ? mixToward(pal.amber, pal.clay, revoke) : pal.amber;
      ctx.save();
      ctx.globalAlpha = 0.4 + prog * 0.6;
      ctx.fillStyle = beadColor;
      if (isDark) { ctx.shadowColor = beadColor; ctx.shadowBlur = 8 * prog; }
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      // a soft ring on light theme to give the bead presence without glow
      if (!isDark && prog > 0.5) {
        ctx.globalAlpha = (0.4 + prog * 0.6) * 0.25;
        ctx.strokeStyle = beadColor; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(cx, cy, r + 3, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
      // capability id on "Self-describing" hover (mono = machine)
      if (infl.contract > 0.02 && prog > 0.6) {
        ctx.save();
        ctx.globalAlpha = infl.contract * 0.95;
        ctx.fillStyle = revoke > 0.3 ? pal.clay : (isDark ? pal.ink : pal.dim);
        ctx.font = '500 11px "Spline Sans Mono", monospace';
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(m.cap, cx + weaveAmp + 12, cy);
        ctx.restore();
      }
    }

    // ── governance marks on the strand (the boundary made legible) ──
    if (marksProg > 0.01 && beads.length) {
      const gx = strandX - weaveAmp - 30 + p.x;
      const lockY = lerp(top, bot, 0.28) + p.y;
      const tickY = lerp(top, bot, 0.72) + p.y;
      const pulse = 1 + infl.revoke * 0.3 * (0.6 + 0.4 * Math.sin(t * 6));
      drawLock(gx, lockY, 7 * pulse, pal.amber, marksProg);
      drawTick(gx, tickY, 7, pal.green, marksProg * (0.5 + 0.5 * (infl.audit || 1) * 0 + 1) * 0.9 + marksProg * 0.1);
      // faint labels for the marks, only on their related hover
      if (infl.revoke > 0.05 || infl.audit > 0.05) {
        ctx.save();
        ctx.font = '500 10px "Spline Sans Mono", monospace';
        ctx.textAlign = "right"; ctx.textBaseline = "middle";
        if (infl.revoke > 0.05) { ctx.globalAlpha = infl.revoke * 0.9; ctx.fillStyle = pal.amber; ctx.fillText("authorize", gx - 12, lockY); }
        if (infl.audit > 0.05) { ctx.globalAlpha = infl.audit * 0.9; ctx.fillStyle = pal.green; ctx.fillText("audit", gx - 12, tickY); }
        ctx.restore();
      }
    }

    // ── agent node + thread to the strand (wide screens only; the 3-zone flow
    //    needs horizontal room, and touch devices can't hover the pillars) ──
    if (!narrow) {
    const aw = 60, ah = 38;
    const axx = agentX + p.x * 0.4, ayy = agentY + p.y * 0.4;
    ctx.save();
    ctx.globalAlpha = reduced ? 1 : clamp01(t / 0.6);
    ctx.strokeStyle = pal.ink;
    ctx.lineWidth = 1;
    roundRect(axx - aw / 2, ayy - ah / 2, aw, ah, 9);
    ctx.stroke();
    ctx.fillStyle = pal.ink;
    ctx.font = '600 12px "Hanken Grotesk", sans-serif';
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.globalAlpha *= 0.9;
    ctx.fillText("agent", axx, ayy);
    ctx.restore();

    if (threadProg > 0.01 && beads.length) {
      const x0 = axx + aw / 2;
      const x1 = strandX - weaveAmp - 6 + p.x;
      const y0 = ayy;
      ctx.save();
      ctx.globalAlpha = threadProg;
      ctx.strokeStyle = pal.amber;
      ctx.lineWidth = 1.25;
      if (isDark) { ctx.shadowColor = pal.amber; ctx.shadowBlur = 6; }
      const xe = lerp(x0, x1, threadProg);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(xe, y0); ctx.stroke();
      ctx.restore();
      if (settled) {
        const tt = (t * 0.5) % 1;
        ctx.save();
        ctx.globalAlpha = (1 - tt) * 0.9;
        ctx.fillStyle = pal.amber;
        ctx.beginPath(); ctx.arc(lerp(x0, x1, tt), y0, 2.2, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = pal.dim;
        ctx.font = '500 11px "Spline Sans Mono", monospace';
        ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText("list → invoke", (x0 + x1) / 2, y0 - 8);
        ctx.restore();
      }
    }
    } // end !narrow

    raf = requestAnimationFrame(frame);
  }

  function mixToward(a: string, b: string, t: number) {
    return `color-mix(in oklch, ${a} ${Math.round((1 - t) * 100)}%, ${b})`;
  }
  function roundRect(x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawLock(x: number, y: number, r: number, color: string, alpha: number) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    if (isDark) { ctx.shadowColor = color; ctx.shadowBlur = 6; }
    ctx.lineWidth = 1.2;
    roundRect(x - r * 0.7, y - r * 0.15, r * 1.4, r * 1.1, 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y - r * 0.15, r * 0.45, Math.PI, 0);
    ctx.stroke();
    ctx.restore();
  }
  function drawTick(x: number, y: number, r: number, color: string, alpha: number) {
    ctx.save();
    ctx.globalAlpha = Math.min(alpha, 1);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = Math.min(alpha, 1) * 0.5;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = Math.min(alpha, 1);
    ctx.beginPath();
    ctx.moveTo(x - r * 0.4, y);
    ctx.lineTo(x - r * 0.05, y + r * 0.4);
    ctx.lineTo(x + r * 0.45, y - r * 0.4);
    ctx.stroke();
    ctx.restore();
  }

  raf = requestAnimationFrame(frame);

  onBeforeUnmount(() => {
    cancelAnimationFrame(raf);
    ro?.disconnect();
    mo?.disconnect();
    cv.removeEventListener("pointermove", onMove);
  });
});
</script>

<template>
  <section class="plx-hero">
    <div class="plx-canvas-wrap">
      <canvas ref="canvas"></canvas>
    </div>
    <p class="plx-vislabel">
      {{ zh ? "散落的资源 → 一个自描述、可操作、受治理的对象 → agent 读取并调用"
            : "scattered resources → one self-describing, operable, governed object → the agent reads and invokes" }}
    </p>

    <ul class="plx-pillars" @mouseleave="active = -1">
      <li
        v-for="(p, i) in pillars"
        :key="p.key"
        :class="['plx-pillar', { on: active === i }]"
        @mouseenter="active = i"
        @focusin="active = i"
        tabindex="0"
      >
        <span class="plx-pillar-i">{{ String(i + 1).padStart(2, "0") }}</span>
        <span class="plx-pillar-title">{{ zh ? p.zh : p.en }}</span>
        <span class="plx-pillar-sub">{{ zh ? p.zhSub : p.enSub }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.plx-hero {
  max-width: 1152px;
  margin: 0 auto;
  padding: 0 24px 8px;
  box-sizing: border-box;
}
.plx-canvas-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 20 / 9;
  min-height: 240px;
  max-height: 460px;
}
.plx-canvas-wrap canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
.plx-vislabel {
  margin: 10px auto 0;
  max-width: 60ch;
  text-align: center;
  font-size: 12px;
  line-height: 1.5;
  letter-spacing: 0.01em;
  color: var(--vp-c-text-3);
}

.plx-pillars {
  list-style: none;
  margin: 16px 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border-top: 1px solid var(--vp-c-divider);
}
.plx-pillar {
  position: relative;
  padding: 18px 20px 16px;
  cursor: default;
  outline: none;
  transition: background-color 0.3s ease;
  border-radius: 0 0 10px 10px;
}
.plx-pillar + .plx-pillar {
  box-shadow: -1px 0 0 var(--vp-c-divider);
}
.plx-pillar::before {
  content: "";
  position: absolute;
  top: -1px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--vp-c-brand-1);
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
.plx-pillar.on {
  background: var(--vp-c-brand-softer);
}
.plx-pillar.on::before {
  transform: scaleX(1);
}
.plx-pillar-i {
  display: block;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  color: var(--vp-c-text-3);
  letter-spacing: 0.04em;
  margin-bottom: 8px;
  transition: color 0.3s ease;
}
.plx-pillar.on .plx-pillar-i {
  color: var(--vp-c-brand-1);
}
.plx-pillar-title {
  display: block;
  font-size: 16px;
  font-weight: 700;
  color: var(--vp-c-text-1);
  letter-spacing: -0.01em;
  margin-bottom: 4px;
}
.plx-pillar-sub {
  display: block;
  font-size: 13px;
  line-height: 1.45;
  color: var(--vp-c-text-2);
}

@media (max-width: 720px) {
  .plx-pillars {
    grid-template-columns: repeat(2, 1fr);
  }
  .plx-pillar:nth-child(3),
  .plx-pillar:nth-child(4) {
    border-top: 1px solid var(--vp-c-divider);
  }
  .plx-canvas-wrap {
    aspect-ratio: 4 / 3;
  }
}
@media (prefers-reduced-motion: reduce) {
  .plx-pillar,
  .plx-pillar::before,
  .plx-pillar-i {
    transition: none;
  }
}
</style>
