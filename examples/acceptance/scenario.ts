/**
 * ============================================================================
 * Plexus 1.0-rc ACCEPTANCE SCENARIO — "codex agent integrates Plexus, creates
 * content with cc-master, and writes it into Obsidian."  (the玩法 / playthrough)
 * ============================================================================
 *
 * THE STORY (user-perspective, end-to-end, HERMETIC + REPEATABLE):
 *
 *   A user wires a **codex agent** into Plexus. Plexus already ships an Obsidian
 *   vault READ source — but NO write. The codex agent therefore AUTHORS a small
 *   `ExtensionManifest` that adds a **vault WRITE capability** (`notes-writer.vault.write`)
 *   backed by a tiny loopback HTTP "writing service" (stands in for the user's
 *   local Obsidian REST / write daemon). That extension is transport-backed, so it
 *   PENDS — the human approves it — and it goes LIVE. The agent then requests grants
 *   (read / write / the cc-master orchestration entry), invokes cc-master to "create
 *   content" (in record-only mode — no real `claude` spawn, fully offline), reads the
 *   existing vault context, and WRITES the composed note into Obsidian through the
 *   newly-created write capability. Finally the harness reviews the audit chain and
 *   REVOKES the write grant, proving the old token is now rejected (`token_revoked`).
 *
 * Everything runs through the REAL gateway pipeline (real handshake → real extension
 * register+approve → real grants+approve → real token mint → real invoke → real audit
 * → real revoke). The only things "scripted" are the codex agent itself (this file,
 * faithfully doing what codex would do over the HTTP API) and the human approvals
 * (a background loop that approves pending items — modeling the user clicking
 * "Approve" in the management UI).
 *
 * HERMETICITY:
 *   - temp `PLEXUS_HOME` (signing secret + audit + cc-master boards live here),
 *   - temp Obsidian vault dir (seeded with a couple notes),
 *   - the gateway runs IN-PROCESS via `app.request` (fetch-shaped; same pipeline,
 *     no socket — never binds :7077),
 *   - the loopback write-server is an ephemeral `Bun.serve` on 127.0.0.1:0,
 *   - cc-master runs in RECORD-ONLY mode (`PLEXUS_CC_HEADLESS_LAUNCH` unset) so it
 *     records the dispatch + returns the argv it WOULD run, never spawning `claude`,
 *   - `claude` presence is FAKED at the platform seam (`resolveBinary`) so the
 *     scenario does NOT depend on a real `claude` binary being installed.
 *
 * This module is BOTH a runnable demo (`run.ts` calls `runScenario` + prints the
 * transcript) AND the engine `tests/acceptance-e2e.test.ts` asserts against (it
 * returns a structured `ScenarioReport` of the genuine facts).
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createSourceRegistry } from "@plexus/runtime/core/registry.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { GrantService } from "@plexus/runtime/core/grant-service.ts";
import { _resetSecretCacheForTests, defaultAuthorizer } from "@plexus/runtime/auth/index.ts";
import { getPlatformServices } from "@plexus/runtime/platform/index.ts";
import { writeCcMasterConfig } from "@plexus/runtime/sources/cc-master/config.ts";
import {
  VAULT_READ_ID,
  VAULT_SKILL_ID,
} from "@plexus/runtime/sources/obsidian/open-vault.ts";
import { AGENT_DISPATCH_ID } from "@plexus/runtime/sources/cc-master/entries.ts";

import type {
  PlatformServices,
  ExtensionManifest,
  HandshakeResponse,
  InvokeResponse,
  ScopedToken,
  AuditEvent,
} from "@plexus/protocol";

// ── identifiers the codex agent's authored extension contributes ──────────────────
export const WRITER_SOURCE_ID = "notes-writer";
export const WRITER_WRITE_ID = "notes-writer.vault.write";
export const SECRET_NAME = "notes-writer-api-key";
const WRITER_API_KEY = "THROWAWAY-WRITER-KEY-acceptance"; // throwaway; never a real key

// ──────────────────────────────────────────────────────────────────────────────────
// Reporting shapes — the genuine facts the test asserts against.
// ──────────────────────────────────────────────────────────────────────────────────

export interface StepCheck {
  ok: boolean;
  label: string;
  detail?: string;
}

export interface ScenarioReport {
  pass: boolean;
  checks: StepCheck[];
  /** The session id from the handshake. */
  sessionId: string;
  /** The extension manifest the codex-harness authored (for the report). */
  authoredManifest: ExtensionManifest;
  /** The capability ids the write-extension registered. */
  registeredWriteCaps: string[];
  /** The granted capability ids (read / write / cc-master dispatch). */
  grantedCaps: string[];
  /** The cc-master record-mode dispatch output (honest record, not a spawned run). */
  ccDispatch: Record<string, unknown>;
  /** The path + content actually written into the temp vault. */
  written: { path: string; content: string };
  /** What a read-back of that note returned through obsidian.vault.read. */
  readBack: string;
  /** The temp vault dir (for the transcript). */
  vaultPath: string;
  /** The temp PLEXUS_HOME (for the transcript). */
  plexusHome: string;
  /** The full audit chain (ordered, oldest→newest). */
  audit: AuditEvent[];
  /** A compact "kind @ capability (outcome)" summary of the audit chain. */
  auditSummary: string[];
  /** The post-revoke re-invoke result (must be a denial). */
  revokeDenial: { status: number; code: string };
}

export interface Logger {
  line: (s: string) => void;
  step: (tag: string, s: string) => void;
  pass: (s: string) => void;
  fail: (s: string) => void;
}

export function consoleLogger(): Logger {
  return {
    line: (s) => console.log(s),
    step: (tag, s) => console.log(`\n[${tag}] ${s}`),
    pass: (s) => console.log(`   ✓ ${s}`),
    fail: (s) => console.log(`   ✗ ${s}`),
  };
}

export function silentLogger(): Logger {
  return { line: () => {}, step: () => {}, pass: () => {}, fail: () => {} };
}

// ──────────────────────────────────────────────────────────────────────────────────
// The codex agent authors this manifest — adds a vault WRITE capability over the
// loopback writing service. It is transport-backed (`local-rest`), so registering it
// PENDS for a human decision; on approval it goes LIVE. The write capability POSTs the
// whole `{ path, content }` input as JSON to the loopback server, which writes the file.
// ──────────────────────────────────────────────────────────────────────────────────

export function authorWriteExtension(baseUrl: string): ExtensionManifest {
  return {
    manifest: "plexus-extension/0.1",
    source: WRITER_SOURCE_ID,
    label: "Notes writer (local loopback writing service)",
    transport: "local-rest",
    secrets: [{ name: SECRET_NAME, attach: "bearer" }],
    capabilities: [
      {
        name: "vault.write",
        kind: "capability",
        label: "Write a note into the vault",
        describe:
          "Write (create or overwrite) a markdown note in the user's Obsidian vault via the " +
          "local loopback writing service. Input: { path: vault-relative path, content: markdown }. " +
          "This MUTATES durable user files, so it requires an explicit `write` grant the user confirms.",
        io: {
          input: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative path, e.g. 'Inbox/From codex.md'." },
              content: { type: "string", description: "The full markdown body to store at that path." },
            },
            required: ["path", "content"],
          },
          output: {
            type: "object",
            properties: { ok: { type: "boolean" }, path: { type: "string" } },
          },
        },
        grants: ["write"],
        transport: "local-rest",
        route: {
          baseUrl,
          method: "POST",
          pathTemplate: "/write",
          // bodyFrom:"input" → the whole { path, content } is sent as the JSON body.
          bodyFrom: "input",
          secret: { name: SECRET_NAME, attach: "bearer" },
        },
      },
    ],
  };
}

// ──────────────────────────────────────────────────────────────────────────────────
// The loopback "writing service" — a tiny ephemeral Bun.serve standing in for the
// user's local Obsidian-write daemon. Bearer-authenticated; POST /write { path, content }
// writes the file into the temp vault and returns { ok, path }. Plain http on 127.0.0.1
// (loopback is always permitted by the local-rest transport; no cert dance needed).
// ──────────────────────────────────────────────────────────────────────────────────

function startWriteServer(vaultPath: string): { url: string; stop: () => void; lastAuth: () => string | null } {
  let lastAuth: string | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      lastAuth = req.headers.get("authorization");
      if (lastAuth !== `Bearer ${WRITER_API_KEY}`) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const url = new URL(req.url);
      if (url.pathname === "/write" && req.method === "POST") {
        const body = (await req.json()) as { path?: string; content?: string };
        const rel = String(body.path ?? "");
        // Confine writes to the vault dir (defense-in-depth in the stand-in service).
        if (!rel || rel.includes("..") || rel.startsWith("/")) {
          return new Response(JSON.stringify({ error: "bad path" }), { status: 400 });
        }
        const abs = join(vaultPath, rel);
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, String(body.content ?? ""), "utf8");
        return Response.json({ ok: true, path: rel });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    lastAuth: () => lastAuth,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────
// Platform seam wrapper: real platform, but `resolveBinary("claude")` returns a FAKE
// path so the cc-master source surfaces its orchestration entries WITHOUT a real
// `claude` install. Everything else delegates to the real platform.
// ──────────────────────────────────────────────────────────────────────────────────

function platformWithFakeClaude(): PlatformServices {
  const real = getPlatformServices();
  return {
    ...real,
    platform: real.platform,
    resolveBinary: async (name: string) =>
      name === "claude" ? "/usr/local/bin/claude" : real.resolveBinary(name),
    getEnrichedPath: () => real.getEnrichedPath(),
    locateLocalService: (...a: Parameters<PlatformServices["locateLocalService"]>) =>
      real.locateLocalService(...a),
    spawnProcess: (...a: Parameters<PlatformServices["spawnProcess"]>) => real.spawnProcess(...a),
    resolveSecret: (...a: Parameters<PlatformServices["resolveSecret"]>) => real.resolveSecret(...a),
  };
}

// ──────────────────────────────────────────────────────────────────────────────────
// The scenario.
// ──────────────────────────────────────────────────────────────────────────────────

export interface RunOptions {
  logger?: Logger;
}

export async function runScenario(opts: RunOptions = {}): Promise<ScenarioReport> {
  const log = opts.logger ?? consoleLogger();
  const config = loadConfig();
  const HOST = expectedHost(config);
  const checks: StepCheck[] = [];
  const ok = (cond: boolean, label: string, detail?: string) => {
    checks.push({ ok: cond, label, ...(detail ? { detail } : {}) });
    (cond ? log.pass : log.fail).call(log, `${label}${detail ? ` — ${detail}` : ""}`);
    return cond;
  };

  // ── isolated temp fixtures (never touch real ~/.plexus, ~/.claude, or a real vault) ─
  const sandbox = mkdtempSync(join(tmpdir(), "plexus-acceptance-"));
  const plexusHome = join(sandbox, "plexus-home");
  const vaultPath = join(sandbox, "vault");
  mkdirSync(plexusHome, { recursive: true });
  mkdirSync(vaultPath, { recursive: true });
  mkdirSync(join(vaultPath, "Daily"), { recursive: true });

  // Seed a couple of notes — the "existing context" the agent reads before writing.
  writeFileSync(
    join(vaultPath, "Index.md"),
    "# Index\nWelcome to the acceptance vault.\nTopics: plexus, codex, obsidian.\n",
    "utf8",
  );
  writeFileSync(
    join(vaultPath, "Daily", "2026-06-23.md"),
    "# 2026-06-23\nKicked off the Plexus 1.0-rc acceptance玩法.\n",
    "utf8",
  );

  process.env.PLEXUS_HOME = plexusHome;
  // RECORD-ONLY cc-master: ensure no real headless launch can spawn here.
  delete process.env.PLEXUS_CC_HEADLESS_LAUNCH;
  // Provision the THROWAWAY writer secret into the temp store (never the user's real store).
  mkdirSync(join(plexusHome, "secrets"), { recursive: true });
  writeFileSync(join(plexusHome, "secrets", SECRET_NAME), WRITER_API_KEY, "utf8");
  // Force the cc-master gate ON so the orchestration surface (incl. agent.dispatch) appears.
  writeCcMasterConfig(true);
  _resetSecretCacheForTests();

  // ── boot the real gateway IN-PROCESS, with a platform that fakes `claude` so the
  //    cc-master source surfaces hermetically (no real `claude` install required) ────
  const platform = platformWithFakeClaude();
  const sources = createSourceRegistry(platform);
  const capabilities = createCapabilityRegistry(sources);
  const { app, state } = createAppWithState(config, { sources, capabilities });
  // Start the source registry so the cc-master first-party source scans its
  // workflow + members + skills into the live registry.
  await state.capabilities.start();

  const adminKey = state.connectionKey.current();

  // The loopback writing service the authored write-capability will POST to.
  const writeSrv = startWriteServer(vaultPath);

  // in-process fetch helper (fetch-shaped; same pipeline, no socket).
  const req = (path: string, init?: RequestInit) =>
    app.request("http://" + HOST + path, {
      ...init,
      headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  const adminReq = (path: string, init?: RequestInit) =>
    req(path, { ...init, headers: { "X-Plexus-Connection-Key": adminKey, ...(init?.headers ?? {}) } });

  // ── HUMAN-IN-THE-LOOP approver — models the user clicking "Approve" in the
  //    management UI. It polls the SHARED pending store and approves every pending
  //    item (extension registrations AND risky grants). This is the SAME pending store
  //    /admin/api/pending reads; we drive it programmatically so the harness is fully
  //    self-contained, while the register/grant requests still flow through real HTTP.
  const approver = new GrantService(state, defaultAuthorizer());
  let approving = true;
  const approveLoop = (async () => {
    while (approving) {
      for (const p of approver.listPending()) {
        log.line(`   [user] approving pending ${p.kind} ${p.pendingId}`);
        await approver.approve(p.pendingId);
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  })();

  // captured evidence
  let sessionId = "";
  let authoredManifest = authorWriteExtension(writeSrv.url);
  let registeredWriteCaps: string[] = [];
  const grantedCaps: string[] = [];
  let ccDispatch: Record<string, unknown> = {};
  let written = { path: "", content: "" };
  let readBack = "";
  let audit: AuditEvent[] = [];
  let auditSummary: string[] = [];
  let revokeDenial = { status: 0, code: "" };

  try {
    // ───────────────────────────────────────────────────────────────────────────────
    // STEP 1 — SETUP: configure an obsidian-fs READ source via POST /admin/api/sources
    // ───────────────────────────────────────────────────────────────────────────────
    log.step("1", "SETUP — configure an obsidian-fs READ source (admin), pointed at the temp vault");
    const addSrc = await adminReq("/admin/api/sources", {
      method: "POST",
      body: JSON.stringify({
        id: "obsidian",
        kind: "obsidian-fs",
        label: "Obsidian vault (acceptance)",
        enabled: true,
        transport: "ipc",
        route: { vaultPath },
      }),
    });
    const addBody = (await addSrc.json()) as { ok: boolean; registered?: string[] };
    ok(addSrc.status === 200 && addBody.ok === true, "obsidian-fs source registered LIVE", `status ${addSrc.status}`);
    ok((addBody.registered ?? []).includes(VAULT_READ_ID), `read capability present: ${VAULT_READ_ID}`);

    // ───────────────────────────────────────────────────────────────────────────────
    // STEP 2 — codex INTEGRATES: discover → handshake → read manifest
    // ───────────────────────────────────────────────────────────────────────────────
    log.step("2", "codex INTEGRATES — discover → handshake → read manifest");
    const wk = (await (await req("/.well-known/plexus")).json()) as { capabilities: { id: string }[] };
    ok(wk.capabilities.some((c) => c.id === VAULT_READ_ID), "discover (.well-known) lists the vault read capability");

    const hs = (await (await req("/link/handshake", {
      method: "POST",
      body: JSON.stringify({ connectionKey: adminKey, client: { name: "codex", version: "0.1.0", agentId: "agent-codex" } }),
    })).json()) as HandshakeResponse;
    sessionId = hs.sessionId;
    ok(!!sessionId, "handshake established a session", sessionId);
    const manifestIds = hs.manifest.entries.map((e) => e.id);
    ok(manifestIds.includes(VAULT_READ_ID), "manifest contains obsidian.vault.read");
    ok(manifestIds.includes(AGENT_DISPATCH_ID), "manifest contains cc-master.agent.dispatch (gate ON)");

    // ───────────────────────────────────────────────────────────────────────────────
    // STEP 3 — CREATE + STITCH AN EXTENSION (the key step): the codex agent AUTHORS an
    //          ExtensionManifest adding a vault WRITE capability → register → it PENDS →
    //          human approves → it goes LIVE.
    // ───────────────────────────────────────────────────────────────────────────────
    log.step("3", "AUTHOR + REGISTER a vault WRITE extension (transport-backed → PENDS → approved → LIVE)");
    authoredManifest = authorWriteExtension(writeSrv.url);
    const regRes = (await (await req("/extensions", {
      method: "POST",
      body: JSON.stringify({ sessionId, manifest: authoredManifest }),
    })).json()) as {
      status?: string;
      pendingId?: string;
      ok?: boolean;
      registered?: string[];
    };
    // Transport-backed → it must PEND (never auto-activate from the wire).
    ok(regRes.status === "grant_pending_user" && !!regRes.pendingId, "extension register PENDED for a human", regRes.pendingId);

    // The background approver approves it; poll the manifest until the write cap is LIVE.
    const liveDeadline = Date.now() + 3000;
    while (Date.now() < liveDeadline) {
      const m = (await (await req("/manifest", { headers: { "X-Plexus-Session": sessionId } })).json()) as {
        entries?: { id: string }[];
      };
      if ((m.entries ?? []).some((e) => e.id === WRITER_WRITE_ID)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const capsAfter = (await (await adminReq("/admin/api/capabilities")).json()) as { entries: { id: string }[] };
    registeredWriteCaps = capsAfter.entries.map((e) => e.id).filter((id) => id === WRITER_WRITE_ID);
    ok(registeredWriteCaps.includes(WRITER_WRITE_ID), `write capability is now LIVE: ${WRITER_WRITE_ID}`);

    // ───────────────────────────────────────────────────────────────────────────────
    // STEP 4 — GRANTS: request read / write / cc-master dispatch; human approves any
    //          that pend; tokens minted.
    // ───────────────────────────────────────────────────────────────────────────────
    log.step("4", "GRANTS — request read / write / cc-master.agent.dispatch; approve pends; mint tokens");

    const grant = async (capId: string): Promise<ScopedToken> => {
      const res = (await (await req("/grants", {
        method: "PUT",
        body: JSON.stringify({ sessionId, grants: { [capId]: "allow" } }),
      })).json()) as ScopedToken & { status?: string; pendingId?: string };
      if (Array.isArray(res.scopes) && res.token) return res;
      const pendingId = res.pendingId;
      if (!pendingId) throw new Error(`grant for ${capId} neither minted nor pended: ${JSON.stringify(res)}`);
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const st = (await (await req(`/grants/status?pendingId=${pendingId}`)).json()) as {
          state: string;
          token?: ScopedToken;
        };
        if (st.state === "approved" && st.token) return st.token;
        if (st.state === "denied" || st.state === "expired") throw new Error(`grant ${capId} ${st.state}`);
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`grant for ${capId} never resolved`);
    };

    const readToken = await grant(VAULT_READ_ID);
    ok(!!readToken.token, "read grant minted a token", VAULT_READ_ID);
    grantedCaps.push(VAULT_READ_ID);

    const writeToken = await grant(WRITER_WRITE_ID);
    const writeScope = writeToken.scopes.find((s) => s.id === WRITER_WRITE_ID);
    ok(!!writeToken.token && !!writeScope?.verbs.includes("write"), "write grant minted a token (write verb)", WRITER_WRITE_ID);
    grantedCaps.push(WRITER_WRITE_ID);

    const ccToken = await grant(AGENT_DISPATCH_ID);
    ok(!!ccToken.token, "cc-master.agent.dispatch grant minted a token", AGENT_DISPATCH_ID);
    grantedCaps.push(AGENT_DISPATCH_ID);

    // ───────────────────────────────────────────────────────────────────────────────
    // STEP 5 — CONTENT CREATION → WRITE INTO OBSIDIAN
    // ───────────────────────────────────────────────────────────────────────────────
    log.step("5", "CONTENT CREATION (cc-master record-mode) → read context → WRITE into Obsidian");

    // 5a. Invoke cc-master to "create content" — RECORD-ONLY (no real claude spawn).
    const dispatchRes = (await (await req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${ccToken.token}` },
      body: JSON.stringify({ id: AGENT_DISPATCH_ID, input: { goal: "draft the acceptance recap note", node: "compose-recap" } }),
    })).json()) as InvokeResponse;
    ccDispatch = (dispatchRes.output ?? {}) as Record<string, unknown>;
    ok(dispatchRes.ok === true, "cc-master dispatch returned ok (record-mode)");
    ok(ccDispatch.agentExecution === "recorded" && ccDispatch.launched === false, "dispatch is HONEST: recorded, not launched");
    ok(Array.isArray(ccDispatch.argv) && (ccDispatch.argv as string[]).includes("--plugin-dir"), "dispatch reports the argv it WOULD run");

    // 5b. Read existing context from Obsidian (real invoke, Bearer read token).
    const ctxRes = (await (await req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${readToken.token}` },
      body: JSON.stringify({ id: VAULT_READ_ID, input: { path: "Index.md" } }),
    })).json()) as InvokeResponse;
    const ctx = (ctxRes.output ?? {}) as { content?: string };
    ok(ctxRes.ok === true && (ctx.content ?? "").includes("acceptance vault"), "read existing Obsidian context (Index.md)");

    // 5c. Compose the content deterministically (the cc-master headless gen is gated off
    //     for hermeticity — the real headless launch is a separate manual smoke). Then
    //     WRITE it into Obsidian via the newly-created write capability (real invoke).
    const NEW_PATH = "Inbox/Acceptance Recap.md";
    const NEW_BODY =
      "# Acceptance Recap (codex × Plexus × Obsidian)\n\n" +
      "Drafted by the codex agent and written through the codex-authored " +
      "`notes-writer.vault.write` capability.\n\n" +
      `Context seen: ${(ctx.content ?? "").split("\n")[0]}\n` +
      `cc-master board: ${String(ccDispatch.boardId ?? "")} (dispatch ${String(ccDispatch.dispatchedNode ?? "")}, record-mode)\n`;
    written = { path: NEW_PATH, content: NEW_BODY };

    const writeRes = (await (await req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${writeToken.token}` },
      body: JSON.stringify({ id: WRITER_WRITE_ID, input: { path: NEW_PATH, content: NEW_BODY } }),
    })).json()) as InvokeResponse;
    ok(writeRes.ok === true, "WRITE invoke through notes-writer.vault.write succeeded");
    ok(writeSrv.lastAuth() === `Bearer ${WRITER_API_KEY}`, "loopback writer saw the Bearer secret (loopback-only attach)");

    // The file really landed in the temp vault.
    const onDisk = existsSync(join(vaultPath, NEW_PATH)) ? readFileSync(join(vaultPath, NEW_PATH), "utf8") : "";
    ok(onDisk === NEW_BODY, "the note file exists in the temp vault with the expected content", NEW_PATH);

    // Read it back THROUGH obsidian.vault.read (proves it's a real vault file).
    const backRes = (await (await req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${readToken.token}` },
      body: JSON.stringify({ id: VAULT_READ_ID, input: { path: NEW_PATH } }),
    })).json()) as InvokeResponse;
    readBack = String(((backRes.output ?? {}) as { content?: string }).content ?? "");
    ok(backRes.ok === true && readBack === NEW_BODY, "read-back via obsidian.vault.read returns the written content");

    // ───────────────────────────────────────────────────────────────────────────────
    // STEP 6 — AUDIT REVIEW
    // ───────────────────────────────────────────────────────────────────────────────
    log.step("6", "AUDIT REVIEW — assert the full chain is present + ordered sanely");
    const auditRes = (await (await adminReq("/admin/api/audit?limit=200")).json()) as { events: AuditEvent[] };
    // readAudit returns newest→oldest; present oldest→newest for the story.
    audit = [...auditRes.events].reverse();
    auditSummary = audit.map((e) => {
      const cap = e.capabilityId ? ` ${e.capabilityId}` : "";
      const outcome = e.outcome ? ` (${e.outcome})` : "";
      const det = e.detail && typeof e.detail.outcome === "string" ? ` (${e.detail.outcome})` : "";
      return `${e.type}${cap}${outcome}${det}`;
    });
    const kinds = new Set(audit.map((e) => e.type));
    ok(kinds.has("handshake"), "audit: handshake present");
    ok(audit.some((e) => e.type === "source.install"), "audit: source.install present (extension register)");
    ok(kinds.has("grant.allow") || kinds.has("grant.pending"), "audit: grant.allow / grant.pending present");
    ok(kinds.has("token.issue"), "audit: token.issue present");
    const invokes = audit.filter((e) => e.type === "invoke");
    ok(invokes.some((e) => e.capabilityId === AGENT_DISPATCH_ID), "audit: invoke cc-master.agent.dispatch present");
    ok(invokes.some((e) => e.capabilityId === VAULT_READ_ID), "audit: invoke obsidian.vault.read present");
    ok(invokes.some((e) => e.capabilityId === WRITER_WRITE_ID), "audit: invoke notes-writer.vault.write present");
    // ordering sanity: handshake precedes the first invoke.
    const firstHandshake = audit.findIndex((e) => e.type === "handshake");
    const firstInvoke = audit.findIndex((e) => e.type === "invoke");
    ok(firstHandshake >= 0 && firstHandshake < firstInvoke, "audit ordering: handshake precedes the first invoke");

    // ───────────────────────────────────────────────────────────────────────────────
    // STEP 7 — REVOKE: revoke the write grant; re-invoke with the old token → must FAIL.
    // ───────────────────────────────────────────────────────────────────────────────
    log.step("7", "REVOKE the write grant — re-invoke with the OLD token must FAIL (token_revoked)");
    const revRes = await adminReq("/grants/revoke", {
      method: "POST",
      body: JSON.stringify({ jti: writeToken.jti, reason: "acceptance: revoke the write grant" }),
    });
    const revBody = (await revRes.json()) as { ok: boolean; revokedJtis: string[] };
    ok(revRes.status === 200 && revBody.ok === true && revBody.revokedJtis.includes(writeToken.jti), "revoke succeeded (management connection-key)");

    // Re-invoke the write with the now-revoked token.
    const deniedRes = await req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${writeToken.token}` },
      body: JSON.stringify({ id: WRITER_WRITE_ID, input: { path: "Inbox/should-fail.md", content: "nope" } }),
    });
    const deniedBody = (await deniedRes.json()) as InvokeResponse;
    revokeDenial = { status: deniedRes.status, code: deniedBody.error?.code ?? "" };
    ok(deniedRes.status === 401 && deniedBody.ok === false, "re-invoke with revoked token → HTTP 401, ok:false");
    ok(deniedBody.error?.code === "token_revoked", `denial code is token_revoked`, deniedBody.error?.code);
    // The would-be file never landed.
    ok(!existsSync(join(vaultPath, "Inbox/should-fail.md")), "revoked write left NO file on disk (access genuinely gone)");

    // The READ token still works (we only revoked the write grant).
    const stillReadRes = (await (await req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${readToken.token}` },
      body: JSON.stringify({ id: VAULT_READ_ID, input: { path: "Index.md" } }),
    })).json()) as InvokeResponse;
    ok(stillReadRes.ok === true, "read token still works (only the write grant was revoked)");
  } finally {
    approving = false;
    await approveLoop;
    writeSrv.stop();
    delete process.env.PLEXUS_HOME;
    delete process.env.PLEXUS_CC_HEADLESS_LAUNCH;
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  const pass = checks.every((c) => c.ok);
  return {
    pass,
    checks,
    sessionId,
    authoredManifest,
    registeredWriteCaps,
    grantedCaps,
    ccDispatch,
    written,
    readBack,
    vaultPath,
    plexusHome,
    audit,
    auditSummary,
    revokeDenial,
  };
}
