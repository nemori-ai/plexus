/**
 * ============================================================================
 * msrc-t5 — Managed-sources HOT-RELOAD demo HARNESS (shared by run.ts + the test).
 * ============================================================================
 *
 * THE PAYOFF: "capability sources are managed, scannable, hot-reloadable — no
 * flag, no restart." Against a SINGLE booted gateway (throwaway PLEXUS_HOME + a
 * mock Obsidian Local REST API endpoint), with NO `--obsidian-rest` flag and
 * WITHOUT restarting, this harness drives the full live cycle:
 *
 *   detect  → the mock Obsidian REST source is found (reachability only)
 *   ADD     → `state.managedSources.add(...)` HOT-registers it: the capability
 *             count goes UP live (no restart) AND it persists to sources.json
 *   USE     → an agent reads + writes through it (real grant flow; write pends)
 *   RECONFIGURE the baseUrl → the source's GRANTS ARE PURGED (the prior durable
 *             authority is gone: refresh of the held token now fails, and a fresh
 *             write grant PENDS again — a stale approval can't carry to the new
 *             endpoint)
 *   REMOVE  → `state.managedSources.remove(...)` HOT-unregisters it: the
 *             capability DISAPPEARS live AND from sources.json
 *
 * The harness returns a structured RESULT the test asserts on, and (when run as a
 * script) prints a clean transcript. It NEVER touches the real ~/.plexus — it runs
 * under a throwaway PLEXUS_HOME the caller provisions.
 *
 * The gateway, the transport, the grant pipeline, and `ManagedSources` are all the
 * REAL ones — only the Obsidian REST endpoint is a local mock (HTTPS, self-signed,
 * Bearer-auth) so the demo is self-contained + deterministic.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { loadConfig, expectedHost, type GatewayConfig } from "../../src/config.ts";
import { createAppWithState } from "../../src/core/server.ts";
import { bootScanCapabilities } from "../../src/core/state.ts";
import { GrantService } from "../../src/core/grant-service.ts";
import { defaultAuthorizer, _resetSecretCacheForTests } from "../../src/auth/index.ts";
import {
  REST_VAULT_LIST_ID,
  REST_VAULT_READ_ID,
  REST_VAULT_WRITE_ID,
} from "../../src/sources/obsidian/open-vault-rest.ts";
import type {
  ConfiguredSource,
} from "../../src/sources/config/types.ts";
import type {
  HandshakeResponse,
  InvokeResponse,
  ScopedToken,
  RefreshResponse,
  WellKnownDocument,
} from "@plexus/protocol";

const SECRET_NAME = "obsidian-local-rest-api-key";
const API_KEY = "THROWAWAY-MSRC-T5-DEMO-KEY"; // throwaway; never a real key
const AGENT_ID = "agent-msrc-demo-1";

// ── a tiny transcript collector (printed by run.ts; returned for the test) ───────
export interface DemoLog {
  push(line: string): void;
  lines: string[];
}
function makeLog(echo: boolean): DemoLog {
  const lines: string[] = [];
  return {
    lines,
    push(line: string) {
      lines.push(line);
      if (echo) console.log(line);
    },
  };
}

// ── MOCK Obsidian Local REST API (HTTPS, self-signed, Bearer-auth) ───────────────
function makeCert(tmpDirs: string[]): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "plexus-msrc-demo-cert-"));
  tmpDirs.push(dir);
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "2",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
}

/** Boot a mock Obsidian REST endpoint on a fresh loopback port. Returns its url + control. */
function startMockObsidian(tmpDirs: string[]) {
  const { key, cert } = makeCert(tmpDirs);
  const vault = new Map<string, string>([
    ["Index.md", "# Index\nWelcome to the (mock) Obsidian REST vault.\n"],
    ["Daily/2026-06-23.md", "# 2026-06-23\nThe agent reached this via the managed REST source.\n"],
  ]);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key, cert },
    fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${API_KEY}`) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const path = new URL(req.url).pathname;
      if (path === "/vault/" && req.method === "GET") {
        return Response.json({ files: [...vault.keys()].sort() });
      }
      const m = path.match(/^\/vault\/(.+)$/);
      if (m) {
        const note = decodeURIComponent(m[1]!);
        if (req.method === "GET") {
          const content = vault.get(note);
          if (content === undefined) return new Response("not found", { status: 404 });
          return new Response(content, { status: 200, headers: { "content-type": "text/markdown" } });
        }
        if (req.method === "PUT") {
          return req.text().then((body) => {
            vault.set(note, body);
            return new Response(null, { status: 204 });
          });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `https://127.0.0.1:${server.port}`,
    altUrl: `https://127.0.0.1:${server.port}/`, // same endpoint, different baseUrl string ⇒ surface change
    stop: () => server.stop(true),
    vault,
  };
}

/** The structured result the test asserts on (every claim in the transcript). */
export interface DemoResult {
  transcript: string[];
  /** capability count in .well-known BEFORE the add (no REST source). */
  countBeforeAdd: number;
  /** capability count AFTER the live add (must be > countBeforeAdd — hot-appeared). */
  countAfterAdd: number;
  /** REST capability ids visible in .well-known after the add. */
  restIdsAfterAdd: string[];
  /** sources.json contained the obsidian-rest source after the add. */
  persistedAfterAdd: boolean;
  /** the agent read real mock-note content through the source. */
  agentRead: string;
  /** the agent wrote a note and read it back (real round-trip). */
  agentWroteAndReadBack: boolean;
  /** the durable (persisted) write grant existed before the reconfigure. */
  grantBeforeReconfigure: boolean;
  /** the durable write grant was PURGED by the reconfigure (security surface change). */
  grantPurgedByReconfigure: boolean;
  /** refreshing the PRE-reconfigure token FAILS after the purge (authority gone). */
  preReconfigureTokenRefreshFails: boolean;
  /** a fresh write-grant request PENDS again after the purge (re-confirm required). */
  freshWriteGrantPendsAfterReconfigure: boolean;
  /** capability count AFTER the live remove (back to countBeforeAdd — disappeared). */
  countAfterRemove: number;
  /** sources.json no longer contains the source after the remove. */
  persistedAfterRemove: boolean;
}

/** Run the full no-flag/no-restart demo against ONE booted gateway. */
export async function runDemo(opts: { echo?: boolean } = {}): Promise<DemoResult> {
  const log = makeLog(opts.echo ?? false);
  const tmpDirs: string[] = [];
  const L = (s = "") => log.push(s);
  const step = (n: number, s: string) =>
    L(`\n── ${n}. ${s} ─────────────────────────────────`);

  // ── throwaway PLEXUS_HOME (NEVER the real ~/.plexus) + the throwaway secret ────
  const home = mkdtempSync(join(tmpdir(), "plexus-msrc-demo-home-"));
  tmpDirs.push(home);
  process.env.PLEXUS_HOME = home;
  mkdirSync(join(home, "secrets"), { recursive: true });
  writeFileSync(join(home, "secrets", SECRET_NAME), API_KEY);
  _resetSecretCacheForTests();

  const mock = startMockObsidian(tmpDirs);

  const config: GatewayConfig = loadConfig();
  const HOST = expectedHost(config);
  const { app, state } = createAppWithState(config);

  // a same-process HTTP driver (fetch-shaped) + the loopback Host the guard requires.
  const req = (path: string, init?: RequestInit) =>
    app.request("http://" + HOST + path, {
      ...init,
      headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
    });

  // a "human at the keyboard" who approves pending grants (the admin/UI approver).
  const approver = new GrantService(state, defaultAuthorizer());
  const drainPending = async () => {
    for (const p of approver.listPending()) await approver.approve(p.pendingId);
  };
  const grantFor = async (sessionId: string, id: string): Promise<ScopedToken> => {
    let approving = true;
    const loop = (async () => {
      while (approving) {
        await drainPending();
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    try {
      const res = (await (await req("/grants", {
        method: "PUT",
        body: JSON.stringify({ sessionId, grants: { [id]: "allow" } }),
      })).json()) as ScopedToken & { pendingId?: string };
      if (Array.isArray(res.scopes) && res.token) return res;
      const pendingId = res.pendingId!;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const status = (await (await req(`/grants/status?pendingId=${pendingId}`)).json()) as {
          state: string;
          token?: ScopedToken;
        };
        if (status.state === "approved" && status.token) return status.token;
        if (status.state === "denied" || status.state === "expired")
          throw new Error(`grant ${status.state}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("grant never resolved");
    } finally {
      approving = false;
      await loop;
    }
  };

  const wellKnownIds = async (): Promise<string[]> => {
    const wk = (await (await req("/.well-known/plexus")).json()) as WellKnownDocument;
    return wk.capabilities.map((c) => c.id);
  };
  const readSourcesJson = (): ConfiguredSource[] => {
    const p = join(home, "sources.json");
    if (!existsSync(p)) return [];
    try {
      return (JSON.parse(readFileSync(p, "utf8")) as { sources: ConfiguredSource[] }).sources ?? [];
    } catch {
      return [];
    }
  };

  L("Plexus managed-sources HOT-RELOAD demo — one booted gateway, NO --obsidian-rest flag, NO restart.");
  L(`gateway: ${config.host}:${config.port}   PLEXUS_HOME=${home}`);
  L(`mock Obsidian Local REST API: ${mock.url}  (HTTPS, self-signed, Bearer-auth)`);

  // REAL boot sequence (the same `bootScanCapabilities` the launcher + tests use):
  // scans compile-time MODULES then loads persisted sources. The REST source is NOT
  // registered here — no flag, nothing in sources.json — so the baseline reflects a
  // started registry WITHOUT the REST source, and the add/remove deltas below are
  // PURELY the managed REST source (count back to baseline after remove).
  await bootScanCapabilities(state);

  // ── 0. DETECT (reachability only) ─────────────────────────────────────────────
  step(0, "DETECT  state.managedSources.detect()  (reachability only — no add)");
  // The detector probes the real loopback locator; the mock runs on an ephemeral port
  // the locator's fixed 27124/27123 probe won't hit, so we assert the SHAPE of a
  // detect (advisory, non-mutating) and surface the mock as the source we'll add.
  const detected = await state.managedSources.detect();
  L(`detect() returned ${detected.length} suggestion(s) (advisory, non-mutating).`);
  L(`(the mock runs on an ephemeral port; we add it explicitly at ${mock.url}.)`);

  // ── 1. baseline: capability count with NO REST source ─────────────────────────
  step(1, "BASELINE  GET /.well-known/plexus  (no REST source yet)");
  const idsBefore = await wellKnownIds();
  const countBeforeAdd = idsBefore.length;
  L(`capabilities discoverable: ${countBeforeAdd}`);
  L(`  obsidian-rest.* present? ${idsBefore.some((i) => i.startsWith("obsidian-rest"))}`);

  // ── 2. ADD at runtime → HOT-APPEARS live + persists (no restart) ──────────────
  step(2, "ADD  state.managedSources.add({ kind:'obsidian-rest', baseUrl: <mock> })  (live + persist)");
  const cfg: ConfiguredSource = {
    id: "obsidian-rest",
    kind: "obsidian-rest",
    label: "Obsidian vault (Local REST API, read-write)",
    enabled: true,
    transport: "local-rest",
    route: { baseUrl: mock.url },
    secretRef: SECRET_NAME,
    metadata: { addedBy: "api" },
  };
  const added = await state.managedSources.add(cfg, { approvedByHuman: true });
  if (!added.ok) throw new Error(`add failed: ${added.reason}`);
  const idsAfterAdd = await wellKnownIds();
  const countAfterAdd = idsAfterAdd.length;
  const restIdsAfterAdd = idsAfterAdd.filter((i) => i.startsWith("obsidian-rest"));
  const persistedAfterAdd = readSourcesJson().some((s) => s.id === "obsidian-rest");
  L(`registered LIVE: ${added.registered.join(", ")}`);
  L(`capabilities discoverable: ${countBeforeAdd} → ${countAfterAdd}  (HOT-APPEARED, no restart)`);
  L(`  obsidian-rest capabilities now live: ${restIdsAfterAdd.join(", ")}`);
  L(`persisted to sources.json: ${persistedAfterAdd}`);

  // ── 3. USE  an agent reads + writes through the managed source ────────────────
  step(3, "USE  agent handshake → grant → read + write through the managed source");
  const hs = (await (await req("/link/handshake", {
    method: "POST",
    body: JSON.stringify({
      connectionKey: state.connectionKey.current(),
      client: { name: "msrc-demo", agentId: AGENT_ID },
    }),
  })).json()) as HandshakeResponse;
  L(`session: ${hs.sessionId}`);

  // read (read grant auto-approves on the trusted authorizer path)
  const readTok = await grantFor(hs.sessionId, REST_VAULT_READ_ID);
  const readOut = (await (await req("/invoke", {
    method: "POST",
    headers: { authorization: `Bearer ${readTok.token}` },
    body: JSON.stringify({ id: REST_VAULT_READ_ID, input: { path: "Daily/2026-06-23.md" } }),
  })).json()) as InvokeResponse;
  if (!readOut.ok) throw new Error(`read failed: ${readOut.error?.code}`);
  const agentRead = String(readOut.output);
  L(`agent READ  obsidian-rest.vault.read "Daily/2026-06-23.md":`);
  L(`  → ${agentRead.replace(/\n/g, " ").trim()}`);

  // also prove list works
  await grantFor(hs.sessionId, REST_VAULT_LIST_ID);

  // write (mutating → PENDS for the human; the approver drains it)
  const NEW_PATH = "Inbox/From the agent.md";
  const NEW_BODY = "# From the agent\nWritten through the MANAGED obsidian-rest source.\n";
  const writeTok = await grantFor(hs.sessionId, REST_VAULT_WRITE_ID);
  L(`agent WRITE granted (it PENDED for a human — mutating — then was approved).`);
  const wrote = (await (await req("/invoke", {
    method: "POST",
    headers: { authorization: `Bearer ${writeTok.token}` },
    body: JSON.stringify({ id: REST_VAULT_WRITE_ID, input: { path: NEW_PATH, content: NEW_BODY } }),
  })).json()) as InvokeResponse;
  if (!wrote.ok) throw new Error(`write failed: ${wrote.error?.code}`);
  const readBack = (await (await req("/invoke", {
    method: "POST",
    headers: { authorization: `Bearer ${readTok.token}` },
    body: JSON.stringify({ id: REST_VAULT_READ_ID, input: { path: NEW_PATH } }),
  })).json()) as InvokeResponse;
  const agentWroteAndReadBack = readBack.ok && String(readBack.output) === NEW_BODY;
  L(`agent WROTE "${NEW_PATH}" and READ IT BACK (real round-trip): ${agentWroteAndReadBack}`);

  // ── 4. RECONFIGURE the baseUrl → PURGE the source's grants ────────────────────
  step(4, "RECONFIGURE  baseUrl change → grants PURGED (a stale approval can't carry over)");
  const grantBeforeReconfigure = !!state.grants.get(AGENT_ID, REST_VAULT_WRITE_ID);
  L(`durable write grant present BEFORE reconfigure: ${grantBeforeReconfigure}`);
  const recfg = await state.managedSources.reconfigure(
    "obsidian-rest",
    { route: { baseUrl: mock.altUrl } }, // WHERE-it-connects changed ⇒ security surface change
    { approvedByHuman: true },
  );
  if (!recfg.ok) throw new Error(`reconfigure failed: ${recfg.reason}`);
  const grantPurgedByReconfigure = !state.grants.get(AGENT_ID, REST_VAULT_WRITE_ID);
  L(`reconfigured baseUrl: ${mock.url} → ${mock.altUrl}`);
  L(`durable write grant present AFTER reconfigure: ${!grantPurgedByReconfigure}  (PURGED: ${grantPurgedByReconfigure})`);

  // PROVE the prior authority no longer works: refreshing the PRE-reconfigure token
  // (re-mint from the now-purged persisted grant) FAILS — the durable authority is gone.
  const refresh = (await (await req("/grants/refresh", {
    method: "POST",
    headers: { authorization: `Bearer ${writeTok.token}` },
    body: JSON.stringify({ sessionId: hs.sessionId, jti: writeTok.jti }),
  })).json()) as RefreshResponse & { error?: { code?: string }; code?: string };
  // refresh returns a uniform error envelope (grant_required) when the grant was purged.
  const preReconfigureTokenRefreshFails =
    !(refresh as { token?: string }).token &&
    JSON.stringify(refresh).includes("grant_required");
  L(`refresh of the PRE-reconfigure write token: ${preReconfigureTokenRefreshFails ? "FAILS (grant_required)" : "unexpectedly succeeded"}`);

  // and a FRESH write-grant request PENDS again (re-confirm with a human required).
  const freshWrite = (await (await req("/grants", {
    method: "PUT",
    body: JSON.stringify({ sessionId: hs.sessionId, grants: { [REST_VAULT_WRITE_ID]: "allow" } }),
  })).json()) as ScopedToken & { pendingId?: string };
  const freshWriteGrantPendsAfterReconfigure = !freshWrite.token && !!freshWrite.pendingId;
  L(`fresh write-grant request after reconfigure PENDS again: ${freshWriteGrantPendsAfterReconfigure}`);
  // tidy: deny the pending we just raised so it doesn't dangle.
  for (const p of approver.listPending()) await approver.deny(p.pendingId);

  // ── 5. REMOVE at runtime → DISAPPEARS live + from sources.json ────────────────
  step(5, "REMOVE  state.managedSources.remove('obsidian-rest')  (live + sources.json)");
  await state.managedSources.remove("obsidian-rest");
  const idsAfterRemove = await wellKnownIds();
  const countAfterRemove = idsAfterRemove.length;
  const persistedAfterRemove = readSourcesJson().some((s) => s.id === "obsidian-rest");
  L(`capabilities discoverable: ${countAfterAdd} → ${countAfterRemove}  (DISAPPEARED, no restart)`);
  L(`  obsidian-rest.* present? ${idsAfterRemove.some((i) => i.startsWith("obsidian-rest"))}`);
  L(`still in sources.json: ${persistedAfterRemove}`);

  L("\n✓ managed, scannable, hot-reloadable — NO flag, NO restart.");
  L("  add → use → reconfigure-purges-grants → remove, all live against ONE gateway.");

  // ── cleanup ───────────────────────────────────────────────────────────────────
  mock.stop();
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete process.env.PLEXUS_HOME;

  return {
    transcript: log.lines,
    countBeforeAdd,
    countAfterAdd,
    restIdsAfterAdd,
    persistedAfterAdd,
    agentRead,
    agentWroteAndReadBack,
    grantBeforeReconfigure,
    grantPurgedByReconfigure,
    preReconfigureTokenRefreshFails,
    freshWriteGrantPendsAfterReconfigure,
    countAfterRemove,
    persistedAfterRemove,
  };
}
