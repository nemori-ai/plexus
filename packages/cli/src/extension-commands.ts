/**
 * ============================================================================
 * `plexus extension …` — the runtime-extension ADMIN sub-CLI (FEAT-CREATE-EXTENSION).
 * ============================================================================
 *
 * A thin HTTP client over the same-origin admin API (`/admin/api/extensions*`). It
 * never imports the gateway/registry — it only speaks HTTP to a RUNNING gateway,
 * exactly like a human in the /admin UI but from the terminal. It lets a user (or an
 * authoring agent like codex/cc) PREVIEW a manifest, INSTALL it, LIST live extensions,
 * and REMOVE one:
 *
 *   plexus extension preview <manifest.json>   — validate + show the security surface (no commit).
 *   plexus extension add     <manifest.json>   — install LIVE (human-approved commit).
 *   plexus extension list                      — live extension-provenance sources.
 *   plexus extension remove  <source>          — unregister + purge grants.
 *
 * AUTH MODEL (mirrors `source-commands.ts`): the admin API is the TRUSTED local
 * management surface — loopback Host/Origin guarded + connection-key gated. This CLI
 * authenticates by being a local process that can read `~/.plexus/connection-key`
 * (the same gate the other `plexus` commands use) and ALWAYS sends the loopback Host
 * header + `X-Plexus-Connection-Key`.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PORT = 7077;

// ── shared error type (mirrors the parent CLI's CliError shape) ──────────────

/** A typed CLI error carrying an exit code (matches the parent CLI's contract). */
export class ExtensionCliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "ExtensionCliError";
    this.exitCode = exitCode;
  }
}

// ── option parsing (sub-flags for `extension`) ───────────────────────────────

interface ExtensionOpts {
  /** Gateway base URL override (--url). */
  url?: string;
  /** Connection-key override (--key). */
  key?: string;
  json: boolean;
  positionals: string[];
}

/** Parse the args AFTER `extension` (the subcommand + its flags). */
function parseExtensionOpts(argv: string[]): ExtensionOpts {
  const o: ExtensionOpts = { json: false, positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--json") o.json = true;
    else if (a === "--url") o.url = argv[++i];
    else if (a === "--key") o.key = argv[++i];
    else if (a.startsWith("--url=")) o.url = a.slice("--url=".length);
    else if (a.startsWith("--key=")) o.key = a.slice("--key=".length);
    else if (a.startsWith("-")) throw new ExtensionCliError(`unknown flag: ${a}`, 2);
    else o.positionals.push(a);
  }
  return o;
}

// ── gateway target + connection-key (same resolution as `source`) ────────────

function resolveBaseUrl(o: ExtensionOpts): string {
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
 * `~/.plexus/connection-key` file. Required for every `extension` subcommand — the
 * admin surface is local-trust only; possessing this key is the proof.
 */
function resolveConnectionKey(o: ExtensionOpts): string {
  const fromFlag = o.key ?? process.env.PLEXUS_CONNECTION_KEY;
  if (fromFlag && fromFlag.length > 0) return fromFlag.trim();
  const path = connectionKeyPath();
  if (!existsSync(path)) {
    throw new ExtensionCliError(
      `no connection-key: not at ${path} and no --key / PLEXUS_CONNECTION_KEY.\n` +
        `  Start the gateway (\`bin/plexus\`) to generate it, or pass --key.`,
      3,
    );
  }
  const key = readFileSync(path, "utf-8").trim();
  if (!key) throw new ExtensionCliError(`connection-key file is empty: ${path}`, 3);
  return key;
}

// ── HTTP helper (always sends the loopback Host header + the mgmt key) ────────

function loopbackHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return `127.0.0.1:${DEFAULT_PORT}`;
  }
}

interface AdminClient {
  baseUrl: string;
  request(method: string, path: string, body?: unknown): Promise<unknown>;
}

function adminClient(o: ExtensionOpts): AdminClient {
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
        throw new ExtensionCliError(
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
        throw new ExtensionCliError(
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

// ── manifest loading (from a JSON file path) ─────────────────────────────────

/** Read + parse a manifest JSON file; throws a typed CLI error on any failure. */
function loadManifest(pathArg: string | undefined): unknown {
  if (!pathArg) {
    throw new ExtensionCliError(`a <manifest.json> path is required`, 2);
  }
  if (!existsSync(pathArg)) {
    throw new ExtensionCliError(`manifest file not found: ${pathArg}`, 2);
  }
  let raw: string;
  try {
    raw = readFileSync(pathArg, "utf8");
  } catch (e) {
    throw new ExtensionCliError(`cannot read manifest ${pathArg}: ${(e as Error).message}`, 2);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new ExtensionCliError(`manifest ${pathArg} is not valid JSON: ${(e as Error).message}`, 2);
  }
}

// ── view types (what the admin API returns) ──────────────────────────────────

interface PreviewSurface {
  source: string;
  label: string;
  capabilities: { id: string; label: string; kind: string; transport: string; verbs: string[] }[];
  cliBins: string[];
  restHosts: string[];
  crossSource: { id: string; sources: string[] }[];
  transportBacked: boolean;
}

interface PreviewResponse {
  ok: boolean;
  valid: boolean;
  reasons: string[];
  surface: PreviewSurface | null;
}

interface CreateResponse {
  ok: boolean;
  source: string;
  registered: string[];
  revision: number;
  reason?: string;
}

interface ExtensionRow {
  source: string;
  label: string;
  capabilities: string[];
}

// ── subcommands ──────────────────────────────────────────────────────────────

/** Pretty-print a preview surface (shared by preview + add). */
function printSurface(surface: PreviewSurface | null): void {
  if (!surface) {
    out("  (no surface — manifest is structurally broken)");
    return;
  }
  out(`  source: ${surface.source}  (${surface.label})`);
  out(`  transport-backed: ${surface.transportBacked ? "yes" : "no"}`);
  out(`  capabilities (${surface.capabilities.length}):`);
  for (const cap of surface.capabilities) {
    const verbs = cap.verbs.length ? cap.verbs.join(",") : "(none)";
    out(`    • ${cap.id}  [${cap.kind} · ${cap.transport} · ${verbs}]  ${cap.label}`);
  }
  if (surface.cliBins.length) out(`  cli bins:   ${surface.cliBins.join(", ")}`);
  if (surface.restHosts.length) out(`  rest hosts: ${surface.restHosts.join(", ")}`);
  if (surface.crossSource.length) {
    out(`  cross-source attaches:`);
    for (const x of surface.crossSource) out(`    • ${x.id} → ${x.sources.join(", ")}`);
  }
}

/** `extension preview <manifest.json>` — POST preview; show valid/reasons + surface. */
async function cmdPreview(client: AdminClient, o: ExtensionOpts): Promise<void> {
  const manifest = loadManifest(o.positionals[0]);
  const res = (await client.request("POST", "/admin/api/extensions/preview", {
    manifest,
  })) as PreviewResponse;
  if (o.json) {
    emitJson(res);
    if (!res.valid) process.exitCode = 5;
    return;
  }
  if (res.valid) {
    out(`✓ manifest is VALID`);
  } else {
    out(`✗ manifest is INVALID:`);
    for (const r of res.reasons) out(`    - ${r}`);
    process.exitCode = 5;
  }
  out(`security surface:`);
  printSurface(res.surface);
}

/** `extension add <manifest.json>` — POST admin create; print registered ids. */
async function cmdAdd(client: AdminClient, o: ExtensionOpts): Promise<void> {
  const manifest = loadManifest(o.positionals[0]);
  const res = (await client.request("POST", "/admin/api/extensions", {
    manifest,
  })) as CreateResponse;
  if (o.json) {
    emitJson(res);
    if (!res.ok) process.exitCode = 5;
    return;
  }
  if (!res.ok) {
    out(`✗ install "${res.source || "(unknown)"}" failed: ${res.reason ?? "(no reason)"}`);
    process.exitCode = 5;
    return;
  }
  out(`✓ installed extension "${res.source}" — revision ${res.revision}`);
  out(
    `  registered ${res.registered.length} capabilit${res.registered.length === 1 ? "y" : "ies"}: ${res.registered.join(", ") || "(none)"}`,
  );
}

/** `extension list` — GET live extension-provenance sources. */
async function cmdList(client: AdminClient, o: ExtensionOpts): Promise<void> {
  const res = (await client.request("GET", "/admin/api/extensions")) as {
    extensions: ExtensionRow[];
    revision: number;
  };
  if (o.json) {
    emitJson(res);
    return;
  }
  const exts = res.extensions ?? [];
  out(`${exts.length} extension${exts.length === 1 ? "" : "s"} (revision ${res.revision}):`);
  for (const e of exts) {
    out(`  • ${e.source}`);
    out(`      capabilities (${e.capabilities.length}): ${e.capabilities.join(", ") || "(none)"}`);
  }
  if (exts.length === 0) {
    out("  (none — `plexus extension add <manifest.json>` to install one)");
  }
}

/** `extension remove <source>` — DELETE admin extensions. */
async function cmdRemove(client: AdminClient, o: ExtensionOpts): Promise<void> {
  const source = o.positionals[0];
  if (!source) throw new ExtensionCliError(`usage: plexus extension remove <source>`, 2);
  const res = (await client.request(
    "DELETE",
    `/admin/api/extensions/${encodeURIComponent(source)}`,
  )) as { ok: boolean; source: string; removed: string[] };
  if (o.json) {
    emitJson(res);
    if (!res.ok) process.exitCode = 5;
    return;
  }
  if (!res.ok) {
    out(`✗ remove "${source}" — nothing removed (not a registered extension?)`);
    process.exitCode = 5;
    return;
  }
  out(`✓ removed extension "${source}" (${res.removed.length} capabilit${res.removed.length === 1 ? "y" : "ies"})`);
}

// ── dispatch ─────────────────────────────────────────────────────────────────

export const EXTENSION_HELP = `plexus extension — author/install runtime extensions over the admin API

Usage:
  plexus extension <subcommand> [options]

Subcommands:
  preview <manifest.json>        Validate a manifest + show its security surface
                                 (cli bins / rest hosts / cross-source / verbs).
                                 Does NOT commit.
  add <manifest.json>            Install (register LIVE + audit) an extension. The
                                 local user IS the human approver, so this commits.
  list                           List live extension-provenance sources + their caps.
  remove <source>                Unregister an extension + purge its grants.

Common options:
  --url <url>                    Gateway base URL (default $PLEXUS_URL or
                                 http://127.0.0.1:\${PLEXUS_PORT:-${DEFAULT_PORT}}).
  --key <connection-key>         Connection-key override (default $PLEXUS_CONNECTION_KEY
                                 or ~/.plexus/connection-key).
  --json                         Machine-readable JSON output.

Authoring guide (the manifest contract an agent follows):
  curl -s -H "X-Plexus-Connection-Key: \$(cat ~/.plexus/connection-key)" \\
       http://127.0.0.1:${DEFAULT_PORT}/admin/api/extensions/authoring-guide

Examples:
  plexus extension preview ./my-vault.json
  plexus extension add ./my-vault.json
  plexus extension list
  plexus extension remove my-vault
`;

/**
 * Entry point for the `extension` subcommand. `argv` is everything AFTER `extension`.
 * Returns nothing on success; throws `ExtensionCliError` (caught by the parent CLI).
 */
export async function runExtension(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    process.stdout.write(EXTENSION_HELP);
    if (!sub) throw new ExtensionCliError("missing subcommand", 2);
    return;
  }

  const o = parseExtensionOpts(argv.slice(1));

  switch (sub) {
    case "preview":
      await cmdPreview(adminClient(o), o);
      return;
    case "add":
      await cmdAdd(adminClient(o), o);
      return;
    case "list":
      await cmdList(adminClient(o), o);
      return;
    case "remove":
      await cmdRemove(adminClient(o), o);
      return;
    default:
      throw new ExtensionCliError(
        `unknown extension subcommand "${sub}" — try \`plexus extension --help\``,
        2,
      );
  }
}
