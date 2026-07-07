/**
 * acceptance-e2e — the Plexus 1.0-rc TRUE end-to-end acceptance gate.
 *
 * Runs the codex×claudecode×Obsidian 玩法 (`tests/harnesses/acceptance/scenario.ts`
 * `runScenario()`) HEADLESS against a freshly-booted real gateway (in-process via
 * `app.request`, fetch-shaped — same uniform pipeline, no socket) and asserts EVERY
 * step is genuinely green: the codex agent authors + registers a write extension
 * (pend→approve→live), is granted read/write/claudecode.run, creates content
 * (claudecode.run record-mode), writes it into the temp Obsidian vault (verifiably
 * on disk + read back), the full audit chain is present + ordered, and a revoked
 * write token is rejected with HTTP 401 `token_revoked`.
 *
 * Hermetic: temp PLEXUS_HOME, temp vault, ephemeral loopback write-server, claudecode
 * record-only (no real `claude`), never binds :7077. The scenario cleans up its own
 * temp fixtures + restores env in a `finally`.
 */

import { describe, it, expect } from "bun:test";
import {
  runScenario,
  silentLogger,
  WRITER_WRITE_ID,
  WRITER_SOURCE_ID,
} from "./harnesses/acceptance/scenario.ts";
import { VAULT_READ_ID } from "@plexus/runtime/sources/obsidian/open-vault.ts";
import { CLAUDECODE_RUN_ID } from "@plexus/runtime/sources/claudecode/entries.ts";

describe("Plexus 1.0-rc — codex × claudecode × Obsidian acceptance玩法", () => {
  it("runs the whole pipeline end-to-end and every step is genuinely green", async () => {
    const report = await runScenario({ logger: silentLogger() });

    // Every individual harness check passed (the per-step ✓ assertions).
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed.map((c) => c.label)).toEqual([]);
    expect(report.pass).toBe(true);

    // ── Step 2: codex integrated (real session) ─────────────────────────────────
    expect(report.sessionId).toBeTruthy();

    // ── Step 3: the authored write extension is real + transport-backed + LIVE ───
    expect(report.authoredManifest.source).toBe(WRITER_SOURCE_ID);
    expect(report.authoredManifest.transport).toBe("local-rest");
    const writeDecl = report.authoredManifest.capabilities.find((c) => c.name === "vault.write");
    expect(writeDecl?.grants).toEqual(["write"]);
    expect(report.registeredWriteCaps).toContain(WRITER_WRITE_ID);

    // ── Step 4: all three grants minted ─────────────────────────────────────────
    expect(report.grantedCaps).toContain(VAULT_READ_ID);
    expect(report.grantedCaps).toContain(WRITER_WRITE_ID);
    expect(report.grantedCaps).toContain(CLAUDECODE_RUN_ID);

    // ── Step 5a: claudecode.run is HONEST record-mode (no real claude spawn) ──
    expect(report.ccRun.launched).toBe(false);
    expect(report.ccRun.sandboxed).toBe(true);
    expect(String(report.ccRun.reason ?? "")).toContain("record mode");

    // ── Step 5c: the note really landed + reads back identically ─────────────────
    expect(report.written.path).toBe("Inbox/Acceptance Recap.md");
    expect(report.readBack).toBe(report.written.content);

    // ── Step 6: the full audit chain is present + ordered ────────────────────────
    const kinds = report.audit.map((e) => e.type);
    expect(kinds).toContain("handshake");
    expect(kinds).toContain("source.install");
    expect(kinds.includes("grant.allow") || kinds.includes("grant.pending")).toBe(true);
    expect(kinds).toContain("token.issue");
    const invokedCaps = report.audit.filter((e) => e.type === "invoke").map((e) => e.capabilityId);
    expect(invokedCaps).toContain(CLAUDECODE_RUN_ID);
    expect(invokedCaps).toContain(VAULT_READ_ID);
    expect(invokedCaps).toContain(WRITER_WRITE_ID);
    // handshake precedes the first invoke.
    const firstHandshake = report.audit.findIndex((e) => e.type === "handshake");
    const firstInvoke = report.audit.findIndex((e) => e.type === "invoke");
    expect(firstHandshake).toBeGreaterThanOrEqual(0);
    expect(firstHandshake).toBeLessThan(firstInvoke);

    // ── Step 7: revoke proof — old write token rejected with 401 token_revoked ───
    expect(report.revokeDenial.status).toBe(401);
    expect(report.revokeDenial.code).toBe("token_revoked");

    // ── Negative-authz beats: the linchpin holds under MISUSE, not just the happy path ─
    // Each beat is a real call through the live pipeline whose EXPECTED outcome is a denial.
    const beats = new Map(report.negativeAuthz.map((b) => [b.label, b]));
    // Every beat was denied exactly as expected (nothing executed).
    expect(report.negativeAuthz.every((b) => b.ok)).toBe(true);
    expect(report.negativeAuthz.length).toBeGreaterThanOrEqual(3);

    // #1 — invoke a capability BEFORE its grant exists → grant_required (no execution).
    expect(beats.get("invoke-before-grant")?.code).toBe("grant_required");

    // #2 — replay a REVOKED token on a DIFFERENT (still-granted) capability → token_revoked.
    //      Proves revocation is jti-keyed: a revoked token can't be laundered onto another cap.
    expect(beats.get("revoked-token-replay-cross-capability")?.code).toBe("token_revoked");

    // #3 — use a valid token on a capability it was never granted for → grant_required.
    expect(beats.get("cross-capability-token-reuse")?.code).toBe("grant_required");
  }, 30_000);
});
