/**
 * ============================================================================
 * Plexus v1 END-TO-END ACCEPTANCE DEMO (t13).
 * ============================================================================
 *
 * THE PROOF: the v1 acceptance scenario works through the REAL gateway, driven by
 * a real AI-agent protocol client (the t12 `PlexusClient`) over real HTTP `fetch`.
 *
 *   Scenario B (user-custom — Obsidian):  one call (`openVaultExtension`) opens an
 *     Obsidian vault READ-ONLY over a TEMP vault of sample notes. The capability
 *     `obsidian.vault.read` is self-described, agent-discovered, and read-only
 *     grantable. An agent DISCOVERS it, HANDSHAKES, is GRANTED `read`, INVOKES it and
 *     reads REAL note content — and an UN-GRANTED read + a WRITE attempt are DENIED.
 *
 * This module is BOTH the runnable demo (`runDemo()` boots a real gateway on a
 * concrete free loopback port) AND the engine the acceptance test asserts against
 * (it returns a structured `DemoReport` so the test can check the genuine facts).
 *
 * Nothing here is staged: every step goes through the published wire contract
 * (`.well-known` → handshake → grants → invoke), the actual sources, and the actual
 * agent client. The denial cases really deny.
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, baseUrl, type GatewayConfig } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import {
  openVaultExtension,
  VAULT_READ_ID,
} from "@plexus/runtime/sources/obsidian/open-vault.ts";
import { _resetSecretCacheForTests, defaultAuthorizer } from "@plexus/runtime/auth/index.ts";
import { GrantService } from "@plexus/runtime/core/grant-service.ts";

import { PlexusClient, PlexusProtocolError } from "../../../examples/min-agent/client.ts";

// ── tiny pretty-printer (no-ops when quiet, e.g. under the test) ────────────────

export interface Logger {
  line(s?: string): void;
  step(tag: string, s: string): void;
  pass(s: string): void;
  fail(s: string): void;
}

export function consoleLogger(): Logger {
  return {
    line: (s = "") => console.log(s),
    step: (tag, s) =>
      console.log(`\n── ${tag} ${s} ${"─".repeat(Math.max(2, 48 - s.length))}`),
    pass: (s) => console.log(`   ✓ ${s}`),
    fail: (s) => console.log(`   ✗ ${s}`),
  };
}

export function silentLogger(): Logger {
  return { line() {}, step() {}, pass() {}, fail() {} };
}

// ── result shapes the acceptance test asserts against ───────────────────────────

export interface CheckResult {
  ok: boolean;
  label: string;
  detail?: string;
}

export interface ScenarioReport {
  name: string;
  pass: boolean;
  checks: CheckResult[];
}

export interface DemoReport {
  base: string;
  scenarioB: ScenarioReport;
  overall: boolean;
}

/** A Hono-app-shaped value whose `request` is fetch-shaped (the t12 in-process seam). */
type RequestableApp = {
  fetch: (req: Request) => Response | Promise<Response>;
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

export interface RunDemoOptions {
  logger?: Logger;
  /**
   * Drive the gateway IN-PROCESS via `app.request` (the test path — no socket).
   * When false (the default for `run.ts`), a real `Bun.serve` socket is opened on a
   * concrete free loopback port and the agent talks over real HTTP `fetch`.
   */
  inProcess?: boolean;
}

// ── temp-fixture helpers (NEVER touch the real ~/.claude or a real vault) ────────

/** Find a free TCP port by briefly binding `:0`, then releasing it. */
async function pickFreePort(): Promise<number> {
  const probe = Bun.serve({ fetch: () => new Response("ok"), hostname: "127.0.0.1", port: 0 });
  const port = probe.port ?? 0;
  probe.stop(true);
  if (!port) throw new Error("could not pick a free loopback port");
  return port;
}

/** Create a throwaway Obsidian vault folder with a couple of real notes. */
function makeVault(root: string): string {
  const vaultPath = join(root, "AcceptanceVault");
  mkdirSync(join(vaultPath, "Projects"), { recursive: true });
  writeFileSync(join(vaultPath, "Index.md"), "# Index\nWelcome to the acceptance vault.\n");
  writeFileSync(
    join(vaultPath, "Projects", "Plexus.md"),
    "# Plexus\nPlexus is a local capability gateway.\n" +
      "The agent discovered and read THIS note via the Plexus protocol (read-only).\n",
  );
  return vaultPath;
}

function check(ok: boolean, label: string, detail?: string): CheckResult {
  return { ok, label, ...(detail ? { detail } : {}) };
}

function summarize(name: string, checks: CheckResult[]): ScenarioReport {
  return { name, pass: checks.every((c) => c.ok), checks };
}

// ────────────────────────────────────────────────────────────────────────────────
// The demo
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Boot a REAL gateway (concrete free loopback port unless `inProcess`), register an
 * Obsidian vault, then drive a real `PlexusClient` through the acceptance scenario
 * end-to-end. Returns a structured `DemoReport` AND prints a human transcript
 * through the logger. Always cleans up its temp dirs + socket.
 */
export async function runDemo(opts: RunDemoOptions = {}): Promise<DemoReport> {
  const log = opts.logger ?? consoleLogger();
  const inProcess = opts.inProcess ?? false;

  // ── isolated temp fixtures — the demo NEVER mutates real user state ──────────
  const sandbox = mkdtempSync(join(tmpdir(), "plexus-e2e-"));
  const plexusHome = join(sandbox, "plexus-home"); // gateway secret/audit home + boards
  mkdirSync(plexusHome, { recursive: true });
  const vaultPath = makeVault(sandbox);

  // Isolate the gateway's own home for the signing secret + audit. Plexus never
  // touches ~/.claude.
  process.env.PLEXUS_HOME = plexusHome;
  // Belt-and-braces: ensure no automated headless launch can spawn here.
  delete process.env.PLEXUS_CC_HEADLESS_LAUNCH;
  _resetSecretCacheForTests();

  // ── boot the real gateway on a CONCRETE free port (never port:0) ─────────────
  const port = inProcess ? loadConfig().port : await pickFreePort();
  const config = { ...loadConfig(), port } as GatewayConfig;
  const { app, state } = createAppWithState(config);
  const base = baseUrl(config);

  // Register the Obsidian vault read-only capability (the real source).
  const { manifest, handlers } = openVaultExtension(vaultPath);
  const reg = await state.capabilities.registerExtension(manifest, { handlers });
  if (!reg.ok) throw new Error(`failed to register vault extension: ${reg.reason}`);

  // Start the source registry so the first-party sources (in MODULES) scan their
  // entries + skills into the live registry.
  await state.capabilities.start();

  // Open a real socket unless the test drives in-process via app.request.
  let server: { stop: (force?: boolean) => void } | undefined;
  const doFetch =
    inProcess
      ? async (input: string, init?: RequestInit) =>
          (app as RequestableApp).request(input, init) as Promise<Response>
      : undefined; // real network fetch below

  if (!inProcess) {
    server = Bun.serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  }

  const newClient = (agentId: string) =>
    new PlexusClient({
      baseUrl: base,
      ...(doFetch ? { fetch: doFetch } : {}),
      client: { name: "acceptance-agent", version: "0.1.0", agentId },
    });

  log.line(
    `[demo] booted REAL gateway @ ${base} (${inProcess ? "in-process" : "loopback socket"})`,
  );
  log.line(`[demo] temp home     : ${plexusHome}  (real ~/.claude is NEVER touched)`);
  log.line(`[demo] temp vault    : ${vaultPath}`);

  // ── HUMAN-IN-THE-LOOP: the gateway now defaults to the UserConfirmAuthorizer, so a
  //    risky grant (execute / write / extension-sourced) PENDS until a human approves.
  //    This background driver MODELS the user clicking "Approve" in the management
  //    client's Pending-approvals panel: it polls the SHARED pending store (the same
  //    one /admin/api/pending reads) and approves every pending item. The demo thus
  //    runs through the NEW confirm flow (register → approve → grant → invoke) honestly.
  const approver = new GrantService(state, defaultAuthorizer());
  let approving = true;
  const approveLoop = (async () => {
    while (approving) {
      for (const p of approver.listPending()) {
        log.line(`[user] approving pending ${p.kind} ${p.pendingId} (${p.capabilities?.join(", ") ?? p.register?.source ?? ""})`);
        await approver.approve(p.pendingId);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  })();

  try {
    const scenarioB = await runScenarioB(newClient("agent-obsidian"), state, log);

    const overall = scenarioB.pass;

    // ── verdict summary ────────────────────────────────────────────────────────
    log.step("==", "ACCEPTANCE SUMMARY");
    printScenario(log, scenarioB);
    log.line("");
    log.line(
      overall
        ? "OVERALL VERDICT: ✓ PASS — the v1 acceptance scenario works end-to-end through the real gateway."
        : "OVERALL VERDICT: ✗ FAIL — see the failing checks above.",
    );

    return { base, scenarioB, overall };
  } finally {
    approving = false;
    await approveLoop;
    server?.stop(true);
      delete process.env.PLEXUS_HOME;
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

function printScenario(log: Logger, s: ScenarioReport) {
  log.line(`${s.pass ? "✓ PASS" : "✗ FAIL"}  ${s.name}`);
  for (const c of s.checks) {
    (c.ok ? log.pass : log.fail).call(log, `${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Scenario B — Obsidian vault read-only (Flow B)
// ────────────────────────────────────────────────────────────────────────────────

async function runScenarioB(
  client: PlexusClient,
  state: ReturnType<typeof createAppWithState>["state"],
  log: Logger,
): Promise<ScenarioReport> {
  log.step("B", "SCENARIO B — Obsidian vault read-only (user-custom)");
  const checks: CheckResult[] = [];

  // ── B1. DISCOVER ─────────────────────────────────────────────────────────────
  // The public `.well-known` no longer carries a catalog (authorized-subset §3.3);
  // discover() still primes the client with the gateway/auth advertisement, and the
  // SUMMARY tier is read off the registry directly.
  log.line("\nB1. DISCOVER  GET /.well-known/plexus");
  await client.discover();
  const summary = state.capabilities.summaries().find((s) => s.id === VAULT_READ_ID);
  if (summary) {
    log.line(`    • ${summary.id}  [${summary.kind}, grants:${JSON.stringify(summary.grants)}, ${summary.transport}]`);
    log.line(`        ${summary.summary}`);
  }
  checks.push(
    check(
      !!summary && summary.kind === "capability" && JSON.stringify(summary.grants) === '["read"]',
      "obsidian.vault.read discovered in .well-known (capability, read-only)",
    ),
  );

  // ── B2. UNDERSTAND — pick by reading describe ────────────────────────────────
  log.line("\nB2. UNDERSTAND  POST /link/handshake (choose by reading describe)");
  await client.handshake(state.connectionKey.current());
  const chosen = client
    .entries()
    .find(
      (e) =>
        e.kind === "capability" &&
        e.grants.length === 1 &&
        e.grants[0] === "read" &&
        e.describe.toLowerCase().includes("obsidian vault"),
    );
  if (chosen) {
    log.line(`    chose: ${chosen.id}`);
    log.line(`      describe: ${chosen.describe.slice(0, 90)}…`);
    log.line(`      grants  : ${JSON.stringify(chosen.grants)} (read-only by construction)`);
  }
  checks.push(
    check(
      chosen?.id === VAULT_READ_ID && !!chosen?.io?.input,
      "agent self-selects obsidian.vault.read by reading its describe; full io schema present",
    ),
  );

  // ── B2b. DEFAULT-DENY — un-granted read is rejected ──────────────────────────
  log.line("\nB2b. DEFAULT-DENY  POST /invoke (no grant held yet)");
  const deniedRead = await client.invoke(VAULT_READ_ID, { path: "Index.md" });
  log.line(`    denied as expected: ok=${deniedRead.ok}, error.code=${deniedRead.error?.code}`);
  checks.push(
    check(
      !deniedRead.ok && deniedRead.error?.code === "grant_required",
      "un-granted read is DENIED with grant_required (real default-deny)",
      deniedRead.error?.code,
    ),
  );
  checks.push(
    check(
      !JSON.stringify(deniedRead).toLowerCase().includes("welcome to the acceptance vault"),
      "no note content leaks in a denial",
    ),
  );

  // ── B3. GRANTED (read) ───────────────────────────────────────────────────────
  log.line("\nB3. GRANTED  PUT /grants (request read)");
  const token = await client.requestGrants([VAULT_READ_ID]); // bare allow → read-only default
  log.line(`    scoped-token jti=${token.jti}  scopes=${JSON.stringify(token.scopes)}`);
  checks.push(
    check(
      JSON.stringify(token.scopes) === JSON.stringify([{ id: VAULT_READ_ID, verbs: ["read"] }]),
      "grant mints a READ-ONLY scope (no write/execute)",
    ),
  );

  // ── B4. CALL — read REAL note content ────────────────────────────────────────
  log.line("\nB4. CALL  POST /invoke (granted read)");
  const out = await client.invokeOrThrow(VAULT_READ_ID, { path: "Projects/Plexus.md" });
  const data = out.output as { type?: string; relativePath?: string; content?: string };
  log.line(`    read: ${data.relativePath} (type=${data.type})`);
  log.line("    ─── note content ───");
  for (const ln of String(data.content ?? "").trimEnd().split("\n")) log.line(`    ${ln}`);
  log.line("    ────────────────────");
  checks.push(
    check(
      out.ok &&
        data.type === "file" &&
        data.relativePath === "Projects/Plexus.md" &&
        (data.content ?? "").includes("discovered and read THIS note via the Plexus protocol"),
      "granted read returns REAL note content (the end-to-end proof)",
    ),
  );

  // Listing (omit path) enumerates the vault — real directory read.
  const listed = await client.invokeOrThrow(VAULT_READ_ID, {});
  const dir = listed.output as { type?: string; entries?: { name: string }[] };
  log.line(`    listing the vault: ${(dir.entries ?? []).map((e) => e.name).join(", ")}`);
  checks.push(
    check(
      dir.type === "dir" && (dir.entries ?? []).some((e) => e.name === "Index.md"),
      "granted read lists the vault (real directory read)",
    ),
  );

  // ── B5. READ-ONLY ENFORCEMENT — traversal confined; write verb not minted ────
  log.line("\nB5. READ-ONLY ENFORCEMENT  (traversal confined; write verb denied)");

  // Path traversal out of the vault is confined (real read-only + confinement). We
  // do this FIRST, while the held token still carries the READ scope, so the denial
  // proves CONFINEMENT (transport_error) rather than a missing grant.
  const traversal = await client.invoke(VAULT_READ_ID, { path: "../../../../etc/passwd" });
  log.line(`    traversal read: ok=${traversal.ok}, error.code=${traversal.error?.code}`);
  log.line(`      ${traversal.error?.message ?? ""}`);
  checks.push(
    check(
      !traversal.ok &&
        traversal.error?.code === "transport_error" &&
        traversal.error?.message?.toLowerCase().includes("confinement") === true,
      "a path-traversal read is CONFINED to the vault (escape denied with a granted read token)",
      traversal.error?.code,
    ),
  );

  // The capability declares only ["read"]; asking the gateway to mint a WRITE scope
  // on it is refused (no write verb to mint). (This clobbers the held read token, so
  // it runs LAST.) A protocol-level refusal is equally a valid denial.
  let writeDenied = false;
  let writeDetail = "";
  try {
    const writeReq = await client.requestGrants([VAULT_READ_ID], { verbs: ["write"] });
    const writeScope = writeReq.scopes.find((s) => s.id === VAULT_READ_ID);
    writeDenied = !writeScope || !writeScope.verbs.includes("write");
    writeDetail = `minted scopes: ${JSON.stringify(writeReq.scopes)}`;
  } catch (err) {
    writeDenied = err instanceof PlexusProtocolError;
    writeDetail = err instanceof Error ? err.message : String(err);
  }
  log.line(`    write grant refused: ${writeDenied} (${writeDetail})`);
  checks.push(check(writeDenied, "a WRITE grant on the read-only capability is NOT minted", writeDetail));

  return summarize("Scenario B — Obsidian vault read-only (discover → grant(read) → invoke → read; write+traversal denied)", checks);
}
