/**
 * D2-CONSOLE — pure helpers for the "Connect an agent" flow (kept DOM-free so they
 * unit-test without a browser). The flow itself (the wizard component) lives in App.tsx;
 * this module owns the request-shaping + the human "why was this skipped" copy so both
 * are testable in isolation.
 *
 * SSOT: docs/design/agent-skill-compile-domain-model.md §5 (deliver·P), ADR-8. The admin
 * picks an agent-type + a cap-set → `POST /admin/api/agents/connect` provisions the agent
 * (mints a one-time code + grants the standing cap-set) → the console shows the copy-able
 * ONE-COMMAND install (from `GET /integration/:agentId`) carrying a FRESH one-time code.
 */
import type { CapabilityEntry, TrustWindow } from "@plexus/protocol";

/**
 * The three DELIVERY forms the console distinguishes. agentType only shapes DELIVERY — provisioning
 * (one-time code + standing grants) is identical for all three:
 *   - `claude-code` — the BESPOKE path: the granted cap-set is compiled into a Claude Code plugin
 *     and delivered as a one-command `install.sh`.
 *   - `generic` — the PORTABLE path: a code-free `curl … | bash` (pasted in the agent's project
 *     dir) that installs the per-agent `plexus` launcher inside `~/.plexus` and lands a paste-able
 *     instruction at the project's AGENTS.md, for any other agent that has a filesystem/shell.
 *   - `in-context` — the HTTP-ONLY path: NOTHING is installed. A light / cloud agent gets a
 *     pure-HTTP-protocol instruction TEXT it pastes into its own context + a one-time enroll code,
 *     and connects with its own `fetch`/`curl` (discover → enroll → handshake → grant → invoke).
 */
export type AgentType = "claude-code" | "generic" | "in-context";

export const AGENT_TYPES: { value: AgentType; label: string }[] = [
  { value: "claude-code", label: "Claude Code (bespoke plugin)" },
  { value: "generic", label: "Generic CLI setup (other agent)" },
  { value: "in-context", label: "In-context / HTTP (no install)" },
];

/** The request body for `POST /admin/api/agents/connect`, as the wizard sends it. */
export interface ConnectAgentBody {
  agentId: string;
  agentType: AgentType;
  capabilities: string[];
  /**
   * Execute capabilities the owner opted into a STANDING grant for THIS agent (ADR-023,
   * default-off + double-confirm). A subset of `capabilities`; omitted when empty.
   */
  standingExecute?: string[];
  trustWindow?: TrustWindow;
}

/**
 * Shape the connect request from raw wizard state: TRIM the id (the backend normalizes by
 * trim only, so connect/revoke/integration all key to the same agent), de-dupe + sort the
 * selected capability ids for a stable request, thread the admin-chosen trust-window, and
 * carry the standing-execute opt-ins (intersected with the selected caps + omitted when empty).
 */
export function buildConnectBody(
  agentId: string,
  agentType: AgentType,
  capabilityIds: string[],
  trustWindow?: TrustWindow,
  standingExecuteIds: readonly string[] = [],
): ConnectAgentBody {
  const capabilities = [...new Set(capabilityIds.map((c) => c.trim()).filter(Boolean))].sort();
  const capSet = new Set(capabilities);
  const standingExecute = [...new Set(standingExecuteIds.map((c) => c.trim()).filter(Boolean))]
    .filter((id) => capSet.has(id))
    .sort();
  return {
    agentId: agentId.trim(),
    agentType,
    capabilities,
    ...(standingExecute.length ? { standingExecute } : {}),
    ...(trustWindow ? { trustWindow } : {}),
  };
}

/**
 * A capability group for step 2's grouped, cascading multi-select. The wizard groups the
 * grantable caps by their SOURCE (the connector/adapter that exposed them) so a long flat
 * list becomes a handful of readable sections with a group-level cascade checkbox.
 */
export interface CapGroup {
  /** Stable grouping key — the source id, or the first dotted id-segment as a fallback. */
  key: string;
  /** Readable header, humanized from the key (e.g. "obsidian-rest" → "Obsidian Rest"). */
  label: string;
  /** The caps in this group, in the order they arrived. */
  entries: CapabilityEntry[];
}

/**
 * The grouping key for a capability: prefer the semantic `source` field (the connector/adapter
 * the entry came from), else fall back to the FIRST dotted segment of the id (e.g.
 * `obsidian-rest.vault.read` → `obsidian-rest`). Both are stable per-source, so caps from the
 * same source always land in the same group.
 */
export function capGroupKey(entry: CapabilityEntry): string {
  const source = (entry.source ?? "").trim();
  if (source) return source;
  const first = entry.id.split(".")[0]?.trim();
  return first || entry.id;
}

/**
 * Humanize a group key into a header label: split on `-`, `_`, `.` and Title-Case each word,
 * so `apple-reminders` → "Apple Reminders", `obsidian-rest` → "Obsidian Rest". The raw key is still
 * shown alongside (mono) in the UI, so this only needs to be pleasant, not reversible.
 */
export function humanizeGroupKey(key: string): string {
  const words = key.split(/[-_.]+/).filter(Boolean);
  if (words.length === 0) return key;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Group capabilities by {@link capGroupKey}, returning groups sorted by label (case-insensitive)
 * with each group's entries kept in arrival order. Pure + DOM-free so the wizard's step-2 layout
 * is unit-testable without a browser.
 */
export function groupCapabilities(entries: CapabilityEntry[]): CapGroup[] {
  const byKey = new Map<string, CapabilityEntry[]>();
  for (const e of entries) {
    const key = capGroupKey(e);
    const arr = byKey.get(key);
    if (arr) arr.push(e);
    else byKey.set(key, [e]);
  }
  return [...byKey.entries()]
    .map(([key, es]) => ({ key, label: humanizeGroupKey(key), entries: es }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

/**
 * The tri-state of a cascade checkbox over a set of ids: "checked" iff EVERY id is selected,
 * "unchecked" iff NONE are, "indeterminate" otherwise. Empty id-lists read as "unchecked".
 * Used for both a group header (its caps) and the top-level "Select all" (every cap). The
 * checkbox itself is DERIVED from the selected-set — this is the derivation.
 */
export type TriState = "checked" | "unchecked" | "indeterminate";

export function triStateFor(ids: readonly string[], selected: ReadonlySet<string>): TriState {
  if (ids.length === 0) return "unchecked";
  let selCount = 0;
  for (const id of ids) if (selected.has(id)) selCount++;
  if (selCount === 0) return "unchecked";
  if (selCount === ids.length) return "checked";
  return "indeterminate";
}

/**
 * Cascade a select/deselect of `ids` onto the selected-set, returning a NEW set (the caller's
 * state stays the source of truth; group/all checkboxes only mutate it). `on=true` adds every
 * id, `on=false` removes every id — leaving ids outside the group untouched.
 */
export function cascadeSelection(
  selected: ReadonlySet<string>,
  ids: readonly string[],
  on: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}

/**
 * The grantable capabilities an agent does NOT already hold as a standing grant — the
 * candidate set for "grant an ADDITIONAL standing capability to THIS agent" (the inline
 * per-agent picker). `grantable` is the console's grant-requiring catalog (caps with ≥1
 * verb); `heldCapabilityIds` are the capability ids the agent already carries as standing
 * grants. Pure + DOM-free so the "already-holds-all" empty state is unit-testable. Order
 * is preserved from `grantable`.
 */
export function capsNotYetGranted(
  grantable: readonly CapabilityEntry[],
  heldCapabilityIds: Iterable<string>,
): CapabilityEntry[] {
  const held = new Set(heldCapabilityIds);
  return grantable.filter((e) => !held.has(e.id));
}

// ── Enrollment status (agent-skill-compile §3 Auth model) ────────────────────────
/**
 * The enrollment lifecycle of an agent, as surfaced by `GET /admin/api/agents/enrollments`:
 *   - `pending`  — code minted, PAT not yet redeemed → provisioned but NOT yet integrated;
 *   - `active`   — redeemed a durable PAT → enrolled / connected;
 *   - `revoked`  — torn down.
 * This is a SEPARATE dimension from live-session activity ("active now" vs "idle"): a
 * `pending` agent has been provisioned but has not run its install, an `active` agent is
 * enrolled whether or not it currently holds a live token.
 */
export type AgentEnrollmentStatus = "pending" | "active" | "revoked";

/** The presentational spec of an agent's enrollment-status badge (rendered by App.tsx). */
export interface EnrollmentBadge {
  /** Short label (the badge CSS upper-cases it). */
  label: string;
  /** The badge modifier class carrying the status colour. */
  className: string;
  /** Hover title spelling out what the status means. */
  title: string;
}

/**
 * The enrollment-status badge for an agent, or `null` when there is NO enrollment record
 * (an older / grants-only agent) — in which case the row falls back to its activity
 * indicator alone. `pending` is amber ("awaiting install"), `active` is a subtle
 * "connected", `revoked` is muted. Pure + DOM-free so it unit-tests without a browser.
 */
export function enrollmentBadge(status: AgentEnrollmentStatus | undefined): EnrollmentBadge | null {
  switch (status) {
    case "pending":
      return {
        label: "Pending",
        className: "badge-enroll-pending",
        title: "Provisioned — awaiting install / not yet enrolled",
      };
    case "active":
      return {
        label: "Connected",
        className: "badge-enroll-active",
        title: "Enrolled — has redeemed a durable credential",
      };
    case "revoked":
      return {
        label: "Revoked",
        className: "badge-enroll-revoked",
        title: "Revoked — all of this agent's access was torn down",
      };
    default:
      return null;
  }
}

/**
 * Look up an agent's enrollment status by id from the `/agents/enrollments` list — the pure
 * merge seam that joins the enrollment ledger onto the grants-derived agent rows. Returns
 * `undefined` when the agent has no enrollment record (grants-only / older agent).
 */
export function enrollmentStatusFor(
  agentId: string,
  enrollments: readonly { agentId: string; status: AgentEnrollmentStatus }[],
): AgentEnrollmentStatus | undefined {
  return enrollments.find((e) => e.agentId === agentId)?.status;
}

/**
 * A short, honest "why" for a requested capability that did NOT become a standing grant
 * (returned by connect under `skipped`). By default the grant service caps execute /
 * high-sensitivity capabilities at `once`, so each use is approved individually rather than
 * pre-authorized (an execute cap the owner opted into standing at step 2 becomes a standing
 * grant instead, and never lands here). The section header already says "approved per-use,
 * not standing", so each line just names the WHY, not the mechanism again. Unknown/unexposed
 * ids fall through to a generic note.
 */
export function explainSkipped(id: string, entry?: CapabilityEntry): string {
  if (!entry) return "no longer exposed by the gateway — nothing to grant.";
  if (entry.grants?.includes("execute")) {
    return "runs code — each call is approved on its own.";
  }
  if (entry.sensitivity === "high") {
    return "high-sensitivity — each use is approved on its own.";
  }
  return "approved per use, each time it's called.";
}
