/**
 * gateway.ts — a REAL, standalone Plexus gateway OS process for the two-process
 * federated-mesh demo. ONE binary, two roles (selected by `PLEXUS_MODE`):
 *
 *   PLEXUS_MODE unset / "primary"
 *     Boots a PRIMARY through the SAME supervised seam the headless gateway uses
 *     (`runtime/serve.ts` → `startRuntime`, exactly like `src/index.ts` and
 *     `bin/plexus`). It binds the agent-facing HTTP surface on `PLEXUS_PORT`, opens
 *     the second routable mesh listener (the tunnel acceptor, ephemeral port), and
 *     keeps the DEFAULT human-in-the-loop authorizer — so a grant for a remote
 *     (extension-class) mesh capability still requires a deliberate human consent
 *     act (the demo performs it via the real `PUT /admin/api/grants` surface).
 *
 *   PLEXUS_MODE=proxy
 *     Boots a PROXY: it exposes the in-repo `mock` source (so it has a real
 *     `mock.echo.run` to forward), reads its one-time join token from
 *     `PLEXUS_JOIN_TOKEN`, dials `PLEXUS_UPSTREAM_URL`, mutually Ed25519-authenticates
 *     against the pinned `PLEXUS_UPSTREAM_PUBKEY`, enrolls as `PLEXUS_WORKLOAD`, and
 *     LIVE-ASCENDS its catalog so the primary auto-mounts it (no in-process mount).
 *     Each process persists its OWN Ed25519 identity + connection-key under its OWN
 *     `PLEXUS_HOME`, so the two gateways are genuinely independent OS processes.
 *
 * This file lives in `examples/` and only COMPOSES the public construction helpers
 * (`loadConfig`, `startRuntime`, `createAppWithState`, the source/transport builders)
 * — exactly as `bin/plexus` composes them for `--vault`. It changes no gateway logic.
 *
 * Honesty note: the standard `bin/plexus` launcher does not yet read a
 * `PLEXUS_JOIN_TOKEN` env var (the join token is injected through the
 * `createAppWithState({ mesh })` seam, which the in-process tests + this launcher use).
 * Wiring that env into core `bin/plexus` is a one-line follow-up outside this demo's
 * scope; here the proxy launcher reads it, which is the realistic operator flow.
 *
 * RUN (orchestrated by run-mesh-demo.sh; not meant to be run by hand):
 *   PLEXUS_HOME=… PLEXUS_PORT=… bun run examples/mesh-demo/gateway.ts            # primary
 *   PLEXUS_HOME=… PLEXUS_PORT=… PLEXUS_MODE=proxy PLEXUS_UPSTREAM_URL=… \
 *     PLEXUS_UPSTREAM_PUBKEY=… PLEXUS_WORKLOAD=… PLEXUS_JOIN_TOKEN=… \
 *     bun run examples/mesh-demo/gateway.ts                                       # proxy
 */

import type { SourceModule, SourceRegistry, TransportKind, Transport } from "@plexus/protocol";
import type { TLSOptions } from "bun";

import { readFileSync } from "node:fs";

import { loadConfig, baseUrl, type GatewayConfig } from "@plexus/runtime/config.ts";
import { startRuntime, installSignalHandlers } from "@plexus/runtime/runtime/serve.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { setBoundPort } from "@plexus/runtime/core/state.ts";
import { getPlatformServices } from "@plexus/runtime/platform/index.ts";
import { buildTransports } from "@plexus/runtime/transports/index.ts";
import {
  mockSourceModule,
  workspaceSourceModule,
  appleCalendarSourceModule,
} from "@plexus/runtime/sources/index.ts";

/**
 * The source modules a demo gateway can expose, keyed by the short name the launcher
 * scripts pass via `PLEXUS_DEMO_PRIMARY_SOURCES` (the MAC PRIMARY's OWN caps) or
 * `PLEXUS_DEMO_PROXY_SOURCE` (a proxy's exposed surface). Each is a real in-repo
 * first-party/example `SourceModule`; the multi-host demo picks a DIFFERENT set per
 * process so the aggregated catalog carries genuinely distinct provenance.
 */
const DEMO_MODULES: Record<string, SourceModule> = {
  mock: mockSourceModule,
  workspace: workspaceSourceModule,
  "apple-calendar": appleCalendarSourceModule,
};

/** Resolve a comma-list of demo-source names to their `SourceModule`s (fail-fast on a typo). */
function modulesFor(names: string): SourceModule[] {
  const ids = names
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids.map((id) => {
    const mod = DEMO_MODULES[id];
    if (!mod) {
      throw new Error(
        `[gateway] unknown demo source "${id}" — known: ${Object.keys(DEMO_MODULES).join(", ")}`,
      );
    }
    return mod;
  });
}

/**
 * PROXY wss CA-trust (B7): when the proxy dials a `wss://` upstream whose primary serves a
 * SELF-SIGNED cert, the proxy must trust that CA. The launcher points `PLEXUS_MESH_UPSTREAM_TLS_CA`
 * at the primary's cert PEM; we read it and hand it to the mesh runtime as a PER-CONNECTION
 * `tls.ca` (never a global `NODE_TLS_REJECT_UNAUTHORIZED`). Absent ⇒ no override (a plain `ws://`
 * upstream needs none; a `wss://` one then verifies against the host trust store).
 */
function loadUpstreamTls(): TLSOptions | undefined {
  const caPath = process.env.PLEXUS_MESH_UPSTREAM_TLS_CA?.trim();
  if (!caPath) return undefined;
  return { ca: readFileSync(caPath, "utf8") };
}

/** A SourceRegistry over an explicit module list (production MODULES is empty). */
function registryOf(modules: SourceModule[]): SourceRegistry {
  const platform = getPlatformServices();
  const transports = buildTransports(platform);
  const byId = new Map(modules.map((m) => [m.id, m]));
  return {
    all: () => [...byId.values()],
    get: (id) => byId.get(id),
    getTransport: (kind: TransportKind): Transport => transports[kind],
  };
}

/**
 * The machine-readable readiness marker the orchestrator greps for (mirrors the
 * supervised `PLEXUS_READY` line, but carries the mesh coordinates the demo needs).
 */
function emitReady(role: string, fields: Record<string, unknown>): void {
  const kv = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  // eslint-disable-next-line no-console
  console.log(`MESH_DEMO_READY role=${role} ${kv}`);
}

async function bootPrimary(config: GatewayConfig): Promise<void> {
  // THE SUPERVISED SEAM — identical lifecycle to `src/index.ts` / `bin/plexus`:
  // build app+state, bind the loopback agent socket, START THE MESH TUNNEL (the
  // second routable listener), emit the ready line, write runtime.json. We disable
  // the first-run boot scan so the primary's directory is deterministic — it should
  // contain ONLY what the proxy mounts over the tunnel, nothing host-incidental.
  const runtime = await startRuntime(config, { bootScan: false });
  const url = baseUrl({ ...config, port: runtime.info.port });
  // eslint-disable-next-line no-console
  console.log(`[primary] agent surface: ${url}`);
  // eslint-disable-next-line no-console
  console.log(`[primary] mesh tunnel listener port: ${runtime.state.mesh.tunnelPort}`);
  emitReady("primary", {
    agentPort: runtime.info.port,
    tunnelPort: runtime.state.mesh.tunnelPort,
    pid: process.pid,
  });
  installSignalHandlers(runtime);
}

async function bootProxy(config: GatewayConfig): Promise<void> {
  const joinToken = process.env.PLEXUS_JOIN_TOKEN?.trim();
  if (!joinToken) {
    // eslint-disable-next-line no-console
    console.error(
      "[proxy] PLEXUS_JOIN_TOKEN is required — a proxy presents a one-time join token at\n" +
        "        enrollment. Mint one on the primary with `plexus mesh mint`.",
    );
    process.exit(2);
  }

  // The proxy EXPOSES a real in-repo source so it has a real capability to forward on the
  // primary's behalf. The A4 demo always used `mock`; the multi-host demo selects a DIFFERENT
  // surface per proxy (e.g. `workspace` for proxy-A, `mock` for proxy-B) via PLEXUS_DEMO_PROXY_SOURCE
  // so the aggregated catalog carries genuinely distinct caps. Default `mock` (A4 back-compat).
  const proxySources = process.env.PLEXUS_DEMO_PROXY_SOURCE?.trim() || "mock";
  const sources = registryOf(modulesFor(proxySources));
  const capabilities = createCapabilityRegistry(sources);

  // PROXY wss CA-trust (B7): trust a self-signed `wss://` primary cert per-connection.
  const upstreamTls = loadUpstreamTls();

  // createAppWithState with the proxy `mode`/`upstream`/`workload` (from env via loadConfig)
  // + the join token through the mesh injection seam. The Ed25519 identity is NOT injected:
  // it auto-loads/persists under THIS process's PLEXUS_HOME (loadOrCreateMeshIdentity), so
  // the proxy owns a real, durable key distinct from the primary's.
  const { app, state } = createAppWithState(config, {
    sources,
    capabilities,
    mesh: { joinToken, ...(upstreamTls ? { upstreamTls } : {}) },
  });

  // Scan the mock source so `mock.echo.run` is live + invocable before we ascend the catalog.
  await state.capabilities.start();

  // Bind the proxy's OWN loopback agent surface (unused by the demo, but a real proxy
  // gateway serves its local capabilities too — and the live socket keeps the process up).
  const server = Bun.serve({ port: config.port, hostname: "127.0.0.1", fetch: app.fetch });
  setBoundPort(state, server.port);

  // DIAL + mutual Ed25519 handshake + ENROLL (presenting the join token once) + LIVE
  // CATALOG ASCENT (the primary auto-mounts the pushed bare entries under tenant/workload/).
  await state.mesh.start();

  const upstream = config.upstream?.url ?? "(unset)";
  const scheme = upstream.startsWith("wss://") ? "wss(enc-ON)" : "ws(enc-OFF)";
  // eslint-disable-next-line no-console
  console.log(`[proxy] agent surface: http://127.0.0.1:${server.port}  (local, unused by demo)`);
  // eslint-disable-next-line no-console
  console.log(`[proxy] exposes source(s): ${proxySources}`);
  // eslint-disable-next-line no-console
  console.log(`[proxy] dialed upstream: ${upstream}  (${scheme})  as workload=${config.workload}`);
  emitReady("proxy", {
    agentPort: server.port,
    workload: config.workload,
    source: proxySources,
    upstream,
    scheme,
    pid: process.pid,
  });

  // Graceful shutdown: stop the tunnel + the local socket on a signal.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      // eslint-disable-next-line no-console
      console.log(`[proxy] received ${sig}, shutting down`);
      state.mesh.stop();
      server.stop(true);
      process.exit(0);
    });
  }
}

/**
 * Boot the MAC PRIMARY exposing its OWN local capabilities (the multi-host demo, P4-?).
 * Unlike the A4 `bootPrimary` — whose directory is DELIBERATELY empty so it shows ONLY what a
 * proxy mounts — this primary SCANS an explicit set of in-repo first-party sources
 * (`PLEXUS_DEMO_PRIMARY_SOURCES`, e.g. `workspace,apple-calendar`) so `.well-known` lists the
 * mac's OWN caps BEFORE any proxy connects. It still:
 *   • opens the DUAL tunnel listener (ws + wss) from the `PLEXUS_MESH_*` env (B7), so a proxy can
 *     dial in over enc-ON (wss) OR enc-OFF (ws), and
 *   • keeps the DEFAULT human-in-the-loop authorizer, so a grant for a remote (extension-class)
 *     mesh capability still PENDS for a human consent act.
 * The mac's OWN first-party reads default-EXPOSED (local caps are visible unless hidden); a
 * mounted proxy address defaults HIDDEN (join ≠ access) until the owner enables it.
 */
async function bootMacPrimary(config: GatewayConfig, names: string): Promise<void> {
  const sources = registryOf(modulesFor(names));
  const capabilities = createCapabilityRegistry(sources);
  const { app, state } = createAppWithState(config, { sources, capabilities });

  // SCAN the mac's own sources so its caps are live + discoverable before the tunnel opens.
  await state.capabilities.start();

  // Bind the mac's agent-facing HTTP surface (the single surface the agent ever talks to).
  const server = Bun.serve({ port: config.port, hostname: "127.0.0.1", fetch: app.fetch });
  setBoundPort(state, server.port);

  // Open the DUAL tunnel listener (ws + wss) from config.tunnel (B7). A TLS-read failure throws
  // here with a clear message rather than a silent dead-end.
  await state.mesh.start();

  const eps = state.mesh.tunnelEndpoints;
  const wssEp = eps.find((e) => e.scheme === "wss");
  const wsEp = eps.find((e) => e.scheme === "ws");
  // eslint-disable-next-line no-console
  console.log(`[primary] agent surface: ${baseUrl({ ...config, port: server.port })}`);
  // eslint-disable-next-line no-console
  console.log(`[primary] own sources scanned: ${names}`);
  // eslint-disable-next-line no-console
  console.log(`[primary] tunnel endpoints: ${eps.map((e) => `${e.scheme}://${e.host}:${e.port}`).join(", ")}`);
  emitReady("primary", {
    agentPort: server.port,
    tunnelPort: state.mesh.tunnelPort,
    wsPort: wsEp?.port ?? 0,
    wssPort: wssEp?.port ?? 0,
    pid: process.pid,
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      // eslint-disable-next-line no-console
      console.log(`[primary] received ${sig}, shutting down`);
      state.mesh.stop();
      server.stop(true);
      process.exit(0);
    });
  }
}

async function main(): Promise<void> {
  const config = loadConfig(); // reads PLEXUS_MODE / PLEXUS_UPSTREAM_* / PLEXUS_WORKLOAD / PLEXUS_PORT
  if (config.mode === "proxy") {
    await bootProxy(config);
  } else if (process.env.PLEXUS_DEMO_PRIMARY_SOURCES?.trim()) {
    // The multi-host demo: a MAC PRIMARY that exposes its OWN caps (own-source set via env).
    await bootMacPrimary(config, process.env.PLEXUS_DEMO_PRIMARY_SOURCES.trim());
  } else {
    await bootPrimary(config);
  }
}

await main();
