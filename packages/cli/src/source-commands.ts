/**
 * ============================================================================
 * `plexus source …` — the managed-capability-sources ADMIN sub-CLI (msrc-t3).
 * ============================================================================
 *
 * A thin HTTP client over Task 2's same-origin admin API (`/admin/api/sources*`,
 * `/admin/api/secrets/:name`). It never imports the gateway/registry — it only
 * speaks HTTP to a RUNNING gateway, exactly like a human in the /admin UI but
 * from the terminal. It lets a user:
 *
 *   plexus source list                 — the configured sources + live status.
 *   plexus source detect               — reachable sources the gateway could add.
 *   plexus source add <kind> [...]     — write a secret (STDIN) + register a source.
 *   plexus source enable|disable|remove <id>
 *
 * AUTH MODEL (mirrors `admin.ts`): the admin API is the TRUSTED local management
 * surface — it is guarded by the gateway's loopback Host/Origin guard and reads the
 * connection-key from `~/.plexus/` server-side. So this CLI authenticates by being
 * a local process that (a) can read `~/.plexus/connection-key` (proof of local
 * trust, the same gate the other `plexus` commands use) and (b) ALWAYS sends the
 * loopback `Host` header the guard expects. The connection-key is additionally sent
 * as `X-Plexus-Connection-Key` (the admin client's management header), so the
 * surface can tighten later without a CLI change.
 *
 * SECRET DISCIPLINE: an API key is read from STDIN ONLY (`--api-key-stdin`) and
 * POSTed to `/admin/api/secrets/<name>` — NEVER passed on argv (no shell-history /
 * process-table leak). `sources.json` then references it by NAME (`secretRef`).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ConfiguredSource,
  ConfiguredSourceKind,
} from "@plexus/runtime/sources/config/types.ts";

const DEFAULT_PORT = 7077;

// ── shared error type (mirrors plexus-cli's CliError shape) ──────────────────

/** A typed CLI error carrying an exit code (matches the parent CLI's contract). */
export class SourceCliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "SourceCliError";
    this.exitCode = exitCode;
  }
}

// ── option parsing (sub-flags for `source`) ──────────────────────────────────

interface SourceOpts {
  /** Gateway base URL override (--url). */
  url?: string;
  /** Connection-key override (--key). */
  key?: string;
  id?: string;
  baseUrl?: string;
  vaultPath?: string;
  path?: string;
  secretName?: string;
  label?: string;
  transport?: string;
  approval?: string;
  apiKeyStdin: boolean;
  json: boolean;
  positionals: string[];
}

/** Parse the args AFTER `source` (the subcommand + its flags). */
function parseSourceOpts(argv: string[]): SourceOpts {
  const o: SourceOpts = { apiKeyStdin: false, json: false, positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--json") o.json = true;
    else if (a === "--api-key-stdin") o.apiKeyStdin = true;
    else if (a === "--url") o.url = argv[++i];
    else if (a === "--key") o.key = argv[++i];
    else if (a === "--id") o.id = argv[++i];
    else if (a === "--base-url") o.baseUrl = argv[++i];
    else if (a === "--vault-path") o.vaultPath = argv[++i];
    else if (a === "--path") o.path = argv[++i];
    else if (a === "--secret-name") o.secretName = argv[++i];
    else if (a === "--label") o.label = argv[++i];
    else if (a === "--transport") o.transport = argv[++i];
    else if (a === "--approval") o.approval = argv[++i];
    else if (a.startsWith("--url=")) o.url = a.slice("--url=".length);
    else if (a.startsWith("--key=")) o.key = a.slice("--key=".length);
    else if (a.startsWith("--id=")) o.id = a.slice("--id=".length);
    else if (a.startsWith("--base-url=")) o.baseUrl = a.slice("--base-url=".length);
    else if (a.startsWith("--vault-path=")) o.vaultPath = a.slice("--vault-path=".length);
    else if (a.startsWith("--path=")) o.path = a.slice("--path=".length);
    else if (a.startsWith("--secret-name=")) o.secretName = a.slice("--secret-name=".length);
    else if (a.startsWith("--label=")) o.label = a.slice("--label=".length);
    else if (a.startsWith("--transport=")) o.transport = a.slice("--transport=".length);
    else if (a.startsWith("--approval=")) o.approval = a.slice("--approval=".length);
    else if (a.startsWith("-")) throw new SourceCliError(`unknown flag: ${a}`, 2);
    else o.positionals.push(a);
  }
  return o;
}

// ── gateway target + connection-key (same resolution as the parent CLI) ──────

function resolveBaseUrl(o: SourceOpts): string {
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
 * `~/.plexus/connection-key` file. Required for every `source` subcommand — the
 * admin surface is local-trust only; possessing this key (filesystem access to
 * `~/.plexus`) is the proof, mirroring how `admin.ts` reads it server-side.
 */
function resolveConnectionKey(o: SourceOpts): string {
  const fromFlag = o.key ?? process.env.PLEXUS_CONNECTION_KEY;
  if (fromFlag && fromFlag.length > 0) return fromFlag.trim();
  const path = connectionKeyPath();
  if (!existsSync(path)) {
    throw new SourceCliError(
      `no connection-key: not at ${path} and no --key / PLEXUS_CONNECTION_KEY.\n` +
        `  Start the gateway (\`bin/plexus\`) to generate it, or pass --key.`,
      3,
    );
  }
  const key = readFileSync(path, "utf-8").trim();
  if (!key) throw new SourceCliError(`connection-key file is empty: ${path}`, 3);
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
  /** GET/POST/DELETE an `/admin/api/...` path; returns parsed JSON (or throws). */
  request(method: string, path: string, body?: unknown): Promise<unknown>;
}

function adminClient(o: SourceOpts): AdminClient {
  const baseUrl = resolveBaseUrl(o);
  const key = resolveConnectionKey(o);
  const host = loopbackHost(baseUrl);
  return {
    baseUrl,
    async request(method, path, body) {
      const headers: Record<string, string> = {
        // The gateway's trust boundary: a loopback Host = same-origin admin surface.
        host,
        accept: "application/json",
        // The management header (forward-compat with a tighter admin auth).
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
        throw new SourceCliError(
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
        const msg = errObj?.error?.message ?? errObj?.reason ?? (typeof parsed === "string" ? parsed : `HTTP ${res.status}`);
        throw new SourceCliError(
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

// ── STDIN read (for --api-key-stdin) ─────────────────────────────────────────

/** Read all of STDIN as a UTF-8 string, trimming a single trailing newline. */
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Uint8Array);
  }
  const buf = Buffer.concat(chunks).toString("utf8");
  // Trim a trailing newline (common when piping `echo …`); keep interior content.
  return buf.replace(/\r?\n$/, "");
}

// ── view types (what the admin API returns) ──────────────────────────────────

interface SourceView extends ConfiguredSource {
  live: boolean;
  liveCapabilityCount: number;
}

interface DetectedSourceView {
  kind: string;
  suggested: {
    id?: string;
    label?: string;
    kind?: string;
    transport?: string;
    route?: { baseUrl?: string; vaultPath?: string };
    secretRef?: string;
  };
  evidence: string;
  alreadyConfigured: boolean;
  reachable: boolean;
  needsSecret?: { name: string };
}

// ── subcommands ──────────────────────────────────────────────────────────────

/** `source list` — GET /admin/api/sources → id/kind/transport/enabled/live/count. */
async function cmdList(client: AdminClient, o: SourceOpts): Promise<void> {
  const res = (await client.request("GET", "/admin/api/sources")) as {
    sources: SourceView[];
    revision: number;
  };
  if (o.json) {
    emitJson(res);
    return;
  }
  const sources = res.sources ?? [];
  out(`${sources.length} configured source${sources.length === 1 ? "" : "s"} (revision ${res.revision}):`);
  for (const s of sources) {
    const flags = [
      s.enabled ? "enabled" : "disabled",
      s.live ? "live" : "not-live",
    ].join(" · ");
    out(`  • ${s.id}`);
    out(`      ${s.kind} · transport:${s.transport} · ${flags} · capabilities:${s.liveCapabilityCount}`);
    if (s.label) out(`      ${s.label}`);
  }
  if (sources.length === 0) {
    out("  (none — `plexus source detect` to find addable sources, or `plexus source add <kind>`)");
  }
}

/** `source detect` — GET /admin/api/sources/detect → reachable, addable sources. */
async function cmdDetect(client: AdminClient, o: SourceOpts): Promise<void> {
  const res = (await client.request("GET", "/admin/api/sources/detect")) as {
    detected: DetectedSourceView[];
  };
  const detected = res.detected ?? [];
  if (o.json) {
    emitJson(res);
    return;
  }
  out(`${detected.length} detected source${detected.length === 1 ? "" : "s"}:`);
  for (const d of detected) {
    const needs = d.needsSecret ? ` · needs-secret:${d.needsSecret.name}` : "";
    const configured = d.alreadyConfigured ? " · ALREADY CONFIGURED" : "";
    const baseUrl = d.suggested.route?.baseUrl;
    out(`  • ${d.kind}${configured}`);
    out(`      ${d.evidence}${needs}`);
    if (baseUrl) out(`      suggested baseUrl: ${baseUrl}`);
    if (!d.alreadyConfigured) {
      // The "how to add" hint.
      const parts = [`plexus source add ${d.kind}`];
      if (d.suggested.id) parts.push(`--id ${d.suggested.id}`);
      if (baseUrl) parts.push(`--base-url ${baseUrl}`);
      if (d.suggested.route?.vaultPath) parts.push(`--vault-path ${d.suggested.route.vaultPath}`);
      if (d.needsSecret) parts.push(`--secret-name ${d.needsSecret.name} --api-key-stdin`);
      out(`      add it:  ${parts.join(" ")}`);
    }
  }
  if (detected.length === 0) {
    out("  (none reachable — add one manually with `plexus source add <kind> [--base-url …]`)");
  }
}

/**
 * `source add <kind> [--id] [--base-url] [--vault-path] [--secret-name]
 *  [--api-key-stdin]` — if `--api-key-stdin`, read the key from STDIN and
 * `POST /admin/api/secrets/<name>` FIRST (never on argv), then POST the
 * ConfiguredSource (secretRef = name). Prints the AddResult.
 */
async function cmdAdd(client: AdminClient, o: SourceOpts): Promise<void> {
  const kind = o.positionals[0];
  if (!kind) {
    throw new SourceCliError(
      `usage: plexus source add <kind> [--id <id>] [--base-url <url>] [--vault-path <path>] [--secret-name <name>] [--api-key-stdin]`,
      2,
    );
  }

  const secretName = o.secretName;

  // SECRET FIRST: if a key is piped on STDIN, write it to the named secret store
  // BEFORE adding the source (so the source's secretRef resolves at registration).
  if (o.apiKeyStdin) {
    if (!secretName) {
      throw new SourceCliError(`--api-key-stdin requires --secret-name <name> (the secret is referenced by NAME)`, 2);
    }
    const value = await readStdin();
    if (!value) {
      throw new SourceCliError(`--api-key-stdin: no key on STDIN (pipe it, e.g. \`printf %s "$KEY" | plexus source add …\`)`, 2);
    }
    await client.request("POST", `/admin/api/secrets/${encodeURIComponent(secretName)}`, { value });
    if (!o.json) out(`secret "${secretName}" stored (write-only; value never echoed).`);
  }

  const id = o.id ?? kind;
  const route: ConfiguredSource["route"] = {};
  if (o.baseUrl) route.baseUrl = o.baseUrl;
  if (o.vaultPath) route.vaultPath = o.vaultPath;
  if (o.path) route.path = o.path;

  if (o.approval !== undefined && o.approval !== "auto" && o.approval !== "ask") {
    throw new SourceCliError(`--approval must be "auto" or "ask" (got "${o.approval}")`, 2);
  }

  const cfg: ConfiguredSource = {
    id,
    kind: kind as ConfiguredSourceKind,
    label: o.label ?? id,
    enabled: true,
    // Informational; the kind adapter's manifest is the source of truth. Default to
    // local-rest for REST kinds, ipc for fs kinds; an explicit --transport overrides.
    transport: (o.transport as ConfiguredSource["transport"]) ??
      (o.vaultPath || o.path ? "ipc" : "local-rest"),
    ...(Object.keys(route).length > 0 ? { route } : {}),
    ...(secretName ? { secretRef: secretName } : {}),
    ...(o.approval ? { approval: o.approval as ConfiguredSource["approval"] } : {}),
  };

  const result = (await client.request("POST", "/admin/api/sources", cfg)) as {
    ok: boolean;
    source: ConfiguredSource;
    registered: string[];
    revision: number;
    reason?: string;
  };

  if (o.json) {
    emitJson(result);
    if (!result.ok) process.exitCode = 5;
    return;
  }
  if (!result.ok) {
    out(`✗ add "${id}" failed: ${result.reason ?? "(no reason)"}`);
    process.exitCode = 5;
    return;
  }
  out(`✓ added source "${result.source.id}" (${result.source.kind}) — revision ${result.revision}`);
  out(`  registered ${result.registered.length} capabilit${result.registered.length === 1 ? "y" : "ies"}: ${result.registered.join(", ") || "(none)"}`);
}

/** `source enable|disable|remove <id>` — the corresponding admin routes. */
async function cmdLifecycle(
  client: AdminClient,
  action: "enable" | "disable" | "remove",
  o: SourceOpts,
): Promise<void> {
  const id = o.positionals[0];
  if (!id) throw new SourceCliError(`usage: plexus source ${action} <id>`, 2);

  let result: unknown;
  if (action === "remove") {
    result = await client.request("DELETE", `/admin/api/sources/${encodeURIComponent(id)}`);
  } else {
    result = await client.request("POST", `/admin/api/sources/${encodeURIComponent(id)}/${action}`, {});
  }

  if (o.json) {
    emitJson(result);
    const r = result as { ok?: boolean };
    if (r && r.ok === false) process.exitCode = 5;
    return;
  }
  const r = result as { ok?: boolean; reason?: string; registered?: string[] };
  if (r && r.ok === false) {
    out(`✗ ${action} "${id}" failed: ${r.reason ?? "(no reason)"}`);
    process.exitCode = 5;
    return;
  }
  const verb = action === "enable" ? "enabled" : action === "disable" ? "disabled" : "removed";
  out(`✓ ${verb} source "${id}"`);
  if (action === "enable" && r.registered) {
    out(`  registered ${r.registered.length} capabilit${r.registered.length === 1 ? "y" : "ies"}: ${r.registered.join(", ") || "(none)"}`);
  }
}

// ── dispatch ─────────────────────────────────────────────────────────────────

export const SOURCE_HELP = `plexus source — manage capability sources over the admin API

Usage:
  plexus source <subcommand> [options]

Subcommands:
  list                           List configured sources (id/kind/transport/
                                 enabled/live/capabilityCount).
  detect                         List sources the gateway detects as reachable,
                                 with a hint how to add each.
  add <kind> [options]           Add (register LIVE + persist) a source. With
                                 --api-key-stdin, reads the key from STDIN and
                                 stores it as the named secret FIRST (never argv).
  enable <id>                    Re-register + persist enabled:true.
  disable <id>                   Unregister + persist enabled:false (config kept).
  remove <id>                    Unregister + drop from config + purge its grants.

Options (add):
  --id <id>                      Source id (default: the <kind>).
  --base-url <url>               Loopback base URL (REST kinds, e.g. obsidian-rest).
  --vault-path <path>            Vault folder root (fs kinds, e.g. obsidian-fs).
  --path <path>                  Directory root (the workspace-dir kind) — the folder
                                 exposed as a path-confined list/read/write surface.
  --approval <auto|ask>          Per-instance approval posture (default auto). "ask"
                                 = Protected: EVERY verb (reads too) pends for the
                                 owner on first use.
  --secret-name <name>           Secret NAME the source references (secretRef).
  --api-key-stdin                Read the API key from STDIN → store under
                                 --secret-name (the key NEVER appears on argv).
  --label <label>                Human label (default: the id).
  --transport <t>                Override the informational transport.

Common options:
  --url <url>                    Gateway base URL (default $PLEXUS_URL or
                                 http://127.0.0.1:\${PLEXUS_PORT:-${DEFAULT_PORT}}).
  --key <connection-key>         Connection-key override (default $PLEXUS_CONNECTION_KEY
                                 or ~/.plexus/connection-key).
  --json                         Machine-readable JSON output.

Examples:
  plexus source detect
  printf %s "$OBSIDIAN_KEY" | plexus source add obsidian-rest \\
      --base-url https://127.0.0.1:27124 --secret-name obsidian-key --api-key-stdin
  plexus source add workspace-dir --id notes --path ~/Notes --label "Notes"
  plexus source add workspace-dir --id vault-b --path ~/Secrets --approval ask
  plexus source list
  plexus source disable obsidian-rest
  plexus source remove obsidian-rest
`;

/**
 * Entry point for the `source` subcommand. `argv` is everything AFTER `source`.
 * Returns nothing on success; throws `SourceCliError` (caught by the parent CLI).
 */
export async function runSource(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    process.stdout.write(SOURCE_HELP);
    if (!sub) throw new SourceCliError("missing subcommand", 2);
    return;
  }

  const o = parseSourceOpts(argv.slice(1));

  switch (sub) {
    case "list":
      await cmdList(adminClient(o), o);
      return;
    case "detect":
      await cmdDetect(adminClient(o), o);
      return;
    case "add":
      await cmdAdd(adminClient(o), o);
      return;
    case "enable":
      await cmdLifecycle(adminClient(o), "enable", o);
      return;
    case "disable":
      await cmdLifecycle(adminClient(o), "disable", o);
      return;
    case "remove":
      await cmdLifecycle(adminClient(o), "remove", o);
      return;
    default:
      throw new SourceCliError(`unknown source subcommand "${sub}" — try \`plexus source --help\``, 2);
  }
}
