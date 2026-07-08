/**
 * integrations-in-context-e2e — the DETERMINISTIC gate for the HTTP-ONLY ("in-context") delivery.
 *
 * The in-context delivery is "a pure-HTTP protocol instruction TEXT + a one-time enroll code",
 * both carried ONLY in the mgmt-gated JSON — for a light / cloud agent that installs NOTHING and
 * has no filesystem. This test is the deterministic proof that the EXACT mechanism such an agent
 * would use works against a real gateway with real data — no mock, no CLI, no plugin, no LLM.
 *
 * It exercises the WHOLE delivery the console hands out for an `in-context` agent:
 *
 *   1. connect the agent (agentType: "in-context") + mgmt-fetch `GET /integration/:agentId`
 *      → the mgmt-gated JSON carries the one-time `enrollCode` + the code-FREE `instruction`
 *        text (filled with the gateway URL) + an `enrollHint`.
 *   2. there is NO public route — both `/integration/:agentId/install.sh` and `/setup.sh` are 404.
 *   3. the NO-LEAK WALK: with ONLY the served instruction + the mgmt code, drive the real protocol
 *      over PLAIN HTTP (fetch — NEVER the plexus CLI, NEVER a filesystem) in an isolated context:
 *      DISCOVER (.well-known) → ENROLL (code → PAT) → HANDSHAKE (Bearer PAT → session + manifest)
 *      → GRANT (PUT /grants → scoped JWT) → INVOKE (Bearer scoped JWT → read a real demo file).
 *
 * SECURITY INVARIANTS this pins:
 *   - Inv III — the served instruction is CODE-FREE + KEY-FREE: neither the one-time code, a
 *     durable PAT, nor the admin connection-key appears in it. The code rides ONLY the mgmt JSON.
 *   - ADR-019 — the agent authenticates with its OWN per-agent PAT (`plx_agent_…`), redeemed from a
 *     one-time code; it NEVER holds the admin connection-key. The connection-key is asserted absent
 *     from EVERY served delivery text, and the PAT lives only in an in-memory variable (no file).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, baseUrl as configBaseUrl } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { openVaultExtension, VAULT_READ_ID } from "@plexus/runtime/sources/obsidian/open-vault.ts";

const AGENT_ID = "in-context-e2e";

interface Booted {
  baseUrl: string;
  home: string; // the GATEWAY home (holds the admin connection-key)
  key: string;
  cleanup: () => void;
}

let booted: Booted;
let server: ReturnType<typeof Bun.serve>;

async function pickFreePort(): Promise<number> {
  const probe = Bun.serve({ fetch: () => new Response("ok"), hostname: "127.0.0.1", port: 0 });
  const port = probe.port ?? 0;
  probe.stop(true);
  if (!port) throw new Error("could not pick a free port");
  return port;
}

async function bootGateway(): Promise<Booted> {
  const home = mkdtempSync(join(tmpdir(), "plexus-incontext-gw-"));
  process.env.PLEXUS_HOME = home;
  _resetSecretCacheForTests();

  const port = await pickFreePort();
  const config = { ...loadConfig(), port } as ReturnType<typeof loadConfig>;
  const { app, state } = createAppWithState(config);

  const vaultRoot = mkdtempSync(join(tmpdir(), "plexus-incontext-vault-"));
  const vaultPath = join(vaultRoot, "DemoVault");
  mkdirSync(join(vaultPath, "Projects"), { recursive: true });
  writeFileSync(
    join(vaultPath, "Projects", "Plexus.md"),
    "# Plexus\nThe in-context agent read THIS note over pure HTTP — no CLI, no install.\n",
  );

  const { manifest, handlers } = openVaultExtension(vaultPath);
  const reg = await state.capabilities.registerExtension(manifest, { handlers });
  if (!reg.ok) throw new Error(`failed to register vault extension: ${reg.reason}`);

  server = Bun.serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  return {
    baseUrl: configBaseUrl(config),
    home,
    key: state.connectionKey.current(),
    cleanup: () => {
      try {
        server.stop(true);
      } catch {
        /* ignore */
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(vaultRoot, { recursive: true, force: true });
    },
  };
}

/** The OWNER connects the IN-CONTEXT agent (grants a starting cap-set + mints the code). */
async function connectAgent(capabilities: string[]): Promise<void> {
  const res = await fetch(`${booted.baseUrl}/admin/api/agents/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Plexus-Connection-Key": booted.key },
    body: JSON.stringify({
      agentId: AGENT_ID,
      agentType: "in-context",
      capabilities,
      trustWindow: { kind: "7d" },
    }),
  });
  if (res.status !== 200) throw new Error(`connect failed: HTTP ${res.status}`);
}

/** The mgmt-gated integration JSON — carries the code-free instruction + the one-time code. */
interface IntegrationJson {
  ok?: boolean;
  agentType?: string;
  instruction?: string;
  manual?: string;
  enrollCode?: string;
  enrollHint?: string;
  enrollCommand?: string;
  setupCommand?: string;
  installCommand?: string;
  capabilities?: string[];
  codeExpiresAt?: string;
}
async function getIntegration(): Promise<{ raw: string; json: IntegrationJson }> {
  const res = await fetch(`${booted.baseUrl}/integration/${AGENT_ID}`, {
    headers: { accept: "application/json", "X-Plexus-Connection-Key": booted.key },
  });
  if (res.status !== 200) throw new Error(`GET /integration JSON failed: HTTP ${res.status}`);
  const raw = await res.text();
  return { raw, json: JSON.parse(raw) as IntegrationJson };
}

beforeAll(async () => {
  booted = await bootGateway();
});

afterAll(() => {
  booted?.cleanup();
  delete process.env.PLEXUS_HOME;
});

describe("integrations/in-context — the mgmt JSON delivers a code-free HTTP instruction (Inv III)", () => {
  it("carries agentType, the one-time code, a SHORT code-free brief, and a form-agnostic manual", async () => {
    await connectAgent([VAULT_READ_ID]);
    const { raw, json } = await getIntegration();

    expect(json.agentType).toBe("in-context");
    // The one-time code is delivered ONLY in the mgmt JSON.
    expect(typeof json.enrollCode).toBe("string");
    expect(json.enrollCode).toMatch(/^plx_enroll_/);
    expect(typeof json.enrollHint).toBe("string");

    const instruction = json.instruction ?? "";
    // The served brief is now SHORT — it is FILLED with the real gateway URL (self-bootstrapping)…
    expect(instruction).toContain(booted.baseUrl);
    expect(instruction).not.toContain("{{GATEWAY_URL}}");
    expect(instruction).not.toContain("{{GATEWAY_HOST}}");
    // …and points at the self-describing endpoint (the brief tells the agent to bootstrap from it).
    expect(instruction).toContain("/.well-known/plexus");
    // The brief is short: the detailed wire (five uppercase steps / io.input / .token) lives in the
    // MANUAL, not the brief. Prove the brief no longer dumps the full walkthrough.
    expect(instruction).not.toContain("grant_pending_user");
    expect(instruction).not.toContain('"input": {}');

    // ── The MANUAL field — the FULL by-hand walkthrough, form-agnostic, present + code-free. ──
    const manual = json.manual ?? "";
    expect(typeof json.manual).toBe("string");
    expect(manual).toContain(booted.baseUrl);
    expect(manual).not.toContain("{{GATEWAY_URL}}");
    expect(manual).not.toContain("{{GATEWAY_HOST}}");
    // It teaches the five-step pure-HTTP protocol.
    for (const kw of ["DISCOVER", "ENROLL", "HANDSHAKE", "GRANT", "INVOKE"]) {
      expect(manual).toContain(kw);
    }
    // It points at the self-describing endpoints.
    expect(manual).toContain("/.well-known/plexus");
    expect(manual).toContain("/agents/enroll");
    expect(manual).toContain("/link/handshake");
    expect(manual).toContain("/grants");
    expect(manual).toContain("/invoke");
    // It tells the agent to read the input SHAPE from the manifest io.input schema (the e2e-found
    // improvement — stable for ANY capability), incl. the no-arg → `{}` case (B3).
    expect(manual).toContain("io.input");
    expect(manual).toContain('"input": {}');
    // GRANT accuracy (A3/A4): the JWT is in the `.token` FIELD (not the whole object), and the
    // deferred branch is `grant_pending_user` (no token) — both must be spelled out so a literal
    // agent doesn't Bearer the wrong thing.
    expect(manual).toContain(".token");
    expect(manual).toContain("grant_pending_user");

    // CODE-FREE + KEY-FREE: neither the brief NOR the manual carries the minted code, a real durable
    // PAT/enroll body, or the admin connection-key.
    for (const text of [instruction, manual]) {
      expect(text).not.toContain(json.enrollCode!);
      expect(text).not.toContain(booted.key);
      expect(text).not.toMatch(/plx_enroll_[A-Za-z0-9_-]{16,}/);
      expect(text).not.toMatch(/plx_agent_[A-Za-z0-9_-]{16,}/);
      expect(text).not.toMatch(/plx_live_[0-9a-f]{32,}/);
    }

    // The connection-key must NEVER appear ANYWHERE in the mgmt JSON (the code legitimately does).
    expect(raw).not.toContain(booted.key);
  });

  it("has NO public bootstrap route — install.sh and setup.sh are both 404 for in-context", async () => {
    const install = await fetch(`${booted.baseUrl}/integration/${AGENT_ID}/install.sh`);
    expect(install.status).toBe(404);
    const setup = await fetch(`${booted.baseUrl}/integration/${AGENT_ID}/setup.sh`);
    expect(setup.status).toBe(404);
  });
});

describe("integrations/in-context — the NO-LEAK walk: real HTTP, PAT in memory only, no CLI", () => {
  it("discover → enroll → handshake → grant → invoke reads a real file over pure fetch", async () => {
    // Re-fetch a FRESH code from the mgmt JSON (single-use; each fetch supersedes the prior).
    const { json: integ } = await getIntegration();
    const code = integ.enrollCode!;
    expect(code).toMatch(/^plx_enroll_/);

    // The agent's ONLY persistent state is this in-memory PAT — never a file, never the CLI.
    let pat = "";

    // 1. DISCOVER — the unauthenticated self-description carries the request shapes + enrollment.
    const wk = await fetch(`${booted.baseUrl}/.well-known/plexus`);
    expect(wk.status).toBe(200);
    const wkDoc = (await wk.json()) as {
      auth?: { enrollmentUrl?: string; requestShapes?: Record<string, unknown> };
    };
    expect(wkDoc.auth?.enrollmentUrl).toContain("/agents/enroll");
    expect(wkDoc.auth?.requestShapes).toBeDefined();

    // 2. ENROLL — redeem the one-time code for this agent's own durable PAT.
    const enrollRes = await fetch(`${booted.baseUrl}/agents/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(enrollRes.status).toBe(200);
    const enrolled = (await enrollRes.json()) as { pat?: string; agentId?: string };
    expect(enrolled.pat).toMatch(/^plx_agent_/);
    expect(enrolled.agentId).toBe(AGENT_ID);
    pat = enrolled.pat!;

    // 3. HANDSHAKE — present the PAT as a Bearer header (no body); receive session + full manifest.
    const hsRes = await fetch(`${booted.baseUrl}/link/handshake`, {
      method: "POST",
      headers: { Authorization: `Bearer ${pat}` },
    });
    expect(hsRes.status).toBe(200);
    const hs = (await hsRes.json()) as {
      sessionId?: string;
      manifest?: { entries?: { id: string; io?: { input?: unknown } }[] };
    };
    expect(typeof hs.sessionId).toBe("string");
    // The input SHAPE is read from the manifest io.input schema — authoritative for any cap.
    const entry = hs.manifest?.entries?.find((e) => e.id === VAULT_READ_ID);
    expect(entry).toBeDefined();
    expect(entry?.io?.input).toBeDefined();

    // 4. GRANT — request the cap for this session; receive a scoped JWT (standing → auto-granted).
    const grantRes = await fetch(`${booted.baseUrl}/grants`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: hs.sessionId, grants: { [VAULT_READ_ID]: "allow" } }),
    });
    expect(grantRes.status).toBe(200);
    const grant = (await grantRes.json()) as { token?: string };
    expect(typeof grant.token).toBe("string");

    // 5. INVOKE — present the scoped JWT as a Bearer token; read the REAL demo file.
    const invRes = await fetch(`${booted.baseUrl}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${grant.token}` },
      body: JSON.stringify({ id: VAULT_READ_ID, input: { path: "Projects/Plexus.md" } }),
    });
    expect(invRes.status).toBe(200);
    const inv = (await invRes.json()) as { ok?: boolean; output?: { content?: string } };
    expect(inv.ok).toBe(true);
    expect(inv.output?.content ?? "").toContain(
      "The in-context agent read THIS note over pure HTTP — no CLI, no install.",
    );

    // The credential the agent used is its OWN PAT — never the admin connection-key.
    expect(pat).not.toBe(booted.key);
    expect(pat).not.toContain(booted.key);
    // And the connection-key never appeared in the served instruction (the agent's whole input).
    expect(integ.instruction ?? "").not.toContain(booted.key);
  });
});

describe("integrations/in-context — switching delivery form (?as=) is a pure re-projection (A1)", () => {
  const SW = "switch-e2e";

  async function connectAs(agentType: string): Promise<void> {
    const res = await fetch(`${booted.baseUrl}/admin/api/agents/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Plexus-Connection-Key": booted.key },
      body: JSON.stringify({ agentId: SW, agentType, capabilities: [VAULT_READ_ID], trustWindow: { kind: "7d" } }),
    });
    if (res.status !== 200) throw new Error(`connect failed: HTTP ${res.status}`);
  }
  async function fetchIntegration(as?: string): Promise<IntegrationJson> {
    const q = as ? `?as=${encodeURIComponent(as)}` : "";
    const res = await fetch(`${booted.baseUrl}/integration/${SW}${q}`, {
      headers: { accept: "application/json", "X-Plexus-Connection-Key": booted.key },
    });
    if (res.status !== 200) throw new Error(`GET /integration${q} → HTTP ${res.status}`);
    return (await res.json()) as IntegrationJson;
  }

  it("re-projecting a PENDING agent's form MINTS a working code (projected command must carry one), never re-grants", async () => {
    // Provision as in-context; the first (plain) fetch mints a code.
    await connectAs("in-context");
    const first = await fetchIntegration();
    expect(first.agentType).toBe("in-context");
    expect(first.enrollCode).toMatch(/^plx_enroll_/);

    // Switch to generic via ?as= — a PENDING agent has no PAT to protect, so the projection MINTS a
    // fresh WORKING code (the fix: a code-free projected command would leave the agent unable to
    // enroll — the "you already hold a credential" bug on Generic CLI). It persists the form + returns
    // the generic delivery, but does NOT re-connect or re-grant.
    const gen = await fetchIntegration("generic");
    expect(gen.agentType).toBe("generic");
    expect(gen.enrollCode).toMatch(/^plx_enroll_/); // ← projected command carries a working code
    expect(gen.enrollCommand ?? "").toContain("plexus enroll ");
    // The standing cap-set is unchanged (not re-granted).
    expect(gen.capabilities).toContain(VAULT_READ_ID);

    // The freshest code redeems → the agent becomes active.
    const enrollRes = await fetch(`${booted.baseUrl}/agents/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: gen.enrollCode }),
    });
    expect(enrollRes.status).toBe(200);
    const enrolled = (await enrollRes.json()) as { pat?: string; agentId?: string };
    expect(enrolled.pat).toMatch(/^plx_agent_/);
    expect(enrolled.agentId).toBe(SW);

    // Now ACTIVE: a plain fetch (and any projection) does NOT mint — the live PAT is protected.
    const afterEnroll = await fetchIntegration();
    expect(afterEnroll.agentType).toBe("generic");
    expect(afterEnroll.enrollCode).toBeUndefined();
  });

  it("switching to in-context still yields a code-free instruction on the projection response", async () => {
    // (agent from the prior test is now active/generic) — switch view to in-context: pure projection.
    const view = await fetchIntegration("in-context");
    expect(view.agentType).toBe("in-context");
    expect(view.enrollCode).toBeUndefined(); // active agent + projection → no mint
    expect(view.instruction ?? "").toContain(booted.baseUrl);
    expect(view.instruction ?? "").not.toContain(booted.key);
  });
});
