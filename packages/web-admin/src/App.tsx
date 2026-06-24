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
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  api,
  type CapabilitiesResponse,
  type ActiveToken,
  type InstallResult,
  type PendingItem,
  type SourceView,
  type ConfiguredSource,
  type StandingGrant,
  type TrustWindow,
  type Provenance,
  type Sensitivity,
  type BundleView,
  type BundleMemberInput,
} from "./api.ts";
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
} from "./icons.tsx";

type Tab = "capabilities" | "sources" | "pending" | "grants" | "tokens" | "audit";

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

// ── Masthead ─────────────────────────────────────────────────────────────────
function Masthead({ gateway }: { gateway: GatewayInfo | null }) {
  return (
    <header className="masthead">
      <div className="brand">
        <div className="sigil" aria-hidden />
        <div>
          <h1>Plexus</h1>
          <div className="tagline">Local capability gateway · permission control</div>
        </div>
      </div>
      {gateway && (
        <div className="gw">
          <span className="live">
            <span className="dot" /> gateway online
          </span>
          <span>
            <b>{gateway.name}</b> v{gateway.version} · protocol {gateway.protocol}
          </span>
          <span>{gateway.baseUrl}{gateway.instance ? ` · ${gateway.instance}` : ""}</span>
        </div>
      )}
    </header>
  );
}

// ── Connection key tile ───────────────────────────────────────────────────────
function ConnectionKeyTile() {
  const [key, setKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api
      .connectionKey()
      .then((r) => setKey(r.connectionKey))
      .catch((e) => setErr(String(e)));
  }, []);
  return (
    <div className="tile">
      <div className="eyebrow">
        <IconKey width={13} height={13} /> connection key
      </div>
      <div className="lead">Bootstrap an agent session</div>
      <div className="sub">Paste this into an agent to handshake — user-paste delivery, no auto-grant.</div>
      {err && <div className="banner banner-err" style={{ marginTop: 12 }}>{err}</div>}
      {key && (
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
      )}
    </div>
  );
}

// ── cc-master install tile ────────────────────────────────────────────────────
function CcMasterTile({ onChanged }: { onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InstallResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const install = async () => {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const r = await api.installCcMaster();
      setResult(r);
      if (r.ok) onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tile">
      <div className="eyebrow">
        <IconPlug width={13} height={13} /> first-party adapter
      </div>
      <div className="cc-row">
        <div>
          <div className="lead">cc-master</div>
          <div className="sub">Optional orchestration plugin — audited install.</div>
        </div>
        <button className="btn btn-primary" onClick={install} disabled={busy}>
          {busy ? "Installing…" : "Install"}
        </button>
      </div>
      {err && <div className="banner banner-err" style={{ marginTop: 12 }}>{err}</div>}
      {result && (
        <div
          className={`banner ${result.ok ? "banner-ok" : "banner-info"}`}
          style={{ marginTop: 12 }}
        >
          {result.ok ? <IconCheck width={15} height={15} /> : null}
          {result.ok
            ? `Installed${result.installed ? ` — ${result.installed}` : ""}. Its capabilities now appear in the ledger.`
            : `Not installed — ${result.reason ?? (result.available ? "install failed" : "source unavailable")}.`}
        </div>
      )}
    </div>
  );
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
      <select
        id="tw-kind"
        className="tw-select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as TrustWindowKind, customMs)}
      >
        {TRUST_WINDOW_KINDS.map((k) => (
          <option key={k} value={k}>
            {TRUST_WINDOW_LABEL[k]}
          </option>
        ))}
      </select>
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
          <h2>Capability ledger</h2>
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
function PendingCard({
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
                <span className="agent-says-text empty">(agent gave no reason)</span>
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
          <h2>Pending approvals</h2>
          <div className="meta">
            Human-in-the-loop. An agent CANNOT grant write/execute or activate an extension without
            your approval here.
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
          Pre-authorize a whole task: pick an agent, add capabilities (with optional path/allowlist
          confinement) and context — approved once, no re-prompts within scope.
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
              <select
                className="tw-select"
                value={row.id}
                onChange={(e) => setRow(i, { id: e.target.value, verbs: [] })}
              >
                {grantable.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.id}
                  </option>
                ))}
              </select>
              <VerbMultiSelect
                available={entry?.grants ?? []}
                selected={row.verbs}
                onChange={(v) => setRow(i, { verbs: v })}
              />
              <select
                className="tw-select"
                value={row.cKind}
                onChange={(e) => setRow(i, { cKind: e.target.value as ComposerRow["cKind"] })}
                aria-label="constraint kind"
              >
                <option value="none">no constraint</option>
                <option value="pathPrefix">path under…</option>
                <option value="allow">field in…</option>
              </select>
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

// ── Grants tab — the standing-trust ledger (ADR-018, the primary trust surface) ─
function GrantsTab({
  onChanged,
  caps,
  knownAgents,
}: {
  onChanged: () => void;
  caps: CapabilitiesResponse | null;
  knownAgents: string[];
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

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Grants</h2>
          <div className="meta">
            The standing-trust ledger. A grant lets an agent use a capability (its verbs) until its
            trust window ends — Plexus won&apos;t re-ask before then. Revoke is the complete stop.
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

      <NewTaskGrantComposer
        caps={caps}
        knownAgents={knownAgents}
        onCreated={() => {
          load();
          onChanged();
        }}
      />

      {/* Task bundles — grouped members with a single Revoke bundle (AUTHZ-UX §2.N3). */}
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
                  <tr key={rowKey}>
                    <td>{g.agentId}</td>
                    <td>
                      <code className="mono">{g.capabilityId}</code>
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

function AuditTab() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .audit(300)
      .then((r) => setEvents(r.events))
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(load, [load]);

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Audit trail</h2>
          <div className="meta">Append-only, redacted. Every handshake, grant, token, invoke and revoke.</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={load}>
          Refresh
        </button>
      </div>

      {err && <div className="banner banner-err">{err}</div>}

      {events === null ? (
        <SkeletonTable />
      ) : events.length === 0 ? (
        <div className="empty">
          <div className="glyph">
            <IconScroll width={20} height={20} />
          </div>
          <h3>The ledger is clean</h3>
          <p>
            No events recorded yet. The moment an agent handshakes, is granted a scope, or invokes a
            capability, it lands here — timestamped and evidentiary.
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
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="t-time">{new Date(e.at).toLocaleTimeString()}</td>
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
              ))}
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

/** One configured-source row with live/enabled status + enable/disable/remove. */
function SourceRow({
  src,
  busy,
  onEnable,
  onDisable,
  onRemove,
}: {
  src: SourceView;
  busy: boolean;
  onEnable: () => void;
  onDisable: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="ledger-row" data-exposed={src.live} data-noexpose={!src.enabled}>
      <div className="rail" aria-hidden />
      <div className="row-body">
        <div className="row-title">
          <span className="name">{src.label || src.id}</span>
          <span className="badge badge-kind" data-kind={src.kind}>
            {src.kind}
          </span>
          <span className="badge badge-transport">{src.transport}</span>
          <span className="verbs">
            <span className="verb" data-active={src.live}>
              {src.live ? "live" : src.enabled ? "offline" : "disabled"}
            </span>
          </span>
        </div>
        <div className="row-id">{src.id}</div>
        <div className="row-describe">
          {src.liveCapabilityCount > 0
            ? `${src.liveCapabilityCount} ${src.liveCapabilityCount === 1 ? "capability" : "capabilities"} registered`
            : src.enabled
              ? "Enabled but no live capabilities — the source may be unreachable."
              : "Disabled — retained in config, not registered."}
          {src.route?.baseUrl ? <span className="row-note"> · {String(src.route.baseUrl)}</span> : null}
          {src.secretRef ? (
            <span className="row-note"> · key ref <code>{src.secretRef}</code></span>
          ) : null}
        </div>
      </div>
      <div className="row-controls">
        {src.enabled ? (
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
    </div>
  );
}

/** The Add-Obsidian (REST) form: base URL + API key → secret then source. */
function AddObsidianForm({
  existingIds,
  onAdded,
}: {
  existingIds: string[];
  onAdded: () => void;
}) {
  const [label, setLabel] = useState("Obsidian");
  const [baseUrl, setBaseUrl] = useState("https://127.0.0.1:27124");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setDone(null);
    if (!apiKey.trim()) {
      setErr("An API key is required for the Obsidian Local REST API.");
      return;
    }
    setBusy(true);
    try {
      // 1. Derive a stable id + a unique secret name from the label.
      let id = slug(label);
      if (existingIds.includes(id)) id = `${id}-${Date.now().toString(36).slice(-4)}`;
      const secretName = `${id}-rest-api-key`;
      // 2. Store the API key WRITE-ONLY in the secret store (never echoed back).
      await api.putSecret(secretName, apiKey.trim());
      // 3. Add the source referencing the key by NAME — never the value.
      const cfg: ConfiguredSource = {
        id,
        kind: "obsidian-rest",
        label: label.trim() || id,
        enabled: true,
        transport: "local-rest",
        route: { baseUrl: baseUrl.trim() },
        secretRef: secretName,
      };
      const res = await api.addSource(cfg);
      if (!res.ok) {
        setErr(res.reason ?? "The source could not be registered.");
        return;
      }
      setApiKey("");
      setDone(`Added “${cfg.label}” — ${res.registered.length} capability(ies) now discoverable.`);
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
        <IconPlug width={13} height={13} /> add obsidian · local REST API
      </div>
      <div className="sub">
        Connect a read-write Obsidian vault over loopback HTTPS. The API key is stored write-only in
        the local secret store and referenced by name — it never lands in <code>sources.json</code>.
      </div>
      <div className="form-grid">
        <label className="field">
          <span>Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Obsidian" />
        </label>
        <label className="field">
          <span>Base URL</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://127.0.0.1:27124"
            spellCheck={false}
          />
        </label>
        <label className="field field-wide">
          <span>API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="paste the Local REST API key"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>
      {err && <div className="banner banner-err" style={{ marginTop: 12 }}>{err}</div>}
      {done && (
        <div className="banner banner-ok" style={{ marginTop: 12 }}>
          <IconCheck width={15} height={15} /> {done}
        </div>
      )}
      <div className="form-actions">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add Obsidian source"}
        </button>
      </div>
    </form>
  );
}

function SourcesTab({ onChanged }: { onChanged: () => void }) {
  const [sources, setSources] = useState<SourceView[] | null>(null);
  const [detected, setDetected] = useState<unknown[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .sources()
      .then((r) => setSources(r.sources))
      .catch((e) => setErr(String(e)));
    api
      .detectSources()
      .then((r) => setDetected(r.detected))
      .catch(() => setDetected([]));
  }, []);
  useEffect(load, [load]);

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

  const existingIds = (sources ?? []).map((s) => s.id);

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Capability sources</h2>
          <div className="meta">
            Manage where capabilities come from. Adding a source here is a trusted, same-origin
            action — it registers immediately (no agent approval needed). Capabilities stay
            default-denied until you expose them in the ledger.
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={load}>
          Refresh
        </button>
      </div>

      {err && <div className="banner banner-err">{err}</div>}

      {detected.length > 0 && (
        <div className="banner banner-info" style={{ marginBottom: 16 }}>
          <IconSource width={15} height={15} /> {detected.length} source
          {detected.length === 1 ? "" : "s"} detected nearby. Use the form below to add one.
        </div>
      )}

      {sources === null ? (
        <SkeletonTable />
      ) : sources.length === 0 ? (
        <div className="empty">
          <div className="glyph">
            <IconSource width={20} height={20} />
          </div>
          <h3>No managed sources</h3>
          <p>
            You haven&apos;t added any capability sources yet. Connect an Obsidian vault below — its
            read/write capabilities will appear in the ledger, default-denied until you expose them.
          </p>
        </div>
      ) : (
        <div className="ledger">
          {sources.map((src) => (
            <SourceRow
              key={src.id}
              src={src}
              busy={busy === src.id}
              onEnable={() => act(src.id, () => api.enable(src.id))}
              onDisable={() => act(src.id, () => api.disable(src.id))}
              onRemove={() => act(src.id, () => api.removeSource(src.id))}
            />
          ))}
        </div>
      )}

      <div className="tile" style={{ marginTop: 20 }}>
        <AddObsidianForm
          existingIds={existingIds}
          onAdded={() => {
            load();
            onChanged();
          }}
        />
      </div>
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

// ── App shell ─────────────────────────────────────────────────────────────────
export function App() {
  const [tab, setTab] = useState<Tab>("capabilities");
  const [caps, setCaps] = useState<CapabilitiesResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [pendingCount, setPendingCount] = useState(0);
  const [grantsCount, setGrantsCount] = useState(0);
  const [knownAgents, setKnownAgents] = useState<string[]>([]);

  const loadCaps = useCallback(() => {
    api
      .capabilities()
      .then(setCaps)
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(loadCaps, [loadCaps, refreshKey]);

  // Standing-grant count (nav badge) + the known agent ids (target-agent pickers).
  const loadGrants = useCallback(() => {
    api
      .grants()
      .then((r) => {
        setGrantsCount(r.grants.length);
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

  // Poll the pending-approvals count so the badge nudges the user to the tab.
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

  const bump = () => setRefreshKey((k) => k + 1);

  return (
    <div className="app">
      <Masthead gateway={caps?.gateway ?? null} />

      <div className="trust-strip">
        <ConnectionKeyTile />
        <CcMasterTile onChanged={bump} />
      </div>

      <nav className="tabs" aria-label="sections">
        <button className={tab === "capabilities" ? "active" : ""} onClick={() => setTab("capabilities")}>
          <IconShield width={15} height={15} /> Capabilities
          {caps && <span className="count">{caps.entries.length}</span>}
        </button>
        <button className={tab === "sources" ? "active" : ""} onClick={() => setTab("sources")}>
          <IconSource width={15} height={15} /> Sources
        </button>
        <button className={tab === "pending" ? "active" : ""} onClick={() => setTab("pending")}>
          <IconInbox width={15} height={15} /> Pending
          {pendingCount > 0 && <span className="count">{pendingCount}</span>}
        </button>
        <button className={tab === "grants" ? "active" : ""} onClick={() => setTab("grants")}>
          <IconGrants width={15} height={15} /> Grants
          {grantsCount > 0 && <span className="count">{grantsCount}</span>}
        </button>
        <button className={tab === "tokens" ? "active" : ""} onClick={() => setTab("tokens")}>
          <IconToken width={15} height={15} /> Tokens
        </button>
        <button className={tab === "audit" ? "active" : ""} onClick={() => setTab("audit")}>
          <IconScroll width={15} height={15} /> Audit
        </button>
      </nav>

      {err && (
        <div className="banner banner-err">
          <IconInbox width={15} height={15} /> {err}
        </div>
      )}

      {tab === "capabilities" &&
        (caps ? (
          <CapabilitiesTab data={caps} knownAgents={knownAgents} onIssued={bump} />
        ) : (
          <SkeletonTable />
        ))}
      {tab === "sources" && <SourcesTab onChanged={bump} />}
      {tab === "pending" && <PendingTab knownAgents={knownAgents} onResolved={bump} />}
      {tab === "grants" && (
        <GrantsTab onChanged={bump} caps={caps} knownAgents={knownAgents} />
      )}
      {tab === "tokens" && <TokensTab />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}
