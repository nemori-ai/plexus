/**
 * `plexus bundle …` — Mode-2 task-bundle management over the same-origin admin API
 * (`/admin/api/bundles`, `/admin/api/revoke`). A task bundle is a named, human-approved
 * group of (capability + verbs + optional scope constraint) grants to ONE task agent, plus
 * attached in-scope context — so the agent runs the whole task with no re-prompts (AUTHZ-UX
 * §2.N3). This is a THIN HTTP client over the admin endpoints; it never imports the gateway.
 *
 * Like `source-commands.ts`, it owns its OWN flag grammar (the parent strict parser would
 * reject `--grant`/`--context`) and is dispatched from the RAW argv. It authenticates by
 * being a local process that can read `~/.plexus/connection-key` (sent as the management
 * header), exactly mirroring `source-commands.ts`.
 *
 * Subcommands:
 *   plexus bundle create --agent <id> --name <task>
 *       --grant <capId>:<verbs>[@pathPrefix:<field>=<prefix>[|<prefix>…]]  (repeatable)
 *       [--grant <capId>:<verbs>[@allow:<field>=<v>[|<v>…]]]
 *       [--trust-window <once|1h|1d|7d|until-revoked>]
 *       [--context <skillId|@file.md>]                                       (repeatable)
 *   plexus bundle list
 *   plexus bundle revoke <bundleId>
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  BundleView,
  GrantVerb,
  ScopeConstraint,
} from "@plexus/protocol";

const DEFAULT_PORT = 7077;

export class BundleCliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "BundleCliError";
  }
}

interface BundleOpts {
  url?: string;
  key?: string;
  json: boolean;
  agent?: string;
  name?: string;
  trustWindow?: string;
  /** `<capId>:<verbs>[@<constraint>]` specs (repeatable). */
  grants: string[];
  /** `<skillId>` or `@<file>` context refs (repeatable). */
  context: string[];
  positionals: string[];
}

/** Parse the bundle subcommand flags from raw argv (after the `bundle` token). */
function parseBundleArgs(argv: string[]): { subcommand: string; opts: BundleOpts } {
  const opts: BundleOpts = { json: false, grants: [], context: [], positionals: [] };
  const subcommand = argv[0] ?? "";
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const next = (): string => {
      const v = rest[++i];
      if (v === undefined) throw new BundleCliError(`flag ${a} needs a value`, 2);
      return v;
    };
    if (a === "--url") opts.url = next();
    else if (a === "--key") opts.key = next();
    else if (a === "--json") opts.json = true;
    else if (a === "--agent") opts.agent = next();
    else if (a === "--name") opts.name = next();
    else if (a === "--trust-window") opts.trustWindow = next();
    else if (a === "--grant") opts.grants.push(next());
    else if (a === "--context") opts.context.push(next());
    else if (a.startsWith("-")) throw new BundleCliError(`unknown flag: ${a}`, 2);
    else opts.positionals.push(a);
  }
  return { subcommand, opts };
}

// ── gateway target + connection-key (same resolution as the parent CLI) ──────

function resolveBaseUrl(o: BundleOpts): string {
  const fromFlag = o.url ?? process.env.PLEXUS_URL;
  if (fromFlag && fromFlag.length > 0) return fromFlag.replace(/\/$/, "");
  const port = Number(process.env.PLEXUS_PORT) || DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

function connectionKeyPath(): string {
  const home = process.env.PLEXUS_HOME ?? join(homedir(), ".plexus");
  return join(home, "connection-key");
}

function resolveConnectionKey(o: BundleOpts): string {
  const fromFlag = o.key ?? process.env.PLEXUS_CONNECTION_KEY;
  if (fromFlag && fromFlag.length > 0) return fromFlag.trim();
  const path = connectionKeyPath();
  if (!existsSync(path)) {
    throw new BundleCliError(
      `no connection-key: not at ${path} and no --key / PLEXUS_CONNECTION_KEY.\n` +
        `  Start the gateway (\`bin/plexus\`) to generate it, or pass --key.`,
      3,
    );
  }
  const key = readFileSync(path, "utf-8").trim();
  if (!key) throw new BundleCliError(`connection-key file is empty: ${path}`, 3);
  return key;
}

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

function adminClient(o: BundleOpts): AdminClient {
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
        throw new BundleCliError(
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
        const msg = errObj?.error?.message ?? errObj?.reason ?? (typeof parsed === "string" ? parsed : `HTTP ${res.status}`);
        throw new BundleCliError(`${method} ${path} failed: ${msg} [HTTP ${res.status}]`, 5);
      }
      return parsed;
    },
  };
}

const out = (s = "") => process.stdout.write(s + "\n");
const emitJson = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");

// ── --grant spec parsing ──────────────────────────────────────────────────────

interface MemberSpec {
  id: string;
  verbs?: GrantVerb[];
  constraint?: ScopeConstraint;
}

/**
 * Parse one `--grant` spec: `<capId>:<verbs>[@<constraint>]` where `<constraint>` is one of
 *   pathPrefix:<field>=<prefix>[|<prefix>…]
 *   allow:<field>=<value>[|<value>…]
 */
function parseGrantSpec(spec: string): MemberSpec {
  const atIdx = spec.indexOf("@");
  const head = atIdx >= 0 ? spec.slice(0, atIdx) : spec;
  const constraintStr = atIdx >= 0 ? spec.slice(atIdx + 1) : "";
  const colon = head.indexOf(":");
  if (colon < 0) throw new BundleCliError(`--grant "${spec}" must be <capId>:<verbs>`, 2);
  const id = head.slice(0, colon).trim();
  const verbsStr = head.slice(colon + 1).trim();
  if (!id) throw new BundleCliError(`--grant "${spec}" has an empty capability id`, 2);
  const verbs = verbsStr
    ? (verbsStr.split(",").map((v) => v.trim()).filter(Boolean) as GrantVerb[])
    : undefined;
  const member: MemberSpec = { id, ...(verbs && verbs.length ? { verbs } : {}) };
  if (constraintStr) member.constraint = parseConstraint(constraintStr, spec);
  return member;
}

function parseConstraint(str: string, spec: string): ScopeConstraint {
  // form: <kind>:<field>=<v1>[|<v2>…]
  const kColon = str.indexOf(":");
  if (kColon < 0) throw new BundleCliError(`--grant "${spec}" constraint must be <kind>:<field>=<values>`, 2);
  const kind = str.slice(0, kColon).trim();
  const eq = str.indexOf("=", kColon);
  if (eq < 0) throw new BundleCliError(`--grant "${spec}" constraint must be <kind>:<field>=<values>`, 2);
  const field = str.slice(kColon + 1, eq).trim();
  const values = str.slice(eq + 1).split("|").map((v) => v.trim()).filter(Boolean);
  if (!field || values.length === 0) {
    throw new BundleCliError(`--grant "${spec}" constraint needs a field and at least one value`, 2);
  }
  if (kind === "pathPrefix") return { pathPrefix: { field, allow: values } };
  if (kind === "allow") return { allow: { field, values } };
  throw new BundleCliError(`--grant "${spec}" unknown constraint kind "${kind}" (use pathPrefix|allow)`, 2);
}

// ── subcommands ──────────────────────────────────────────────────────────────

async function cmdCreate(client: AdminClient, o: BundleOpts): Promise<void> {
  if (!o.agent) throw new BundleCliError("bundle create needs --agent <id>", 2);
  if (!o.name) throw new BundleCliError("bundle create needs --name <task>", 2);
  if (o.grants.length === 0) throw new BundleCliError("bundle create needs at least one --grant", 2);
  const grants = o.grants.map(parseGrantSpec);
  // Context: `@file` → inline blob; bare id → existing skill reference.
  const context = o.context.map((ref) => {
    if (ref.startsWith("@")) {
      const path = ref.slice(1);
      if (!existsSync(path)) throw new BundleCliError(`--context file not found: ${path}`, 2);
      const markdown = readFileSync(path, "utf-8");
      return { kind: "inline" as const, label: path.split("/").pop() ?? "Task context", markdown };
    }
    return { kind: "skill" as const, skillId: ref };
  });
  const body = {
    name: o.name,
    agentId: o.agent,
    grants,
    ...(o.trustWindow ? { trustWindow: { kind: o.trustWindow } } : {}),
    ...(context.length ? { context } : {}),
  };
  const view = (await client.request("POST", "/admin/api/bundles", body)) as BundleView;
  if (o.json) {
    emitJson(view);
    return;
  }
  out(`✓ created bundle ${view.bundleId} "${view.name}" → agent ${view.agentId}`);
  for (const m of view.members) {
    const cons = m.constraint?.pathPrefix
      ? `  ↳ only under ${m.constraint.pathPrefix.allow.join(", ")}`
      : m.constraint?.allow
        ? `  ↳ only ${m.constraint.allow.field} ∈ {${m.constraint.allow.values.join(", ")}}`
        : "";
    out(`    • ${m.capabilityId} [${m.verbs.join(",")}]${cons}`);
  }
  if (view.context.length) out(`    context: ${view.context.map((x) => x.id).join(", ")}`);
}

async function cmdList(client: AdminClient, o: BundleOpts): Promise<void> {
  const res = (await client.request("GET", "/admin/api/bundles")) as { bundles: BundleView[] };
  const bundles = res.bundles ?? [];
  if (o.json) {
    emitJson(res);
    return;
  }
  out(`${bundles.length} task bundle${bundles.length === 1 ? "" : "s"}:`);
  for (const b of bundles) {
    out(`  • ${b.bundleId} "${b.name}" → ${b.agentId} (${b.members.length} grant${b.members.length === 1 ? "" : "s"})`);
    for (const m of b.members) {
      const cons = m.constraint?.pathPrefix
        ? `  ↳ only under ${m.constraint.pathPrefix.allow.join(", ")}`
        : "";
      out(`      ${m.capabilityId} [${m.verbs.join(",")}]${cons}`);
    }
  }
  if (bundles.length === 0) out("  (none — `plexus bundle create …` to pre-authorize a task)");
}

async function cmdRevoke(client: AdminClient, o: BundleOpts): Promise<void> {
  const bundleId = o.positionals[0];
  if (!bundleId) throw new BundleCliError("bundle revoke needs a <bundleId>", 2);
  const res = (await client.request("POST", "/admin/api/revoke", { bundleId })) as {
    ok: boolean;
    revokedJtis: string[];
    grantRemoved: boolean;
  };
  if (o.json) {
    emitJson(res);
    return;
  }
  out(`✓ revoked bundle ${bundleId} (grants removed: ${res.grantRemoved}, tokens revoked: ${res.revokedJtis.length})`);
}

/** Entry point — dispatch a `bundle` subcommand from the raw argv (after the `bundle` token). */
export async function runBundle(argv: string[]): Promise<void> {
  const { subcommand, opts } = parseBundleArgs(argv);
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    out(BUNDLE_HELP);
    return;
  }
  const client = adminClient(opts);
  switch (subcommand) {
    case "create":
      await cmdCreate(client, opts);
      return;
    case "list":
      await cmdList(client, opts);
      return;
    case "revoke":
      await cmdRevoke(client, opts);
      return;
    default:
      throw new BundleCliError(`unknown bundle subcommand "${subcommand}" — try \`plexus bundle help\``, 2);
  }
}

const BUNDLE_HELP = `plexus bundle — Mode-2 pre-authorized task bundles (named grants + constraints + context)

Usage:
  plexus bundle create --agent <id> --name <task> --grant <spec> [--grant <spec> …]
                       [--trust-window <once|1h|1d|7d|until-revoked>] [--context <ref> …]
  plexus bundle list
  plexus bundle revoke <bundleId>

--grant spec:
  <capId>:<verbs>[@<constraint>]
    verbs       comma list (read,write,execute)
    constraint  pathPrefix:<field>=<prefix>[|<prefix>…]   confine a path field under prefixes
                allow:<field>=<value>[|<value>…]           exact-match an id field
  e.g.  --grant obsidian-rest.vault.write:write@pathPrefix:path=Inbox/

--context ref:
  <skillId>     reference an existing kind:"skill" entry
  @<file.md>    materialize an inline markdown blob as task context (capped 64 KiB)

A bundle = N grants + their constraints + context, grouped under one bundleId and approved
once. One create authorizes the whole task; revoke drops every member + its tokens at once.`;
