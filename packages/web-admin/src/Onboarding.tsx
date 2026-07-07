/**
 * Plexus — Onboarding (P4 → P1b): the 4-step guided, skippable first-run flow
 * (REDESIGN-PRODUCT-UX §3). Shown as a full-bleed overlay when the app is in a
 * "fresh" state (no agents, no sources, no grants) and the user hasn't dismissed
 * it. Every step is strongly guided but carries a visible "Skip / I'll explore",
 * and onboarding NEVER blocks the app — dismissing drops straight into the
 * (still-empty) Overview, and any unfinished step re-surfaces as an Overview
 * "Needs you" nudge.
 *
 * P1b — THE DEMO DIRECTORY STORY. Step 3's primary action exposes a demo folder
 * pair in one click (`POST /admin/api/demo-workspace`):
 *   - `demo-intro`  (plexus-intro/)  — OPEN reads: the agent can read it freely
 *     and introduce Plexus to the user from its contents;
 *   - `your-secret` (your-secret/)   — PROTECTED (approval:"ask"): reading it
 *     PENDS, and step 4 embeds the real approval card INLINE so the user
 *     approves or denies without leaving onboarding. Either outcome completes
 *     the act — deny is the other half of the same lesson.
 * The user personally operates default-deny + the approval loop in ~5 minutes.
 * Connecting an own Obsidian vault remains as the secondary, collapsed path.
 *
 * TCC (macOS permission) moments are PRE-EXPLAINED here in-app, before the OS
 * prompt fires (notifications in step 1; folder access in step 3).
 *
 * This file REUSES the app's components verbatim — `ConnectAgentPanel` (step 2),
 * `AddObsidianForm` (step 3 secondary), `PendingCard` (step 4 inline approval) —
 * and the unchanged `api.ts` data layer.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type SourceView,
  type AuditEvent,
  type StandingGrant,
  type DemoWorkspaceResult,
  type PendingItem,
  type TrustWindow,
} from "./api.ts";
import { AddObsidianForm, ConnectAgentPanel, PendingCard } from "./App.tsx";
import {
  IconCheck,
  IconSource,
  IconAgent,
  IconShield,
  IconScroll,
  IconKey,
} from "./icons.tsx";

/** The LocalStorage flag that records the user finished or skipped onboarding. */
export const ONBOARDING_DISMISSED_KEY = "plexus.onboarding.dismissed.v1";

/** The demo source ids the gateway's demo-workspace endpoint registers. */
const DEMO_INTRO_ID = "demo-intro";
const DEMO_SECRET_ID = "your-secret";

/** Snapshot of the runtime used both to detect "fresh" and to drive step 4. */
export interface FreshState {
  agentCount: number;
  sourceCount: number;
  grantCount: number;
}

/**
 * Read whether the runtime is in a FRESH state: no agents known (no grants/bundles
 * to any caller), no managed sources, no standing grants. We treat an all-empty
 * runtime as first-run. Robust to API failure (any error ⇒ not-fresh so we never
 * trap a working install behind onboarding). A user who already ran the demo has
 * sources (+ likely grants), so they are NOT fresh — re-entry never drags a
 * finished-demo user back into onboarding.
 */
export async function detectFreshState(): Promise<FreshState> {
  try {
    const [grantsRes, sourcesRes, bundlesRes] = await Promise.all([
      api.grants().catch(() => ({ grants: [] as StandingGrant[] })),
      api.sources().catch(() => ({ sources: [] as SourceView[], revision: 0 })),
      api.bundles().catch(() => ({ bundles: [] as { agentId: string }[] })),
    ]);
    const agentIds = new Set<string>();
    for (const g of grantsRes.grants) agentIds.add(g.agentId);
    for (const b of bundlesRes.bundles) agentIds.add(b.agentId);
    return {
      agentCount: agentIds.size,
      sourceCount: sourcesRes.sources.length,
      grantCount: grantsRes.grants.length,
    };
  } catch {
    // On any failure, report a non-fresh state so onboarding does not block.
    return { agentCount: 1, sourceCount: 1, grantCount: 1 };
  }
}

/** Is this a first-run install the onboarding should greet? */
export function isFresh(s: FreshState): boolean {
  return s.agentCount === 0 && s.sourceCount === 0 && s.grantCount === 0;
}

type StepId = 0 | 1 | 2 | 3;

const STEP_TITLES = ["What is this", "Connect an agent", "Expose the demo", "Witness the loop"];

/* ── The shared TCC explainer chip — pre-explains an OS prompt before it fires ─── */
function TccExplainer({ kind }: { kind: "notifications" | "folder" }) {
  if (kind === "notifications") {
    return (
      <div className="ob-tcc">
        <span className="ob-tcc-badge">macOS permission</span>
        <div>
          <b>Plexus will ask to send you notifications.</b> That&apos;s how approvals
          reach you — an agent asks, a native notification appears, you approve from
          it in one tap. We explain it now so the system prompt isn&apos;t a surprise.
          <span className="ob-tcc-note">
            {" "}
            (The OS prompt is triggered by the desktop app; here we just prime it.)
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="ob-tcc">
      <span className="ob-tcc-badge">macOS permission</span>
      <div>
        <b>Connecting a folder under Documents, Desktop, or Downloads</b> will make
        macOS show a folder-access prompt — allow it so Plexus can read what you
        expose. We pre-explain it; we never trigger it up front.
        <span className="ob-tcc-note">
          {" "}
          (The OS prompt is triggered by the desktop app when you pick the folder.)
        </span>
      </div>
    </div>
  );
}

/* ── STEP 1 — "What is this": the value in three bullets (the arc, no jargon) ──── */
function StepWhatIsThis({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  return (
    <div className="ob-step ob-step-hero">
      <div className="ob-hero-mark" aria-hidden />
      <h2 className="ob-hero-title">
        Your machine&apos;s capabilities, packaged for agents — and governed.
      </h2>
      <ul className="ob-bullets">
        <li>
          <IconSource width={16} height={16} />
          <span>
            Plexus exposes things on your computer — your notes, your files — as
            <b> capabilities</b> an AI agent can use.
          </span>
        </li>
        <li>
          <IconShield width={16} height={16} />
          <span>
            It generates the AI-native <b>skills and workflows</b> agents need to
            call them.
          </span>
        </li>
        <li>
          <IconScroll width={16} height={16} />
          <span>
            You decide <b>which agent gets what, why, and for how long</b> — and you
            see everything they do in the audit.
          </span>
        </li>
      </ul>

      <TccExplainer kind="notifications" />

      <div className="ob-actions">
        <button className="btn btn-primary" onClick={onNext}>
          Set up Plexus →
        </button>
        <button className="btn btn-ghost" onClick={onSkip}>
          Skip, I&apos;ll explore
        </button>
      </div>
    </div>
  );
}

/* ── STEP 2 — "Connect your first agent" (who I trust); reuses ConnectAgentPanel ─ */
function StepConnectAgent({
  onNext,
  onSkip,
  onBack,
}: {
  onNext: () => void;
  onSkip: () => void;
  onBack: () => void;
}) {
  return (
    <div className="ob-step">
      <div className="ob-step-eyebrow">
        <IconAgent width={14} height={14} /> who I trust
      </div>
      <h2 className="ob-step-title">Connect your first agent</h2>
      <p className="ob-step-lead">
        An <b>agent</b> is an AI tool that will use your capabilities. Connecting one
        means <b>installing Plexus INTO that agent so it can use Plexus</b> — a
        convenience that drops the integration and lets the agent read your
        connection key. This is <i>not</i> the same as exposing a source (that&apos;s
        the next step); here you&apos;re just making an agent able to <i>talk to</i>{" "}
        Plexus.
      </p>

      {/* Reuse the P3 ConnectAgentPanel verbatim: guided install (cc / codex) OR
          manual connection-key paste. The connection-key-is-the-boundary caption
          lives inside it. */}
      <ConnectAgentPanel />

      <div className="ob-caption">
        <IconKey width={13} height={13} /> The connection key is the trust boundary —
        anything holding it can talk to Plexus as any agent name.
      </div>

      <div className="ob-actions">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          ← Back
        </button>
        <button className="btn btn-primary" onClick={onNext}>
          Continue →
        </button>
        <button className="btn btn-ghost" onClick={onSkip}>
          Skip, I&apos;ll explore
        </button>
      </div>
    </div>
  );
}

/* ── STEP 3 — "Expose the demo folders" (what I expose) — the P1b primary path ── */
function StepAddSource({
  onNext,
  onSkip,
  onBack,
}: {
  onNext: () => void;
  onSkip: () => void;
  onBack: () => void;
}) {
  const [detected, setDetected] = useState<unknown[]>([]);
  const [sources, setSources] = useState<SourceView[]>([]);
  const [demo, setDemo] = useState<DemoWorkspaceResult | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoErr, setDemoErr] = useState<string | null>(null);
  const [showObsidian, setShowObsidian] = useState(false);

  const load = useCallback(() => {
    api.detectSources().then((r) => setDetected(r.detected)).catch(() => setDetected([]));
    api.sources().then((r) => setSources(r.sources)).catch(() => setSources([]));
  }, []);
  useEffect(load, [load]);

  // Already ran the demo in a prior visit? Reflect it (the endpoint is idempotent,
  // but we can show the two-card state without another call).
  const demoAlready = useMemo(
    () => sources.some((s) => s.id === DEMO_INTRO_ID) && sources.some((s) => s.id === DEMO_SECRET_ID),
    [sources],
  );

  const exposeDemo = async () => {
    setDemoBusy(true);
    setDemoErr(null);
    try {
      const res = await api.demoWorkspace();
      if (!res.ok) {
        setDemoErr(res.reason ?? "The demo folders could not be set up.");
        return;
      }
      setDemo(res);
      load();
    } catch (e) {
      setDemoErr(String(e));
    } finally {
      setDemoBusy(false);
    }
  };

  const demoDone = Boolean(demo) || demoAlready;
  const existingIds = sources.map((s) => s.id);

  // The your-secret source's ACTUAL posture (U1b — the badge must not hardcode
  // "protected"). If the id pre-existed with an OPEN posture (alreadyConfigured, approval
  // ≠ ask), tell the truth instead of claiming protection. Prefer the fresh demo result;
  // fall back to the live sources list; default to the intended "ask" before it loads.
  const secretSource =
    demo?.sources.find((s) => s.id === DEMO_SECRET_ID) ??
    sources.find((s) => s.id === DEMO_SECRET_ID);
  const secretProtected = (secretSource?.approval ?? "ask") === "ask";

  return (
    <div className="ob-step">
      <div className="ob-step-eyebrow">
        <IconSource width={14} height={14} /> what I expose
      </div>
      <h2 className="ob-step-title">Give your agent something to work with</h2>
      <p className="ob-step-lead">
        A <b>source</b> is where capabilities come from. Start with the built-in demo:
        one click creates <code>~/PlexusDemo</code> with two folders that teach the
        whole trust model — one open, one protected.
      </p>

      {!demoDone ? (
        <div className="tile ob-demo-cta">
          <div className="eyebrow">
            <IconSource width={13} height={13} /> the 5-minute demo
          </div>
          <div className="lead">Expose the demo folders</div>
          <div className="sub">
            <code>plexus-intro/</code> — notes your agent may read freely (and use to
            introduce Plexus to you) · <code>your-secret/</code> — a{" "}
            <b>Protected</b> folder where even a read must ask you first.
          </div>
          <div className="ob-actions" style={{ marginTop: 10 }}>
            <button className="btn btn-primary" onClick={exposeDemo} disabled={demoBusy}>
              {demoBusy ? "Setting up…" : "Expose the demo folders"}
            </button>
          </div>
          {demoErr && <div className="banner banner-err" style={{ marginTop: 10 }}>{demoErr}</div>}
        </div>
      ) : (
        <>
          <div className="banner banner-ok ob-discovered">
            <IconCheck width={15} height={15} /> Demo folders exposed
            {demo?.root ? (
              <>
                {" "}
                at <code>{demo.root}</code>
              </>
            ) : null}{" "}
            — capabilities are <b>default-denied</b> until granted.
          </div>
          <div className="ledger ob-demo-cards">
            <div className="ledger-row" data-exposed>
              <div className="rail" aria-hidden />
              <div className="row-body">
                <div className="row-title">
                  <span className="name">Plexus intro</span>
                  <span className="badge badge-kind">workspace-dir</span>
                  <span className="badge badge-transport">open read</span>
                </div>
                <div className="row-id">{DEMO_INTRO_ID}</div>
                <div className="row-describe">
                  Reads flow without a prompt — your agent can read these notes and
                  explain Plexus to you. That&apos;s the <b>auto</b> posture for
                  low-risk reads on sources you added yourself.
                </div>
              </div>
            </div>
            <div className="ledger-row" data-exposed>
              <div className="rail" aria-hidden />
              <div className="row-body">
                <div className="row-title">
                  <span className="name">Your secret</span>
                  <span className="badge badge-kind">workspace-dir</span>
                  {secretProtected ? (
                    <span className="badge badge-kind" data-kind="protected">
                      protected
                    </span>
                  ) : (
                    <span className="badge badge-transport">open read</span>
                  )}
                </div>
                <div className="row-id">{DEMO_SECRET_ID}</div>
                <div className="row-describe">
                  {secretProtected ? (
                    <>
                      <b>Protected</b> (approval: ask) — every first use, even a read,
                      pends for you. Next step, your agent will hit this wall and you
                      will decide, right here.
                    </>
                  ) : (
                    <>
                      This folder already existed with an <b>open</b> posture, so its
                      reads won&apos;t pend — the protected-approval demo won&apos;t
                      trigger for it. Mark it <b>Protected</b> under <b>What I expose</b>
                      {" "}to try the approval loop.
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Detection banner preserved — it feeds the secondary "your own vault" path. */}
      {detected.length > 0 && (
        <div className="banner banner-ok ob-detected">
          <IconCheck width={15} height={15} /> We also detected {detected.length} source
          {detected.length === 1 ? "" : "s"} nearby (e.g. Obsidian&apos;s Local REST
          API) — connect it below if you want your real notes too.
        </div>
      )}

      {/* SECONDARY, collapsed: connect your own Obsidian vault (the old primary). */}
      <div className="ob-secondary">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-expanded={showObsidian}
          onClick={() => setShowObsidian((v) => !v)}
        >
          {showObsidian ? "▾" : "▸"} Or connect your own Obsidian vault
        </button>
        {showObsidian && (
          <div className="tile" style={{ marginTop: 8 }}>
            <AddObsidianForm existingIds={existingIds} onAdded={load} />
          </div>
        )}
      </div>

      <TccExplainer kind="folder" />

      <div className="ob-actions">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          ← Back
        </button>
        {/* Continue is never hard-disabled: api.sources() lists MANAGED sources only, so a
            user relying on the compile-time `workspace` singleton would otherwise be
            trapped here (P4). Onboarding is skippable throughout; step 4 handles the
            no-source case. */}
        <button className="btn btn-primary" onClick={onNext}>
          Continue →
        </button>
        <button className="btn btn-ghost" onClick={onSkip}>
          Skip, I&apos;ll explore
        </button>
      </div>
    </div>
  );
}

/* ── STEP 4 — "Witness the loop": two acts — open read, then the protected pend ── */

/** A copyable instruction block ("tell your agent this"). */
function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ob-callout ob-copyline">
      <span>&ldquo;{text}&rdquo;</span>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function StepWitnessCall({
  onDone,
  onSkip,
}: {
  onDone: () => void;
  onSkip: () => void;
}) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [grants, setGrants] = useState<StandingGrant[]>([]);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [sources, setSources] = useState<SourceView[]>([]);
  const [busyPending, setBusyPending] = useState<string | null>(null);
  const [resolveErr, setResolveErr] = useState<string | null>(null);

  // Poll for the calls to land (handshake → grant/pend → invoke). Live WS wiring is
  // deferred to the desktop app; polling is correct here.
  const poll = useCallback(() => {
    api.audit(80).then((r) => setEvents(r.events)).catch(() => {});
    api.grants().then((r) => setGrants(r.grants)).catch(() => {});
    api.pending().then((r) => setPending(r.pending)).catch(() => {});
    api.sources().then((r) => setSources(r.sources)).catch(() => {});
  }, []);
  useEffect(() => {
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [poll]);

  const demoPresent = sources.some((s) => s.id === DEMO_INTRO_ID || s.id === DEMO_SECRET_ID);

  // ── RAW observations from the (windowed) audit tail ──────────────────────────
  // ACT 1: a successful read/list against the intro source landed.
  const introInvoke = useMemo(
    () =>
      events.find(
        (e) =>
          e.type === "invoke" &&
          (e.capabilityId ?? "").startsWith(`${DEMO_INTRO_ID}.`) &&
          e.outcome === "ok",
      ),
    [events],
  );

  // ACT 2: the protected pend RESOLVED — approve OR deny both complete the act.
  const secretDeny = useMemo(
    () =>
      events.find(
        (e) => e.type === "grant.deny" && (e.capabilityId ?? "").startsWith(`${DEMO_SECRET_ID}.`),
      ),
    [events],
  );
  // "approved" REQUIRES a HUMAN approval: a `grant.allow` stamped with `detail.viaApproval`
  // (the pendingId). An AUTO-allow emits a `grant.allow` WITHOUT viaApproval — if the
  // `your-secret` id collided with a pre-existing OPEN source, the read would auto-allow
  // and this must NOT be mis-narrated as "you approved it". (U1a — no protected lie.)
  const secretAllow = useMemo(
    () =>
      events.find(
        (e) =>
          e.type === "grant.allow" &&
          (e.capabilityId ?? "").startsWith(`${DEMO_SECRET_ID}.`) &&
          Boolean((e.detail as { viaApproval?: unknown } | undefined)?.viaApproval),
      ),
    [events],
  );
  const rawSecretOutcome: "approved" | "denied" | null = secretAllow
    ? "approved"
    : secretDeny
      ? "denied"
      : null;

  // LEGACY fallback: a real governed call on a NON-demo capability (e.g. the user's own
  // vault). Excludes the demo caps so act 1's intro read never short-circuits act 2, yet
  // a demo+vault user who reads their vault is NOT trapped (P4).
  const isDemoCap = (id: string) => id.startsWith(`${DEMO_INTRO_ID}.`) || id.startsWith(`${DEMO_SECRET_ID}.`);
  const legacyInvoke = useMemo(
    () =>
      events.find(
        (e) => e.type === "invoke" && e.outcome === "ok" && !isDemoCap(e.capabilityId ?? ""),
      ),
    [events],
  );
  const nonDemoGrant = useMemo(() => grants.find((g) => !isDemoCap(g.capabilityId)), [grants]);
  const rawLegacy = Boolean(legacyInvoke || nonDemoGrant);

  // ── LATCH (U2) ────────────────────────────────────────────────────────────────
  // The audit read is a bounded tail; a chatty agent (repeated list/handshake/intro
  // reads) can push an early grant.deny (deny leaves NO standing grant, so the event is
  // its ONLY trace) out of the window, which would flip a completed act back to
  // "Waiting…". Latch each observed outcome: null→value only, never value→null.
  const [introLatched, setIntroLatched] = useState(false);
  const [secretLatched, setSecretLatched] = useState<"approved" | "denied" | null>(null);
  const [legacyLatched, setLegacyLatched] = useState(false);
  useEffect(() => {
    if (introInvoke) setIntroLatched(true);
  }, [introInvoke]);
  useEffect(() => {
    if (rawSecretOutcome) setSecretLatched((prev) => prev ?? rawSecretOutcome);
  }, [rawSecretOutcome]);
  useEffect(() => {
    if (rawLegacy) setLegacyLatched(true);
  }, [rawLegacy]);

  const introDone = introLatched;
  const secretOutcome = secretLatched;
  const legacyCompleted = legacyLatched;

  // The INLINE approval surface: any pending grant touching the protected demo source.
  const secretPending = useMemo(
    () =>
      pending.filter(
        (p) =>
          p.kind === "grant" &&
          p.state === "pending" &&
          (p.capabilities ?? []).some((c) => c.startsWith(`${DEMO_SECRET_ID}.`)),
      ),
    [pending],
  );
  const knownAgents = useMemo(
    () => [...new Set(grants.map((g) => g.agentId))],
    [grants],
  );

  const resolveInline = async (
    id: string,
    action: "approve" | "deny",
    opts: { trustWindow?: TrustWindow; agentId?: string },
  ) => {
    setBusyPending(id);
    setResolveErr(null);
    try {
      await api.resolvePending(id, action, opts);
      poll();
    } catch (e) {
      setResolveErr(String(e));
    } finally {
      setBusyPending(null);
    }
  };

  // Evidence rows shared by the completed states (best-effort — may scroll out of the
  // audit window after the latch fixes the outcome; the celebration copy persists).
  const secretGrant = grants.find((g) => g.capabilityId.startsWith(`${DEMO_SECRET_ID}.`));
  const denyReason =
    secretDeny && secretDeny.detail && typeof (secretDeny.detail as { reason?: unknown }).reason === "string"
      ? ((secretDeny.detail as { reason?: string }).reason ?? null)
      : null;

  const allDone = (introDone && secretOutcome !== null) || legacyCompleted;

  return (
    <div className="ob-step">
      <div className="ob-step-eyebrow">
        <IconScroll width={14} height={14} /> the payoff — authz + audit, felt
      </div>
      <h2 className="ob-step-title">Witness the trust loop</h2>

      {!demoPresent && !legacyCompleted && (
        <p className="ob-step-lead">
          Ask your agent to make one real, read-only call against the source you
          exposed (for a vault: <code>obsidian.vault.read</code>). When a grant
          request arrives, approve it — the loop completes below.
        </p>
      )}

      {demoPresent && (
        <>
          {/* ── ACT 1 — the open read: the agent introduces Plexus ─────────────── */}
          <div className="ob-act" data-done={introDone}>
            <div className="ob-act-head">
              <span className="ob-rail-dot">{introDone ? "✓" : "1"}</span>
              <b>Act one — let your agent introduce Plexus.</b>
            </div>
            {!introDone ? (
              <>
                <p className="ob-step-lead">
                  Tell your connected agent (paste this into its chat):
                </p>
                <CopyLine text="Use Plexus to read the plexus-intro demo folder (list what you can call, then use demo-intro.read) and introduce Plexus to me in your own words based on what you find." />
                <p className="ob-step-lead">
                  The agent runs <code>plexus list</code>, sees{" "}
                  <code>{DEMO_INTRO_ID}.read</code>, and the read <b>flows without a
                  prompt</b> — a low-risk read on a source you added yourself. Watch
                  its introduction, then come back here.
                </p>
              </>
            ) : (
              <div className="banner banner-ok ob-discovered">
                <IconCheck width={15} height={15} /> Your agent read{" "}
                <code>{introInvoke?.capabilityId}</code> — no prompt needed. That is
                the open half: vetted source, read-only, straight through (and
                already in your audit).
              </div>
            )}
          </div>

          {/* ── ACT 2 — the protected read: pend → YOU decide, inline ──────────── */}
          <div className="ob-act" data-done={secretOutcome !== null}>
            <div className="ob-act-head">
              <span className="ob-rail-dot">{secretOutcome ? "✓" : "2"}</span>
              <b>Act two — now send it at the protected folder.</b>
            </div>
            {secretOutcome === null ? (
              <>
                <p className="ob-step-lead">Then tell your agent:</p>
                <CopyLine text="Now read secret.md from the your-secret folder via Plexus (your-secret.read) and tell me what it says." />
                <p className="ob-step-lead">
                  This folder is <b>Protected</b> — the read does NOT flow. It pends,
                  and the approval card appears right here. Approve it (pick a trust
                  window) or deny it — <b>both are the lesson</b>.
                </p>
                {secretPending.length === 0 ? (
                  <div className="ob-waiting">
                    <span className="ob-spinner" aria-hidden />
                    Waiting for the agent&apos;s protected read… (this updates live)
                  </div>
                ) : (
                  <div className="ledger ob-inline-approvals">
                    {secretPending.map((p) => (
                      <PendingCard
                        key={p.pendingId}
                        item={p}
                        busy={busyPending === p.pendingId}
                        knownAgents={knownAgents}
                        onResolve={(action, opts) => resolveInline(p.pendingId, action, opts)}
                      />
                    ))}
                  </div>
                )}
                {resolveErr && <div className="banner banner-err">{resolveErr}</div>}
              </>
            ) : secretOutcome === "approved" ? (
              <div className="banner banner-ok ob-discovered">
                <IconCheck width={15} height={15} /> You approved it — with the trust
                window you chose. The agent got the (deliberately fake) secret, and
                the grant + the call are both in your ledger. Nothing moved until
                you said so.
              </div>
            ) : (
              <div className="banner banner-ok ob-discovered">
                <IconShield width={15} height={15} /> You denied it — and the agent
                received an explicit <b>DENIED</b>, not a hang. That is default-deny
                working end-to-end: the protected folder stayed sealed, and the
                denial (with its reason) is in your audit.
              </div>
            )}
          </div>
        </>
      )}

      {allDone ? (
        <>
          <div className="banner banner-ok ob-discovered">
            <IconCheck width={15} height={15} /> Done. That&apos;s the whole loop —
            discover → request → <b>you decide</b> → call → audit.
          </div>

          {secretGrant && (
            <div className="ob-proof">
              <div className="ob-proof-label">the grant it created</div>
              <div className="ob-proof-body">
                <code className="mono">{secretGrant.agentId}</code> may{" "}
                <code className="mono">{secretGrant.capabilityId}</code> —{" "}
                {secretGrant.verbs.join(", ")}. A row now lives in Standing Grants.
              </div>
            </div>
          )}

          {secretDeny && (
            <div className="ob-proof">
              <div className="ob-proof-label">the denial, on the record</div>
              <div className="ob-proof-body">
                <span className="t-time">{new Date(secretDeny.at).toLocaleTimeString()}</span>{" "}
                <b>grant.deny</b>{" "}
                <code className="mono">{secretDeny.capabilityId}</code>
                {denyReason ? <span className="row-note"> — “{denyReason}”</span> : null} —
                expand it in Activity to see the full reason.
              </div>
            </div>
          )}

          {(introInvoke ?? legacyInvoke) && (
            <div className="ob-proof">
              <div className="ob-proof-label">the audit line</div>
              <div className="ob-proof-body">
                <span className="t-time">
                  {new Date((introInvoke ?? legacyInvoke)!.at).toLocaleTimeString()}
                </span>{" "}
                <b>{(introInvoke ?? legacyInvoke)!.type}</b>{" "}
                {(introInvoke ?? legacyInvoke)!.capabilityId ? (
                  <code className="mono">{(introInvoke ?? legacyInvoke)!.capabilityId}</code>
                ) : null}{" "}
                <span className="row-note">{(introInvoke ?? legacyInvoke)!.agentId ?? ""}</span> —
                Activity now shows the full trail.
              </div>
            </div>
          )}

          <p className="ob-step-lead">
            Everything an agent does flows through here, visibly.
          </p>
          <div className="ob-actions">
            <button className="btn btn-primary" onClick={onDone}>
              Go to Overview →
            </button>
          </div>
        </>
      ) : (
        <div className="ob-actions">
          <button className="btn btn-ghost" onClick={onSkip}>
            Skip — I&apos;ll do this later
          </button>
        </div>
      )}
    </div>
  );
}

/* ── The onboarding shell — progress rail + the active step ────────────────────── */
export function Onboarding({
  initialStep = 0,
  onFinish,
}: {
  /** Lets an Overview "Needs you" nudge re-open onboarding on a specific step. */
  initialStep?: StepId;
  /** Called when the user finishes or skips — App marks dismissed + drops to Overview. */
  onFinish: () => void;
}) {
  const [step, setStep] = useState<StepId>(initialStep);

  const next = () => setStep((s) => Math.min(3, s + 1) as StepId);
  const back = () => setStep((s) => Math.max(0, s - 1) as StepId);

  return (
    <div className="ob-overlay" role="dialog" aria-modal="true" aria-label="Set up Plexus">
      <div className="ob-shell">
        <header className="ob-head">
          <div className="ob-brand">
            <div className="ob-sigil" aria-hidden />
            <span>Set up Plexus</span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onFinish}>
            Skip onboarding
          </button>
        </header>

        <ol className="ob-rail" aria-label="onboarding steps">
          {STEP_TITLES.map((t, i) => (
            <li
              key={t}
              className="ob-rail-step"
              data-state={i < step ? "done" : i === step ? "active" : "todo"}
            >
              <span className="ob-rail-dot">{i < step ? "✓" : i + 1}</span>
              <span className="ob-rail-label">{t}</span>
            </li>
          ))}
        </ol>

        <div className="ob-body">
          {step === 0 && <StepWhatIsThis onNext={next} onSkip={onFinish} />}
          {step === 1 && <StepConnectAgent onNext={next} onSkip={onFinish} onBack={back} />}
          {step === 2 && <StepAddSource onNext={next} onSkip={onFinish} onBack={back} />}
          {step === 3 && <StepWitnessCall onDone={onFinish} onSkip={onFinish} />}
        </div>
      </div>
    </div>
  );
}
