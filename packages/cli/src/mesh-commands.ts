/**
 * ============================================================================
 * `plexus mesh …` — the federated-mesh operator sub-CLI (A1).
 * ============================================================================
 *
 * A thin HTTP client over the same-origin admin API (`/admin/api/mesh*`), mirroring
 * `source-commands.ts`. It NEVER imports the gateway/runtime — it only speaks HTTP to
 * a RUNNING primary, exactly like a human in the /admin UI but from the terminal. It
 * lets an operator mint the ONE-TIME join token a remote proxy presents at enrollment,
 * which until now had no out-of-process surface (`mintJoinToken()` was in-process only):
 *
 *   plexus mesh mint [--ttl <dur>]   — mint a one-time join token + print the proxy's
 *                                      upstream env block (URL / pubkey / workload).
 *   plexus mesh status               — the mesh posture (mode, tunnel port, pubkey).
 *
 * AUTH MODEL (mirrors `admin.ts` + `source-commands.ts`): the admin API is the TRUSTED
 * local management surface, guarded by the gateway's loopback Host guard + a verified
 * connection-key. So this CLI authenticates by being a local process that (a) can read
 * `~/.plexus/connection-key` (proof of local trust) and (b) ALWAYS sends the loopback
 * `Host` header + the key as `X-Plexus-Connection-Key`. Minting an admission token is a
 * trust-boundary act, so the same management-key gate that fronts every `/admin/api/*`
 * route fronts this one — no special-case auth.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PORT = 7077;

// ── shared error type (mirrors plexus-cli's CliError shape) ──────────────────

/** A typed CLI error carrying an exit code (matches the parent CLI's contract). */
export class MeshCliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "MeshCliError";
    this.exitCode = exitCode;
  }
}

// ── option parsing (sub-flags for `mesh`) ────────────────────────────────────

interface MeshOpts {
  /** Gateway base URL override (--url). */
  url?: string;
  /** Connection-key override (--key). */
  key?: string;
  /** One-time token TTL as a duration (--ttl), e.g. 10m / 1h / 30s / 500ms / a bare ms number. */
  ttl?: string;
  /** Optional proxy workload name to substitute into the printed PLEXUS_WORKLOAD line. */
  workload?: string;
  /**
   * Routable host to substitute into the printed PLEXUS_UPSTREAM_URL (B7). The primary may BIND
   * `0.0.0.0` (or loopback); a container/VM proxy needs a reachable host (e.g. `host.docker.internal`
   * or the primary's LAN IP). Absent ⇒ the endpoint's bind host (`0.0.0.0` is rewritten to `127.0.0.1`).
   */
  host?: string;
  /** Which tunnel endpoint to build the upstream URL from: `ws` (enc-OFF, default) or `wss` (enc-ON). */
  scheme?: string;
  json: boolean;
  positionals: string[];
}

/** Parse the args AFTER `mesh` (the subcommand + its flags). */
function parseMeshOpts(argv: string[]): MeshOpts {
  const o: MeshOpts = { json: false, positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--json") o.json = true;
    else if (a === "--url") o.url = argv[++i];
    else if (a === "--key") o.key = argv[++i];
    else if (a === "--ttl") o.ttl = argv[++i];
    else if (a === "--workload") o.workload = argv[++i];
    else if (a === "--host") o.host = argv[++i];
    else if (a === "--scheme") o.scheme = argv[++i];
    else if (a.startsWith("--url=")) o.url = a.slice("--url=".length);
    else if (a.startsWith("--key=")) o.key = a.slice("--key=".length);
    else if (a.startsWith("--ttl=")) o.ttl = a.slice("--ttl=".length);
    else if (a.startsWith("--workload=")) o.workload = a.slice("--workload=".length);
    else if (a.startsWith("--host=")) o.host = a.slice("--host=".length);
    else if (a.startsWith("--scheme=")) o.scheme = a.slice("--scheme=".length);
    else if (a.startsWith("-")) throw new MeshCliError(`unknown flag: ${a}`, 2);
    else o.positionals.push(a);
  }
  return o;
}

/**
 * Parse a TTL duration into milliseconds. Accepts a bare number (ms) or a `<n><unit>`
 * suffix: `ms`, `s`, `m`, `h`, `d`. Rejects non-positive / unparseable values (the
 * admin route also fail-closes on a bad `ttlMs`, but a clear CLI error is friendlier).
 */
function parseDurationMs(raw: string): number {
  const s = raw.trim();
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(s);
  if (!m) throw new MeshCliError(`--ttl: not a duration (got "${raw}"; use e.g. 10m, 1h, 30s, 500ms)`, 2);
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  const mult = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const ms = n * mult;
  if (!Number.isFinite(ms) || ms <= 0) throw new MeshCliError(`--ttl must be a positive duration (got "${raw}")`, 2);
  return ms;
}

// ── gateway target + connection-key (same resolution as the parent CLI) ──────

function resolveBaseUrl(o: MeshOpts): string {
  const fromFlag = o.url ?? process.env.PLEXUS_URL;
  if (fromFlag && fromFlag.length > 0) return fromFlag.replace(/\/$/, "");
  const port = Number(process.env.PLEXUS_PORT) || DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

function connectionKeyPath(): string {
  const home = process.env.PLEXUS_HOME ?? join(homedir(), ".plexus");
  return join(home, "connection-key");
}

/**
 * Resolve the connection-key: --key > PLEXUS_CONNECTION_KEY > the local
 * `~/.plexus/connection-key` file. Required for every `mesh` subcommand — the admin
 * surface is local-trust only; possessing this key (filesystem access to `~/.plexus`)
 * is the proof, mirroring how `admin.ts` reads it server-side.
 */
function resolveConnectionKey(o: MeshOpts): string {
  const fromFlag = o.key ?? process.env.PLEXUS_CONNECTION_KEY;
  if (fromFlag && fromFlag.length > 0) return fromFlag.trim();
  const path = connectionKeyPath();
  if (!existsSync(path)) {
    throw new MeshCliError(
      `no connection-key: not at ${path} and no --key / PLEXUS_CONNECTION_KEY.\n` +
        `  Start the gateway (\`bin/plexus\`) to generate it, or pass --key.`,
      3,
    );
  }
  const key = readFileSync(path, "utf-8").trim();
  if (!key) throw new MeshCliError(`connection-key file is empty: ${path}`, 3);
  return key;
}

// ── HTTP helper (always sends the loopback Host header + the mgmt key) ────────

/** The loopback authority the gateway's Host/Origin guard expects. */
function loopbackHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return `127.0.0.1:${DEFAULT_PORT}`;
  }
}

interface AdminClient {
  baseUrl: string;
  /** GET/POST an `/admin/api/...` path; returns parsed JSON (or throws). */
  request(method: string, path: string, body?: unknown): Promise<unknown>;
}

function adminClient(o: MeshOpts): AdminClient {
  const baseUrl = resolveBaseUrl(o);
  const key = resolveConnectionKey(o);
  const host = loopbackHost(baseUrl);
  return {
    baseUrl,
    async request(method, path, body) {
      const headers: Record<string, string> = {
        host,
        accept: "application/json",
        "X-Plexus-Connection-Key": key,
      };
      if (body !== undefined) headers["content-type"] = "application/json";
      let res: Response;
      try {
        res = await fetch(`${baseUrl}${path}`, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (e) {
        throw new MeshCliError(
          `cannot reach the gateway at ${baseUrl} (${(e as Error).message}).\n` +
            `  Is it running? Start it with \`bin/plexus\` or set --url / PLEXUS_PORT.`,
          6,
        );
      }
      const text = await res.text();
      let parsed: unknown = undefined;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!res.ok) {
        const errObj = parsed as { error?: { code?: string; message?: string }; reason?: string };
        const code = errObj?.error?.code;
        const msg =
          errObj?.error?.message ??
          errObj?.reason ??
          (typeof parsed === "string" ? parsed : `HTTP ${res.status}`);
        throw new MeshCliError(
          `${method} ${path} failed: ${msg}` + (code ? ` [${code}]` : ` [HTTP ${res.status}]`),
          5,
        );
      }
      return parsed;
    },
  };
}

// ── output helpers ───────────────────────────────────────────────────────────

const out = (s = "") => process.stdout.write(s + "\n");
const emitJson = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");

// ── view types (what the admin API returns) ──────────────────────────────────

/** One bound tunnel listener the primary advertises (B7 / P4-0). */
interface TunnelEndpoint {
  scheme: "ws" | "wss";
  host: string;
  port: number;
}

interface MintResult {
  token: string;
  expiresAt?: string;
  tunnelPort: number;
  endpoints?: TunnelEndpoint[];
  primaryPubKey?: string;
}

interface MeshStatus {
  mode: string;
  tunnelPort: number;
  endpoints?: TunnelEndpoint[];
  primaryPubKey?: string;
}

/**
 * Build the proxy's `PLEXUS_UPSTREAM_URL` from the primary's advertised endpoints (B7). Picks the
 * `--scheme` endpoint (default `ws`), substitutes a routable `--host` (a `0.0.0.0` bind host is
 * rewritten to `127.0.0.1` for a sane local default), and falls back to the legacy `tunnelPort`
 * when an older primary reports no `endpoints`.
 */
function buildUpstreamUrl(res: { tunnelPort: number; endpoints?: TunnelEndpoint[] }, o: MeshOpts): string {
  const scheme = (o.scheme ?? "ws").trim();
  if (scheme !== "ws" && scheme !== "wss") {
    throw new MeshCliError(`--scheme must be "ws" or "wss" (got "${o.scheme}")`, 2);
  }
  const endpoints = res.endpoints ?? [];
  const chosen = endpoints.find((e) => e.scheme === scheme);
  if (!chosen && endpoints.length > 0) {
    const have = endpoints.map((e) => e.scheme).join(", ");
    throw new MeshCliError(`no ${scheme} tunnel endpoint on the primary (available: ${have})`, 2);
  }
  const bindHost = chosen?.host ?? "127.0.0.1";
  const host = o.host && o.host.length > 0 ? o.host : bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost;
  const port = chosen?.port ?? res.tunnelPort;
  return `${scheme}://${host}:${port}`;
}

/** Render the advertised endpoints for human output (e.g. `ws://0.0.0.0:8080, wss://0.0.0.0:8443`). */
function formatEndpoints(endpoints: TunnelEndpoint[] | undefined, tunnelPort: number): string {
  if (!endpoints || endpoints.length === 0) {
    return tunnelPort ? `ws://127.0.0.1:${tunnelPort}` : "(not started)";
  }
  return endpoints.map((e) => `${e.scheme}://${e.host}:${e.port}`).join(", ");
}

interface RevokeResult {
  workload: string;
  tombstoned: boolean;
  unmounted: string[];
  purgedGrants: number;
}

// ── subcommands ──────────────────────────────────────────────────────────────

/**
 * `mesh mint [--ttl <dur>]` — POST /admin/api/mesh/join-token → a one-time token + the
 * proxy's upstream coordinates. Prints the token and a copy-paste env block the operator
 * hands the remote proxy. With --json, emits the raw mint result for machine consumption.
 */
async function cmdMint(client: AdminClient, o: MeshOpts): Promise<void> {
  const body: { ttlMs?: number } = {};
  if (o.ttl !== undefined) body.ttlMs = parseDurationMs(o.ttl);

  const res = (await client.request(
    "POST",
    "/admin/api/mesh/join-token",
    Object.keys(body).length > 0 ? body : {},
  )) as MintResult;

  if (o.json) {
    emitJson(res);
    return;
  }

  const url = buildUpstreamUrl(res, o);
  const workload = o.workload && o.workload.length > 0 ? o.workload : "<name>";
  out(`✓ minted a one-time join token${res.expiresAt ? ` (expires ${res.expiresAt})` : ""}`);
  out(`  token: ${res.token}`);
  out(`  tunnel endpoints: ${formatEndpoints(res.endpoints, res.tunnelPort)}`);
  out("");
  out("  Hand the remote proxy this token + upstream env (single-use — mint a fresh one per proxy):");
  out("");
  out(`  PLEXUS_UPSTREAM_URL=${url}`);
  out(`  PLEXUS_UPSTREAM_PUBKEY=${(res.primaryPubKey ?? "").trim()}`);
  out(`  PLEXUS_WORKLOAD=${workload}`);
  out("");
  out("  (then deliver the token out-of-band; the proxy presents it once at enrollment.)");
  out("  Use --host <reachable-host> (e.g. host.docker.internal / a LAN IP) and --scheme ws|wss");
  out("  to target a specific endpoint when the primary binds 0.0.0.0.");
}

/**
 * `mesh revoke <workload>` — POST /admin/api/mesh/revoke → terminally revoke a remote
 * workload (primary only). Tombstones its enrollment, un-mounts its addresses, purges
 * their grants, and drops its live socket; a reconnect with the old key then fails closed.
 */
async function cmdRevoke(client: AdminClient, o: MeshOpts): Promise<void> {
  const workload = o.positionals[0];
  if (!workload || workload.length === 0) {
    throw new MeshCliError("revoke requires a <workload> argument — `plexus mesh revoke <workload>`", 2);
  }
  const res = (await client.request("POST", "/admin/api/mesh/revoke", { workload })) as RevokeResult;
  if (o.json) {
    emitJson(res);
    return;
  }
  out(`✓ revoked workload '${res.workload}'${res.tombstoned ? "" : " (no active enrollment — unmount/purge ran idempotently)"}`);
  out(`  unmounted addresses: ${res.unmounted.length}`);
  for (const a of res.unmounted) out(`    - ${a}`);
  out(`  purged grants:       ${res.purgedGrants}`);
}

/** `mesh status` — GET /admin/api/mesh → mode, tunnel port, primary pubkey. */
async function cmdStatus(client: AdminClient, o: MeshOpts): Promise<void> {
  const res = (await client.request("GET", "/admin/api/mesh")) as MeshStatus;
  if (o.json) {
    emitJson(res);
    return;
  }
  out(`mode:        ${res.mode}`);
  out(`tunnelPort:  ${res.tunnelPort || "(not started)"}`);
  out(`endpoints:   ${formatEndpoints(res.endpoints, res.tunnelPort)}`);
  out(`primaryKey:  ${res.primaryPubKey ? "present" : "(none — proxy or not started)"}`);
}

// ── dispatch ─────────────────────────────────────────────────────────────────

export const MESH_HELP = `plexus mesh — federated-mesh operator commands over the admin API

Usage:
  plexus mesh <subcommand> [options]

Subcommands:
  mint [--ttl <dur>]             Mint a ONE-TIME join token (primary only) and print
                                 the proxy's upstream env block (URL / pubkey / workload).
  revoke <workload>              TERMINALLY revoke a remote workload (primary only):
                                 tombstone its enrollment, un-mount its addresses, purge
                                 their grants, drop its live socket (reconnect fails closed).
  status                         Show the mesh posture (mode, tunnel port, primary pubkey).

Options (mint):
  --ttl <dur>                    Token expiry as a duration (e.g. 10m, 1h, 30s, 500ms,
                                 or a bare number of ms). Absent ⇒ no expiry.
  --workload <name>              Fill the printed PLEXUS_WORKLOAD line (default: <name>).
  --host <reachable-host>        Routable host for the printed PLEXUS_UPSTREAM_URL when the
                                 primary binds 0.0.0.0 (e.g. host.docker.internal, a LAN IP).
  --scheme ws|wss                Which tunnel endpoint to build the upstream URL from —
                                 ws (enc-OFF, default) or wss (enc-ON, channel-encrypted).

Common options:
  --url <url>                    Gateway base URL (default $PLEXUS_URL or
                                 http://127.0.0.1:\${PLEXUS_PORT:-${DEFAULT_PORT}}).
  --key <connection-key>         Connection-key override (default $PLEXUS_CONNECTION_KEY
                                 or ~/.plexus/connection-key).
  --json                         Machine-readable JSON output.

Examples:
  plexus mesh status
  plexus mesh mint --ttl 1h --workload laptop
  plexus mesh revoke laptop
`;

/**
 * Entry point for the `mesh` subcommand. `argv` is everything AFTER `mesh`.
 * Returns nothing on success; throws `MeshCliError` (caught by the parent CLI).
 */
export async function runMesh(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    process.stdout.write(MESH_HELP);
    if (!sub) throw new MeshCliError("missing subcommand", 2);
    return;
  }

  const o = parseMeshOpts(argv.slice(1));

  switch (sub) {
    case "mint":
      await cmdMint(adminClient(o), o);
      return;
    case "revoke":
      await cmdRevoke(adminClient(o), o);
      return;
    case "status":
      await cmdStatus(adminClient(o), o);
      return;
    default:
      throw new MeshCliError(`unknown mesh subcommand "${sub}" — try \`plexus mesh --help\``, 2);
  }
}
