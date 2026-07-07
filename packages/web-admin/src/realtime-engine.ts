/**
 * RealtimeEngine — the canvas world for the Realtime Activity view.
 *
 * A framework-agnostic port of the approved prototype's vanilla-JS canvas engine
 * (scratchpad/realtime-view-prototype.html, v6). It owns ONLY the <canvas>: the
 * Plexus wall (amber membrane + breathing spine beads), agents on the left, the
 * capability constellation clustered by source on the right, and the three-stage
 * data-flow state machine (approach → pass / bounce / wait). React (Realtime.tsx)
 * owns the DOM chrome (bar, tray, ledger, pending card) and feeds this engine real
 * events via `fire()`.
 *
 * Colours are NEVER hard-coded — the palette is read from the admin design tokens
 * (`getComputedStyle` on <html>) so the canvas follows the light/dark theme. Call
 * `refreshPalette()` when `data-theme` flips.
 *
 * Node positions ease toward per-frame layout *targets* (tx/ty) so the stage reflows
 * smoothly when the filter tray opens/closes or the window resizes — no jump.
 */

export interface EngineAgent {
  id: string;
  label: string;
}
export interface EngineCap {
  id: string;
  source: string;
  verb: "read" | "write" | "execute";
}
/** A flow's disposition — mirrors the prototype's four kinds. */
export type FlowKind = "invoke" | "allow" | "deny" | "pend";

export interface EngineCallbacks {
  /** A canvas agent node was clicked — toggle it in the filter (two-way with chips). */
  onToggleAgent?: (id: string) => void;
  /** A canvas capability node was clicked — toggle it in the filter. */
  onToggleCap?: (id: string) => void;
}

interface AgentNode extends EngineAgent {
  x: number | null;
  y: number;
  tx: number;
  ty: number;
  r: number;
}
interface CapNode extends EngineCap {
  x: number | null;
  y: number;
  tx: number;
  ty: number;
  sx: number;
  sy: number;
}

type Stage = "approach" | "pass" | "bounce" | "wait" | "done";
interface Flow {
  agent: AgentNode;
  cap: CapNode;
  kind: FlowKind;
  wy: number;
  bow: number;
  stage: Stage;
  t0: number;
  dur: number;
  c1: { cx: number; cy: number };
  c2?: { cx: number; cy: number };
  doneAt?: number;
}
interface WallHit {
  y: number;
  kind: "allow" | "deny";
  t0: number;
  dur: number;
}
interface Pulse {
  node: CapNode;
  color: string;
  t0: number;
  dur: number;
}

interface Palette {
  ink: string;
  dim: string;
  faint: string;
  ghost: string;
  hair: string;
  hairS: string;
  amber: string;
  grant: string;
  deny: string;
  light: boolean;
}

export class RealtimeEngine {
  private readonly cv: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cb: EngineCallbacks;
  private readonly reduce: boolean;

  private agents: AgentNode[] = [];
  private caps: CapNode[] = [];
  private sources: string[] = [];

  private W = 0;
  private H = 0;
  private dpr = 1;
  private wallX = 0;

  private flows: Flow[] = [];
  private wallHits: WallHit[] = [];
  private pulses: Pulse[] = [];
  private hoverNode: AgentNode | CapNode | null = null;
  private selA: Set<string> = new Set();
  private selC: Set<string> = new Set();

  private P: Palette = {
    ink: "",
    dim: "",
    faint: "",
    ghost: "",
    hair: "",
    hairS: "",
    amber: "",
    grant: "",
    deny: "",
    light: false,
  };

  private raf = 0;
  private running = false;
  private ro: ResizeObserver | null = null;
  private readonly onMove: (e: MouseEvent) => void;
  private readonly onLeave: () => void;
  private readonly onClick: (e: MouseEvent) => void;

  constructor(canvas: HTMLCanvasElement, cb: EngineCallbacks = {}) {
    this.cv = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;
    this.cb = cb;
    this.reduce =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.refreshPalette();

    this.onMove = (e) => {
      const r = this.cv.getBoundingClientRect();
      const h = this.hit(e.clientX - r.left, e.clientY - r.top);
      this.hoverNode = h ? h.o : null;
      this.cv.style.cursor = h ? "pointer" : "default";
    };
    this.onLeave = () => {
      this.hoverNode = null;
      this.cv.style.cursor = "default";
    };
    this.onClick = (e) => {
      const r = this.cv.getBoundingClientRect();
      const h = this.hit(e.clientX - r.left, e.clientY - r.top);
      if (!h) return;
      if (h.t === "a") this.cb.onToggleAgent?.(h.o.id);
      else this.cb.onToggleCap?.((h.o as CapNode).id);
    };
    this.cv.addEventListener("mousemove", this.onMove);
    this.cv.addEventListener("mouseleave", this.onLeave);
    this.cv.addEventListener("click", this.onClick);

    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.cv);
    this.layout();
  }

  // ── palette (read the admin design tokens; follows the theme) ────────────────
  refreshPalette(): void {
    const cs = getComputedStyle(document.documentElement);
    const g = (v: string) => cs.getPropertyValue(v).trim();
    this.P = {
      ink: g("--ink"),
      dim: g("--ink-dim"),
      faint: g("--ink-faint"),
      ghost: g("--ink-ghost"),
      hair: g("--hairline"),
      hairS: g("--hairline-strong"),
      amber: g("--amber"),
      grant: g("--grant"),
      deny: g("--deny"),
      light: document.documentElement.getAttribute("data-theme") === "light",
    };
  }

  // ── world: agents + capability constellation ─────────────────────────────────
  setWorld(agents: EngineAgent[], caps: EngineCap[]): void {
    // Preserve existing node positions so the target-easing animates a reflow when
    // the world grows (a new agent/cap seen on an event) instead of snapping.
    const prevA = new Map(this.agents.map((a) => [a.id, a]));
    const prevC = new Map(this.caps.map((c) => [c.id, c]));
    this.agents = agents.map((a) => {
      const p = prevA.get(a.id);
      return {
        ...a,
        x: p ? p.x : null,
        y: p ? p.y : 0,
        tx: p ? p.tx : 0,
        ty: p ? p.ty : 0,
        r: p ? p.r : 3.5,
      };
    });
    this.caps = caps.map((c) => {
      const p = prevC.get(c.id);
      return {
        ...c,
        x: p ? p.x : null,
        y: p ? p.y : 0,
        tx: p ? p.tx : 0,
        ty: p ? p.ty : 0,
        sx: p ? p.sx : 0,
        sy: p ? p.sy : 0,
      };
    });
    this.sources = [...new Set(this.caps.map((c) => c.source))];
    this.layout();
  }

  setSelection(selA: Set<string>, selC: Set<string>): void {
    this.selA = selA;
    this.selC = selC;
  }

  private layout(): void {
    const r = this.cv.getBoundingClientRect();
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.W = r.width;
    this.H = r.height;
    if (this.W === 0 || this.H === 0) return;
    this.cv.width = this.W * this.dpr;
    this.cv.height = this.H * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.wallX = this.W * 0.4;
    const W = this.W;
    const H = this.H;
    // agents: left column, adaptive spacing (scales to many)
    const aTop = H * 0.14;
    const aBot = H * 0.86;
    const an = this.agents.length;
    this.agents.forEach((a, i) => {
      a.tx = W * 0.085;
      a.ty = an === 1 ? H * 0.5 : aTop + (aBot - aTop) * (i / (an - 1));
      a.r = Math.max(3, Math.min(4.5, 60 / Math.max(1, an)));
      if (a.x == null) {
        a.x = a.tx;
        a.y = a.ty;
      }
    });
    // capabilities: cluster by source into "galaxies" inside the governed zone
    const zx0 = this.wallX + (W - this.wallX) * 0.14;
    const zx1 = W - 24;
    const zy0 = H * 0.12;
    const zy1 = H * 0.9;
    const S = this.sources.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(S * 1.4)));
    const rows = Math.max(1, Math.ceil(S / cols));
    this.sources.forEach((s, si) => {
      const cx = zx0 + ((zx1 - zx0) * ((si % cols) + 0.5)) / cols;
      const cy = zy0 + ((zy1 - zy0) * (Math.floor(si / cols) + 0.5)) / rows;
      const members = this.caps.filter((c) => c.source === s);
      members.forEach((c, ci) => {
        const ang = (ci / members.length) * Math.PI * 2 + si * 1.1;
        const rad = members.length === 1 ? 0 : 16 + members.length * 3;
        c.tx = cx + Math.cos(ang) * rad * (0.5 + ci * 0.12);
        c.ty = cy + Math.sin(ang) * rad * (0.5 + ci * 0.12);
        c.sx = cx;
        c.sy = cy;
        if (c.x == null) {
          c.x = c.tx;
          c.y = c.ty;
        }
      });
    });
  }

  // ── firing a flow (driven by real events) ────────────────────────────────────
  private findAgent(id: string): AgentNode | undefined {
    return this.agents.find((a) => a.id === id);
  }
  private findCap(id: string): CapNode | undefined {
    return this.caps.find((c) => c.id === id);
  }

  /**
   * Push a data flow for a real event. For an `allow`/`deny` that resolves a
   * capability currently WAITING at the wall (a prior `pend`), we release that
   * waiting flow (green pass / red bounce) instead of starting a fresh approach —
   * so an approval visibly opens the wall for the agent already stopped there.
   * Returns false if the agent/cap is not in the current world (nothing drawn).
   */
  fire(agentId: string, capId: string, kind: FlowKind): boolean {
    const agent = this.findAgent(agentId);
    const cap = this.findCap(capId);
    if (!agent || !cap || agent.x == null || cap.x == null) return false;
    if (kind === "allow" || kind === "deny") {
      const waiting = this.flows.find(
        (f) => f.stage === "wait" && f.agent.id === agentId && f.cap.id === capId,
      );
      if (waiting) {
        this.releaseWaiting(waiting, kind === "allow");
        return true;
      }
    }
    const wy = agent.y * 0.35 + cap.y * 0.65;
    const bow = (Math.random() < 0.5 ? 1 : -1) * (18 + Math.random() * 30);
    this.flows.push({
      agent,
      cap,
      kind,
      wy,
      bow,
      stage: "approach",
      t0: this.now(),
      dur: this.reduce ? 1 : 560 + Math.random() * 220,
      c1: this.ctrlPt(agent.x, agent.y, this.wallX, wy, bow),
    });
    return true;
  }

  /** Release the currently-waiting flow for (agent, cap) — a resolution fallback if
   *  the audit allow/deny flow was suppressed as a duplicate. */
  resolveWaiting(agentId: string, capId: string, approved: boolean): void {
    const waiting = this.flows.find(
      (f) => f.stage === "wait" && f.agent.id === agentId && f.cap.id === capId,
    );
    if (waiting) this.releaseWaiting(waiting, approved);
  }

  private releaseWaiting(f: Flow, approved: boolean): void {
    f.kind = approved ? "allow" : "deny";
    if (approved) {
      f.stage = "pass";
      f.t0 = this.now();
      f.dur = this.reduce ? 1 : 620;
      f.c2 = this.ctrlPt(this.wallX, f.wy, f.cap.x as number, f.cap.y, f.bow * 0.6);
      this.wallFlash(f.wy, "allow");
    } else {
      f.stage = "bounce";
      f.t0 = this.now();
      f.dur = this.reduce ? 1 : 520;
      this.wallFlash(f.wy, "deny");
    }
  }

  private pulse(node: CapNode, color: string): void {
    this.pulses.push({ node, color, t0: this.now(), dur: 720 });
  }
  private wallFlash(y: number, kind: "allow" | "deny"): void {
    this.wallHits.push({ y, kind, t0: this.now(), dur: kind === "deny" ? 900 : 640 });
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────
  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
  destroy(): void {
    this.stop();
    this.ro?.disconnect();
    this.ro = null;
    this.cv.removeEventListener("mousemove", this.onMove);
    this.cv.removeEventListener("mouseleave", this.onLeave);
    this.cv.removeEventListener("click", this.onClick);
  }

  // ── helpers (verbatim math from the prototype) ───────────────────────────────
  private now(): number {
    return performance.now();
  }
  private ctrlPt(ax: number, ay: number, bx: number, by: number, bow: number) {
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const dx = bx - ax;
    const dy = by - ay;
    const nx = -dy;
    const ny = dx;
    const L = Math.hypot(nx, ny) || 1;
    return { cx: mx + (nx / L) * bow, cy: my + (ny / L) * bow };
  }
  private ptOn(ax: number, ay: number, cx: number, cy: number, bx: number, by: number, t: number) {
    const u = 1 - t;
    return {
      x: u * u * ax + 2 * u * t * cx + t * t * bx,
      y: u * u * ay + 2 * u * t * cy + t * t * by,
    };
  }
  /** Recolour an oklch token string at a new alpha (matches prototype's `A`). */
  private A(o: string, a: number): string {
    if (!o) return `oklch(70% 0.1 75 / ${a})`;
    const inner = (o.replace(/^oklch\(/, "").replace(/\)$/, "").split("/")[0] ?? "").trim();
    return `oklch(${inner} / ${a})`;
  }
  private mono(): string {
    return getComputedStyle(document.body).getPropertyValue("--font-mono");
  }
  private uif(): string {
    return getComputedStyle(document.body).getPropertyValue("--font-ui");
  }
  private dim(id: string, isA: boolean): number {
    const s = isA ? this.selA : this.selC;
    return (this.selA.size || this.selC.size) && !s.has(id) ? (this.P.light ? 0.32 : 0.26) : 1;
  }
  private hit(mx: number, my: number): { t: "a" | "c"; o: AgentNode | CapNode } | null {
    for (const a of this.agents) {
      if (a.x != null && Math.hypot(mx - a.x, my - a.y) < 15) return { t: "a", o: a };
    }
    for (const c of this.caps) {
      if (c.x != null && Math.hypot(mx - c.x, my - c.y) < 13) return { t: "c", o: c };
    }
    return null;
  }

  private activePulse(node: CapNode, tn: number): { k: number; color: string } | null {
    let best: { k: number; color: string } | null = null;
    this.pulses = this.pulses.filter((p) => {
      const k = (tn - p.t0) / p.dur;
      if (k >= 1) return false;
      if (p.node === node) best = { k, color: p.color };
      return true;
    });
    return best;
  }

  private beadPath(
    ax: number,
    ay: number,
    cx: number,
    cy: number,
    bx: number,
    by: number,
    t: number,
    col: string,
  ): void {
    const ctx = this.ctx;
    ctx.lineWidth = 1.7;
    const steps = 20;
    for (let s = 0; s < steps; s++) {
      const ta = (s / steps) * t;
      const tb = ((s + 1) / steps) * t;
      const pa = this.ptOn(ax, ay, cx, cy, bx, by, ta);
      const pb = this.ptOn(ax, ay, cx, cy, bx, by, tb);
      const fade = s / steps;
      ctx.strokeStyle = this.A(col, 0.05 + 0.5 * fade);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    const head = this.ptOn(ax, ay, cx, cy, bx, by, t);
    ctx.fillStyle = this.A(col, 0.18);
    ctx.beginPath();
    ctx.arc(head.x, head.y, 7, 0, 7);
    ctx.fill();
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(head.x, head.y, 2.6, 0, 7);
    ctx.fill();
  }

  private drawWall(tn: number): void {
    const ctx = this.ctx;
    const P = this.P;
    const top = this.H * 0.05;
    const bot = this.H * 0.95;
    const x = this.wallX;
    const grad = ctx.createLinearGradient(x - 2, 0, x + 40, 0);
    grad.addColorStop(0, this.A(P.amber, P.light ? 0.13 : 0.1));
    grad.addColorStop(1, this.A(P.amber, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(x, top, 44, bot - top);
    ctx.strokeStyle = this.A(P.hairS, P.light ? 0.9 : 0.8);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bot);
    ctx.stroke();
    const N = 13;
    for (let i = 0; i <= N; i++) {
      const y = top + (bot - top) * (i / N);
      const wob = Math.sin(tn / 1400 + i * 0.9) * 2.4;
      ctx.fillStyle = this.A(P.amber, P.light ? 0.5 : 0.42);
      ctx.beginPath();
      ctx.arc(x + wob, y, i % 3 === 0 ? 2.1 : 1.3, 0, 7);
      ctx.fill();
    }
    this.wallHits = this.wallHits.filter((h) => {
      const k = (tn - h.t0) / h.dur;
      if (k >= 1) return false;
      if (h.kind === "allow") {
        const g = 1 - Math.abs(0.5 - k) * 2;
        ctx.strokeStyle = this.A(P.grant, 0.85 * g);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(x, h.y - 18 * g);
        ctx.lineTo(x, h.y + 18 * g);
        ctx.stroke();
        ctx.fillStyle = this.A(P.grant, 0.16 * g);
        ctx.beginPath();
        ctx.arc(x, h.y, 16 * g, 0, 7);
        ctx.fill();
      } else {
        const g = 1 - k;
        ctx.strokeStyle = this.A(P.deny, 0.9 * g);
        ctx.lineWidth = 3.2 * g + 1;
        ctx.beginPath();
        ctx.moveTo(x, h.y - 26 * g);
        ctx.lineTo(x, h.y + 26 * g);
        ctx.stroke();
        ctx.fillStyle = this.A(P.deny, 0.2 * g);
        ctx.beginPath();
        ctx.arc(x, h.y, 20 * g, 0, 7);
        ctx.fill();
      }
      return true;
    });
    ctx.font = "600 10px " + this.uif();
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillStyle = this.A(P.amber, 0.75);
    ctx.fillText("PLEXUS", x - 14, top + 2);
    ctx.font = "9px " + this.mono();
    ctx.fillStyle = this.A(P.ghost, 0.9);
    ctx.fillText("default-deny · audited", x - 14, top + 16);
  }

  private frame(): void {
    const ctx = this.ctx;
    const P = this.P;
    const tn = this.now();
    if (this.W === 0 || this.H === 0) return;
    ctx.clearRect(0, 0, this.W, this.H);
    // ease every node toward its layout target — tray open/close (and resize) reflow smoothly
    const ease = (n: { x: number | null; y: number; tx: number; ty: number }) => {
      if (n.x == null) {
        n.x = n.tx;
        n.y = n.ty;
        return;
      }
      n.x += (n.tx - n.x) * 0.16;
      n.y += (n.ty - n.y) * 0.16;
    };
    this.agents.forEach(ease);
    this.caps.forEach(ease);

    // source galaxy webs
    ctx.lineWidth = 1;
    this.sources.forEach((s) => {
      const m = this.caps.filter((c) => c.source === s);
      for (let i = 0; i < m.length; i++)
        for (let j = i + 1; j < m.length; j++) {
          const mi = m[i];
          const mj = m[j];
          if (!mi || !mj || mi.x == null || mj.x == null) continue;
          const d = Math.hypot(mi.x - mj.x, mi.y - mj.y);
          if (d < this.W * 0.12) {
            ctx.strokeStyle = this.A(
              P.hair,
              (P.light ? 0.8 : 0.5) *
                (1 - d / (this.W * 0.12)) *
                Math.min(this.dim(mi.id, false), this.dim(mj.id, false)),
            );
            ctx.beginPath();
            ctx.moveTo(mi.x, mi.y);
            ctx.lineTo(mj.x, mj.y);
            ctx.stroke();
          }
        }
    });

    this.drawWall(tn);

    // capability nodes
    this.caps.forEach((c) => {
      if (c.x == null) return;
      const p = this.activePulse(c, tn);
      const baseR = c.verb === "execute" ? 3.2 : 2.4;
      const dm = this.dim(c.id, false);
      const sel = this.selC.has(c.id);
      const hov = this.hoverNode === c;
      if (p) {
        const k = p.k;
        ctx.fillStyle = this.A(p.color, 0.16 * (1 - k) * dm);
        ctx.beginPath();
        ctx.arc(c.x, c.y, baseR + 22 * k, 0, 7);
        ctx.fill();
        ctx.strokeStyle = this.A(p.color, 0.5 * (1 - k) * dm);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(c.x, c.y, baseR + 22 * k, 0, 7);
        ctx.stroke();
      }
      if (sel || hov) {
        ctx.strokeStyle = this.A(P.amber, sel ? 0.9 : 0.5);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(c.x, c.y, baseR + 5, 0, 7);
        ctx.stroke();
      }
      ctx.fillStyle = this.A(
        c.verb === "execute" ? P.amber : P.dim,
        (c.verb === "execute" ? 0.92 : 0.85) * dm,
      );
      ctx.beginPath();
      ctx.arc(c.x, c.y, baseR, 0, 7);
      ctx.fill();
    });

    // cap labels — only when hovered/selected/active (avoids clutter at scale)
    ctx.font = "10.5px " + this.mono();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    this.caps.forEach((c) => {
      if (c.x == null) return;
      const on = this.flows.some((f) => f.cap === c && f.stage !== "done");
      const sel = this.selC.has(c.id);
      const hov = this.hoverNode === c;
      if (!(on || sel || hov)) return;
      ctx.fillStyle = this.A(on || hov ? P.amber : P.faint, 0.95 * this.dim(c.id, false));
      ctx.fillText(c.id, c.x + 8, c.y);
    });

    // agents
    this.agents.forEach((a) => {
      if (a.x == null) return;
      const on = this.flows.some((f) => f.agent === a && f.stage !== "done");
      const dm = this.dim(a.id, true);
      const sel = this.selA.has(a.id);
      const hov = this.hoverNode === a;
      ctx.fillStyle = this.A(P.hair, 0.95 * dm);
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r + 5, 0, 7);
      ctx.fill();
      if (sel || hov) {
        ctx.strokeStyle = this.A(P.amber, sel ? 0.9 : 0.5);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r + 9, 0, 7);
        ctx.stroke();
      }
      ctx.fillStyle = this.A(on ? P.amber : P.dim, (on ? 1 : 0.82) * dm);
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, 7);
      ctx.fill();
      ctx.font = "600 12px " + this.uif();
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = this.A(on || sel || hov ? P.ink : P.faint, 1 * dm);
      ctx.fillText(a.label, a.x - 14, a.y);
    });

    // flows
    this.flows = this.flows.filter((f) => {
      if (f.agent.x == null || f.cap.x == null) return false;
      const t = Math.min(1, (tn - f.t0) / f.dur);
      const col =
        f.kind === "deny"
          ? P.deny
          : f.kind === "pend"
            ? P.amber
            : f.kind === "allow"
              ? P.grant
              : P.amber;
      if (f.stage === "approach") {
        this.beadPath(f.agent.x, f.agent.y, f.c1.cx, f.c1.cy, this.wallX, f.wy, t, col);
        if (t >= 1) {
          if (f.kind === "deny") {
            f.stage = "bounce";
            f.t0 = tn;
            f.dur = this.reduce ? 1 : 520;
            this.wallFlash(f.wy, "deny");
          } else if (f.kind === "pend") {
            f.stage = "wait";
          } else {
            f.stage = "pass";
            f.t0 = tn;
            f.dur = this.reduce ? 1 : 600;
            f.c2 = this.ctrlPt(this.wallX, f.wy, f.cap.x, f.cap.y, f.bow * 0.6);
            this.wallFlash(f.wy, "allow");
          }
        }
        return true;
      }
      if (f.stage === "pass") {
        const c2 = f.c2 as { cx: number; cy: number };
        this.beadPath(this.wallX, f.wy, c2.cx, c2.cy, f.cap.x, f.cap.y, t, col);
        if (t >= 1) {
          this.pulse(f.cap, col);
          f.stage = "done";
          f.doneAt = tn;
        }
        return true;
      }
      if (f.stage === "bounce") {
        const bt = t;
        const back = this.ptOn(
          this.wallX,
          f.wy,
          f.c1.cx,
          f.c1.cy,
          f.agent.x,
          f.agent.y,
          Math.min(0.42, bt * 0.6),
        );
        ctx.fillStyle = this.A(P.deny, 0.9 * (1 - bt));
        ctx.beginPath();
        ctx.arc(back.x, back.y + bt * bt * 40, 2.4, 0, 7);
        ctx.fill();
        for (let s = 0; s < 5; s++) {
          const ang = Math.PI * (0.5 + (s - 2) * 0.22);
          const rr = 6 + bt * 26;
          ctx.fillStyle = this.A(P.deny, 0.5 * (1 - bt));
          ctx.beginPath();
          ctx.arc(
            this.wallX - Math.cos(ang) * rr * 0.4,
            f.wy + Math.sin(ang) * rr,
            1.6 * (1 - bt) + 0.4,
            0,
            7,
          );
          ctx.fill();
        }
        if (t >= 1) {
          f.stage = "done";
          f.doneAt = tn;
        }
        return true;
      }
      if (f.stage === "wait") {
        const b = 0.5 + 0.5 * Math.sin(tn / 380);
        ctx.fillStyle = this.A(P.amber, 0.2 + 0.2 * b);
        ctx.beginPath();
        ctx.arc(this.wallX - 9, f.wy, 7 + b * 2, 0, 7);
        ctx.fill();
        ctx.fillStyle = this.A(P.amber, 0.95);
        ctx.beginPath();
        ctx.arc(this.wallX - 9, f.wy, 2.8, 0, 7);
        ctx.fill();
        return true;
      }
      if (f.stage === "done") return tn - (f.doneAt ?? tn) < 200;
      return true;
    });
  }
}
