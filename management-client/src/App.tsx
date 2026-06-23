/**
 * Plexus — Capability Control (management panel, t11). A single-page, same-origin
 * admin UI served by the gateway at /admin. Presents the trust surface of a local
 * capability gateway as a custodial permission ledger: govern which capabilities an
 * AI agent may discover and call (expose/hide + read/read-write → grant verbs),
 * issue/revoke/list scoped tokens, optional-install cc-master, and read the audit.
 *
 * The data layer (./api.ts) and the gateway API contract are unchanged — this file
 * owns presentation and orchestration only. Default-deny, default-read-only, per-
 * capability, revocable, audited: that trust story is the design.
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
} from "./api.ts";
import type {
  CapabilityEntry,
  GatewayInfo,
  GrantDecision,
  GrantResponse,
  AuditEvent,
  GrantVerb,
  CapabilityId,
} from "../../src/protocol/index.ts";
import {
  IconKey,
  IconPlug,
  IconCheck,
  IconShield,
  IconToken,
  IconScroll,
  IconInbox,
  IconSource,
} from "./icons.tsx";

type Tab = "capabilities" | "sources" | "pending" | "tokens" | "audit";
type Access = "read" | "read-write";

/** Per-capability UI selection: expose? + access level. */
interface CapSelection {
  expose: boolean;
  access: Access;
}

/** Map an entry's required verbs + an access level to the grant verbs to request. */
function verbsForAccess(entry: CapabilityEntry, access: Access): GrantVerb[] {
  const required = entry.grants;
  if (access === "read") {
    return required.includes("read") ? ["read"] : [];
  }
  // read-write → every verb the entry requires (read + write + execute as needed).
  return [...required];
}

/** Does this entry support a write/execute path at all (so read-write is meaningful)? */
function isMutating(entry: CapabilityEntry): boolean {
  return entry.grants.includes("write") || entry.grants.includes("execute");
}

const VERB_ORDER: GrantVerb[] = ["read", "write", "execute"];

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
  const mutating = isMutating(entry);
  const requiresGrant = entry.grants.length > 0;
  const granted = selection.expose ? verbsForAccess(entry, selection.access) : [];

  return (
    <div
      className="ledger-row"
      data-exposed={selection.expose && requiresGrant}
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
          {requiresGrant && (
            <span className="verbs">
              {VERB_ORDER.filter((v) => entry.grants.includes(v)).map((v) => (
                <VerbStamp
                  key={v}
                  verb={v}
                  active={selection.expose ? granted.includes(v) : undefined}
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
                checked={selection.expose}
                onChange={(e) => onChange({ ...selection, expose: e.target.checked })}
              />
              <span className="switch" aria-hidden />
              <span className="state">{selection.expose ? "Exposed" : "Hidden"}</span>
            </label>
            <div className="access-seg" aria-label="access level">
              <button
                type="button"
                aria-pressed={selection.access === "read"}
                disabled={!selection.expose}
                onClick={() => onChange({ ...selection, access: "read" })}
              >
                read-only
              </button>
              <button
                type="button"
                aria-pressed={selection.access === "read-write"}
                disabled={!selection.expose || !mutating}
                onClick={() => onChange({ ...selection, access: "read-write" })}
              >
                read-write
              </button>
            </div>
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
  onIssued,
}: {
  data: CapabilitiesResponse;
  onIssued: () => void;
}) {
  const grantable = useMemo(() => data.entries.filter((e) => e.grants.length > 0), [data.entries]);
  const [sel, setSel] = useState<Record<string, CapSelection>>({});
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<GrantResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const selFor = (id: string): CapSelection => sel[id] ?? { expose: false, access: "read" };
  const setOne = (id: string, s: CapSelection) => setSel((prev) => ({ ...prev, [id]: s }));

  const issue = async () => {
    const grants: Record<CapabilityId, GrantDecision | "deny"> = {};
    for (const entry of grantable) {
      const s = selFor(entry.id);
      if (!s.expose) {
        grants[entry.id] = "deny";
        continue;
      }
      grants[entry.id] = { decision: "allow", verbs: verbsForAccess(entry, s.access) };
    }
    if (Object.keys(grants).length === 0) return;
    setIssuing(true);
    setErr(null);
    setIssued(null);
    try {
      const r = await api.issueGrants(grants);
      setIssued(r);
      onIssued();
    } catch (e) {
      setErr(String(e));
    } finally {
      setIssuing(false);
    }
  };

  const exposed = grantable.filter((e) => selFor(e.id).expose);
  const exposedCount = exposed.length;
  const writeCount = exposed.filter((e) => selFor(e.id).access === "read-write" && isMutating(e)).length;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Capability ledger</h2>
          <div className="meta">
            <b>{data.entries.length}</b> registered · revision <b>{data.revision}</b> · default-deny until exposed
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
            until you expose them.
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
          <div className="tally">
            <span className="n">{exposedCount}</span>
            <span className="label">
              {exposedCount === 1 ? "capability" : "capabilities"} to expose
              {writeCount > 0 ? (
                <>
                  {" "}· <b>{writeCount}</b> with write/execute
                </>
              ) : exposedCount > 0 ? (
                <> · read-only</>
              ) : null}
            </span>
          </div>
          <button className="btn btn-primary" onClick={issue} disabled={issuing || exposedCount === 0}>
            {issuing ? "Issuing token…" : "Issue scoped token"}
          </button>
        </div>
      )}

      {issued && "token" in issued && (
        <div className="receipt">
          <div className="r-head">
            <IconCheck width={15} height={15} /> Token issued <code className="mono">{issued.jti}</code>
            <span className="row-note">expires {issued.expiresAt}</span>
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
          <code className="mono">{issued.pendingId}</code>)
        </div>
      )}
    </section>
  );
}

// ── Pending approvals tab (the human-in-the-loop linchpin surface) ──────────────
function PendingCard({
  item,
  busy,
  onResolve,
}: {
  item: PendingItem;
  busy: boolean;
  onResolve: (action: "approve" | "deny") => void;
}) {
  const isRegister = item.kind === "register";
  const reg = item.register;
  return (
    <div className="ledger-row" data-exposed={isRegister}>
      <div className="rail" aria-hidden />
      <div className="row-body">
        <div className="row-title">
          <span className="name">
            {isRegister ? `Register extension — ${reg?.label ?? reg?.source}` : "Grant request"}
          </span>
          <span className="badge badge-kind" data-kind={isRegister ? "workflow" : "capability"}>
            {item.kind}
          </span>
          {item.agentId ? <span className="badge badge-transport">{item.agentId}</span> : null}
        </div>
        <div className="row-id">{item.pendingId}</div>

        {/* GRANT: the capabilities + verbs + risk reasons the user is approving. */}
        {!isRegister && (
          <>
            {item.scopes?.length ? (
              <div className="row-relations">
                <div>
                  <span className="rel-label">requests</span>{" "}
                  {item.scopes.map((s) => (
                    <span key={s.id}>
                      <code>{s.id}</code> [{s.verbs.join("/")}]{"  "}
                    </span>
                  ))}
                </div>
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
      <div className="row-controls">
        <button
          className="btn btn-primary btn-sm"
          disabled={busy}
          onClick={() => onResolve("approve")}
        >
          {busy ? "…" : "Approve"}
        </button>
        <button
          className="btn btn-danger btn-sm"
          disabled={busy}
          onClick={() => onResolve("deny")}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function PendingTab({ onResolved }: { onResolved: () => void }) {
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

  const resolve = async (id: string, action: "approve" | "deny") => {
    setBusy(id);
    setErr(null);
    try {
      await api.resolvePending(id, action);
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
              onResolve={(action) => resolve(item.pendingId, action)}
            />
          ))}
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
          <h2>Active tokens</h2>
          <div className="meta">Live scoped grants an agent currently holds. Revoke takes effect immediately.</div>
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
            Nothing is authorized right now. Expose capabilities in the ledger and issue a scoped
            token — it will appear here, scope by scope, until it expires or you revoke it.
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
                <th>expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
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
                          {s.synthesizedFor ? (
                            <span className="synth">↳ via {s.synthesizedFor}</span>
                          ) : null}
                        </span>
                      ))
                    ) : (
                      <span className="row-note">—</span>
                    )}
                  </td>
                  <td className="t-time">{t.expiresAt}</td>
                  <td>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => revoke(t.jti)}
                      disabled={busy === t.jti}
                    >
                      {busy === t.jti ? "Revoking…" : "Revoke"}
                    </button>
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

  const loadCaps = useCallback(() => {
    api
      .capabilities()
      .then(setCaps)
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(loadCaps, [loadCaps, refreshKey]);

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
          <CapabilitiesTab data={caps} onIssued={bump} />
        ) : (
          <SkeletonTable />
        ))}
      {tab === "sources" && <SourcesTab onChanged={bump} />}
      {tab === "pending" && <PendingTab onResolved={bump} />}
      {tab === "tokens" && <TokensTab />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}
