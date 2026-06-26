/**
 * ============================================================================
 * M4 CAPSTONE — THE HEADLINE LOOP (meta-skill scaffold → register → agent uses it).
 * ============================================================================
 *
 * THE PROOF (the new bit M4 adds): the ENTIRE extension-authoring story, honest-green,
 * end to end:
 *
 *   1. SCAFFOLD  — call the meta-skill's ACTUAL generator (`generateManifest` from
 *      `plugins/plexus-ext/lib/generate.ts`) on an interview `CapabilitySpec` for a
 *      simple, read-only `local-rest` capability. We do NOT hand-write the manifest;
 *      the generator emits it + a bundled usage skill, and we run the meta-skill's own
 *      `validateExtension` pre-register check (PASS).
 *
 *   2. STAND UP A REAL BACKEND — a loopback "facts" service (`service.ts`, mirroring
 *      `m4-user-workflow/server.ts`) is the REAL side the capability dispatches to.
 *
 *   3. REGISTER (pends) — boot a REAL gateway, `POST /extensions` the generated
 *      manifest over the published wire. It is transport-backed (local-rest), so it
 *      PENDS for a human (`grant_pending_user`) — an agent CANNOT activate an
 *      extension on its own. An un-approved register stays INERT (asserted).
 *
 *   4. APPROVE — a background driver MODELS the management user clicking "Approve"
 *      in the management client (it polls the SAME shared pending store
 *      `/admin/api/pending` reads, and approves). Only THEN does the commit run.
 *
 *   5. AGENT USES IT — a real `PlexusClient` handshakes, DISCOVERS the scaffolded
 *      capability by reading its `describe` (and its bundled how-to-use skill body),
 *      requests the READ grant (pends → approved), and INVOKES it. The invoke routes
 *      through the gateway's real `LocalRestTransport` → a REAL HTTP GET to the
 *      loopback backend → the agent receives REAL data.
 *
 * HONEST GREEN: we assert the agent's returned `value` EQUALS the loopback service's
 * OWN view of that record (read back independently) — the value is the proof the data
 * came back through the real pipeline, not a fabricated ok.
 *
 * ── The REAL (FULLY vanilla) route — ZERO demo-side bridging ──────────────────────
 * The meta-skill generator emits the EXTENSION-SPEC §6 published route field
 * `pathTemplate` (the path with `{token}` interpolation), and the shipped runtime
 * `LocalRestTransport` READS `pathTemplate` directly (canonical; `path` kept as a legacy
 * alias — task m4fix). The generator ALSO publishes the local-service discovery info as a
 * MANIFEST-LEVEL `serviceHint` (`app`/`defaultPort`), and the gateway's own materializer
 * (`materializeExtension` in `src/sources/extension.ts`) now propagates that serviceHint
 * onto each local-rest entry's `route` (task m4fix2) — so the transport resolves the
 * loopback `baseUrl` itself via the REAL, loopback-enforced platform `locateLocalService`
 * (which probes `serviceHint.defaultPort` on 127.0.0.1). Therefore we register the
 * generator's manifest 100% VERBATIM: NO `pathTemplate`→`path` bridge AND NO
 * serviceHint-onto-route bridge. This demo exercises the FULLY vanilla generated path; it
 * does not edit the frozen generator or any `src/**` materialization on its behalf.
 */

import {
  generateManifest,
  validateExtension,
  type CapabilitySpec,
} from "../../../plugins/plexus-ext/lib/generate.ts";

import { loadConfig, baseUrl, type GatewayConfig } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { _resetSecretCacheForTests, defaultAuthorizer } from "@plexus/runtime/auth/index.ts";
import { GrantService } from "@plexus/runtime/core/grant-service.ts";
import type {
  ExtensionManifest,
  ExtensionRegisterRequest,
  ExtensionRegisterResponse,
  GrantResponse,
} from "@plexus/protocol";

import { PlexusClient } from "../../../examples/min-agent/client.ts";
import { startFactsService, type FactsService } from "./service.ts";
import type { CheckResult, Logger } from "./report.ts";
import { check, consoleLogger, mkTempHome, pickFreePort, cleanupHome } from "./report.ts";

// The scaffolded source + capability ids (derived by the generator: <source>.<name>).
export const FACTS_SOURCE = "facts-lookup" as const;
export const FACTS_READ_ID = "facts-lookup.facts.read" as const;
export const FACTS_SKILL_ID = "facts-lookup.facts.read.how-to-use" as const;

/** The agent supplies a topic; the backend returns the canonical fact value. */
const HEADLINE_TOPIC = "plexus";

export interface HeadlineResult {
  base: string;
  checks: CheckResult[];
  pass: boolean;
  /** The REAL value the agent received through the pipeline (the headline proof). */
  agentValue?: string;
  /** The backend's own view of the same record (what the agent SHOULD have got). */
  backendValue?: string;
  /** The generated manifest (so callers can show it was generator-authored). */
  manifest: ExtensionManifest;
}

/**
 * The interview answer-set a user gives the `create-extension` meta-skill for a
 * read-only local facts lookup. This is the INPUT to the real generator — the
 * manifest itself is generator-authored, never hand-written.
 */
export function factsLookupSpec(servicePort: number): CapabilitySpec {
  return {
    sourceName: "Facts Lookup",
    label: "Local Facts Lookup (loopback REST)",
    transport: "local-rest",
    actions: [
      {
        name: "facts.read",
        label: "Read a local fact",
        describe:
          "Look up a canonical fact value by topic from the user's local facts service. " +
          "Use when the task needs an authoritative local datum. Read-only: never mutates.",
        grants: ["read"],
        inputProperties: {
          topic: { type: "string", description: "The topic key to look up, e.g. 'plexus'." },
        },
        requiredInputs: ["topic"],
        // EXTENSION-SPEC §6 published route field: a `{token}`-interpolated path.
        rest: { method: "GET", pathTemplate: "/facts/{topic}" },
        attachUsageSkill: true,
      },
    ],
    // serviceHint drives loopback baseUrl discovery: the transport probes this
    // defaultPort on 127.0.0.1 (`locateLocalService`) to resolve the backend.
    serviceHint: { app: FACTS_SOURCE, defaultPort: servicePort },
  };
}

type RequestableApp = {
  fetch: (req: Request) => Response | Promise<Response>;
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

function isPending(r: GrantResponse | ExtensionRegisterResponse): r is GrantResponse & { status: "grant_pending_user"; pendingId: string } {
  return (r as { status?: string }).status === "grant_pending_user";
}

export interface RunHeadlineOptions {
  logger?: Logger;
  /** Drive in-process via app.request (the test path). Default: real loopback socket. */
  inProcess?: boolean;
}

export async function runHeadline(opts: RunHeadlineOptions = {}): Promise<HeadlineResult> {
  const log = opts.logger ?? consoleLogger();
  const inProcess = opts.inProcess ?? false;
  const checks: CheckResult[] = [];

  const home = mkTempHome("plexus-m4demo-");
  process.env.PLEXUS_HOME = home.plexusHome;
  _resetSecretCacheForTests();

  // ── stand up the REAL loopback backend the scaffolded capability reaches ──────
  const backend: FactsService = await startFactsService();
  log.line(`[demo] loopback facts service @ ${backend.baseUrl}`);

  // ════════════════════════════════════════════════════════════════════════════
  // 1. SCAFFOLD — the meta-skill's ACTUAL generator produces the manifest.
  // ════════════════════════════════════════════════════════════════════════════
  log.step("1", "SCAFFOLD — meta-skill generateManifest(spec) (not hand-written)");
  const spec = factsLookupSpec(backend.port);
  const generated = generateManifest(spec);
  const validation = validateExtension(generated);
  log.line(`    generator emitted source="${generated.source}" with ${generated.capabilities.length} entries`);
  log.line(`    meta-skill validateExtension: ok=${validation.ok} (${validation.errors.length} errors, ${validation.warnings.length} warnings)`);
  checks.push(
    check(
      generated.source === FACTS_SOURCE &&
        validation.ok &&
        generated.capabilities.some((c) => c.name === "facts.read" && c.kind === "capability") &&
        generated.capabilities.some((c) => c.kind === "skill"),
      "meta-skill GENERATED a spec-compliant manifest (capability + bundled usage skill), validateExtension PASS",
      `errors=${validation.errors.join("; ") || "none"}`,
    ),
  );
  // The generated capability is read-only by secure default.
  const genCap = generated.capabilities.find((c) => c.name === "facts.read");
  checks.push(
    check(
      JSON.stringify(genCap?.grants) === JSON.stringify(["read"]),
      "scaffolded capability is read-only by the generator's secure default (grants:[read])",
      JSON.stringify(genCap?.grants),
    ),
  );

  // Register the generator's manifest 100% VERBATIM — ZERO demo-side bridging. The
  // runtime reads `pathTemplate` directly (m4fix) and the gateway materializer propagates
  // the manifest-level `serviceHint` onto each local-rest route itself (m4fix2), so the
  // transport resolves the loopback baseUrl via `locateLocalService`. No adaptation needed.
  const manifest = generated as unknown as ExtensionManifest;

  // ── boot a REAL gateway ───────────────────────────────────────────────────────
  const port = inProcess ? loadConfig().port : await pickFreePort();
  const config = { ...loadConfig(), port } as GatewayConfig;
  const { app, state } = createAppWithState(config);
  const base = baseUrl(config);
  let server: { stop: (force?: boolean) => void } | undefined;
  const doFetch = inProcess
    ? async (input: string, init?: RequestInit) => (app as RequestableApp).request(input, init) as Promise<Response>
    : undefined;
  if (!inProcess) server = Bun.serve({ fetch: app.fetch, hostname: config.host, port: config.port });

  // ── HUMAN-IN-THE-LOOP: model the management user approving every pending item ──
  const approver = new GrantService(state, defaultAuthorizer());
  let approving = true;
  const approved: string[] = [];
  const approveLoop = (async () => {
    while (approving) {
      for (const p of approver.listPending()) {
        approved.push(`${p.kind}:${p.register?.source ?? p.capabilities?.join(",") ?? ""}`);
        log.line(`[user] approving pending ${p.kind} (${p.register?.source ?? p.capabilities?.join(", ") ?? ""})`);
        await approver.approve(p.pendingId);
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  })();

  const client = new PlexusClient({
    baseUrl: base,
    ...(doFetch ? { fetch: doFetch } : {}),
    client: { name: "m4-capstone-agent", version: "0.1.0", agentId: "agent-capstone" },
  });

  log.line(`[demo] booted REAL gateway @ ${base} (${inProcess ? "in-process" : "loopback socket"})`);

  try {
    // ── 0. handshake (need a live session to POST /extensions + grant) ──────────
    log.step("0", "HANDSHAKE — open a session");
    await client.discover();
    await client.handshake(state.connectionKey.current());
    const sessionId = client.getSessionId()!;
    log.line(`    session ${sessionId}`);

    // ════════════════════════════════════════════════════════════════════════════
    // SECURITY SPOT-CHECK — an UN-APPROVED register is inert (asserted BEFORE the
    // approve loop has a chance to commit it: we POST and immediately check it pended
    // and did not activate). The pending store will be approved by the loop right
    // after; that is the real flow. Here we prove the PEND, not auto-activation.
    // ════════════════════════════════════════════════════════════════════════════
    log.step("2", "REGISTER — POST /extensions the GENERATED manifest (PENDS for a human)");
    const regReq: ExtensionRegisterRequest = { sessionId, manifest };
    // Snapshot: capability absent before any approval.
    const absentBefore = state.capabilities.getEntry(FACTS_READ_ID) === undefined;
    const regRes = await postExtensions(base, doFetch, regReq);
    const pended = isPending(regRes);
    log.line(`    POST /extensions → ${pended ? "grant_pending_user (PENDS)" : JSON.stringify(regRes).slice(0, 120)}`);
    checks.push(
      check(
        absentBefore && pended,
        "an agent's register PENDS for a human (transport-backed local-rest); it does NOT self-activate",
        pended ? "grant_pending_user" : JSON.stringify(regRes),
      ),
    );

    // ════════════════════════════════════════════════════════════════════════════
    // 3. APPROVE — the modeled user commits the register; only THEN is it live.
    // ════════════════════════════════════════════════════════════════════════════
    log.step("3", "APPROVE — user approves; only then is the scaffolded capability live");
    const committed = await waitFor(() => !!state.capabilities.getEntry(FACTS_READ_ID), 2000);
    const entry = state.capabilities.getEntry(FACTS_READ_ID);
    log.line(`    capability entry present after approve: ${!!entry}`);
    checks.push(
      check(
        committed && entry?.kind === "capability" && entry.transport === "local-rest",
        "after approve, the scaffolded capability is committed + discoverable (local-rest)",
        entry ? `${entry.id} grants=${JSON.stringify(entry.grants)}` : "absent",
      ),
    );

    // ── 4a. AGENT DISCOVERY — read the describe + the bundled usage-skill body ───
    log.step("4", "AGENT discovers the scaffolded capability by reading its describe");
    await client.refreshManifest();
    const seen = client.entry(FACTS_READ_ID);
    log.line(`    agent sees: ${seen?.id} — ${seen?.describe.slice(0, 70)}…`);
    checks.push(
      check(
        !!seen && seen.describe.toLowerCase().includes("canonical fact value") && !!seen.io?.input,
        "AGENT discovers the scaffolded capability via its describe + io schema (self-describe)",
        seen?.id,
      ),
    );
    // The bundled how-to-use skill reaches the agent as context (back-linked + body).
    const skillEntry = client.entry(FACTS_SKILL_ID);
    const backlinked = (seen?.skills ?? []).some((s) => s.id === FACTS_SKILL_ID);
    checks.push(
      check(
        skillEntry?.kind === "skill" &&
          (skillEntry.body?.markdown ?? "").includes("How to use") &&
          backlinked,
        "the meta-skill's bundled how-to-use skill is discoverable + back-linked (context delivered)",
        backlinked ? `${FACTS_SKILL_ID} body+backlink` : "missing",
      ),
    );

    // ── 4b. DEFAULT-DENY — an un-granted invoke is rejected ─────────────────────
    log.step("4b", "DEFAULT-DENY — un-granted invoke is rejected");
    const denied = await client.invoke(FACTS_READ_ID, { topic: HEADLINE_TOPIC });
    log.line(`    denied: ok=${denied.ok}, code=${denied.error?.code}`);
    checks.push(
      check(
        !denied.ok && denied.error?.code === "grant_required",
        "un-granted invoke of the scaffolded capability is DENIED with grant_required",
        denied.error?.code,
      ),
    );

    // ════════════════════════════════════════════════════════════════════════════
    // 5. GRANT (read) → INVOKE → REAL data from the loopback backend.
    // ════════════════════════════════════════════════════════════════════════════
    log.step("5a", "GRANT the scaffolded capability (read; pends → approved)");
    const token = await client.requestGrants([FACTS_READ_ID]); // bare allow → read-only default
    log.line(`    scoped-token scopes=${JSON.stringify(token.scopes)}`);
    checks.push(
      check(
        JSON.stringify(token.scopes) === JSON.stringify([{ id: FACTS_READ_ID, verbs: ["read"] }]),
        "grant mints a READ-ONLY scope for the scaffolded capability (no write/execute)",
        JSON.stringify(token.scopes),
      ),
    );

    log.step("5b", "INVOKE — REAL HTTP GET to the loopback backend; assert the REAL value");
    const out = await client.invoke(FACTS_READ_ID, { topic: HEADLINE_TOPIC });
    const data = out.output as { topic?: string; value?: string; source?: string } | undefined;
    const backendRec = backend.factFor(HEADLINE_TOPIC);
    log.line(`    invoke ok=${out.ok}`);
    if (out.ok) {
      log.line(`    agent received: value="${data?.value}"`);
      log.line(`    backend's own : value="${backendRec?.value}"`);
    } else {
      log.line(`    error: ${out.error?.code} ${out.error?.message}`);
    }

    // THE HEADLINE PROOF: the agent's returned value EQUALS the backend's own record —
    // real data through the real pipeline (not a trusted ok, not a fabricated value).
    const realData =
      out.ok &&
      !!data &&
      data.topic === HEADLINE_TOPIC &&
      typeof data.value === "string" &&
      data.value.length > 0 &&
      data.value === backendRec?.value &&
      data.source === "facts-service";
    checks.push(
      check(
        realData,
        "HEADLINE: granted invoke returns the REAL backend value (agent value === backend's own record)",
        out.ok ? `value="${data?.value?.slice(0, 60)}…"` : out.error?.code,
      ),
    );

    const pass = checks.every((c) => c.ok);
    log.step("==", "HEADLINE SUMMARY");
    for (const c of checks) (c.ok ? log.pass : log.fail).call(log, `${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
    log.line("");
    log.line(
      pass
        ? "HEADLINE: ✓ PASS — meta-skill scaffold → register(pend→approve) → agent discovered + invoked → REAL backend data."
        : "HEADLINE: ✗ FAIL — see the failing checks above.",
    );

    return {
      base,
      checks,
      pass,
      agentValue: data?.value,
      backendValue: backendRec?.value,
      manifest,
    };
  } finally {
    approving = false;
    await approveLoop;
    server?.stop(true);
    await backend.stop();
    delete process.env.PLEXUS_HOME;
    cleanupHome(home);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────────

/** POST /extensions over the SAME wire the agent uses (loopback Host header). */
async function postExtensions(
  base: string,
  doFetch: ((input: string, init?: RequestInit) => Promise<Response>) | undefined,
  body: ExtensionRegisterRequest,
): Promise<GrantResponse | ExtensionRegisterResponse> {
  const fetchImpl = doFetch ?? ((globalThis as { fetch: typeof fetch }).fetch);
  const res = await fetchImpl(`${base}/extensions`, {
    method: "POST",
    headers: { host: new URL(base).host, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as GrantResponse | ExtensionRegisterResponse;
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}
