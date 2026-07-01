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
 * SECRET HYGIENE (Inv III) — NO durable secret ever leaves here. When a code is minted the
 * response carries a FRESH one-time enrollment code (single-use; supersedes any prior
 * un-redeemed code) that rides ONLY the `installCommand` string in an env var — never baked
 * into a distributed file (axis 2 of the verifier asserts exactly this, and we additionally
 * forbid the admin connection-key from appearing in any file). The durable PAT is minted
 * server-side at enroll time and is never served.
 *
 * NO SILENT DE-ENROLL (Bug A) — `mintEnrollmentCode` is ALSO the lost-PAT re-issue path: it
 * resets the row to `pending` and drops the active PAT. So this endpoint mints ONLY for an agent
 * that is not yet `active`, OR when the admin EXPLICITLY passes `?reissue=1` (a knowing action that
 * invalidates the current credential). Re-fetching the install for an already-active agent (no
 * `reissue`) recompiles + serves the plugin WITHOUT minting — its live PAT keeps working — and the
 * returned `installCommand` is the code-free re-materialize form. The response flags
 * `alreadyEnrolled` (state before the call) + `reissued` (this call minted for an active agent).
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
    | { kind: "ok"; agentId: string; floor: WellKnownDocument; capabilityIds: string[]; alreadyEnrolled: boolean } {
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
    // Whether this agent has already redeemed a code and holds a live PAT. Re-fetching the install
    // for such an agent must NOT silently reset it to `pending` / drop its PAT (Bug A) — the JSON
    // route below only mints for a NOT-yet-active agent, or on an EXPLICIT `?reissue=1`.
    const alreadyEnrolled = record.status === "active";

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

    return { kind: "ok", agentId, floor, capabilityIds, alreadyEnrolled };
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
    const { agentId, floor, capabilityIds, alreadyEnrolled } = derived;

    // Bug A — re-fetching the install for an ALREADY-ACTIVE agent must NOT silently de-enroll it.
    // `mintEnrollmentCode` is ALSO the lost-PAT re-issue path: it resets the row to `pending` and
    // drops the active PAT. So we mint ONLY when the agent is not yet active, OR when the admin
    // EXPLICITLY asks to re-issue a code via `?reissue=1` (a knowing action that invalidates the
    // agent's current credential — it must re-install). For an active agent WITHOUT `reissue`, we
    // recompile + serve the plugin artifact WITHOUT touching enrollment: the install command is the
    // code-FREE re-materialize form (install.sh with no code simply re-lands the files + re-registers
    // the plugin, and skips enrollment), so the agent's live PAT keeps working.
    const reissue = ["1", "true", "yes"].includes((c.req.query("reissue") ?? "").toLowerCase());
    const mint = !alreadyEnrolled || reissue;

    // Mint a FRESH one-time enrollment code only on the mint paths (codes are single-use; a mint
    // supersedes any prior un-redeemed code, and — for an active agent being re-issued — resets the
    // row to pending + invalidates the current PAT). The raw code is delivered here ONCE and rides
    // ONLY the installCommand — never a distributed file (Inv III).
    const minted = mint ? state.agentEnrollment.mintEnrollmentCode(agentId) : null;

    // COMPILE (G1) then GATE (G3): never serve an artifact that fails the Floor oracle. Assert the
    // referenced caps stay within the granted set, and that the admin connection-key never leaks
    // into any file (axis 2). When NOT minting, use a non-secret placeholder code (it only shapes
    // the installCommand, which we override with the code-free form below — never a served file).
    let rendered;
    try {
      rendered = renderPlugin({
        floor,
        capabilityIds,
        agentId,
        enrollmentCode: minted?.code ?? "plx_enroll_placeholder_no_reissue",
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

    // For an active agent we did NOT mint: hand back the code-FREE install command (re-materialize
    // + re-register only; enrollment untouched) rather than the placeholder-code one.
    const gatewayBaseUrl = (floor.gateway?.baseUrl ?? "").replace(/\/+$/, "");
    const installCommand = minted
      ? rendered.installCommand
      : `curl -fsSL ${gatewayBaseUrl}/integration/${agentId}/install.sh | bash`;

    return c.json({
      ok: true,
      agentId,
      dirName: rendered.dirName,
      version: rendered.version,
      installCommand,
      files: rendered.files,
      capabilities: capabilityIds,
      // `alreadyEnrolled` reflects the state BEFORE this call: true iff the agent already held a
      // live PAT. `reissued` is true only when this call explicitly minted a new code for an
      // already-active agent (which INVALIDATED its previous credential — it must re-install).
      alreadyEnrolled,
      reissued: alreadyEnrolled && mint,
      ...(minted ? { codeExpiresAt: minted.expiresAt } : {}),
    });
  });

  return app;
}
