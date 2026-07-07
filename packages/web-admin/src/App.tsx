/**
 * Plexus — Capability Control (management panel, t11). A single-page, same-origin
 * admin UI served by the gateway at /admin. Presents the trust surface of a local
 * capability gateway with ONE vocabulary (ADR-018): an AGENT holds a GRANT to use a
 * CAPABILITY (its VERBS) for a TRUST WINDOW; Plexus mints short-lived TOKENS from it;
 * each grant shows its SOURCE CLASS and SENSITIVITY and is revocable in Grants.
 *
 * The data layer (./api.ts) and the gateway API contract are unchanged — this file
 * owns presentation and orchestration only. Default-deny, per-capability, revocable,
 * audited, with the standing trust made first-class and visible: that is the design.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import {
  api,
  setPasteKeyPrompt,
  setAuthFailureHandler,
  hasResolvableKey,
  rememberManagementKey,
  type CapabilitiesResponse,
  type ActiveToken,
  type PendingItem,
  type SourceView,
  type ConfiguredSource,
  type StandingGrant,
  type TrustWindow,
  type Provenance,
  type Sensitivity,
  type BundleView,
  type BundleMemberInput,
  type ConnectorDescriptor,
  type ConnectorConfigField,
  type DetectedSourceView,
  type ExtensionManifest,
  type ExtensionSurface,
  type ExtensionPreviewResponse,
  type ExtensionListItem,
  type CapabilityHealth,
  type HealthStatus,
  type ConnectAgentResult,
  type IntegrationResult,
  type AgentEnrollment,
} from "./api.ts";
import {
  AGENT_TYPES,
  buildConnectBody,
  capsNotYetGranted,
  cascadeSelection,
  explainSkipped,
  enrollmentBadge,
  enrollmentStatusFor,
  groupCapabilities,
  triStateFor,
  type AgentType,
  type AgentEnrollmentStatus,
  type CapGroup,
  type TriState,
} from "./connect.ts";
import { initialAgentFilter } from "./nav.ts";
import { PLEXUS_PROTOCOL_VERSION } from "@plexus/protocol";
import type {
  CapabilityEntry,
  GatewayInfo,
  GrantDecision,
  GrantResponse,
  AuditEvent,
  GrantVerb,
  CapabilityId,
  TrustWindowKind,
  ScopeConstraint,
} from "@plexus/protocol";
import {
  IconKey,
  IconPlug,
  IconCheck,
  IconShield,
  IconToken,
  IconScroll,
  IconInbox,
  IconSource,
  IconGrants,
  IconGrid,
  IconAgent,
  IconBundle,
  IconSpark,
  IconGear,
  IconSun,
  IconMoon,
} from "./icons.tsx";
import {
  Onboarding,
  detectFreshState,
  isFresh,
  ONBOARDING_DISMISSED_KEY,
  type FreshState,
} from "./Onboarding.tsx";
import { Dropdown } from "./Dropdown.tsx";
import { ActivityHeatmap, ProgressRing } from "./Visuals.tsx";

/**
 * The redesigned IA (REDESIGN-PRODUCT-UX §2.2) is a LEFT SIDEBAR whose order *is* the
 * mental-model arc, grouped into three bands. `Section` replaces the old flat six-tab
 * model. The data layer (./api.ts) + protocol contract are UNCHANGED — this is a
 * reorganization + reskin of the same components, not a rewrite.
 *
 *   Overview            — the hub (§5 dashboard).
 *   WHAT I EXPOSE       — Sources · Capabilities · (reserved) Create an extension.
 *   WHO I TRUST         — Agents (the spine) · Approvals · Task Grants · Standing Grants.
 *   WHAT HAPPENED       — Activity (the audit, renamed).
 *   footer              — Connection key · Settings (raw tokens live here, demoted).
 */
type Section =
  | "overview"
  | "expose"
  | "extensions"
  | "agents"
  | "approvals"
  | "task-grants"
  | "standing-grants"
  | "activity"
  | "settings";

/** Extra intent carried across a section switch (e.g. pre-seed an Activity filter). */
interface NavOptions {
  /** Pre-select this agent in the Activity tab's agent filter on arrival. */
  agent?: string;
}

/** Navigation callback: switch sections, optionally pre-seeding a filter. */
type Navigate = (section: Section, opts?: NavOptions) => void;

/** Per-capability UI selection: grant? + the verb subset chosen. */
interface CapSelection {
  grant: boolean;
  verbs: GrantVerb[];
}

/** Does this entry support a write/execute path at all? */
function isMutating(entry: CapabilityEntry): boolean {
  return entry.grants.includes("write") || entry.grants.includes("execute");
}

const VERB_ORDER: GrantVerb[] = ["read", "write", "execute"];

/** The default agent a grant pre-authorizes when the admin doesn't pick one. */
const DEFAULT_AGENT_ID = "plexus-cli";

// ── Trust-window vocabulary (ADR-018) ──────────────────────────────────────────
/** The pickable menu (in order). `custom` opens a duration entry. */
const TRUST_WINDOW_KINDS: TrustWindowKind[] = ["once", "1h", "1d", "7d", "until-revoked", "custom"];
const TRUST_WINDOW_LABEL: Record<TrustWindowKind, string> = {
  once: "Once",
  "1h": "1 hour",
  "1d": "1 day",
  "7d": "7 days",
  "until-revoked": "Until I revoke",
  custom: "Custom…",
};
/** 30-day cap on custom / until-revoked, matching the backend `maxTrustWindowMs`. */
const MAX_TRUST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Pre-select the default trust-window by provenance × verb-kind (ADR-018 ratified table). */
function defaultTrustWindowKind(
  provenance: Provenance | undefined,
  verbs: GrantVerb[] | undefined,
): TrustWindowKind {
  const isWrite = (verbs ?? []).some((v) => v === "write" || v === "execute");
  if (provenance === "extension") return isWrite ? "once" : "1d";
  // first-party / managed (treat unknown as first-party-ish for read=7d default)
  return isWrite ? "1d" : "7d";
}

/** Build the wire TrustWindow from a kind + (for custom) a ms value. */
function makeTrustWindow(kind: TrustWindowKind, customMs?: number): TrustWindow {
  if (kind === "custom") {
    const ms = Math.min(Math.max(customMs ?? 0, 0), MAX_TRUST_WINDOW_MS);
    return { kind, ms };
  }
  return { kind };
}

/** Human-legible relative date for a trust-window / token expiry. */
function relativeWhen(iso: string | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  // Far-future sentinel ⇒ "until revoke".
  if (t - Date.now() > 365 * 24 * 60 * 60 * 1000) return "until you revoke";
  const diff = t - Date.now();
  const past = diff < 0;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  let span: string;
  if (mins < 1) span = "moments";
  else if (mins < 60) span = `${mins} min`;
  else if (hours < 48) span = `${hours} hr`;
  else span = `${days} d`;
  return past ? `expired ${span} ago` : `in ${span}`;
}

/** Format a trust-window kind for display next to a grant row. */
function trustWindowLabel(tw: TrustWindow | undefined): string {
  if (!tw) return "—";
  return TRUST_WINDOW_LABEL[tw.kind] ?? tw.kind;
}

/**
 * Render a scope CONSTRAINT (AUTHZ-UX §3) compactly for the approval card — e.g.
 * `path under Inbox/`, `calendarId in [work-cal]`. Read-only display; the enforced
 * copy lives in the token, never edited here.
 */
function constraintLabel(c: ScopeConstraint | undefined): string {
  if (!c) return "";
  const parts: string[] = [];
  if (c.pathPrefix) parts.push(`${c.pathPrefix.field} under ${c.pathPrefix.allow.join(" | ")}`);
  if (c.allow) parts.push(`${c.allow.field} in [${c.allow.values.join(", ")}]`);
  if (c.match) {
    for (const m of c.match) {
      const rhs = m.op === "in" ? `[${(m.values ?? []).join(", ")}]` : String(m.value ?? "");
      parts.push(`${m.field} ${m.op} ${rhs}`);
    }
  }
  return parts.join(" · ");
}

// ── Verb stamp ────────────────────────────────────────────────────────────────
function VerbStamp({
  verb,
  active,
}: {
  verb: GrantVerb;
  active?: boolean;
}) {
  return (
    <span className="verb" data-verb={verb} data-active={active === undefined ? undefined : active}>
      {verb}
    </span>
  );
}

// ── Source-class badge (provenance — neutral, NOT a warning) ───────────────────
const PROVENANCE_LABEL: Record<Provenance, string> = {
  "first-party": "First-party",
  managed: "Managed",
  extension: "Extension",
};
function SourceClassBadge({ provenance }: { provenance?: Provenance }) {
  if (!provenance) return null;
  return (
    <span
      className="badge badge-source"
      data-provenance={provenance}
      title={
        provenance === "first-party"
          ? "First-party — ships with Plexus."
          : provenance === "managed"
            ? "Managed — a source you added through this admin UI."
            : "Extension — user-added by an agent, so Plexus always checks with you."
      }
    >
      {PROVENANCE_LABEL[provenance]}
    </span>
  );
}

// ── Sensitivity pill (derived risk tier) ───────────────────────────────────────
function SensitivityPill({ sensitivity }: { sensitivity?: Sensitivity }) {
  if (!sensitivity) return null;
  return (
    <span className="pill-sensitivity" data-sensitivity={sensitivity} title={`Sensitivity: ${sensitivity}`}>
      {sensitivity}
    </span>
  );
}

// ── "Granted but top-level-disabled" badge (EXPOSURE policy) ───────────────────
/**
 * Marks a standing grant whose capability the owner turned OFF at the top level
 * ("What I expose"). The grant RECORD stands, but effective access = granted ∧
 * exposed, so the agent can't actually use it. Rendered dimmed + badged.
 */
function DisabledBadge() {
  return (
    <span
      className="badge badge-disabled"
      title="Granted, but disabled at the top level (What I expose) — invisible to the agent and uninvokable until you re-enable it."
    >
      disabled · invisible
    </span>
  );
}

// ── Verb multi-select (replaces the read-only / read-write segmented control) ──
function VerbMultiSelect({
  available,
  selected,
  disabled,
  onChange,
}: {
  available: GrantVerb[];
  selected: GrantVerb[];
  disabled?: boolean;
  onChange: (verbs: GrantVerb[]) => void;
}) {
  const ordered = VERB_ORDER.filter((v) => available.includes(v));
  const toggle = (v: GrantVerb) => {
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  };
  return (
    <div className="verb-select" role="group" aria-label="verbs to grant">
      {ordered.map((v) => (
        <button
          key={v}
          type="button"
          className="verb-opt"
          data-verb={v}
          aria-pressed={selected.includes(v)}
          disabled={disabled}
          onClick={() => toggle(v)}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

// ── Trust-window picker (the Approve / Grant duration) ─────────────────────────
function TrustWindowPicker({
  value,
  customMs,
  disabled,
  onChange,
}: {
  value: TrustWindowKind;
  customMs: number;
  disabled?: boolean;
  onChange: (kind: TrustWindowKind, customMs: number) => void;
}) {
  return (
    <div className="tw-picker">
      <label className="tw-label" htmlFor="tw-kind">
        Trust window
      </label>
      <Dropdown
        id="tw-kind"
        value={value}
        disabled={disabled}
        ariaLabel="Trust window"
        onChange={(v) => onChange(v as TrustWindowKind, customMs)}
        options={TRUST_WINDOW_KINDS.map((k) => ({ value: k, label: TRUST_WINDOW_LABEL[k] }))}
      />
      {value === "custom" && (
        <span className="tw-custom">
          <input
            type="number"
            min={1}
            max={30}
            value={Math.max(1, Math.round(customMs / 86_400_000))}
            disabled={disabled}
            onChange={(e) => {
              const days = Math.min(Math.max(Number(e.target.value) || 1, 1), 30);
              onChange("custom", days * 86_400_000);
            }}
            aria-label="custom trust-window in days"
          />
          <span className="tw-unit">days (max 30)</span>
        </span>
      )}
    </div>
  );
}

// ── Target-agent picker (free-text + known agent ids; decoy fix) ───────────────
function AgentPicker({
  value,
  known,
  onChange,
}: {
  value: string;
  known: string[];
  onChange: (v: string) => void;
}) {
  const listId = "known-agent-ids";
  return (
    <div className="agent-picker">
      <label className="tw-label" htmlFor="agent-id">
        Grant to agent
      </label>
      <input
        id="agent-id"
        list={listId}
        className="agent-input"
        value={value}
        spellCheck={false}
        autoComplete="off"
        placeholder={DEFAULT_AGENT_ID}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {known.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
    </div>
  );
}

// ── One capability ledger row ─────────────────────────────────────────────────
function LedgerRow({
  entry,
  selection,
  onChange,
}: {
  entry: CapabilityEntry;
  selection: CapSelection;
  onChange: (s: CapSelection) => void;
}) {
  const requiresGrant = entry.grants.length > 0;
  const granted = selection.grant ? selection.verbs : [];

  return (
    <div
      className="ledger-row"
      data-exposed={selection.grant && requiresGrant}
      data-noexpose={!requiresGrant}
    >
      <div className="rail" aria-hidden />
      <div className="row-body">
        <div className="row-title">
          <span className="name">{entry.label}</span>
          <span className="badge badge-kind" data-kind={entry.kind}>
            {entry.kind}
          </span>
          <span className="badge badge-transport">{entry.transport}</span>
          <SourceClassBadge provenance={entry.provenance} />
          <SensitivityPill sensitivity={entry.sensitivity} />
          {requiresGrant && (
            <span className="verbs">
              {VERB_ORDER.filter((v) => entry.grants.includes(v)).map((v) => (
                <VerbStamp
                  key={v}
                  verb={v}
                  active={selection.grant ? granted.includes(v) : undefined}
                />
              ))}
            </span>
          )}
        </div>
        <div className="row-id">{entry.id}</div>
        <div className="row-describe">{entry.describe}</div>
        {(entry.skills?.length || (entry.kind === "workflow" && entry.members?.length)) && (
          <div className="row-relations">
            {entry.skills?.length ? (
              <div>
                <span className="rel-label">attached skills</span>{" "}
                {entry.skills.map((s) => s.label).join(" · ")}
              </div>
            ) : null}
            {entry.kind === "workflow" && entry.members?.length ? (
              <div>
                <span className="rel-label">transitive grants</span>{" "}
                {entry.members.map((m) => (
                  <span key={m.id}>
                    <code>{m.id}</code> [{m.verbs.join("/")}]{"  "}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
      <div className="row-controls">
        {requiresGrant ? (
          <>
            <label className="expose-toggle">
              <input
                type="checkbox"
                checked={selection.grant}
                onChange={(e) => {
                  const grant = e.target.checked;
                  // Default the verb set to "read" (or the only available verb) on grant.
                  const verbs =
                    grant && selection.verbs.length === 0
                      ? entry.grants.includes("read")
                        ? (["read"] as GrantVerb[])
                        : [...entry.grants]
                      : selection.verbs;
                  onChange({ grant, verbs });
                }}
              />
              <span className="switch" aria-hidden />
              <span className="state">{selection.grant ? "Granted" : "Not granted"}</span>
            </label>
            <VerbMultiSelect
              available={entry.grants}
              selected={selection.grant ? selection.verbs : []}
              disabled={!selection.grant}
              onChange={(verbs) => onChange({ ...selection, verbs })}
            />
          </>
        ) : (
          <span className="row-note">No grant required — read-as-context.</span>
        )}
      </div>
    </div>
  );
}

// ── Capabilities ledger tab ───────────────────────────────────────────────────
function CapabilitiesTab({
  data,
  knownAgents,
  onIssued,
}: {
  data: CapabilitiesResponse;
  knownAgents: string[];
  onIssued: () => void;
}) {
  const grantable = useMemo(() => data.entries.filter((e) => e.grants.length > 0), [data.entries]);
  const [sel, setSel] = useState<Record<string, CapSelection>>({});
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<GrantResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The decoy fix: an admin grant must target a REAL agentId so the agent's next
  // request hits hasPriorApproval. Default to plexus-cli; free-text + known ids.
  const [agentId, setAgentId] = useState<string>(DEFAULT_AGENT_ID);
  // The authoritative trust-window for these grants (the human's pick).
  const [twKind, setTwKind] = useState<TrustWindowKind>("7d");
  const [twCustomMs, setTwCustomMs] = useState<number>(7 * 86_400_000);

  const selFor = (id: string): CapSelection => sel[id] ?? { grant: false, verbs: [] };
  const setOne = (id: string, s: CapSelection) => setSel((prev) => ({ ...prev, [id]: s }));

  const issue = async () => {
    const grants: Record<CapabilityId, GrantDecision | "deny"> = {};
    for (const entry of grantable) {
      const s = selFor(entry.id);
      if (!s.grant || s.verbs.length === 0) {
        grants[entry.id] = "deny";
        continue;
      }
      grants[entry.id] = { decision: "allow", verbs: s.verbs };
    }
    const allowing = Object.values(grants).filter((g) => g !== "deny").length;
    if (allowing === 0) return;
    setIssuing(true);
    setErr(null);
    setIssued(null);
    try {
      const r = await api.issueGrants(grants, {
        agentId: agentId.trim() || DEFAULT_AGENT_ID,
        trustWindow: makeTrustWindow(twKind, twCustomMs),
      });
      setIssued(r);
      onIssued();
    } catch (e) {
      setErr(String(e));
    } finally {
      setIssuing(false);
    }
  };

  const granted = grantable.filter((e) => {
    const s = selFor(e.id);
    return s.grant && s.verbs.length > 0;
  });
  const grantedCount = granted.length;
  const writeCount = granted.filter(
    (e) => selFor(e.id).verbs.some((v) => v === "write" || v === "execute") && isMutating(e),
  ).length;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Capabilities</h2>
          <div className="meta">
            The catalog of grantable things + the AI-native artifacts they generate. Each row shows
            its attached skills and (for workflows) its transitive member grants.
          </div>
          <div className="meta">
            <b>{data.entries.length}</b> registered · revision <b>{data.revision}</b> · default-deny until granted
          </div>
        </div>
      </div>

      {err && <div className="banner banner-err">{err}</div>}

      {data.entries.length === 0 ? (
        <div className="empty">
          <div className="glyph">
            <IconShield width={20} height={20} />
          </div>
          <h3>No capabilities registered</h3>
          <p>
            Sources scan into the registry at gateway boot. Once a source comes online — or you
            install cc-master above — its capabilities appear here as ledger rows, default-denied
            until you grant them.
          </p>
        </div>
      ) : (
        <div className="ledger">
          {data.entries.map((entry) => (
            <LedgerRow
              key={entry.id}
              entry={entry}
              selection={selFor(entry.id)}
              onChange={(s) => setOne(entry.id, s)}
            />
          ))}
        </div>
      )}

      {grantable.length > 0 && (
        <div className="issue-bar">
          <div className="grant-controls">
            <div className="tally">
              <span className="n">{grantedCount}</span>
              <span className="label">
                {grantedCount === 1 ? "capability" : "capabilities"} to grant
                {writeCount > 0 ? (
                  <>
                    {" "}· <b>{writeCount}</b> with write/execute
                  </>
                ) : null}
              </span>
            </div>
            <AgentPicker value={agentId} known={knownAgents} onChange={setAgentId} />
            <TrustWindowPicker
              value={twKind}
              customMs={twCustomMs}
              onChange={(k, ms) => {
                setTwKind(k);
                setTwCustomMs(ms);
              }}
            />
          </div>
          <button className="btn btn-primary" onClick={issue} disabled={issuing || grantedCount === 0}>
            {issuing ? "Granting…" : "Grant access"}
          </button>
        </div>
      )}

      {issued && "token" in issued && (
        <div className="receipt">
          <div className="r-head">
            <IconCheck width={15} height={15} /> Access granted to{" "}
            <code className="mono">{agentId.trim() || DEFAULT_AGENT_ID}</code>
            <span className="row-note">
              trust window: {TRUST_WINDOW_LABEL[twKind]} · token <code className="mono">{issued.jti}</code> expires{" "}
              {relativeWhen(issued.expiresAt)}
            </span>
          </div>
          <div className="r-scopes">
            {issued.scopes.map((s) => (
              <span key={s.id}>
                <code className="mono">{s.id}</code> [{s.verbs.join("/")}]
              </span>
            ))}
          </div>
        </div>
      )}
      {issued && "status" in issued && (
        <div className="banner banner-info" style={{ marginTop: 12 }}>
          Grant pending user decision: {issued.pending.join(", ")} (pendingId{" "}
          <code className="mono">{issued.pendingId}</code>) — resolve it in Pending.
        </div>
      )}
    </section>
  );
}

// ── Pending approvals tab (the human-in-the-loop linchpin surface) ──────────────
// Exported: onboarding's "witness a call" step embeds the SAME approval card
// inline (trust-window picker + Approve/Deny) so the demo pend resolves in place.
export function PendingCard({
  item,
  busy,
  knownAgents,
  onResolve,
}: {
  item: PendingItem;
  busy: boolean;
  knownAgents: string[];
  onResolve: (action: "approve" | "deny", opts: { trustWindow?: TrustWindow; agentId?: string }) => void;
}) {
  const isRegister = item.kind === "register";
  const reg = item.register;
  // The gateway-authored narration (ADR-018) — relay `summary` verbatim.
  const narration = item.pendingNarration ?? [];
  const provenance = narration[0]?.provenance;
  const sensitivity = narration[0]?.sensitivity;
  // Pre-select the trust-window by provenance × verb (the ratified default), but honor
  // the gateway's own default if it gave one.
  const allVerbs = (item.scopes ?? []).flatMap((s) => s.verbs as GrantVerb[]);
  const gatewayDefault = narration[0]?.defaultTrustWindow?.kind;
  const initialKind: TrustWindowKind = gatewayDefault ?? defaultTrustWindowKind(provenance, allVerbs);

  const [twKind, setTwKind] = useState<TrustWindowKind>(initialKind);
  const [twCustomMs, setTwCustomMs] = useState<number>(7 * 86_400_000);
  // Re-target the grant onto a real agent (decoy fix). Default = the requesting agent.
  const [agentId, setAgentId] = useState<string>(item.agentId ?? DEFAULT_AGENT_ID);

  const approve = () =>
    onResolve("approve", {
      trustWindow: makeTrustWindow(twKind, twCustomMs),
      agentId: agentId.trim() || undefined,
    });

  return (
    <div className="ledger-row" data-exposed={isRegister}>
      <div className="rail" aria-hidden />
      <div className="row-body">
        <div className="row-title">
          <span className="name">
            {isRegister
              ? `Register extension — ${reg?.label ?? reg?.source}`
              : item.bundle
                ? `Task bundle — ${item.bundle.name}`
                : "Grant request"}
          </span>
          <span className="badge badge-kind" data-kind={isRegister ? "workflow" : "capability"}>
            {item.bundle ? "bundle" : item.kind}
          </span>
          {item.agentId ? <span className="badge badge-transport">{item.agentId}</span> : null}
          {item.client && (item.client.name || item.client.version) ? (
            <span className="badge badge-client" title="Self-reported client name/version from the handshake">
              {[item.client.name, item.client.version].filter(Boolean).join(" ")}
            </span>
          ) : null}
          <SourceClassBadge provenance={provenance} />
          <SensitivityPill sensitivity={sensitivity} />
        </div>
        <div className="row-id">{item.pendingId}</div>

        {/* BUNDLE (AUTHZ-UX §2.N3 / D4): one grouped card — the whole task approves in a
            single Approve. The anti-self-grant linchpin holds: the agent's bundle PENDS. */}
        {item.bundle ? (
          <div className="bundle-pending">
            <span className="rel-label">this task bundle grants ({item.bundle.members.length}):</span>
            {item.bundle.members.map((m) => (
              <div className="bundle-member-row" key={m.id}>
                <code>{m.id}</code> [{m.verbs.join("/")}]
                {m.constraint ? (
                  <span className="synth"> ↳ only {constraintLabel(m.constraint)}</span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {/* GRANT: four legible blocks in order (AUTHZ-UX §2.N2):
            (1) the agent says → (2) Plexus says → (3) scope/constraint/posture → (4) controls. */}
        {!isRegister && (
          <>
            {/* (1) THE AGENT SAYS — the agent's declared purpose, PLAIN TEXT, quoted, in a
                visually-distinct block. NEVER merged with / adjacent to the gateway
                "Plexus says" narration (anti-injection). Absent ⇒ "(agent gave no reason)". */}
            <div className="agent-says">
              <span className="agent-says-label">the agent says:</span>
              {item.agentPurpose ? (
                <span className="agent-says-text">“{item.agentPurpose}”</span>
              ) : (
                <span className="agent-says-text is-empty">(agent gave no reason)</span>
              )}
            </div>

            {/* (2) PLEXUS SAYS — the gateway-authored narration, unchanged. */}
            {narration.length ? (
              <div className="narration">
                <span className="narration-label">Plexus says:</span>
                {narration.map((n) => (
                  <div className="narration-line" key={n.id}>
                    {n.summary}
                  </div>
                ))}
              </div>
            ) : null}

            {/* (3) SCOPE / CONSTRAINT / POSTURE. */}
            {item.scopes?.length ? (
              <div className="row-relations">
                <div>
                  <span className="rel-label">scope</span>{" "}
                  {item.scopes.map((s) => (
                    <span key={s.id}>
                      <code>{s.id}</code> [{s.verbs.join("/")}]{"  "}
                    </span>
                  ))}
                </div>
                {item.scopes.some((s) => s.constraint) ? (
                  <div>
                    <span className="rel-label">↳ constrained to</span>{" "}
                    {item.scopes
                      .filter((s) => s.constraint)
                      .map((s) => (
                        <span key={s.id}>
                          <code>{constraintLabel(s.constraint)}</code>
                          {"  "}
                        </span>
                      ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {item.requestedTrustWindow ? (
              <div className="row-note">
                Agent requested: {trustWindowLabel(item.requestedTrustWindow)} (advisory — you decide)
              </div>
            ) : null}
            {item.reasons?.length ? (
              <div className="row-describe">⚠ {item.reasons.join(" · ")}</div>
            ) : null}
          </>
        )}

        {/* REGISTER: the SECURITY-SENSITIVE surface — cli bins, rest hosts, cross-source. */}
        {isRegister && reg && (
          <div className="row-relations">
            <div>
              <span className="rel-label">capabilities</span>{" "}
              {reg.capabilities.map((c) => (
                <span key={c.id}>
                  <code>{c.id}</code> [{c.verbs.join("/") || "—"}] <em>({c.transport})</em>
                  {"  "}
                </span>
              ))}
            </div>
            {reg.cliBins.length > 0 && (
              <div>
                <span className="rel-label">⚠ cli binaries</span>{" "}
                {reg.cliBins.map((b) => (
                  <code key={b}>{b}</code>
                ))}
              </div>
            )}
            {reg.restHosts.length > 0 && (
              <div>
                <span className="rel-label">⚠ rest hosts</span>{" "}
                {reg.restHosts.map((h) => (
                  <code key={h}>{h}</code>
                ))}
              </div>
            )}
            {reg.crossSource.length > 0 && (
              <div>
                <span className="rel-label">⚠ cross-source attach</span>{" "}
                {reg.crossSource.map((x) => (
                  <span key={x.id}>
                    <code>{x.id}</code> → {x.sources.join(", ")}
                    {"  "}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="row-controls row-controls-approve">
        {!isRegister && (
          <>
            <AgentPicker value={agentId} known={knownAgents} onChange={setAgentId} />
            <TrustWindowPicker
              value={twKind}
              customMs={twCustomMs}
              disabled={busy}
              onChange={(k, ms) => {
                setTwKind(k);
                setTwCustomMs(ms);
              }}
            />
          </>
        )}
        <div className="approve-actions">
          <button
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={isRegister ? () => onResolve("approve", {}) : approve}
          >
            {busy ? "…" : "Approve"}
          </button>
          <button
            className="btn btn-danger btn-sm"
            disabled={busy}
            onClick={() => onResolve("deny", {})}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}

function PendingTab({ knownAgents, onResolved }: { knownAgents: string[]; onResolved: () => void }) {
  const [items, setItems] = useState<PendingItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .pending()
      .then((r) => setItems(r.pending))
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(load, [load]);

  const resolve = async (
    id: string,
    action: "approve" | "deny",
    opts: { trustWindow?: TrustWindow; agentId?: string },
  ) => {
    setBusy(id);
    setErr(null);
    try {
      await api.resolvePending(id, action, opts);
      load();
      onResolved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Approvals</h2>
          <div className="meta">
            Mode-1 — the human-in-the-loop record + the fallback when a notification was missed. An
            agent CANNOT grant write/execute or activate an extension without your approval here.
            Each "Review" row opens the same focused review the desktop notifications open.
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={load}>
          Refresh
        </button>
      </div>

      {err && <div className="banner banner-err">{err}</div>}

      {items === null ? (
        <SkeletonTable />
      ) : items.length === 0 ? (
        <div className="empty">
          <div className="glyph">
            <IconInbox width={20} height={20} />
          </div>
          <h3>Nothing awaiting you</h3>
          <p>
            When an agent requests a risky grant (write/execute, or anything on an extension) — or
            tries to register a transport-backed extension — it lands here for your approval. Until
            you approve, the agent stays denied.
          </p>
        </div>
      ) : (
        <div className="ledger">
          {items.map((item) => (
            <PendingCard
              key={item.pendingId}
              item={item}
              busy={busy === item.pendingId}
              knownAgents={knownAgents}
              onResolve={(action, opts) => resolve(item.pendingId, action, opts)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ── New task grant composer (Mode-2 bundle, AUTHZ-UX §2.N3 / D4) ────────────────
/** One editable row in the composer: a capability + verbs + optional path-prefix constraint. */
interface ComposerRow {
  id: string;
  verbs: GrantVerb[];
  /** Constraint mode: none | a path-prefix field/prefixes | an exact allowlist. */
  cKind: "none" | "pathPrefix" | "allow";
  cField: string;
  cValues: string;
}

function NewTaskGrantComposer({
  caps,
  knownAgents,
  onCreated,
}: {
  caps: CapabilitiesResponse | null;
  knownAgents: string[];
  onCreated: () => void;
}) {
  const grantable = useMemo(
    () => (caps?.entries ?? []).filter((e) => e.grants.length > 0),
    [caps],
  );
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState(DEFAULT_AGENT_ID);
  const [twKind, setTwKind] = useState<TrustWindowKind>("1d");
  const [twMs, setTwMs] = useState(86_400_000);
  const [rows, setRows] = useState<ComposerRow[]>([]);
  const [ctxSkills, setCtxSkills] = useState<string>(""); // comma list of skill ids
  const [ctxNote, setCtxNote] = useState<string>(""); // inline markdown note
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const skillEntries = useMemo(
    () => (caps?.entries ?? []).filter((e) => e.kind === "skill"),
    [caps],
  );

  const addRow = () =>
    setRows((r) => [
      ...r,
      { id: grantable[0]?.id ?? "", verbs: [], cKind: "none", cField: "path", cValues: "" },
    ]);
  const setRow = (i: number, patch: Partial<ComposerRow>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const delRow = (i: number) => setRows((r) => r.filter((_, j) => j !== i));

  const submit = async () => {
    setErr(null);
    if (!name.trim()) return setErr("name is required");
    if (!agentId.trim()) return setErr("target agent is required");
    if (rows.length === 0) return setErr("add at least one capability");
    const grants: BundleMemberInput[] = [];
    for (const row of rows) {
      if (!row.id) continue;
      const member: BundleMemberInput = { id: row.id, ...(row.verbs.length ? { verbs: row.verbs } : {}) };
      if (row.cKind !== "none") {
        const values = row.cValues.split(",").map((v) => v.trim()).filter(Boolean);
        if (row.cField && values.length) {
          member.constraint =
            row.cKind === "pathPrefix"
              ? { pathPrefix: { field: row.cField, allow: values } }
              : { allow: { field: row.cField, values } };
        }
      }
      grants.push(member);
    }
    const context: NonNullable<Parameters<typeof api.createBundle>[0]["context"]> = [];
    for (const s of ctxSkills.split(",").map((x) => x.trim()).filter(Boolean)) {
      context.push({ kind: "skill", skillId: s });
    }
    if (ctxNote.trim()) context.push({ kind: "inline", label: "Task note", markdown: ctxNote });
    setBusy(true);
    try {
      await api.createBundle({
        name: name.trim(),
        agentId: agentId.trim(),
        grants,
        trustWindow: makeTrustWindow(twKind, twMs),
        ...(context.length ? { context } : {}),
      });
      setName("");
      setRows([]);
      setCtxSkills("");
      setCtxNote("");
      setOpen(false);
      onCreated();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="composer-collapsed">
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
          + New task grant
        </button>
        <span className="meta">
          Pick an agent, add the capabilities the task needs (each with optional path/allowlist
          confinement) plus any context notes — you approve it once, and in-scope calls never
          re-prompt. Running-code capabilities can't be added (they're approved per call).
        </span>
      </div>
    );
  }

  return (
    <div className="composer">
      <div className="composer-head">
        <h3>New task grant</h3>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {err && <div className="banner banner-err">{err}</div>}
      <div className="composer-fields">
        <label className="tw-label">Task name</label>
        <input
          className="agent-input"
          value={name}
          placeholder="e.g. Organize NAS Inbox"
          onChange={(e) => setName(e.target.value)}
        />
        <AgentPicker value={agentId} known={knownAgents} onChange={setAgentId} />
        <TrustWindowPicker
          value={twKind}
          customMs={twMs}
          onChange={(k, ms) => {
            setTwKind(k);
            setTwMs(ms);
          }}
        />
      </div>

      <div className="composer-rows">
        {rows.map((row, i) => {
          const entry = grantable.find((e) => e.id === row.id);
          return (
            <div className="composer-row" key={i}>
              <Dropdown
                className="dd-cap"
                value={row.id}
                ariaLabel="capability"
                onChange={(v) => setRow(i, { id: v, verbs: [] })}
                options={grantable.map((e) => ({ value: e.id, label: e.id }))}
              />
              <VerbMultiSelect
                available={entry?.grants ?? []}
                selected={row.verbs}
                onChange={(v) => setRow(i, { verbs: v })}
              />
              <Dropdown
                value={row.cKind}
                ariaLabel="constraint kind"
                onChange={(v) => setRow(i, { cKind: v as ComposerRow["cKind"] })}
                options={[
                  { value: "none", label: "no constraint" },
                  { value: "pathPrefix", label: "path under…" },
                  { value: "allow", label: "field in…" },
                ]}
              />
              {row.cKind !== "none" && (
                <>
                  <input
                    className="agent-input composer-c-field"
                    value={row.cField}
                    placeholder="field"
                    onChange={(e) => setRow(i, { cField: e.target.value })}
                  />
                  <input
                    className="agent-input composer-c-values"
                    value={row.cValues}
                    placeholder={row.cKind === "pathPrefix" ? "Inbox/, Archive/" : "work-cal, …"}
                    onChange={(e) => setRow(i, { cValues: e.target.value })}
                  />
                </>
              )}
              <button className="btn btn-ghost btn-sm" onClick={() => delRow(i)}>
                ✕
              </button>
            </div>
          );
        })}
        <button className="btn btn-ghost btn-sm" onClick={addRow} disabled={grantable.length === 0}>
          + Add capability
        </button>
      </div>

      <div className="composer-fields">
        <label className="tw-label">
          Attach context skills{skillEntries.length ? ` (${skillEntries.length} available)` : ""}
        </label>
        <input
          className="agent-input"
          value={ctxSkills}
          placeholder="skill ids, comma-separated"
          onChange={(e) => setCtxSkills(e.target.value)}
        />
        <label className="tw-label">Inline task note (materialized as a skill)</label>
        <textarea
          className="agent-input composer-note"
          value={ctxNote}
          placeholder="e.g. Move each Inbox capture into Inbox/YYYY/MM/ by date; never touch anything outside Inbox/."
          onChange={(e) => setCtxNote(e.target.value)}
        />
      </div>

      <div className="composer-actions">
        <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
          {busy ? "Creating…" : "Create bundle"}
        </button>
      </div>
    </div>
  );
}

// ── Grants — the standing-trust ledger + the Mode-2 task bundles (ADR-018) ──────
// Re-cut into TWO sidebar sections per the new IA (REDESIGN §2.3): `view="task"`
// renders Task Grants (the composer + bundle cards); `view="standing"` renders the
// flat per-(agent,cap) Standing Grants ledger. Same data + revoke logic, reused.
function GrantsTab({
  onChanged,
  caps,
  knownAgents,
  view,
}: {
  onChanged: () => void;
  caps: CapabilitiesResponse | null;
  knownAgents: string[];
  view: "task" | "standing";
}) {
  const [grants, setGrants] = useState<StandingGrant[] | null>(null);
  const [bundles, setBundles] = useState<BundleView[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .grants()
      .then((r) => setGrants(r.grants))
      .catch((e) => setErr(String(e)));
    api
      .bundles()
      .then((r) => setBundles(r.bundles))
      .catch(() => setBundles([]));
  }, []);
  useEffect(load, [load]);

  const revoke = async (g: StandingGrant) => {
    const rowKey = `${g.agentId}::${g.capabilityId}`;
    setBusy(rowKey);
    setErr(null);
    try {
      await api.revokeGrant(g.agentId, g.capabilityId);
      load();
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  const revokeBundle = async (bundleId: string) => {
    setBusy(`bundle::${bundleId}`);
    setErr(null);
    try {
      await api.revokeBundle(bundleId);
      load();
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  // Standalone grants = those NOT belonging to any bundle (bundles render grouped below).
  const standalone = (grants ?? []).filter((g) => !g.bundleId);

  // ── TASK GRANTS (Mode-2 bundles) — the composer + bundle-grouped list. ──────────
  if (view === "task") {
    return (
      <section>
        <div className="section-head">
          <div>
            <h2>Task Grants</h2>
            <div className="meta">
              Pre-authorize a whole task at once, instead of approving calls one at a time. A
              task grant is a named set of capabilities — each with optional path/allowlist
              confinement and attached notes — handed to one agent and approved a single time.
              Calls inside that scope run without re-prompting; anything outside it still asks
              you. Revoke the whole task in one click. (Only capabilities that can stand belong
              here — running code is approved per call, never bundled.)
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={load}>
            Refresh
          </button>
        </div>

        {err && <div className="banner banner-err">{err}</div>}

        <NewTaskGrantComposer
          caps={caps}
          knownAgents={knownAgents}
          onCreated={() => {
            load();
            onChanged();
          }}
        />

        {bundles.map((b) => (
          <div className="bundle-card" key={b.bundleId}>
            <div className="bundle-head">
              <div>
                <span className="bundle-name">{b.name}</span>{" "}
                <span className="meta">→ {b.agentId}</span>{" "}
                <code className="mono bundle-id">{b.bundleId}</code>
              </div>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => revokeBundle(b.bundleId)}
                disabled={busy === `bundle::${b.bundleId}`}
              >
                {busy === `bundle::${b.bundleId}` ? "Revoking…" : "Revoke bundle"}
              </button>
            </div>
            <table className="data-table">
              <tbody>
                {b.members.map((g) => (
                  <tr key={g.capabilityId} data-disabled={g.topLevelDisabled || undefined}>
                    <td>
                      <code className="mono">{g.capabilityId}</code>
                      {g.topLevelDisabled ? <DisabledBadge /> : null}
                      {g.constraint ? (
                        <div className="synth">↳ only {constraintLabel(g.constraint)}</div>
                      ) : null}
                    </td>
                    <td>
                      <SourceClassBadge provenance={g.provenance} />
                    </td>
                    <td>
                      <span className="verbs">
                        {VERB_ORDER.filter((v) => g.verbs.includes(v)).map((v) => (
                          <VerbStamp key={v} verb={v} />
                        ))}
                      </span>
                    </td>
                    <td className="t-time">
                      {g.standing ? relativeWhen(g.expiresAt) : <span className="row-note">once</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {b.context.length > 0 && (
              <div className="meta bundle-context">
                context: {b.context.map((x) => x.id).join(", ")}
              </div>
            )}
          </div>
        ))}

        {grants === null ? (
          <SkeletonTable />
        ) : bundles.length === 0 ? (
          <div className="empty">
            <div className="glyph">
              <IconBundle width={20} height={20} />
            </div>
            <h3>No task grants yet</h3>
            <p>
              Use <b>+ New task grant</b> above to pre-authorize a whole task for an agent —
              several scoped capabilities plus context, approved in one click. An agent can also
              propose one itself; it then waits for you under <b>Approvals</b>.
            </p>
          </div>
        ) : null}
      </section>
    );
  }

  // ── STANDING GRANTS (the flat per-(agent,cap) ledger + revoke). ─────────────────
  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Standing Grants</h2>
          <div className="meta">
            The standing-trust ledger. A grant lets an agent use a capability (its verbs) until its
            trust window ends — Plexus won&apos;t re-ask before then. Revoke is the complete stop.
            To pre-authorize several capabilities for one job and revoke them together, use{" "}
            <b>Task Grants</b> instead.
          </div>
          <div className="meta" title="agentId is a self-asserted label, not a login. Any process with the connection-key can handshake as any agent id and use that id's standing grants. Rotate the connection-key to revoke them all.">
            Standing grants are scoped by agent id (self-asserted; the connection-key is the trust
            boundary — rotate it to revoke all).
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={load}>
          Refresh
        </button>
      </div>

      {err && <div className="banner banner-err">{err}</div>}

      {/* Bundle members ALSO appear grouped in Task Grants; here we show the flat ledger. */}
      {bundles.map((b) => (
        <div className="bundle-card" key={b.bundleId}>
          <div className="bundle-head">
            <div>
              <span className="bundle-name">{b.name}</span>{" "}
              <span className="meta">→ {b.agentId}</span>{" "}
              <code className="mono bundle-id">{b.bundleId}</code>
            </div>
            <button
              className="btn btn-danger btn-sm"
              onClick={() => revokeBundle(b.bundleId)}
              disabled={busy === `bundle::${b.bundleId}`}
            >
              {busy === `bundle::${b.bundleId}` ? "Revoking…" : "Revoke bundle"}
            </button>
          </div>
          <table className="data-table">
            <tbody>
              {b.members.map((g) => (
                <tr key={g.capabilityId}>
                  <td>
                    <code className="mono">{g.capabilityId}</code>
                    {g.constraint ? (
                      <div className="synth">↳ only {constraintLabel(g.constraint)}</div>
                    ) : null}
                  </td>
                  <td>
                    <SourceClassBadge provenance={g.provenance} />
                  </td>
                  <td>
                    <span className="verbs">
                      {VERB_ORDER.filter((v) => g.verbs.includes(v)).map((v) => (
                        <VerbStamp key={v} verb={v} />
                      ))}
                    </span>
                  </td>
                  <td className="t-time">
                    {g.standing ? relativeWhen(g.expiresAt) : <span className="row-note">once</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {b.context.length > 0 && (
            <div className="meta bundle-context">
              context: {b.context.map((x) => x.id).join(", ")}
            </div>
          )}
        </div>
      ))}

      {grants === null ? (
        <SkeletonTable />
      ) : standalone.length === 0 && bundles.length === 0 ? (
        <div className="empty">
          <div className="glyph">
            <IconGrants width={20} height={20} />
          </div>
          <h3>No standing grants</h3>
          <p>
            When you approve a capability, it appears here with its trust window — revoke anytime.
          </p>
        </div>
      ) : standalone.length === 0 ? null : (
        <div className="ledger">
          <table className="data-table">
            <thead>
              <tr>
                <th>agent</th>
                <th>capability</th>
                <th>source class</th>
                <th>verbs</th>
                <th>trust window ends</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {standalone.map((g) => {
                const rowKey = `${g.agentId}::${g.capabilityId}`;
                return (
                  <tr key={rowKey} data-disabled={g.topLevelDisabled || undefined}>
                    <td>{g.agentId}</td>
                    <td>
                      <code className="mono">{g.capabilityId}</code>
                      {g.topLevelDisabled ? <DisabledBadge /> : null}
                      {g.synthesizedFor ? (
                        <span className="synth">↳ via {g.synthesizedFor}</span>
                      ) : null}
                      {g.constraint ? (
                        <div className="synth">↳ only {constraintLabel(g.constraint)}</div>
                      ) : null}
                    </td>
                    <td>
                      <SourceClassBadge provenance={g.provenance} />
                      <SensitivityPill sensitivity={g.sensitivity} />
                    </td>
                    <td>
                      <span className="verbs">
                        {VERB_ORDER.filter((v) => g.verbs.includes(v)).map((v) => (
                          <VerbStamp key={v} verb={v} />
                        ))}
                      </span>
                    </td>
                    <td className="t-time">
                      {g.standing ? (
                        <>
                          {relativeWhen(g.expiresAt)}
                          <span className="row-note"> · {trustWindowLabel(g.trustWindow)}</span>
                        </>
                      ) : (
                        <span className="row-note">once (single-use)</span>
                      )}
                    </td>
                    <td>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => revoke(g)}
                        disabled={busy === rowKey}
                      >
                        {busy === rowKey ? "Revoking…" : "Revoke"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Tokens tab ────────────────────────────────────────────────────────────────
function TokensTab() {
  const [tokens, setTokens] = useState<ActiveToken[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .tokens()
      .then((r) => setTokens(r.tokens))
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(load, [load]);

  const revoke = async (jti: string) => {
    setBusy(jti);
    setErr(null);
    try {
      await api.revoke(jti);
      load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Tokens (15-min views of grants — auto-refreshed)</h2>
          <div className="meta">
            A token is a short-lived (15-min) key Plexus mints from a grant and refreshes
            automatically; you never manage it. To stop access for good, revoke the grant in Grants.
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={load}>
          Refresh
        </button>
      </div>

      {err && <div className="banner banner-err">{err}</div>}

      {tokens === null ? (
        <SkeletonTable />
      ) : tokens.length === 0 ? (
        <div className="empty">
          <div className="glyph">
            <IconToken width={20} height={20} />
          </div>
          <h3>No active tokens</h3>
          <p>
            Nothing is authorized right now. Grant access in the ledger — a token (a 15-min view of
            the grant) will appear here, scope by scope, until it expires or you revoke the grant.
          </p>
        </div>
      ) : (
        <div className="ledger">
          <table className="data-table">
            <thead>
              <tr>
                <th>token id</th>
                <th>agent</th>
                <th>scopes</th>
                <th>token expires</th>
                <th>trust window ends</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => {
                // The grant's trust-window end — the longest-lived scope ceiling on the token.
                const grantEnd = t.scopes
                  .map((s) => s.grantExpiresAt)
                  .filter((x): x is string => Boolean(x))
                  .sort()
                  .pop();
                return (
                  <tr key={t.jti}>
                    <td>
                      <code className="mono">{t.jti}</code>
                    </td>
                    <td>{t.agentId ?? <span className="row-note">—</span>}</td>
                    <td>
                      {t.scopes.length ? (
                        t.scopes.map((s) => (
                          <span className="scope-line" key={s.id}>
                            <code className="mono">{s.id}</code> [{s.verbs.join("/")}]
                            <SourceClassBadge provenance={s.provenance} />
                            {s.synthesizedFor ? (
                              <span className="synth">↳ via {s.synthesizedFor}</span>
                            ) : null}
                          </span>
                        ))
                      ) : (
                        <span className="row-note">—</span>
                      )}
                    </td>
                    <td className="t-time">{relativeWhen(t.expiresAt)}</td>
                    <td className="t-time">
                      {grantEnd ? relativeWhen(grantEnd) : <span className="row-note">—</span>}
                    </td>
                    <td>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => revoke(t.jti)}
                        disabled={busy === t.jti}
                      >
                        {busy === t.jti ? "Revoking…" : "Revoke token"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Audit tab ─────────────────────────────────────────────────────────────────
function eventGroup(type: AuditEvent["type"]): string {
  if (type === "handshake") return "handshake";
  if (type.startsWith("grant")) return "grant";
  if (type.startsWith("token")) return "token";
  if (type === "invoke") return "invoke";
  if (type === "source.install") return "source";
  return "";
}

/** A short, human label for an audit event type (drops the dotted namespace). */
function eventLabel(type: AuditEvent["type"]): string {
  const map: Record<AuditEvent["type"], string> = {
    handshake: "handshake",
    "grant.allow": "grant",
    "grant.deny": "deny",
    "grant.revoke": "revoke",
    "grant.pending": "pending",
    "token.issue": "token",
    "token.refresh": "refresh",
    "token.revoke": "token revoke",
    invoke: "invoke",
    "source.install": "install",
    "source.settings": "settings",
    "exposure.set": "exposure",
  };
  return map[type] ?? String(type).replace(/[._]/g, " ");
}

/** Compact relative "moments / 4m / 2h / 3d ago" for the activity pulse. */
function relAgo(iso: string | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 45_000) return "now";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(diff / 86_400_000)}d`;
}

// ── Audit request/result panes (Feature 1 — "不能没有参数") ──────────────────────
/** Does this event carry an `input` (request params) and/or `output` (result)? */
function hasAuditIO(e: AuditEvent): boolean {
  // A grant denial carries its WHY in `detail` (reason/policy) rather than input/output
  // — without this, the deny row is not expandable and the reason is invisible.
  if (e.type === "grant.deny" && e.detail !== undefined) return true;
  return e.input !== undefined || e.output !== undefined;
}

/** Extract a denial/error envelope from an event's `output` (`{ error: { code, message } }`). */
function auditError(output: unknown): { code?: string; message?: string } | null {
  if (output && typeof output === "object" && "error" in output) {
    const err = (output as { error?: unknown }).error;
    if (err && typeof err === "object") return err as { code?: string; message?: string };
  }
  return null;
}

/** A one-line "top-level keys" summary used as the collapsed view of a large value. */
function summarizeValue(value: unknown): string {
  if (Array.isArray(value)) return `[ ${value.length} item${value.length === 1 ? "" : "s"} … ]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length ? `{ ${keys.join(", ")} … }` : "{ }";
  }
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return (s ?? "").length > 120 ? `${(s ?? "").slice(0, 117)}…` : String(s);
}

/**
 * A compact, theme-aware JSON code block. The backend already redacts + truncates,
 * but very large values are further collapsed here to their top-level keys with a
 * "show full" affordance so a row stays scannable. Tokens only — flips with the theme.
 */
function JsonBlock({ value }: { value: unknown }) {
  const full = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return String(value);
    }
  }, [value]);
  const large = full.length > 480 || full.split("\n").length > 14;
  const [expanded, setExpanded] = useState(!large);
  return (
    <pre className="json-block" data-collapsed={!expanded || undefined}>
      <code>{expanded ? full : summarizeValue(value)}</code>
      {large && (
        <button
          type="button"
          className="json-more"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "collapse" : "… show full"}
        </button>
      )}
    </pre>
  );
}

/**
 * The expandable request/result detail for one audit row. Shows `input` (the invoke
 * params) and `output` (the result); for denials it renders the error code + message.
 * Events without input/output (older / non-invoke) render nothing.
 */
function AuditDetail({ event }: { event: AuditEvent }) {
  const err = auditError(event.output);
  if (!hasAuditIO(event)) return null;
  // grant.deny: the reason lives in `detail` — render it as the (error-toned) pane.
  const denyDetail =
    event.type === "grant.deny" && event.detail !== undefined ? event.detail : null;
  const denyReason =
    denyDetail && typeof (denyDetail as { reason?: unknown }).reason === "string"
      ? ((denyDetail as { reason?: string }).reason ?? null)
      : null;
  return (
    <div className="audit-detail">
      {denyDetail && (
        <div className="audit-pane">
          <span className="audit-pane-label" data-error>
            denied
          </span>
          {denyReason ? (
            <div className="audit-error">
              <code className="audit-error-code">grant.deny</code>
              <span className="audit-error-msg">{denyReason}</span>
            </div>
          ) : (
            <JsonBlock value={denyDetail} />
          )}
        </div>
      )}
      {event.input !== undefined && (
        <div className="audit-pane">
          <span className="audit-pane-label">params</span>
          <JsonBlock value={event.input} />
        </div>
      )}
      {event.output !== undefined && (
        <div className="audit-pane">
          <span className="audit-pane-label" data-error={err ? true : undefined}>
            {err ? "error" : "result"}
          </span>
          {err ? (
            <div className="audit-error">
              <code className="audit-error-code">{err.code ?? "error"}</code>
              {err.message ? <span className="audit-error-msg">{err.message}</span> : null}
            </div>
          ) : (
            <JsonBlock value={event.output} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Activity (audit, renamed to the user's word) — with §2.4 filters. ───────────
function ActivityTab({
  initialAgent = null,
  onConsumeInitialAgent,
}: {
  /** Agent id to pre-select in the agent filter on mount (from a "Recent activity →" jump). */
  initialAgent?: string | null;
  /** Called once on mount after the initial agent has been consumed, so the parent can clear it. */
  onConsumeInitialAgent?: () => void;
} = {}) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Seed the agent filter from the (optional) pending jump; the dropdown stays fully
  // user-controllable afterward. Consumed once on mount so later visits default to "all".
  const [fAgent, setFAgent] = useState<string>(() => initialAgentFilter(initialAgent));
  useEffect(() => {
    if (initialAgent) onConsumeInitialAgent?.();
    // Mount-only: ActivityTab remounts on each nav to Activity, so this runs per visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [fCap, setFCap] = useState<string>("all");
  const [fOutcome, setFOutcome] = useState<string>("all");
  // Which rows are expanded to reveal their request params + result (Feature 1).
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const load = useCallback(() => {
    api
      .audit(300)
      .then((r) => setEvents(r.events))
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(load, [load]);

  // Filter facets, derived from the loaded events (REDESIGN §2.4).
  const agents = useMemo(
    () => [...new Set((events ?? []).map((e) => e.agentId).filter((x): x is string => Boolean(x)))],
    [events],
  );
  const caps = useMemo(
    () => [...new Set((events ?? []).map((e) => e.capabilityId).filter((x): x is string => Boolean(x)))],
    [events],
  );
  const outcomes = useMemo(
    () => [...new Set((events ?? []).map((e) => e.outcome).filter(Boolean).map(String))],
    [events],
  );
  const filtered = (events ?? []).filter(
    (e) =>
      (fAgent === "all" || e.agentId === fAgent) &&
      (fCap === "all" || e.capabilityId === fCap) &&
      (fOutcome === "all" || e.outcome === fOutcome),
  );

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Activity</h2>
          <div className="meta">
            Append-only, redacted. Every handshake, grant, token, invoke and revoke — who did what is
            crystal clear.
          </div>
        </div>
        <div className="activity-filters">
          <Dropdown
            value={fAgent}
            ariaLabel="filter by agent"
            onChange={setFAgent}
            options={[{ value: "all", label: "agent: all" }, ...agents.map((a) => ({ value: a, label: a }))]}
          />
          <Dropdown
            value={fCap}
            ariaLabel="filter by capability"
            onChange={setFCap}
            options={[{ value: "all", label: "capability: all" }, ...caps.map((c) => ({ value: c, label: c }))]}
          />
          <Dropdown
            value={fOutcome}
            ariaLabel="filter by outcome"
            onChange={setFOutcome}
            options={[{ value: "all", label: "outcome: all" }, ...outcomes.map((o) => ({ value: o, label: o }))]}
          />
          <button className="btn btn-ghost btn-sm" onClick={load}>
            Refresh
          </button>
        </div>
      </div>

      {err && <div className="banner banner-err">{err}</div>}

      {events === null ? (
        <SkeletonTable />
      ) : filtered.length === 0 ? (
        <div className="empty">
          <div className="glyph">
            <IconScroll width={20} height={20} />
          </div>
          <h3>{events.length === 0 ? "The ledger is clean" : "No events match the filter"}</h3>
          <p>
            {events.length === 0
              ? "No events recorded yet. The moment an agent handshakes, is granted a scope, or invokes a capability, it lands here — timestamped and evidentiary."
              : "Adjust the agent / capability / outcome filters to see more of the audit."}
          </p>
        </div>
      ) : (
        <div className="ledger">
          <table className="data-table">
            <thead>
              <tr>
                <th>time</th>
                <th>event</th>
                <th>capability</th>
                <th>outcome</th>
                <th>agent / token</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => {
                const expandable = hasAuditIO(e);
                const isOpen = open.has(e.id);
                return (
                  <Fragment key={e.id}>
                    <tr
                      className="audit-row"
                      data-expandable={expandable || undefined}
                      data-open={isOpen || undefined}
                      onClick={expandable ? () => toggle(e.id) : undefined}
                      aria-expanded={expandable ? isOpen : undefined}
                    >
                      <td className="t-time">
                        {expandable && (
                          <span className="audit-caret" data-open={isOpen || undefined} aria-hidden>
                            ▸
                          </span>
                        )}
                        {new Date(e.at).toLocaleTimeString()}
                      </td>
                      <td>
                        <span className="evt" data-grp={eventGroup(e.type)}>
                          {e.type}
                        </span>
                      </td>
                      <td>
                        {e.capabilityId ? (
                          <code className="mono">{e.capabilityId}</code>
                        ) : (
                          <span className="row-note">—</span>
                        )}
                      </td>
                      <td>
                        {e.outcome ? (
                          <span className="outcome" data-o={e.outcome}>
                            {e.outcome}
                          </span>
                        ) : (
                          <span className="row-note">—</span>
                        )}
                      </td>
                      <td className="t-time">
                        {e.agentId ?? "—"}
                        {e.jti ? ` · ${e.jti}` : ""}
                      </td>
                    </tr>
                    {expandable && isOpen && (
                      <tr className="audit-detail-row">
                        <td colSpan={5}>
                          <AuditDetail event={e} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Sources tab (msrc-t2) — manage capability sources from the UI ──────────────

/** Slugify a label into a stable, secret-safe source id / secret name fragment. */
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "source"
  );
}

// ════════════════════════════════════════════════════════════════════════════
// WHAT I EXPOSE — unified nested view (connector catalog → sources → capabilities)
// ════════════════════════════════════════════════════════════════════════════
// The redesign collapses the old peer tabs (Sources | Capabilities) into ONE tree:
//   · Connector CATALOG (secondary/collapsible) — "what Plexus can connect to".
//   · Source INSTANCES grouped by provenance tier; each row EXPANDS to ITS
//     capabilities (the source→capability join the old orphan list was missing).
// Three layers, named consistently: Connector (连接器) · Source (源) · Capability (能力).

const PROVENANCE_TIERS: Provenance[] = ["first-party", "managed", "extension"];
const TIER_LABEL: Record<Provenance, string> = {
  "first-party": "First-party",
  managed: "Managed",
  extension: "Extensions",
};
const TIER_BLURB: Record<Provenance, string> = {
  "first-party": "Ships with Plexus.",
  managed: "Sources you added through this admin UI.",
  extension: "User-added by an agent — Plexus always checks with you.",
};
/** Reserved first-party source ids (mirrors RESERVED_SOURCE_IDS for tier grouping). */
const RESERVED_FIRST_PARTY = new Set<string>(["cc-master", "obsidian", "mock"]);

/** Recover a capability's source id from `entry.source`, falling back to the id prefix. */
function sourceOf(entry: CapabilityEntry): string {
  return entry.source || entry.id.split(".").slice(0, -2).join(".") || entry.id;
}

// ── Per-source HEALTH (HEALTH) — the dashboard's health vocabulary ───────────────
// Health is per-source, advisory + time-varying (backend caches ~10s, stale-while-
// revalidate). The source row owns the signal; capability leaves inherit it. The dot
// colour maps onto the existing signal palette: ok→grant(green), degraded→amber,
// unavailable→deny(red), unknown→hidden(grey, quiet — the not-yet-probed/no-op default).
const HEALTH_LABEL: Record<HealthStatus, string> = {
  ok: "Healthy",
  degraded: "Degraded",
  unavailable: "Unavailable",
  unknown: "Unknown",
};

/** Is this a status the user should be alerted to (loud) vs. quiet/neutral? */
function healthIsAlarming(status: HealthStatus): boolean {
  return status === "unavailable" || status === "degraded";
}

/**
 * The DISPLAY label for a health snapshot. Normally the 4-state map above, but a mesh-mounted
 * source (mesh-health-reporting.md §6) reports its finer state in `detail`: an `unknown` status
 * whose detail begins "connecting" is a proxy whose first health report hasn't arrived yet — show
 * "Connecting" rather than the quiet "Unknown".
 */
function healthLabel(health: CapabilityHealth | undefined): string {
  const status: HealthStatus = health?.status ?? "unknown";
  if (status === "unknown" && health?.detail?.toLowerCase().startsWith("connect")) return "Connecting";
  return HEALTH_LABEL[status];
}

/**
 * The per-source health dot + accessible label. `detail` (e.g. "`claude` not on PATH")
 * and a relative "checked Ns ago" ride along as the title tooltip. `unknown` stays
 * quiet (no alarm — it's the default for not-yet-probed / no-op connectors).
 */
function HealthDot({ health }: { health: CapabilityHealth | undefined }) {
  const status: HealthStatus = health?.status ?? "unknown";
  const checked = relAgo(health?.checkedAt);
  // A mesh "connecting" reads as unknown on the wire but renders its own quiet state (below).
  const connecting = status === "unknown" && !!health?.detail?.toLowerCase().startsWith("connect");
  const title =
    healthLabel(health) +
    (health?.detail ? ` — ${health.detail}` : "") +
    (checked ? ` · checked ${checked === "now" ? "just now" : `${checked} ago`}` : "");
  return (
    <span
      className="health-dot"
      data-health={connecting ? "connecting" : status}
      role="img"
      aria-label={`Source health: ${title}`}
      title={title}
    />
  );
}

/**
 * The inline health REASON shown on a source row when it is NOT ok — so the user
 * immediately reads "this source is down because X". Renders nothing for ok/unknown
 * (those are quiet); falls back to the status label when the backend gave no detail.
 */
function HealthReason({ health }: { health: CapabilityHealth | undefined }) {
  const status: HealthStatus = health?.status ?? "unknown";
  if (!healthIsAlarming(status)) return null;
  const checked = relAgo(health?.checkedAt);
  return (
    <span className="health-reason" data-health={status}>
      <span className="health-reason-label">{HEALTH_LABEL[status]}</span>
      {health?.detail ? <span className="health-reason-detail">{health.detail}</span> : null}
      {checked ? (
        <span className="health-reason-when">· {checked === "now" ? "just now" : `${checked} ago`}</span>
      ) : null}
    </span>
  );
}

/**
 * One capability LEAF rendered nested under its source row. Read-only descriptive
 * view (grant verbs / kind / sensitivity / describe) — issuing a grant lives under
 * WHO I TRUST, so this is the "what does this source expose" join, not a grant form.
 */
function CapabilityLeaf({
  entry,
  enabled,
  busy,
  onToggle,
}: {
  entry: CapabilityEntry;
  enabled: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
}) {
  const requiresGrant = entry.grants.length > 0;
  return (
    <div className="cap-leaf" data-disabled={!enabled || undefined}>
      <div className="cap-leaf-head">
        <span className="name">{entry.label}</span>
        <span className="badge badge-kind" data-kind={entry.kind}>
          {entry.kind}
        </span>
        <SensitivityPill sensitivity={entry.sensitivity} />
        {!enabled && (
          <span className="badge badge-disabled" title="Top-level disabled — invisible to all agents, ungrantable, and uninvokable.">
            disabled · invisible
          </span>
        )}
        {requiresGrant ? (
          <span className="verbs">
            {VERB_ORDER.filter((v) => entry.grants.includes(v)).map((v) => (
              <VerbStamp key={v} verb={v} />
            ))}
          </span>
        ) : (
          <span className="row-note">read-as-context</span>
        )}
        {/* Top-level exposure toggle (Feature 3) — the OUTERMOST gate. */}
        <label className="expose-toggle cap-leaf-toggle" title="Expose this capability to agents (effective access = granted ∧ exposed).">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(ev) => onToggle(ev.target.checked)}
          />
          <span className="switch" aria-hidden />
          <span className="state">{busy ? "…" : enabled ? "Exposed" : "Disabled"}</span>
        </label>
      </div>
      <div className="cap-leaf-id">{entry.id}</div>
      <div className="cap-leaf-describe">{entry.describe.split("\n")[0]}</div>
      {!enabled && (
        <div className="cap-leaf-hint">
          Disabled at the top level: invisible to all agents, not grantable, and not invokable — even
          with a still-valid token. Re-enable to expose it again.
        </div>
      )}
    </div>
  );
}

/**
 * One SOURCE row — expandable to reveal its capabilities. Works for BOTH a managed
 * `ConfiguredSource` (with enable/disable/remove controls) and a DERIVED source (a
 * first-party module or live extension that owns capabilities but has no
 * ConfiguredSource) — `src` is null for the derived case, so the controls hide.
 */
function ExpandableSourceRow({
  id,
  label,
  kind,
  transport,
  provenance,
  caps,
  src,
  health,
  busy,
  exposure,
  exposureBusy,
  onToggleExposure,
  launch,
  launchBusy,
  onToggleRealLaunch,
  onEnable,
  onDisable,
  onRemove,
}: {
  id: string;
  label: string;
  kind: string;
  transport: string;
  provenance: Provenance;
  caps: CapabilityEntry[];
  src: SourceView | null;
  /** The health to render — `src.health` for a ConfiguredSource, else the derived cap health. */
  health?: CapabilityHealth;
  busy: boolean;
  /** id → currently exposed? (default true when absent). */
  exposure: Map<string, boolean>;
  /** The capability id whose exposure toggle is in flight, if any. */
  exposureBusy: string | null;
  onToggleExposure: (id: string, next: boolean) => void;
  /** Machine-level real-launch state — present ONLY for the exec-class sources. */
  launch?: { realLaunch: boolean; persisted: boolean | null; envActive: boolean };
  launchBusy?: boolean;
  onToggleRealLaunch?: (next: boolean) => void;
  onEnable?: () => void;
  onDisable?: () => void;
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Prefer the explicit `health` prop (carries the derived mesh-source health); fall back to the
  // ConfiguredSource's inline health for a normal source.
  const rowHealth = health ?? src?.health;
  const live = src ? src.live : caps.length > 0;
  const enabled = src ? src.enabled : true;
  const status = live ? "live" : enabled ? "offline" : "disabled";
  const capCount = src ? Math.max(src.liveCapabilityCount, caps.length) : caps.length;

  return (
    <div className="source-block" data-open={open}>
      <div className="ledger-row" data-exposed={live} data-noexpose={!enabled}>
        <div className="rail" aria-hidden />
        <button
          type="button"
          className="row-body row-expand"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <div className="row-title">
            <span className="caret" aria-hidden data-open={open}>
              ▸
            </span>
            <HealthDot health={rowHealth} />
            <span className="name">{label || id}</span>
            <span className="badge badge-kind" data-kind={kind}>
              {kind}
            </span>
            <span className="badge badge-transport">{transport}</span>
            {src?.approval === "ask" && (
              <span
                className="badge badge-kind"
                data-kind="protected"
                title="Protected — every capability (reads included) pends for your approval on first use."
              >
                protected
              </span>
            )}
            <span className="verbs">
              <span className="verb" data-active={live}>
                {status}
              </span>
            </span>
          </div>
          <div className="row-id">{id}</div>
          <div className="row-describe">
            {capCount > 0
              ? `${capCount} ${capCount === 1 ? "capability" : "capabilities"}${live ? " · live" : ""}`
              : enabled
                ? "Enabled but no live capabilities — the source may be unreachable."
                : "Disabled — retained in config, not registered."}
            {src?.route?.baseUrl ? (
              <span className="row-note"> · {String(src.route.baseUrl)}</span>
            ) : null}
            {src?.secretRef ? (
              <span className="row-note"> · key ref <code>{src.secretRef}</code></span>
            ) : null}
            {/* When a source is degraded/unavailable, surface the REASON inline so the
                user sees "down because X" without expanding. Quiet for ok/unknown. */}
            <HealthReason health={rowHealth} />
          </div>
        </button>
        {src ? (
          <div className="row-controls">
            {enabled ? (
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onDisable}>
                {busy ? "…" : "Disable"}
              </button>
            ) : (
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={onEnable}>
                {busy ? "…" : "Enable"}
              </button>
            )}
            <button className="btn btn-danger btn-sm" disabled={busy} onClick={onRemove}>
              Remove
            </button>
          </div>
        ) : (
          <div className="row-controls">
            <SourceClassBadge provenance={provenance} />
          </div>
        )}
      </div>
      {open && (
        <div className="cap-leaves">
          {launch && onToggleRealLaunch && (
            /* The machine-level REAL-LAUNCH knob (exec-class sources only). This is the
               OWNER's asset decision — "may approved execute calls actually spawn the tool
               (spending my model quota / running agents on this machine)" — distinct from,
               and composing with, the per-call grant approval. Audited on every flip. */
            <div className="cap-leaf" data-setting="real-launch">
              <div className="row-title">
                <span className="name">Real launch</span>
                <span className="badge badge-kind">{launch.realLaunch ? "REAL" : "record-mode"}</span>
                {launch.persisted === null && launch.envActive && (
                  <span className="badge badge-transport" title="Enabled by the environment flag; the toggle overrides it.">
                    via env
                  </span>
                )}
              </div>
              <div className="row-describe">
                {launch.realLaunch
                  ? "Approved execute calls REALLY spawn the tool on this machine (spends your model quota)."
                  : "Approved execute calls do the honest dry-run: full sandboxed command assembled and audited, nothing spawned, no spend."}
              </div>
              <div className="row-controls">
                <button
                  className={launch.realLaunch ? "btn btn-ghost btn-sm" : "btn btn-primary btn-sm"}
                  disabled={launchBusy}
                  onClick={() => onToggleRealLaunch(!launch.realLaunch)}
                >
                  {launchBusy ? "…" : launch.realLaunch ? "Switch to record-mode" : "Enable real launch"}
                </button>
              </div>
            </div>
          )}
          {caps.length === 0 ? (
            <div className="cap-leaf-empty">
              No live capabilities — they appear here once the source comes online.
            </div>
          ) : (
            caps.map((entry) => (
              <CapabilityLeaf
                key={entry.id}
                entry={entry}
                enabled={exposure.get(entry.id) ?? true}
                busy={exposureBusy === entry.id}
                onToggle={(next) => onToggleExposure(entry.id, next)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * DATA-DRIVEN connector form — renders inputs from `connector.fields` and maps each
 * value by `target` on submit: label→cfg.label, route→cfg.route[name], secret→a
 * write-only `putSecret(name, value)` then `cfg.secretRef = name`. Replaces the
 * hardcoded AddObsidianForm. `prefill` pre-populates from a detect result.
 */
function ConnectorForm({
  connector,
  existingIds,
  prefill,
  onAdded,
  onCancel,
}: {
  connector: ConnectorDescriptor;
  existingIds: string[];
  prefill?: DetectedSourceView;
  onAdded: () => void;
  onCancel: () => void;
}) {
  // The cc-master / "Claude Code" connector is a FIRST-PARTY launch profile: its single
  // `loadCcMaster` toggle persists via the dedicated cc-master config route, not the
  // generic addSource (it has no SourceKindAdapter). The toggle GATES its capabilities.
  const isCcMaster = connector.kind === "cc-master";

  const initial = useMemo(() => {
    const v: Record<string, string> = {};
    for (const f of connector.fields) {
      if (f.type === "toggle") {
        v[f.name] = (f.default ?? "false") === "true" ? "true" : "false";
      } else if (f.target === "label") {
        v[f.name] = prefill?.suggested.label ?? f.default ?? "";
      } else if (f.target === "route") {
        const r = prefill?.suggested.route?.[f.name];
        v[f.name] = typeof r === "string" ? r : (f.default ?? "");
      } else {
        v[f.name] = ""; // secrets never pre-fill (never echoed)
      }
    }
    return v;
  }, [connector, prefill]);

  const [values, setValues] = useState<Record<string, string>>(initial);
  // Per-instance approval posture (a generic ConfiguredSource field, not descriptor-
  // driven): "Protected" ⇒ approval:"ask" — every verb (reads too) pends on first use.
  const [protectedAsk, setProtectedAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // For cc-master, hydrate the toggle from the persisted launch-profile config so the
  // form reflects the real current gate (not just the descriptor default).
  useEffect(() => {
    if (!isCcMaster) return;
    api
      .ccMasterConfig()
      .then((r) =>
        setValues((prev) => ({ ...prev, loadCcMaster: r.config.loadCcMaster ? "true" : "false" })),
      )
      .catch(() => {});
  }, [isCcMaster]);

  const setField = (name: string, val: string) =>
    setValues((prev) => ({ ...prev, [name]: val }));

  const inputType = (f: ConnectorConfigField): string =>
    f.type === "password" ? "password" : "text";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setDone(null);
    setBusy(true);
    try {
      // cc-master: persist the loadCcMaster gate via the dedicated config route.
      if (isCcMaster) {
        const loadCcMaster = (values.loadCcMaster ?? "true") === "true";
        const res = await api.setCcMasterConfig(loadCcMaster);
        setDone(
          res.config.loadCcMaster
            ? "cc-master orchestration enabled — its capabilities now appear in the ledger."
            : "cc-master orchestration disabled — only the base launch capability is exposed.",
        );
        onAdded();
        return;
      }

      // Required-field guard (text fields only; toggles always have a value).
      for (const f of connector.fields) {
        if (f.type !== "toggle" && f.required && !(values[f.name] ?? "").trim()) {
          setErr(`${f.label} is required.`);
          return;
        }
      }
      // Derive a stable id from the chosen label (or the connector kind).
      const labelField = connector.fields.find((f) => f.target === "label");
      const labelVal = (labelField ? values[labelField.name] : "")?.trim() || connector.label;
      let id = prefill?.suggested.id ?? slug(labelVal);
      if (existingIds.includes(id)) id = `${id}-${Date.now().toString(36).slice(-4)}`;

      const route: Record<string, unknown> = {};
      let secretRef: string | undefined;
      // Map each field by target. Secrets are written WRITE-ONLY first, then referenced.
      for (const f of connector.fields) {
        if (f.type === "toggle") {
          route[f.name] = (values[f.name] ?? "false") === "true";
          continue;
        }
        const val = (values[f.name] ?? "").trim();
        if (f.target === "route") {
          if (val) route[f.name] = val;
        } else if (f.target === "secret" && val) {
          const secretName = prefill?.needsSecret?.name ?? `${id}-${slug(f.name)}`;
          await api.putSecret(secretName, val);
          secretRef = secretName;
        }
      }

      const cfg: ConfiguredSource = {
        id,
        kind: connector.kind,
        label: labelVal || id,
        enabled: true,
        transport: connector.transport as ConfiguredSource["transport"],
        ...(Object.keys(route).length ? { route } : {}),
        ...(secretRef ? { secretRef } : {}),
        // "Protected" checkbox → approval:"ask" (omit for the default auto posture).
        ...(protectedAsk ? { approval: "ask" as const } : {}),
      };
      const res = await api.addSource(cfg);
      if (!res.ok) {
        setErr(res.reason ?? "The source could not be registered.");
        return;
      }
      setDone(
        `Added ${cfg.label} — ${res.registered.length} capability(ies) now discoverable.`,
      );
      onAdded();
    } catch (e2) {
      setErr(String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="source-form" onSubmit={submit}>
      <div className="eyebrow">
        <IconPlug width={13} height={13} /> connect · {connector.label}
      </div>
      <div className="sub">{connector.blurb}.</div>
      <div className="form-grid">
        {connector.fields.map((f) =>
          f.type === "toggle" ? (
            <label className="field field-wide expose-toggle" key={f.name}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={(values[f.name] ?? "false") === "true"}
                  onChange={(e) => setField(f.name, e.target.checked ? "true" : "false")}
                />
                {f.label}
              </span>
              {f.help ? <span className="field-help">{f.help}</span> : null}
            </label>
          ) : (
            <label
              className={`field ${f.target === "secret" || f.type === "path" ? "field-wide" : ""}`}
              key={f.name}
            >
              <span>
                {f.label}
                {f.required ? " *" : ""}
              </span>
              <input
                type={inputType(f)}
                value={values[f.name] ?? ""}
                onChange={(e) => setField(f.name, e.target.value)}
                placeholder={f.placeholder}
                autoComplete={f.target === "secret" ? "off" : undefined}
                spellCheck={false}
              />
              {f.help ? <span className="field-help">{f.help}</span> : null}
            </label>
          ),
        )}
        {/* Per-instance approval posture — a GENERIC ConfiguredSource field, rendered for
            every wireable managed kind (not descriptor-driven; cc-master persists via its
            own config route and takes no ConfiguredSource). */}
        {!isCcMaster && (
          <label className="field field-wide expose-toggle" key="__approval">
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={protectedAsk}
                onChange={(e) => setProtectedAsk(e.target.checked)}
              />
              Protected — agents must ask before every first use
            </span>
            <span className="field-help">
              Every capability on this source (reads included) pends for your approval on
              first use; you pick the trust window on the approval card.
            </span>
          </label>
        )}
      </div>
      {err && <div className="banner banner-err" style={{ marginTop: 12 }}>{err}</div>}
      {done && (
        <div className="banner banner-ok" style={{ marginTop: 12 }}>
          <IconCheck width={15} height={15} /> {done}
        </div>
      )}
      <div className="form-actions">
        <button className="btn btn-ghost" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? (isCcMaster ? "Saving…" : "Adding…") : isCcMaster ? "Save" : `Add ${connector.label}`}
        </button>
      </div>
    </form>
  );
}

/**
 * The connector CATALOG ("what Plexus can connect to") — SECONDARY, collapsible. One
 * row per `ConnectorDescriptor`: label, blurb, provenance chip, exposes-summary. A
 * detectable connector with a matching detect result badges "Detected on this machine"
 * and offers Install/接入 (form pre-filled). Wireable connectors offer "Add…".
 * First-party builtins are informational (no add action).
 */
function ConnectorCatalog({
  connectors,
  detected,
  existingIds,
  onAdded,
}: {
  connectors: ConnectorDescriptor[];
  detected: DetectedSourceView[];
  existingIds: string[];
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<{ kind: string; prefill?: DetectedSourceView } | null>(null);

  const detectByKind = useMemo(() => {
    const m = new Map<string, DetectedSourceView>();
    for (const d of detected) if (!m.has(d.kind)) m.set(d.kind, d);
    return m;
  }, [detected]);

  return (
    <div className="catalog">
      <button
        type="button"
        className="catalog-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="caret" aria-hidden data-open={open}>
          ▸
        </span>
        What Plexus can connect to
        <span className="catalog-count">{connectors.length} connectors</span>
      </button>
      {open && (
        <div className="catalog-list">
          {connectors.map((c) => {
            const hit = c.detectable ? detectByKind.get(c.kind) : undefined;
            const isActive = active?.kind === c.kind;
            return (
              <div className="catalog-item" key={c.kind} data-provenance={c.provenanceClass}>
                <div className="catalog-item-head">
                  <span className="name">{c.label}</span>
                  <SourceClassBadge provenance={c.provenanceClass} />
                  {hit && !hit.alreadyConfigured ? (
                    <span className="badge badge-detected">Detected on this machine</span>
                  ) : null}
                </div>
                <div className="catalog-item-blurb">{c.blurb}</div>
                {c.exposesSummary ? (
                  <div className="catalog-item-exposes">exposes: {c.exposesSummary}</div>
                ) : null}
                <div className="catalog-item-actions">
                  {c.wireable ? (
                    hit && !hit.alreadyConfigured ? (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => setActive(isActive ? null : { kind: c.kind, prefill: hit })}
                      >
                        {isActive ? "Close" : "Install / 接入"}
                      </button>
                    ) : (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setActive(isActive ? null : { kind: c.kind })}
                      >
                        {isActive ? "Close" : "Add…"}
                      </button>
                    )
                  ) : (
                    <span className="row-note">Built in — always available.</span>
                  )}
                </div>
                {isActive && c.wireable ? (
                  <div className="tile" style={{ marginTop: 12 }}>
                    <ConnectorForm
                      connector={c}
                      existingIds={existingIds}
                      prefill={active?.prefill}
                      onAdded={() => {
                        setActive(null);
                        onAdded();
                      }}
                      onCancel={() => setActive(null)}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Thin compatibility wrapper kept for the Onboarding flow (step 3): fetches the
 * obsidian-rest connector descriptor and renders the data-driven `ConnectorForm` for
 * it. The form is now schema-driven (no hardcoded fields) — this just pre-selects the
 * obsidian-rest connector so the first-run "Add your first source" step keeps working.
 */
export function AddObsidianForm({
  existingIds,
  onAdded,
}: {
  existingIds: string[];
  onAdded: () => void;
}) {
  const [connector, setConnector] = useState<ConnectorDescriptor | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .connectors()
      .then((r) => {
        const rest = r.connectors.find((c) => c.kind === "obsidian-rest") ?? null;
        setConnector(rest);
        if (!rest) setErr("The obsidian-rest connector is not available in this build.");
      })
      .catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div className="banner banner-err">{err}</div>;
  if (!connector) return <SkeletonTable />;
  return (
    <ConnectorForm
      connector={connector}
      existingIds={existingIds}
      onAdded={onAdded}
      onCancel={() => {}}
    />
  );
}

/**
 * The unified WHAT I EXPOSE view. Joins three feeds:
 *   · connectors() — the catalog (secondary, on top).
 *   · sources()    — managed ConfiguredSource instances (+ live status).
 *   · capabilities() — entries, grouped under their source (derived when no
 *                      ConfiguredSource exists, so EVERY capability is reachable).
 * Sources render grouped by provenance tier (First-party / Managed / Extensions).
 */
function ExposeTab({
  caps,
  onChanged,
}: {
  caps: CapabilitiesResponse | null;
  onChanged: () => void;
}) {
  const [connectors, setConnectors] = useState<ConnectorDescriptor[]>([]);
  const [sources, setSources] = useState<SourceView[] | null>(null);
  const [detected, setDetected] = useState<DetectedSourceView[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Top-level EXPOSURE policy (Feature 3): id → exposed? + the in-flight toggle.
  const [exposure, setExposure] = useState<Map<string, boolean>>(new Map());
  const [exposureBusy, setExposureBusy] = useState<string | null>(null);

  const loadExposure = useCallback(() => {
    api
      .getExposure()
      .then((r) => setExposure(new Map(r.capabilities.map((c) => [c.id, c.enabled]))))
      .catch(() => setExposure(new Map()));
  }, []);

  // Machine-level source settings (v1: exec real-launch) — sourceId → state.
  const [launchSettings, setLaunchSettings] = useState<
    Map<string, { realLaunch: boolean; persisted: boolean | null; envActive: boolean }>
  >(new Map());
  const [launchBusy, setLaunchBusy] = useState<string | null>(null);
  const loadLaunchSettings = useCallback(() => {
    api
      .sourceSettings()
      .then((r) =>
        setLaunchSettings(
          new Map(
            r.sources.map((s) => [
              s.sourceId,
              { realLaunch: s.realLaunch, persisted: s.persisted, envActive: s.envActive },
            ]),
          ),
        ),
      )
      .catch(() => setLaunchSettings(new Map()));
  }, []);
  const toggleRealLaunch = async (sourceId: string, next: boolean) => {
    setLaunchBusy(sourceId);
    setErr(null);
    try {
      const r = await api.setSourceRealLaunch(sourceId, next);
      setLaunchSettings((prev) =>
        new Map(prev).set(sourceId, {
          realLaunch: r.realLaunch,
          persisted: r.persisted,
          envActive: prev.get(sourceId)?.envActive ?? false,
        }),
      );
    } catch (e) {
      setErr(String(e));
      loadLaunchSettings(); // reconcile on failure
    } finally {
      setLaunchBusy(null);
    }
  };

  const load = useCallback(() => {
    api
      .connectors()
      .then((r) => setConnectors(r.connectors))
      .catch((e) => setErr(String(e)));
    api
      .sources()
      .then((r) => setSources(r.sources))
      .catch((e) => setErr(String(e)));
    api
      .detectSources()
      .then((r) => setDetected(r.detected))
      .catch(() => setDetected([]));
    loadExposure();
    loadLaunchSettings();
  }, [loadExposure, loadLaunchSettings]);
  useEffect(load, [load]);

  const toggleExposure = async (id: string, next: boolean) => {
    setExposureBusy(id);
    setErr(null);
    // Optimistic flip so the switch responds immediately.
    setExposure((prev) => new Map(prev).set(id, next));
    try {
      const r = await api.setExposure(id, next);
      setExposure((prev) => new Map(prev).set(id, r.enabled));
      // The grant ledgers carry `topLevelDisabled` — refresh them across the app.
      onChanged();
    } catch (e) {
      setErr(String(e));
      loadExposure(); // reconcile on failure
    } finally {
      setExposureBusy(null);
    }
  };

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setErr(null);
    try {
      await fn();
      load();
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  // Capabilities grouped by source id.
  const capsBySource = useMemo(() => {
    const m = new Map<string, CapabilityEntry[]>();
    for (const e of caps?.entries ?? []) {
      const sid = sourceOf(e);
      const arr = m.get(sid) ?? [];
      arr.push(e);
      m.set(sid, arr);
    }
    return m;
  }, [caps]);

  // Provenance of a managed connector kind (for tier grouping of a ConfiguredSource).
  const connectorProvenance = useMemo(() => {
    const m = new Map<string, Provenance>();
    for (const c of connectors) m.set(c.kind, c.provenanceClass);
    return m;
  }, [connectors]);

  // Build the SOURCE node list: every ConfiguredSource + every capability source that
  // has no ConfiguredSource (derived → first-party module / live extension).
  interface SourceNode {
    id: string;
    label: string;
    kind: string;
    transport: string;
    provenance: Provenance;
    caps: CapabilityEntry[];
    src: SourceView | null;
    /**
     * The health to render for this node. For a ConfiguredSource it is `src.health`; for a DERIVED
     * source (no ConfiguredSource — notably a mesh-mounted `mesh:<workload>` source) it falls back
     * to the health STAMPED on its capabilities (mesh-health-reporting.md §6), so a mounted remote
     * cap shows its real reported status instead of "health unknown".
     */
    health?: CapabilityHealth;
  }
  const nodes = useMemo<SourceNode[]>(() => {
    const out: SourceNode[] = [];
    const seen = new Set<string>();
    for (const s of sources ?? []) {
      seen.add(s.id);
      const prov =
        connectorProvenance.get(s.kind) ??
        (RESERVED_FIRST_PARTY.has(s.id) ? "first-party" : "managed");
      out.push({
        id: s.id,
        label: s.label || s.id,
        kind: s.kind,
        transport: s.transport,
        provenance: prov,
        caps: capsBySource.get(s.id) ?? [],
        src: s,
        health: s.health,
      });
    }
    // Derived sources — a capability source with no ConfiguredSource (e.g. a mesh-mounted
    // `mesh:<workload>`). Its health is stamped onto its capabilities by the primary, so read it
    // from the first cap (mesh-health-reporting.md §6) — the fix for mounted caps showing "unknown".
    for (const [sid, list] of capsBySource) {
      if (seen.has(sid)) continue;
      const first = list[0];
      const prov: Provenance = first?.provenance ?? "extension";
      out.push({
        id: sid,
        label: sid,
        kind: first?.kind ?? "source",
        transport: first?.transport ?? "—",
        provenance: prov,
        caps: list,
        src: null,
        health: first?.health,
      });
    }
    return out;
  }, [sources, capsBySource, connectorProvenance]);

  const existingIds = (sources ?? []).map((s) => s.id);
  const totalCaps = caps?.entries.length ?? 0;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>What I expose</h2>
          <div className="meta">
            The sources Plexus exposes and the capabilities under each. Adding a source is a
            trusted, same-origin action — it registers immediately. Its capabilities stay
            default-denied until you grant them under <b>Who I trust</b>.
          </div>
          <div className="meta">
            Each capability has a top-level <b>exposure</b> switch (expand a source to reach it).
            Disabling makes it <b>invisible to every agent</b> — ungrantable and uninvokable even with
            a still-valid token — until you re-enable it.
          </div>
          <div className="meta">
            <b>{nodes.length}</b> {nodes.length === 1 ? "source" : "sources"} · <b>{totalCaps}</b>{" "}
            {totalCaps === 1 ? "capability" : "capabilities"}
            {caps ? <> · revision <b>{caps.revision}</b></> : null}
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={load}>
          Refresh
        </button>
      </div>

      {err && <div className="banner banner-err">{err}</div>}

      {/* SECONDARY: the connector catalog (collapsed by default; demoted). */}
      <ConnectorCatalog
        connectors={connectors}
        detected={detected}
        existingIds={existingIds}
        onAdded={() => {
          load();
          onChanged();
        }}
      />

      {/* PRIMARY: the instances grouped by provenance tier. */}
      {sources === null ? (
        <SkeletonTable />
      ) : nodes.length === 0 ? (
        <div className="empty">
          <div className="glyph">
            <IconSource width={20} height={20} />
          </div>
          <h3>No sources yet</h3>
          <p>
            Open <b>What Plexus can connect to</b> above and add a source — its capabilities will
            appear here grouped by tier, default-denied until you grant them.
          </p>
        </div>
      ) : (
        PROVENANCE_TIERS.map((tier) => {
          const tierNodes = nodes.filter((n) => n.provenance === tier);
          if (tierNodes.length === 0) return null;
          return (
            <div className="expose-tier" key={tier} data-provenance={tier}>
              <div className="expose-tier-head">
                <SourceClassBadge provenance={tier} />
                <span className="expose-tier-title">{TIER_LABEL[tier]}</span>
                <span className="expose-tier-blurb">{TIER_BLURB[tier]}</span>
              </div>
              <div className="ledger">
                {tierNodes.map((n) => (
                  <ExpandableSourceRow
                    key={n.id}
                    id={n.id}
                    label={n.label}
                    kind={n.kind}
                    transport={n.transport}
                    provenance={n.provenance}
                    caps={n.caps}
                    src={n.src}
                    health={n.health}
                    busy={busy === n.id}
                    exposure={exposure}
                    exposureBusy={exposureBusy}
                    onToggleExposure={toggleExposure}
                    launch={launchSettings.get(n.id)}
                    launchBusy={launchBusy === n.id}
                    onToggleRealLaunch={(next) => toggleRealLaunch(n.id, next)}
                    onEnable={() => act(n.id, () => api.enable(n.id))}
                    onDisable={() => act(n.id, () => api.disable(n.id))}
                    onRemove={() => act(n.id, () => api.removeSource(n.id))}
                  />
                ))}
              </div>
            </div>
          );
        })
      )}

      {/* cc-master / Claude Code is the first-party "Claude Code" connector in the
          catalog above (WHAT PLEXUS CAN CONNECT TO) with its loadCcMaster toggle —
          Plexus launches it headless with the embedded plugin; ~/.claude is untouched. */}
    </section>
  );
}

function SkeletonTable() {
  return (
    <div className="skeleton">
      {Array.from({ length: 4 }).map((_, i) => (
        <div className="sk-row" key={i} />
      ))}
    </div>
  );
}

// ── Agents-as-spine data model (REDESIGN §2.4 AGENTS) ───────────────────────────
/** One agent's per-caller trust view: standing grants + bundles + live tokens. */
interface AgentView {
  agentId: string;
  standing: StandingGrant[];
  bundles: BundleView[];
  tokens: ActiveToken[];
  /**
   * The agent's ENROLLMENT status (pending/active/revoked), merged from
   * `GET /admin/api/agents/enrollments`. `undefined` when there is no enrollment record
   * (an older / grants-only agent) — a SEPARATE dimension from live-session activity.
   */
  enrollment?: AgentEnrollmentStatus;
}

/**
 * Fold the flat per-(agent,cap) data back INTO an Agents view — the model's substance
 * is "give different agents, in different scenarios, different capability sets, each
 * independently authorized." Standing Grants (flat) + Task Grants (bundles) are the same
 * data re-cut; this groups them by caller, which is the mental model rendered.
 */
function buildAgentViews(
  grants: StandingGrant[],
  bundles: BundleView[],
  tokens: ActiveToken[],
  extra: string[],
  enrollments: readonly AgentEnrollment[] = [],
): AgentView[] {
  const ids = new Set<string>(extra);
  for (const g of grants) ids.add(g.agentId);
  for (const b of bundles) ids.add(b.agentId);
  for (const t of tokens) if (t.agentId) ids.add(t.agentId);
  // Include agents that are enrolled/provisioned but carry NO standing grant yet — e.g. a
  // pending agent whose requested caps all skipped (execute-only). Without this it would be
  // invisible, which is exactly the "created but not integrated" case we want surfaced.
  for (const e of enrollments) if (e.agentId) ids.add(e.agentId);
  return [...ids]
    .filter(Boolean)
    .sort()
    .map((agentId) => ({
      agentId,
      standing: grants.filter((g) => g.agentId === agentId && !g.bundleId),
      bundles: bundles.filter((b) => b.agentId === agentId),
      tokens: tokens.filter((t) => t.agentId === agentId),
      ...(enrollmentStatusFor(agentId, enrollments)
        ? { enrollment: enrollmentStatusFor(agentId, enrollments) }
        : {}),
    }));
}

// ── Connect an agent (WHO I TRUST setup — key paste OR install-integration) ──────
/**
 * R1 (the Owner refinement): installing the Plexus INTEGRATION *into* an agent — "let
 * cc/codex use Plexus" — is a *convenience*, tucked here under "Connect an agent", NOT a
 * core concept. EXPOSE (a source like cc-master) is the core concept and lives under
 * WHAT I EXPOSE ▸ Sources. This panel makes that distinction explicit.
 */
export function ConnectAgentPanel() {
  const [key, setKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api.connectionKey().then((r) => setKey(r.connectionKey)).catch(() => setKey(null));
  }, []);
  return (
    <div className="tile connect-agent">
      <div className="eyebrow">
        <IconPlug width={13} height={13} /> connect an agent · setup
      </div>
      <div className="lead">Let an AI tool use your capabilities</div>
      <div className="sub">
        An agent is a caller identity. The connection key is the trust boundary — anything holding it
        can talk to Plexus as any agent name. Two ways to connect:
      </div>

      <div className="connect-options">
        <div className="connect-opt">
          <div className="connect-opt-title">Install the Plexus integration into an agent</div>
          <div className="sub">
            A convenience: makes the local agent handshake with Plexus and read
            <code>~/.plexus/connection-key</code> — no manual paste. Use the
            <b> Connect an agent</b> guided install above to name the agent, pre-authorize its default
            capabilities, and get a one-click setup for Claude Code, Codex, OpenClaw, Hermes, or Tanka.
            (This installs Plexus INTO the agent; it is not the same as exposing a source.)
          </div>
        </div>

        <div className="connect-opt">
          <div className="connect-opt-title">…or paste the connection key manually</div>
          {key ? (
            <div className="key-row">
              <code>{key}</code>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  void navigator.clipboard?.writeText(key);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          ) : (
            <div className="sub">loading key…</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Guided-install wizard (D2-CONSOLE — the real "Connect an agent" flow) ────────
/**
 * The admin "Connect an agent" flow (agent-skill-compile §5, ADR-8). Three steps:
 *   1. IDENTIFY   — pick an agentId + agent-type (Claude Code bespoke vs Generic/other).
 *   2. PERMISSIONS — select capabilities from the LIVE catalog to grant as standing.
 *   3. PROVISION + INSTALL — `POST /admin/api/agents/connect` mints a one-time code and
 *      grants the cap-set, then (for Claude Code) `GET /integration/:agentId` returns the
 *      copy-able ONE-COMMAND install carrying a FRESH one-time code. We show which caps
 *      became `granted` (standing) vs `skipped` (with a short "why"), plus the install.
 *
 * This drives the real backend (unlike the earlier templated placeholder): the code is the
 * one-time enrollment secret (fine to show/copy — that's the point); the durable PAT is
 * never served and the admin connection-key is never displayed here.
 */
/**
 * A checkbox that can render the three DOM states — checked, unchecked, and the DOM-only
 * `indeterminate` (which React doesn't drive via props, so we set it on the element via a ref).
 * Used for the wizard's cascade checkboxes (top-level "Select all" + each group header); its
 * state is DERIVED from the selected-set upstream and its onChange cascades back into it.
 */
function TriStateCheckbox({
  state,
  onChange,
  ariaLabel,
}: {
  state: TriState;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "indeterminate";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={ariaLabel}
      checked={state === "checked"}
      // A click on an indeterminate box resolves to checked=true → cascade selects the group.
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

/**
 * The copy-able ONE-COMMAND install block (D1 deliver·P) — the shared "install view" used by
 * BOTH the Connect wizard's step 3 and the Agents tab's per-agent Re-integrate action, so the
 * two never drift. Renders the integration's one-command install (carrying a FRESH one-time
 * enrollment code minted on fetch) + a Copy button + a Re-fetch (new code) button, and —
 * for the Re-integrate case — the granted cap-set (`showCaps`). Pure presentation: the caller
 * owns fetching + the copy/refetch state. Dismissal is the caller's concern too.
 */
function InstallCommandPanel({
  integration,
  agentId,
  copied,
  onCopy,
  onRefetch,
  refreshing,
  showCaps = false,
  onReissue,
  reissuing = false,
}: {
  integration: IntegrationResult;
  agentId: string;
  copied: string | null;
  onCopy: (text: string, label: string) => void;
  onRefetch: () => void;
  refreshing: boolean;
  showCaps?: boolean;
  /** Explicit "re-issue a one-time code" action (Bug A). When present + the agent is already
   *  enrolled, a SEPARATE button offers it — with a warning that it invalidates the credential. */
  onReissue?: () => void;
  reissuing?: boolean;
}) {
  // Already enrolled (a re-view that did NOT mint) vs. a fresh/pending install (carries a live code).
  // `reissued` means THIS fetch just minted a new code for an active agent → treat as a code install.
  const enrolled = !!integration.alreadyEnrolled && !integration.reissued;
  return (
    <div className="wizard-install">
      <div className="sub">
        {enrolled ? (
          <>
            This agent is <b>already enrolled</b> — its credential is live and untouched. Run this{" "}
            <b>one command</b> to re-install or update the Plexus plugin in Claude Code as{" "}
            <code>{agentId}</code>. It carries <b>no new code</b> and does not change enrollment.
          </>
        ) : (
          <>
            Run this <b>one command</b> to install the Plexus plugin into Claude Code as{" "}
            <code>{agentId}</code>. It carries a one-time enrollment code
            {integration.codeExpiresAt ? <> (expires {relativeWhen(integration.codeExpiresAt)})</> : null} —
            copy + run it once, then it's spent.
          </>
        )}
      </div>
      {showCaps && integration.capabilities.length > 0 && (
        <div className="connect-result-block">
          <span className="rel-label">granted caps ({integration.capabilities.length})</span>
          {integration.capabilities.map((id) => (
            <div className="agent-grant-row" key={id}>
              <code className="mono">{id}</code>
            </div>
          ))}
        </div>
      )}
      <div className="wizard-prompt">
        <pre className="json-block"><code>{integration.installCommand}</code></pre>
        <div className="wizard-actions">
          <button className="btn btn-primary btn-sm" onClick={() => onCopy(integration.installCommand, "install")}>
            {copied === "install" ? "Copied" : "Copy install command"}
          </button>
          {enrolled ? (
            onReissue ? (
              <button
                className="btn btn-ghost btn-sm"
                disabled={reissuing}
                onClick={onReissue}
                title="Mint a NEW one-time code (lost PAT / clean re-install). This INVALIDATES the agent's current credential — it must re-install with the new code."
              >
                {reissuing ? "Re-issuing…" : "Re-issue one-time code"}
              </button>
            ) : null
          ) : (
            <button className="btn btn-ghost btn-sm" disabled={refreshing} onClick={onRefetch}>
              {refreshing ? "Re-minting…" : "Re-fetch (new code)"}
            </button>
          )}
        </div>
      </div>
      {enrolled && (
        <div className="sub" style={{ marginTop: 6 }}>
          Need a fresh code (lost credential / clean re-install)? Use <b>Re-issue one-time code</b> —
          it invalidates this agent's current credential, so it must re-install afterwards.
        </div>
      )}
    </div>
  );
}

/**
 * The grouped, cascading capability multi-select shared by the Connect-an-agent wizard
 * (step 2) and the per-agent inline "Grant a capability…" picker. Renders the
 * `.wizard-caps-groups` surface: a top-level "Select all" cascade + one collapsible
 * `.wizard-cap-group` per source, each with a tri-state group cascade. Selection lives in
 * the caller's `selected` set (authoritative); this component only derives the tri-states
 * and mutates via `setSelected`. Collapse state is likewise the caller's — it hides rows,
 * never touches selection.
 */
function CapGroupsPicker({
  groups,
  allIds,
  selected,
  setSelected,
  collapsed,
  toggleCollapsed,
}: {
  groups: CapGroup[];
  allIds: string[];
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  collapsed: Set<string>;
  toggleCollapsed: (key: string) => void;
}) {
  const toggleCap = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="wizard-caps-groups">
      {/* Top-level cascade — selects/clears every grantable cap across all groups. */}
      <label className="wizard-caps-all">
        <TriStateCheckbox
          ariaLabel="select all capabilities"
          state={triStateFor(allIds, selected)}
          onChange={(on) => setSelected(cascadeSelection(selected, allIds, on))}
        />
        <span className="wizard-caps-all-label">Select all</span>
        <span className="meta">
          {selected.size} of {allIds.length} selected · {groups.length}{" "}
          {groups.length === 1 ? "source" : "sources"}
        </span>
      </label>

      {groups.map((g) => {
        const ids = g.entries.map((e) => e.id);
        const groupSelected = ids.filter((id) => selected.has(id)).length;
        const isCollapsed = collapsed.has(g.key);
        return (
          <section className="wizard-cap-group" key={g.key} data-collapsed={isCollapsed || undefined}>
            <div className="wizard-cap-group-head">
              <label className="wizard-cap-group-check">
                {/* Group cascade — tri-state over just this source's caps. */}
                <TriStateCheckbox
                  ariaLabel={`select all ${g.label} capabilities`}
                  state={triStateFor(ids, selected)}
                  onChange={(on) => setSelected(cascadeSelection(selected, ids, on))}
                />
                <span className="wizard-cap-group-title">{g.label}</span>
                <span className="wizard-cap-group-id mono">{g.key}</span>
              </label>
              <span className="wizard-cap-group-count meta">{groupSelected}/{ids.length}</span>
              <button
                type="button"
                className="btn btn-ghost wizard-cap-group-toggle"
                aria-expanded={!isCollapsed}
                aria-label={isCollapsed ? `expand ${g.label}` : `collapse ${g.label}`}
                onClick={() => toggleCollapsed(g.key)}
              >
                {isCollapsed ? "▸" : "▾"}
              </button>
            </div>
            {!isCollapsed && (
              <div className="wizard-cap-group-body">
                {g.entries.map((e) => (
                  <label className="wizard-cap" key={e.id} data-checked={selected.has(e.id) || undefined}>
                    <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggleCap(e.id)} />
                    <span className="wizard-cap-body">
                      <span className="wizard-cap-title">
                        <span className="name">{e.label}</span>
                        <span className="verbs">
                          {VERB_ORDER.filter((v) => e.grants.includes(v)).map((v) => (
                            <VerbStamp key={v} verb={v} />
                          ))}
                        </span>
                        <SensitivityPill sensitivity={e.sensitivity} />
                      </span>
                      <span className="wizard-cap-id mono">{e.id}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function GuidedInstallWizard({
  caps,
  onChanged,
}: {
  caps: CapabilitiesResponse | null;
  onChanged: () => void;
}) {
  const grantable = useMemo(
    () => (caps?.entries ?? []).filter((e) => e.grants.length > 0),
    [caps],
  );
  // Step 2's grouped view: caps grouped by source, and the flat id-list (source of truth for
  // the top-level cascade). Both DERIVE from `grantable` — the selected-set stays authoritative.
  const capGroups = useMemo(() => groupCapabilities(grantable), [grantable]);
  const allGrantableIds = useMemo(() => grantable.map((e) => e.id), [grantable]);
  // Collapsed group keys (nice-to-have). Collapse only hides rows; it never touches selection.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapsed = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const entryById = useMemo(() => {
    const m = new Map<string, CapabilityEntry>();
    for (const e of caps?.entries ?? []) m.set(e.id, e);
    return m;
  }, [caps]);

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [agentId, setAgentId] = useState("");
  const [agentType, setAgentType] = useState<AgentType>("claude-code");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The admin-chosen trust-window for the standing grants (authoritative). Default 7d,
  // matching the Capabilities ledger default.
  const [twKind, setTwKind] = useState<TrustWindowKind>("7d");
  const [twCustomMs, setTwCustomMs] = useState<number>(7 * 86_400_000);

  const [copied, setCopied] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [connectResult, setConnectResult] = useState<ConnectAgentResult | null>(null);
  const [integration, setIntegration] = useState<IntegrationResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reset = () => {
    setStep(1);
    setAgentId("");
    setAgentType("claude-code");
    setSelected(new Set());
    setCollapsed(new Set());
    setTwKind("7d");
    setTwCustomMs(7 * 86_400_000);
    setConnectResult(null);
    setIntegration(null);
    setErr(null);
  };

  const copy = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 1600);
  };

  // Step 2 → 3: PROVISION the agent (mint code + grant cap-set standing), then — for the
  // bespoke Claude Code path — fetch the compiled one-command install.
  const provisionAndContinue = async () => {
    const id = agentId.trim();
    if (!id) {
      setErr("Give the agent an id first.");
      return;
    }
    setErr(null);
    setProvisioning(true);
    setConnectResult(null);
    setIntegration(null);
    try {
      const body = buildConnectBody(
        id,
        agentType,
        [...selected],
        makeTrustWindow(twKind, twCustomMs),
      );
      const connected = await api.connectAgent(body);
      setConnectResult(connected);
      // Bespoke: compile + fetch the copy-able one-command install (fresh one-time code).
      if (agentType === "claude-code") {
        try {
          const integ = await api.integration(id);
          setIntegration(integ);
        } catch (e) {
          // Provisioning already succeeded; surface the install-fetch failure without losing
          // the grant/code result (the manual enrollment coordinates are still shown).
          setErr(`Provisioned, but fetching the install command failed: ${String(e)}`);
        }
      }
      onChanged();
      setStep(3);
    } catch (e) {
      setErr(String(e));
    } finally {
      setProvisioning(false);
    }
  };

  // Re-mint a FRESH one-time code + install (codes are single-use; each GET supersedes the
  // prior un-redeemed one). Used when the shown code may have been used or expired.
  const refetchInstall = async () => {
    const id = agentId.trim();
    if (!id) return;
    setRefreshing(true);
    setErr(null);
    try {
      const integ = await api.integration(id);
      setIntegration(integ);
    } catch (e) {
      setErr(String(e));
    } finally {
      setRefreshing(false);
    }
  };

  if (!open) {
    return (
      <div className="composer-collapsed">
        <button className="btn btn-primary btn-sm" onClick={() => { reset(); setOpen(true); }}>
          + Connect an agent
        </button>
        <span className="meta">
          Provision an agent: name it, pick its agent-type, grant a starting cap-set, and get a
          copy-able one-command install (Claude Code) or its enrollment coordinates.
        </span>
      </div>
    );
  }

  const grantedCaps = connectResult?.granted ?? [];
  const skippedCaps = connectResult?.skipped ?? [];

  return (
    <div className="composer wizard">
      <div className="composer-head">
        <h3>Connect an agent</h3>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>

      {/* Stepper */}
      <ol className="wizard-steps" aria-label="connect steps">
        {[
          { n: 1, label: "Identify" },
          { n: 2, label: "Capabilities" },
          { n: 3, label: "Install" },
        ].map((s) => (
          <li key={s.n} className="wizard-step" data-active={step === s.n || undefined} data-done={step > s.n || undefined}>
            <span className="wizard-step-n">{step > s.n ? "✓" : s.n}</span>
            <span className="wizard-step-label">{s.label}</span>
          </li>
        ))}
      </ol>

      {err && <div className="banner banner-err">{err}</div>}

      {/* STEP 1 — identify: agentId + agent-type */}
      {step === 1 && (
        <div className="wizard-body">
          <div className="sub">
            Pick an id for the agent you're connecting. It's a self-asserted caller label — the
            connection key is the real trust boundary — so make it memorable (e.g. <code>research-bot</code>).
          </div>
          <label className="tw-label" htmlFor="wizard-agent">Agent id</label>
          <input
            id="wizard-agent"
            className="agent-input"
            value={agentId}
            spellCheck={false}
            autoComplete="off"
            placeholder="e.g. research-bot"
            onChange={(e) => setAgentId(e.target.value)}
          />
          <div className="wizard-integrator">
            <label className="tw-label" htmlFor="wizard-agent-type">Agent type</label>
            <Dropdown
              id="wizard-agent-type"
              value={agentType}
              ariaLabel="agent type"
              onChange={(v) => setAgentType(v as AgentType)}
              options={AGENT_TYPES}
            />
          </div>
          <div className="sub">
            {agentType === "claude-code" ? (
              <>Claude Code gets a <b>bespoke plugin</b>: its granted cap-set is compiled into a
              plugin you install with one command.</>
            ) : (
              <>A generic agent is provisioned the same way — a one-time code + standing grants —
              but delivered as raw <b>enrollment coordinates</b> for any agent to redeem.</>
            )}
          </div>
          <div className="wizard-actions">
            <button
              className="btn btn-primary btn-sm"
              disabled={!agentId.trim()}
              onClick={() => { setErr(null); setStep(2); }}
            >
              Next: capabilities →
            </button>
          </div>
        </div>
      )}

      {/* STEP 2 — select capabilities to grant as standing + the trust-window */}
      {step === 2 && (
        <div className="wizard-body">
          <div className="sub">
            Check the capabilities to grant <code>{agentId.trim() || "this agent"}</code> as <b>standing</b>.
            They become usable the moment it connects — everything else stays default-denied until you
            approve it. (Execute / high-sensitivity capabilities can't be standing; they'll be approved
            per-use and appear under <em>skipped</em> after provisioning.)
          </div>
          {grantable.length === 0 ? (
            <div className="row-note">No grantable capabilities yet — connect a source under What I expose first.</div>
          ) : (
            <CapGroupsPicker
              groups={capGroups}
              allIds={allGrantableIds}
              selected={selected}
              setSelected={setSelected}
              collapsed={collapsed}
              toggleCollapsed={toggleCollapsed}
            />
          )}
          <div className="wizard-integrator">
            <TrustWindowPicker
              value={twKind}
              customMs={twCustomMs}
              disabled={provisioning}
              onChange={(k, ms) => { setTwKind(k); setTwCustomMs(ms); }}
            />
          </div>
          <div className="wizard-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => setStep(1)}>← Back</button>
            <span className="meta">{selected.size} selected</span>
            <button className="btn btn-primary btn-sm" disabled={provisioning} onClick={provisionAndContinue}>
              {provisioning ? "Provisioning…" : "Provision + get install →"}
            </button>
          </div>
        </div>
      )}

      {/* STEP 3 — provisioned: granted/skipped + the copy-able one-command install */}
      {step === 3 && connectResult && (
        <div className="wizard-body">
          <div className="banner banner-ok">
            <IconCheck width={15} height={15} /> Provisioned <code>{connectResult.agentId}</code>
            {connectResult.agentType ? <> ({connectResult.agentType})</> : null} — {grantedCaps.length}{" "}
            standing grant{grantedCaps.length === 1 ? "" : "s"}
            {skippedCaps.length ? <>, {skippedCaps.length} skipped</> : null}.
          </div>

          {/* GRANTED — the caps that became standing. */}
          {grantedCaps.length > 0 && (
            <div className="connect-result-block">
              <span className="rel-label">granted (standing)</span>
              {grantedCaps.map((g) => (
                <div className="agent-grant-row" key={g.capabilityId}>
                  <code className="mono">{g.capabilityId}</code>
                  <span className="verbs">
                    {VERB_ORDER.filter((v) => g.verbs.includes(v)).map((v) => (
                      <VerbStamp key={v} verb={v} />
                    ))}
                  </span>
                  <span className="row-note"> · {trustWindowLabel(g.trustWindow)}</span>
                </div>
              ))}
            </div>
          )}

          {/* SKIPPED — requested caps that did NOT become standing, each with a short "why". */}
          {skippedCaps.length > 0 && (
            <div className="connect-result-block">
              <span className="rel-label">skipped (approved per-use, not standing)</span>
              {skippedCaps.map((id) => (
                <div className="agent-grant-row" key={id} data-disabled>
                  <code className="mono">{id}</code>
                  <span className="row-note"> — {explainSkipped(id, entryById.get(id))}</span>
                </div>
              ))}
            </div>
          )}

          {/* INSTALL — bespoke (Claude Code) one-command install, or generic enrollment coords. */}
          {agentType === "claude-code" ? (
            integration ? (
              <InstallCommandPanel
                integration={integration}
                agentId={connectResult.agentId}
                copied={copied}
                onCopy={copy}
                onRefetch={refetchInstall}
                refreshing={refreshing}
              />
            ) : (
              <div className="sub">
                Provisioned — but no install command was returned. Use <b>Re-fetch</b> to mint a fresh
                one, or check that the agent still has exposed standing grants.
                <div className="wizard-actions">
                  <button className="btn btn-primary btn-sm" disabled={refreshing} onClick={refetchInstall}>
                    {refreshing ? "Re-minting…" : "Re-fetch install"}
                  </button>
                </div>
              </div>
            )
          ) : (
            <div className="wizard-install">
              <div className="sub">
                Point your agent at Plexus with these <b>enrollment coordinates</b>. The code is one-time
                {connectResult.expiresAt ? <> (expires {relativeWhen(connectResult.expiresAt)})</> : null} —
                redeem it once at the enroll URL to receive a durable token.
              </div>
              <div className="wizard-creds">
                <div className="key-row">
                  <span className="tw-label">Enroll URL</span>
                  <code>{connectResult.enrollUrl}</code>
                  <button className="btn btn-ghost btn-sm" onClick={() => copy(connectResult.enrollUrl, "enroll")}>
                    {copied === "enroll" ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="key-row">
                  <span className="tw-label">Handshake URL</span>
                  <code>{connectResult.handshakeUrl}</code>
                  <button className="btn btn-ghost btn-sm" onClick={() => copy(connectResult.handshakeUrl, "handshake")}>
                    {copied === "handshake" ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="key-row">
                  <span className="tw-label">One-time code</span>
                  <code>{connectResult.code}</code>
                  <button className="btn btn-primary btn-sm" onClick={() => copy(connectResult.code, "code")}>
                    {copied === "code" ? "Copied" : "Copy code"}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="wizard-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => setStep(2)}>← Back</button>
            <button className="btn btn-primary btn-sm" onClick={() => { setOpen(false); }}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── AGENTS — the new spine (trust seen per-caller). ─────────────────────────────
function AgentsTab({
  onChanged,
  caps,
  knownAgents,
  go,
}: {
  onChanged: () => void;
  caps: CapabilitiesResponse | null;
  knownAgents: string[];
  go: Navigate;
}) {
  const [grants, setGrants] = useState<StandingGrant[] | null>(null);
  const [bundles, setBundles] = useState<BundleView[]>([]);
  const [tokens, setTokens] = useState<ActiveToken[]>([]);
  const [enrollments, setEnrollments] = useState<AgentEnrollment[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Per-agent Re-integrate ("reopen the install view") state. `integrateFor` is the agentId
  // whose install panel is open (dismissable), fetched fresh via `api.integration` (which
  // mints a NEW one-time code each call). Kept local so it never disturbs the rest of the tab.
  const [integrateFor, setIntegrateFor] = useState<string | null>(null);
  const [integration, setIntegration] = useState<IntegrationResult | null>(null);
  const [integrating, setIntegrating] = useState(false);
  const [integrateErr, setIntegrateErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reissuing, setReissuing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // Per-agent "Grant a capability…" inline picker (agent-skill-compile §grant-append). Toggled
  // open under one agent card at a time (like `integrateFor`). It grants ADDITIONAL standing
  // caps to an ALREADY-connected agent via `api.issueGrants` (NOT connect — connect would
  // re-mint a one-time code and de-enroll the live agent). `grantSelected` is the authoritative
  // checked-set; `grantCollapsed` only hides group rows.
  const [grantFor, setGrantFor] = useState<string | null>(null);
  const [grantSelected, setGrantSelected] = useState<Set<string>>(new Set());
  const [grantCollapsed, setGrantCollapsed] = useState<Set<string>>(new Set());
  const [grantTwKind, setGrantTwKind] = useState<TrustWindowKind>("7d");
  const [grantTwCustomMs, setGrantTwCustomMs] = useState<number>(7 * 86_400_000);
  const [granting, setGranting] = useState(false);
  const [grantErr, setGrantErr] = useState<string | null>(null);
  const toggleGrantCollapsed = (key: string) =>
    setGrantCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // The console's grant-requiring catalog (caps with ≥1 verb) — the same source the
  // Connect-an-agent wizard's step-2 picker draws from.
  const grantableCaps = useMemo(
    () => (caps?.entries ?? []).filter((e) => e.grants.length > 0),
    [caps],
  );

  const load = useCallback(() => {
    api.grants().then((r) => setGrants(r.grants)).catch((e) => setErr(String(e)));
    api.bundles().then((r) => setBundles(r.bundles)).catch(() => setBundles([]));
    api.tokens().then((r) => setTokens(r.tokens)).catch(() => setTokens([]));
    api.agentEnrollments().then((r) => setEnrollments(r.agents)).catch(() => setEnrollments([]));
  }, []);
  useEffect(load, [load]);

  const agents = useMemo(
    () => buildAgentViews(grants ?? [], bundles, tokens, knownAgents, enrollments),
    [grants, bundles, tokens, knownAgents, enrollments],
  );

  const copy = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 1600);
  };

  // Re-integrate: reopen the install view for an already-provisioned agent. `api.integration` does
  // NOT de-enroll an already-active agent (Bug A) — its live PAT keeps working; the returned command
  // just re-materializes / re-registers the plugin. For a pending agent it mints a fresh code. Dismissable.
  const openIntegrate = async (agentId: string) => {
    dismissGrant();
    setIntegrateFor(agentId);
    setIntegration(null);
    setIntegrateErr(null);
    setIntegrating(true);
    try {
      setIntegration(await api.integration(agentId));
    } catch (e) {
      setIntegrateErr(String(e));
    } finally {
      setIntegrating(false);
    }
  };
  const refetchIntegrate = async () => {
    if (!integrateFor) return;
    setRefreshing(true);
    setIntegrateErr(null);
    try {
      setIntegration(await api.integration(integrateFor));
    } catch (e) {
      setIntegrateErr(String(e));
    } finally {
      setRefreshing(false);
    }
  };
  // EXPLICIT re-issue (Bug A): mint a NEW one-time code for an already-active agent. This RESETS the
  // enrollment row + INVALIDATES the agent's current credential, so it must re-install. Gated by a
  // confirm because it is destructive to the live credential.
  const reissueIntegrate = async () => {
    if (!integrateFor) return;
    const ok = window.confirm(
      `Re-issue a one-time code for '${integrateFor}'?\n\n` +
        `This INVALIDATES the agent's current credential — it will stop working until the agent ` +
        `re-installs with the new code.`,
    );
    if (!ok) return;
    setReissuing(true);
    setIntegrateErr(null);
    try {
      setIntegration(await api.integration(integrateFor, { reissue: true }));
    } catch (e) {
      setIntegrateErr(String(e));
    } finally {
      setReissuing(false);
    }
  };
  const dismissIntegrate = () => {
    setIntegrateFor(null);
    setIntegration(null);
    setIntegrateErr(null);
  };

  // Grant-append: open the inline picker for THIS agent (toggle), resetting its selection +
  // trust-window. Mutually exclusive with the install panel so only one panel shows at a time.
  const openGrant = (agentId: string) => {
    setGrantFor(agentId);
    setGrantSelected(new Set());
    setGrantCollapsed(new Set());
    setGrantTwKind("7d");
    setGrantTwCustomMs(7 * 86_400_000);
    setGrantErr(null);
    dismissIntegrate();
  };
  const dismissGrant = () => {
    setGrantFor(null);
    setGrantSelected(new Set());
    setGrantErr(null);
  };
  // Confirm: issue the checked caps as ADDITIONAL standing grants to this agent via the
  // correct `PUT /grants` path (issueGrants) — targeted with `agentId` so it lands on the real
  // agent WITHOUT re-minting an enrollment code (never `connectAgent`, which would de-enroll a
  // live agent). Execute / high-sensitivity caps are forced to "once" server-side (ADR-5), same
  // as the wizard. On success, refresh the tab + close the picker.
  const confirmGrant = async (agentId: string) => {
    const grants: Record<CapabilityId, "allow"> = {};
    for (const id of grantSelected) grants[id] = "allow";
    if (Object.keys(grants).length === 0) return;
    setGranting(true);
    setGrantErr(null);
    try {
      await api.issueGrants(grants, {
        agentId,
        trustWindow: makeTrustWindow(grantTwKind, grantTwCustomMs),
      });
      load();
      onChanged();
      dismissGrant();
    } catch (e) {
      setGrantErr(String(e));
    } finally {
      setGranting(false);
    }
  };

  const revokeGrant = async (g: StandingGrant) => {
    const key = `g::${g.agentId}::${g.capabilityId}`;
    setBusy(key);
    try {
      await api.revokeGrant(g.agentId, g.capabilityId);
      load();
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };
  const revokeBundle = async (bundleId: string) => {
    setBusy(`b::${bundleId}`);
    try {
      await api.revokeBundle(bundleId);
      load();
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };
  // Complete per-agent teardown (agent-skill-compile §3 step 4): the real
  // `POST /admin/api/agents/revoke` tombstones the enrollment/PAT, invalidates live
  // sessions, and removes standing grants + tokens in one call — nothing else touched.
  const revokeAgent = async (a: AgentView) => {
    setBusy(`all::${a.agentId}`);
    try {
      await api.revokeAgent(a.agentId);
      load();
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Agents</h2>
          <div className="meta">
            The spine of the model — trust seen per-caller. Each agent gets, in different scenarios,
            its own capability set, independently authorized. The connection key is the trust boundary
            (rotate it to revoke all).
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={load}>
          Refresh
        </button>
      </div>

      {err && <div className="banner banner-err">{err}</div>}

      {grants === null ? (
        <SkeletonTable />
      ) : agents.length === 0 ? (
        <div className="empty">
          <div className="glyph">
            <IconAgent width={20} height={20} />
          </div>
          <h3>No agents yet</h3>
          <p>
            Connect an agent below, then grant it a capability or compose a task grant — it will
            appear here with its standing trust, task grants, and live sessions.
          </p>
        </div>
      ) : (
        <div className="ledger">
          {agents.map((a) => {
            const liveTokens = a.tokens.length;
            const isOpen = expanded === a.agentId;
            // Enrollment status — a SEPARATE dimension from the live-session activity below.
            const eb = enrollmentBadge(a.enrollment);
            const isPending = a.enrollment === "pending";
            // Grant-append candidates for THIS agent: grantable caps it does NOT already hold
            // as a standing grant (computed from its standing list vs the catalog), grouped by
            // source for the shared picker.
            const notYetGranted = capsNotYetGranted(
              grantableCaps,
              a.standing.map((g) => g.capabilityId),
            );
            const grantGroups = groupCapabilities(notYetGranted);
            const grantAllIds = notYetGranted.map((e) => e.id);
            return (
              <div className="ledger-row agent-row" data-exposed={liveTokens > 0} key={a.agentId}>
                <div className="rail" aria-hidden />
                <div className="row-body">
                  <button
                    className="agent-summary"
                    onClick={() => setExpanded(isOpen ? null : a.agentId)}
                    aria-expanded={isOpen}
                  >
                    <span className="name">{a.agentId}</span>
                    {eb ? (
                      <span className={`badge ${eb.className}`} title={eb.title}>
                        {eb.label}
                      </span>
                    ) : null}
                    <span className="verbs">
                      <span className="verb" data-active={liveTokens > 0}>
                        {liveTokens > 0 ? `active now · ${liveTokens} token${liveTokens === 1 ? "" : "s"}` : "idle"}
                      </span>
                    </span>
                    <span className="meta">
                      {a.standing.length} grant{a.standing.length === 1 ? "" : "s"}
                      {a.bundles.length ? ` · ${a.bundles.length} bundle${a.bundles.length === 1 ? "" : "s"}` : ""}
                    </span>
                    <span className="agent-chevron" aria-hidden>{isOpen ? "▾" : "▸"}</span>
                  </button>

                  {isOpen && (
                    <div className="agent-detail">
                      {/* Active now — the demoted Tokens surface (REDESIGN §2.3): live
                          sessions, never a thing to manage. */}
                      {a.tokens.length > 0 && (
                        <div className="agent-block">
                          <span className="rel-label">active now</span>
                          {a.tokens.map((t) => (
                            <div className="agent-active-row" key={t.jti}>
                              {t.scopes.map((s) => s.id).join(", ") || "—"}{" "}
                              <span className="row-note">token {t.jti} · {relativeWhen(t.expiresAt)}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="agent-block">
                        <span className="rel-label">standing grants ({a.standing.length})</span>
                        {a.standing.length === 0 ? (
                          <div className="row-note">none</div>
                        ) : (
                          a.standing.map((g) => (
                            <div
                              className="agent-grant-row"
                              key={g.capabilityId}
                              data-disabled={g.topLevelDisabled || undefined}
                            >
                              <code className="mono">{g.capabilityId}</code>{" "}
                              {g.topLevelDisabled ? <DisabledBadge /> : null}
                              <span className="verbs">
                                {VERB_ORDER.filter((v) => g.verbs.includes(v)).map((v) => (
                                  <VerbStamp key={v} verb={v} />
                                ))}
                              </span>
                              {g.constraint ? (
                                <span className="synth"> ↳ only {constraintLabel(g.constraint)}</span>
                              ) : null}
                              <span className="row-note">
                                {" "}
                                {g.standing ? relativeWhen(g.expiresAt) : "once"} · {trustWindowLabel(g.trustWindow)}
                              </span>
                              <button
                                className="btn btn-danger btn-sm"
                                disabled={busy === `g::${g.agentId}::${g.capabilityId}`}
                                onClick={() => revokeGrant(g)}
                              >
                                {busy === `g::${g.agentId}::${g.capabilityId}` ? "…" : "Revoke"}
                              </button>
                            </div>
                          ))
                        )}
                      </div>

                      {a.bundles.length > 0 && (
                        <div className="agent-block">
                          <span className="rel-label">task grants ({a.bundles.length})</span>
                          {a.bundles.map((b) => (
                            <div className="agent-grant-row" key={b.bundleId}>
                              <span className="bundle-name">“{b.name}”</span>{" "}
                              <span className="row-note">{b.members.length} caps</span>
                              <button
                                className="btn btn-danger btn-sm"
                                disabled={busy === `b::${b.bundleId}`}
                                onClick={() => revokeBundle(b.bundleId)}
                              >
                                {busy === `b::${b.bundleId}` ? "…" : "Revoke bundle"}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="agent-actions">
                        {/* Re-integrate — reopen the install view. For an ACTIVE agent this does
                            NOT de-enroll it (Bug A): it re-materializes the plugin without a new
                            code; the live credential is untouched. Re-issuing a code is a SEPARATE,
                            explicit action inside the panel. Prominent for a `pending` agent. */}
                        <button
                          className={`btn btn-sm ${isPending ? "btn-primary" : "btn-ghost"}`}
                          disabled={integrating && integrateFor === a.agentId}
                          onClick={() =>
                            integrateFor === a.agentId ? dismissIntegrate() : openIntegrate(a.agentId)
                          }
                          title={
                            isPending
                              ? "This agent is provisioned but not yet installed — get its one-command install."
                              : "Reopen the install view — re-copy the one-command install. Does NOT change enrollment (the live credential keeps working)."
                          }
                        >
                          {integrating && integrateFor === a.agentId
                            ? "Compiling…"
                            : integrateFor === a.agentId
                              ? "Hide install"
                              : isPending
                                ? "Integrate"
                                : "Re-integrate"}
                        </button>
                        <button
                          className={`btn btn-sm ${grantFor === a.agentId ? "btn-primary" : "btn-ghost"}`}
                          disabled={granting && grantFor === a.agentId}
                          onClick={() =>
                            grantFor === a.agentId ? dismissGrant() : openGrant(a.agentId)
                          }
                          title="Grant one or more ADDITIONAL standing capabilities to this already-connected agent (no re-install)."
                        >
                          {grantFor === a.agentId ? "Hide grant" : "Grant a capability…"}
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => go("task-grants")}>
                          New task grant…
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => go("activity", { agent: a.agentId })}
                        >
                          Recent activity →
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          disabled={busy === `all::${a.agentId}`}
                          onClick={() => revokeAgent(a)}
                          title="Revoke this agent completely — enrollment, live sessions, and all standing grants"
                        >
                          {busy === `all::${a.agentId}` ? "Revoking…" : "Revoke agent"}
                        </button>
                      </div>

                      {/* Re-integrate install view — dismissable, scoped to this agent. */}
                      {integrateFor === a.agentId && (
                        <div className="agent-integrate">
                          <div className="agent-integrate-head">
                            <span className="rel-label">install / enrollment</span>
                            <button className="btn btn-ghost btn-sm" onClick={dismissIntegrate}>
                              Dismiss
                            </button>
                          </div>
                          {integrateErr && <div className="banner banner-err">{integrateErr}</div>}
                          {integrating ? (
                            <div className="sub">Compiling the install command…</div>
                          ) : integration ? (
                            <InstallCommandPanel
                              integration={integration}
                              agentId={a.agentId}
                              copied={copied}
                              onCopy={copy}
                              onRefetch={refetchIntegrate}
                              refreshing={refreshing}
                              onReissue={reissueIntegrate}
                              reissuing={reissuing}
                              showCaps
                            />
                          ) : null}
                        </div>
                      )}

                      {/* Grant-a-capability picker — dismissable, scoped to this agent. Grants
                          ADDITIONAL standing caps via issueGrants (no re-install / no new code). */}
                      {grantFor === a.agentId && (
                        <div className="agent-integrate">
                          <div className="agent-integrate-head">
                            <span className="rel-label">grant a standing capability</span>
                            <button className="btn btn-ghost btn-sm" onClick={dismissGrant}>
                              Dismiss
                            </button>
                          </div>
                          {grantErr && <div className="banner banner-err">{grantErr}</div>}
                          <div className="sub">
                            Grant <code>{a.agentId}</code> one or more <b>additional standing</b>{" "}
                            capabilities — usable the moment they're granted, no re-install. (Execute /
                            high-sensitivity capabilities can't be standing; they're approved per-use.)
                          </div>
                          {notYetGranted.length === 0 ? (
                            <div className="row-note">
                              This agent already holds all available capabilities.
                            </div>
                          ) : (
                            <>
                              <CapGroupsPicker
                                groups={grantGroups}
                                allIds={grantAllIds}
                                selected={grantSelected}
                                setSelected={setGrantSelected}
                                collapsed={grantCollapsed}
                                toggleCollapsed={toggleGrantCollapsed}
                              />
                              <div className="wizard-integrator">
                                <TrustWindowPicker
                                  value={grantTwKind}
                                  customMs={grantTwCustomMs}
                                  disabled={granting}
                                  onChange={(k, ms) => { setGrantTwKind(k); setGrantTwCustomMs(ms); }}
                                />
                              </div>
                              <div className="wizard-actions">
                                <span className="meta">{grantSelected.size} selected</span>
                                <button
                                  className="btn btn-primary btn-sm"
                                  disabled={granting || grantSelected.size === 0}
                                  onClick={() => confirmGrant(a.agentId)}
                                >
                                  {granting ? "Granting…" : "Grant selected →"}
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        <GuidedInstallWizard caps={caps} onChanged={onChanged} />
      </div>
      <div style={{ marginTop: 20 }}>
        <ConnectAgentPanel />
      </div>
    </section>
  );
}

// ── CREATE AN EXTENSION (R2 reserved affordance — a visible, disabled home) ──────
/**
 * The worked starter manifest — a local-rest "vault write" example mirroring
 * docs/extension-authoring.md §6. Pre-filled into the editor so the by-hand ("用嘴")
 * author has a valid, minimal contract to adapt rather than a blank page.
 */
const STARTER_MANIFEST = `{
  "manifest": "plexus-extension/0.1",
  "source": "my-vault",
  "label": "My local vault",
  "transport": "local-rest",
  "secrets": [{ "name": "my-vault-key", "attach": "bearer" }],
  "capabilities": [
    {
      "name": "notes.write",
      "kind": "capability",
      "label": "Write a note",
      "describe": "Create or overwrite the note at {path} with {content}. Use when saving content the user dictated.",
      "io": { "input": { "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string" } }, "required": ["path", "content"] } },
      "grants": ["write"],
      "transport": "local-rest",
      "route": {
        "baseUrl": "http://127.0.0.1:27123",
        "allowedHosts": ["127.0.0.1:27123"],
        "method": "PUT",
        "path": "/vault/{path}",
        "body": "{content}",
        "secret": { "name": "my-vault-key", "attach": "bearer" }
      }
    }
  ]
}`;

/**
 * Tiny, dependency-free markdown → React renderer for the authoring guide. Handles the
 * subset the guide uses (headings, fenced code, inline code, lists, paragraphs). Not a
 * general markdown engine — just enough to render the served contract readably.
 */
function renderGuideMarkdown(md: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  const lines = md.split("\n");
  let i = 0;
  let key = 0;
  const inline = (text: string): (string | JSX.Element)[] => {
    // Split on `inline code` spans only — keep it minimal + safe (no HTML injection).
    const parts = text.split(/(`[^`]+`)/g);
    return parts.map((p, idx) =>
      p.startsWith("`") && p.endsWith("`") ? (
        <code key={idx}>{p.slice(1, -1)}</code>
      ) : (
        p
      ),
    );
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        if (cur === undefined || cur.startsWith("```")) break;
        buf.push(cur);
        i++;
      }
      i++; // closing fence
      out.push(
        <pre className="guide-code" key={key++}>
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = (h[1] ?? "").length;
      const Tag = (`h${Math.min(level + 1, 6)}` as keyof JSX.IntrinsicElements);
      out.push(<Tag key={key++}>{inline(h[2] ?? "")}</Tag>);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\[\s?[xX ]?\s?\]/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (cur === undefined) break;
        if (!/^\s*[-*]\s+/.test(cur) && !/^\s*\[/.test(cur.trim())) break;
        items.push(cur.replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push(
        <ul key={key++}>
          {items.map((it, idx) => (
            <li key={idx}>{inline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Paragraph: gather consecutive non-empty, non-structural lines.
    const buf: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (cur === undefined) break;
      if (
        cur.trim() === "" ||
        cur.startsWith("```") ||
        /^#{1,4}\s/.test(cur) ||
        /^\s*[-*]\s+/.test(cur)
      ) {
        break;
      }
      buf.push(cur);
      i++;
    }
    out.push(<p key={key++}>{inline(buf.join(" "))}</p>);
  }
  return out;
}

/** Read-only "security surface" card — the "see what you're about to trust" projection. */
function SurfaceCard({ surface }: { surface: ExtensionSurface }) {
  return (
    <div className="ext-surface">
      <div className="ext-surface-head">
        <SourceClassBadge provenance="extension" />
        <span className="ext-surface-source mono">{surface.source}</span>
        <span className="ext-surface-label">{surface.label}</span>
        {surface.transportBacked ? (
          <span className="badge badge-source" data-provenance="managed" title="Backed by a live transport (cli / local-rest / ipc / stdio).">
            transport-backed
          </span>
        ) : (
          <span className="badge badge-source" title="No transport — skills / workflows only.">
            no transport
          </span>
        )}
      </div>

      <div className="ext-surface-grid">
        <div className="ext-surface-cell">
          <span className="ext-surface-cell-k">CLI bins</span>
          {surface.cliBins.length ? (
            <span className="ext-surface-bins">
              {surface.cliBins.map((b) => (
                <code key={b} className="ext-chip ext-chip-warn">
                  {b}
                </code>
              ))}
            </span>
          ) : (
            <span className="ext-surface-none">none</span>
          )}
        </div>
        <div className="ext-surface-cell">
          <span className="ext-surface-cell-k">REST hosts</span>
          {surface.restHosts.length ? (
            <span className="ext-surface-bins">
              {surface.restHosts.map((h) => (
                <code key={h} className="ext-chip ext-chip-warn">
                  {h}
                </code>
              ))}
            </span>
          ) : (
            <span className="ext-surface-none">loopback only</span>
          )}
        </div>
        <div className="ext-surface-cell">
          <span className="ext-surface-cell-k">Cross-source attach</span>
          {surface.crossSource.length ? (
            <span className="ext-surface-bins">
              {surface.crossSource.map((cs) => (
                <code key={cs.id} className="ext-chip ext-chip-warn" title={`reaches into: ${cs.sources.join(", ")}`}>
                  {cs.id} → {cs.sources.join(", ")}
                </code>
              ))}
            </span>
          ) : (
            <span className="ext-surface-none">none</span>
          )}
        </div>
      </div>

      <div className="ext-surface-caps">
        <span className="ext-surface-cell-k">Capabilities ({surface.capabilities.length})</span>
        <div className="ledger" style={{ marginTop: 8 }}>
          {surface.capabilities.map((cap) => (
            <div className="ext-cap-row" key={cap.id}>
              <span className="ext-cap-id mono">{cap.id}</span>
              <span className="ext-cap-label">{cap.label}</span>
              <span className="ext-cap-meta">
                <code className="ext-chip">{cap.kind}</code>
                <code className="ext-chip">{cap.transport}</code>
                {cap.verbs.length ? (
                  cap.verbs.map((v) => (
                    <code key={v} className="ext-chip ext-chip-verb">
                      {v}
                    </code>
                  ))
                ) : (
                  <span className="ext-surface-none">no verbs</span>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * "Create an extension" — the DEMOTED authoring panel (secondary to "What I expose").
 * It installs an integration: AUTHOR a manifest (paste / adapt the starter, with the
 * served authoring guide alongside) → PREVIEW the security surface (no commit) → CREATE
 * (human-approved commit, enabled only after a valid preview) → MANAGE live extensions
 * (list + remove). NL drafting lives in an external agent — this is the contract + the
 * paste-a-manifest + see-what-you-trust path.
 */
function ExtensionsTab() {
  const [manifestText, setManifestText] = useState<string>(STARTER_MANIFEST);
  const [parseError, setParseError] = useState<string | null>(null);

  // Preview state — the surface is the gate for Create.
  const [preview, setPreview] = useState<ExtensionPreviewResponse | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  // The exact manifest text the current preview was computed for — Create is only
  // enabled while the editor still matches a VALID preview (edit ⇒ must re-preview).
  const [previewedText, setPreviewedText] = useState<string | null>(null);

  const [createBusy, setCreateBusy] = useState(false);
  const [createDone, setCreateDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // The authoring guide (fetched on demand, expandable).
  const [guideOpen, setGuideOpen] = useState(false);
  const [guide, setGuide] = useState<string | null>(null);
  const [guideErr, setGuideErr] = useState<string | null>(null);

  // The live extension list (Manage).
  const [extensions, setExtensions] = useState<ExtensionListItem[] | null>(null);
  const [removeBusy, setRemoveBusy] = useState<string | null>(null);

  const loadExtensions = useCallback(() => {
    api
      .extensions()
      .then((r) => setExtensions(r.extensions))
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(loadExtensions, [loadExtensions]);

  const openGuide = () => {
    setGuideOpen((o) => !o);
    if (guide === null && guideErr === null) {
      api
        .authoringGuide()
        .then((md) => setGuide(md))
        .catch((e) => setGuideErr(String(e)));
    }
  };

  // Parse the editor JSON → manifest, surfacing parse errors inline (never crash).
  const parseManifest = (): ExtensionManifest | null => {
    try {
      const parsed = JSON.parse(manifestText) as ExtensionManifest;
      setParseError(null);
      return parsed;
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  const onEdit = (text: string) => {
    setManifestText(text);
    // Any edit invalidates a prior preview (so Create re-gates) + clears stale notices.
    setPreview(null);
    setPreviewedText(null);
    setCreateDone(null);
  };

  const runPreview = async () => {
    setErr(null);
    setCreateDone(null);
    const manifest = parseManifest();
    if (!manifest) return;
    setPreviewBusy(true);
    try {
      const res = await api.previewExtension(manifest);
      setPreview(res);
      setPreviewedText(manifestText);
    } catch (e) {
      setErr(String(e));
    } finally {
      setPreviewBusy(false);
    }
  };

  // Create is enabled only when the CURRENT editor text matches a VALID preview.
  const canCreate =
    !!preview && preview.valid && previewedText === manifestText && !previewBusy && !createBusy;

  const runCreate = async () => {
    if (!canCreate) return;
    setErr(null);
    setCreateDone(null);
    const manifest = parseManifest();
    if (!manifest) return;
    setCreateBusy(true);
    try {
      const res = await api.createExtension(manifest);
      if (!res.ok) {
        setErr(res.reason ?? "The extension could not be registered.");
        return;
      }
      setCreateDone(
        `Installed ${res.source} — ${res.registered.length} capability(ies) now discoverable under the Extensions tier (revision ${res.revision}).`,
      );
      // Refresh the live list; the new source now also shows in the ExposeTab tree.
      loadExtensions();
    } catch (e) {
      setErr(String(e));
    } finally {
      setCreateBusy(false);
    }
  };

  const removeExtension = async (source: string) => {
    if (!window.confirm(`Remove extension "${source}"? Its capabilities are unregistered and any grants purged.`)) {
      return;
    }
    setRemoveBusy(source);
    setErr(null);
    try {
      await api.removeExtension(source);
      loadExtensions();
    } catch (e) {
      setErr(String(e));
    } finally {
      setRemoveBusy(null);
    }
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Create an extension</h2>
          <div className="meta">
            Install an integration: author an <b>extension manifest</b> that wraps a CLI, a local REST
            host, or a workflow as a grantable source of your own. Installing makes its capabilities
            <i> discoverable</i> — they stay default-denied until you grant them under <b>Who I trust</b>.
            Natural-language drafting happens in your agent (codex / Claude Code); paste or adapt the
            manifest here, preview the surface, then install.
          </div>
        </div>
      </div>

      {err && <div className="banner banner-err">{err}</div>}

      {/* ── 1. AUTHOR ─────────────────────────────────────────────────────────── */}
      <div className="tile ext-author">
        <div className="eyebrow">
          <IconSpark width={13} height={13} /> author · manifest
        </div>
        <div className="sub">
          A starter <code>local-rest</code> manifest is pre-filled below. Edit it, or paste one your
          agent drafted. Secrets are referenced by <b>name</b> only — never paste secret values.
        </div>
        <button type="button" className="catalog-toggle" aria-expanded={guideOpen} onClick={openGuide} style={{ marginTop: 12 }}>
          <span className="caret" aria-hidden data-open={guideOpen}>
            ▸
          </span>
          Authoring guide — the manifest contract
        </button>
        {guideOpen && (
          <div className="ext-guide">
            {guideErr ? (
              <div className="banner banner-err">{guideErr}</div>
            ) : guide === null ? (
              <SkeletonTable />
            ) : (
              <div className="guide-md">{renderGuideMarkdown(guide)}</div>
            )}
          </div>
        )}
        <label className="field field-wide" style={{ marginTop: 12 }}>
          <span>manifest (JSON)</span>
          <textarea
            className="ext-editor"
            value={manifestText}
            onChange={(e) => onEdit(e.target.value)}
            spellCheck={false}
            rows={18}
            aria-label="extension manifest JSON"
          />
        </label>
        {parseError && (
          <div className="banner banner-err">
            JSON parse error: <span className="mono">{parseError}</span>
          </div>
        )}
        <div className="form-actions" style={{ justifyContent: "space-between" }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onEdit(STARTER_MANIFEST)}
            disabled={previewBusy || createBusy}
          >
            Reset to starter
          </button>
          <button className="btn btn-primary" type="button" onClick={runPreview} disabled={previewBusy || createBusy}>
            {previewBusy ? "Previewing…" : "Preview"}
          </button>
        </div>
      </div>

      {/* ── 2. PREVIEW — the security surface (the "see what you trust" step) ──── */}
      {preview && (
        <div className="tile ext-preview">
          <div className="eyebrow">
            <IconShield width={13} height={13} /> preview · security surface
          </div>
          {preview.valid ? (
            <div className="banner banner-ok">
              <IconCheck width={15} height={15} /> Valid manifest — review the surface below, then
              install.
            </div>
          ) : (
            <div className="banner banner-err">
              <b>Invalid manifest — install is blocked.</b>
              {preview.reasons.length ? (
                <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                  {preview.reasons.map((r, idx) => (
                    <li key={idx}>{r}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
          {preview.surface ? (
            <SurfaceCard surface={preview.surface} />
          ) : (
            <div className="banner banner-info">
              The surface could not be projected (the manifest is too malformed to read). Fix the
              reasons above and preview again.
            </div>
          )}

          {createDone && (
            <div className="banner banner-ok" style={{ marginTop: 12 }}>
              <IconCheck width={15} height={15} /> {createDone}
            </div>
          )}
          <div className="form-actions">
            <button className="btn btn-primary" type="button" onClick={runCreate} disabled={!canCreate}>
              {createBusy ? "Installing…" : "Create extension"}
            </button>
          </div>
          {preview.valid && previewedText !== manifestText && (
            <div className="meta" style={{ textAlign: "right", marginTop: 4 }}>
              Manifest changed since this preview — re-preview to enable install.
            </div>
          )}
        </div>
      )}

      {/* ── 3. MANAGE — live extension sources (list + remove) ─────────────────── */}
      <div className="ext-manage">
        <div className="expose-tier-head" style={{ marginTop: 8 }}>
          <SourceClassBadge provenance="extension" />
          <span className="expose-tier-title">Installed extensions</span>
          <span className="expose-tier-blurb">Live extension-provenance sources. Remove to unregister + purge grants.</span>
        </div>
        {extensions === null ? (
          <SkeletonTable />
        ) : extensions.length === 0 ? (
          <div className="empty">
            <div className="glyph">
              <IconSpark width={20} height={20} />
            </div>
            <h3>No extensions installed</h3>
            <p>
              Author + preview a manifest above, then install — it will appear here and under the
              <b> Extensions</b> tier in <b>What I expose</b>.
            </p>
          </div>
        ) : (
          <div className="ledger">
            {extensions.map((ext) => (
              <div className="ext-cap-row ext-manage-row" key={ext.source}>
                <span className="ext-cap-id mono">{ext.source}</span>
                <span className="ext-cap-label">{ext.label}</span>
                <span className="ext-cap-meta">
                  <span className="ext-surface-none">{ext.capabilities.length} cap(s)</span>
                  {ext.capabilities.slice(0, 4).map((id) => (
                    <code key={id} className="ext-chip">
                      {id}
                    </code>
                  ))}
                  {ext.capabilities.length > 4 ? (
                    <span className="ext-surface-none">+{ext.capabilities.length - 4} more</span>
                  ) : null}
                </span>
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  onClick={() => removeExtension(ext.source)}
                  disabled={removeBusy === ext.source}
                >
                  {removeBusy === ext.source ? "Removing…" : "Remove"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ── SETTINGS — connection key (rotate note) + the raw token list (Advanced). ─────
function SettingsTab() {
  const [showTokens, setShowTokens] = useState(false);
  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Settings</h2>
          <div className="meta">Connection key, advanced power-user surfaces.</div>
        </div>
      </div>

      <div className="tile">
        <div className="eyebrow">
          <IconKey width={13} height={13} /> connection key
        </div>
        <div className="lead">The trust boundary</div>
        <div className="sub">
          The connection key is what an agent presents to talk to Plexus. It is the trust boundary:
          anything holding it can act as any agent name. Rotating it revokes ALL standing grants
          (epoch-bound) — the nuclear stop. (Rotation lands with the desktop shell.)
        </div>
      </div>

      <div className="tile" style={{ marginTop: 16 }}>
        <div className="eyebrow">
          <IconToken width={13} height={13} /> advanced · raw tokens
        </div>
        <div className="cc-row">
          <div>
            <div className="lead">Active tokens (plumbing)</div>
            <div className="sub">
              A token is a short-lived (15-min) auto-refreshed view of a grant — you never manage it.
              Revealed here only for power users; the day-to-day surface is each agent&apos;s
              &ldquo;active now&rdquo;.
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowTokens((s) => !s)}>
            {showTokens ? "Hide raw tokens" : "Reveal raw tokens"}
          </button>
        </div>
      </div>

      {showTokens && (
        <div style={{ marginTop: 16 }}>
          <TokensTab />
        </div>
      )}
    </section>
  );
}

// ── OVERVIEW — the hub / dashboard (REDESIGN §5). ───────────────────────────────
function OverviewTab({
  caps,
  gateway,
  go,
  setupIncomplete = false,
  onResumeSetup,
}: {
  caps: CapabilitiesResponse | null;
  gateway: GatewayInfo | null;
  go: Navigate;
  /** True when onboarding was skipped but the runtime is still fresh (nudge it). */
  setupIncomplete?: boolean;
  /** Re-open onboarding from the nudge at the first unfinished step. */
  onResumeSetup?: (step: 0 | 1 | 2 | 3) => void;
}) {
  const [grants, setGrants] = useState<StandingGrant[]>([]);
  const [bundles, setBundles] = useState<BundleView[]>([]);
  const [tokens, setTokens] = useState<ActiveToken[]>([]);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [sources, setSources] = useState<SourceView[]>([]);
  // Expanded pulse rows — reveal request params + result inline (Feature 1).
  const [openPulse, setOpenPulse] = useState<Set<string>>(new Set());
  const togglePulse = (id: string) =>
    setOpenPulse((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const load = useCallback(() => {
    api.grants().then((r) => setGrants(r.grants)).catch(() => setGrants([]));
    api.bundles().then((r) => setBundles(r.bundles)).catch(() => setBundles([]));
    api.tokens().then((r) => setTokens(r.tokens)).catch(() => setTokens([]));
    api.pending().then((r) => setPending(r.pending)).catch(() => setPending([]));
    // Pull a wide audit window: the pulse shows the latest 8, the heatmap buckets
    // the whole window by day (≈12 weeks of "access over time").
    api.audit(500).then((r) => setEvents(r.events)).catch(() => setEvents([]));
    api.sources().then((r) => setSources(r.sources)).catch(() => setSources([]));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  const agents = useMemo(
    () => buildAgentViews(grants, bundles, tokens, []),
    [grants, bundles, tokens],
  );
  const activeAgents = agents.filter((a) => a.tokens.length > 0);
  const liveSources = sources.filter((s) => s.live);
  const offlineSources = sources.filter((s) => s.enabled && !s.live);
  // Per-source HEALTH roll-up for the Overview health card (HEALTH). Counts the loud
  // statuses; `unknown` stays quiet (not-yet-probed / no-op connectors don't alarm).
  const unavailableSources = sources.filter((s) => s.health?.status === "unavailable");
  const degradedSources = sources.filter((s) => s.health?.status === "degraded");
  const grantableCaps = (caps?.entries ?? []).filter((e) => e.grants.length > 0);
  const grantedCapIds = new Set(grants.map((g) => g.capabilityId));
  const grantedCount = grantableCaps.filter((e) => grantedCapIds.has(e.id)).length;
  const artifactCount = (caps?.entries ?? []).filter(
    (e) => e.kind === "skill" || e.kind === "workflow",
  ).length;
  const darkCaps = Math.max(0, grantableCaps.length - grantedCount);

  // The standing-grant ledger, folded by agent (drives Standing-trust tile).
  const trustedAgents = agents.filter((a) => a.standing.length > 0 || a.bundles.length > 0);
  const standingGrantCount = grants.filter((g) => !g.bundleId).length;
  const liveTokenCount = tokens.length;

  // Total count of things needing the human, for the headline number + accent.
  const needsCount = pending.length + offlineSources.length + (setupIncomplete ? 1 : 0);

  return (
    <section className="overview">
      <div className="section-head">
        <div>
          <h2>Overview</h2>
          <div className="meta">What Plexus is doing right now — and what you&apos;ve trusted.</div>
        </div>
        {gateway && (
          <span className="ov-gw" title={`Gateway bound at ${gateway.baseUrl}`}>
            <span className="dot" /> running
            {gateway.instance ? <> · <b>{gateway.instance}</b></> : null}
            {" "}· protocol {PLEXUS_PROTOCOL_VERSION}
          </span>
        )}
      </div>

      <div className="ov-grid">
        {/* ── ROW 1 — three balanced stat tiles: the glance. ───────────────── */}
        <button
          type="button"
          className="ov-stat"
          onClick={() => go("agents")}
          data-tone="active"
        >
          <div className="ov-stat-head">
            <span className="ov-stat-label">Active now</span>
            <IconAgent width={14} height={14} />
          </div>
          <div className="ov-stat-figure">
            <span className="ov-num" data-live={activeAgents.length > 0}>{activeAgents.length}</span>
            <span className="ov-stat-unit">
              of {agents.length} agent{agents.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="ov-stat-foot">
            {liveTokenCount > 0
              ? <>{liveTokenCount} live token{liveTokenCount === 1 ? "" : "s"} in flight</>
              : agents.length === 0
                ? "no agents connected yet"
                : "idle — no live tokens"}
          </div>
        </button>

        <button
          type="button"
          className="ov-stat"
          onClick={() => go(pending.length ? "approvals" : "expose")}
          data-tone="needs"
          data-alert={needsCount > 0}
        >
          <div className="ov-stat-head">
            <span className="ov-stat-label">Needs you</span>
            <IconInbox width={14} height={14} />
          </div>
          <div className="ov-stat-figure">
            <span className="ov-num" data-accent={needsCount > 0}>{needsCount}</span>
            <span className="ov-stat-unit">
              {needsCount === 1 ? "item" : "items"}
            </span>
          </div>
          <ul className="ov-needs">
            {setupIncomplete && (
              <li
                onClick={(ev) => {
                  ev.stopPropagation();
                  onResumeSetup?.(agents.length === 0 ? 1 : sources.length === 0 ? 2 : 3);
                }}
                data-flag="warn"
              >
                <span className="ov-needs-dot" /> finish setup
              </li>
            )}
            <li data-flag={pending.length > 0 ? "warn" : "ok"}>
              <span className="ov-needs-dot" />
              {pending.length} approval{pending.length === 1 ? "" : "s"} waiting
            </li>
            <li data-flag={offlineSources.length > 0 ? "warn" : "ok"}>
              <span className="ov-needs-dot" />
              {offlineSources.length} source{offlineSources.length === 1 ? "" : "s"} offline
            </li>
          </ul>
        </button>

        <button
          type="button"
          className="ov-stat"
          onClick={() => go("standing-grants")}
          data-tone="trust"
        >
          <div className="ov-stat-head">
            <span className="ov-stat-label">Standing trust</span>
            <IconShield width={14} height={14} />
          </div>
          <div className="ov-stat-figure">
            <span className="ov-num">{standingGrantCount + bundles.length}</span>
            <span className="ov-stat-unit">grants held</span>
          </div>
          <div className="ov-stat-foot">
            {standingGrantCount} standing · {bundles.length} task bundle{bundles.length === 1 ? "" : "s"}
            {trustedAgents.length > 0 && <> · {trustedAgents.length} agent{trustedAgents.length === 1 ? "" : "s"}</>}
          </div>
        </button>

        {/* ── ROW 2 — the hero: a scannable activity pulse that fills the page. ─ */}
        <div className="ov-card ov-pulse-card">
          <div className="ov-card-head">
            <div className="ov-card-title">Activity pulse</div>
            <button className="btn btn-ghost btn-sm" onClick={() => go("activity")}>
              Full activity →
            </button>
          </div>
          {events.length === 0 ? (
            <div className="ov-empty">
              <IconSpark width={18} height={18} />
              <p>Quiet for now. Handshakes, grants, tokens and capability invocations will stream in here as agents work.</p>
            </div>
          ) : (
            <ul className="ov-pulse">
              {events.slice(0, 8).map((e) => {
                const expandable = hasAuditIO(e);
                const isOpen = openPulse.has(e.id);
                return (
                  <li
                    key={e.id}
                    className="ov-pulse-row"
                    data-expandable={expandable || undefined}
                    data-open={isOpen || undefined}
                    onClick={expandable ? () => togglePulse(e.id) : undefined}
                    aria-expanded={expandable ? isOpen : undefined}
                  >
                    <span className="ov-pulse-time" title={new Date(e.at).toLocaleString()}>
                      {expandable && (
                        <span className="audit-caret" data-open={isOpen || undefined} aria-hidden>
                          ▸
                        </span>
                      )}
                      {relAgo(e.at)}
                    </span>
                    <span className="evt" data-grp={eventGroup(e.type)}>{eventLabel(e.type)}</span>
                    <span className="ov-pulse-agent">
                      {e.agentId ? <code className="mono">{e.agentId}</code> : <span className="ov-faint">system</span>}
                    </span>
                    <span className="ov-pulse-cap">
                      {e.capabilityId
                        ? <code className="mono">{e.capabilityId}</code>
                        : <span className="ov-faint">{e.verbs?.length ? e.verbs.join("/") : "—"}</span>}
                    </span>
                    <span className="ov-pulse-outcome">
                      {e.outcome
                        ? <span className="outcome" data-o={e.outcome}>{e.outcome}</span>
                        : <span className="ov-faint">—</span>}
                    </span>
                    {expandable && isOpen && (
                      <div className="ov-pulse-detail">
                        <AuditDetail event={e} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* ── ROW 2 sidekick — exposure health, dense + legible. ───────────── */}
        <div className="ov-card ov-health-card">
          <div className="ov-card-head">
            <div className="ov-card-title">Exposure health</div>
            <button className="btn btn-ghost btn-sm" onClick={() => go("expose")}>
              Sources →
            </button>
          </div>
          <div className="ov-metrics">
            <div className="ov-metric">
              <span className="ov-metric-n">{liveSources.length}<span className="ov-metric-sub">/{sources.length}</span></span>
              <span className="ov-metric-label">sources live</span>
              {/* Per-source HEALTH (HEALTH): unavailable is loud (red), degraded amber.
                  unknown stays quiet — no flag. */}
              {unavailableSources.length > 0 && (
                <span className="ov-metric-flag" data-flag="bad">{unavailableSources.length} unavailable</span>
              )}
              {degradedSources.length > 0 && (
                <span className="ov-metric-flag" data-flag="warn">{degradedSources.length} degraded</span>
              )}
              {unavailableSources.length === 0 && degradedSources.length === 0 && offlineSources.length > 0 && (
                <span className="ov-metric-flag" data-flag="warn">{offlineSources.length} offline</span>
              )}
            </div>
            <div className="ov-metric ov-metric-ring">
              <ProgressRing value={grantedCount} max={grantableCaps.length} size={48} tone="grant" />
              <div className="ov-metric-body">
                <span className="ov-metric-n">{grantedCount}<span className="ov-metric-sub">/{grantableCaps.length}</span></span>
                <span className="ov-metric-label">capabilities granted</span>
              </div>
              {darkCaps > 0 && (
                <span className="ov-metric-flag" data-flag="dim">{darkCaps} dark</span>
              )}
            </div>
            <div className="ov-metric">
              <span className="ov-metric-n">{artifactCount}</span>
              <span className="ov-metric-label">skills / workflows</span>
            </div>
          </div>
          {trustedAgents.length > 0 && (
            <div className="ov-trust-list">
              <span className="ov-trust-cap">trusted agents</span>
              {trustedAgents.slice(0, 4).map((a) => (
                <span className="ov-trust-chip" key={a.agentId} title={`${a.standing.length} standing · ${a.bundles.length} bundles`}>
                  <code className="mono">{a.agentId}</code>
                  <span className="ov-trust-count">{a.standing.length + a.bundles.length}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* ── ROW 3 — access over time: a GitHub-style audit heatmap. ───────── */}
        <div className="ov-card ov-heat-card">
          <div className="ov-card-head">
            <div className="ov-card-title">Access over time</div>
            <span className="ov-faint">last 12 weeks · audit events per day</span>
          </div>
          <ActivityHeatmap events={events} weeks={12} />
        </div>
      </div>
    </section>
  );
}

// ── Theme (light / dark) ────────────────────────────────────────────────────────
// The console is token-driven: a `data-theme` attribute on <html> swaps the whole
// palette (see styles.css). The choice persists per-origin in localStorage; dark is
// the default (and applied eagerly on module load to avoid a flash of the wrong theme).
type Theme = "light" | "dark";
const THEME_KEY = "plexus.theme.v1";

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* localStorage unavailable */
  }
  return "dark";
}

function applyTheme(t: Theme): void {
  document.documentElement.setAttribute("data-theme", t);
}

// Apply eagerly at import time so the first paint is already in the chosen theme.
applyTheme(readTheme());

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const set = (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* ignore */
    }
  };
  const isDark = theme === "dark";
  return (
    <div className="theme-toggle" role="group" aria-label="Color theme">
      <button
        type="button"
        className="theme-opt"
        data-on={!isDark || undefined}
        aria-pressed={!isDark}
        onClick={() => set("light")}
        title="Light theme"
      >
        <IconSun width={14} height={14} />
        <span>Light</span>
      </button>
      <button
        type="button"
        className="theme-opt"
        data-on={isDark || undefined}
        aria-pressed={isDark}
        onClick={() => set("dark")}
        title="Dark theme"
      >
        <IconMoon width={14} height={14} />
        <span>Dark</span>
      </button>
    </div>
  );
}

// ── Sidebar (the new IA spine — three bands; REDESIGN §2.2) ─────────────────────
interface NavItem {
  id: Section;
  label: string;
  icon: (p: { width?: number; height?: number }) => JSX.Element;
  count?: number;
  alert?: boolean;
}

function Sidebar({
  active,
  go,
  gateway,
  capCount,
  pendingCount,
  grantsCount,
}: {
  active: Section;
  go: Navigate;
  gateway: GatewayInfo | null;
  capCount: number;
  pendingCount: number;
  grantsCount: number;
}) {
  const bands: { band: string | null; items: NavItem[] }[] = [
    { band: null, items: [{ id: "overview", label: "Overview", icon: IconGrid }] },
    {
      band: "WHAT I EXPOSE",
      items: [
        // ONE primary entry — the unified sources→capabilities tree. The
        // "Create an extension" stub stays wired but DEMOTED below it.
        { id: "expose", label: "What I expose", icon: IconShield, count: capCount || undefined },
        { id: "extensions", label: "Create an extension", icon: IconSpark },
      ],
    },
    {
      band: "WHO I TRUST",
      items: [
        { id: "agents", label: "Agents", icon: IconAgent },
        { id: "approvals", label: "Approvals", icon: IconInbox, count: pendingCount || undefined, alert: pendingCount > 0 },
        { id: "task-grants", label: "Task Grants", icon: IconBundle },
        { id: "standing-grants", label: "Standing Grants", icon: IconGrants, count: grantsCount || undefined },
      ],
    },
    {
      band: "WHAT HAPPENED",
      items: [{ id: "activity", label: "Activity", icon: IconScroll }],
    },
  ];

  return (
    <aside className="sidebar" aria-label="sections">
      <div className="sidebar-head">
        <div className="brand">
          <div className="sigil" aria-hidden />
          <div>
            <h1>Plexus</h1>
            <div className="sidebar-status">
              <span className="dot" /> {gateway ? `running · v${gateway.version}` : "connecting…"}
            </div>
          </div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {bands.map((b, bi) => (
          <div className="nav-band" key={b.band ?? `band-${bi}`}>
            {b.band && <div className="nav-band-label">{b.band}</div>}
            {b.items.map((it) => {
              const Icon = it.icon;
              return (
                <button
                  key={it.id}
                  className={`nav-item ${active === it.id ? "active" : ""}`}
                  data-alert={it.alert || undefined}
                  onClick={() => go(it.id)}
                >
                  <Icon width={16} height={16} />
                  <span className="nav-label">{it.label}</span>
                  {it.count !== undefined && <span className="count">{it.count}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <ThemeToggle />
        <button
          className={`nav-item nav-foot ${active === "settings" ? "active" : ""}`}
          onClick={() => go("settings")}
        >
          <IconGear width={16} height={16} />
          <span className="nav-label">Settings</span>
        </button>
        <button className="nav-item nav-foot" onClick={() => go("agents")} title="Connect an agent — paste the connection key">
          <IconKey width={16} height={16} />
          <span className="nav-label">Connection key</span>
        </button>
      </div>
    </aside>
  );
}

// ── Connection-key gate ─────────────────────────────────────────────────────────
/**
 * The no-key safety net. When NO connection-key is resolvable (neither desktop IPC
 * nor localStorage) — e.g. a browser/dev user who clicked "Skip" on onboarding —
 * every gated admin call silently 401s with no visible way in. Rather than rely on the
 * lazy window.prompt, App surfaces THIS in-app gate by default: paste the key, we
 * VALIDATE it against a gated read before persisting, and re-surface it on any later
 * 401 (a wrong/stale key). A missing key takes precedence over onboarding.
 */
function KeyGate({ onConnected }: { onConnected: (key: string) => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const candidate = value.trim();
      if (!candidate || busy) return;
      setBusy(true);
      setError(null);
      try {
        // One lightweight gated read to confirm the key BEFORE persisting it. A raw
        // fetch (not the cached api client) so validation never recurses into this gate.
        const res = await fetch("/admin/api/exposure", {
          headers: { accept: "application/json", "X-Plexus-Connection-Key": candidate },
        });
        if (res.status === 401) {
          setError("Connection-key rejected — check and re-paste.");
          return;
        }
        if (!res.ok) {
          setError(`Could not verify the key (gateway returned ${res.status}).`);
          return;
        }
        onConnected(candidate);
      } catch {
        setError("Could not reach Plexus to verify the key.");
      } finally {
        setBusy(false);
      }
    },
    [value, busy, onConnected],
  );

  return (
    <div className="ob-overlay key-gate" role="dialog" aria-modal="true" aria-label="Connect to Plexus">
      <div className="ob-shell key-gate-shell">
        <header className="ob-head">
          <div className="ob-brand">
            <div className="ob-sigil" aria-hidden />
            <span>Connect to Plexus</span>
          </div>
        </header>
        <div className="ob-body">
          <div className="ob-step">
            <div className="ob-step-eyebrow">
              <IconKey width={14} height={14} /> connection key
            </div>
            <h2 className="ob-step-title">Paste your connection key</h2>
            <p className="ob-step-lead">
              The console manages Plexus with your <b>connection key</b>. The runtime prints it
              to the terminal it started in, and stores it at{" "}
              <code>$PLEXUS_HOME/connection-key</code> (default{" "}
              <code>~/.plexus/connection-key</code> — a custom <code>PLEXUS_HOME</code>, as
              demos and proxies use, keeps its own). Paste it once to continue.
            </p>

            <form onSubmit={submit}>
              <label className="field field-wide">
                <span>Connection key</span>
                <input
                  type="password"
                  autoFocus
                  value={value}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="paste connection key…"
                  onChange={(e) => {
                    setValue(e.target.value);
                    if (error) setError(null);
                  }}
                />
              </label>

              {error && (
                <div className="banner banner-err key-gate-err">
                  <IconShield width={15} height={15} /> {error}
                </div>
              )}

              <div className="ob-actions">
                <button className="btn btn-primary" type="submit" disabled={busy || !value.trim()}>
                  {busy ? "Connecting…" : "Connect"}
                </button>
              </div>
            </form>

            <div className="ob-caption">
              <IconKey width={13} height={13} /> The connection key is the trust boundary —
              anything holding it can talk to Plexus as any agent name.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── App shell ─────────────────────────────────────────────────────────────────
export function App() {
  const [section, setSection] = useState<Section>("overview");
  const [caps, setCaps] = useState<CapabilitiesResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [pendingCount, setPendingCount] = useState(0);
  const [grantsCount, setGrantsCount] = useState(0);
  const [knownAgents, setKnownAgents] = useState<string[]>([]);

  // ── Onboarding (P4) — the first-run flow. We show it as an overlay when the
  // runtime is FRESH (no agents/sources/grants) and the user hasn't dismissed it.
  // It never blocks the app: "Skip" / finish marks dismissed and drops to Overview;
  // any unfinished step re-surfaces as an Overview "Needs you" nudge (re-openable).
  const [fresh, setFresh] = useState<FreshState | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState<0 | 1 | 2 | 3>(0);

  // ── Connection-key gate — the no-key safety net. If NO key is resolvable (neither
  // desktop IPC nor localStorage), surface an in-app paste gate INSTEAD of silently
  // 401-ing — this takes precedence over the onboarding-dismissed flag. We also wire
  // the gate as the paste affordance (`setPasteKeyPrompt`) so even a lazily-triggered
  // key need shows this nice box, and re-open it on any 401 (a wrong/stale key).
  const [keyGateOpen, setKeyGateOpen] = useState(false);
  const pasteResolverRef = useRef<((key: string | null) => void) | null>(null);

  useEffect(() => {
    setPasteKeyPrompt(
      () =>
        new Promise<string | null>((resolve) => {
          pasteResolverRef.current = resolve;
          setKeyGateOpen(true);
        }),
    );
    setAuthFailureHandler(() => setKeyGateOpen(true));
    return () => {
      setAuthFailureHandler(null);
    };
  }, []);

  // Proactively check on mount whether a key is resolvable WITHOUT prompting; if not,
  // open the gate immediately rather than waiting for a lazy 401 that may never fire.
  useEffect(() => {
    let live = true;
    hasResolvableKey().then((ok) => {
      if (live && !ok) setKeyGateOpen(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const handleKeyConnected = useCallback((key: string) => {
    rememberManagementKey(key);
    const resolve = pasteResolverRef.current;
    pasteResolverRef.current = null;
    setKeyGateOpen(false);
    // Resolve any in-flight `managementKey()` paste prompt with the validated key, then
    // re-run the page's loaders now that gated calls will succeed.
    if (resolve) resolve(key);
    setRefreshKey((k) => k + 1);
  }, []);

  // Detect fresh state on mount + on each refresh bump. If fresh & not dismissed,
  // open onboarding automatically (first run).
  useEffect(() => {
    let live = true;
    detectFreshState().then((s) => {
      if (!live) return;
      setFresh(s);
      if (isFresh(s) && !dismissed) setOnboardingOpen(true);
    });
    return () => {
      live = false;
    };
  }, [refreshKey, dismissed]);

  const dismissOnboarding = useCallback(() => {
    try {
      localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
    setOnboardingOpen(false);
    setSection("overview");
  }, []);

  /** Re-open onboarding from an Overview "Needs you" nudge at a specific step. */
  const reopenOnboarding = useCallback((step: 0 | 1 | 2 | 3) => {
    setOnboardingStep(step);
    setOnboardingOpen(true);
  }, []);

  const loadCaps = useCallback(() => {
    api
      .capabilities()
      .then((c) => {
        setCaps(c);
        // A success CLEARS a prior failure — a mount-time 401 (fetched before the
        // human pasted the connection-key) must not linger after the key gate passes.
        setErr(null);
      })
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(loadCaps, [loadCaps, refreshKey]);

  // Standing-grant count (nav badge) + the known agent ids (target-agent pickers).
  const loadGrants = useCallback(() => {
    api
      .grants()
      .then((r) => {
        setGrantsCount(r.grants.filter((g) => !g.bundleId).length);
        setKnownAgents((prev) => {
          const ids = new Set([DEFAULT_AGENT_ID, ...prev, ...r.grants.map((g) => g.agentId)]);
          return [...ids].filter(Boolean);
        });
      })
      .catch(() => setGrantsCount(0));
  }, []);
  useEffect(loadGrants, [loadGrants, refreshKey]);

  // Fold in agent ids seen on pending requests so the picker offers real targets.
  useEffect(() => {
    api
      .pending()
      .then((r) => {
        const seen = r.pending.map((p) => p.agentId).filter((x): x is string => Boolean(x));
        if (seen.length === 0) return;
        setKnownAgents((prev) => [...new Set([DEFAULT_AGENT_ID, ...prev, ...seen])].filter(Boolean));
      })
      .catch(() => {});
  }, [refreshKey]);

  // Poll the pending-approvals count so the sidebar badge nudges the user.
  const loadPendingCount = useCallback(() => {
    api
      .pending()
      .then((r) => setPendingCount(r.pending.length))
      .catch(() => setPendingCount(0));
  }, []);
  useEffect(() => {
    loadPendingCount();
    const t = setInterval(loadPendingCount, 3000);
    return () => clearInterval(t);
  }, [loadPendingCount, refreshKey]);

  // An agent id to pre-seed the Activity tab's filter with on the next visit — set by a
  // "Recent activity →" jump, consumed + cleared by ActivityTab on mount.
  const [pendingActivityAgent, setPendingActivityAgent] = useState<string | null>(null);

  const bump = () => setRefreshKey((k) => k + 1);
  const go: Navigate = (s, opts) => {
    setPendingActivityAgent(opts?.agent ?? null);
    setSection(s);
  };

  // Whether the runtime is still fresh enough to nudge unfinished setup on Overview.
  const setupIncomplete = fresh ? isFresh(fresh) : false;

  return (
    <div className="app">
      {keyGateOpen && <KeyGate onConnected={handleKeyConnected} />}

      {onboardingOpen && !keyGateOpen && (
        <Onboarding
          initialStep={onboardingStep}
          onFinish={() => {
            dismissOnboarding();
            bump();
          }}
        />
      )}

      <Sidebar
        active={section}
        go={go}
        gateway={caps?.gateway ?? null}
        capCount={caps?.entries.length ?? 0}
        pendingCount={pendingCount}
        grantsCount={grantsCount}
      />

      <main className="content">
        {err && (
          <div className="banner banner-err">
            <IconInbox width={15} height={15} /> {err}
          </div>
        )}

        {section === "overview" && (
          <OverviewTab
            caps={caps}
            gateway={caps?.gateway ?? null}
            go={go}
            setupIncomplete={setupIncomplete && dismissed}
            onResumeSetup={reopenOnboarding}
          />
        )}
        {section === "expose" && <ExposeTab caps={caps} onChanged={bump} />}
        {section === "extensions" && <ExtensionsTab />}
        {section === "agents" && (
          <AgentsTab onChanged={bump} caps={caps} knownAgents={knownAgents} go={go} />
        )}
        {section === "approvals" && <PendingTab knownAgents={knownAgents} onResolved={bump} />}
        {section === "task-grants" && (
          <GrantsTab onChanged={bump} caps={caps} knownAgents={knownAgents} view="task" />
        )}
        {section === "standing-grants" && (
          <GrantsTab onChanged={bump} caps={caps} knownAgents={knownAgents} view="standing" />
        )}
        {section === "activity" && (
          <ActivityTab
            initialAgent={pendingActivityAgent}
            onConsumeInitialAgent={() => setPendingActivityAgent(null)}
          />
        )}
        {section === "settings" && <SettingsTab />}
      </main>
    </div>
  );
}
