/**
 * Realtime — the god's-eye Activity stage (WHAT HAPPENED band).
 *
 * A faithful React port of the approved prototype (scratchpad/realtime-view-prototype.html,
 * v6): a live canvas where every agent reaches your resources THROUGH the Plexus wall, as it
 * happens. This component owns the DOM chrome — the top bar (● Live / ↻ Back to realtime),
 * the collapsible filter tray (window segments + agent/capability chips + ✕ Clear all), the
 * pending-approval card, and the ledger — and drives a `RealtimeEngine` that owns the <canvas>
 * (the wall, the agent column, the source-clustered capability constellation, and the
 * approach → pass / bounce / wait data-flow state machine).
 *
 * The stage is fed REAL events: an initial snapshot (`api.audit` + `api.grants` +
 * `api.capabilities` + `api.pending`) then live increments over the management SSE stream
 * `GET /v1/events` (`api.subscribeV1Events`). Every `audit_appended` / `pending_added` /
 * `pending_resolved` maps to a flow: an allowed read passes the wall, a denied write bounces
 * off it, a write awaiting approval breathes at it, and your Approve/Deny opens or holds it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, subscribeV1Events } from "./api.ts";
import type { AuditEvent, CapabilityEntry, PlexusEvent } from "@plexus/protocol";
import { RealtimeEngine, type EngineAgent, type EngineCap, type FlowKind } from "./realtime-engine.ts";

const THEME_KEY = "plexus.theme.v1";
const DEFAULT_AGENT_ID = "plexus-cli";
const MAX_LEDGER = 140;
const MAX_ROWS = 60;

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
  oc: "ok" | "no" | "wait";
  out: string;
  bounced: boolean;
}

interface PendingCard {
  pendingId: string;
  agentId: string;
  agentLabel: string;
  capId: string;
}

const WINDOW_MS: Record<WindowKey, number> = {
  live: Infinity,
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
};

/** Derive the coarse verb a capability node is drawn as, from its required grant verbs. */
function capVerb(entry: CapabilityEntry): EngineCap["verb"] {
  const g = entry.grants ?? [];
  if (g.includes("execute")) return "execute";
  if (g.includes("write")) return "write";
  return "read";
}

/** Source of a capability id when the registry entry is unknown (prefix before first dot). */
function sourceOf(capId: string): string {
  const i = capId.indexOf(".");
  return i > 0 ? capId.slice(0, i) : capId;
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

function hhmmss(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
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
  // World maps (agent-id → node, cap-id → node) kept in refs so the SSE callback (subscribed
  // once) can grow them without a stale closure. `pushWorld` re-syncs the engine when they change.
  const agentsRef = useRef<Map<string, EngineAgent>>(new Map());
  const capsRef = useRef<Map<string, EngineCap>>(new Map());

  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [selA, setSelA] = useState<Set<string>>(new Set());
  const [selC, setSelC] = useState<Set<string>>(new Set());
  const [fRange, setFRange] = useState<WindowKey>("live");
  const [trayOpen, setTrayOpen] = useState(false);
  const [pending, setPending] = useState<PendingCard | null>(null);
  const [caption, setCaption] = useState<{ cls: Cls; agentLabel: string; capId: string } | null>(null);
  const [litKey, setLitKey] = useState<string | null>(null);
  const [worldTick, setWorldTick] = useState(0); // bumped when the world maps change → chip re-render

  // Filter refs mirror state so the once-subscribed SSE handler reads the CURRENT filter.
  const selARef = useRef(selA);
  const selCRef = useRef(selC);
  const fRangeRef = useRef(fRange);
  selARef.current = selA;
  selCRef.current = selC;
  fRangeRef.current = fRange;

  const anyFilter = selA.size > 0 || selC.size > 0 || fRange !== "live";

  // ── world helpers ────────────────────────────────────────────────────────────
  const pushWorld = useCallback(() => {
    engineRef.current?.setWorld([...agentsRef.current.values()], [...capsRef.current.values()]);
  }, []);

  const ensureAgent = useCallback(
    (id: string): boolean => {
      if (!id || agentsRef.current.has(id)) return false;
      agentsRef.current.set(id, { id, label: id });
      return true;
    },
    [],
  );
  const ensureCap = useCallback((id: string): boolean => {
    if (!id || capsRef.current.has(id)) return false;
    capsRef.current.set(id, { id, source: sourceOf(id), verb: "read" });
    return true;
  }, []);

  // ── the filter predicate (agent ∧ capability ∧ time window) ──────────────────
  const passes = useCallback((e: LedgerEvent, a: Set<string>, c: Set<string>, w: WindowKey): boolean => {
    if (a.size && !a.has(e.agentId)) return false;
    if (c.size && !c.has(e.capId)) return false;
    if (w !== "live" && Date.now() - e.at > WINDOW_MS[w]) return false;
    return true;
  }, []);

  // ── ingest one real event into ledger + stage ────────────────────────────────
  /** Append a ledger row (dedup by key) + optionally fire a canvas flow. When a filter is
   *  active the stage stays quiet (a replay surface) except for events that pass the filter. */
  const ingest = useCallback(
    (row: LedgerEvent, kind: FlowKind, opts: { fire: boolean } = { fire: true }) => {
      let grew = false;
      if (ensureAgent(row.agentId)) grew = true;
      if (ensureCap(row.capId)) grew = true;
      if (grew) {
        pushWorld();
        setWorldTick((t) => t + 1);
      }
      setEvents((prev) => {
        if (prev[0]?.key === row.key) return prev;
        const next = [row, ...prev];
        if (next.length > MAX_LEDGER) next.length = MAX_LEDGER;
        return next;
      });
      const filtered = selARef.current.size > 0 || selCRef.current.size > 0 || fRangeRef.current !== "live";
      const matches = passes(row, selARef.current, selCRef.current, fRangeRef.current);
      if (opts.fire && (!filtered || matches)) {
        engineRef.current?.fire(row.agentId, row.capId, kind);
        if (!filtered) setCaption({ cls: row.cls, agentLabel: row.agentLabel, capId: row.capId });
      }
    },
    [ensureAgent, ensureCap, pushWorld, passes],
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

    // Follow the admin theme: refresh the canvas palette when data-theme flips on <html>.
    const mo = new MutationObserver(() => engine.refreshPalette());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      mo.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the engine's selection (node dimming) in lockstep with the chips.
  useEffect(() => {
    engineRef.current?.setSelection(selA, selC);
  }, [selA, selC]);

  // ── initial snapshot ─────────────────────────────────────────────────────────
  useEffect(() => {
    let live = true;
    (async () => {
      // Capability constellation (the authoritative world) + agent roster.
      try {
        const caps = await api.capabilities();
        if (!live) return;
        for (const e of caps.entries) {
          capsRef.current.set(e.id, { id: e.id, source: e.source, verb: capVerb(e) });
        }
      } catch {
        /* the key gate / 401 path surfaces elsewhere; the stage still runs empty */
      }
      agentsRef.current.set(DEFAULT_AGENT_ID, { id: DEFAULT_AGENT_ID, label: DEFAULT_AGENT_ID });
      try {
        const g = await api.grants();
        if (live) for (const s of g.grants) ensureAgent(s.agentId);
      } catch {
        /* ignore */
      }
      try {
        const en = await api.agentEnrollments();
        if (live) for (const a of en.agents) ensureAgent(a.agentId);
      } catch {
        /* ignore */
      }
      // Seed the ledger from recent audit history (no flows for history — fill only).
      try {
        const r = await api.audit(200);
        if (live) {
          const rows: LedgerEvent[] = [];
          for (const e of r.events) {
            if (!e.capabilityId || !e.agentId) continue;
            const k = classify(e.type, e.outcome);
            if (!k) continue;
            ensureAgent(e.agentId);
            ensureCap(e.capabilityId);
            const at = Date.parse(e.at);
            rows.push({
              key: e.id,
              at: Number.isFinite(at) ? at : Date.now(),
              timeStr: hhmmss(Number.isFinite(at) ? at : Date.now()),
              ev: k.ev,
              cls: k.cls,
              agentId: e.agentId,
              agentLabel: e.agentId,
              capId: e.capabilityId,
              oc: k.oc,
              out: k.out,
              bounced: k.bounced,
            });
          }
          rows.sort((x, y) => y.at - x.at);
          setEvents(rows.slice(0, MAX_LEDGER));
        }
      } catch {
        /* ignore */
      }
      // Any still-open grant approval → the pending card + a breathing flow at the wall.
      try {
        const p = await api.pending();
        if (live) {
          const grant = p.pending.find((x) => x.kind === "grant" && x.agentId && x.capabilities?.length);
          const capId = grant?.capabilities?.[0];
          if (grant && grant.agentId && capId) {
            ensureAgent(grant.agentId);
            ensureCap(capId);
            setPending({ pendingId: grant.pendingId, agentId: grant.agentId, agentLabel: grant.agentId, capId });
            pushWorld();
            engineRef.current?.fire(grant.agentId, capId, "pend");
          }
        }
      } catch {
        /* ignore */
      }
      if (live) {
        pushWorld();
        setWorldTick((t) => t + 1);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── live SSE subscription (subscribe once; read filter via refs) ─────────────
  useEffect(() => {
    const onEvent = (evt: PlexusEvent) => {
      if (evt.type === "audit_appended") {
        if (!evt.capabilityId || !evt.agentId) return;
        const k = classify(evt.auditType, evt.outcome);
        if (!k) return;
        const at = Date.parse(evt.at);
        const ms = Number.isFinite(at) ? at : Date.now();
        ingest(
          {
            key: evt.id,
            at: ms,
            timeStr: hhmmss(ms),
            ev: k.ev,
            cls: k.cls,
            agentId: evt.agentId,
            agentLabel: evt.agentId,
            capId: evt.capabilityId,
            oc: k.oc,
            out: k.out,
            bounced: k.bounced,
          },
          k.cls as FlowKind,
        );
      } else if (evt.type === "pending_added") {
        const item = evt.item;
        if (item.kind !== "grant" || !item.agentId) return;
        const capId = item.capabilities?.[0];
        if (!capId) return;
        const at = Date.parse(item.createdAt);
        const ms = Number.isFinite(at) ? at : Date.now();
        setPending({ pendingId: item.pendingId, agentId: item.agentId, agentLabel: item.agentId, capId });
        ingest(
          {
            key: `pend:${item.pendingId}`,
            at: ms,
            timeStr: hhmmss(ms),
            ev: "pend",
            cls: "pend",
            agentId: item.agentId,
            agentLabel: item.agentId,
            capId,
            oc: "wait",
            out: "waiting",
            bounced: true,
          },
          "pend",
        );
      } else if (evt.type === "pending_resolved") {
        // Clear the card; the accompanying grant.allow/grant.deny audit releases the wall flow.
        setPending((cur) => {
          if (cur && cur.pendingId === evt.pendingId && evt.decision !== "approved" && evt.decision !== "denied") {
            // expired — release the waiting flow ourselves (no audit follows an expiry).
            engineRef.current?.resolveWaiting(cur.agentId, cur.capId, false);
          }
          return cur && cur.pendingId === evt.pendingId ? null : cur;
        });
      }
    };
    const unsub = subscribeV1Events({ onEvent });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Deselecting the LAST filter drops back to realtime + auto-collapses the tray (prototype
  // rule). Detect the true→false transition of `anyFilter` so a deliberately-opened empty tray
  // (Filter button, no selection) stays open for browsing.
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

  // ── row hover → replay that flow on the stage above ──────────────────────────
  const replay = useCallback((e: LedgerEvent) => {
    setLitKey(e.key);
    engineRef.current?.fire(e.agentId, e.capId, (e.cls === "pend" ? "deny" : e.cls) as FlowKind);
  }, []);

  // ── pending approve / deny (real POST) ───────────────────────────────────────
  const resolvePending = useCallback(
    async (approve: boolean) => {
      const p = pending;
      if (!p) return;
      setPending(null); // optimistic; the audit event drives the wall flow + ledger row
      try {
        await api.resolvePending(p.pendingId, approve ? "approve" : "deny");
      } catch {
        // Fall back to releasing the waiting flow locally so the stage never gets stuck.
        engineRef.current?.resolveWaiting(p.agentId, p.capId, approve);
      }
    },
    [pending],
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
                  <button
                    key={r}
                    className={`rt-seg${fRange === r ? " sel" : ""}`}
                    onClick={() => setFRange(r)}
                  >
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
        {pending && (
          <div className="rt-pend">
            <div className="eyebrow">
              <span className="pd" />
              At the wall — awaiting you
            </div>
            <div className="who">
              <span className="ag">{pending.agentLabel}</span> wants to run <code>{pending.capId}</code>
            </div>
            <div className="meta">it can't pass until you allow this one call</div>
            <div className="acts">
              <button className="approve" onClick={() => resolvePending(true)}>
                Approve
              </button>
              <button className="deny" onClick={() => resolvePending(false)}>
                Deny
              </button>
            </div>
          </div>
        )}
        <div className="rt-cap">
          {caption && (
            <Caption cls={caption.cls} agentLabel={caption.agentLabel} capId={caption.capId} />
          )}
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
