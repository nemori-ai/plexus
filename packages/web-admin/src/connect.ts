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
 * The two agent-types the console distinguishes. `claude-code` is the BESPOKE path — its
 * granted cap-set is compiled into a Claude Code plugin and delivered as a one-command
 * install (the D1 `/integration/:agentId` artifact). `generic` is the portable path — the
 * same provisioning (code + standing grants), but delivered as raw enrollment coordinates
 * (enroll URL + handshake URL + one-time code) for any other agent to redeem.
 */
export type AgentType = "claude-code" | "generic";

export const AGENT_TYPES: { value: AgentType; label: string }[] = [
  { value: "claude-code", label: "Claude Code (bespoke plugin)" },
  { value: "generic", label: "Generic / other agent" },
];

/** The request body for `POST /admin/api/agents/connect`, as the wizard sends it. */
export interface ConnectAgentBody {
  agentId: string;
  agentType: AgentType;
  capabilities: string[];
  trustWindow?: TrustWindow;
}

/**
 * Shape the connect request from raw wizard state: TRIM the id (the backend normalizes by
 * trim only, so connect/revoke/integration all key to the same agent), de-dupe + sort the
 * selected capability ids for a stable request, and thread the admin-chosen trust-window.
 */
export function buildConnectBody(
  agentId: string,
  agentType: AgentType,
  capabilityIds: string[],
  trustWindow?: TrustWindow,
): ConnectAgentBody {
  const capabilities = [...new Set(capabilityIds.map((c) => c.trim()).filter(Boolean))].sort();
  return {
    agentId: agentId.trim(),
    agentType,
    capabilities,
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
 * so `apple-reminders` → "Apple Reminders", `cc-master` → "Cc Master". The raw key is still
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
 * A short, honest "why" for a requested capability that did NOT become a standing grant
 * (returned by connect under `skipped`). Per ADR-5 the grant service forces `once` for
 * execute / high-sensitivity capabilities even when the admin supplies a trust-window, so
 * they never persist as standing — the agent still gets them, but each use is approved
 * per-use rather than pre-authorized. Unknown/unexposed ids fall through to a generic note.
 */
export function explainSkipped(id: string, entry?: CapabilityEntry): string {
  if (!entry) return "no longer exposed by the gateway — nothing to grant.";
  if (entry.grants?.includes("execute")) {
    return "execute capabilities can't be standing — each run is approved per-use.";
  }
  if (entry.sensitivity === "high") {
    return "high-sensitivity — approved per-use, not pre-authorized as standing.";
  }
  return "did not become standing — it stays approved per-use.";
}
