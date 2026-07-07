/**
 * P3-5 — Linux exec-source confinement (the `SandboxBackend` seam + the availability gate).
 *
 * The exec sources (`codex`/`claudecode`) are jailed by a KERNEL sandbox: macOS
 * `sandbox-exec`, or Linux `bwrap`. P3-1 gates them OUT on Linux because `sandbox-exec`
 * has no Linux equivalent. P3-5 lifts that gate ONLY when a real `bwrap` jail is
 * available (anti-"advertised but unjailed"). This suite proves, all HERMETICALLY (the
 * Linux code paths can never EXECUTE on this macOS box; `bwrap` is NOT installed — every
 * probe is MOCKED, mirroring `p3-platform-gate-modules.test.ts`):
 *
 *  (a) linux + bwrap AVAILABLE (mocked) ⇒ the active registry INCLUDES codex/claudecode;
 *  (b) linux + bwrap ABSENT (mocked)    ⇒ they stay OUT; the active set is exactly
 *      {workspace, sysinfo} and a `.well-known`-shaped scan advertises ZERO exec caps;
 *  (c) `LinuxSandboxBackend.wrap()` builds the EXPECTED bwrap argv for a sample command
 *      (pure arg construction — NO real bwrap binary required);
 *  (d) darwin registry + the sandbox-exec path are UNCHANGED (all 7 sources; the darwin
 *      backend reproduces the exact seatbelt argv).
 */

import { describe, it, expect } from "bun:test";
import type { PlatformServices } from "@plexus/protocol";

import { createSourceRegistry } from "@plexus/runtime/core/registry.ts";
import {
  DarwinSandboxBackend,
  LinuxSandboxBackend,
  selectSandboxBackend,
  type SandboxBackend,
  type SandboxSpec,
} from "@plexus/runtime/platform/sandbox-backend.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

/** A fake PlatformServices pinned to the given OS — no real OS access. */
function fakePlatform(platform: PlatformServices["platform"]): PlatformServices {
  return {
    platform,
    async resolveBinary() {
      return undefined;
    },
    async getEnrichedPath() {
      return "/usr/bin";
    },
    async locateLocalService() {
      return undefined;
    },
    spawnProcess() {
      throw new Error("not used in registry-build test");
    },
    async resolveSecret() {
      return undefined;
    },
  };
}

/** A SandboxBackend whose availability is forced — NO real `bwrap`/`sandbox-exec` needed. */
function fakeSandbox(available: boolean): SandboxBackend {
  return {
    mechanism: "bwrap",
    isAvailableSync: () => available,
    wrap: () => ({ command: "bwrap", args: [] }),
  };
}

const ALL_FIRST_PARTY = [
  "apple-calendar",
  "apple-reminders",
  "things",
  "workspace",
  "claudecode",
  "codex",
  "sysinfo",
] as const;
const EXEC_IDS = ["codex", "claudecode"] as const;
// The portable (Linux-active) first-party ids that are ALWAYS active on linux (exec-gate
// aside). `sysinfo` joined them (portable `ps`/`df`/`os` + pure-code path-jail).
const LINUX_PORTABLE = ["workspace", "sysinfo"] as const;

// ══════════════════════════════════════════════════════════════════════════════
// (a) linux + bwrap AVAILABLE ⇒ exec sources re-join the active registry
// ══════════════════════════════════════════════════════════════════════════════
describe("P3-5 registry gate — linux WITH a working bwrap jail", () => {
  it("ACTIVE set on linux INCLUDES codex + claudecode when bwrap is available", () => {
    const reg = createSourceRegistry(fakePlatform("linux"), { sandbox: fakeSandbox(true) });
    const active = new Set(reg.all().map((m) => m.id));
    expect([...active].sort()).toEqual(
      [...LINUX_PORTABLE, "codex", "claudecode"].sort(),
    );
    for (const id of EXEC_IDS) expect(reg.get(id)).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (b) linux + bwrap ABSENT ⇒ exec sources stay OUT, zero exec caps advertised
// ══════════════════════════════════════════════════════════════════════════════
describe("P3-5 registry gate — linux WITHOUT bwrap (anti-advertised-but-unjailed)", () => {
  it("ACTIVE set on linux is exactly the portable set when bwrap is absent", () => {
    const reg = createSourceRegistry(fakePlatform("linux"), { sandbox: fakeSandbox(false) });
    const active = new Set(reg.all().map((m) => m.id));
    expect([...active].sort()).toEqual([...LINUX_PORTABLE].sort());
    for (const id of EXEC_IDS) expect(reg.get(id)).toBeUndefined();
  });

  it("a `.well-known`-shaped scan over the active set advertises ZERO exec caps", async () => {
    const reg = createSourceRegistry(fakePlatform("linux"), { sandbox: fakeSandbox(false) });
    // Mirror what discovery does: scan every active source, collect the advertised ids.
    const advertised: string[] = [];
    for (const m of reg.all()) {
      const src = m.createSource(fakePlatform("linux"));
      for (const e of await src.scan()) advertised.push(e.id);
    }
    expect(advertised.length).toBeGreaterThan(0); // workspace/sysinfo DO advertise
    for (const id of advertised) {
      expect(id.startsWith("codex.")).toBe(false);
      expect(id.startsWith("claudecode.")).toBe(false);
    }
  });

  it("DEFAULT linux probe (no injected sandbox) gates exec OUT here (bwrap not installed)", () => {
    // On this macOS dev box `bwrap` is absent ⇒ the real LinuxSandboxBackend probe ⇒ OUT.
    const reg = createSourceRegistry(fakePlatform("linux"));
    const active = new Set(reg.all().map((m) => m.id));
    expect([...active].sort()).toEqual([...LINUX_PORTABLE].sort());
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (c) LinuxSandboxBackend.wrap — the bwrap argv is built correctly (NO real bwrap)
// ══════════════════════════════════════════════════════════════════════════════
describe("LinuxSandboxBackend.wrap — bwrap jail argv construction (pure)", () => {
  function sampleSpec(): SandboxSpec {
    return {
      innerCommand: "/abs/codex",
      innerArgs: ["exec", "--dangerously-bypass-approvals-and-sandbox", "do work"],
      jail: "/home/u/PlexusDemo/pomodoro",
      homedir: "/home/u",
      tmpdir: "/home/u/PlexusDemo/pomodoro/.tmp",
      network: true,
      profilePath: "/ignored/on/linux.sb",
      params: [{ name: "CODEX_BIN_DIR", path: "/opt/codex/bin" }],
      configDirs: ["/home/u/.codex"],
    };
  }

  it("builds the expected bwrap flags: ns isolation, ro-root binds, ONE rw jail, no-net-leak", () => {
    // bwrapPath injected so the test is independent of a real binary on PATH.
    const backend = new LinuxSandboxBackend({ bwrapPath: "/usr/bin/bwrap", probe: () => "/usr/bin/bwrap" });
    const { command, args } = backend.wrap(sampleSpec());

    expect(command).toBe("/usr/bin/bwrap");
    expect(backend.mechanism).toBe("bwrap");

    // Namespace isolation + lifecycle.
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--unshare-all");
    expect(args).toContain("--new-session");
    // network:true ⇒ re-share net (consistent with the seatbelt `allow network*`).
    expect(args).toContain("--share-net");
    // A fresh proc + minimal dev + a PRIVATE empty /tmp (no host temp leaks in).
    expect(args).toContain("--proc");
    expect(args).toContain("--dev");
    expect(args).toContain("--tmpfs");

    // read-only OS dir (the bwrap dual of `(allow file-read* (subpath "/usr"))`).
    const roUsr = args.findIndex((a, i) => a === "--ro-bind-try" && args[i + 1] === "/usr" && args[i + 2] === "/usr");
    expect(roUsr).toBeGreaterThanOrEqual(0);

    // THE jail — the ONLY broad read-write bind (hard --bind, src==dest).
    const jailIdx = args.findIndex(
      (a, i) => a === "--bind" && args[i + 1] === "/home/u/PlexusDemo/pomodoro" && args[i + 2] === "/home/u/PlexusDemo/pomodoro",
    );
    expect(jailIdx).toBeGreaterThanOrEqual(0);
    // The jail is bound with --bind (rw), NEVER --ro-bind.
    expect(args).not.toContain("--ro-bind");

    // config dir rw (tolerant of absence).
    const cfgIdx = args.findIndex(
      (a, i) => a === "--bind-try" && args[i + 1] === "/home/u/.codex" && args[i + 2] === "/home/u/.codex",
    );
    expect(cfgIdx).toBeGreaterThanOrEqual(0);

    // tool bin dir is read-only.
    const binIdx = args.findIndex(
      (a, i) => a === "--ro-bind-try" && args[i + 1] === "/opt/codex/bin" && args[i + 2] === "/opt/codex/bin",
    );
    expect(binIdx).toBeGreaterThanOrEqual(0);

    // TMPDIR pinned INSIDE the jail + chdir into the jail.
    const tmpIdx = args.findIndex((a, i) => a === "--setenv" && args[i + 1] === "TMPDIR");
    expect(tmpIdx).toBeGreaterThanOrEqual(0);
    expect(args[tmpIdx + 2]).toBe("/home/u/PlexusDemo/pomodoro/.tmp");
    const chdirIdx = args.indexOf("--chdir");
    expect(args[chdirIdx + 1]).toBe("/home/u/PlexusDemo/pomodoro");

    // The inner command sits AFTER the `--` separator, verbatim.
    const sep = args.indexOf("--");
    expect(sep).toBeGreaterThanOrEqual(0);
    expect(args.slice(sep + 1)).toEqual([
      "/abs/codex",
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "do work",
    ]);
  });

  it("network:false OMITS --share-net (the jail stays network-isolated)", () => {
    const backend = new LinuxSandboxBackend({ bwrapPath: "/usr/bin/bwrap", probe: () => "/usr/bin/bwrap" });
    const { args } = backend.wrap({ ...sampleSpec(), network: false });
    expect(args).toContain("--unshare-all");
    expect(args).not.toContain("--share-net");
  });

  it("isAvailableSync reflects the injected probe (absent ⇒ false, present ⇒ true)", () => {
    expect(new LinuxSandboxBackend({ probe: () => undefined }).isAvailableSync()).toBe(false);
    expect(new LinuxSandboxBackend({ probe: () => "/usr/bin/bwrap" }).isAvailableSync()).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (d) darwin UNCHANGED — all sources active; the seatbelt argv is byte-identical
// ══════════════════════════════════════════════════════════════════════════════
describe("P3-5 — darwin registry + sandbox-exec path UNCHANGED", () => {
  it("darwin active registry keeps ALL 7 first-party sources (probe never consulted)", () => {
    // Even an UNAVAILABLE sandbox backend must not gate darwin (the probe is linux-only).
    const reg = createSourceRegistry(fakePlatform("darwin"), { sandbox: fakeSandbox(false) });
    const active = new Set(reg.all().map((m) => m.id));
    for (const id of ALL_FIRST_PARTY) expect(active.has(id)).toBe(true);
    expect(active.size).toBe(ALL_FIRST_PARTY.length);
  });

  it("selectSandboxBackend maps darwin→sandbox-exec, linux→bwrap", () => {
    expect(selectSandboxBackend("darwin").mechanism).toBe("sandbox-exec");
    expect(selectSandboxBackend("win32").mechanism).toBe("sandbox-exec");
    expect(selectSandboxBackend("linux").mechanism).toBe("bwrap");
  });

  it("DarwinSandboxBackend.wrap reproduces the EXACT seatbelt argv (JAIL,HOMEDIR,params order)", () => {
    const backend = new DarwinSandboxBackend({ sandboxExec: "/usr/bin/sandbox-exec" });
    const { command, args } = backend.wrap({
      innerCommand: "/abs/claude",
      innerArgs: ["-p", "x"],
      jail: "/j",
      homedir: "/h",
      tmpdir: "/j/.tmp",
      network: true,
      profilePath: "/p/cc-confine.sb",
      params: [
        { name: "CLAUDE_BIN_DIR", path: "/b" },
        { name: "PLUGIN_DIR", path: "/j" },
      ],
    });
    expect(command).toBe("/usr/bin/sandbox-exec");
    expect(args).toEqual([
      "-f",
      "/p/cc-confine.sb",
      "-D",
      "JAIL=/j",
      "-D",
      "HOMEDIR=/h",
      "-D",
      "CLAUDE_BIN_DIR=/b",
      "-D",
      "PLUGIN_DIR=/j",
      "/abs/claude",
      "-p",
      "x",
    ]);
  });

  it("DarwinSandboxBackend availability = existsSync(sandbox-exec) (injected exists probe)", () => {
    expect(new DarwinSandboxBackend({ exists: () => true }).isAvailableSync()).toBe(true);
    expect(new DarwinSandboxBackend({ exists: () => false }).isAvailableSync()).toBe(false);
  });
});
