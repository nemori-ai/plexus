/**
 * G1-TEMPLATE — the deterministic CC-plugin renderer, proven END-TO-END.
 *
 * SSOT: docs/design/agent-skill-compile-domain-model.md §4 + Inv II/III/VI, ADR-6/ADR-8;
 *       docs/design/cc-plugin-artifact-spec.md §1/§2/§3/§5.
 *
 * Boots a REAL gateway + a read-only Obsidian vault (same harness as the G2 CLI e2e),
 * mints a one-time enrollment code + a standing grant, then:
 *   1. STRUCTURE     — renderPlugin/writePlugin emit the right skeleton: valid plugin.json
 *                      + marketplace.json, well-formed SKILL.md frontmatter, an executable
 *                      bin/plexus byte-identical to the committed G2 engine, install.sh.
 *   2. SECRET HYGIENE — no long-lived secret in ANY distributed file: the durable PAT is
 *                      never present; the one-time code is NOT baked into a file (it rides
 *                      the install COMMAND via env -> a 0600 scratch file per install.sh).
 *   3. FLOOR FIDELITY — the SKILL references ONLY granted caps; an un-advertised cap throws.
 *   4. DETERMINISM   — same (Floor + caps + agentId + code + stamp) -> byte-identical bytes.
 *   5. INV VI E2E    — the rendered artifact's OWN bin/plexus, run verbatim under `node`,
 *                      redeems the code -> PAT and then invokes a capability over the hidden
 *                      auth chain, printing JUST the real result. The auth core is the
 *                      committed engine, not anything this renderer authored.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, baseUrl as configBaseUrl } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { buildWellKnown } from "@plexus/runtime/core/well-known.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { openVaultExtension, VAULT_READ_ID } from "@plexus/runtime/sources/obsidian/open-vault.ts";
import { renderPlugin, writePlugin } from "@plexus/runtime/integration/index.ts";
import type { WellKnownDocument } from "@plexus/protocol";

const ENGINE_SOURCE = join(import.meta.dir, "..", "tools", "plexus-cli", "plexus");
const AGENT_ID = "cc-agent-g1";
const NOTE_TEXT = "The COMPILED plugin's own bin/plexus read THIS note via the hidden chain.";
const FIXED_STAMP = "2026-07-01T15:30:00.000Z";

async function pickFreePort(): Promise<number> {
  const probe = Bun.serve({ fetch: () => new Response("ok"), hostname: "127.0.0.1", port: 0 });
  const port = probe.port ?? 0;
  probe.stop(true);
  if (!port) throw new Error("could not pick a free port");
  return port;
}

interface Booted {
  baseUrl: string;
  serverHome: string;
  enrollCode: string;
  floor: WellKnownDocument;
  cleanup: () => void;
}

let booted: Booted;
let server: ReturnType<typeof Bun.serve>;

async function bootGateway(): Promise<Booted> {
  const serverHome = mkdtempSync(join(tmpdir(), "plexus-g1-server-"));
  process.env.PLEXUS_HOME = serverHome;
  _resetSecretCacheForTests();

  const port = await pickFreePort();
  const config = { ...loadConfig(), port } as ReturnType<typeof loadConfig>;
  const { app, state } = createAppWithState(config);

  const vaultRoot = mkdtempSync(join(tmpdir(), "plexus-g1-vault-"));
  const vaultPath = join(vaultRoot, "DemoVault");
  mkdirSync(join(vaultPath, "Projects"), { recursive: true });
  writeFileSync(join(vaultPath, "Index.md"), "# Index\nWelcome to the demo vault.\n");
  writeFileSync(join(vaultPath, "Projects", "Plexus.md"), `# Plexus\n${NOTE_TEXT}\n`);

  const { manifest, handlers } = openVaultExtension(vaultPath);
  const reg = await state.capabilities.registerExtension(manifest, { handlers });
  if (!reg.ok) throw new Error(`failed to register vault extension: ${reg.reason}`);

  // Admin-time provisioning: the one-time code (the plugin redeems it) + a STANDING grant.
  const { code } = state.agentEnrollment.mintEnrollmentCode(AGENT_ID);
  const now = Date.now();
  state.grants.put({
    agentId: AGENT_ID,
    capabilityId: VAULT_READ_ID,
    verbs: ["read"],
    grantedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
    trustWindow: { kind: "7d" },
    standing: true,
  });

  server = Bun.serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  const baseUrl = configBaseUrl(config);

  // The renderer's INPUT is the real Floor — the internal catalog-carrying doc
  // (buildWellKnown), NOT the public `.well-known`, which no longer ships a catalog
  // (authorized-subset model §3.3).
  const floor = buildWellKnown(config, state.capabilities.summaries());

  return {
    baseUrl,
    serverHome,
    enrollCode: code,
    floor,
    cleanup: () => {
      try {
        server.stop(true);
      } catch {
        /* ignore */
      }
      rmSync(serverHome, { recursive: true, force: true });
      rmSync(vaultRoot, { recursive: true, force: true });
    },
  };
}

beforeAll(async () => {
  booted = await bootGateway();
});

afterAll(() => {
  booted?.cleanup();
  delete process.env.PLEXUS_HOME;
});

function fileOf(files: { path: string; content: string; mode: number }[], p: string) {
  const f = files.find((x) => x.path === p);
  if (!f) throw new Error(`expected rendered file ${p}`);
  return f;
}

describe("G1 renderer — structure of the emitted CC plugin", () => {
  it("emits the full skeleton with valid plugin.json + marketplace.json", () => {
    const r = renderPlugin({
      floor: booted.floor,
      capabilityIds: [VAULT_READ_ID],
      agentId: AGENT_ID,
      enrollmentCode: booted.enrollCode,
      compileStamp: FIXED_STAMP,
    });

    expect(r.dirName).toBe(`plexus@${AGENT_ID}`);
    expect(r.pluginName).toBe("plexus");
    expect(r.marketplaceName).toBe("plexus");
    const paths = r.files.map((f) => f.path).sort();
    expect(paths).toEqual(
      [
        ".claude-plugin/marketplace.json",
        ".claude-plugin/plugin.json",
        "README.md",
        "bin/plexus",
        `bin/plexus-${AGENT_ID}`, // the per-agent, collision-proof launcher (Bug B)
        "install.sh",
        "skills/use-plexus/SKILL.md",
      ].sort(),
    );

    const plugin = JSON.parse(fileOf(r.files, ".claude-plugin/plugin.json").content) as {
      name: string;
      version: string;
      description: string;
    };
    expect(plugin.name).toBe("plexus"); // stable namespace + install target `plexus@plexus`
    expect(plugin.version).toBe(r.version);
    expect(plugin.version).toMatch(/^0\.1\.0-c\d+$/); // version == compile stamp (cache key)
    expect(plugin.description).toContain(VAULT_READ_ID);

    const mkt = JSON.parse(fileOf(r.files, ".claude-plugin/marketplace.json").content) as {
      name: string;
      plugins: { name: string; source: string }[];
    };
    expect(mkt.name).toBe("plexus");
    expect(mkt.plugins[0]?.name).toBe("plexus");
    expect(mkt.plugins[0]?.source).toBe("./"); // the dir itself is the plugin root
  });

  it("SKILL.md has well-formed frontmatter (name/description/allowed-tools) referencing only granted caps", () => {
    const r = renderPlugin({
      floor: booted.floor,
      capabilityIds: [VAULT_READ_ID],
      agentId: AGENT_ID,
      enrollmentCode: booted.enrollCode,
      compileStamp: FIXED_STAMP,
    });
    const skill = fileOf(r.files, "skills/use-plexus/SKILL.md").content;

    // Frontmatter is a well-formed leading YAML block.
    const m = skill.match(/^---\n([\s\S]*?)\n---\n/);
    expect(m).toBeTruthy();
    const fm = m![1]!;
    expect(fm).toMatch(/^name:\s*use-plexus$/m);
    expect(fm).toMatch(/^allowed-tools:\s*Bash$/m);
    expect(fm).toMatch(/^description:\s*>$/m);

    // Tier-1 description + the tier-2 cap header reference the granted cap and the agentId.
    expect(skill).toContain(VAULT_READ_ID);
    expect(skill).toContain(`agent \`${AGENT_ID}\``);
    // The prose body [P] carries no auth mechanics (no handshake/token wire terms).
    const body = skill.slice(m![0].length);
    expect(body).not.toContain("connectionKey");
    expect(body).not.toContain("/link/handshake");
    expect(body.toLowerCase()).not.toContain("bearer");
  });

  it("bin/plexus is present, executable, and BYTE-IDENTICAL to the committed G2 engine", () => {
    const dest = mkdtempSync(join(tmpdir(), "plexus-g1-write-"));
    try {
      const { root } = writePlugin(
        {
          floor: booted.floor,
          capabilityIds: [VAULT_READ_ID],
          agentId: AGENT_ID,
          enrollmentCode: booted.enrollCode,
          compileStamp: FIXED_STAMP,
        },
        dest,
      );
      const binPath = join(root, "bin", "plexus");
      expect(existsSync(binPath)).toBe(true);
      // Executable bit set.
      expect(statSync(binPath).mode & 0o111).not.toBe(0);
      // Verbatim engine (Inv VI: the auth core is the committed engine, not re-authored).
      expect(readFileSync(binPath, "utf8")).toBe(readFileSync(ENGINE_SOURCE, "utf8"));
      // install.sh executable too.
      expect(statSync(join(root, "install.sh")).mode & 0o111).not.toBe(0);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});

describe("G1 renderer — secret hygiene (Inv III)", () => {
  it("no long-lived secret in ANY distributed file; the one-time code rides the install command, not a file", () => {
    const r = renderPlugin({
      floor: booted.floor,
      capabilityIds: [VAULT_READ_ID],
      agentId: AGENT_ID,
      enrollmentCode: booted.enrollCode,
      compileStamp: FIXED_STAMP,
    });

    // The one-time code is NEVER inside a distributed file…
    for (const f of r.files) {
      expect(f.content.includes(booted.enrollCode)).toBe(false);
      expect(f.content.includes("plx_agent_x")).toBe(false); // no literal durable PAT
      expect(f.content).not.toMatch(/plx_agent_[A-Za-z0-9_-]{20,}/); // no real PAT baked
    }

    // …but the copy-able INSTALL COMMAND carries it via an env var (the safe channel).
    expect(r.installCommand).toContain(`PLEXUS_ENROLL_CODE="${booted.enrollCode}"`);
    expect(r.installCommand).toContain("install.sh");

    // install.sh consumes the code from the env into a 0600 scratch file, then redeems + deletes.
    const install = fileOf(r.files, "install.sh").content;
    expect(install).toContain("PLEXUS_ENROLL_CODE");
    expect(install).toContain("umask 177"); // 0600 scratch
    expect(install).toContain(".enroll");
    expect(install).toContain("enroll"); // redeem via the engine
    expect(install).toContain("rm -f"); // delete the scratch on success
    expect(install.includes(booted.enrollCode)).toBe(false); // still no baked code
  });
});

describe("G1 renderer — project-scope registration (agent-integration-project-scope §3)", () => {
  function render() {
    return renderPlugin({
      floor: booted.floor,
      capabilityIds: [VAULT_READ_ID],
      agentId: AGENT_ID,
      enrollmentCode: booted.enrollCode,
      compileStamp: FIXED_STAMP,
    });
  }

  it("install.sh registers into the project with --scope \"$PLEXUS_CC_SCOPE\" (validated local|project)", () => {
    const install = fileOf(render().files, "install.sh").content;
    expect(install).toContain('claude plugin marketplace add "$DIR" --scope "$PLEXUS_CC_SCOPE"');
    expect(install).toContain('claude plugin install "$PLUGIN_NAME@$MARKETPLACE" --scope "$PLEXUS_CC_SCOPE"');
    expect(install).toContain('PLEXUS_CC_SCOPE="${PLEXUS_CC_SCOPE:-local}"');
    expect(install).toContain('if [ "$PWD" = "$HOME" ]; then'); // the home-as-project loud warning
    // The printed contract: where it landed + /reload-plugins activation + the ad-hoc line.
    expect(install).toContain("installed into project $PWD");
    expect(install).toContain("/reload-plugins");
    expect(install).toContain("--plugin-dir");
  });

  it("README's manual section teaches the project-scope forms + the ad-hoc --plugin-dir line", () => {
    const readme = fileOf(render().files, "README.md").content;
    expect(readme).toContain("--scope local");
    expect(readme).not.toContain("--scope user");
    expect(readme).toContain("--plugin-dir");
    expect(readme).toContain("/reload-plugins");
  });
});

describe("G1 renderer — Floor fidelity + determinism", () => {
  it("throws when asked to reference a capability the Floor does not advertise (Inv II)", () => {
    expect(() =>
      renderPlugin({
        floor: booted.floor,
        capabilityIds: ["totally.made.up.cap"],
        agentId: AGENT_ID,
        enrollmentCode: booted.enrollCode,
        compileStamp: FIXED_STAMP,
      }),
    ).toThrow(/not advertised/);
  });

  it("is deterministic: same inputs (incl. stamp) -> byte-identical files, regardless of cap order", () => {
    const a = renderPlugin({
      floor: booted.floor,
      capabilityIds: [VAULT_READ_ID],
      agentId: AGENT_ID,
      enrollmentCode: booted.enrollCode,
      compileStamp: FIXED_STAMP,
    });
    // Re-render with a duplicated / differently-ordered cap list — must normalize identically.
    const b = renderPlugin({
      floor: booted.floor,
      capabilityIds: [VAULT_READ_ID, VAULT_READ_ID],
      agentId: AGENT_ID,
      enrollmentCode: booted.enrollCode,
      compileStamp: FIXED_STAMP,
    });
    expect(JSON.stringify(b.files)).toBe(JSON.stringify(a.files));
    expect(b.installCommand).toBe(a.installCommand);
  });
});

describe("G1 renderer — Inv VI end-to-end: the artifact's OWN bin/plexus works", () => {
  it("the rendered bin/plexus (run verbatim under node) enrolls then invokes over the hidden chain", async () => {
    const dest = mkdtempSync(join(tmpdir(), "plexus-g1-e2e-"));
    const clientHome = mkdtempSync(join(tmpdir(), "plexus-g1-client-"));
    try {
      const { root } = writePlugin(
        {
          floor: booted.floor,
          capabilityIds: [VAULT_READ_ID],
          agentId: AGENT_ID,
          enrollmentCode: booted.enrollCode,
          compileStamp: FIXED_STAMP,
        },
        dest,
      );
      const bin = join(root, "bin", "plexus");
      const env = {
        PATH: process.env.PATH ?? "",
        HOME: clientHome,
        PLEXUS_HOME: clientHome, // the agent's OWN store — no connection-key here (Inv III)
        PLEXUS_GATEWAY: booted.baseUrl,
      };

      // enroll: redeem the one-time code -> self-stored PAT (never baked into the artifact).
      const enroll = Bun.spawn(["node", bin, "enroll", booted.enrollCode], { env, stdout: "pipe", stderr: "pipe" });
      const enrollErr = await new Response(enroll.stderr).text();
      const enrollOut = await new Response(enroll.stdout).text();
      expect(await enroll.exited).toBe(0);
      expect(enrollErr).toBe("");
      expect(enrollOut).toContain(`Enrolled as '${AGENT_ID}'`);
      expect(existsSync(join(clientHome, "agents", `${AGENT_ID}.pat`))).toBe(true);
      // The client home never materializes a connection-key — pure PAT auth.
      expect(existsSync(join(clientHome, "connection-key"))).toBe(false);

      // call: the hidden handshake -> standing token -> invoke prints JUST the note content.
      const call = Bun.spawn(["node", bin, VAULT_READ_ID, "Projects/Plexus.md"], { env, stdout: "pipe", stderr: "pipe" });
      const callErr = await new Response(call.stderr).text();
      const callOut = await new Response(call.stdout).text();
      expect(await call.exited).toBe(0);
      expect(callErr).toBe("");
      expect(callOut).toContain(NOTE_TEXT);
      expect(callOut).not.toContain("plx_agent_"); // no plumbing leaks to stdout
      expect(callOut).not.toContain("Bearer");
    } finally {
      rmSync(dest, { recursive: true, force: true });
      rmSync(clientHome, { recursive: true, force: true });
    }
  });
});
