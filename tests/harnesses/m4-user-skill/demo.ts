/**
 * ============================================================================
 * M4 USER CUSTOM-SKILL — the demo engine (shared by run.ts + the test).
 * ============================================================================
 *
 * Boots a REAL gateway, registers the FIRST-PARTY `obsidian.vault.read` (the
 * existing capability a user skill will teach cross-source), then drives the
 * user-authoring worked path and returns a structured `DemoReport` of GENUINE
 * facts (so the test asserts the same things the human transcript prints).
 *
 * The worked path, step by step:
 *
 *   1. SAME-SOURCE attach — register the user's authored skill extension. The
 *      author's own capability gets its own usage skill back-linked freely; the
 *      cross-source skill on this register is DROPPED (no opt-in) — that is the
 *      default-OFF posture, proven below.
 *
 *   2. CROSS-SOURCE DEFAULT-OFF (over the wire) — the agent POSTs the same
 *      manifest to `/extensions` with NO opt-in + NO human. The register is
 *      REJECTED outright (cross-source attach is a prompt-injection channel). We
 *      assert the rejection + that the host entry carries NO foreign skill.
 *
 *   3. CROSS-SOURCE WITH opt-in + approval — the MANAGEMENT user re-registers
 *      with `allowCrossSource:true` (modeling the human's deliberate consent).
 *      Now the skill attaches onto `obsidian.vault.read`, PROVENANCE-STAMPED.
 *
 *   4. AGENT DISCOVERY — a real `PlexusClient` handshakes and reads the FULL
 *      manifest. We prove: the same-source skill is discoverable (back-link + body),
 *      the cross-source skill is discoverable on the host with provenance, and the
 *      provenance distinguishes it from a first-party describe.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, baseUrl, type GatewayConfig } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { openVaultExtension } from "@plexus/runtime/sources/obsidian/open-vault.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import type {
  CapabilityEntry,
  ExtensionRegisterResponse,
  GrantPendingResponse,
} from "@plexus/protocol";
import type { AttachedSkillProvenance } from "@plexus/runtime/sources/extension.ts";

import { PlexusClient } from "../../../examples/min-agent/client.ts";
import {
  SAME_SOURCE_EXTENSION,
  USER_SKILL_EXTENSION,
  USER_SOURCE,
  OBSIDIAN_VAULT_READ_ID,
  SNIPPETS_READ_ID,
  SAME_SOURCE_SKILL_ID,
  CROSS_SOURCE_SKILL_ID,
} from "./skill-manifests.ts";

export interface CheckResult {
  ok: boolean;
  label: string;
  detail?: string;
}
export interface DemoReport {
  base: string;
  checks: CheckResult[];
  overall: boolean;
}

export interface RunOptions {
  verbose?: boolean;
  /** Drive in-process via app.request (the test path). Default: real socket. */
  inProcess?: boolean;
}

function check(ok: boolean, label: string, detail?: string): CheckResult {
  return { ok, label, ...(detail ? { detail } : {}) };
}

type RequestableApp = {
  fetch: (req: Request) => Response | Promise<Response>;
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

async function pickFreePort(): Promise<number> {
  const probe = Bun.serve({ fetch: () => new Response("ok"), hostname: "127.0.0.1", port: 0 });
  const port = probe.port ?? 0;
  probe.stop(true);
  if (!port) throw new Error("could not pick a free loopback port");
  return port;
}

/** Read the `attachedSkillProvenance` array off a host entry's `extras` (the escape hatch). */
function provenanceOf(entry: CapabilityEntry | undefined): AttachedSkillProvenance[] {
  const p = entry?.extras?.attachedSkillProvenance;
  return Array.isArray(p) ? (p as AttachedSkillProvenance[]) : [];
}

/**
 * Run the worked path. `register` indirection: we register the FIRST-PARTY vault +
 * the SAME-SOURCE user skill through the registry directly (the trusted in-process /
 * management path), drive the agent's cross-source DEFAULT-OFF attempt over the WIRE
 * (`POST /extensions`), then model the human's opt-in via the registry again.
 */
export async function runUserSkillDemo(opts: RunOptions = {}): Promise<DemoReport> {
  const log = (s: string) => {
    if (opts.verbose) console.log(s);
  };
  const inProcess = opts.inProcess ?? false;
  const checks: CheckResult[] = [];

  // ── isolated temp fixtures — NEVER mutate real user state ────────────────────
  const sandbox = mkdtempSync(join(tmpdir(), "plexus-m4skill-"));
  const plexusHome = join(sandbox, "plexus-home");
  mkdirSync(plexusHome, { recursive: true });
  const vaultPath = join(sandbox, "Vault");
  mkdirSync(join(vaultPath, "Projects"), { recursive: true });
  writeFileSync(join(vaultPath, "Index.md"), "# Index\nThe user's notes.\n");
  writeFileSync(join(vaultPath, "Projects", "Plexus.md"), "# Plexus\nA local capability gateway.\n");

  process.env.PLEXUS_HOME = plexusHome;
  _resetSecretCacheForTests();

  const port = inProcess ? loadConfig().port : await pickFreePort();
  const config = { ...loadConfig(), port } as GatewayConfig;
  const { app, state } = createAppWithState(config);
  const base = baseUrl(config);
  let server: { stop: (force?: boolean) => void } | undefined;

  try {
    // ── 0. The EXISTING first-party capability the user will teach ─────────────
    // Register the real, path-confined `obsidian.vault.read` (in-process handler).
    const vault = openVaultExtension(vaultPath);
    const vaultReg = await state.capabilities.registerExtension(vault.manifest, {
      handlers: vault.handlers,
    });
    if (!vaultReg.ok) throw new Error(`vault register failed: ${vaultReg.reason}`);
    log(`[setup] first-party ${OBSIDIAN_VAULT_READ_ID} registered (the cross-source target).`);

    // ════════════════════════════════════════════════════════════════════════
    // STEP 1 — SAME-SOURCE attach (applied freely)
    // ════════════════════════════════════════════════════════════════════════
    // Register the SAME-SOURCE-ONLY manifest (the user's own capability + the usage
    // skill that teaches it). No cross-source boundary is crossed, so the back-link
    // wires FREELY — no gate, no human. The cross-source skill is registered later.
    log("");
    log("[step 1] register the SAME-SOURCE skill extension (applied freely)…");
    const reg1 = await state.capabilities.registerExtension(SAME_SOURCE_EXTENSION);
    if (!reg1.ok) throw new Error(`same-source register failed: ${reg1.reason}`);

    const snippetsRead = state.capabilities.getEntry(SNIPPETS_READ_ID);
    const sameSourceLinked = (snippetsRead?.skills ?? []).some((s) => s.id === SAME_SOURCE_SKILL_ID);
    checks.push(
      check(
        sameSourceLinked,
        "SAME-SOURCE skill back-linked onto the author's own capability (applied freely)",
        `${SNIPPETS_READ_ID}.skills ⊇ ${SAME_SOURCE_SKILL_ID}`,
      ),
    );
    const sameSourceSkill = state.capabilities.getEntry(SAME_SOURCE_SKILL_ID);
    checks.push(
      check(
        sameSourceSkill?.kind === "skill" && !!sameSourceSkill.body?.markdown,
        "SAME-SOURCE skill is a standalone discoverable kind:\"skill\" entry with a body",
      ),
    );

    // The first-party host carries NO user skill yet (the cross-source attach hasn't
    // been opted into — and the same-source register never touches a foreign source).
    const vaultEntryBefore = state.capabilities.getEntry(OBSIDIAN_VAULT_READ_ID);
    const notYetAttached = !(vaultEntryBefore?.skills ?? []).some((s) => s.id === CROSS_SOURCE_SKILL_ID);
    checks.push(
      check(
        notYetAttached && provenanceOf(vaultEntryBefore).length === 0,
        "first-party host carries NO user skill before any cross-source opt-in",
        `${OBSIDIAN_VAULT_READ_ID} has no ${CROSS_SOURCE_SKILL_ID}`,
      ),
    );
    log(`[step 1] same-source attached freely; first-party host untouched.`);

    // Boot the socket now (the agent + the wire register talk over it).
    if (!inProcess) {
      server = Bun.serve({ fetch: app.fetch, hostname: config.host, port: config.port });
    }
    const doFetch = inProcess
      ? async (input: string, init?: RequestInit) =>
          (app as RequestableApp).request(input, init) as Promise<Response>
      : undefined;
    const client = new PlexusClient({
      baseUrl: base,
      ...(doFetch ? { fetch: doFetch } : {}),
      client: { name: "m4-user-skill-agent", agentId: "agent-ez" },
    });

    // ════════════════════════════════════════════════════════════════════════
    // STEP 2 — CROSS-SOURCE over the WIRE is DEFAULT-OFF (real denial)
    // ════════════════════════════════════════════════════════════════════════
    // An agent holding a connection-key POSTs the SAME manifest to /extensions with
    // NO opt-in + NO human. The wire path validates WITHOUT allowCrossSource → the
    // cross-source attach is rejected → the WHOLE register is rejected outright.
    log("");
    log("[step 2] agent attempts the cross-source attach over the WIRE (no opt-in)…");
    const hs = await client.handshake(state.connectionKey.current());
    const wireRes = await fetchJson(app, base, "/extensions", inProcess, doFetch, {
      method: "POST",
      body: JSON.stringify({
        sessionId: hs.sessionId,
        // A DISTINCT source id so this wire attempt does not re-register step 1's source.
        manifest: { ...USER_SKILL_EXTENSION, source: "ezskills-wire" },
      }),
    });
    // The cross-source skill makes validation fail → ExtensionRegisterResponse{ok:false},
    // NOT a grant_pending_user (it is rejected before it can even pend).
    const wireRejected =
      (wireRes as ExtensionRegisterResponse).ok === false &&
      typeof (wireRes as ExtensionRegisterResponse).reason === "string" &&
      (wireRes as ExtensionRegisterResponse).reason!.toLowerCase().includes("cross-source");
    const notPended = (wireRes as GrantPendingResponse).status !== "grant_pending_user";
    checks.push(
      check(
        wireRejected && notPended,
        "CROSS-SOURCE attach over the wire (no opt-in/human) is REJECTED outright — a REAL denial",
        (wireRes as ExtensionRegisterResponse).reason?.slice(0, 80),
      ),
    );
    // And nothing from that attempt entered the registry.
    checks.push(
      check(
        state.capabilities.getEntry("ezskills-wire.obsidian.how-to-cite-well") === undefined,
        "the rejected wire register activated NOTHING (no foreign skill smuggled in)",
      ),
    );
    log(`[step 2] wire register REJECTED: ${(wireRes as ExtensionRegisterResponse).reason?.slice(0, 90)}`);

    // ════════════════════════════════════════════════════════════════════════
    // STEP 3 — CROSS-SOURCE WITH opt-in + human approval (provenance-stamped)
    // ════════════════════════════════════════════════════════════════════════
    // The MANAGEMENT user — having reviewed the skill body — re-registers the SAME
    // source WITH the explicit `allowCrossSource:true` opt-in. This models the human
    // deliberately consenting to layer a user skill onto a trusted first-party cap.
    log("");
    log("[step 3] management user opts in (allowCrossSource) + approves…");
    const reg3 = await state.capabilities.registerExtension(USER_SKILL_EXTENSION, {
      allowCrossSource: true,
    });
    if (!reg3.ok) throw new Error(`opt-in register failed: ${reg3.reason}`);

    const vaultEntryAfter = state.capabilities.getEntry(OBSIDIAN_VAULT_READ_ID);
    const nowAttached = (vaultEntryAfter?.skills ?? []).some((s) => s.id === CROSS_SOURCE_SKILL_ID);
    checks.push(
      check(
        nowAttached,
        "CROSS-SOURCE skill attaches onto obsidian.vault.read AFTER opt-in + approval",
        `${OBSIDIAN_VAULT_READ_ID}.skills ⊇ ${CROSS_SOURCE_SKILL_ID}`,
      ),
    );
    const prov = provenanceOf(vaultEntryAfter);
    const stamped = prov.find((p) => p.skillId === CROSS_SOURCE_SKILL_ID);
    checks.push(
      check(
        !!stamped && stamped.authoringSource === USER_SOURCE,
        "the cross-source attach is PROVENANCE-STAMPED (authoringSource ≠ host source)",
        stamped ? `skillId=${stamped.skillId}, authoringSource=${stamped.authoringSource}` : undefined,
      ),
    );

    // ════════════════════════════════════════════════════════════════════════
    // STEP 4 — AGENT DISCOVERY through the published wire
    // ════════════════════════════════════════════════════════════════════════
    log("");
    log("[step 4] agent re-pulls the manifest and DISCOVERS the skills…");
    // Re-handshake so the client holds the post-attach manifest snapshot.
    await client.handshake(state.connectionKey.current());

    // (a) the same-source skill body reaches the agent's manifest.
    const agentSameSkill = client.entry(SAME_SOURCE_SKILL_ID);
    checks.push(
      check(
        agentSameSkill?.kind === "skill" &&
          (agentSameSkill.body?.markdown ?? "").includes("kebab-case"),
        "AGENT discovers the SAME-SOURCE skill body in the handshake manifest (context delivered)",
      ),
    );

    // (b) the host capability the agent sees carries the cross-source back-link…
    const agentVault = client.entry(OBSIDIAN_VAULT_READ_ID);
    const agentSeesBacklink = (agentVault?.skills ?? []).some((s) => s.id === CROSS_SOURCE_SKILL_ID);
    checks.push(
      check(agentSeesBacklink, "AGENT sees the cross-source skill back-linked on obsidian.vault.read"),
    );

    // …and the cross-source skill body reaches the agent too.
    const agentCrossSkill = client.entry(CROSS_SOURCE_SKILL_ID);
    checks.push(
      check(
        agentCrossSkill?.kind === "skill" &&
          (agentCrossSkill.body?.markdown ?? "").includes("vault-relative path"),
        "AGENT discovers the CROSS-SOURCE skill body (its usage guidance delivered as context)",
      ),
    );

    // (c) the cross-source attach is DISTINGUISHABLE from a first-party describe:
    //     the host carries authoringSource provenance the agent can read.
    const agentProv = provenanceOf(agentVault);
    const agentSeesProvenance = agentProv.some(
      (p) => p.skillId === CROSS_SOURCE_SKILL_ID && p.authoringSource === USER_SOURCE,
    );
    checks.push(
      check(
        agentSeesProvenance,
        "AGENT can DISTINGUISH the foreign skill via attachedSkillProvenance (not a first-party describe)",
        `authoringSource=${USER_SOURCE}`,
      ),
    );

    if (opts.verbose) {
      log("");
      log("[discovered] obsidian.vault.read attached skills + provenance the AGENT sees:");
      log(`  skills:     ${JSON.stringify(agentVault?.skills ?? [])}`);
      log(`  provenance: ${JSON.stringify(agentProv)}`);
      log("");
      log("[discovered] cross-source skill body the AGENT reads as context:");
      log((agentCrossSkill?.body?.markdown ?? "").replace(/^/gm, "  | "));
    }

    const overall = checks.every((c) => c.ok);
    return { base, checks, overall };
  } finally {
    server?.stop(true);
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    delete process.env.PLEXUS_HOME;
  }
}

/** Issue one JSON request against the gateway (real socket or in-process). */
async function fetchJson(
  app: { fetch: (req: Request) => Response | Promise<Response> },
  base: string,
  path: string,
  inProcess: boolean,
  doFetch: ((input: string, init?: RequestInit) => Promise<Response>) | undefined,
  init: RequestInit,
): Promise<unknown> {
  const host = new URL(base).host;
  const headers = { host, "content-type": "application/json", ...(init.headers ?? {}) };
  const res =
    inProcess && doFetch
      ? await doFetch(base + path, { ...init, headers })
      : await fetch(base + path, { ...init, headers });
  return res.json();
}
