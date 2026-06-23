#!/usr/bin/env bun
/**
 * ============================================================================
 * `plexus` — the shared Plexus integration CLI (the engine the per-agent
 * wrappers, ti-cc and ti-codex, drive over Bash).
 * ============================================================================
 *
 * Plexus is a LOCAL CAPABILITY GATEWAY that speaks its OWN AI-native protocol:
 *
 *     DISCOVER → handshake (UNDERSTAND) → requestGrants (GRANTED) → invoke (CALL)
 *
 * plus a usage-SKILL layer MCP does not have (`kind:"skill"` entries whose body
 * is read-as-context). It is NOT an MCP server — there is no `/mcp` wire — so a
 * mainstream coding agent (Claude Code, Codex) cannot consume Plexus by dropping
 * an `mcpServers` entry in. Instead this tiny CLI wraps the agent-side
 * `PlexusClient` (the same `examples/min-agent/client.ts` engine the gateway's
 * own harness test drives) and exposes the protocol as four shell-friendly,
 * agent-friendly commands:
 *
 *     plexus discover            — GET .well-known: the "scan" (id/kind/label/
 *                                  one-line-describe/grants/transport per entry).
 *     plexus manifest            — handshake: the FULL manifest (describe/io/
 *                                  skills per entry).
 *     plexus skills [<id>]       — list kind:"skill" entries; with <id>, FETCH a
 *                                  skill body (the "how to use me" knowledge).
 *     plexus call <id> [--input] — handshake → grant (poll if pending) → invoke,
 *                                  printing the REAL result.
 *
 * It auto-reads the connection-key from `~/.plexus/connection-key` (a LOCAL agent
 * needs no manual paste), targets the gateway via `--url` / `PLEXUS_URL` /
 * `PLEXUS_PORT`, and ALWAYS sends the loopback `Host` header (the gateway's
 * host/origin guard). Every protocol error maps to the closed `ErrorCode` union so
 * the wrapping agent can branch deterministically.
 *
 * Output is human-readable by default and machine-readable with `--json` (so an
 * agent can parse rather than scrape). Exit code is 0 on success, non-zero on a
 * protocol/usage failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  PlexusClient,
  PlexusProtocolError,
} from "../../examples/min-agent/client.ts";
import type {
  CapabilityEntry,
  CapabilitySummary,
  GrantVerb,
  ScopedToken,
} from "../../src/protocol/index.ts";

// ── constants ────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 7077;
const CLI_NAME = "plexus";
const CLI_VERSION = "0.1.0";

/** The agent identity stamped into the gateway's audit trail for CLI-driven calls. */
const CLIENT_IDENTITY = {
  name: "plexus-integration-cli",
  version: CLI_VERSION,
  agentId: "plexus-cli",
} as const;

// ── parsed invocation ──────────────────────────────────────────────────────────

interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  url?: string;
  key?: string;
  input?: string;
  verbs?: GrantVerb[];
  json: boolean;
  help: boolean;
  /** Max ms to wait for a `grant_pending_user` approval before giving up. */
  pollTimeoutMs: number;
}

/** A small typed CLI error — carries an exit code + an optional ErrorCode hint. */
class CliError extends Error {
  readonly exitCode: number;
  readonly code?: string;
  constructor(message: string, opts?: { exitCode?: number; code?: string }) {
    super(message);
    this.name = "CliError";
    this.exitCode = opts?.exitCode ?? 1;
    this.code = opts?.code;
  }
}

// ── arg parsing (no dep) ────────────────────────────────────────────────────────

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: undefined,
    positionals: [],
    json: false,
    help: false,
    pollTimeoutMs: 120_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--key") out.key = argv[++i];
    else if (a === "--input" || a === "-i") out.input = argv[++i];
    else if (a === "--verbs") out.verbs = (argv[++i] ?? "").split(",").filter(Boolean) as GrantVerb[];
    else if (a === "--poll-timeout-ms") out.pollTimeoutMs = Number(argv[++i]) || out.pollTimeoutMs;
    else if (a.startsWith("--url=")) out.url = a.slice("--url=".length);
    else if (a.startsWith("--key=")) out.key = a.slice("--key=".length);
    else if (a.startsWith("--input=")) out.input = a.slice("--input=".length);
    else if (a.startsWith("--verbs=")) out.verbs = a.slice("--verbs=".length).split(",").filter(Boolean) as GrantVerb[];
    else if (a.startsWith("-")) throw new CliError(`unknown flag: ${a}`, { exitCode: 2 });
    else if (out.command === undefined) out.command = a;
    else out.positionals.push(a);
  }
  return out;
}

// ── gateway target + connection-key resolution ──────────────────────────────────

/** Resolve the gateway base URL: --url > PLEXUS_URL > http://127.0.0.1:${PLEXUS_PORT|7077}. */
function resolveBaseUrl(args: ParsedArgs): string {
  const fromFlag = args.url ?? process.env.PLEXUS_URL;
  if (fromFlag && fromFlag.length > 0) return fromFlag.replace(/\/$/, "");
  const port = Number(process.env.PLEXUS_PORT) || DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

/** Path of the local connection-key file (a local agent reads it, no paste). */
function connectionKeyPath(): string {
  // Honor PLEXUS_HOME so tests / non-default state dirs work; else ~/.plexus.
  const home = process.env.PLEXUS_HOME ?? join(homedir(), ".plexus");
  return join(home, "connection-key");
}

/**
 * Resolve the connection-key: --key > PLEXUS_CONNECTION_KEY > the local
 * `~/.plexus/connection-key` file. Only needed for handshake-backed commands
 * (`manifest`, `skills <id>`, `call`); `discover` is pre-session and needs none.
 */
function resolveConnectionKey(args: ParsedArgs): string {
  const fromFlag = args.key ?? process.env.PLEXUS_CONNECTION_KEY;
  if (fromFlag && fromFlag.length > 0) return fromFlag.trim();
  const path = connectionKeyPath();
  if (!existsSync(path)) {
    throw new CliError(
      `no connection-key: not at ${path} and no --key / PLEXUS_CONNECTION_KEY.\n` +
        `  Start the gateway (\`bin/plexus\`) to generate it, or pass --key.`,
      { exitCode: 3, code: "no_connection_key" },
    );
  }
  const key = readFileSync(path, "utf-8").trim();
  if (!key) throw new CliError(`connection-key file is empty: ${path}`, { exitCode: 3 });
  return key;
}

// ── tiny output helpers ─────────────────────────────────────────────────────────

const out = (s = "") => process.stdout.write(s + "\n");
const emitJson = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");

/** One-line teaser from a (possibly multi-sentence) describe string. */
function oneLine(s: string, max = 120): string {
  const firstSentence = s.split(/(?<=\.)\s/)[0] ?? s;
  const t = firstSentence.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

// ── commands ─────────────────────────────────────────────────────────────────

/**
 * `discover` — the SCAN. GET /.well-known/plexus and print one line per entry:
 * id, kind, label, one-line describe-teaser, grant cost, transport. Pre-session;
 * no connection-key needed. This is the "what can I do on this machine" window.
 */
/**
 * The resolved gateway base URL, set once at entrypoint. `PlexusClient` keeps its
 * own copy private, so the CLI threads this module-scoped value to the few places
 * that need to build a gateway-relative URL (skill `ref` fetch, the /admin notice).
 */
let GATEWAY_BASE_URL = "";

async function cmdDiscover(client: PlexusClient, args: ParsedArgs): Promise<void> {
  const wk = await client.discover();
  if (args.json) {
    emitJson({ gateway: wk.gateway, capabilities: wk.capabilities });
    return;
  }
  out(
    `gateway: ${wk.gateway.name} v${wk.gateway.version} ` +
      `(protocol ${wk.gateway.protocol}) @ ${wk.gateway.baseUrl}` +
      (wk.gateway.instance ? `  [${wk.gateway.instance}]` : ""),
  );
  const caps = wk.capabilities;
  out(`discovered ${caps.length} entr${caps.length === 1 ? "y" : "ies"}:`);
  for (const s of caps) printSummary(s);
  if (caps.length === 0) {
    out("  (none — boot the gateway with a vault or enable a first-party source)");
  }
}

function printSummary(s: CapabilitySummary): void {
  const grants = s.grants.length ? s.grants.join("+") : "—";
  out(`  • ${s.id}`);
  out(`      ${s.kind} · grants:${grants} · transport:${s.transport} · ${s.label}`);
  out(`      ${oneLine(s.summary)}`);
}

/**
 * `manifest` — handshake → the FULL manifest. Prints every entry with its full
 * describe, io schema presence, attached skills, and (for skills) whether a body
 * is present. This is the "understand" depth `discover` deliberately withholds.
 */
async function cmdManifest(client: PlexusClient, args: ParsedArgs): Promise<void> {
  const key = resolveConnectionKey(args);
  const hs = await client.handshake(key);
  const entries = hs.manifest.entries;
  if (args.json) {
    emitJson(hs.manifest);
    return;
  }
  out(
    `session ${hs.sessionId} (expires ${hs.expiresAt}) — ` +
      `${entries.length} full entr${entries.length === 1 ? "y" : "ies"}, revision ${hs.manifest.revision}`,
  );
  for (const e of entries) printEntry(e);
}

function printEntry(e: CapabilityEntry): void {
  const grants = e.grants.length ? e.grants.join("+") : "—";
  out("");
  out(`  ▸ ${e.id}  (${e.kind})`);
  out(`      label:     ${e.label}`);
  out(`      grants:    ${grants}    transport: ${e.transport}    source: ${e.source}`);
  out(`      describe:  ${oneLine(e.describe, 200)}`);
  if (e.io?.input) out(`      io.input:  present`);
  if (e.io?.output) out(`      io.output: present`);
  if (e.skills?.length) out(`      skills:    ${e.skills.map((s) => s.id).join(", ")}`);
  if (e.members?.length) out(`      members:   ${e.members.map((m) => m.id).join(", ")}`);
  if (e.kind === "skill") out(`      body:      ${e.body ? `present (${e.body.format})` : "—"}`);
}

/**
 * `skills` — the SKILL half of "API + skill".
 *   - with no id: list every `kind:"skill"` entry (the usage-knowledge cards).
 *   - with an id: FETCH that skill's body and print it (the markdown the agent
 *     reads as context). The body arrives inline at handshake (format:"markdown")
 *     or by ref (format:"ref") — in which case we GET the ref. An id pointing at a
 *     capability prints its ATTACHED skills.
 */
async function cmdSkills(client: PlexusClient, args: ParsedArgs): Promise<void> {
  const key = resolveConnectionKey(args);
  await client.handshake(key);
  const entries = client.entries();
  const id = args.positionals[0];

  if (!id) {
    const skills = entries.filter((e) => e.kind === "skill");
    if (args.json) {
      emitJson(skills.map((s) => ({ id: s.id, label: s.label, describe: s.describe })));
      return;
    }
    out(`${skills.length} usage skill${skills.length === 1 ? "" : "s"}:`);
    for (const s of skills) {
      out(`  • ${s.id} — ${s.label}`);
      out(`      ${oneLine(s.describe, 160)}`);
    }
    if (skills.length === 0) out("  (no kind:\"skill\" entries exposed)");
    return;
  }

  const entry = entries.find((e) => e.id === id);
  if (!entry) {
    throw new CliError(`no entry with id "${id}" in the manifest`, {
      exitCode: 4,
      code: "unknown_capability",
    });
  }

  // If the id is a capability, surface its attached skills (then read each).
  if (entry.kind !== "skill") {
    const attached = entry.skills ?? [];
    if (attached.length === 0) {
      throw new CliError(
        `"${id}" is a ${entry.kind} with no attached usage skills.`,
        { exitCode: 4 },
      );
    }
    if (args.json) {
      const bodies = await Promise.all(
        attached.map(async (ref) => ({
          id: ref.id,
          label: ref.label,
          body: await fetchSkillBody(client, ref.id),
        })),
      );
      emitJson(bodies);
      return;
    }
    out(`usage skills attached to ${id}:`);
    for (const ref of attached) {
      out(`\n──── ${ref.id} — ${ref.label} ────`);
      out(await fetchSkillBody(client, ref.id));
    }
    return;
  }

  // The id IS a skill: fetch + print its body.
  const body = await fetchSkillBody(client, id);
  if (args.json) {
    emitJson({ id: entry.id, label: entry.label, body });
    return;
  }
  out(`──── ${entry.id} — ${entry.label} ────`);
  out(body);
}

/**
 * Resolve a skill entry's body to markdown text. Inline bodies (format:"markdown")
 * are returned directly; ref bodies (format:"ref") are GET-fetched from the
 * gateway-relative URL with the loopback Host header. Requires a prior handshake.
 */
async function fetchSkillBody(client: PlexusClient, id: string): Promise<string> {
  const entry = client.entry(id);
  if (!entry) throw new CliError(`skill "${id}" not in the manifest`, { exitCode: 4 });
  if (entry.kind !== "skill") throw new CliError(`"${id}" is not a kind:"skill" entry`, { exitCode: 4 });
  const body = entry.body;
  if (!body) throw new CliError(`skill "${id}" has no body`, { exitCode: 4 });
  if (body.format === "markdown") {
    return body.markdown ?? "";
  }
  // format:"ref" — fetch the gateway-relative content URL.
  if (!body.ref) throw new CliError(`skill "${id}" body is a ref with no URL`, { exitCode: 4 });
  const url = body.ref.startsWith("http") ? body.ref : GATEWAY_BASE_URL + body.ref;
  const res = await fetch(url, { headers: { host: new URL(GATEWAY_BASE_URL).host } });
  if (!res.ok) throw new CliError(`failed to fetch skill ref ${url}: HTTP ${res.status}`, { exitCode: 4 });
  return await res.text();
}

/**
 * `call <id> [--input <json>]` — the CALL. handshake → request a grant (read-only
 * by default, or the entry's required verbs / explicit --verbs) → if the configured
 * Authorizer DEFERS (`grant_pending_user`), tell the user to approve in the Plexus
 * management UI (/admin) and POLL `GET /grants/status` until resolved → invoke →
 * print the real result. Errors map to the closed ErrorCode union.
 */
async function cmdCall(client: PlexusClient, args: ParsedArgs): Promise<void> {
  const id = args.positionals[0];
  if (!id) throw new CliError(`usage: ${CLI_NAME} call <id> [--input <json>]`, { exitCode: 2 });

  let input: Record<string, unknown> | undefined;
  if (args.input !== undefined) {
    try {
      input = JSON.parse(args.input) as Record<string, unknown>;
    } catch (e) {
      throw new CliError(`--input is not valid JSON: ${(e as Error).message}`, { exitCode: 2 });
    }
  }

  const key = resolveConnectionKey(args);
  await client.handshake(key);

  const entry = client.entry(id);
  if (!entry) {
    throw new CliError(
      `no entry "${id}" in the manifest — run \`${CLI_NAME} discover\` to see ids`,
      { exitCode: 4, code: "unknown_capability" },
    );
  }
  if (entry.kind === "skill") {
    throw new CliError(
      `"${id}" is a usage skill (read-as-context), not callable — use \`${CLI_NAME} skills ${id}\``,
      { exitCode: 2 },
    );
  }

  // Request a grant. The default `AutoApproveAuthorizer` mints immediately; a
  // stricter policy returns grant_pending_user — we surface the /admin approval
  // instruction (to stderr so stdout stays the result) and poll until resolved.
  let token: ScopedToken;
  try {
    token = await requestGrantWithPendingNotice(client, id, args);
  } catch (err) {
    throw asCliError(err);
  }

  // Invoke. /invoke returns the single InvokeResponse shape for success AND every
  // denial (v0.1.1 / ADR-017): we read `ok` directly and branch on `error.code`.
  const res = await client.invoke(id, input, { token });

  if (args.json) {
    emitJson(res);
    if (!res.ok) process.exitCode = 5;
    return;
  }

  if (!res.ok) {
    const code = res.error?.code ?? "internal_error";
    out(`✗ call denied [${code}]: ${res.error?.message ?? "(no message)"}`);
    out(`  auditId: ${res.auditId || "(edge denial — no audit event)"}`);
    out(`  ${recoveryHint(code)}`);
    process.exitCode = 5;
    return;
  }

  out(`✓ ${id} ok  (auditId ${res.auditId})`);
  if (res.output !== undefined) {
    out("──── output ────");
    out(typeof res.output === "string" ? res.output : JSON.stringify(res.output, null, 2));
  }
  if (res.mcpResult) {
    out("──── mcpResult (verbatim) ────");
    out(JSON.stringify(res.mcpResult, null, 2));
  }
}

/**
 * Request a grant; on `grant_pending_user` print the /admin approval instruction to
 * STDERR (keeping stdout clean for the eventual result) and let the client poll.
 */
async function requestGrantWithPendingNotice(
  client: PlexusClient,
  id: string,
  args: ParsedArgs,
): Promise<ScopedToken> {
  // First attempt: ask for grants with a short poll. The client's requestGrants
  // already polls on pending; we wrap it so we can emit the human notice the
  // FIRST time we detect a pending decision. To do that we make the raw call and
  // branch ourselves so the notice fires before the (potentially long) poll.
  const sessionId = client.getSessionId();
  if (!sessionId) throw new CliError("internal: no session after handshake", { exitCode: 1 });

  // Use the high-level helper, but probe for pending by catching its timeout and
  // re-issuing with the user-facing notice. Simpler: emit the notice up front only
  // when the underlying response is pending. The client lacks a "raw" hook, so we
  // request with the full poll timeout and print the notice immediately — the
  // notice is harmless when auto-approve mints instantly (poll returns at once).
  const verbsOpt = args.verbs && args.verbs.length > 0 ? { verbs: args.verbs } : {};

  // Race a tiny timer: if the grant has not resolved in 250ms, it is almost
  // certainly pending → show the /admin instruction. Auto-approve resolves well
  // under 250ms, so the notice does not fire on the happy path.
  const grantPromise = client.requestGrants([id], {
    ...verbsOpt,
    pollTimeoutMs: args.pollTimeoutMs,
    pollIntervalMs: 500,
  });
  const noticeTimer = setTimeout(() => {
    process.stderr.write(
      `\n[plexus] grant for "${id}" is awaiting your approval.\n` +
        `         Open the Plexus management UI and approve it:\n` +
        `           ${GATEWAY_BASE_URL}/admin\n` +
        `         Polling until resolved (timeout ${Math.round(args.pollTimeoutMs / 1000)}s)…\n`,
    );
  }, 250);

  try {
    const token = await grantPromise;
    return token;
  } finally {
    clearTimeout(noticeTimer);
  }
}

/** Map a thrown error to a CliError with the protocol ErrorCode preserved. */
function asCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof PlexusProtocolError) {
    return new CliError(`[${err.code}] ${err.message}\n  ${recoveryHint(err.code)}`, {
      exitCode: 5,
      code: err.code,
    });
  }
  return new CliError(err instanceof Error ? err.message : String(err), { exitCode: 1 });
}

/** One-line recovery hint per closed ErrorCode (mirrors PROTOCOL §4 table). */
function recoveryHint(code: string): string {
  switch (code) {
    case "grant_required":
      return "→ the entry needs a grant; re-run `plexus call` (or approve in /admin).";
    case "grant_pending_user":
      return "→ approve the grant in the Plexus management UI (/admin), then retry.";
    case "token_expired":
      return "→ token expired; re-run the call (a fresh handshake + grant is issued).";
    case "token_revoked":
      return "→ the grant was revoked; request it again via `plexus call`.";
    case "session_expired":
      return "→ session expired; re-run (a fresh handshake is performed).";
    case "unknown_capability":
      return "→ id not found; run `plexus discover` for current ids.";
    case "schema_validation_failed":
      return "→ fix --input against the entry's io.input (see `plexus manifest`).";
    case "source_unavailable":
      return "→ the backing app/source is not reachable; start it and retry.";
    case "host_forbidden":
      return "→ Host/Origin guard rejected the request; target the loopback authority.";
    case "rate_limited":
      return "→ back off and retry.";
    default:
      return "→ see the Plexus protocol error table (docs/protocol).";
  }
}

// ── help ─────────────────────────────────────────────────────────────────────

const HELP = `${CLI_NAME} — drive the Plexus local capability gateway (discover → grant → invoke + usage skills)

Usage:
  ${CLI_NAME} <command> [options]

Commands:
  discover                       Scan: list every capability/skill/workflow the
                                 gateway exposes (id, kind, grants, transport,
                                 one-line describe). Pre-session — no key needed.
  manifest                       Handshake → the FULL manifest (full describe / io
                                 / attached skills per entry).
  skills [<id>]                  List kind:"skill" usage-knowledge entries; with an
                                 <id>, FETCH and print that skill's body (the "how
                                 to use me" markdown). An <id> of a capability prints
                                 its attached skills.
  call <id> [--input <json>]     Handshake → request a grant (read-only by default)
                                 → if pending, approve in /admin (the CLI polls) →
                                 invoke → print the REAL result.

Options:
  --url <url>                    Gateway base URL (default $PLEXUS_URL or
                                 http://127.0.0.1:\${PLEXUS_PORT:-${DEFAULT_PORT}}).
  --key <connection-key>         Connection-key override (default: read from
                                 \$PLEXUS_CONNECTION_KEY or ~/.plexus/connection-key).
  --input <json>                 (call) JSON call arguments, e.g. '{"path":"Index.md"}'.
  --verbs <a,b>                  (call) Override the requested grant verbs
                                 (read|write|execute). Default: the entry's required verbs.
  --poll-timeout-ms <ms>         (call) Max wait for a pending grant approval (default 120000).
  --json                         Machine-readable JSON output (for agent parsing).
  --help, -h                     Show this help.

Environment:
  PLEXUS_URL                     Gateway base URL.
  PLEXUS_PORT                    Loopback port (default ${DEFAULT_PORT}) when PLEXUS_URL is unset.
  PLEXUS_CONNECTION_KEY          Connection-key (else ~/.plexus/connection-key).
  PLEXUS_HOME                    Gateway state dir (default ~/.plexus); the key is read from here.

Examples:
  ${CLI_NAME} discover
  ${CLI_NAME} skills obsidian.vault.how-to-cite
  ${CLI_NAME} call obsidian.vault.read --input '{"path":"Index.md"}'
`;

// ── entrypoint ─────────────────────────────────────────────────────────────────

export async function run(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return e instanceof CliError ? e.exitCode : 2;
  }

  if (args.help || args.command === undefined || args.command === "help") {
    process.stdout.write(HELP);
    return args.command === undefined && !args.help ? 2 : 0;
  }

  const baseUrl = resolveBaseUrl(args);
  GATEWAY_BASE_URL = baseUrl;
  const client = new PlexusClient({ baseUrl, client: CLIENT_IDENTITY });

  try {
    switch (args.command) {
      case "discover":
        await cmdDiscover(client, args);
        break;
      case "manifest":
        await cmdManifest(client, args);
        break;
      case "skills":
        await cmdSkills(client, args);
        break;
      case "call":
        await cmdCall(client, args);
        break;
      default:
        throw new CliError(`unknown command "${args.command}" — try \`${CLI_NAME} --help\``, {
          exitCode: 2,
        });
    }
    return process.exitCode ? Number(process.exitCode) : 0;
  } catch (err) {
    const cli = asCliError(err);
    if (args.json) {
      emitJson({ ok: false, error: { code: cli.code ?? "cli_error", message: cli.message } });
    } else {
      process.stderr.write(`✗ ${cli.message}\n`);
    }
    return cli.exitCode;
  }
}

// Run when invoked directly (not when imported by a test).
if (import.meta.main) {
  const code = await run(process.argv.slice(2));
  process.exit(code);
}
