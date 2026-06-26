/**
 * Managed HEADLESS launcher — argv + safety + (optional) real synthetic-plugin spawn.
 *
 * Proves the v1 managed-launch slice:
 *  - `buildLaunchArgv` / `ClaudeLauncher.argvFor` build `--plugin-dir <dir> -p` when
 *    loadCcMaster is ON, and OMIT `--plugin-dir` when OFF.
 *  - the launcher fails CLEANLY when `claude` is absent (no spawn).
 *  - `validateEmbeddedPlugin()` passes on the REAL vendored plugin (STRUCTURAL only —
 *    NEVER headless-launches the real cc-master) and fails on a non-plugin dir.
 *  - a REAL spawn of a SYNTHETIC fixture plugin (a tiny dir whose UserPromptSubmit
 *    hook writes a marker file) drops the marker — proving `--plugin-dir` really loads
 *    a plugin headless. This uses a FAKE `claude` shim (a shell script that emulates
 *    the hook firing), so it is deterministic + zero-LLM + never touches the real
 *    `claude` or the real cc-master plugin.
 *
 * SAFETY: the real cc-master plugin gets STRUCTURAL validation ONLY. No test in this
 * file spawns the real `claude` or the real embedded plugin.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildLaunchArgv,
  ClaudeLauncher,
  defaultCapture,
  type CaptureResult,
} from "@plexus/runtime/sources/cc-master/launch.ts";
import {
  EMBEDDED_PLUGIN_DIR,
  resolveEmbeddedPluginDir,
  validateEmbeddedPlugin,
} from "@plexus/runtime/sources/cc-master/embedded-plugin.ts";
import { CcMasterBridge } from "@plexus/runtime/sources/cc-master/bridge.ts";
import { AGENT_DISPATCH_ID, ccMasterEntries } from "@plexus/runtime/sources/cc-master/entries.ts";
import type {
  AuditEvent,
  AuditEventInput,
  BridgeDeps,
  CapabilityEntry,
  InvokeContext,
} from "@plexus/protocol";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("launcher: argv construction", () => {
  it("injects --plugin-dir <embedded> -p when loadCcMaster is ON", () => {
    const argv = buildLaunchArgv({ loadCcMaster: true, prompt: "do it", embeddedPluginDir: "/x/plugin" });
    expect(argv).toEqual(["--plugin-dir", "/x/plugin", "-p", "do it"]);
  });

  it("OMITS --plugin-dir when loadCcMaster is OFF (plain managed `claude -p`)", () => {
    const argv = buildLaunchArgv({ loadCcMaster: false, prompt: "do it", embeddedPluginDir: "/x/plugin" });
    expect(argv).toEqual(["-p", "do it"]);
    expect(argv).not.toContain("--plugin-dir");
  });

  it("ClaudeLauncher.argvFor mirrors buildLaunchArgv with the injected embedded dir", () => {
    const launcher = new ClaudeLauncher({
      resolveBinary: async () => "/usr/local/bin/claude",
      embeddedPluginDir: "/embed/cc",
    });
    expect(launcher.argvFor(true, "p")).toEqual(["--plugin-dir", "/embed/cc", "-p", "p"]);
    expect(launcher.argvFor(false, "p")).toEqual(["-p", "p"]);
  });
});

describe("launcher: clean failure + fake-spawn capture", () => {
  it("fails cleanly when `claude` is not on PATH (no spawn)", async () => {
    let spawned = false;
    const launcher = new ClaudeLauncher({
      resolveBinary: async () => undefined,
      capture: async () => {
        spawned = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const res = await launcher.launch({ loadCcMaster: true, prompt: "x" });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("not found on PATH");
    expect(spawned).toBe(false);
  });

  it("builds the right argv and captures stdout/exit via a FAKE spawner", async () => {
    const seen: { command: string; args: string[] }[] = [];
    const launcher = new ClaudeLauncher({
      resolveBinary: async (n) => (n === "claude" ? "/usr/local/bin/claude" : undefined),
      // Skip the embedded structural validation in this pure-argv test.
      validate: () => ({ ok: true }),
      capture: async (spec): Promise<CaptureResult> => {
        seen.push({ command: spec.command, args: spec.args });
        return { stdout: "headless output", stderr: "", exitCode: 0 };
      },
    });
    const res = await launcher.launch({ loadCcMaster: true, prompt: "ship it" });
    expect(res.ok).toBe(true);
    expect(res.output).toBe("headless output");
    expect(res.exitCode).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.command).toBe("/usr/local/bin/claude");
    expect(seen[0]!.args).toContain("--plugin-dir");
    expect(seen[0]!.args).toContain("-p");
  });

  it("a bad embedded plugin fails cleanly when loadCcMaster is on (no spawn)", async () => {
    let spawned = false;
    const launcher = new ClaudeLauncher({
      resolveBinary: async () => "/usr/local/bin/claude",
      validate: () => ({ ok: false, reason: "missing plugin.json" }),
      capture: async () => {
        spawned = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const res = await launcher.launch({ loadCcMaster: true, prompt: "x" });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("embedded cc-master plugin invalid");
    expect(spawned).toBe(false);
  });
});

describe("validateEmbeddedPlugin: STRUCTURAL check on the REAL vendored plugin", () => {
  it("passes on the real embedded cc-master plugin (files-on-disk only — no launch)", () => {
    const v = validateEmbeddedPlugin(EMBEDDED_PLUGIN_DIR);
    expect(v.ok).toBe(true);
    expect(v.name).toBe("cc-master");
    expect(typeof v.version).toBe("string");
  });

  it("resolveEmbeddedPluginDir(dev) points at the vendored cc-master-plugin dir", () => {
    expect(EMBEDDED_PLUGIN_DIR.endsWith("cc-master-plugin")).toBe(true);
    expect(existsSync(EMBEDDED_PLUGIN_DIR)).toBe(true);
  });

  it("resolveEmbeddedPluginDir(packaged) resolves under resourcesPath", () => {
    const dir = resolveEmbeddedPluginDir({ packaged: true, resourcesPath: "/Resources" });
    expect(dir).toBe("/Resources/cc-master-plugin");
  });

  it("fails on a non-plugin dir", () => {
    const empty = tmp("plexus-noplugin-");
    const v = validateEmbeddedPlugin(empty);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("plugin.json");
  });

  it("REJECTS a structurally-valid plugin whose identity (name) is not cc-master (SECURITY #4)", () => {
    // A dir that PASSES the old structural-only check (parses + all key dirs exist) but is
    // NOT the vendored cc-master plugin — e.g. an attacker dir a PLEXUS_CC_EMBEDDED_PLUGIN_DIR
    // override could point at. The identity gate must reject it.
    const impostor = tmp("plexus-impostor-plugin-");
    mkdirSync(join(impostor, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(impostor, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "not-cc-master", version: "9.9.9" }),
    );
    for (const sub of ["hooks", "skills", "commands"]) mkdirSync(join(impostor, sub), { recursive: true });
    const v = validateEmbeddedPlugin(impostor);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("identity mismatch");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// TRACKED LAUNCH SMOKE — "launch PROVES EXECUTION" (complements the record-mode wiring proof)
// ════════════════════════════════════════════════════════════════════════════════════
//
// The acceptance e2e (`tests/harnesses/acceptance/scenario.ts`) runs cc-master in RECORD-MODE
// (no real spawn) — it proves the WIRING (the argv the bridge WOULD run). This smoke is the
// complementary artifact that proves LAUNCH ACTUALLY EXECUTES: with the headless-launch gate
// ON, the bridge REALLY spawns `claude --plugin-dir <plugin> -p` and the plugin LOADS — proven
// DETERMINISTICALLY by a marker file the plugin's UserPromptSubmit hook writes.
//
// HERMETIC / CI-SAFE: it uses a SYNTHETIC fixture plugin (a tiny dir whose hook writes a
// marker) — NEVER the real embedded cc-master (whose hooks bootstrap a nested orchestration) —
// and a FAKE `claude` shim (a tiny shell script emulating `claude --plugin-dir X -p` by firing
// the plugin's hook). So it needs NO real `claude`, NO network, NO LLM, and never touches
// ~/.claude. Two layers are asserted:
//   (1) at the LAUNCHER level (`ClaudeLauncher` + `defaultCapture`): gate ON ⇒ --plugin-dir
//       injected ⇒ real spawn ⇒ marker; gate OFF ⇒ no --plugin-dir ⇒ no marker.
//   (2) at the BRIDGE level (`agent.dispatch` handler under `PLEXUS_CC_HEADLESS_LAUNCH`):
//       gate ON ⇒ `launched:true` + marker (the embedded launch path REALLY ran); gate OFF ⇒
//       `launched:false`, `agentExecution:"recorded"`, NO marker (record-mode, the guardrail).
// ── Shared fixtures for the TRACKED LAUNCH SMOKE (launcher-level + bridge-level) ──────

/**
 * Build a tiny SYNTHETIC plugin dir: a valid `.claude-plugin/plugin.json` + the
 * key dirs + a UserPromptSubmit hook script that writes a marker file. This is the
 * proven technique — it is NOT the real cc-master (whose hooks bootstrap an
 * orchestration). We pair it with a FAKE `claude` shim that emulates Claude Code
 * firing the plugin's UserPromptSubmit hook, so the spawn is deterministic + offline.
 */
function makeSyntheticPlugin(markerPath: string): string {
  const plugin = tmp("plexus-synthplugin-");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  // Name it "cc-master" so it passes the launcher's identity validation (SECURITY #4) —
  // this fixture proves the --plugin-dir spawn + marker mechanism, not name diversity.
  writeFileSync(
    join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "cc-master", version: "0.0.1" }),
  );
  mkdirSync(join(plugin, "hooks", "scripts"), { recursive: true });
  mkdirSync(join(plugin, "skills"), { recursive: true });
  mkdirSync(join(plugin, "commands"), { recursive: true });
  const hookScript = join(plugin, "hooks", "scripts", "marker.sh");
  writeFileSync(hookScript, `#!/usr/bin/env bash\necho "loaded" > "${markerPath}"\n`);
  chmodSync(hookScript, 0o755);
  writeFileSync(
    join(plugin, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/marker.sh" }] },
        ],
      },
    }),
  );
  return plugin;
}

/**
 * A FAKE `claude` shim: a shell script that, given `--plugin-dir <dir> -p <prompt>`,
 * runs that plugin's UserPromptSubmit hook script (the marker writer) with
 * CLAUDE_PLUGIN_ROOT set — emulating Claude Code loading the plugin headless.
 */
function makeFakeClaude(): string {
  const bin = tmp("plexus-fakeclaude-");
  const claude = join(bin, "claude");
  writeFileSync(
    claude,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'plugin_dir=""',
      'while [[ $# -gt 0 ]]; do',
      '  case "$1" in',
      '    --plugin-dir) plugin_dir="$2"; shift 2;;',
      '    -p) shift 2;;',
      '    *) shift;;',
      '  esac',
      "done",
      'if [[ -n "$plugin_dir" ]]; then',
      '  CLAUDE_PLUGIN_ROOT="$plugin_dir" bash "$plugin_dir/hooks/scripts/marker.sh"',
      "fi",
      'echo "ok"',
    ].join("\n") + "\n",
  );
  chmodSync(claude, 0o755);
  return claude;
}

describe("TRACKED LAUNCH SMOKE — real spawn of a SYNTHETIC plugin proves --plugin-dir loads (marker-file proof)", () => {
  it("real spawn of the synthetic plugin via --plugin-dir drops the marker file", async () => {
    const work = tmp("plexus-marker-");
    const markerPath = join(work, "marker.txt");
    const plugin = makeSyntheticPlugin(markerPath);
    const fakeClaude = makeFakeClaude();

    const launcher = new ClaudeLauncher({
      resolveBinary: async (n) => (n === "claude" ? fakeClaude : undefined),
      embeddedPluginDir: plugin,
      // Use the REAL default capture (raw spawn) against the fake claude + synthetic plugin.
      capture: defaultCapture,
    });

    expect(existsSync(markerPath)).toBe(false);
    const res = await launcher.launch({ loadCcMaster: true, prompt: "go" });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    // THE PROOF: the plugin's hook fired under --plugin-dir, writing the marker.
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8").trim()).toBe("loaded");
    // And argv carried the injection.
    expect(res.argv).toContain("--plugin-dir");
    expect(res.argv).toContain(plugin);
  });

  it("with loadCcMaster:false the fake claude gets NO --plugin-dir ⇒ no marker", async () => {
    const work = tmp("plexus-marker-");
    const markerPath = join(work, "marker.txt");
    const plugin = makeSyntheticPlugin(markerPath);
    const fakeClaude = makeFakeClaude();

    const launcher = new ClaudeLauncher({
      resolveBinary: async () => fakeClaude,
      embeddedPluginDir: plugin,
      capture: defaultCapture,
    });
    const res = await launcher.launch({ loadCcMaster: false, prompt: "go" });
    expect(res.ok).toBe(true);
    expect(res.argv).not.toContain("--plugin-dir");
    // No plugin injected ⇒ the hook never fired ⇒ no marker.
    expect(existsSync(markerPath)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// TRACKED LAUNCH SMOKE — BRIDGE-LEVEL gate proof: PLEXUS_CC_HEADLESS_LAUNCH end-to-end
// ════════════════════════════════════════════════════════════════════════════════════
//
// The block above proves the LAUNCHER spawns + loads a plugin. This block proves the
// GATE that decides whether the bridge spawns AT ALL: it drives the REAL `CcMasterBridge`
// `cc-master.agent.dispatch` handler — the exact code path the acceptance e2e exercises in
// RECORD-MODE — but with the headless-launch gate (`PLEXUS_CC_HEADLESS_LAUNCH`) flipped:
//   - gate ON  ⇒ the handler REALLY calls the injected launcher ⇒ fake `claude` fires the
//                synthetic plugin's hook ⇒ marker appears; the response is HONEST
//                (`launched:true`, `agentExecution:"launched"`).
//   - gate OFF ⇒ the handler records the board only (`launched:false`,
//                `agentExecution:"recorded"`) and NO marker is written (the guardrail —
//                the same record-mode the hermetic acceptance e2e runs in).
//
// Hermetic: a temp PLEXUS_HOME for the board file, a SYNTHETIC plugin + FAKE `claude` shim
// (no real `claude`, no LLM, no network), and a minimal in-test `BridgeDeps` whose `audit`
// just collects events. The gate env var is saved + restored so it never leaks to the rest
// of the suite (keeping the MAIN suite hermetic + record-mode by default).
describe("TRACKED LAUNCH SMOKE (bridge gate) — agent.dispatch honors PLEXUS_CC_HEADLESS_LAUNCH end-to-end", () => {
  /** A minimal BridgeDeps: audit collects; the dispatch handler never needs the others. */
  function stubDeps(entries: CapabilityEntry[]): { deps: BridgeDeps; events: AuditEvent[] } {
    const events: AuditEvent[] = [];
    const byId = new Map(entries.map((e) => [e.id, e]));
    const deps: BridgeDeps = {
      audit: async (e: AuditEventInput) => {
        const full = { ...e, id: `evt-${events.length}`, ts: new Date().toISOString() } as unknown as AuditEvent;
        events.push(full);
        return full;
      },
      getTransport: () => {
        throw new Error("agent.dispatch is served by an in-process handler; no transport needed");
      },
      getEntry: (id) => byId.get(id),
      invokeById: async () => {
        throw new Error("agent.dispatch does not re-enter the pipeline");
      },
    };
    return { deps, events };
  }

  const ctx: InvokeContext = { jti: "tok-smoke", sessionId: "sess-smoke", scopes: [] };

  /** Drive the REAL bridge's agent.dispatch under a chosen gate value; return its output. */
  async function dispatchUnderGate(gateOn: boolean): Promise<{ output: Record<string, unknown>; markerExists: boolean }> {
    const home = tmp("plexus-bridge-home-");
    const work = tmp("plexus-bridge-marker-");
    const markerPath = join(work, "marker.txt");
    const plugin = makeSyntheticPlugin(markerPath);
    const fakeClaude = makeFakeClaude();

    const prevHome = process.env.PLEXUS_HOME;
    const prevGate = process.env.PLEXUS_CC_HEADLESS_LAUNCH;
    process.env.PLEXUS_HOME = home;
    if (gateOn) process.env.PLEXUS_CC_HEADLESS_LAUNCH = "1";
    else delete process.env.PLEXUS_CC_HEADLESS_LAUNCH;

    try {
      const entries = ccMasterEntries(true);
      const { deps } = stubDeps(entries);
      // Inject a launcher wired to the fake `claude` + synthetic plugin (no real claude).
      const launcher = new ClaudeLauncher({
        resolveBinary: async (n) => (n === "claude" ? fakeClaude : undefined),
        embeddedPluginDir: plugin,
        capture: defaultCapture,
      });
      const bridge = new CcMasterBridge(deps, ctx.sessionId, entries, launcher);

      const res = await bridge.invoke(
        { id: AGENT_DISPATCH_ID, input: { goal: "smoke goal", node: "smoke-node" } },
        ctx,
      );
      const output = (res.output ?? {}) as Record<string, unknown>;
      return { output, markerExists: existsSync(markerPath) };
    } finally {
      if (prevHome === undefined) delete process.env.PLEXUS_HOME;
      else process.env.PLEXUS_HOME = prevHome;
      if (prevGate === undefined) delete process.env.PLEXUS_CC_HEADLESS_LAUNCH;
      else process.env.PLEXUS_CC_HEADLESS_LAUNCH = prevGate;
    }
  }

  it("gate ON ⇒ bridge REALLY spawns ⇒ plugin loads (marker) ⇒ launched:true", async () => {
    const { output, markerExists } = await dispatchUnderGate(true);
    // THE PROOF: the gate=ON path drove a real spawn that loaded the plugin (marker written).
    expect(markerExists).toBe(true);
    expect(output.launched).toBe(true);
    expect(output.agentExecution).toBe("launched");
    expect(output.launchMode).toBe("managed-headless");
    // The board half is still real (a board id was recorded).
    expect(typeof output.boardId).toBe("string");
  });

  it("gate OFF ⇒ bridge records only ⇒ NO spawn (no marker) ⇒ launched:false (record-mode guardrail)", async () => {
    const { output, markerExists } = await dispatchUnderGate(false);
    // The guardrail: with the gate off, NO spawn happens ⇒ the marker is never written.
    expect(markerExists).toBe(false);
    expect(output.launched).toBe(false);
    expect(output.agentExecution).toBe("recorded");
    // Record-mode still honestly reports the argv it WOULD have run (the wiring proof).
    expect(Array.isArray(output.argv)).toBe(true);
    expect(output.argv as string[]).toContain("--plugin-dir");
  });
});
