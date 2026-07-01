/**
 * D1-ENDPOINT — `GET /integration/:agentId`: serve the copy-able ONE-COMMAND install
 * for an already-connected agent.
 *
 * SSOT: docs/design/agent-skill-compile-domain-model.md §5 (deliver·P — the copy-able
 *       one-command install carrying the one-time code), ADR-8, §9 Q#6; and
 *       docs/design/cc-plugin-artifact-spec.md (G0) for the install mechanics.
 *
 * WHAT THIS IS — the DELIVER half of "connect an agent". The ADMIN side (A3,
 * `POST /admin/api/agents/connect`) provisioned the agent: it granted a STANDING
 * cap-set to `agentId` (the human approval, done once) and seeded an enrollment row.
 * This endpoint, for that already-provisioned agent, COMPILES the granted cap-set +
 * the gateway Floor into a ready-to-install Claude Code plugin (G1 `renderPlugin`),
 * GATES it through the build-time Floor oracle (G3 `assertVerified` — never serve an
 * over-reaching artifact), and returns the copy-able install command + the rendered
 * files.
 *
 * SECRET HYGIENE (Inv III) — NO durable secret ever leaves here. The response carries
 * a FRESH one-time enrollment code (codes are single-use; each GET mints a new one via
 * `mintEnrollmentCode`, superseding any prior un-redeemed code) that rides ONLY the
 * `installCommand` string in an env var — never baked into a distributed file (axis 2
 * of the verifier asserts exactly this, and we additionally forbid the admin
 * connection-key from appearing in any file). The durable PAT is minted server-side at
 * enroll time and is never served.
 *
 * GATING — MANAGEMENT-KEY ONLY. This route lives OUTSIDE `/admin/api/*` (so the blanket
 * admin gate does not cover it) and applies its OWN `X-Plexus-Connection-Key` check via
 * `state.connectionKey.verify`. An untrusted agent speaks only HTTP and can never present
 * the out-of-band connection-key, so it can never reach this route — the fresh code is
 * disclosed to the trusted human admin only.
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { WellKnownDocument } from "@plexus/protocol";
import type { GatewayState } from "./state.ts";
import { buildWellKnown } from "./well-known.ts";
import { renderPlugin, assertVerified } from "../integration/index.ts";

/** Identity reserved for the local management user — never a target agent (mirrors admin.ts). */
const ADMIN_AGENT_ID = "plexus-admin";

/**
 * Build the `/integration` sub-app. Mounted in `server.ts` AFTER the Host/Origin guard,
 * so every request is loopback/same-origin guarded; this app adds the management-key gate.
 */
export function createIntegrationApp(state: GatewayState): Hono {
  const app = new Hono();

  // ── MANAGEMENT-KEY GUARD (same contract as admin.ts `requireManagementKey`) ──────────
  // The loopback Host guard alone is not sufficient (any local process can send a loopback
  // Host, and a LAN peer can reach a LAN-bound gateway). A VERIFIED connection-key —
  // obtained OUT OF BAND by the real console, never over HTTP — is what distinguishes the
  // trusted admin from an arbitrary caller. Without it: 401. An agent can NEVER present it.
  const requireManagementKey: MiddlewareHandler = async (c, next) => {
    const presented =
      c.req.header("x-plexus-connection-key") ?? c.req.header("X-Plexus-Connection-Key");
    if (!presented || !state.connectionKey.verify(presented)) {
      return c.json(
        {
          error: {
            code: "unauthorized",
            message:
              "GET /integration/:agentId requires a verified management connection-key (X-Plexus-Connection-Key)",
          },
        },
        401,
      );
    }
    await next();
  };

  // ── Shared derivation: normalize the agentId + compile the granted cap-set against the Floor ──
  // Returns `null` when the agent is not connected/revoked (⇒ 404), or a `{ code, ... }` shape
  // describing a bad id (⇒ 400). This is the SAME projection both routes below use, so the public
  // install.sh and the mgmt-gated JSON stay in lock-step (Inv II: only Floor-advertised, granted caps).
  function deriveFor(agentIdRaw: string | undefined):
    | { kind: "bad_id" }
    | { kind: "unknown"; agentId: string }
    | { kind: "ok"; agentId: string; floor: WellKnownDocument; capabilityIds: string[] } {
    if (
      typeof agentIdRaw !== "string" ||
      agentIdRaw.trim().length === 0 ||
      agentIdRaw.trim().toLowerCase() === ADMIN_AGENT_ID
    ) {
      return { kind: "bad_id" };
    }
    const agentId = agentIdRaw.trim();

    const record = state.agentEnrollment.get(agentId);
    if (!record || record.status === "revoked") {
      return { kind: "unknown", agentId };
    }

    // The Floor: the SAME `.well-known` document the discovery handler serves — exposure-filtered
    // capability summaries + gateway/auth advertisement, reconciled to the real bound port.
    const summaries = state.capabilities
      .summaries()
      .filter((s) => !state.exposure?.isDisabled(s.id));
    const floor = buildWellKnown(state.config, summaries, state.boundPort);

    // The granted cap-set to project: the agent's LIVE standing grants, intersected with what the
    // Floor advertises (only granted caps appear; a grant for a now-unexposed/removed cap is
    // dropped so the artifact can never reference a cap the Floor does not advertise — Inv II).
    const advertised = new Set(summaries.map((s) => s.id));
    const now = Date.now();
    const capabilityIds = [
      ...new Set(
        state.grants
          .forAgent(agentId)
          .filter((g) => g.standing !== false && new Date(g.expiresAt).getTime() > now)
          .map((g) => g.capabilityId)
          .filter((id) => advertised.has(id)),
      ),
    ].sort();

    return { kind: "ok", agentId, floor, capabilityIds };
  }

  // ── PUBLIC — GET /integration/:agentId/install.sh (the self-contained bootstrap) ─────────────
  // A COLD agent runs `curl … | bash` carrying NO management key, so this route MUST be reachable
  // WITHOUT `requireManagementKey`. It is: `app.use("/:agentId", …)` matches only the single-segment
  // path `/:agentId`, never the two-segment `/:agentId/install.sh`, and we register this route BEFORE
  // that guard for good measure. This is a SECRET-FREE public projection — the served install.sh
  // inlines only the payload files (no one-time code, no PAT, no connection-key; the code rides the
  // JSON route's installCommand env var). We still derive the granted cap-set the same way and 404
  // for unknown/revoked agents, and re-gate through the Floor oracle before serving.
  app.get("/:agentId/install.sh", (c) => {
    const derived = deriveFor(c.req.param("agentId"));
    if (derived.kind === "bad_id") {
      return c.text("plexus: `agentId` (a non-empty string, not the admin id) is required\n", 400);
    }
    if (derived.kind === "unknown") {
      return c.text(
        `plexus: agent '${derived.agentId}' is not connected — connect it first via the Plexus console.\n`,
        404,
      );
    }

    let rendered;
    try {
      rendered = renderPlugin({
        floor: derived.floor,
        capabilityIds: derived.capabilityIds,
        agentId: derived.agentId,
        // install.sh is code-FREE (the one-time code never enters any file). A fixed non-secret
        // placeholder satisfies the renderer's non-empty check; it only shapes the (unused-here)
        // installCommand, never the served install.sh.
        enrollmentCode: "plx_enroll_placeholder_unused_by_install_sh",
      });
      // Re-gate (defense in depth): never serve an over-reaching artifact, and assert no secret leaks.
      assertVerified(rendered, derived.floor, {
        expectedCapabilityIds: derived.capabilityIds,
        forbiddenSecrets: [state.connectionKey.current()],
      });
    } catch (e) {
      return c.text(
        `plexus: failed to compile the installer for '${derived.agentId}': ${
          e instanceof Error ? e.message : String(e)
        }\n`,
        500,
      );
    }

    const installSh = rendered.files.find((f) => f.path === "install.sh")?.content ?? "";
    return c.body(installSh, 200, { "content-type": "text/plain; charset=utf-8" });
  });

  app.use("/:agentId", requireManagementKey);

  // ── GET /integration/:agentId — the copy-able one-command install for a provisioned agent ──
  app.get("/:agentId", (c) => {
    const derived = deriveFor(c.req.param("agentId"));
    if (derived.kind === "bad_id") {
      return c.json(
        { error: { code: "internal_error", message: "`agentId` (a non-empty string, not the admin id) is required" } },
        400,
      );
    }
    if (derived.kind === "unknown") {
      return c.json(
        {
          error: {
            code: "unknown_agent",
            message: `agent '${derived.agentId}' is not connected — connect it first via POST /admin/api/agents/connect`,
          },
        },
        404,
      );
    }
    const { agentId, floor, capabilityIds } = derived;

    // Mint a FRESH one-time enrollment code (codes are single-use; this supersedes any prior
    // un-redeemed code for the agent). The raw code is delivered here ONCE and rides ONLY the
    // installCommand — never a distributed file (Inv III).
    const minted = state.agentEnrollment.mintEnrollmentCode(agentId);

    // COMPILE (G1) then GATE (G3): never serve an artifact that fails the Floor oracle. Assert the
    // referenced caps stay within the granted set, and that the admin connection-key never leaks
    // into any file (axis 2).
    let rendered;
    try {
      rendered = renderPlugin({
        floor,
        capabilityIds,
        agentId,
        enrollmentCode: minted.code,
      });
      assertVerified(rendered, floor, {
        expectedCapabilityIds: capabilityIds,
        forbiddenSecrets: [state.connectionKey.current()],
      });
    } catch (e) {
      return c.json(
        {
          error: {
            code: "internal_error",
            message: `failed to compile/verify the integration for '${agentId}': ${
              e instanceof Error ? e.message : String(e)
            }`,
          },
        },
        500,
      );
    }

    return c.json({
      ok: true,
      agentId,
      dirName: rendered.dirName,
      version: rendered.version,
      installCommand: rendered.installCommand,
      files: rendered.files,
      capabilities: capabilityIds,
      codeExpiresAt: minted.expiresAt,
    });
  });

  return app;
}
