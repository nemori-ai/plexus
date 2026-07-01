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
