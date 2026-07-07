/**
 * Realtime — the god's-eye Activity stage (WHAT HAPPENED band).
 *
 * A faithful React port of the approved prototype (scratchpad/realtime-view-prototype.html,
 * v6): a live canvas where every agent reaches your resources THROUGH the Plexus wall, as it
 * happens. This component owns the DOM chrome — the top bar (● Live / ↻ Back to realtime),
 * the collapsible filter tray (window segments + agent/capability chips + ✕ Clear all), the
 * pending-approval cards, and the ledger — and drives a `RealtimeEngine` that owns the <canvas>
 * (the wall, the agent column, the source-clustered capability constellation, and the
 * approach → pass / bounce / wait data-flow state machine).
 *
 * DATA — a reconciled snapshot + live stream:
 *   - Live increments arrive over the management SSE stream `GET /v1/events`.
 *   - An initial snapshot (`api.audit` + `api.grants`/`api.agentEnrollments` +
 *     `api.capabilities` + `api.pending`) seeds the ledger, roster, constellation, and any
 *     open approvals. SSE events that land DURING the snapshot fetch are buffered, then merged
 *     (dedup by stable event id, sort by time) so the fetch window drops nothing and doubles
 *     nothing. On reconnect we re-fetch + reconcile (dedup makes it safe). Best-effort: a long
 *     disconnect may miss a few events — the authoritative ledger is still Activity/audit.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, subscribeV1Events } from "./api.ts";
import type { AuditEvent, CapabilityEntry, PlexusEvent } from "@plexus/protocol";
import { RealtimeEngine, type EngineAgent, type EngineCap, type FlowKind } from "./realtime-engine.ts";

const THEME_KEY = "plexus.theme.v1";
const MAX_LEDGER = 140;
const MAX_ROWS = 60;
/** Window after a local Approve/Deny during which the confirming audit's flow is suppressed
 *  (we already animated the release locally — A5) while still recording its ledger row. */
const LOCAL_RESOLVE_SUPPRESS_MS = 6000;

type Cls = "invoke" | "allow" | "deny" | "pend";
type WindowKey = "live" | "1h" | "24h" | "7d";

interface LedgerEvent {
  key: string;
  at: number;
  timeStr: string;
  ev: string;
  cls: Cls;
  agentId: string;
  agentLabel: string;
  capId: string;
  /** For a multi-capability pend row: how many MORE caps beyond `capId`. */
  extraCaps?: number;
  oc: "ok" | "no" | "wait";
  out: string;
  bounced: boolean;
}

/** One open approval awaiting the owner — supports concurrency + multi-capability grants (A4). */
interface PendingCard {
  pendingId: string;
  agentId: string;
  capIds: string[];
}

const WINDOW_MS: Record<WindowKey, number> = {
  live: Infinity,
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
};

function capVerb(entry: CapabilityEntry): EngineCap["verb"] {
  const g = entry.grants ?? [];
  if (g.includes("execute")) return "execute";
  if (g.includes("write")) return "write";
  return "read";
}
function sourceOf(capId: string): string {
  const i = capId.indexOf(".");
  return i > 0 ? capId.slice(0, i) : capId;
}
function hhmmss(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
}

/**
 * Map a real audit event `type`+`outcome` to a wall-crossing flow, or null for control-plane
 * events (handshake / token.* / grant.revoke / source.* / exposure.*) that don't reach a
 * resource. `grant.pending` is intentionally excluded — the pend flow + row is driven by the
 * richer `pending_added` event so it carries the approval identity, with no double flow.
 */
function classify(
  type: AuditEvent["type"],
  outcome: AuditEvent["outcome"],
): { cls: Cls; ev: string; oc: LedgerEvent["oc"]; out: string; bounced: boolean } | null {
  switch (type) {
    case "grant.allow":
      return { cls: "allow", ev: "allow", oc: "ok", out: "allowed", bounced: false };
    case "grant.deny":
      return { cls: "deny", ev: "deny", oc: "no", out: "denied", bounced: true };
    case "invoke":
      if (outcome === "denied") return { cls: "deny", ev: "deny", oc: "no", out: "blocked", bounced: true };
      if (outcome === "error") return { cls: "invoke", ev: "invoke", oc: "no", out: "error", bounced: false };
      return { cls: "invoke", ev: "invoke", oc: "ok", out: "ok", bounced: false };
    default:
      return null;
  }
}

/** The stage caption text for the most-recent flow (matches the prototype's four templates). */
function Caption({ cls, agentLabel, capId }: { cls: Cls; agentLabel: string; capId: string }) {
  const ag = <b>{agentLabel}</b>;
  const cap = <code>{capId}</code>;
  switch (cls) {
    case "invoke":
      return (
        <>
          {ag} called {cap} — it passed the wall and you weren't interrupted.
        </>
      );
    case "allow":
      return (
        <>
          You let {ag} through to {cap} — the wall opened for this one.
        </>
      );
    case "deny":
      return (
        <>
          The wall held: {ag} was denied {cap} — nothing got through.
        </>
      );
    case "pend":
      return (
        <>
          {ag} is stopped at the wall, asking to run {cap} — your call.
        </>
      );
  }
}

export function Realtime() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<RealtimeEngine | null>(null);
  const agentsRef = useRef<Map<string, EngineAgent>>(new Map());
  const capsRef = useRef<Map<string, EngineCap>>(new Map());

  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [selA, setSelA] = useState<Set<string>>(new Set());
  const [selC, setSelC] = useState<Set<string>>(new Set());
  const [fRange, setFRange] = useState<WindowKey>("live");
  const [trayOpen, setTrayOpen] = useState(false);
  const [pendings, setPendings] = useState<PendingCard[]>([]);
  const [caption, setCaption] = useState<{ cls: Cls; agentLabel: string; capId: string } | null>(null);
  const [litKey, setLitKey] = useState<string | null>(null);
  const [worldTick, setWorldTick] = useState(0);
  const [connLost, setConnLost] = useState(false); // B5: auth failure → surface a Reconnect pill
  const [reconnectNonce, setReconnectNonce] = useState(0);

  // Refs the once-subscribed SSE handler reads so it sees CURRENT state without re-subscribing.
  const selARef = useRef(selA);
  const selCRef = useRef(selC);
  const fRangeRef = useRef(fRange);
  selARef.current = selA;
  selCRef.current = selC;
  fRangeRef.current = fRange;

  // Reconciliation state (A1).
  const snapshotReadyRef = useRef(false);
  const bufferRef = useRef<PlexusEvent[]>([]);
  const firedPendRef = useRef<Set<string>>(new Set()); // one wall 'wait' flow per pendingId
  const justResolvedRef = useRef<Map<string, number>>(new Map()); // suppress the confirming audit flow
  const pendingsRef = useRef<PendingCard[]>([]); // eager mirror so updaters stay pure (C4)

  const anyFilter = selA.size > 0 || selC.size > 0 || fRange !== "live";

  // ── world helpers ────────────────────────────────────────────────────────────
  const pushWorld = useCallback(() => {
    engineRef.current?.setWorld([...agentsRef.current.values()], [...capsRef.current.values()]);
  }, []);
  const ensureAgent = useCallback((id: string): boolean => {
    if (!id || agentsRef.current.has(id)) return false;
    agentsRef.current.set(id, { id, label: id });
    return true;
  }, []);
  const ensureCap = useCallback((id: string): boolean => {
    if (!id || capsRef.current.has(id)) return false;
    capsRef.current.set(id, { id, source: sourceOf(id), verb: "read" });
    return true;
  }, []);
  const growWorld = useCallback(
    (agentId?: string, capId?: string) => {
      let grew = false;
      if (agentId && ensureAgent(agentId)) grew = true;
      if (capId && ensureCap(capId)) grew = true;
      if (grew) {
        pushWorld();
        setWorldTick((t) => t + 1);
      }
    },
    [ensureAgent, ensureCap, pushWorld],
  );

  const passes = useCallback((e: LedgerEvent, a: Set<string>, c: Set<string>, w: WindowKey): boolean => {
    if (a.size && !a.has(e.agentId)) return false;
    if (c.size && !c.has(e.capId)) return false;
    if (w !== "live" && Date.now() - e.at > WINDOW_MS[w]) return false;
    return true;
  }, []);

  // ── ledger merge — dedup by stable key, newest-first, capped (A1: no dup, no loss) ──
  const mergeLedger = useCallback((rows: LedgerEvent[]) => {
    if (rows.length === 0) return;
    setEvents((prev) => {
      const map = new Map(prev.map((e) => [e.key, e]));
      let changed = false;
      for (const r of rows) {
        if (!map.has(r.key)) {
          map.set(r.key, r);
          changed = true;
        }
      }
      if (!changed) return prev;
      let next = [...map.values()].sort((x, y) => y.at - x.at);
      if (next.length > MAX_LEDGER) next = next.slice(0, MAX_LEDGER);
      return next;
    });
  }, []);

  // ── fire a canvas flow for a LIVE event (filter-aware; sets the caption) ─────
  const fireLive = useCallback(
    (row: LedgerEvent, kind: FlowKind) => {
      const filtered = selARef.current.size > 0 || selCRef.current.size > 0 || fRangeRef.current !== "live";
      const matches = passes(row, selARef.current, selCRef.current, fRangeRef.current);
      if (filtered && !matches) return;
      engineRef.current?.fire(row.agentId, row.capId, kind);
      if (!filtered) setCaption({ cls: row.cls, agentLabel: row.agentLabel, capId: row.capId });
    },
    [passes],
  );

  const rowFromAudit = useCallback(
    (id: string, type: AuditEvent["type"], outcome: AuditEvent["outcome"], atIso: string, agentId: string, capId: string): LedgerEvent | null => {
      const k = classify(type, outcome);
      if (!k) return null;
      const at = Date.parse(atIso);
      const ms = Number.isFinite(at) ? at : Date.now();
      return {
        key: id,
        at: ms,
        timeStr: hhmmss(ms),
        ev: k.ev,
        cls: k.cls,
        agentId,
        agentLabel: agentId,
        capId,
        oc: k.oc,
        out: k.out,
        bounced: k.bounced,
      };
    },
    [],
  );

  // ── pending card mutation — eager ref + state so reads stay pure (C4) ───────
  const mutatePendings = useCallback((fn: (prev: PendingCard[]) => PendingCard[]) => {
    const next = fn(pendingsRef.current);
    pendingsRef.current = next;
    setPendings(next);
  }, []);

  // ── apply one decoded event (fire=false for snapshot/buffer reconciliation) ──
  const applyEvent = useCallback(
    (evt: PlexusEvent, fire: boolean) => {
      if (evt.type === "audit_appended") {
        if (!evt.capabilityId || !evt.agentId) return;
        const row = rowFromAudit(evt.id, evt.auditType, evt.outcome, evt.at, evt.agentId, evt.capabilityId);
        if (!row) return;
        growWorld(row.agentId, row.capId);
        mergeLedger([row]);
        if (!fire) return;
        // Suppress the flow if we JUST locally released this exact resolution (A5) — the ledger
        // row still lands, but we don't double-animate the wall opening/holding.
        if (row.cls === "allow" || row.cls === "deny") {
          const sk = `${row.agentId}|${row.capId}|${row.cls}`;
          const t = justResolvedRef.current.get(sk);
          if (t && Date.now() - t < LOCAL_RESOLVE_SUPPRESS_MS) {
            justResolvedRef.current.delete(sk);
            return;
          }
        }
        fireLive(row, row.cls as FlowKind);
      } else if (evt.type === "pending_added") {
        const item = evt.item;
        if (item.kind !== "grant" || !item.agentId || !item.capabilities?.length) return;
        const capIds = item.capabilities;
        const primary = capIds[0] as string;
        for (const c of capIds) growWorld(item.agentId, c);
        // Card (concurrency-safe: keyed by pendingId; a new id stacks, never overwrites).
        mutatePendings((prev) =>
          prev.some((p) => p.pendingId === item.pendingId)
            ? prev
            : [...prev, { pendingId: item.pendingId, agentId: item.agentId as string, capIds }],
        );
        // Pend ledger row.
        const at = Date.parse(item.createdAt);
        const ms = Number.isFinite(at) ? at : Date.now();
        mergeLedger([
          {
            key: `pend:${item.pendingId}`,
            at: ms,
            timeStr: hhmmss(ms),
            ev: "pend",
            cls: "pend",
            agentId: item.agentId,
            agentLabel: item.agentId,
            capId: primary,
            extraCaps: capIds.length - 1,
            oc: "wait",
            out: "waiting",
            bounced: true,
          },
        ]);
        // Breathing flow(s) at the wall — ONCE per pendingId across snapshot/buffer/stream.
        if (!firedPendRef.current.has(item.pendingId)) {
          firedPendRef.current.add(item.pendingId);
          const filtered = selARef.current.size > 0 || selCRef.current.size > 0 || fRangeRef.current !== "live";
          for (const c of capIds) {
            if (filtered && ((selCRef.current.size && !selCRef.current.has(c)) || (selARef.current.size && !selARef.current.has(item.agentId as string)))) continue;
            engineRef.current?.fire(item.agentId as string, c, "pend");
          }
        }
      } else if (evt.type === "pending_resolved") {
        // Compute the removed card FIRST (pure), then release its wall flows (idempotent).
        const card = pendingsRef.current.find((p) => p.pendingId === evt.pendingId) ?? null;
        mutatePendings((prev) => prev.filter((p) => p.pendingId !== evt.pendingId));
        firedPendRef.current.delete(evt.pendingId);
        if (card) {
          const approved = evt.decision === "approved";
          for (const c of card.capIds) engineRef.current?.resolveWaiting(card.agentId, c, approved);
        }
      }
    },
    [rowFromAudit, growWorld, mergeLedger, fireLive, mutatePendings],
  );

  // ── engine lifecycle ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new RealtimeEngine(canvas, {
      onToggleAgent: (id) => toggleAgent(id),
      onToggleCap: (id) => toggleCap(id),
    });
    engineRef.current = engine;
    pushWorld();
    engine.start();
    const mo = new MutationObserver(() => engine.refreshPalette());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mo.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.setSelection(selA, selC);
  }, [selA, selC]);

  // ── snapshot loader / reconciler (also re-run on reconnect + manual Reconnect) ──
  const loadSnapshot = useCallback(
    async (opts: { initial: boolean }): Promise<void> => {
      // Constellation (authoritative world) + roster — real data only (no phantom seed, A3).
      try {
        const caps = await api.capabilities();
        for (const e of caps.entries) capsRef.current.set(e.id, { id: e.id, source: e.source, verb: capVerb(e) });
      } catch {
        /* key gate / 401 surfaces via onAuthError; stage still runs */
      }
      try {
        const g = await api.grants();
        for (const s of g.grants) ensureAgent(s.agentId);
      } catch {
        /* ignore */
      }
      try {
        const en = await api.agentEnrollments();
        for (const a of en.agents) ensureAgent(a.agentId);
      } catch {
        /* ignore */
      }
      // Ledger from recent audit — merged (dedup), no flows for history.
      try {
        const r = await api.audit(200);
        const rows: LedgerEvent[] = [];
        for (const e of r.events) {
          if (!e.capabilityId || !e.agentId) continue;
          const row = rowFromAudit(e.id, e.type, e.outcome, e.at, e.agentId, e.capabilityId);
          if (!row) continue;
          ensureAgent(e.agentId);
          ensureCap(e.capabilityId);
          rows.push(row);
        }
        mergeLedger(rows);
      } catch {
        /* ignore */
      }
      // Open approvals → cards + breathing flows; reconcile away any that resolved during a gap.
      try {
        const p = await api.pending();
        const open = p.pending.filter((x) => x.kind === "grant" && x.agentId && x.capabilities?.length);
        const openIds = new Set(open.map((x) => x.pendingId));
        // Drop cards no longer open (resolved while disconnected) + release their flows.
        for (const stale of pendingsRef.current.filter((c) => !openIds.has(c.pendingId))) {
          for (const c of stale.capIds) engineRef.current?.resolveWaiting(stale.agentId, c, true);
          firedPendRef.current.delete(stale.pendingId);
        }
        mutatePendings((prev) => prev.filter((c) => openIds.has(c.pendingId)));
        for (const x of open) {
          const capIds = x.capabilities as string[];
          for (const c of capIds) {
            ensureAgent(x.agentId as string);
            ensureCap(c);
          }
          mutatePendings((prev) =>
            prev.some((c) => c.pendingId === x.pendingId)
              ? prev
              : [...prev, { pendingId: x.pendingId, agentId: x.agentId as string, capIds }],
          );
          const at = Date.parse(x.createdAt ?? "");
          const ms = Number.isFinite(at) ? at : Date.now();
          mergeLedger([
            {
              key: `pend:${x.pendingId}`,
              at: ms,
              timeStr: hhmmss(ms),
              ev: "pend",
              cls: "pend",
              agentId: x.agentId as string,
              agentLabel: x.agentId as string,
              capId: capIds[0] as string,
              extraCaps: capIds.length - 1,
              oc: "wait",
              out: "waiting",
              bounced: true,
            },
          ]);
          if (!firedPendRef.current.has(x.pendingId)) {
            firedPendRef.current.add(x.pendingId);
            for (const c of capIds) engineRef.current?.fire(x.agentId as string, c, "pend");
          }
        }
      } catch {
        /* ignore */
      }
      pushWorld();
      setWorldTick((t) => t + 1);

      if (opts.initial) {
        // Merge any SSE events that arrived DURING the fetch (ledger-only, no flow burst),
        // then go live. Pend flows still fire (once, via firedPendRef).
        snapshotReadyRef.current = true;
        const buffered = bufferRef.current;
        bufferRef.current = [];
        for (const evt of buffered) applyEvent(evt, false);
      }
    },
    [ensureAgent, ensureCap, mergeLedger, rowFromAudit, pushWorld, mutatePendings, applyEvent],
  );

  // First snapshot on mount.
  useEffect(() => {
    let live = true;
    snapshotReadyRef.current = false;
    bufferRef.current = [];
    void loadSnapshot({ initial: true }).finally(() => {
      if (!live) return;
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── live SSE subscription (buffers pre-snapshot; reconciles on reconnect) ────
  useEffect(() => {
    setConnLost(false);
    const unsub = subscribeV1Events({
      onEvent: (evt) => {
        if (!snapshotReadyRef.current) {
          bufferRef.current.push(evt);
          return;
        }
        applyEvent(evt, true);
      },
      onOpen: ({ reconnect }) => {
        setConnLost(false);
        // A1c: after a reconnect, re-fetch + reconcile so the disconnect window is filled
        // (dedup makes the overlap safe). The first open is already covered by loadSnapshot.
        if (reconnect) void loadSnapshot({ initial: false });
      },
      onAuthError: () => setConnLost(true), // B5: stop looping; surface an explicit Reconnect
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectNonce]);

  // ── filter controls ──────────────────────────────────────────────────────────
  const toggleAgent = useCallback((id: string) => {
    setSelA((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    setTrayOpen(true);
  }, []);
  const toggleCap = useCallback((id: string) => {
    setSelC((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    setTrayOpen(true);
  }, []);

  const prevAnyFilter = useRef(anyFilter);
  useEffect(() => {
    if (prevAnyFilter.current && !anyFilter) setTrayOpen(false);
    prevAnyFilter.current = anyFilter;
  }, [anyFilter]);

  const backToRealtime = useCallback(() => {
    setSelA(new Set());
    setSelC(new Set());
    setFRange("live");
    setTrayOpen(false);
  }, []);

  const world = useMemo(
    () => ({ agents: [...agentsRef.current.values()], caps: [...capsRef.current.values()] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [worldTick],
  );

  const visible = useMemo(
    () => events.filter((e) => passes(e, selA, selC, fRange)).slice(0, MAX_ROWS),
    [events, selA, selC, fRange, passes],
  );

  // Row hover → PURELY visual replay (A2): never touches a live 'wait' flow.
  const replay = useCallback((e: LedgerEvent) => {
    setLitKey(e.key);
    engineRef.current?.replay(e.agentId, e.capId, (e.cls === "pend" ? "deny" : e.cls) as FlowKind);
  }, []);

  // ── pending approve / deny (real POST + optimistic local release, A5) ────────
  const resolvePending = useCallback(
    async (card: PendingCard, approve: boolean) => {
      mutatePendings((prev) => prev.filter((p) => p.pendingId !== card.pendingId));
      firedPendRef.current.delete(card.pendingId);
      // Optimistically release the wall flow NOW so the stage never gets stuck, and record
      // that we did so the confirming grant.allow/deny audit doesn't double-animate.
      for (const c of card.capIds) {
        engineRef.current?.resolveWaiting(card.agentId, c, approve);
        justResolvedRef.current.set(`${card.agentId}|${c}|${approve ? "allow" : "deny"}`, Date.now());
      }
      try {
        await api.resolvePending(card.pendingId, approve ? "approve" : "deny");
      } catch {
        /* the optimistic release already ran; the SSE reconcile is idempotent */
      }
    },
    [mutatePendings],
  );

  const toggleTheme = useCallback(() => {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <div className="realtime">
      <div className="rt-bar">
        <span className={`rt-live${anyFilter ? " paused" : ""}`}>
          <span className="dot" />
          {anyFilter ? "Filtered" : "Live"}
        </span>
        <h1>
          Realtime
          <span className="sub">
            the god's-eye view — every agent reaching your resources through Plexus, as it happens
          </span>
        </h1>
        {connLost && (
          <button className="rt-btn rt-reconnect" onClick={() => setReconnectNonce((n) => n + 1)}>
            ⚠ Reconnect
          </button>
        )}
        <button
          className={`rt-btn${trayOpen ? " on" : ""}`}
          onClick={() => setTrayOpen((o) => !o)}
          aria-expanded={trayOpen}
        >
          <span>Filter</span>
          <span className="caret">▾</span>
        </button>
        {anyFilter && (
          <button className="rt-btn rt-rt" onClick={backToRealtime}>
            ↻ Back to realtime
          </button>
        )}
        <button className="rt-btn rt-theme" onClick={toggleTheme} title="Toggle theme" aria-label="Toggle theme">
          ◐
        </button>
      </div>

      <div className={`rt-tray${trayOpen ? " open" : ""}`}>
        <div className="rt-tray-inner">
          <div className="rt-tray-pad">
            <div className="rt-fgroup">
              <span className="rt-flabel">Window</span>
              <div className="rt-range">
                {(["live", "1h", "24h", "7d"] as WindowKey[]).map((r) => (
                  <button key={r} className={`rt-seg${fRange === r ? " sel" : ""}`} onClick={() => setFRange(r)}>
                    {r === "live" ? "Live" : r}
                  </button>
                ))}
              </div>
            </div>
            <div className="rt-fgroup">
              <span className="rt-flabel">Agent</span>
              <div className="rt-chips">
                {world.agents.map((a) => (
                  <button
                    key={a.id}
                    className={`rt-chip${selA.has(a.id) ? " sel" : ""}`}
                    onClick={() => toggleAgent(a.id)}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="rt-fgroup">
              <span className="rt-flabel">Capability</span>
              <div className="rt-chips">
                {world.caps.map((c) => (
                  <button
                    key={c.id}
                    className={`rt-chip${selC.has(c.id) ? " sel" : ""}`}
                    onClick={() => toggleCap(c.id)}
                  >
                    {c.id}
                  </button>
                ))}
              </div>
            </div>
            {anyFilter && (
              <button className="rt-tray-clear" onClick={backToRealtime}>
                ✕ Clear all filters
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="rt-stage">
        <canvas ref={canvasRef} className="rt-canvas" />
        {!anyFilter && (
          <div className="rt-hint">
            tip — click any <code>agent</code> or <code>capability</code> to filter to it
          </div>
        )}
        {pendings.length > 0 && (
          <div className="rt-pends">
            {pendings.map((p) => (
              <div className="rt-pend" key={p.pendingId}>
                <div className="eyebrow">
                  <span className="pd" />
                  At the wall — awaiting you
                </div>
                <div className="who">
                  <span className="ag">{p.agentId}</span> wants to run <code>{p.capIds[0]}</code>
                  {p.capIds.length > 1 && <span className="more"> +{p.capIds.length - 1} more</span>}
                </div>
                <div className="meta">it can't pass until you allow this one call</div>
                <div className="acts">
                  <button className="approve" onClick={() => resolvePending(p, true)}>
                    Approve
                  </button>
                  <button className="deny" onClick={() => resolvePending(p, false)}>
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="rt-cap">
          {caption && <Caption cls={caption.cls} agentLabel={caption.agentLabel} capId={caption.capId} />}
        </div>
      </div>

      <div className="rt-ledger">
        <div className="rt-ledger-head">
          Recent activity <span className="count">{events.length} events</span>
          <span className="rh">hover a row to replay it above ↑</span>
        </div>
        <div className="rt-rows">
          {visible.map((e) => (
            <div
              key={e.key}
              className={`rt-row${litKey === e.key ? " lit" : ""}`}
              onMouseEnter={() => replay(e)}
              onMouseLeave={() => setLitKey(null)}
            >
              <span className="t">{e.timeStr}</span>
              <span className={`ev ${e.cls}`}>{e.ev}</span>
              <span className="path">
                <span className="ag">{e.agentLabel}</span>
                {e.bounced ? <span className="sep b">⊗</span> : <span className="sep">→</span>}
                <code>{e.capId}</code>
                {e.extraCaps ? <span className="more"> +{e.extraCaps}</span> : null}
              </span>
              <span className={`out ${e.oc}`}>
                {e.oc === "ok" ? "✓" : e.oc === "no" ? "⊘" : "⏳"} {e.out}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
