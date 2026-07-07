/**
 * Connector catalog — GET /admin/api/connectors.
 *
 * Asserts the "What Plexus can connect to" catalog endpoint returns:
 *   1. The obsidian-rest descriptor with its dynamic-form fields (label/baseUrl/apiKey,
 *      apiKey being a write-only `target:"secret"` password field), wireable + managed.
 *   2. The obsidian-fs descriptor (wireable + managed, no secret field).
 *   3. A first-party claudecode descriptor (wireable:false, fields:[], first-party class).
 *
 * Throwaway PLEXUS_HOME — never touches the real ~/.plexus.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import type { ConnectorDescriptor } from "@plexus/runtime/sources/config/connector-descriptor.ts";

const config = loadConfig();
const HOST = expectedHost(config);
const dirs: string[] = [];
let activeKey = "";

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-connectors-"));
  dirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const built = createAppWithState(config);
  activeKey = built.state.connectionKey.current();
  return { ...built, dir };
}

function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "X-Plexus-Connection-Key": activeKey, ...(init?.headers ?? {}) },
  });
}

afterAll(() => {
  delete process.env.PLEXUS_HOME;
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("connectors: GET /admin/api/connectors returns the catalog", () => {
  it("includes obsidian-rest + obsidian-fs descriptors with their fields", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/connectors");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connectors: ConnectorDescriptor[]; revision: number };
    expect(Array.isArray(body.connectors)).toBe(true);
    expect(typeof body.revision).toBe("number");

    const rest = body.connectors.find((c) => c.kind === "obsidian-rest");
    expect(rest).toBeDefined();
    expect(rest!.wireable).toBe(true);
    expect(rest!.provenanceClass).toBe("managed");
    expect(rest!.transport).toBe("local-rest");
    expect(rest!.detectable).toBe(true);
    // Fields drive the dynamic form: label (→label), baseUrl (→route), apiKey (→secret).
    const fieldNames = rest!.fields.map((f) => f.name);
    expect(fieldNames).toEqual(["label", "baseUrl", "apiKey"]);
    const apiKey = rest!.fields.find((f) => f.name === "apiKey")!;
    expect(apiKey.type).toBe("password");
    expect(apiKey.required).toBe(true);
    expect(apiKey.target).toBe("secret");
    const baseUrl = rest!.fields.find((f) => f.name === "baseUrl")!;
    expect(baseUrl.target).toBe("route");
    expect(baseUrl.default).toBeTruthy();

    const fs = body.connectors.find((c) => c.kind === "obsidian-fs");
    expect(fs).toBeDefined();
    expect(fs!.wireable).toBe(true);
    expect(fs!.provenanceClass).toBe("managed");
    expect(fs!.fields.map((f) => f.name)).toEqual(["label", "vaultPath"]);
    // Read-only fs source carries no secret field.
    expect(fs!.fields.some((f) => f.target === "secret")).toBe(false);
  });

  it("includes a first-party claudecode descriptor (informational, not wireable)", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/connectors");
    const body = (await res.json()) as { connectors: ConnectorDescriptor[]; revision: number };
    const cc = body.connectors.find((c) => c.kind === "claudecode");
    expect(cc).toBeDefined();
    expect(cc!.provenanceClass).toBe("first-party");
    // First-party builtins self-register in-process: nothing to wire, no fields.
    expect(cc!.wireable).toBe(false);
    expect(cc!.fields).toEqual([]);
  });
});
