import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilitySource, InvokeContext, PlatformServices, SourceHealth, SourceModule, SourceRegistry } from "@plexus/protocol";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { expectedHost, loadConfig } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { bootScanCapabilities } from "@plexus/runtime/core/state.ts";
import { createSourceHealthCache } from "@plexus/runtime/core/source-health.ts";
import { InvokePipeline } from "@plexus/runtime/core/pipeline.ts";
import { appleAvailabilityHealth, inspectAppleApp } from "@plexus/runtime/sources/apple-availability.ts";
import { AppleCalendarSource } from "@plexus/runtime/sources/apple-calendar/manifest.ts";
import { RealCalendarProvider } from "@plexus/runtime/sources/apple-calendar/provider-real.ts";
import { AppleContactsSource } from "@plexus/runtime/sources/apple-contacts/manifest.ts";
import { RealContactsProvider } from "@plexus/runtime/sources/apple-contacts/provider.ts";
import { AppleMailSource } from "@plexus/runtime/sources/apple-mail/manifest.ts";
import { RealMailProvider } from "@plexus/runtime/sources/apple-mail/provider.ts";
import { AppleNotesSource } from "@plexus/runtime/sources/apple-notes/manifest.ts";
import { RealNotesProvider } from "@plexus/runtime/sources/apple-notes/provider.ts";
import { AppleNotesBridge } from "@plexus/runtime/sources/apple-notes/bridge.ts";
import { appleNotesEntries, NOTES_FOLDERS_LIST_ID } from "@plexus/runtime/sources/apple-notes/entries.ts";
import { ApplePhotosSource } from "@plexus/runtime/sources/apple-photos/manifest.ts";
import { RealPhotosProvider } from "@plexus/runtime/sources/apple-photos/provider.ts";
import { AppleRemindersSource } from "@plexus/runtime/sources/apple-reminders/manifest.ts";
import { RealRemindersProvider } from "@plexus/runtime/sources/apple-reminders/provider.ts";
import { ShortcutsSource } from "@plexus/runtime/sources/shortcuts/manifest.ts";
import { RealShortcutsProvider } from "@plexus/runtime/sources/shortcuts/provider.ts";

const platform = {} as PlatformServices; // These constructors do not use platform services.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
let dir: string;
let priorHome: string | undefined;
const apps: ReturnType<typeof createAppWithState>[] = [];

beforeEach(() => {
  priorHome = process.env.PLEXUS_HOME;
  dir = mkdtempSync(join(tmpdir(), "plexus-passive-health-"));
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
});

afterEach(async () => {
  for (const { state } of apps.splice(0)) {
    await state.capabilities.stop();
    state.mesh.stop();
  }
  rmSync(dir, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.PLEXUS_HOME;
  else process.env.PLEXUS_HOME = priorHome;
  _resetSecretCacheForTests();
});

function freshApp(modules: SourceModule[]) {
  const sources: SourceRegistry = {
    all: () => modules,
    get: (id) => modules.find((module) => module.id === id),
    getTransport: (kind) => ({ kind, dispatch: async () => { throw new Error("Unexpected transport execution"); } }),
  };
  const built = createAppWithState(loadConfig(), { sources });
  apps.push(built);
  return built;
}

function healthSource(health: () => Promise<SourceHealth>): CapabilitySource {
  return {
    id: "notes", label: "Test source", transport: "ipc", health,
    checkRequirements: async () => ({ ok: true }),
    scan: async () => [],
    start: async () => {},
    stop: async () => {},
  };
}

/** Real provider implementations, with every command runner explicitly intercepted. */
function nativeSources() {
  const deny = { stdout: "", stderr: "Not authorized to send Apple events (-1743)", exitCode: 1, code: 1, timedOut: false };
  const runScript = mock(async (_script: string) => deny);
  const runCommand = mock(async (_command: string, _args: string[]) => deny);
  const runShortcut = mock(async () => deny);
  const notes = new RealNotesProvider(runScript);
  const reminders = new RealRemindersProvider(runScript);
  const photos = new RealPhotosProvider(runCommand);
  const mail = new RealMailProvider({ run: runScript });
  const contacts = new RealContactsProvider({ run: runScript });
  const calendar = new RealCalendarProvider(runCommand);
  const shortcuts = new RealShortcutsProvider(runShortcut);
  const providers = [notes, reminders, photos, mail, contacts, calendar, shortcuts];
  const probes = providers.map((provider) => {
    const probe = mock(provider.available.bind(provider));
    provider.available = probe;
    return probe;
  });
  const sources: CapabilitySource[] = [
    new AppleNotesSource(platform, { provider: notes }),
    new AppleRemindersSource(platform, { provider: reminders }),
    new ApplePhotosSource({ provider: photos }),
    new AppleMailSource({ provider: mail }),
    new AppleContactsSource({ provider: contacts }),
    new AppleCalendarSource({ provider: calendar }),
    new ShortcutsSource(platform, { provider: shortcuts }),
  ];
  const modules: SourceModule[] = sources.map((source) => ({
    id: source.id, label: source.label, transport: source.transport,
    createSource: () => source,
    createBridge: () => { throw new Error("Background work must not invoke a bridge"); },
  }));
  return { sources, modules, probes, commands: [runScript, runCommand, runShortcut] };
}

describe("Apple installation checks", () => {
  it("reports installed apps as unknown without checking permission", () => {
    const exists = mock((path: string) => path === "/System/Applications/Notes.app");
    const result = inspectAppleApp("Notes", { platform: "darwin", exists });
    expect(result).toMatchObject({ ok: true, accessChecked: false });
    expect(appleAvailabilityHealth(result).status).toBe("unknown");
    expect(exists.mock.calls).toEqual([["/System/Applications/Notes.app"]]);
  });

  it("supports the legacy Applications directory and checks the Shortcuts binary only", () => {
    expect(inspectAppleApp("Mail", { platform: "darwin", exists: (p) => p === "/Applications/Mail.app" }).ok).toBe(true);
    const exists = mock((p: string) => p === "/usr/bin/shortcuts");
    expect(inspectAppleApp("Shortcuts", { platform: "darwin", exists }).accessChecked).toBe(false);
    expect(exists.mock.calls).toEqual([["/usr/bin/shortcuts"]]);
  });

  it("reports missing apps and unsupported platforms without attempting OS access", () => {
    const exists = mock(() => false);
    expect(appleAvailabilityHealth(inspectAppleApp("Photos", { platform: "darwin", exists })).status).toBe("unavailable");
    exists.mockClear();
    expect(inspectAppleApp("Calendar", { platform: "linux", exists }).reason).toContain("macOS");
    expect(exists).not.toHaveBeenCalled();
  });
});

describe("Apple lifecycle never launches apps or asks for permission", () => {
  it("checks requirements and health without running any AppleScript, EventKit or shortcuts command", async () => {
    const { sources, commands } = nativeSources();
    for (const source of sources) {
      await source.start();
      await source.scan();
      const requirements = await source.checkRequirements();
      expect((await source.health!()).status).toBe(requirements.ok ? "unknown" : "unavailable");
      await source.stop();
    }
    for (const command of commands) expect(command).not.toHaveBeenCalled();
  });

  for (const enabled of [true, false]) {
    it(`keeps boot, discovery and admin health passive with capabilities ${enabled ? "enabled" : "disabled"} and no grants`, async () => {
      const { modules, sources, probes, commands } = nativeSources();
      const { app, state } = freshApp(modules);
      if (!enabled) {
        for (const source of sources) {
          for (const entry of await source.scan()) {
            if (entry.kind !== "skill") state.exposure.setEnabled(entry.id, false);
          }
        }
      }
      await bootScanCapabilities(state);
      state.capabilities.summaries();
      state.capabilities.projectedEntries();
      state.capabilities.healthReport();
      const response = await app.request(`http://${expectedHost(state.config)}/admin/api/health`, {
        headers: { host: expectedHost(state.config), "X-Plexus-Connection-Key": state.connectionKey.current() },
      });
      expect(response.status).toBe(200);
      await flush();
      for (const command of commands) expect(command).not.toHaveBeenCalled();
      for (const probe of probes) {
        if (enabled) expect(probe).toHaveBeenCalled();
        else expect(probe).not.toHaveBeenCalled();
      }
    });
  }

  it("skips disabled sources even on forced refresh and TTL expiry, then resumes passive checks on enable", async () => {
    let now = 0;
    let enabled = true;
    const probe = mock(async () => ({ status: "ok" as const }));
    const resolve = mock(() => healthSource(probe));
    const cache = createSourceHealthCache(resolve, { now: () => now, shouldProbe: () => enabled });
    await cache.refresh("notes");
    enabled = false;
    now += 10_001;
    expect(cache.cached("notes").status).toBe("unknown");
    await cache.refresh("notes");
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    enabled = true;
    cache.cached("notes");
    await flush();
    expect(probe).toHaveBeenCalledTimes(2);
    now += 10_001;
    cache.cached("notes");
    await flush();
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("discards an in-flight health result if the owner disables the source", async () => {
    let enabled = true;
    let finish!: (value: { status: "ok" }) => void;
    const cache = createSourceHealthCache(() => healthSource(
      () => new Promise((resolve) => { finish = resolve; }),
    ), { shouldProbe: () => enabled });
    const pending = cache.refresh("notes");
    enabled = false;
    finish({ status: "ok" });
    expect((await pending).status).toBe("unknown");
    expect(cache.cached("notes").status).toBe("unknown");
  });

  it("allows an authorized invocation with unknown health, but disabled or ungranted calls never run a script", async () => {
    const run = mock(async () => ({ exitCode: 0, stderr: "", stdout: '{"folders":[]}' }));
    const provider = new RealNotesProvider(run);
    // Model an installed Mac app deterministically, including on Linux CI.
    provider.available = async () => inspectAppleApp("Notes", { platform: "darwin", exists: () => true });
    const source = new AppleNotesSource(platform, { provider });
    const { state } = freshApp([{
      id: source.id, label: source.label, transport: source.transport,
      createSource: () => source,
      createBridge: (deps, sessionId) => new AppleNotesBridge(deps, sessionId, appleNotesEntries(), provider),
    }]);
    await bootScanCapabilities(state);
    expect((await state.capabilities.refreshHealth(source.id)).status).toBe("unknown");
    const session = state.sessions.open(state.connectionKey.current());
    const ctx: InvokeContext = { jti: "passive-health-test", sessionId: session.id, scopes: [] };
    const request = { id: NOTES_FOLDERS_LIST_ID, input: {} };
    const pipeline = new InvokePipeline(state);
    await expect(pipeline.invokeById(request, ctx)).rejects.toMatchObject({ body: { code: "grant_required" } });
    ctx.scopes = [{ id: NOTES_FOLDERS_LIST_ID, verbs: ["read"] }];
    state.exposure.setEnabled(NOTES_FOLDERS_LIST_ID, false);
    await expect(pipeline.invokeById(request, ctx)).rejects.toMatchObject({ body: { code: "capability_unexposed" } });
    expect(run).not.toHaveBeenCalled();
    state.exposure.setEnabled(NOTES_FOLDERS_LIST_ID, true);
    expect((await pipeline.invokeById(request, ctx)).ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    await pipeline.disposeSession(session.id);
  });
});
