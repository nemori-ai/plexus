/**
 * ============================================================================
 * Plexus minimal AI-agent — runnable end-to-end demo (t12).
 * ============================================================================
 *
 * THE PROOF: "any AI agent can self-discover and call a local capability."
 *
 * This script boots a REAL Plexus gateway (`Bun.serve`, loopback), registers an
 * Obsidian vault read-only capability (a temp vault of `.md` notes — the real
 * `obsidian.vault.read` source), and then — talking ONLY the published protocol
 * over real HTTP `fetch` through `PlexusClient` — performs the WHOLE loop:
 *
 *     1. DISCOVER   GET  /.well-known/plexus     → capability summaries
 *     2. UNDERSTAND POST /link/handshake         → full manifest; pick a cap by `describe`
 *     3. GRANTED    PUT  /grants                 → scoped read token
 *     4. CALL       POST /invoke                 → REAL note content
 *     (+ a deliberate UN-GRANTED invoke to show the gateway DENIES it.)
 *
 * Run:  bun run examples/min-agent/run.ts
 *
 * The script self-contains its gateway (no external setup) so it always shows a
 * real end-to-end read. Pass `PLEXUS_BASE_URL` to instead point at an already-
 * running gateway, and `PLEXUS_CONNECTION_KEY` to supply its connection-key.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, baseUrl } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { openVaultExtension, VAULT_READ_ID } from "@plexus/runtime/sources/obsidian/open-vault.ts";

import { PlexusClient, PlexusProtocolError } from "./client.ts";

// ── tiny pretty-printer ────────────────────────────────────────────────────────
const line = (s = "") => console.log(s);
const step = (n: number, s: string) => console.log(`\n── ${n}. ${s} ──────────────────────────`);

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
      line("PLEXUS_BASE_URL set but PLEXUS_CONNECTION_KEY missing — cannot handshake.");
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

  const client = new PlexusClient({
    baseUrl: base,
    client: { name: "min-agent-demo", version: "0.1.0", agentId: "agent-demo-1" },
  });

  try {
    // ── 1. DISCOVER ──────────────────────────────────────────────────────────
    step(1, "DISCOVER  GET /.well-known/plexus");
    const wk = await client.discover();
    line(`gateway: ${wk.gateway.name} v${wk.gateway.version} (protocol ${wk.gateway.protocol})`);
    line(`discovered ${wk.capabilities.length} capability summar${wk.capabilities.length === 1 ? "y" : "ies"}:`);
    for (const s of wk.capabilities) {
      line(`  • ${s.id}  [${s.kind}, grants:${JSON.stringify(s.grants)}, ${s.transport}]`);
      line(`      ${s.summary}`);
    }

    // ── 2. UNDERSTAND ────────────────────────────────────────────────────────
    step(2, "UNDERSTAND  POST /link/handshake");
    const hs = await client.handshake(connectionKey);
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

    // ── 2b. Prove default-deny: an UN-GRANTED invoke must be DENIED ───────────
    step(2, "DEFAULT-DENY  POST /invoke (no grant held yet)");
    const denied = await client.invoke(chosen.id, { path: "Index.md" });
    if (denied.ok) {
      throw new Error("SECURITY FAILURE: un-granted invoke SUCCEEDED — default-deny broken");
    }
    line(`denied as expected: ok=${denied.ok}, error.code=${denied.error?.code}`);
    line(`  message: ${denied.error?.message}`);

    // ── 3. GRANTED ─────────────────────────────────────────────────────────────
    step(3, "GRANTED  PUT /grants (request read)");
    const token = await client.requestGrants([chosen.id]); // bare allow → read-only default
    line(`scoped-token jti=${token.jti}  (expires ${token.expiresAt})`);
    line(`scopes: ${JSON.stringify(token.scopes)}`);

    // ── 4. CALL ────────────────────────────────────────────────────────────────
    step(4, "CALL  POST /invoke (granted read)");
    const out = await client.invokeOrThrow(chosen.id, { path: "Projects/Plexus.md" });
    line(`ok=${out.ok}  auditId=${out.auditId}`);
    const data = out.output as { type?: string; relativePath?: string; content?: string };
    line(`read: ${data.relativePath}`);
    line("─── note content ───");
    line(String(data.content ?? "").trimEnd());
    line("────────────────────");

    line(
      "\n✓ FULL LOOP COMPLETE: discover → handshake → grant → invoke returned REAL note content,\n" +
        "  and the un-granted invoke was DENIED (grant_required). Any agent speaking the\n" +
        "  Plexus protocol can self-discover and call a local capability.",
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
