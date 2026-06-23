/**
 * m4skill — USER CUSTOM-SKILL authoring worked path (kind:"skill" attach).
 *
 * Proves, end-to-end and HONEST-GREEN, a user attaching their OWN usage skills to
 * capabilities so an agent discovers them as context (USER-AUTHORING-DESIGN §A;
 * EXTENSION-SPEC §6, §1). Two attach shapes:
 *
 *   (a) SAME-SOURCE — the author teaches their OWN capability; the back-link is
 *       wired FREELY (no cross-source boundary). Discoverable as a standalone
 *       kind:"skill" entry AND back-linked on the capability.
 *
 *   (b) CROSS-SOURCE — the author teaches an EXISTING first-party capability
 *       (obsidian.vault.read). DEFAULT-OFF:
 *         · a pure-wire `POST /extensions` register (no opt-in, no human) is a REAL
 *           denial — the cross-source attach is REJECTED and NOTHING activates;
 *         · with the `allowCrossSource` opt-in + a human approval it attaches, and
 *           the host entry is PROVENANCE-STAMPED so the foreign skill is
 *           distinguishable from a first-party describe;
 *         · the skill BODY reaches the agent's handshake manifest as context.
 *
 * Every denial is a real assertion driven through the published wire — no fake-green.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapabilityEntry,
  ExtensionManifest,
  ExtensionRegisterResponse,
  GrantPendingResponse,
  HandshakeResponse,
  Manifest,
} from "../src/protocol/index.ts";
import type { AttachedSkillProvenance } from "../src/sources/extension.ts";
import { createAppWithState } from "../src/core/server.ts";
import { loadConfig, expectedHost } from "../src/config.ts";
import { _resetSecretCacheForTests } from "../src/auth/index.ts";
import { openVaultExtension } from "../src/sources/obsidian/open-vault.ts";

import { runUserSkillDemo } from "../examples/m4-user-skill/demo.ts";
import {
  SAME_SOURCE_EXTENSION,
  USER_SKILL_EXTENSION,
  USER_SOURCE,
  OBSIDIAN_VAULT_READ_ID,
  SNIPPETS_READ_ID,
  SAME_SOURCE_SKILL_ID,
  CROSS_SOURCE_SKILL_ID,
} from "../examples/m4-user-skill/skill-manifests.ts";

const config = loadConfig();
const HOST = expectedHost(config);
const tmpDirs: string[] = [];

/** Boot a real gateway with the DEFAULT authorizer + a real first-party vault. */
function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-m4skill-"));
  tmpDirs.push(dir);
  const plexusHome = join(dir, "home");
  mkdirSync(plexusHome, { recursive: true });
  const vaultPath = join(dir, "Vault");
  mkdirSync(join(vaultPath, "Projects"), { recursive: true });
  writeFileSync(join(vaultPath, "Index.md"), "# Index\n");
  writeFileSync(join(vaultPath, "Projects", "Plexus.md"), "# Plexus\nA local capability gateway.\n");

  process.env.PLEXUS_HOME = plexusHome;
  _resetSecretCacheForTests();
  const { app, state } = createAppWithState(config);
  return { app, state, vaultPath };
}

function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function handshake(
  app: ReturnType<typeof freshApp>["app"],
  state: ReturnType<typeof freshApp>["state"],
): Promise<HandshakeResponse> {
  const res = await req(app, "/link/handshake", {
    method: "POST",
    body: JSON.stringify({
      connectionKey: state.connectionKey.current(),
      client: { name: "test", agentId: "agent-1" },
    }),
  });
  return (await res.json()) as HandshakeResponse;
}

/** Register the real first-party `obsidian.vault.read` (the cross-source target). */
async function registerVault(state: ReturnType<typeof freshApp>["state"], vaultPath: string) {
  const v = openVaultExtension(vaultPath);
  const reg = await state.capabilities.registerExtension(v.manifest, { handlers: v.handlers });
  expect(reg.ok).toBe(true);
}

function provenanceOf(entry: CapabilityEntry | undefined): AttachedSkillProvenance[] {
  const p = entry?.extras?.attachedSkillProvenance;
  return Array.isArray(p) ? (p as AttachedSkillProvenance[]) : [];
}

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

// ════════════════════════════════════════════════════════════════════════════
// 1 — SAME-SOURCE attach is applied freely + discoverable
// ════════════════════════════════════════════════════════════════════════════
describe("same-source skill attach (applied freely)", () => {
  it("back-links the author's own capability + is discoverable as a kind:\"skill\" entry", async () => {
    const { state } = freshApp();
    const reg = await state.capabilities.registerExtension(SAME_SOURCE_EXTENSION);
    expect(reg.ok).toBe(true);
    expect(reg.registered).toContain(SNIPPETS_READ_ID);
    expect(reg.registered).toContain(SAME_SOURCE_SKILL_ID);

    // The capability carries the back-link (entry.skills) to its usage skill.
    const cap = state.capabilities.getEntry(SNIPPETS_READ_ID);
    expect((cap?.skills ?? []).map((s) => s.id)).toContain(SAME_SOURCE_SKILL_ID);

    // The skill is a standalone discoverable kind:"skill" entry with grants:[] + body.
    const skill = state.capabilities.getEntry(SAME_SOURCE_SKILL_ID);
    expect(skill?.kind).toBe("skill");
    expect(skill?.grants).toEqual([]);
    expect(skill?.body?.markdown).toContain("kebab-case");

    // No provenance on a SAME-SOURCE attach — provenance is the cross-source marker.
    expect(provenanceOf(cap).length).toBe(0);
  });

  it("the same-source skill body reaches the agent's handshake manifest as context", async () => {
    const { app, state } = freshApp();
    await state.capabilities.registerExtension(SAME_SOURCE_EXTENSION);
    const hs = await handshake(app, state);
    const manifest = hs.manifest as Manifest;
    const skill = manifest.entries.find((e) => e.id === SAME_SOURCE_SKILL_ID);
    expect(skill?.kind).toBe("skill");
    expect(skill?.body?.markdown).toContain("Pass the exact `name`");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2 — CROSS-SOURCE attach is DEFAULT-OFF (real denial without opt-in + human)
// ════════════════════════════════════════════════════════════════════════════
describe("cross-source skill attach is DEFAULT-OFF", () => {
  it("a programmatic registerExtension (no opt-in) is REJECTED — REAL denial, nothing activates", async () => {
    const { state, vaultPath } = freshApp();
    await registerVault(state, vaultPath);

    // No allowCrossSource → the cross-source attach makes validation fail outright.
    const reg = await state.capabilities.registerExtension(USER_SKILL_EXTENSION);
    expect(reg.ok).toBe(false);
    expect(reg.reason?.toLowerCase()).toContain("cross-source");

    // The whole register is rejected: not even the same-source parts activated.
    expect(state.capabilities.getEntry(SNIPPETS_READ_ID)).toBeUndefined();
    // The first-party host carries NO foreign skill + NO provenance.
    const host = state.capabilities.getEntry(OBSIDIAN_VAULT_READ_ID);
    expect((host?.skills ?? []).some((s) => s.id === CROSS_SOURCE_SKILL_ID)).toBe(false);
    expect(provenanceOf(host).length).toBe(0);
  });

  it("the WIRE POST /extensions (no opt-in, no human) is REJECTED — not even pended", async () => {
    const { app, state, vaultPath } = freshApp();
    await registerVault(state, vaultPath);
    const hs = await handshake(app, state);

    // The wire path calls validateRegistration WITHOUT allowCrossSource → reject.
    const wireManifest: ExtensionManifest = { ...USER_SKILL_EXTENSION, source: "ezskills-wire" };
    const res = await req(app, "/extensions", {
      method: "POST",
      body: JSON.stringify({ sessionId: hs.sessionId, manifest: wireManifest }),
    });
    const body = (await res.json()) as ExtensionRegisterResponse & GrantPendingResponse;
    expect(body.ok).toBe(false);
    expect(body.reason?.toLowerCase()).toContain("cross-source");
    // A rejected manifest does NOT pend for a human (it never reaches the pend gate).
    expect(body.status).not.toBe("grant_pending_user");

    // Nothing activated; nothing is pending in the admin surface either.
    expect(state.capabilities.getEntry("ezskills-wire.obsidian.how-to-cite-well")).toBeUndefined();
    const pend = await req(app, "/admin/api/pending");
    const pendBody = (await pend.json()) as { pending: unknown[] };
    expect(pendBody.pending.length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3 — CROSS-SOURCE attach WITH opt-in + approval → attaches WITH provenance
// ════════════════════════════════════════════════════════════════════════════
describe("cross-source skill attach with opt-in + human approval", () => {
  it("attaches onto obsidian.vault.read, provenance-stamped, distinguishable from first-party", async () => {
    const { state, vaultPath } = freshApp();
    await registerVault(state, vaultPath);

    // The MANAGEMENT user opts in (the human's deliberate cross-source consent).
    const reg = await state.capabilities.registerExtension(USER_SKILL_EXTENSION, {
      allowCrossSource: true,
    });
    expect(reg.ok).toBe(true);

    const host = state.capabilities.getEntry(OBSIDIAN_VAULT_READ_ID);
    // Back-link present on the foreign host.
    expect((host?.skills ?? []).some((s) => s.id === CROSS_SOURCE_SKILL_ID)).toBe(true);

    // PROVENANCE-STAMPED with the AUTHORING source (≠ the host's own source).
    const prov = provenanceOf(host);
    const stamped = prov.find((p) => p.skillId === CROSS_SOURCE_SKILL_ID);
    expect(stamped).toBeDefined();
    expect(stamped!.authoringSource).toBe(USER_SOURCE);
    expect(stamped!.authoringSource).not.toBe(host!.source);

    // CONTRAST: obsidian's OWN bundled skill on the same host carries NO provenance —
    // proving provenance distinguishes a foreign attach from a first-party describe.
    const firstPartySkillRef = (host?.skills ?? []).find((s) => s.id === "obsidian.vault.how-to-cite");
    expect(firstPartySkillRef).toBeDefined();
    expect(prov.some((p) => p.skillId === "obsidian.vault.how-to-cite")).toBe(false);
  });

  it("the cross-source skill body reaches the agent's handshake manifest as context", async () => {
    const { app, state, vaultPath } = freshApp();
    await registerVault(state, vaultPath);
    await state.capabilities.registerExtension(USER_SKILL_EXTENSION, { allowCrossSource: true });

    const hs = await handshake(app, state);
    const manifest = hs.manifest as Manifest;

    // The skill body is delivered as context.
    const skill = manifest.entries.find((e) => e.id === CROSS_SOURCE_SKILL_ID);
    expect(skill?.kind).toBe("skill");
    expect(skill?.body?.markdown).toContain("vault-relative path");

    // The host the agent sees carries both the back-link AND the provenance.
    const host = manifest.entries.find((e) => e.id === OBSIDIAN_VAULT_READ_ID);
    expect((host?.skills ?? []).some((s) => s.id === CROSS_SOURCE_SKILL_ID)).toBe(true);
    expect(provenanceOf(host).some((p) => p.skillId === CROSS_SOURCE_SKILL_ID)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4 — the runnable example's worked path is green end-to-end (real socket)
// ════════════════════════════════════════════════════════════════════════════
describe("the runnable worked-path example is honest-green", () => {
  it("runUserSkillDemo passes every check over the real wire", async () => {
    const report = await runUserSkillDemo({ inProcess: true });
    const failed = report.checks.filter((c) => !c.ok).map((c) => c.label);
    expect(failed).toEqual([]);
    expect(report.overall).toBe(true);
  });
});
