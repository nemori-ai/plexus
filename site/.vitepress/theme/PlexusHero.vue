<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useData } from "vitepress";

const { lang } = useData();
const zh = computed(() => lang.value.startsWith("zh"));

// ── the four pillars, woven into the visual (fewer words, on purpose) ──
type Pillar = { key: string; en: string; enSub: string; zh: string; zhSub: string };
const pillars: Pillar[] = [
  { key: "shape", en: "Any shape", enSub: "your world, as it is", zh: "任意结构", zhSub: "你的世界本来的样子" },
  { key: "contract", en: "Self-describing", enSub: "an agent-native contract", zh: "自描述", zhSub: "Agent-Native 的能力契约" },
  { key: "revoke", en: "Revocable", enSub: "granted by a human, taken back anytime", zh: "可撤销", zhSub: "由人授予，随时收回" },
  { key: "audit", en: "Audited", enSub: "every call — on its own record", zh: "全审计", zhSub: "每一次调用，各自留痕" },
];

// ── consumers: the SAME resource pool, assembled into a different projection for
//    each agent — different capabilities, names, and governance. Select to switch. ──
type Cap = { label: string; cap: string; exec?: boolean; write?: boolean };
type Consumer = { name: string; caps: Cap[] };
const consumers: Consumer[] = [
  { name: "Claude Code", caps: [
    { label: "workspace", cap: "workspace.read" },
    { label: "workspace", cap: "workspace.write", write: true },
    { label: "files", cap: "files.read" },
    { label: "run", cap: "run.exec", exec: true },
  ] },
  { name: "Codex", caps: [
    { label: "repo", cap: "git.read" },
    { label: "files", cap: "files.read" },
    { label: "run", cap: "run.exec", exec: true },
  ] },
  { name: "Raycast", caps: [
    { label: "notes", cap: "notes.read" },
    { label: "calendar", cap: "calendar.list" },
    { label: "clipboard", cap: "clipboard.read" },
  ] },
  { name: "Cron", caps: [
    { label: "calendar", cap: "calendar.list" },
    { label: "backup", cap: "backup.run", exec: true },
    { label: "files", cap: "files.read" },
  ] },
];

const active = ref(-1); // pillar hover
const consumer = ref(0); // selected consumer
const canvas = ref<HTMLCanvasElement | null>(null);

const liveText = computed(() => {
  const c = consumers[consumer.value];
  return `${c.name}: ${c.caps.map((x) => x.cap).join(", ")}`;
});
function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown" || e.key === "ArrowRight") { consumer.value = (consumer.value + 1) % consumers.length; e.preventDefault(); }
  else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { consumer.value = (consumer.value - 1 + consumers.length) % consumers.length; e.preventDefault(); }
}

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
      chip: isDark ? "oklch(0.215 0.010 66)" : "oklch(0.998 0.003 82)",
    };
  }
  mo = new MutationObserver(() => {
    isDark = document.documentElement.classList.contains("dark");
    pal = readPalette();
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  let W = 0, H = 0, dpr = 1, narrow = false;
  type Mote = { sx: number; sy: number; ty: number; label: string; cap: string; exec?: boolean; delay: number };
  type Node = { x: number; y: number; amp: number; ph: number; sp: number; big: boolean; links: number[]; emit: number };
  let motes: Mote[] = [];
  let field: Node[] = [];
  let strandX = 0, top = 0, bot = 0, cy0 = 0, weaveAmp = 0;
  let chipRects: { x: number; y: number; w: number; h: number; cx: number; cy: number }[] = [];
  let builtConsumer = -1;
  let composeStart = performance.now();

  const rnd = (i: number, salt: number) => {
    const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };

  function buildMotes(ci: number): Mote[] {
    const caps = consumers[ci].caps;
    const n = caps.length;
    return caps.map((c, i) => {
      const ty = top + (bot - top) * (n === 1 ? 0.5 : i / (n - 1));
      const f = field.length ? field[(i * 3 + ci * 2) % field.length] : null;
      const sx = f ? f.x : W * (0.7 + 0.2 * rnd(i, ci + 1));
      const sy = f ? f.y : H * (0.2 + 0.6 * rnd(i, ci + 2));
      return { sx, sy, ty, label: c.label, cap: c.cap, exec: c.exec, delay: i * 0.09 };
    });
  }

  function layout() {
    const rect = cv.getBoundingClientRect();
    W = rect.width; H = rect.height;
    narrow = W < 620;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    strandX = (narrow ? 0.5 : 0.54) * W;
    weaveAmp = Math.min(W * 0.028, 20);
    const objH = Math.min(H * 0.8, 330);
    cy0 = H * 0.5;
    top = cy0 - objH / 2;
    bot = cy0 + objH / 2;

    // consumer chips: vertical stack on the left (wide) / horizontal row on top (narrow)
    chipRects = [];
    const n = consumers.length;
    if (narrow) {
      const cw = Math.min(128, (W - 24) / n - 8), ch = 30, gap = 8;
      const totalW = n * cw + (n - 1) * gap;
      const sx = (W - totalW) / 2, y = H * 0.08;
      for (let i = 0; i < n; i++) {
        const x = sx + i * (cw + gap);
        chipRects.push({ x, y, w: cw, h: ch, cx: x + cw / 2, cy: y + ch / 2 });
      }
    } else {
      const cw = 118, ch = 34, gap = 12;
      const totalH = n * ch + (n - 1) * gap;
      const x = W * 0.12 - cw / 2, sy = cy0 - totalH / 2;
      for (let i = 0; i < n; i++) {
        const y = sy + i * (ch + gap);
        chipRects.push({ x, y, w: cw, h: ch, cx: x + cw / 2, cy: y + ch / 2 });
      }
    }

    const count = narrow ? 0 : 26;
    field = Array.from({ length: count }, (_, k) => ({
      x: W * (0.66 + rnd(k, 21) * 0.27),
      y: H * (0.04 + rnd(k, 22) * 0.92),
      amp: 2.5 + rnd(k, 23) * 5,
      ph: rnd(k, 24) * 6.28,
      sp: 0.3 + rnd(k, 25) * 0.5,
      big: rnd(k, 26) > 0.62,
      links: [],
      emit: rnd(k, 27),
    }));
    const maxLink = (W * 0.12) ** 2;
    field.forEach((a, i) => {
      a.links = field
        .map((b, j) => ({ j, d: (a.x - b.x) ** 2 + (a.y - b.y) ** 2 }))
        .filter((o) => o.j !== i && o.d < maxLink)
        .sort((p, q) => p.d - q.d)
        .slice(0, 2)
        .map((o) => o.j);
    });
    if (builtConsumer >= 0) motes = buildMotes(builtConsumer);
  }
  layout();
  ro = new ResizeObserver(() => layout());
  ro.observe(cv);

  let mx = 0, my = 0;
  const onMove = (e: PointerEvent) => {
    const r = cv.getBoundingClientRect();
    mx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    my = ((e.clientY - r.top) / r.height - 0.5) * 2;
    const px = e.clientX - r.left, py = e.clientY - r.top;
    cv.style.cursor = chipRects.some((c) => px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) ? "pointer" : "default";
  };
  const onDown = (e: PointerEvent) => {
    const r = cv.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const hit = chipRects.findIndex((c) => px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h);
    if (hit >= 0) consumer.value = hit;
  };
  cv.addEventListener("pointermove", onMove);
  cv.addEventListener("pointerdown", onDown);

  const infl = { shape: 0, contract: 0, revoke: 0, audit: 0 };
  const keys = ["shape", "contract", "revoke", "audit"] as const;
  const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
  const easeIO = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
  const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  const startT = performance.now();

  function frame(now: number) {
    const t = (now - startT) / 1000;
    ctx.clearRect(0, 0, W, H);

    // consumer switch → recompose the object
    if (builtConsumer !== consumer.value) {
      builtConsumer = consumer.value;
      composeStart = now;
      motes = buildMotes(builtConsumer);
    }
    const cs = (now - composeStart) / 1000; // seconds since the current projection began

    for (let i = 0; i < keys.length; i++) {
      infl[keys[i]] += ((active.value === i ? 1 : 0) - infl[keys[i]]) * 0.12;
    }
    // capability descriptions reveal briefly on each switch, then on demand via the pillar
    const revealBoost = clamp01((2.0 - cs) / 0.6);
    const reveal = Math.max(infl.contract, revealBoost);

    const marksProg = reduced ? 1 : clamp01((t - 1.7) / 0.7);
    const threadProg = reduced ? 1 : clamp01((cs - 0.15) / 0.7);
    const settled = reduced || t > 2.6;
    const breathe = settled ? Math.sin(t * 0.6) * 0.15 : 0;
    const p = settled ? { x: mx * 6, y: my * 6 } : { x: 0, y: 0 };
    const fieldIn = clamp01((t - 0.2) / 0.9);

    // ── aura column behind the object ──
    {
      const auraProg = clamp01((t - 1.0) / 1.0);
      ctx.save();
      ctx.globalAlpha = (isDark ? 0.16 : 0.1) * auraProg * (1 - infl.shape * 0.5);
      ctx.fillStyle = pal.amber;
      ctx.shadowColor = pal.amber;
      ctx.shadowBlur = 40;
      const aw = weaveAmp * 2 + 26;
      roundRect(strandX - aw / 2 + p.x, top - 14 + p.y, aw, bot - top + 28, aw / 2);
      ctx.fill();
      ctx.restore();
    }

    // ── resource field mesh (the shared pool) ──
    if (field.length) {
      const fx = (nd: Node) => nd.x + Math.sin(t * nd.sp + nd.ph) * nd.amp + p.x;
      const fy = (nd: Node) => nd.y + Math.cos(t * nd.sp * 0.8 + nd.ph) * nd.amp * 0.7 + p.y;
      ctx.save();
      ctx.strokeStyle = pal.dim;
      ctx.lineWidth = 1;
      for (let i = 0; i < field.length; i++) {
        const a = field[i];
        for (const j of a.links) {
          if (j <= i) continue;
          const b = field[j];
          ctx.globalAlpha = (isDark ? 0.14 : 0.12) * fieldIn;
          ctx.beginPath(); ctx.moveTo(fx(a), fy(a)); ctx.lineTo(fx(b), fy(b)); ctx.stroke();
        }
      }
      ctx.restore();
      for (const a of field) {
        const nx = fx(a), ny = fy(a);
        ctx.save();
        ctx.globalAlpha = (isDark ? 0.5 : 0.4) * fieldIn;
        ctx.fillStyle = a.big ? pal.amber : pal.dim;
        ctx.beginPath(); ctx.arc(nx, ny, a.big ? 2.4 : 1.6, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        if (settled && !reduced && a.big) {
          const c = (t * 0.35 + a.emit) % 1;
          const e = easeIO(c);
          const tx = strandX + weaveAmp + p.x;
          const ty2 = Math.max(top, Math.min(bot, ny));
          const px = lerp(nx, tx, e), py = lerp(ny, ty2, e);
          const al = Math.sin(c * Math.PI) * 0.45;
          ctx.save();
          ctx.globalAlpha = al;
          ctx.strokeStyle = pal.amber; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(lerp(nx, px, 0.5), lerp(ny, py, 0.5)); ctx.lineTo(px, py); ctx.stroke();
          ctx.fillStyle = pal.amber; ctx.globalAlpha = al * 1.5;
          ctx.beginPath(); ctx.arc(px, py, 1.8, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
      }
    }

    // resolve motes → beads (re-composes on switch, using cs)
    type P = { x: number; y: number; prog: number; m: Mote };
    const beads: P[] = [];
    motes.forEach((m, i) => {
      const local = reduced ? 1 : easeOutExpo(clamp01((cs - m.delay) / 0.9));
      const disperse = infl.shape * (settled ? 0.4 : 0);
      const prog = clamp01(local * (1 - disperse));
      const wob = infl.shape * Math.sin(t * 3 + i) * 12;
      const cx = lerp(m.sx, strandX + wob, prog) + p.x;
      const cyv = lerp(m.sy, m.ty, prog) + p.y;
      beads.push({ x: cx, y: cyv, prog, m });
    });

    // ── woven strand: two filaments + cross-rungs ──
    if (beads.length > 1) {
      const revoke = infl.revoke;
      const braid = Math.min(weaveAmp * 0.55, 10);
      const off = (i: number) => Math.sin(i * 1.7 + 1.2 + breathe) * braid;
      const drawFilament = (sign: number, width: number, alpha: number, glow: number) => {
        ctx.save();
        ctx.strokeStyle = pal.amber; ctx.lineWidth = width; ctx.lineCap = "round";
        ctx.globalAlpha = alpha * clamp01((cs - 0.15) / 0.8);
        if (isDark) { ctx.shadowColor = pal.amber; ctx.shadowBlur = glow; }
        ctx.beginPath();
        ctx.moveTo(beads[0].x + sign * off(0), beads[0].y);
        for (let i = 0; i < beads.length - 1; i++) {
          const cut = revoke > 0.15 && (beads[i].m.exec || beads[i + 1].m.exec);
          const xc = (beads[i].x + sign * off(i) + beads[i + 1].x + sign * off(i + 1)) / 2;
          const yc = (beads[i].y + beads[i + 1].y) / 2;
          if (cut) { ctx.stroke(); ctx.beginPath(); ctx.moveTo(beads[i + 1].x + sign * off(i + 1), beads[i + 1].y); }
          else ctx.quadraticCurveTo(beads[i].x + sign * off(i), beads[i].y, xc, yc);
        }
        const l = beads.length - 1;
        ctx.lineTo(beads[l].x + sign * off(l), beads[l].y);
        ctx.stroke();
        ctx.restore();
      };
      ctx.save();
      ctx.strokeStyle = pal.amber; ctx.lineWidth = 1;
      for (let i = 0; i < beads.length; i++) {
        if (beads[i].prog < 0.5) continue;
        if (revoke > 0.15 && beads[i].m.exec) continue;
        ctx.globalAlpha = 0.28 * clamp01((cs - 0.25) / 0.8);
        ctx.beginPath();
        ctx.moveTo(beads[i].x + off(i), beads[i].y);
        ctx.lineTo(beads[i].x - off(i), beads[i].y);
        ctx.stroke();
      }
      ctx.restore();
      drawFilament(1, 2, 0.9, 14);
      drawFilament(-1, 1.5, 0.55, 8);
    }

    // audit ledger line on "Audited" hover
    if (infl.audit > 0.02 && beads.length) {
      const lx = strandX + weaveAmp + 24 + p.x;
      ctx.save();
      ctx.globalAlpha = infl.audit * 0.85;
      ctx.strokeStyle = pal.green; ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(lx, top + p.y); ctx.lineTo(lx, bot + p.y); ctx.stroke();
      ctx.setLineDash([]);
      const yy = lerp(top, bot, (t * 0.4) % 1) + p.y;
      ctx.globalAlpha = infl.audit; ctx.fillStyle = pal.green;
      ctx.beginPath(); ctx.arc(lx, yy, 2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // ── beads + labels ──
    for (const b of beads) {
      const { x: cx, y: cyv, prog, m } = b;
      if (prog < 0.98 && !reduced) {
        ctx.save();
        ctx.globalAlpha = clamp01((0.9 - prog) * 1.5) * 0.85;
        ctx.fillStyle = pal.dim;
        ctx.font = '500 12px "Hanken Grotesk", sans-serif';
        ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(m.label, cx, cyv - 11);
        ctx.restore();
      }
      const revoke = m.exec ? infl.revoke : 0;
      const r = 3.5 + prog * 3.5;
      const col = revoke > 0.02 ? mixToward(pal.amber, pal.clay, revoke) : pal.amber;
      ctx.save();
      ctx.globalAlpha = (0.4 + prog * 0.6) * (isDark ? 0.35 : 0.3);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(cx, cyv, r + 4, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.5 + prog * 0.5;
      if (isDark) { ctx.shadowColor = col; ctx.shadowBlur = 10 * prog; }
      ctx.beginPath(); ctx.arc(cx, cyv, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      if (reveal > 0.02 && prog > 0.6) {
        ctx.save();
        ctx.globalAlpha = reveal * 0.95;
        ctx.fillStyle = revoke > 0.3 ? pal.clay : (isDark ? pal.ink : pal.dim);
        ctx.font = '500 11px "Spline Sans Mono", monospace';
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(m.cap, cx + weaveAmp + 14, cyv);
        ctx.restore();
      }
    }

    // consumer name as the projection's title
    if (beads.length) {
      ctx.save();
      ctx.globalAlpha = clamp01((cs - 0.2) / 0.5) * 0.9;
      ctx.fillStyle = pal.amber;
      ctx.font = '700 13px "Hanken Grotesk", sans-serif';
      ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.fillText(consumers[builtConsumer].name, strandX + p.x, top - 16 + p.y);
      ctx.restore();
    }

    // ── governance membrane + marks ──
    if (marksProg > 0.01 && beads.length) {
      const gx = strandX - weaveAmp - 26 + p.x;
      ctx.save();
      ctx.globalAlpha = marksProg * (isDark ? 0.5 : 0.4);
      ctx.strokeStyle = pal.amber; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(gx, top + 6 + p.y); ctx.lineTo(gx, bot - 6 + p.y); ctx.stroke();
      ctx.restore();
      const lockY = lerp(top, bot, 0.28) + p.y;
      const tickY = lerp(top, bot, 0.72) + p.y;
      const pulse = 1 + infl.revoke * 0.3 * (0.6 + 0.4 * Math.sin(t * 6));
      drawLock(gx, lockY, 7.5 * pulse, pal.amber, marksProg);
      drawTick(gx, tickY, 7.5, pal.green, marksProg);
      if (infl.revoke > 0.05 || infl.audit > 0.05) {
        ctx.save();
        ctx.font = '500 10px "Spline Sans Mono", monospace';
        ctx.textAlign = "right"; ctx.textBaseline = "middle";
        if (infl.revoke > 0.05) { ctx.globalAlpha = infl.revoke * 0.9; ctx.fillStyle = pal.amber; ctx.fillText("authorize", gx - 12, lockY); }
        if (infl.audit > 0.05) { ctx.globalAlpha = infl.audit * 0.9; ctx.fillStyle = pal.green; ctx.fillText("audit · " + consumers[builtConsumer].name, gx - 12, tickY); }
        ctx.restore();
      }
    }

    // ── consumer chips (selectable) + thread from the selected one ──
    {
      const sel = chipRects[builtConsumer];
      if (sel && !narrow) {
        // thread from the selected chip into the object
        const x0 = sel.x + sel.w, y0 = sel.cy + p.y * 0.3;
        const x1 = strandX - weaveAmp - 6 + p.x;
        const yObj = Math.max(top + 10, Math.min(bot - 10, y0));
        ctx.save();
        ctx.globalAlpha = threadProg;
        ctx.strokeStyle = pal.amber; ctx.lineWidth = 1.5;
        if (isDark) { ctx.shadowColor = pal.amber; ctx.shadowBlur = 6; }
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(lerp(x0, x1, threadProg), lerp(y0, yObj, threadProg));
        ctx.stroke();
        ctx.restore();
        if (settled) {
          for (const o of [0, 0.5]) {
            const tt = (t * 0.5 + o) % 1;
            ctx.save();
            ctx.globalAlpha = Math.sin(tt * Math.PI) * 0.9;
            ctx.fillStyle = pal.amber;
            ctx.beginPath(); ctx.arc(lerp(x0, x1, tt), lerp(y0, yObj, tt), 2.3, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
          }
          ctx.save();
          ctx.globalAlpha = 0.7; ctx.fillStyle = pal.dim;
          ctx.font = '500 11px "Spline Sans Mono", monospace';
          ctx.textAlign = "center"; ctx.textBaseline = "bottom";
          ctx.fillText("list → invoke", (x0 + x1) / 2, (y0 + yObj) / 2 - 8);
          ctx.restore();
        }
      }
      // draw all chips
      for (let i = 0; i < chipRects.length; i++) {
        const c = chipRects[i];
        const on = i === builtConsumer;
        const appear = reduced ? 1 : clamp01((t - 0.1 - i * 0.06) / 0.5);
        ctx.save();
        ctx.globalAlpha = appear * (on ? 1 : 0.6);
        ctx.fillStyle = pal.chip;
        roundRect(c.x, c.y, c.w, c.h, 9); ctx.fill();
        ctx.strokeStyle = on ? pal.amber : pal.dim;
        ctx.lineWidth = on ? 1.6 : 1;
        if (on && isDark) { ctx.shadowColor = pal.amber; ctx.shadowBlur = 8; }
        roundRect(c.x, c.y, c.w, c.h, 9); ctx.stroke();
        ctx.shadowBlur = 0;
        if (on) {
          ctx.globalAlpha = appear * (isDark ? 0.14 : 0.1);
          ctx.fillStyle = pal.amber;
          roundRect(c.x, c.y, c.w, c.h, 9); ctx.fill();
        }
        ctx.globalAlpha = appear * (on ? 1 : 0.75);
        ctx.fillStyle = on ? pal.ink : pal.dim;
        ctx.font = `${on ? 600 : 500} 13px "Hanken Grotesk", sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(consumers[i].name, c.cx, c.cy);
        ctx.restore();
      }
    }

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
    ctx.fillStyle = pal.chip;
    ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = color;
    if (isDark) { ctx.shadowColor = color; ctx.shadowBlur = 6; }
    ctx.lineWidth = 1.3;
    roundRect(x - r * 0.7, y - r * 0.15, r * 1.4, r * 1.1, 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y - r * 0.15, r * 0.45, Math.PI, 0); ctx.stroke();
    ctx.restore();
  }
  function drawTick(x: number, y: number, r: number, color: string, alpha: number) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = pal.chip;
    ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1.4;
    ctx.globalAlpha = alpha * 0.55;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(x - r * 0.4, y); ctx.lineTo(x - r * 0.05, y + r * 0.4); ctx.lineTo(x + r * 0.45, y - r * 0.4);
    ctx.stroke();
    ctx.restore();
  }

  raf = requestAnimationFrame(frame);

  onBeforeUnmount(() => {
    cancelAnimationFrame(raf);
    ro?.disconnect();
    mo?.disconnect();
    cv.removeEventListener("pointermove", onMove);
    cv.removeEventListener("pointerdown", onDown);
  });
});
</script>

<template>
  <section class="plx-hero">
    <div class="plx-canvas-wrap">
      <canvas
        ref="canvas"
        tabindex="0"
        role="group"
        :aria-label="zh ? '选择一个 agent，查看 Plexus 为它组织出的能力投影（方向键切换）' : 'Select an agent to see the capability projection Plexus assembles for it (arrow keys to switch)'"
        @keydown="onKey"
      ></canvas>
      <p class="plx-sr" aria-live="polite">{{ liveText }}</p>
    </div>
    <p class="plx-vislabel">
      {{ zh
        ? "选中一个 agent —— 同一批资源，Plexus 为每个 agent 组织出不同的投影，并各自独立审计。"
        : "Select an agent — the same resources, assembled into a different projection for each, audited on its own." }}
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
  min-height: 260px;
  max-height: 480px;
}
.plx-canvas-wrap canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  border-radius: 12px;
  outline: none;
}
.plx-canvas-wrap canvas:focus-visible {
  box-shadow: 0 0 0 2px var(--vp-c-brand-soft);
}
.plx-sr {
  position: absolute;
  width: 1px; height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.plx-vislabel {
  margin: 10px auto 0;
  max-width: 66ch;
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
  top: -1px; left: 0; right: 0;
  height: 2px;
  background: var(--vp-c-brand-1);
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
.plx-pillar.on { background: var(--vp-c-brand-softer); }
.plx-pillar.on::before { transform: scaleX(1); }
.plx-pillar-i {
  display: block;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  color: var(--vp-c-text-3);
  letter-spacing: 0.04em;
  margin-bottom: 8px;
  transition: color 0.3s ease;
}
.plx-pillar.on .plx-pillar-i { color: var(--vp-c-brand-1); }
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
  .plx-pillars { grid-template-columns: repeat(2, 1fr); }
  .plx-pillar:nth-child(3),
  .plx-pillar:nth-child(4) { border-top: 1px solid var(--vp-c-divider); }
  .plx-canvas-wrap { aspect-ratio: 4 / 3; }
}
@media (prefers-reduced-motion: reduce) {
  .plx-pillar,
  .plx-pillar::before,
  .plx-pillar-i { transition: none; }
}
</style>
