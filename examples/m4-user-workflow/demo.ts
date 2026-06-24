/**
 * ============================================================================
 * m4-user-workflow — DYNAMIC-WORKFLOW authoring worked path (the engine).
 * ============================================================================
 *
 * THE PROOF (Plexus M4 section B): a USER composes two EXISTING capabilities into a
 * NEW `kind:"workflow"` capability, exposed via self-describe, and an agent drives it
 * end-to-end through the published wire contract — with REAL fan-out producing a REAL
 * composed result, and the security guards genuinely rejecting bad compositions.
 *
 * The worked path (all through the real gateway, NOTHING staged):
 *   1. COMPOSE  — `journalWorkflowManifest` declares two members (append/write +
 *                 list/read) and a workflow composing them (`journal.note.log`).
 *   2. REGISTER — the agent `POST /extensions`. The manifest is transport-backed
 *                 (local-rest), so it PENDS for a human (`validateRegistration` runs
 *                 first: members resolve, no cycle). An unapproved register does NOT
 *                 activate the extension.
 *   3. APPROVE  — a background driver MODELS the user clicking "Approve" in the
 *                 management client (it polls the SAME shared pending store the admin
 *                 panel reads, and approves). Only THEN does the commit run.
 *   4. GRANT    — the agent grants the workflow (write). The gateway SYNTHESIZES the
 *                 transitive member scopes (append/write + list/read), surfaces them,
 *                 and stamps them `synthesizedFor` into the token.
 *   5. INVOKE   — the granted invoke fans out via the WorkflowTransport: a REAL POST
 *                 to the journal then a REAL GET. Honest-green: we read the journal
 *                 service's OWN state back (not the workflow's return value) to prove
 *                 the append really executed, AND an independent direct `journal.log.list`
 *                 invoke returns the appended line — the real composed effect.
 *
 * GUARDS (real rejections, real assertions):
 *   - a workflow with a DANGLING member → REJECTED at register.
 *   - a CYCLIC compose (A→B→A) → REJECTED at register.
 *   - granting the workflow does NOT grant authority beyond the synthesized member
 *     scopes (no phantom verbs; the member scopes are exactly append/write + list/read).
 *
 * Runs in-process via `app.request` (fetch-shaped) under the test, or over a real
 * loopback socket under `run.ts`. Always cleans up its temp home + journal service.
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, baseUrl, type GatewayConfig } from "../../src/config.ts";
import { createAppWithState } from "../../src/core/server.ts";
import { _resetSecretCacheForTests, defaultAuthorizer } from "../../src/auth/index.ts";
import { GrantService } from "../../src/core/grant-service.ts";
import type {
  ExtensionRegisterRequest,
  ExtensionRegisterResponse,
  GrantResponse,
} from "@plexus/protocol";

import { PlexusClient, PlexusProtocolError } from "../min-agent/client.ts";
import { startJournalService, type JournalService } from "./server.ts";
import {
  journalWorkflowManifest,
  danglingMemberManifest,
  cyclicWorkflowManifest,
  APPEND_ID,
  LIST_ID,
  WORKFLOW_ID,
} from "./manifest.ts";

// ── result shapes (the test asserts against these) ──────────────────────────────

export interface CheckResult {
  ok: boolean;
  label: string;
  detail?: string;
}

export interface DemoReport {
  base: string;
  checks: CheckResult[];
  pass: boolean;
}

export interface Logger {
  line(s?: string): void;
  step(tag: string, s: string): void;
  pass(s: string): void;
  fail(s: string): void;
}

export function consoleLogger(): Logger {
  return {
    line: (s = "") => console.log(s),
    step: (tag, s) => console.log(`\n── ${tag} ${s} ${"─".repeat(Math.max(2, 56 - s.length))}`),
    pass: (s) => console.log(`   ✓ ${s}`),
    fail: (s) => console.log(`   ✗ ${s}`),
  };
}

export function silentLogger(): Logger {
  return { line() {}, step() {}, pass() {}, fail() {} };
}

function check(ok: boolean, label: string, detail?: string): CheckResult {
  return { ok, label, ...(detail ? { detail } : {}) };
}

/** A Hono-app-shaped value whose `request` is fetch-shaped (the in-process seam). */
type RequestableApp = {
  fetch: (req: Request) => Response | Promise<Response>;
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

export interface RunDemoOptions {
  logger?: Logger;
  /** Drive in-process via app.request (test path). When false, open a real loopback socket. */
  inProcess?: boolean;
}

/** Discriminate a `PUT /grants` (or `POST /extensions`) pending response. */
function isPending(r: GrantResponse | ExtensionRegisterResponse): r is GrantResponse & { status: "grant_pending_user"; pendingId: string } {
  return (r as { status?: string }).status === "grant_pending_user";
}

export async function runDemo(opts: RunDemoOptions = {}): Promise<DemoReport> {
  const log = opts.logger ?? consoleLogger();
  const inProcess = opts.inProcess ?? false;
  const checks: CheckResult[] = [];

  // ── isolated temp home (never touch the real ~/.plexus) ──────────────────────
  const sandbox = mkdtempSync(join(tmpdir(), "plexus-m4wf-"));
  const plexusHome = join(sandbox, "plexus-home");
  mkdirSync(plexusHome, { recursive: true });
  process.env.PLEXUS_HOME = plexusHome;
  _resetSecretCacheForTests();

  // ── stand up the LOOPBACK journal service the workflow members reach ─────────
  const journal: JournalService = await startJournalService();
  log.line(`[demo] loopback journal service @ ${journal.baseUrl}`);

  // ── boot the real gateway ────────────────────────────────────────────────────
  const port = inProcess ? loadConfig().port : await pickFreePort();
  const config = { ...loadConfig(), port } as GatewayConfig;
  const { app, state } = createAppWithState(config);
  const base = baseUrl(config);

  let server: { stop: (force?: boolean) => void } | undefined;
  const doFetch = inProcess
    ? async (input: string, init?: RequestInit) =>
        (app as RequestableApp).request(input, init) as Promise<Response>
    : undefined;
  if (!inProcess) {
    server = Bun.serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  }

  // ── HUMAN-IN-THE-LOOP: model the user approving in the management client. The
  //    gateway defaults to UserConfirmAuthorizer, so a transport-backed register +
  //    a write grant PEND. This loop polls the SHARED pending store (the same one
  //    /admin/api/pending reads) and approves every pending item — register & grant.
  const approver = new GrantService(state, defaultAuthorizer());
  let approving = true;
  const approveLog: string[] = [];
  const approveLoop = (async () => {
    while (approving) {
      for (const p of approver.listPending()) {
        approveLog.push(`${p.kind}:${p.register?.source ?? p.capabilities?.join(",") ?? ""}`);
        log.line(`[user] approving pending ${p.kind} (${p.register?.source ?? p.capabilities?.join(", ") ?? ""})`);
        await approver.approve(p.pendingId);
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  })();

  const client = new PlexusClient({
    baseUrl: base,
    ...(doFetch ? { fetch: doFetch } : {}),
    client: { name: "m4wf-author-agent", version: "0.1.0", agentId: "agent-author" },
  });

  log.line(`[demo] booted REAL gateway @ ${base} (${inProcess ? "in-process" : "loopback socket"})`);

  try {
    // ── 0. handshake (need a live session to POST /extensions + grant) ──────────
    log.step("0", "HANDSHAKE — open a session");
    await client.discover();
    await client.handshake(state.connectionKey.current());
    const sessionId = client.getSessionId()!;
    log.line(`    session ${sessionId}`);

    // ── 1. COMPOSE + 2. REGISTER (pends) ─────────────────────────────────────────
    log.step("1·2", "COMPOSE two existing capabilities → a workflow, then REGISTER");
    const manifest = journalWorkflowManifest(journal.baseUrl);
    log.line(`    workflow ${WORKFLOW_ID} composes:`);
    log.line(`      • ${APPEND_ID} (write)   POST /entry`);
    log.line(`      • ${LIST_ID} (read)      GET  /entries`);

    const regReq: ExtensionRegisterRequest = { sessionId, manifest };
    const regRes = await postExtensions(client, base, doFetch, regReq);
    log.line(`    POST /extensions → ${JSON.stringify(regRes).slice(0, 120)}`);
    const registerPended = isPending(regRes);
    checks.push(
      check(
        registerPended,
        "register PENDS for a human (transport-backed; not committed on the agent's say-so)",
        registerPended ? "grant_pending_user" : JSON.stringify(regRes),
      ),
    );

    // ── 3. APPROVE — wait for the modeled user-approve to commit the register ────
    log.step("3", "APPROVE — the user approves; only then does the commit run");
    const committed = await waitFor(
      () => !!state.capabilities.getEntry(WORKFLOW_ID),
      2000,
    );
    const wfEntry = state.capabilities.getEntry(WORKFLOW_ID);
    log.line(`    workflow entry present after approve: ${!!wfEntry}`);
    checks.push(
      check(
        committed && !!wfEntry && wfEntry.kind === "workflow",
        "after approve, the workflow capability is committed + discoverable (kind:workflow)",
        wfEntry ? `${wfEntry.id} members=${(wfEntry.members ?? []).map((m) => m.id).join("+")}` : "absent",
      ),
    );
    // The members resolve to PRESENT entries (transitive targets are real).
    const memberIds = new Set((wfEntry?.members ?? []).map((m) => m.id));
    checks.push(
      check(
        !!state.capabilities.getEntry(APPEND_ID) &&
          !!state.capabilities.getEntry(LIST_ID) &&
          memberIds.has(APPEND_ID) &&
          memberIds.has(LIST_ID),
        "workflow members resolve to present registry entries (append + list)",
        [...memberIds].join(", "),
      ),
    );

    // Re-fetch the manifest so the agent sees the freshly-committed workflow self-describe.
    await client.refreshManifest();
    const selfDescribe = client.entry(WORKFLOW_ID);
    checks.push(
      check(
        !!selfDescribe && selfDescribe.kind === "workflow" && selfDescribe.transport === "workflow",
        "the new workflow is exposed via self-describe (handshake manifest) as a workflow",
        selfDescribe?.describe.slice(0, 60),
      ),
    );

    // ── 3b. DEFAULT-DENY — an un-granted invoke is rejected ─────────────────────
    log.step("3b", "DEFAULT-DENY — un-granted workflow invoke is rejected");
    const deniedInvoke = await client.invoke(WORKFLOW_ID, { text: "should not run" });
    log.line(`    denied: ok=${deniedInvoke.ok}, code=${deniedInvoke.error?.code}`);
    checks.push(
      check(
        !deniedInvoke.ok && deniedInvoke.error?.code === "grant_required",
        "un-granted workflow invoke is DENIED with grant_required (real default-deny)",
        deniedInvoke.error?.code,
      ),
    );
    // And nothing ran on the journal yet (no silent fan-out before grant).
    checks.push(
      check(
        journal.state().count === 0,
        "no fan-out ran before grant (journal is still empty)",
        `count=${journal.state().count}`,
      ),
    );

    // ── 4. GRANT — synthesize the transitive member scopes ──────────────────────
    log.step("4", "GRANT the workflow (write) → SYNTHESIZED transitive member scopes");
    const token = await client.requestGrants([WORKFLOW_ID], { verbs: ["write"] });
    const topScope = token.scopes.find((s) => s.id === WORKFLOW_ID);
    const synthesized = token.scopes.filter((s) => s.synthesizedFor === WORKFLOW_ID);
    for (const s of token.scopes) {
      log.line(`    scope ${s.id} ${JSON.stringify(s.verbs)}${s.synthesizedFor ? `  (transitive for ${s.synthesizedFor})` : ""}`);
    }
    checks.push(
      check(!!topScope && topScope.verbs.includes("write"), "grant mints the workflow's write scope"),
    );
    const appendSynth = synthesized.find((s) => s.id === APPEND_ID);
    const listSynth = synthesized.find((s) => s.id === LIST_ID);
    checks.push(
      check(
        !!appendSynth && appendSynth.verbs.includes("write") &&
          !!listSynth && listSynth.verbs.includes("read"),
        "token carries SYNTHESIZED transitive member scopes (append/write + list/read)",
        `${synthesized.length} synthesized`,
      ),
    );
    // OVER-GRANT GUARD: the synthesized scopes are EXACTLY the member scopes — no
    // phantom id, no widened verb. Granting the workflow grants no authority beyond
    // its declared members.
    const synthIds = synthesized.map((s) => s.id).sort();
    const noOverGrant =
      JSON.stringify(synthIds) === JSON.stringify([APPEND_ID, LIST_ID].sort()) &&
      appendSynth?.verbs.join(",") === "write" &&
      listSynth?.verbs.join(",") === "read";
    checks.push(
      check(
        noOverGrant,
        "granting the workflow does NOT over-grant — synthesized scopes are EXACTLY the member scopes (no extra id/verb)",
        `synthIds=${synthIds.join("+")}`,
      ),
    );

    // ── 5. INVOKE — REAL fan-out, REAL composed result ──────────────────────────
    log.step("5", "INVOKE — fan out via WorkflowTransport (REAL POST then REAL GET)");
    const NOTE = `journaled at run ${Date.now()}`;
    const out = await client.invoke(WORKFLOW_ID, { text: NOTE });
    log.line(`    invoke ok=${out.ok}`);
    const wfOut = out.output as { workflow?: string; members?: { id: string; ok: boolean }[] } | undefined;
    log.line(`    fan-out: ${(wfOut?.members ?? []).map((m) => `${m.id}=${m.ok ? "ok" : "fail"}`).join(", ")}`);
    if (!out.ok) log.line(`    error: ${out.error?.code} ${out.error?.message}`);

    const memberOk = (id: string) => wfOut?.members?.some((m) => m.id === id && m.ok) === true;
    checks.push(
      check(
        out.ok && memberOk(APPEND_ID) && memberOk(LIST_ID),
        "the granted invoke REALLY fanned out via the WorkflowTransport — both members ran ok (append then list)",
        out.ok ? "workflow green" : out.error?.code,
      ),
    );
    // Members fanned out IN ORDER (append before list).
    checks.push(
      check(
        JSON.stringify((wfOut?.members ?? []).map((m) => m.id)) === JSON.stringify([APPEND_ID, LIST_ID]),
        "members fanned out IN ORDER (append → list)",
        (wfOut?.members ?? []).map((m) => m.id).join(" → "),
      ),
    );

    // HONEST GREEN #1: read the journal service's OWN state back — the append really
    // executed (we don't trust the workflow's ok flags).
    const after = journal.state();
    log.line(`    journal service state after fan-out: count=${after.count} last="${after.entries.at(-1)}"`);
    checks.push(
      check(
        after.count === 1 && after.entries.at(-1) === NOTE,
        "the fan-out's append REALLY mutated the journal service (read its own state back, not the return value)",
        `count=${after.count}`,
      ),
    );

    // HONEST GREEN #2: an independent direct read returns the REAL appended line —
    // the composed effect is observable end-to-end through the wire.
    const directList = await client.invoke(LIST_ID, {});
    const listData = directList.output as { entries?: string[]; count?: number } | undefined;
    log.line(`    direct ${LIST_ID} → entries=${JSON.stringify(listData?.entries)}`);
    checks.push(
      check(
        directList.ok && (listData?.entries ?? []).includes(NOTE),
        "a direct read of the journal returns the REAL line the workflow appended (real composed result)",
        JSON.stringify(listData?.entries),
      ),
    );

    // ── GUARD #1 — DANGLING member is rejected at register ──────────────────────
    log.step("G1", "GUARD — a workflow with a DANGLING member is REJECTED");
    const dangling = await postExtensions(client, base, doFetch, {
      sessionId,
      manifest: danglingMemberManifest(journal.baseUrl),
    });
    log.line(`    POST /extensions (dangling) → ok=${(dangling as ExtensionRegisterResponse).ok}`);
    log.line(`      reason: ${(dangling as ExtensionRegisterResponse).reason ?? "(none)"}`);
    const danglingRejected =
      !isPending(dangling) &&
      (dangling as ExtensionRegisterResponse).ok === false &&
      String((dangling as ExtensionRegisterResponse).reason ?? "").includes("journal.entry.delete");
    checks.push(
      check(
        danglingRejected,
        "a workflow naming a DANGLING member is REJECTED at register (not pended, not committed)",
        (dangling as ExtensionRegisterResponse).reason?.slice(0, 80),
      ),
    );

    // ── GUARD #2 — CYCLE is rejected at register ────────────────────────────────
    log.step("G2", "GUARD — a CYCLIC compose (A→B→A) is REJECTED");
    const cyclic = await postExtensions(client, base, doFetch, {
      sessionId,
      manifest: cyclicWorkflowManifest(journal.baseUrl),
    });
    log.line(`    POST /extensions (cyclic) → ok=${(cyclic as ExtensionRegisterResponse).ok}`);
    log.line(`      reason: ${(cyclic as ExtensionRegisterResponse).reason ?? "(none)"}`);
    const cycleRejected =
      !isPending(cyclic) &&
      (cyclic as ExtensionRegisterResponse).ok === false &&
      String((cyclic as ExtensionRegisterResponse).reason ?? "").toLowerCase().includes("cycle");
    checks.push(
      check(
        cycleRejected,
        "a CYCLIC workflow compose is REJECTED at register (anti-cycle walk)",
        (cyclic as ExtensionRegisterResponse).reason?.slice(0, 80),
      ),
    );

    const pass = checks.every((c) => c.ok);
    log.step("==", "SUMMARY");
    for (const c of checks) (c.ok ? log.pass : log.fail).call(log, `${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
    log.line("");
    log.line(
      pass
        ? "OVERALL: ✓ PASS — user-authored workflow composed, registered (approve), invoked with REAL fan-out; guards reject bad compositions."
        : "OVERALL: ✗ FAIL — see the failing checks above.",
    );

    return { base, checks, pass };
  } finally {
    approving = false;
    await approveLoop;
    server?.stop(true);
    await journal.stop();
    delete process.env.PLEXUS_HOME;
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────────

/**
 * POST /extensions through the SAME wire path the agent uses (the PlexusClient does
 * not expose a register helper, so we issue the raw request with the loopback Host
 * header the gateway's guard requires). Returns the pending notice or the register
 * response.
 */
async function postExtensions(
  client: PlexusClient,
  base: string,
  doFetch: ((input: string, init?: RequestInit) => Promise<Response>) | undefined,
  body: ExtensionRegisterRequest,
): Promise<GrantResponse | ExtensionRegisterResponse> {
  const fetchImpl = doFetch ?? ((globalThis as { fetch: typeof fetch }).fetch);
  void client; // identity carried by sessionId in the body; host header below
  const res = await fetchImpl(`${base}/extensions`, {
    method: "POST",
    headers: {
      host: new URL(base).host,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as GrantResponse | ExtensionRegisterResponse;
}

/** Poll a predicate until true or timeout. Returns whether it became true. */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

/** Find a free TCP port by briefly binding `:0`, then releasing it. */
async function pickFreePort(): Promise<number> {
  const probe = Bun.serve({ fetch: () => new Response("ok"), hostname: "127.0.0.1", port: 0 });
  const port = probe.port ?? 0;
  probe.stop(true);
  if (!port) throw new Error("could not pick a free loopback port");
  return port;
}

// Re-export for the runner + test.
export { PlexusProtocolError };
