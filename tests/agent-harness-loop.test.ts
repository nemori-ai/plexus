/**
 * t12 — minimal AI-agent protocol HARNESS test.
 *
 * Drives the standalone agent-side `PlexusClient` (examples/min-agent/client.ts)
 * against the REAL booted gateway (in-process Hono app via `app.request`, which is
 * fetch-shaped) with a registered Obsidian vault read-only source, exercising the
 * FULL protocol loop the way an external AI agent would:
 *
 *     discover → handshake → request a read grant → invoke
 *
 * Asserts, as a real protocol consumer:
 *   - discovery (`.well-known`) returns capability SUMMARIES,
 *   - handshake returns the FULL manifest (entries with describe/io/grants),
 *   - a GRANTED read returns REAL note content,
 *   - an UN-GRANTED invoke is DENIED with `grant_required` (a real default-deny
 *     assertion — no fake-green),
 *   - the client always sends the correct `Host` header (an arbitrary Host is
 *     rejected `host_forbidden`).
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { loadConfig } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import {
  openVaultExtension,
  VAULT_READ_ID,
  VAULT_SKILL_ID,
} from "@plexus/runtime/sources/obsidian/open-vault.ts";

import { PlexusClient, PlexusProtocolError, isGrantPending } from "../examples/min-agent/client.ts";

const config = loadConfig();
const HOST = `${config.host}:${config.port}`;
const BASE = `http://${HOST}`;
const tmpDirs: string[] = [];

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete process.env.PLEXUS_HOME;
});

/** A fresh gateway (real state) with an Obsidian vault read-only source registered. */
async function bootGatewayWithVault() {
  const home = mkdtempSync(join(tmpdir(), "plexus-harness-home-"));
  tmpDirs.push(home);
  process.env.PLEXUS_HOME = home;
  _resetSecretCacheForTests();

  const vaultRoot = mkdtempSync(join(tmpdir(), "plexus-harness-vault-"));
  tmpDirs.push(vaultRoot);
  const vaultPath = join(vaultRoot, "Vault");
  mkdirSync(join(vaultPath, "Daily"), { recursive: true });
  writeFileSync(join(vaultPath, "Index.md"), "# Index\nThe vault index.\n");
  writeFileSync(
    join(vaultPath, "Daily", "2026-06-23.md"),
    "# 2026-06-23\nThe agent read this real note over the protocol.\n",
  );

  const { app, state } = createAppWithState(config);
  const { manifest, handlers } = openVaultExtension(vaultPath);
  const reg = await state.capabilities.registerExtension(manifest, { handlers });
  expect(reg.ok).toBe(true);

  return { app, state, vaultPath };
}

/** A Hono-app-shaped value whose `request` is fetch-shaped (Response or Promise). */
type RequestableApp = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

/**
 * Build a `PlexusClient` whose injected fetch is the gateway's `app.request`. The
 * client adds the `Host` header itself; we assert that by NOT adding it here.
 */
function clientFor(app: RequestableApp) {
  return new PlexusClient({
    baseUrl: BASE,
    fetch: async (input, init) => app.request(input, init),
    client: { name: "agent-harness", version: "0.1.0", agentId: "agent-harness-1" },
  });
}

describe("t12 agent harness — full discover→handshake→grant→invoke loop (Obsidian read)", () => {
  it("discovery returns capability summaries", async () => {
    const { app } = await bootGatewayWithVault();
    const client = clientFor(app);

    const wk = await client.discover();
    expect(wk.gateway.name).toBe("plexus");
    expect(Array.isArray(wk.capabilities)).toBe(true);
    const summary = wk.capabilities.find((s) => s.id === VAULT_READ_ID);
    expect(summary).toBeDefined();
    // A SUMMARY: id/kind/grants/transport present, no full io/describe/skill body.
    expect(summary?.kind).toBe("capability");
    expect(summary?.grants).toEqual(["read"]);
    expect(summary).not.toHaveProperty("io");
    expect(summary).not.toHaveProperty("body");
    // The auth advertisement carries the endpoint URLs the agent reads from.
    expect(wk.auth.handshakeUrl).toContain("/link/handshake");
    expect(wk.auth.invokeUrl).toContain("/invoke");
  });

  it("handshake returns the full manifest (entries with describe/io/grants)", async () => {
    const { app, state } = await bootGatewayWithVault();
    const client = clientFor(app);
    await client.discover();

    const hs = await client.handshake(state.connectionKey.current());
    expect(hs.sessionId).toBeTruthy();
    expect(hs.manifest.entries.length).toBeGreaterThan(0);

    const entry = client.entry(VAULT_READ_ID);
    expect(entry).toBeDefined();
    expect(entry?.describe.length).toBeGreaterThan(0); // the HEART — full describe
    expect(entry?.io?.input).toBeDefined(); // full io schema (absent from summaries)
    expect(entry?.grants).toEqual(["read"]);
    // The bundled how-to skill is discoverable and back-linked.
    const skill = client.entry(VAULT_SKILL_ID);
    expect(skill?.kind).toBe("skill");
    expect(entry?.skills?.some((s) => s.id === VAULT_SKILL_ID)).toBe(true);
  });

  it("a GRANTED read returns REAL note content (the end-to-end proof)", async () => {
    const { app, state } = await bootGatewayWithVault();
    const client = clientFor(app);

    await client.discover();
    await client.handshake(state.connectionKey.current());

    // Pick the capability by reading its describe — the read-only Obsidian vault
    // read whose describe says it returns the user's note text. (The default
    // registry may carry other read capabilities, e.g. sysinfo.resources.read; the
    // agent chooses by intent, reading describe, not "the first read it finds".)
    const chosen = client
      .entries()
      .find(
        (e) =>
          e.kind === "capability" &&
          e.grants.length === 1 &&
          e.grants[0] === "read" &&
          e.describe.toLowerCase().includes("obsidian vault"),
      );
    expect(chosen?.id).toBe(VAULT_READ_ID);

    const token = await client.requestGrants([chosen!.id]); // bare allow → read-only default
    expect(isGrantPending(token as never)).toBe(false);
    expect(token.scopes).toEqual([{ id: VAULT_READ_ID, verbs: ["read"] }]);

    const out = await client.invokeOrThrow(chosen!.id, { path: "Daily/2026-06-23.md" });
    expect(out.ok).toBe(true);
    const data = out.output as { type: string; content: string; relativePath: string };
    expect(data.type).toBe("file");
    expect(data.content).toContain("The agent read this real note over the protocol");
    expect(data.relativePath).toBe("Daily/2026-06-23.md");

    // Listing (omit path) enumerates the vault — real directory read.
    const listed = await client.invokeOrThrow(chosen!.id, {});
    const dir = listed.output as { type: string; entries: { name: string }[] };
    expect(dir.type).toBe("dir");
    expect(dir.entries.map((e) => e.name)).toContain("Index.md");
  });

  it("an UN-GRANTED invoke is DENIED with grant_required (real default-deny)", async () => {
    const { app, state } = await bootGatewayWithVault();
    const client = clientFor(app);

    await client.discover();
    await client.handshake(state.connectionKey.current());

    // Handshake gives the agent a session + manifest but ZERO call authority.
    // Mint a token for NOTHING is impossible; instead we invoke WITHOUT having
    // requested any grant — the agent holds no token at all.
    expect(client.getToken()).toBeUndefined();

    const denied = await client.invoke(VAULT_READ_ID, { path: "Index.md" });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("grant_required");
    // The secret/content is NOT returned in a denial.
    expect(JSON.stringify(denied)).not.toContain("vault index");

    // And `invokeOrThrow` surfaces it as a typed protocol error the agent branches on.
    await expect(client.invokeOrThrow(VAULT_READ_ID, { path: "Index.md" })).rejects.toThrow(
      PlexusProtocolError,
    );
  });

  it("a granted token does NOT authorize a DIFFERENT un-granted capability", async () => {
    const { app, state } = await bootGatewayWithVault();
    const client = clientFor(app);
    await client.discover();
    await client.handshake(state.connectionKey.current());
    // Grant ONLY the read capability.
    await client.requestGrants([VAULT_READ_ID]);

    // The skill entry is not a callable capability id with the same scope; invoking
    // a non-granted id (the skill) with the held token must still be denied.
    const denied = await client.invoke(VAULT_SKILL_ID, {});
    expect(denied.ok).toBe(false);
    // grant_required (no scope) or unknown_capability (skill not invocable) — either
    // way it is NOT a successful, authorized read of an un-granted id.
    expect(["grant_required", "unknown_capability", "transport_error"]).toContain(
      denied.error?.code ?? "",
    );
  });

  it("the client sends the correct Host header; an arbitrary Host is rejected", async () => {
    const { app, state } = await bootGatewayWithVault();

    // The PlexusClient sends Host == the bound loopback authority → accepted.
    const good = clientFor(app);
    const wk = await good.discover();
    expect(wk.gateway.name).toBe("plexus");

    // A hand-rolled request with a bogus Host is rejected by the guard BEFORE auth.
    const bad = await app.request(BASE + "/link/handshake", {
      method: "POST",
      headers: { host: "evil.example.com", "content-type": "application/json" },
      body: JSON.stringify({ connectionKey: state.connectionKey.current() }),
    });
    expect(bad.status).toBe(403);
    const body = (await bad.json()) as { error: { code: string } };
    expect(body.error.code).toBe("host_forbidden");
  });
});
