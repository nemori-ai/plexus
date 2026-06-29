/**
 * Fix #5 — the handshake/`GET /manifest` `gateway.baseUrl` must reflect the ACTUAL
 * bound port under an ephemeral `port:0` bind, matching `.well-known`.
 *
 * `buildManifest` called `gatewayInfo(state.config)` WITHOUT the bound port, so with
 * `port:0` (config.port === 0) it advertised port `0` while `.well-known` (which
 * threads `state.boundPort`) advertised the real port. This test simulates a
 * `port:0` bind (config.port differs from the bound port) and asserts the manifest
 * gateway baseUrl now reflects the bound port AND matches `buildWellKnown`.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Session } from "@plexus/runtime/core/sessions.ts";
import { buildManifest } from "@plexus/runtime/core/manifest.ts";
import { buildWellKnown } from "@plexus/runtime/core/well-known.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { setBoundPort } from "@plexus/runtime/core/state.ts";
import { loadConfig } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";

const tmpDirs: string[] = [];

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

function fakeSession(): Session {
  const now = Date.now();
  return {
    id: "sess-bound-port",
    bootstrapKey: "plx_live_test",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    invalidated: false,
    issuedJtis: new Set<string>(),
  };
}

describe("fix #5 — manifest advertises the bound port under ephemeral bind", () => {
  it("buildManifest reflects state.boundPort and matches buildWellKnown", () => {
    const dir = mkdtempSync(join(tmpdir(), "plexus-manifest-port-"));
    tmpDirs.push(dir);
    process.env.PLEXUS_HOME = dir;
    _resetSecretCacheForTests();

    // Simulate `port:0`: the configured port is the requested/ephemeral 0, the
    // listener actually bound a real port post-listen.
    const config = { ...loadConfig(), port: 0 };
    const BOUND = 54321;
    const { state } = createAppWithState(config);
    setBoundPort(state, BOUND);

    const manifest = buildManifest(state, fakeSession());
    const wellKnown = buildWellKnown(config, state.capabilities.summaries(), state.boundPort);

    // The manifest's baseUrl now carries the REAL bound port (not the stale 0)...
    expect(manifest.gateway.baseUrl).toContain(`:${BOUND}`);
    expect(manifest.gateway.baseUrl).not.toContain(":0");
    // ...and it agrees with what `.well-known` advertises.
    expect(manifest.gateway.baseUrl).toBe(wellKnown.gateway.baseUrl);
  });
});
