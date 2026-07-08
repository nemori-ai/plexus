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
import {
  renderPlugin,
  assertVerified,
  renderGeneric,
  assertGenericVerified,
  type RenderedGeneric,
  renderInContext,
  assertInContextVerified,
  renderManual,
  assertManualVerified,
  type RenderedInContext,
} from "../integration/index.ts";
import { deliversAsGeneric, deliversAsInContext } from "./agent-enrollment.ts";

/** Identity reserved for the local management user — never a target agent (mirrors admin.ts). */
const ADMIN_AGENT_ID = "plexus-admin";

/**
 * The UNIFORM public-route 404 body — a COLD agent's `curl` gets the SAME "not connected" text
 * whether the agent is unknown/revoked OR connected-but-wrong-delivery-type. Not echoing the
 * agentId (or the reason) closes an enumeration oracle (C7): you can't probe which agents exist
 * or which delivery form they take through the un-authenticated install.sh / setup.sh routes.
 */
const PUBLIC_NOT_CONNECTED = "plexus: not connected — connect this agent first via the Plexus console.\n";

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
    | {
        kind: "ok";
        agentId: string;
        agentType?: string;
        floor: WellKnownDocument;
        capabilityIds: string[];
        alreadyEnrolled: boolean;
      } {
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

    return { kind: "ok", agentId, agentType: record.agentType, floor, capabilityIds, alreadyEnrolled };
  }

  // ── Shared GENERIC render+gate (C3) — the SINGLE place both the public setup.sh route and the
  // mgmt JSON route compile the portable delivery, so their serve/verify policy stays in lock-step
  // (same forbiddenSecrets set; same single baseUrl normalization — B3: pass the RAW Floor baseUrl,
  // let renderGeneric's requireNonEmpty throw on a missing one rather than silently emitting a
  // host-less curl). Returns the rendered delivery, or a `{ message }` an error path can surface.
  function renderGenericOrError(
    derived: { agentId: string; floor: WellKnownDocument },
    extraSecrets: string[] = [],
  ): { ok: true; generic: RenderedGeneric } | { ok: false; message: string } {
    try {
      const generic = renderGeneric({
        agentId: derived.agentId,
        gatewayBaseUrl: derived.floor.gateway?.baseUrl,
      });
      assertGenericVerified(generic, {
        forbiddenSecrets: [state.connectionKey.current(), ...extraSecrets],
      });
      return { ok: true, generic };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── Shared IN-CONTEXT render+gate — the HTTP-only projection (no public route, no engine). The
  // instruction TEXT is filled from the committed PROTOCOL.md against the Floor's baseUrl and gated
  // through the SAME secret oracle (shared denylist + any caller-supplied secret — the one-time code,
  // the connection-key) before it may be returned. Code-FREE + KEY-FREE (Inv III). Returns the rendered
  // instruction, or a `{ message }` the caller surfaces as a 500.
  function renderInContextOrError(
    derived: { floor: WellKnownDocument },
    extraSecrets: string[] = [],
    extraTexts: { label: string; text: string }[] = [],
  ): { ok: true; inContext: RenderedInContext } | { ok: false; message: string } {
    try {
      const inContext = renderInContext({ gatewayBaseUrl: derived.floor.gateway?.baseUrl });
      // Gate the instruction AND every other served in-context text field (e.g. enrollHint) through
      // the same secret oracle (B2) — a future added text field can't bypass the denylist.
      assertInContextVerified(inContext, {
        forbiddenSecrets: [state.connectionKey.current(), ...extraSecrets],
        extraTexts,
      });
      return { ok: true, inContext };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── Shared MANUAL render+gate — the FORM-AGNOSTIC "manual + skill" reference (the full by-hand
  // DISCOVER→ENROLL→HANDSHAKE→GRANT→INVOKE walkthrough), returned as a `manual` field on EVERY
  // delivery form (cc / generic / in-context). Filled from the committed MANUAL.md against the Floor's
  // baseUrl and gated through the SAME secret oracle (shared denylist + the minted code + the
  // connection-key as forbidden literals) before it may be returned. Code-FREE + KEY-FREE (Inv III):
  // the one-time code rides ONLY the JSON `enrollCode`, never this text. Returns the rendered manual,
  // or a `{ message }` the caller surfaces as a 500 (never serve a manual that fails the gate).
  function renderManualOrError(
    derived: { floor: WellKnownDocument },
    extraSecrets: string[] = [],
  ): { ok: true; manual: string } | { ok: false; message: string } {
    try {
      const manual = renderManual(derived.floor.gateway?.baseUrl);
      assertManualVerified(manual, {
        forbiddenSecrets: [state.connectionKey.current(), ...extraSecrets],
      });
      return { ok: true, manual };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
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
    // A2 — install.sh is the CLAUDE CODE (compiled-plugin) bootstrap. It inlines the SKILL.md with
    // the full granted cap-set, so serving it for a GENERIC agent would leak that agent's cap-set
    // over an un-authenticated route (generic's contract is cap-free). Serve ONLY for the
    // claude-code (compiled-plugin / legacy) delivery; generic (setup.sh) and in-context (mgmt-only,
    // no public route) are a uniform 404 (C7).
    if (
      derived.kind === "unknown" ||
      deliversAsGeneric(derived.agentType) ||
      deliversAsInContext(derived.agentType)
    ) {
      return c.text(PUBLIC_NOT_CONNECTED, 404);
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

  // ── PUBLIC — GET /integration/:agentId/setup.sh (the portable GENERIC bootstrap) ─────────────
  // The generic counterpart to install.sh: a COLD agent runs `curl … | bash` carrying NO
  // management key, so this route MUST be reachable WITHOUT `requireManagementKey` (two-segment
  // path, not covered by the single-segment `/:agentId` guard). It installs the sanctioned
  // `plexus` CLI on PATH + lands a filled-in AGENTS.plexus.md. It is CODE-FREE + KEY-FREE — the
  // one-time enrollment code rides ONLY the mgmt-gated JSON route's `enrollCode` (Inv III). We
  // derive + 404 the same way, then assert no secret leaks before serving.
  app.get("/:agentId/setup.sh", (c) => {
    const derived = deriveFor(c.req.param("agentId"));
    if (derived.kind === "bad_id") {
      return c.text("plexus: `agentId` (a non-empty string, not the admin id) is required\n", 400);
    }
    // A2 — setup.sh is the GENERIC (portable) bootstrap. Serve ONLY for a generic-delivery agent;
    // a claude-code / legacy agent takes install.sh instead. Wrong type or unknown → uniform 404 (C7).
    if (derived.kind === "unknown" || !deliversAsGeneric(derived.agentType)) {
      return c.text(PUBLIC_NOT_CONNECTED, 404);
    }
    // Compile via the shared render+gate (C3) — same policy as the mgmt JSON route.
    const out = renderGenericOrError(derived);
    if (!out.ok) {
      return c.text(`plexus: failed to compile the setup: ${out.message}\n`, 500);
    }
    return c.body(out.generic.setupSh, 200, { "content-type": "text/plain; charset=utf-8" });
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
    const { agentId, agentType, floor, capabilityIds, alreadyEnrolled } = derived;

    // ── DELIVERY-FORM PROJECTION OVERRIDE (`?as=`) — the operator switching HOW this agent is
    // delivered (Claude Code plugin / generic CLI / in-context HTTP). agentType shapes ONLY
    // delivery, never authz, so a form switch is a pure RE-PROJECTION — NOT re-provisioning: it
    // persists the chosen form (lightweight — no mint, no grant, no audit via `setAgentType`) and
    // renders it, but MINTS NOTHING. The existing un-redeemed code stays valid (the console carries
    // it across the switch) and any live PAT is untouched. Only a KNOWN form is honored; an unknown
    // `as` is ignored (falls back to the persisted form + normal mint). A plain fetch (no `as`)
    // keeps the full mint semantics below. This is the implementation of "switching form is a
    // display switch, not a re-authorization".
    const KNOWN_FORMS = ["claude-code", "generic", "in-context"];
    const asRaw = (c.req.query("as") ?? "").trim().toLowerCase();
    const overrideForm = KNOWN_FORMS.includes(asRaw) ? asRaw : undefined;
    const projectionSwitch = overrideForm !== undefined;
    if (projectionSwitch && overrideForm !== agentType) {
      state.agentEnrollment.setAgentType(agentId, overrideForm);
    }
    const deliverAs = overrideForm ?? agentType;

    // Bug A — re-fetching the install for an ALREADY-ACTIVE agent must NOT silently de-enroll it.
    // `mintEnrollmentCode` is ALSO the lost-PAT re-issue path: it resets the row to `pending` and
    // drops the active PAT. So we mint ONLY when the agent is not yet active, OR when the admin
    // EXPLICITLY asks to re-issue a code via `?reissue=1` (a knowing action that invalidates the
    // agent's current credential — it must re-install). For an active agent WITHOUT `reissue`, we
    // recompile + serve the plugin artifact WITHOUT touching enrollment: the install command is the
    // code-FREE re-materialize form (install.sh with no code simply re-lands the files + re-registers
    // the plugin, and skips enrollment), so the agent's live PAT keeps working. A PROJECTION SWITCH
    // (`?as=`) NEVER mints — it is a pure re-projection of an already-provisioned agent.
    const reissue = ["1", "true", "yes"].includes((c.req.query("reissue") ?? "").toLowerCase());
    const mint = !projectionSwitch && (!alreadyEnrolled || reissue);

    // C1 — PROVE THE DELIVERY RENDERS BEFORE MINTING. A mint is destructive: it supersedes the
    // prior un-redeemed code and, on a reissue of an active agent, DROPS the live PAT. If we minted
    // first and the render then 500'd (e.g. a Floor missing its baseUrl), the agent would be left
    // with an invalidated credential AND no delivery — stuck until another reissue. So we do a PURE
    // render+verify probe for the `deliverAs` form FIRST (the *OrError helpers + renderPlugin are
    // side-effect-free); a failure 500s here with enrollment UNTOUCHED. Only runs on mint paths.
    if (mint) {
      let probe: { ok: true } | { ok: false; message: string };
      if (deliversAsInContext(deliverAs)) {
        probe = renderInContextOrError({ floor });
      } else if (deliversAsGeneric(deliverAs)) {
        probe = renderGenericOrError({ agentId, floor });
      } else {
        try {
          const r = renderPlugin({
            floor,
            capabilityIds,
            agentId,
            enrollmentCode: "plx_enroll_probe_placeholder_pre_mint",
          });
          assertVerified(r, floor, {
            expectedCapabilityIds: capabilityIds,
            forbiddenSecrets: [state.connectionKey.current()],
          });
          probe = { ok: true };
        } catch (e) {
          probe = { ok: false, message: e instanceof Error ? e.message : String(e) };
        }
      }
      if (!probe.ok) {
        return c.json(
          {
            error: {
              code: "internal_error",
              message: `failed to compile/verify the integration for '${agentId}' before minting a code: ${probe.message}`,
            },
          },
          500,
        );
      }
    }

    // Mint a FRESH one-time enrollment code only on the mint paths (codes are single-use; a mint
    // supersedes any prior un-redeemed code, and — for an active agent being re-issued — resets the
    // row to pending + invalidates the current PAT). The raw code is delivered here ONCE and rides
    // ONLY the installCommand — never a distributed file (Inv III). The C1 probe above guarantees
    // the render will succeed, so this destructive mint is never wasted.
    const minted = mint ? state.agentEnrollment.mintEnrollmentCode(agentId) : null;

    // ── IN-CONTEXT delivery: an HTTP-only light/cloud agent gets NO install — just the pure-HTTP
    // protocol instruction TEXT (fed straight into its own context) + the one-time code. There is
    // NO public route: both the instruction and the code ride ONLY this mgmt-gated JSON. The
    // instruction is code-FREE + key-FREE (assertInContextVerified — shared secret denylist + the
    // minted code + the connection-key as forbidden literals). `enrollHint` tells the operator how
    // to hand it off. Same mint/`alreadyEnrolled`/`reissued` semantics as the other two forms.
    if (deliversAsInContext(deliverAs)) {
      // How the operator delivers this form: paste the instruction into the agent's context; the
      // agent enrolls + connects over HTTP on its own with the one-time code. This handoff text is
      // ALSO run through the secret gate (B2) so it can never leak a code/key even though it is a
      // constant today (future-proof against deriving it from a request/Floor).
      const enrollHint =
        "Paste the instruction into your agent's context / system prompt, then hand it the one-time enroll code below. The agent enrolls and connects over pure HTTP on its own — nothing is installed.";
      const out = renderInContextOrError(
        { floor },
        minted ? [minted.code] : [],
        [{ label: "enrollHint", text: enrollHint }],
      );
      if (!out.ok) {
        return c.json(
          {
            error: {
              code: "internal_error",
              message: `failed to compile/verify the in-context integration for '${agentId}': ${out.message}`,
            },
          },
          500,
        );
      }
      // The FORM-AGNOSTIC manual reference (gated code-free, same forbidden literals).
      const man = renderManualOrError({ floor }, minted ? [minted.code] : []);
      if (!man.ok) {
        return c.json(
          {
            error: {
              code: "internal_error",
              message: `failed to compile/verify the manual for '${agentId}': ${man.message}`,
            },
          },
          500,
        );
      }
      return c.json({
        ok: true,
        agentId,
        agentType: "in-context",
        // No install command / no CLI: in-context installs nothing. Kept as an empty string so a
        // consumer keyed on `installCommand` never sees `undefined` (the panel ignores it).
        installCommand: "",
        instruction: out.inContext.instruction,
        manual: man.manual,
        enrollHint,
        // The one-time code + its raw value — delivered ONCE here only (never in the instruction).
        // Absent when we did NOT mint (already-enrolled re-view, or a `?as=` projection switch).
        ...(minted ? { enrollCode: minted.code } : {}),
        capabilities: capabilityIds,
        alreadyEnrolled,
        reissued: alreadyEnrolled && mint,
        ...(minted ? { codeExpiresAt: minted.expiresAt } : {}),
      });
    }

    // ── GENERIC delivery: any non-Claude-Code agent gets the PORTABLE shape — a code-FREE
    // setup command + the copy-able instruction TEXT — instead of a compiled CC plugin. The
    // one-time code (when minted) is delivered ONLY here, in this mgmt-gated JSON, as a
    // SEPARATE `enrollCode` field the operator hands to the agent to run `plexus enroll <code>`.
    // The served setup.sh / instruction stay code-free + key-free (assertGenericVerified).
    if (deliversAsGeneric(deliverAs)) {
      const out = renderGenericOrError({ agentId, floor }, minted ? [minted.code] : []);
      if (!out.ok) {
        return c.json(
          {
            error: {
              code: "internal_error",
              message: `failed to compile/verify the generic integration for '${agentId}': ${out.message}`,
            },
          },
          500,
        );
      }
      const generic = out.generic;
      const man = renderManualOrError({ floor }, minted ? [minted.code] : []);
      if (!man.ok) {
        return c.json(
          {
            error: {
              code: "internal_error",
              message: `failed to compile/verify the manual for '${agentId}': ${man.message}`,
            },
          },
          500,
        );
      }
      return c.json({
        ok: true,
        agentId,
        agentType: "generic",
        setupCommand: generic.setupCommand,
        manual: man.manual,
        // For the CC path `installCommand` is the copy-able command; mirror it here (code-free)
        // so any consumer keyed on `installCommand` still gets the right thing.
        installCommand: generic.setupCommand,
        instruction: generic.instruction,
        // The one-time code + its ready-to-run enroll command — delivered ONCE here only (never
        // in a served file). Absent when we did NOT mint (already-enrolled re-view).
        ...(minted ? { enrollCode: minted.code, enrollCommand: `plexus enroll ${minted.code}` } : {}),
        capabilities: capabilityIds,
        alreadyEnrolled,
        reissued: alreadyEnrolled && mint,
        ...(minted ? { codeExpiresAt: minted.expiresAt } : {}),
      });
    }

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

    // The FORM-AGNOSTIC manual reference (gated code-free) — the Manual tab is form-agnostic, so the
    // CC path carries it too. Forbid the minted code + connection-key as literals (same as the others).
    const man = renderManualOrError({ floor }, minted ? [minted.code] : []);
    if (!man.ok) {
      return c.json(
        {
          error: {
            code: "internal_error",
            message: `failed to compile/verify the manual for '${agentId}': ${man.message}`,
          },
        },
        500,
      );
    }

    return c.json({
      ok: true,
      agentId,
      // B1 — the CC path returns the CANONICAL agentType too, so the console can dispatch install
      // rendering on a single `integration.agentType` field (never re-branch per call site).
      agentType: "claude-code",
      dirName: rendered.dirName,
      version: rendered.version,
      installCommand,
      manual: man.manual,
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
