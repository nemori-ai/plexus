/**
 * t8 — cc-master AUTO-INSTALL: the idempotent, audited settings.json merge.
 *
 * CRITICAL SAFETY: every test writes to a TEMP `.claude/` dir injected via the
 * source's `claudeDir` option. The real `~/.claude/settings.json` is NEVER read or
 * mutated. Each test creates a fresh temp dir under the OS tmp prefix and cleans up.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CC_MASTER_MARKETPLACE,
  CC_MASTER_PLUGIN_KEY,
  mergeCcMasterIntoSettings,
  readCcMasterState,
} from "../src/sources/cc-master/install.ts";
import { CcMasterSource } from "../src/sources/index.ts";
import type { AuditEvent, AuditEventInput, PlatformServices } from "@plexus/protocol";

/** A minimal platform stub — `claude` present so the source is "ok". */
function platformStub(claudePath: string | undefined): PlatformServices {
  return {
    platform: "darwin",
    async resolveBinary(name) {
      return name === "claude" ? claudePath : undefined;
    },
    async getEnrichedPath() {
      return "/usr/bin";
    },
    async locateLocalService() {
      return undefined;
    },
    spawnProcess() {
      throw new Error("not used");
    },
    async resolveSecret() {
      return undefined;
    },
  };
}

function recordingAudit() {
  const events: AuditEventInput[] = [];
  const audit = async (e: AuditEventInput): Promise<AuditEvent> => {
    events.push(e);
    return { ...e, id: `audit-${events.length}`, at: new Date().toISOString() };
  };
  return { audit, events };
}

function readSettings(claudeDir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8"));
}

describe("cc-master install: settings.json merge into a TEMP dir", () => {
  let claudeDir: string;

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), "plexus-ccm-"));
  });
  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true });
  });

  it("merges enabledPlugins + extraKnownMarketplaces into a fresh (empty) settings", () => {
    const res = mergeCcMasterIntoSettings(claudeDir);
    expect(res.ok).toBe(true);
    expect(res.alreadyInstalled).toBe(false);
    expect(res.changed.sort()).toEqual(["enabledPlugins", "extraKnownMarketplaces"]);

    const settings = readSettings(claudeDir);
    expect(settings.enabledPlugins[CC_MASTER_PLUGIN_KEY]).toBe(true);
    expect(settings.extraKnownMarketplaces[CC_MASTER_MARKETPLACE]).toEqual({
      source: { source: "github", repo: "nemori-ai/cc-master" },
    });
  });

  it("is IDEMPOTENT: a second install is a no-op (no further changes)", () => {
    const first = mergeCcMasterIntoSettings(claudeDir);
    expect(first.alreadyInstalled).toBe(false);

    const second = mergeCcMasterIntoSettings(claudeDir);
    expect(second.ok).toBe(true);
    expect(second.alreadyInstalled).toBe(true);
    expect(second.changed).toEqual([]);

    // The file content is unchanged on the second pass (still exactly one cc-master entry).
    const settings = readSettings(claudeDir);
    expect(settings.enabledPlugins[CC_MASTER_PLUGIN_KEY]).toBe(true);
    expect(Object.keys(settings.extraKnownMarketplaces)).toEqual([CC_MASTER_MARKETPLACE]);
  });

  it("PRESERVES unrelated existing settings (only adds our two keys)", () => {
    // Seed a realistic settings.json with other plugins + marketplaces + misc keys.
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        theme: "dark",
        enabledPlugins: { "other@market": true, "off@market": false },
        extraKnownMarketplaces: {
          market: { source: { source: "github", repo: "acme/market" } },
        },
      }),
    );

    const res = mergeCcMasterIntoSettings(claudeDir);
    expect(res.changed.sort()).toEqual(["enabledPlugins", "extraKnownMarketplaces"]);

    const settings = readSettings(claudeDir);
    // Unrelated keys untouched.
    expect(settings.theme).toBe("dark");
    expect(settings.enabledPlugins["other@market"]).toBe(true);
    expect(settings.enabledPlugins["off@market"]).toBe(false);
    expect(settings.extraKnownMarketplaces.market).toEqual({
      source: { source: "github", repo: "acme/market" },
    });
    // Ours added.
    expect(settings.enabledPlugins[CC_MASTER_PLUGIN_KEY]).toBe(true);
    expect(settings.extraKnownMarketplaces[CC_MASTER_MARKETPLACE]).toBeDefined();
  });

  it("enables when installed-but-disabled (changes only enabledPlugins if marketplace already known)", () => {
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        enabledPlugins: { [CC_MASTER_PLUGIN_KEY]: false },
        extraKnownMarketplaces: {
          [CC_MASTER_MARKETPLACE]: { source: { source: "github", repo: "nemori-ai/cc-master" } },
        },
      }),
    );

    const res = mergeCcMasterIntoSettings(claudeDir);
    expect(res.alreadyInstalled).toBe(false);
    expect(res.changed).toEqual(["enabledPlugins"]); // marketplace already known
    expect(readSettings(claudeDir).enabledPlugins[CC_MASTER_PLUGIN_KEY]).toBe(true);
  });

  it("readCcMasterState reports installed/enabled from a TEMP installed_plugins.json", () => {
    // empty temp dir → nothing installed/enabled
    const empty = readCcMasterState(claudeDir);
    expect(empty.installed).toBe(false);
    expect(empty.enabled).toBe(false);
    expect(empty.marketplaceKnown).toBe(false);

    // seed installed_plugins.json (schema v2) + enabled settings
    mkdirSync(join(claudeDir, "plugins"), { recursive: true });
    writeFileSync(
      join(claudeDir, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { [CC_MASTER_PLUGIN_KEY]: [{ scope: "user" }] } }),
    );
    mergeCcMasterIntoSettings(claudeDir);

    const state = readCcMasterState(claudeDir);
    expect(state.installed).toBe(true);
    expect(state.enabled).toBe(true);
    expect(state.marketplaceKnown).toBe(true);
    expect(state.installedSchemaVersion).toBe(2);
  });
});

describe("cc-master source.install(): audited + idempotent through the source", () => {
  let claudeDir: string;
  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), "plexus-ccm-"));
  });
  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true });
  });

  it("install() merges into the injected temp dir and emits a source.install audit", async () => {
    const source = new CcMasterSource(platformStub("/usr/local/bin/claude"), { claudeDir });
    const { audit, events } = recordingAudit();

    const res = await source.install!({ audit, platform: platformStub("/usr/local/bin/claude") });
    expect(res.ok).toBe(true);
    expect(res.installed).toBe(CC_MASTER_PLUGIN_KEY);

    // Real merge happened in the TEMP dir.
    expect(readSettings(claudeDir).enabledPlugins[CC_MASTER_PLUGIN_KEY]).toBe(true);

    // Exactly one source.install audit, with redaction-safe detail (no file contents).
    const installAudits = events.filter((e) => e.type === "source.install");
    expect(installAudits.length).toBe(1);
    const first = installAudits[0]!;
    expect(first.outcome).toBe("ok");
    expect(first.detail).toMatchObject({
      source: "cc-master",
      plugin: CC_MASTER_PLUGIN_KEY,
      alreadyInstalled: false,
    });
  });

  it("install() is idempotent through the source (second call is a no-op success)", async () => {
    const source = new CcMasterSource(platformStub("/usr/local/bin/claude"), { claudeDir });
    const { audit, events } = recordingAudit();

    await source.install!({ audit, platform: platformStub("/usr/local/bin/claude") });
    const second = await source.install!({ audit, platform: platformStub("/usr/local/bin/claude") });

    expect(second.ok).toBe(true);
    expect(second.reason).toContain("no-op");
    const lastAudit = events.filter((e) => e.type === "source.install").at(-1)!;
    expect(lastAudit.detail).toMatchObject({ alreadyInstalled: true, changed: [] });
  });
});
