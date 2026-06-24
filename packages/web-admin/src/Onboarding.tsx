/**
 * Plexus — Onboarding (P4): the 4-step guided, skippable first-run flow
 * (REDESIGN-PRODUCT-UX §3). Shown as a full-bleed overlay when the app is in a
 * "fresh" state (no agents, no sources, no grants) and the user hasn't dismissed
 * it. Every step is strongly guided but carries a visible "Skip / I'll explore",
 * and onboarding NEVER blocks the app — dismissing drops straight into the
 * (still-empty) Overview, and any unfinished step re-surfaces as an Overview
 * "Needs you" nudge.
 *
 * The arc the user should FEEL across the four steps (§1.5 / §3):
 *   packages your machine's capabilities for agents → AI-native skills/workflows
 *   → per-agent authz → audit — by doing ONE real call, not reading a tour.
 *
 * R1 (Owner refinement) is made explicit in step 2: "Connect an agent" INSTALLS
 * Plexus *into* the agent so it can USE Plexus — a convenience — which is distinct
 * from EXPOSING a source (the core concept, step 3).
 *
 * TCC (macOS permission) moments are PRE-EXPLAINED here in-app, before the OS
 * prompt fires. The actual OS prompts are triggered by the desktop app (Electron
 * main); the web flow only renders the explainer copy + a noted hook. So:
 *   - Notifications  — primed in step 1, paid off in step 4.
 *   - Folder access  — pre-explained in step 3 when a protected dir is involved.
 *
 * This file REUSES the P3 components verbatim — `ConnectAgentPanel` (step 2) and
 * `AddObsidianForm` (step 3) — and the unchanged `api.ts` data layer (sources
 * detect, add source, connection-key, audit). It owns only the shell + step copy
 * + the witness-a-call payoff wiring (polling; live events deferred to the
 * desktop app).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type SourceView, type AuditEvent, type StandingGrant } from "./api.ts";
import { AddObsidianForm, ConnectAgentPanel } from "./App.tsx";
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
 * trap a working install behind onboarding).
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

const STEP_TITLES = ["What is this", "Connect an agent", "Add a source", "Witness a call"];

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

/* ── STEP 3 — "Add your first source" (what I expose); detect + AddObsidianForm ── */
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
  const [discovered, setDiscovered] = useState<number | null>(null);

  const load = useCallback(() => {
    api.detectSources().then((r) => setDetected(r.detected)).catch(() => setDetected([]));
    api
      .sources()
      .then((r) => {
        setSources(r.sources);
        const caps = r.sources.reduce((n, s) => n + (s.liveCapabilityCount || 0), 0);
        if (r.sources.length > 0) setDiscovered(caps);
      })
      .catch(() => setSources([]));
  }, []);
  useEffect(load, [load]);

  const existingIds = sources.map((s) => s.id);

  return (
    <div className="ob-step">
      <div className="ob-step-eyebrow">
        <IconSource width={14} height={14} /> what I expose
      </div>
      <h2 className="ob-step-title">Give your agent something to work with</h2>
      <p className="ob-step-lead">
        A <b>source</b> is where capabilities come from. We scanned this Mac and lead
        with what we found.
      </p>

      {detected.length > 0 ? (
        <div className="banner banner-ok ob-detected">
          <IconCheck width={15} height={15} /> We detected {detected.length} source
          {detected.length === 1 ? "" : "s"} nearby (e.g. Obsidian&apos;s Local REST
          API). Paste its API key below to connect.
        </div>
      ) : (
        <div className="banner banner-info ob-detected">
          <IconSource width={15} height={15} /> Nothing auto-detected — connect an
          Obsidian vault manually below, or skip and add a source later.
        </div>
      )}

      {/* Reuse the P3 AddObsidianForm verbatim (detect + connect flow). On connect
          we surface the arc's first beat: "N capabilities discovered — default-denied
          until you grant them." */}
      <div className="tile">
        <AddObsidianForm existingIds={existingIds} onAdded={load} />
      </div>

      {discovered !== null && (
        <div className="banner banner-ok ob-discovered">
          <IconCheck width={15} height={15} /> {discovered} capabilit
          {discovered === 1 ? "y" : "ies"} discovered — <b>default-denied</b> until
          you grant them to an agent.
        </div>
      )}

      <TccExplainer kind="folder" />

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

/* ── STEP 4 — "Witness a real call": the payoff — authz + audit, felt ──────────── */
function StepWitnessCall({
  onDone,
  onSkip,
}: {
  onDone: () => void;
  onSkip: () => void;
}) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [grants, setGrants] = useState<StandingGrant[]>([]);
  const [pendingCount, setPendingCount] = useState(0);

  // Poll for the real call to land (handshake → grant → invoke). Live WS wiring is
  // deferred to the desktop app; polling is correct here.
  const poll = useCallback(() => {
    api.audit(12).then((r) => setEvents(r.events)).catch(() => {});
    api.grants().then((r) => setGrants(r.grants)).catch(() => {});
    api.pending().then((r) => setPendingCount(r.pending.length)).catch(() => {});
  }, []);
  useEffect(() => {
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [poll]);

  // Did a real invoke complete? (an audit "invoke"/"grant" event + a standing grant)
  const lastInvoke = useMemo(
    () => events.find((e) => e.type.includes("invoke") || e.type.includes("call")),
    [events],
  );
  const lastGrant = grants[0];
  const completed = Boolean(lastInvoke || lastGrant);

  return (
    <div className="ob-step">
      <div className="ob-step-eyebrow">
        <IconScroll width={14} height={14} /> the payoff — authz + audit, felt
      </div>
      <h2 className="ob-step-title">Witness a real call</h2>

      {!completed ? (
        <>
          <p className="ob-step-lead">
            Here&apos;s the heart of Plexus. Ask your agent to make one real,
            read-only call — for example:
          </p>
          <div className="ob-callout">
            &ldquo;Ask Claude Code to read your vault&apos;s index note.&rdquo;
          </div>
          <p className="ob-step-lead">
            The agent runs <code>plexus call obsidian.vault.read</code> and a grant
            request arrives. <b>Approve it the way you always will — from a
            notification.</b>
          </p>

          {/* TCC payoff: the notification we primed in step 1 now does its job. */}
          <div className="ob-tcc ob-tcc-live">
            <span className="ob-tcc-badge">notification</span>
            <div>
              A native notification appears now (triggered by the desktop app). Click
              <b> Approve once</b> and the call completes — that&apos;s the
              notifications permission from step 1 paying off.
            </div>
          </div>

          <div className="ob-waiting">
            <span className="ob-spinner" aria-hidden />
            {pendingCount > 0
              ? `${pendingCount} approval${pendingCount === 1 ? "" : "s"} waiting — approve it from the notification…`
              : "Waiting for the agent's first call… (this updates live)"}
          </div>
        </>
      ) : (
        <>
          <div className="banner banner-ok ob-discovered">
            <IconCheck width={15} height={15} /> Done. That&apos;s the whole loop.
          </div>
          <div className="ob-loop">
            <b>claude-code</b> → asked (why) → you approved (window) → it ran →
            it&apos;s in your audit.
          </div>

          {lastGrant && (
            <div className="ob-proof">
              <div className="ob-proof-label">the grant it created</div>
              <div className="ob-proof-body">
                <code className="mono">{lastGrant.agentId}</code> may{" "}
                <code className="mono">{lastGrant.capabilityId}</code> —{" "}
                {lastGrant.verbs.join(", ")}. A row now lives in Standing Grants.
              </div>
            </div>
          )}

          {lastInvoke && (
            <div className="ob-proof">
              <div className="ob-proof-label">the audit line</div>
              <div className="ob-proof-body">
                <span className="t-time">
                  {new Date(lastInvoke.at).toLocaleTimeString()}
                </span>{" "}
                <b>{lastInvoke.type}</b>{" "}
                {lastInvoke.capabilityId ? (
                  <code className="mono">{lastInvoke.capabilityId}</code>
                ) : null}{" "}
                <span className="row-note">{lastInvoke.agentId ?? ""}</span> — Activity
                now shows handshake → grant → invoke.
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
      )}

      {!completed && (
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
