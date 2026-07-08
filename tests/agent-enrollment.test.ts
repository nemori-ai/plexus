/**
 * A1 — Per-agent enrollment core (agent-skill-compile §3, Inv III/VI, ADR-3/ADR-4).
 *
 * The agent-facing trust boundary: a one-time enrollment code (bootstrapped by the
 * admin) redeems ONCE for a durable per-agent bearer PAT; the PAT verifies to the
 * bound agentId; revoke kills exactly one agent. Mirrors the mesh enrollment primitive
 * (token-is-the-nonce, single-use, hash-at-rest) applied to HTTP agents.
 *
 * Covers BOTH halves:
 *   REGISTRY (unit): mint → redeem → PAT; single-use; expiry; hash-at-rest; forged PAT;
 *                    revoke (per-agent blast radius); durable persist across reload.
 *   ROUTE (POST /agents/enroll): redeem → { pat, agentId }; single-use 401; malformed 400.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import {
  AgentEnrollmentRegistry,
  createAgentEnrollmentRegistry,
  canonicalAgentType,
  deliversAsGeneric,
  deliversAsInContext,
} from "@plexus/runtime/core/agent-enrollment.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plexus-agent-enroll-"));
  process.env.PLEXUS_HOME = home;
});

afterEach(() => {
  delete process.env.PLEXUS_HOME;
  rmSync(home, { recursive: true, force: true });
});

const ledgerPath = () => join(home, "agent-enrollments.json");
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// ── Registry (unit) ──────────────────────────────────────────────────────────

describe("agent-enrollment registry — mint → redeem → verify", () => {
  it("mints a code, redeems it for a PAT, and verifyPat returns the bound agentId", () => {
    const reg = new AgentEnrollmentRegistry(ledgerPath());
    const { code, agentId } = reg.mintEnrollmentCode("agent-a");
    expect(agentId).toBe("agent-a");
    expect(reg.get("agent-a")!.status).toBe("pending");

    const out = reg.redeemEnrollmentCode(code);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.agentId).toBe("agent-a");
    expect(out.pat.startsWith("plx_agent_")).toBe(true);

    // The PAT verifies to exactly the bound agent; the row is now active.
    expect(reg.verifyPat(out.pat)).toBe("agent-a");
    expect(reg.isActive("agent-a")).toBe(true);
  });

  it("is SINGLE-USE — a second redeem of the same code fails", () => {
    const reg = new AgentEnrollmentRegistry(ledgerPath());
    const { code } = reg.mintEnrollmentCode("agent-b");

    const first = reg.redeemEnrollmentCode(code);
    expect(first.ok).toBe(true);
    const second = reg.redeemEnrollmentCode(code);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("code_consumed");
    // No second PAT minted — still exactly one active row.
    expect(reg.list().filter((r) => r.status === "active").length).toBe(1);
  });

  it("rejects an EXPIRED code (past its TTL)", () => {
    const reg = new AgentEnrollmentRegistry(ledgerPath());
    const { code } = reg.mintEnrollmentCode("agent-c", { ttlMs: 1_000 });
    const out = reg.redeemEnrollmentCode(code, new Date(Date.now() + 5_000));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("code_expired");
    expect(reg.isActive("agent-c")).toBe(false);
  });

  it("rejects a malformed (empty/non-string) code", () => {
    const reg = new AgentEnrollmentRegistry(ledgerPath());
    for (const bad of ["", undefined, null, 42, {}]) {
      const out = reg.redeemEnrollmentCode(bad as unknown);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe("malformed");
    }
  });

  it("rejects an UNKNOWN / forged code", () => {
    const reg = new AgentEnrollmentRegistry(ledgerPath());
    reg.mintEnrollmentCode("agent-d");
    const out = reg.redeemEnrollmentCode("plx_enroll_totally-forged-never-minted");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("unknown_code");
  });
});

describe("agent-enrollment registry — hash at rest", () => {
  it("persists only sha256 HASHES of the code and PAT, never the plaintext", () => {
    const reg = new AgentEnrollmentRegistry(ledgerPath());
    const { code } = reg.mintEnrollmentCode("agent-e");
    const out = reg.redeemEnrollmentCode(code);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(existsSync(ledgerPath())).toBe(true);
    const onDisk = readFileSync(ledgerPath(), "utf8");
    // NEITHER raw secret touches disk…
    expect(onDisk).not.toContain(code);
    expect(onDisk).not.toContain(out.pat);
    // …but BOTH hashes do.
    expect(onDisk).toContain(sha256(code));
    expect(onDisk).toContain(sha256(out.pat));
  });

  it("a wrong / forged PAT does not verify", () => {
    const reg = new AgentEnrollmentRegistry(ledgerPath());
    const { code } = reg.mintEnrollmentCode("agent-f");
    const out = reg.redeemEnrollmentCode(code);
    expect(out.ok).toBe(true);

    expect(reg.verifyPat("plx_agent_forged")).toBeNull();
    expect(reg.verifyPat("")).toBeNull();
    expect(reg.verifyPat(undefined as unknown)).toBeNull();
  });
});

describe("agent-enrollment registry — revoke (per-agent blast radius)", () => {
  it("revoke(agentId) stops THAT agent's PAT but leaves others verifying", () => {
    const reg = new AgentEnrollmentRegistry(ledgerPath());
    const a = reg.redeemEnrollmentCode(reg.mintEnrollmentCode("agent-1").code);
    const b = reg.redeemEnrollmentCode(reg.mintEnrollmentCode("agent-2").code);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(reg.revoke("agent-1")).toBe(true);
    expect(reg.verifyPat(a.pat)).toBeNull(); // agent-1 killed
    expect(reg.verifyPat(b.pat)).toBe("agent-2"); // agent-2 unaffected
    expect(reg.isActive("agent-1")).toBe(false);
    expect(reg.get("agent-1")!.status).toBe("revoked");

    // Idempotent — a second revoke is a no-op.
    expect(reg.revoke("agent-1")).toBe(false);
    expect(reg.revoke("never-existed")).toBe(false);
  });

  it("remove(agentId) deletes the row entirely — PAT dead, off the roster, durable", () => {
    const path = ledgerPath();
    const reg = new AgentEnrollmentRegistry(path);
    const a = reg.redeemEnrollmentCode(reg.mintEnrollmentCode("agent-x").code);
    const b = reg.redeemEnrollmentCode(reg.mintEnrollmentCode("agent-y").code);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(reg.remove("agent-x")).toBe(true);
    expect(reg.verifyPat(a.pat)).toBeNull(); // agent-x PAT stops verifying
    expect(reg.get("agent-x")).toBeUndefined(); // NO tombstone — the row is gone
    expect(reg.list().some((r) => r.agentId === "agent-x")).toBe(false); // off the roster
    expect(reg.verifyPat(b.pat)).toBe("agent-y"); // agent-y untouched

    // Idempotent — removing an unknown / already-removed agent is a no-op.
    expect(reg.remove("agent-x")).toBe(false);
    expect(reg.remove("never-existed")).toBe(false);

    // Durable — a fresh registry over the same ledger does not see the removed row,
    // and the removed agent's PAT stays dead (no row ⇒ fail-closed).
    const reloaded = new AgentEnrollmentRegistry(path);
    expect(reloaded.get("agent-x")).toBeUndefined();
    expect(reloaded.verifyPat(a.pat)).toBeNull();
    expect(reloaded.verifyPat(b.pat)).toBe("agent-y");
  });
});

describe("agent-enrollment registry — durable persistence", () => {
  it("survives a reload: an active PAT still verifies against a fresh registry", () => {
    const reg = new AgentEnrollmentRegistry(ledgerPath());
    const out = reg.redeemEnrollmentCode(reg.mintEnrollmentCode("agent-persist").code);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // Fresh registry over the same PLEXUS_HOME = "restart".
    const reloaded = createAgentEnrollmentRegistry();
    expect(reloaded.verifyPat(out.pat)).toBe("agent-persist");
    expect(reloaded.isActive("agent-persist")).toBe(true);

    // A revoke on the reloaded instance also persists — a third instance sees it dead.
    expect(reloaded.revoke("agent-persist")).toBe(true);
    const third = createAgentEnrollmentRegistry();
    expect(third.verifyPat(out.pat)).toBeNull();
  });

  it("re-minting a code for an already-enrolled agent invalidates the old PAT (lost-PAT re-issue)", () => {
    const reg = new AgentEnrollmentRegistry(ledgerPath());
    const first = reg.redeemEnrollmentCode(reg.mintEnrollmentCode("agent-reissue").code);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(reg.verifyPat(first.pat)).toBe("agent-reissue");

    // Admin re-issues a code → old PAT dies, new code redeems to a new PAT.
    const { code: code2 } = reg.mintEnrollmentCode("agent-reissue");
    expect(reg.verifyPat(first.pat)).toBeNull();
    const second = reg.redeemEnrollmentCode(code2);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(reg.verifyPat(second.pat)).toBe("agent-reissue");
    expect(second.pat).not.toBe(first.pat);
  });

  it("persists the agentType (delivery form) + preserves it across a re-mint", () => {
    const reg = new AgentEnrollmentRegistry(ledgerPath());
    reg.mintEnrollmentCode("agent-typed", { agentType: "generic" });
    expect(reg.get("agent-typed")?.agentType).toBe("generic");

    // A re-mint WITHOUT re-stating the type preserves it (lost-PAT re-issue keeps delivery form).
    reg.mintEnrollmentCode("agent-typed");
    expect(reg.get("agent-typed")?.agentType).toBe("generic");

    // It survives a reload (durable).
    const reloaded = createAgentEnrollmentRegistry();
    expect(reloaded.get("agent-typed")?.agentType).toBe("generic");
  });

  it("canonicalizes the three delivery forms + routes them disjointly", () => {
    // claude-code / in-context are their own forms; anything else non-empty collapses to generic.
    expect(canonicalAgentType("claude-code")).toBe("claude-code");
    expect(canonicalAgentType("In-Context")).toBe("in-context");
    expect(canonicalAgentType("generic")).toBe("generic");
    expect(canonicalAgentType("codex")).toBe("generic");
    expect(canonicalAgentType("")).toBeUndefined();
    expect(canonicalAgentType(undefined)).toBeUndefined();

    // The delivery routers are DISJOINT: in-context is neither generic nor claude-code.
    expect(deliversAsInContext("in-context")).toBe(true);
    expect(deliversAsGeneric("in-context")).toBe(false);
    expect(deliversAsGeneric("generic")).toBe(true);
    expect(deliversAsInContext("generic")).toBe(false);
    // claude-code / legacy-undefined take neither portable form (→ the compiled plugin).
    expect(deliversAsGeneric("claude-code")).toBe(false);
    expect(deliversAsInContext("claude-code")).toBe(false);
    expect(deliversAsGeneric(undefined)).toBe(false);
    expect(deliversAsInContext(undefined)).toBe(false);
  });

  it("persists the in-context delivery form across a re-mint + reload", () => {
    const reg = new AgentEnrollmentRegistry(ledgerPath());
    reg.mintEnrollmentCode("agent-http", { agentType: "in-context" });
    expect(reg.get("agent-http")?.agentType).toBe("in-context");
    reg.mintEnrollmentCode("agent-http");
    expect(reg.get("agent-http")?.agentType).toBe("in-context");
    const reloaded = createAgentEnrollmentRegistry();
    expect(reloaded.get("agent-http")?.agentType).toBe("in-context");
  });

  it("setAgentType switches the delivery form WITHOUT minting / dropping the code (A1)", () => {
    const reg = new AgentEnrollmentRegistry(ledgerPath());
    const minted = reg.mintEnrollmentCode("agent-switch", { agentType: "claude-code" });
    const codeHashBefore = reg.get("agent-switch")?.codeHash;
    const expiryBefore = reg.get("agent-switch")?.codeExpiresAt;

    // Switch the delivery form — a pure projection change: agentType flips, but the row's code
    // (its hash + expiry) and PENDING status are UNTOUCHED (no mint, no PAT drop).
    expect(reg.setAgentType("agent-switch", "in-context")).toBe(true);
    const row = reg.get("agent-switch");
    expect(row?.agentType).toBe("in-context");
    expect(row?.codeHash).toBe(codeHashBefore!); // ← same code — not re-minted
    expect(row?.codeExpiresAt).toBe(expiryBefore!);
    expect(row?.status).toBe("pending");

    // The original code is therefore STILL redeemable (the switch minted nothing).
    const outcome = reg.redeemEnrollmentCode(minted.code);
    expect(outcome.ok).toBe(true);

    // No-ops safely for an unknown agent; the persisted form survives a reload.
    expect(reg.setAgentType("ghost", "generic")).toBe(false);
    const reloaded = createAgentEnrollmentRegistry();
    expect(reloaded.get("agent-switch")?.agentType).toBe("in-context");
  });
});

// ── N2: tampered-ledger hardening (load() validation) ─────────────────────────

describe("agent-enrollment registry — load() rejects tampered rows", () => {
  // Write a raw ledger file directly (simulating a locally-tampered
  // ~/.plexus/agent-enrollments.json), then load a fresh registry over it.
  const writeLedger = (records: unknown[]) => {
    writeFileSync(ledgerPath(), JSON.stringify({ version: 1, records }, null, 2), { mode: 0o600 });
  };

  it("drops an ACTIVE row that carries NO patHash — it can never authenticate", () => {
    // An attacker can't know a valid PAT's plaintext, but could try to inject an
    // active row with a chosen/absent patHash. A patHash-less active row is malformed
    // and must not load into the active index.
    writeLedger([
      {
        agentId: "agent-no-pat",
        status: "active",
        codeHash: sha256("some-code"),
        codeExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        issuedAt: new Date().toISOString(),
        // patHash intentionally absent
      },
    ]);
    const reg = new AgentEnrollmentRegistry(ledgerPath());
    // The row was dropped entirely — nothing to verify, nothing active.
    expect(reg.get("agent-no-pat")).toBeUndefined();
    expect(reg.isActive("agent-no-pat")).toBe(false);
  });

  it("drops a row with an out-of-set status — no injected credential survives", () => {
    const forgedPatHash = sha256("plx_agent_attacker-chosen");
    writeLedger([
      {
        agentId: "agent-bad-status",
        status: "superuser", // not in {pending,active,revoked}
        codeHash: sha256("c"),
        codeExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        patHash: forgedPatHash,
        issuedAt: new Date().toISOString(),
      },
    ]);
    const reg = new AgentEnrollmentRegistry(ledgerPath());
    expect(reg.get("agent-bad-status")).toBeUndefined();
    // Even armed with the row's chosen patHash, verifyPat never authenticates it.
    expect(reg.verifyPat("plx_agent_attacker-chosen")).toBeNull();
  });

  it("still loads VALID rows sitting alongside a tampered one (fail-safe, not fail-all)", () => {
    // First mint+redeem a genuine agent so we have a real active row + its PAT.
    const seed = new AgentEnrollmentRegistry(ledgerPath());
    const out = seed.redeemEnrollmentCode(seed.mintEnrollmentCode("agent-good").code);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // Read the genuine ledger back, append a tampered active row (no patHash), rewrite.
    const disk = JSON.parse(readFileSync(ledgerPath(), "utf8")) as { records: unknown[] };
    disk.records.push({
      agentId: "agent-tampered",
      status: "active",
      codeHash: sha256("x"),
      codeExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      issuedAt: new Date().toISOString(),
    });
    writeLedger(disk.records);

    const reg = new AgentEnrollmentRegistry(ledgerPath());
    // Tampered row dropped…
    expect(reg.get("agent-tampered")).toBeUndefined();
    // …but the genuine active PAT still verifies.
    expect(reg.verifyPat(out.pat)).toBe("agent-good");
    expect(reg.isActive("agent-good")).toBe(true);
  });
});

// ── POST /agents/enroll (route) ───────────────────────────────────────────────

const config = loadConfig();
const HOST = expectedHost(config);

function freshApp() {
  _resetSecretCacheForTests();
  return createAppWithState(config);
}
function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

describe("POST /agents/enroll", () => {
  it("redeems a valid code → { pat, agentId } and the PAT verifies", async () => {
    const { app, state } = freshApp();
    const { code } = state.agentEnrollment.mintEnrollmentCode("agent-http");

    const res = await req(app, "/agents/enroll", { method: "POST", body: JSON.stringify({ code }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pat: string; agentId: string };
    expect(body.agentId).toBe("agent-http");
    expect(body.pat.startsWith("plx_agent_")).toBe(true);
    expect(state.agentEnrollment.verifyPat(body.pat)).toBe("agent-http");
  });

  it("is single-use over the wire — a second redeem of the same code is 401", async () => {
    const { app, state } = freshApp();
    const { code } = state.agentEnrollment.mintEnrollmentCode("agent-http2");
    expect((await req(app, "/agents/enroll", { method: "POST", body: JSON.stringify({ code }) })).status).toBe(200);

    const res2 = await req(app, "/agents/enroll", { method: "POST", body: JSON.stringify({ code }) });
    expect(res2.status).toBe(401);
    const body = (await res2.json()) as { error: { code: string } };
    expect(body.error.code).toBe("code_consumed");
  });

  it("fails closed with 400 on a malformed body (no code)", async () => {
    const { app } = freshApp();
    const res = await req(app, "/agents/enroll", { method: "POST", body: JSON.stringify({ nope: 1 }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("malformed");

    // Non-JSON body → 400 too.
    const res2 = await req(app, "/agents/enroll", { method: "POST", body: "{not json" });
    expect(res2.status).toBe(400);
  });

  it("rejects an unknown code with 401 (the connection-key is never accepted here)", async () => {
    const { app, state } = freshApp();
    const res = await req(app, "/agents/enroll", {
      method: "POST",
      // Present the ADMIN connection-key as a code — it must NOT enroll anything.
      body: JSON.stringify({ code: state.connectionKey.current() }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unknown_code");
  });
});
