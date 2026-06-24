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

describe("launcher: REAL spawn of a SYNTHETIC fixture plugin (marker-file proof)", () => {
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
