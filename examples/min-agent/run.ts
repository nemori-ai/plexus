/**
 * ============================================================================
 * Plexus minimal AI-agent — runnable end-to-end demo (t12).
 * ============================================================================
 *
 * THE PROOF: "any AI agent can self-discover and call a local capability —
 * authenticating with its OWN per-agent credential, never the admin key."
 *
 * This script boots a REAL Plexus gateway (`Bun.serve`, loopback), registers an
 * Obsidian vault read-only capability (a temp vault of `.md` notes — the real
 * `obsidian.vault.read` source), and then — talking ONLY the published protocol
 * over real HTTP `fetch` through `PlexusClient` — performs the WHOLE loop on the
 * CURRENT per-agent enrollment model:
 *
 *     0. ADMIN     POST /admin/api/agents/connect  → mint a ONE-TIME enrollment
 *                  code (connection-key gated; this is the owner/admin acting,
 *                  the only place the connection-key is used) + pre-grant the
 *                  cap-set the agent will need.
 *     1. DISCOVER  GET  /.well-known/plexus        → capability summaries
 *     2. ENROLL    POST /agents/enroll { code }    → the agent's OWN durable PAT
 *                  (`plx_agent_…`). The one-time code dies on redeem; the PAT is
 *                  this agent's identity from here on.
 *     3. UNDERSTAND POST /link/handshake           → full manifest, authenticated
 *                  with `Authorization: Bearer plx_agent_…` (NOT the admin key)
 *     4. GRANTED   PUT  /grants                    → scoped read token
 *     5. CALL      POST /invoke                    → REAL note content
 *     (+ a deliberate UN-GRANTED invoke to show the gateway DENIES it.)
 *
 * The trust boundary (agent-skill-compile Inv III): the AGENT holds ONLY its own
 * per-agent PAT + the out-of-band one-time code. It NEVER sees or uses the admin
 * `connection-key` — that stays admin-only, used here solely to mint the code (the
 * owner's provisioning step). A leaked PAT's blast radius is exactly this one
 * agent's pre-granted caps, independently revocable.
 *
 * Run:  bun run examples/min-agent/run.ts
 *
 * The script self-contains its gateway (no external setup) so it always shows a
 * real end-to-end read. Pass `PLEXUS_BASE_URL` to instead point at an already-
 * running gateway, and `PLEXUS_CONNECTION_KEY` to supply its connection-key —
 * which this script uses ONLY as the admin, to mint the agent's enrollment code.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, baseUrl } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { openVaultExtension, VAULT_READ_ID } from "@plexus/runtime/sources/obsidian/open-vault.ts";

import { PlexusClient, PlexusProtocolError, type FetchLike } from "./client.ts";

// ── tiny pretty-printer ────────────────────────────────────────────────────────
const line = (s = "") => console.log(s);
const step = (n: number, s: string) => console.log(`\n── ${n}. ${s} ──────────────────────────`);

/** The demo agent's stable id — the identity its PAT will be bound to. */
const AGENT_ID = "agent-demo-1";

/** Find a free TCP port by briefly binding `:0`, then releasing it. */
async function pickFreePort(): Promise<number> {
  const probe = Bun.serve({ fetch: () => new Response("ok"), hostname: "127.0.0.1", port: 0 });
  const port = probe.port;
  probe.stop(true);
  return port;
}

/** Create a throwaway Obsidian vault folder with a couple of real notes. */
function makeVault(): { vaultPath: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "plexus-min-agent-"));
  const vaultPath = join(root, "DemoVault");
  mkdirSync(join(vaultPath, "Projects"), { recursive: true });
  writeFileSync(join(vaultPath, "Index.md"), "# Index\nWelcome to the demo vault.\n");
  writeFileSync(
    join(vaultPath, "Projects", "Plexus.md"),
    "# Plexus\nPlexus is a local capability gateway. The agent discovered and read THIS note via the protocol.\n",
  );
  return { vaultPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * ADMIN step (connection-key gated). The owner mints a ONE-TIME enrollment code for
 * `agentId` via `POST /admin/api/agents/connect`, pre-granting `capabilities` as
 * standing grants so the agent's later `PUT /grants` short-circuits with no per-call
 * human approval. Returns the raw code (delivered to the agent OUT OF BAND). This is
 * the ONLY place the admin connection-key is used — the agent never sees it.
 */
async function mintEnrollmentCode(
  base: string,
  hostAuthority: string,
  connectionKey: string,
  agentId: string,
  capabilities: string[],
): Promise<{ code: string; granted: string[] }> {
  const res = await fetch(`${base}/admin/api/agents/connect`, {
    method: "POST",
    headers: {
      host: hostAuthority,
      "content-type": "application/json",
      // The connection-key is the ADMIN authority — carried in the admin-API header,
      // never handed to the agent.
      "x-plexus-connection-key": connectionKey,
    },
    body: JSON.stringify({ agentId, capabilities, agentType: "min-agent-demo" }),
  });
  const body = (await res.json()) as {
    code?: string;
    granted?: Array<{ capabilityId: string }>;
    error?: { message?: string };
  };
  if (!res.ok || !body.code) {
    throw new Error(`admin connect failed (${res.status}): ${body.error?.message ?? JSON.stringify(body)}`);
  }
  return { code: body.code, granted: (body.granted ?? []).map((g) => g.capabilityId) };
}

/**
 * AGENT step (UNAUTHENTICATED — the code IS the credential). Redeem the one-time code
 * at `POST /agents/enroll` for this agent's OWN durable PAT (`plx_agent_…`). The code
 * dies on redeem; the PAT is returned exactly once. The admin connection-key is NEVER
 * involved here.
 */
async function enrollAgent(
  base: string,
  hostAuthority: string,
  code: string,
): Promise<{ pat: string; agentId: string }> {
  const res = await fetch(`${base}/agents/enroll`, {
    method: "POST",
    headers: { host: hostAuthority, "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const body = (await res.json()) as { pat?: string; agentId?: string; error?: { message?: string } };
  if (!res.ok || !body.pat || !body.agentId) {
    throw new Error(`enroll failed (${res.status}): ${body.error?.message ?? JSON.stringify(body)}`);
  }
  return { pat: body.pat, agentId: body.agentId };
}

async function main() {
  const externalBase = process.env.PLEXUS_BASE_URL;

  // ── Boot a self-contained gateway unless pointed at an external one ──────────
  let base: string;
  let connectionKey: string;
  let stop: () => void = () => {};
  let cleanupVault: () => void = () => {};

  if (externalBase) {
    base = externalBase.replace(/\/$/, "");
    connectionKey = process.env.PLEXUS_CONNECTION_KEY ?? "";
    if (!connectionKey) {
      // The connection-key is the ADMIN authority — needed here to mint the agent's
      // one-time enrollment code, NOT to authenticate the agent.
      line("PLEXUS_BASE_URL set but PLEXUS_CONNECTION_KEY missing — cannot mint an enrollment code.");
      process.exit(2);
    }
    line(`[demo] using external gateway at ${base}`);
  } else {
    // CONTRACT NOTE: the gateway's host/origin guard pins `expectedHost` to
    // `config.port` at app-construction time. So we CANNOT bind `port:0` (ephemeral)
    // and then read the bound port — the guard would reject every request because
    // the bound authority wouldn't match the configured one. Instead we pick a
    // concrete free port, put it in config, and serve on exactly that port so
    // `expectedHost` == the bound authority.
    const port = await pickFreePort();
    const config = { ...loadConfig(), port } as ReturnType<typeof loadConfig>;
    const { app, state } = createAppWithState(config);

    // Register the Obsidian vault read-only capability — the real source.
    const { vaultPath, cleanup } = makeVault();
    cleanupVault = cleanup;
    const { manifest, handlers } = openVaultExtension(vaultPath);
    const reg = await state.capabilities.registerExtension(manifest, { handlers });
    if (!reg.ok) {
      line(`[demo] failed to register vault extension: ${reg.reason}`);
      process.exit(2);
    }

    const server = Bun.serve({ fetch: app.fetch, hostname: config.host, port: config.port });
    stop = () => server.stop(true);
    base = baseUrl(config);
    connectionKey = state.connectionKey.current();
    line(`[demo] booted gateway at ${base} (loopback) with vault: ${vaultPath}`);
  }

  const hostAuthority = new URL(base).host;

  // The agent's OWN per-agent PAT, learned at enroll (step 2). A fetch wrapper attaches
  // it as `Authorization: Bearer plx_agent_…` ONLY on the handshake request — the one
  // place the agent presents its bootstrap credential. Thereafter `PlexusClient` presents
  // the short-lived scoped-token itself. The admin connection-key never rides on any
  // agent request.
  let agentPat: string | undefined;
  const patInjectingFetch: FetchLike = (input, init) => {
    if (agentPat && input.includes("/link/handshake")) {
      const headers = { ...((init?.headers as Record<string, string>) ?? {}), authorization: `Bearer ${agentPat}` };
      return fetch(input, { ...init, headers });
    }
    return fetch(input, init);
  };

  const client = new PlexusClient({
    baseUrl: base,
    fetch: patInjectingFetch,
    client: { name: "min-agent-demo", version: "0.1.0", agentId: AGENT_ID },
  });

  try {
    // ── 0. ADMIN: mint the agent's one-time enrollment code (connection-key gated) ──
    // The owner provisions the agent: mint a one-time code + pre-grant the cap-set. This
    // is the ONLY use of the connection-key; what leaves for the agent is the code alone.
    step(0, "ADMIN  POST /admin/api/agents/connect (mint one-time code + pre-grant caps)");
    const { code, granted } = await mintEnrollmentCode(base, hostAuthority, connectionKey, AGENT_ID, [VAULT_READ_ID]);
    line(`minted one-time enrollment code for agentId=${AGENT_ID}: ${code.slice(0, 14)}…`);
    line(`pre-granted standing caps: ${granted.length ? granted.join(", ") : "(none)"}`);

    // ── 1. DISCOVER ──────────────────────────────────────────────────────────
    step(1, "DISCOVER  GET /.well-known/plexus");
    const wk = await client.discover();
    line(`gateway: ${wk.gateway.name} v${wk.gateway.version} (protocol ${wk.gateway.protocol})`);
    line(`discovered ${wk.capabilities.length} capability summar${wk.capabilities.length === 1 ? "y" : "ies"}:`);
    for (const s of wk.capabilities) {
      line(`  • ${s.id}  [${s.kind}, grants:${JSON.stringify(s.grants)}, ${s.transport}]`);
      line(`      ${s.summary}`);
    }

    // ── 2. ENROLL: redeem the one-time code → the agent's OWN durable PAT ───────
    step(2, "ENROLL  POST /agents/enroll { code } → per-agent PAT");
    const enrolled = await enrollAgent(base, hostAuthority, code);
    agentPat = enrolled.pat; // arms the handshake fetch wrapper above.
    line(`redeemed code → durable PAT ${enrolled.pat.slice(0, 14)}… bound to agentId=${enrolled.agentId}`);
    line(`(the one-time code is now spent; this PAT is the agent's identity from here on)`);

    // ── 3. UNDERSTAND (handshake with Bearer PAT, NOT the connection-key) ──────
    step(3, "UNDERSTAND  POST /link/handshake (Authorization: Bearer plx_agent_…)");
    // The PAT rides as the Bearer via `patInjectingFetch`; no connection-key crosses the
    // wire on this agent path (the gateway binds the session to the PAT's real agentId).
    const hs = await client.handshake("");
    line(`session: ${hs.sessionId}  (expires ${hs.expiresAt})`);
    line(`manifest: ${hs.manifest.entries.length} full entries, revision ${hs.manifest.revision}`);

    // Pick a capability by READING its describe: a read-only capability entry.
    const chosen =
      client.entry(VAULT_READ_ID) ??
      client
        .entries()
        .find((e) => e.kind === "capability" && e.grants.length === 1 && e.grants[0] === "read");
    if (!chosen) {
      throw new Error("no read-only capability found in the manifest to call");
    }
    line(`\nchose capability by reading its describe:`);
    line(`  id:       ${chosen.id}`);
    line(`  label:    ${chosen.label}`);
    line(`  grants:   ${JSON.stringify(chosen.grants)}`);
    line(`  transport:${chosen.transport}`);
    line(`  describe: ${chosen.describe}`);

    // ── 3b. Prove default-deny: an UN-GRANTED invoke must be DENIED ───────────
    // Even with the cap pre-granted as standing, a call presenting NO scoped-token is
    // denied — the agent still cannot mint its own token; it must request a grant first.
    step(3, "DEFAULT-DENY  POST /invoke (no grant held yet)");
    const denied = await client.invoke(chosen.id, { path: "Index.md" });
    if (denied.ok) {
      throw new Error("SECURITY FAILURE: un-granted invoke SUCCEEDED — default-deny broken");
    }
    line(`denied as expected: ok=${denied.ok}, error.code=${denied.error?.code}`);
    line(`  message: ${denied.error?.message}`);

    // ── 4. GRANTED ─────────────────────────────────────────────────────────────
    // Because the admin pre-granted this cap as standing at connect-time, the grant
    // short-circuits to a minted token with no per-call human approval.
    step(4, "GRANTED  PUT /grants (request read)");
    const token = await client.requestGrants([chosen.id]); // bare allow → read-only default
    line(`scoped-token jti=${token.jti}  (expires ${token.expiresAt})`);
    line(`scopes: ${JSON.stringify(token.scopes)}`);

    // ── 5. CALL ────────────────────────────────────────────────────────────────
    step(5, "CALL  POST /invoke (granted read)");
    const out = await client.invokeOrThrow(chosen.id, { path: "Projects/Plexus.md" });
    line(`ok=${out.ok}  auditId=${out.auditId}`);
    const data = out.output as { type?: string; relativePath?: string; content?: string };
    line(`read: ${data.relativePath}`);
    line("─── note content ───");
    line(String(data.content ?? "").trimEnd());
    line("────────────────────");

    line(
      "\n✓ FULL LOOP COMPLETE: admin-mint-code → enroll (own PAT) → handshake (Bearer PAT) →\n" +
        "  grant → invoke returned REAL note content, and the un-granted invoke was DENIED\n" +
        "  (grant_required). The agent authenticated with its OWN per-agent credential — it\n" +
        "  never held the admin connection-key.",
    );
  } catch (err) {
    if (err instanceof PlexusProtocolError) {
      line(`\n✗ protocol error [${err.code}]: ${err.message}`);
    } else {
      line(`\n✗ ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
    process.exitCode = 1;
  } finally {
    stop();
    cleanupVault();
    line(`[demo] gateway stopped @ ${baseUrl(loadConfig()).replace(/:\d+$/, "")} (demo over)`);
  }
}

await main();
