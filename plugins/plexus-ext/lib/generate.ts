/**
 * plexus-ext — the meta-skill's generator + pre-register validator.
 *
 * This is the small, standalone library the `create-extension` skill invokes to
 * turn an interview answer set (a `CapabilitySpec`) into a SPEC-COMPLIANT
 * `ExtensionManifest`, and to PRE-VALIDATE it (the EXTENSION-SPEC §13 conformance
 * checklist + the secure-default discipline) BEFORE anything is `POST`ed to the
 * gateway.
 *
 * Why a standalone lib (M4-PLAN T-A): the meta-skill plugin exercises the gateway
 * ONLY over the published wire. It does NOT import gateway internals
 * (`capability-registry`, `extension.ts`). Instead it mirrors the published rules:
 *
 *   - The structural §8/§13 rules a well-formed manifest must satisfy (so what the
 *     skill emits PASSES the gateway's `validateRegistration` — which runs
 *     `validateManifest` + `validateWorkflowGraph`).
 *   - The SECURE-DEFAULT discipline the EXTENSION-SPEC mandates and the gateway's
 *     transport-policy seam (`isBinaryAllowed` / `isAllowedHost`) HARD-enforces at
 *     dispatch: read-only minimal verbs, slug-validated source, NO absolute/shell
 *     cli bins, loopback-only rest hosts, secret REFERENCES never values.
 *
 * The skill's body relies on `generateManifest` + `validateExtension` to keep its
 * output honest: it never registers a manifest `validateExtension` flags.
 *
 * The type shapes mirror `src/protocol/types.ts` §1b (frozen). We re-declare the
 * minimal subset here so the plugin has ZERO dependency on gateway source — the
 * shapes are byte-aligned with the contract the gateway re-validates.
 */

// ── Minimal mirror of the frozen protocol shapes (§1, §1b) ────────────────────

export type GrantVerb = "read" | "write" | "execute";
export type EntryKind = "capability" | "skill" | "workflow";
/** Authorable transports — the manifest type `Exclude`s "mcp". */
export type AuthorTransport = "local-rest" | "stdio" | "ipc" | "cli" | "skill" | "workflow";

export interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, unknown>;
  items?: unknown;
  required?: string[];
  enum?: unknown[];
  description?: string;
  [k: string]: unknown;
}
export type JsonSchema = boolean | JsonSchemaObject;

export interface IoSchema {
  input?: JsonSchema;
  output?: JsonSchema;
}
export interface SkillBody {
  format: "markdown" | "ref";
  markdown?: string;
  ref?: string;
}
export interface WorkflowMember {
  id: string;
  verbs: GrantVerb[];
}
export interface ExtensionSecretRef {
  name: string;
  attach: "bearer" | "header" | "query" | "env";
  as?: string;
}
export interface ExtensionCapabilityDecl {
  name: string;
  kind: EntryKind;
  label: string;
  describe: string;
  io?: IoSchema;
  grants: GrantVerb[];
  transport: AuthorTransport;
  members?: WorkflowMember[];
  body?: SkillBody;
  route?: Record<string, unknown>;
}
export interface LocalServiceHint {
  app: string;
  defaultPort?: number;
  socketName?: string;
}
export interface ExtensionManifest {
  manifest: "plexus-extension/0.1";
  source: string;
  label: string;
  transport: AuthorTransport;
  capabilities: ExtensionCapabilityDecl[];
  secrets?: ExtensionSecretRef[];
  serviceHint?: LocalServiceHint;
}

// ── The interview answer-set the skill collects (§3 of META-SKILL-DESIGN) ─────

/** One action the user wants to expose. */
export interface ActionSpec {
  /** `<noun>.<verb>` suffix, e.g. "vault.read". */
  name: string;
  label: string;
  /** Agent-facing "Action outcome. Use when X." describe. First line is the teaser. */
  describe: string;
  /** MINIMUM verbs this action needs. Default ["read"]. */
  grants?: GrantVerb[];
  /** Input fields (JSON Schema property map). */
  inputProperties?: Record<string, JsonSchemaObject>;
  /** Which input fields are required. */
  requiredInputs?: string[];
  /** local-rest routing. */
  rest?: { method?: string; pathTemplate: string; secret?: string };
  /** cli routing. `bin` is a BARE command name; absolute/shell bins are refused. */
  cli?: { bin: string; args?: string[]; secret?: string };
  /** If set, scaffold a usage skill and attach it to this action. Default true. */
  attachUsageSkill?: boolean;
  /** The usage-skill markdown body (filled from the template). */
  usageSkillMarkdown?: string;
}

export interface CapabilitySpec {
  /** Raw app/source name; slugged into a valid SourceId. */
  sourceName: string;
  label: string;
  transport: AuthorTransport;
  actions: ActionSpec[];
  /** Secret references the transport needs (names + attach mode; NEVER values). */
  secrets?: ExtensionSecretRef[];
  serviceHint?: LocalServiceHint;
}

// ── Slug + secure-default helpers (mirror the gateway's enforced floors) ──────

/** Slugify a source name into a valid lower-kebab/dot SourceId (ID-DERIVATION RULE). */
export function slugifySource(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A SourceId is valid iff it slugs to itself (lower-kebab/dot, no leading/trailing dash). */
export function isValidSourceId(source: string): boolean {
  return source.length > 0 && /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(source) && slugifySource(source.replace(/\./g, "-")) === source.replace(/\./g, "-");
}

/** A capability decl name must be a non-empty `<noun>.<verb>` lower-kebab/dot slug. */
export function isValidDeclName(name: string): boolean {
  return /^[a-z0-9]+(?:[-.][a-z0-9]+)+$/.test(name);
}

/**
 * Shell interpreters / script runtimes that can execute an arbitrary arg string —
 * NEVER a safe cli bin to scaffold. Byte-aligned with the gateway's
 * `transport-policy.ts` SHELL_INTERPRETERS hard-deny set.
 */
const SHELL_INTERPRETERS = new Set<string>([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "ash",
  "pwsh", "powershell", "cmd", "command",
  "python", "python2", "python3", "perl", "ruby", "node", "deno", "bun",
  "php", "lua", "tclsh", "osascript",
  "env", "xargs", "nice", "nohup", "timeout", "stdbuf", "setsid", "eval", "exec",
]);
const SHELL_METACHAR = /[;&|`$(){}<>\n\r\t*?!\\"'\s]/;

function bareName(bin: string): string {
  const lastSlash = Math.max(bin.lastIndexOf("/"), bin.lastIndexOf("\\"));
  const base = lastSlash >= 0 ? bin.slice(lastSlash + 1) : bin;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

export type CliBinIssue =
  | "empty"
  | "absolute_path"
  | "path_separator"
  | "shell_interpreter"
  | "shell_metacharacter";

/**
 * The SECURE cli-bin check the meta-skill REFUSES to scaffold past. Mirrors the
 * gateway's `isBinaryAllowed` hard-deny floor: an absolute path, a relative path
 * (any separator), a shell/interpreter, or a name with shell metacharacters is
 * refused — the generated manifest never names one. Returns the issue, or null if
 * the bin is a structurally-safe bare command name.
 */
export function checkCliBin(bin: unknown): CliBinIssue | null {
  if (typeof bin !== "string" || bin.trim().length === 0) return "empty";
  const raw = bin.trim();
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) return "absolute_path";
  if (raw.includes("/") || raw.includes("\\")) return "path_separator";
  if (SHELL_METACHAR.test(raw)) return "shell_metacharacter";
  if (SHELL_INTERPRETERS.has(bareName(raw))) return "shell_interpreter";
  return null;
}

/** Loopback-only host check (mirrors the gateway's local-rest egress floor). */
export function isLoopbackUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const h = url.hostname.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]" || h === "0:0:0:0:0:0:0:1") return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const oct = m.slice(1).map((n) => Number(n));
    if (oct.every((n) => n >= 0 && n <= 255) && oct[0] === 127) return true;
  }
  return false;
}

/** A secret ref `name` is safe iff plain (no path traversal). Mirrors `isSafeSecretName`. */
export function isSafeSecretName(name: unknown): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name.includes("\0")) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.includes("..")) return false;
  if (name.startsWith(".") || /^[a-zA-Z]:/.test(name)) return false;
  return true;
}

// ── The generator ─────────────────────────────────────────────────────────────

/**
 * Build a spec-compliant `ExtensionManifest` from an interview `CapabilitySpec`.
 *
 * SECURE DEFAULTS enforced by construction:
 *  - `source` is slug-validated (throws on an invalid id).
 *  - verbs default to `["read"]` (minimal, read-only) when an action omits them.
 *  - a cli bin that fails `checkCliBin` (absolute / shell / metachar / separator)
 *    THROWS — the generator never emits an over-privileged cli bin.
 *  - a local-rest route whose `pathTemplate` smuggles a non-loopback absolute URL
 *    is refused; rest hosts stay loopback (the transport pins loopback at dispatch).
 *  - secrets are emitted as REFERENCES only; no value ever enters the manifest.
 *  - a usage skill is scaffolded per action by default and back-linked via
 *    `route.attachSkills`.
 */
export function generateManifest(spec: CapabilitySpec): ExtensionManifest {
  const source = slugifySource(spec.sourceName);
  if (!isValidSourceId(source)) {
    throw new Error(`cannot derive a valid SourceId from "${spec.sourceName}"`);
  }

  const capabilities: ExtensionCapabilityDecl[] = [];
  const secrets: ExtensionSecretRef[] = [...(spec.secrets ?? [])];

  for (const action of spec.actions) {
    if (!isValidDeclName(action.name)) {
      throw new Error(`action name "${action.name}" must be a <noun>.<verb> lower-kebab/dot slug`);
    }
    // SECURE DEFAULT: minimal verbs, read-only.
    const grants: GrantVerb[] = action.grants && action.grants.length > 0 ? [...action.grants] : ["read"];

    const decl: ExtensionCapabilityDecl = {
      name: action.name,
      kind: "capability",
      label: action.label,
      describe: action.describe,
      grants,
      transport: spec.transport,
    };

    // I/O schema (JSON Schema 2020-12 object).
    if (action.inputProperties && Object.keys(action.inputProperties).length > 0) {
      const input: JsonSchemaObject = { type: "object", properties: action.inputProperties };
      if (action.requiredInputs && action.requiredInputs.length > 0) {
        input.required = action.requiredInputs;
      }
      decl.io = { input };
    }

    // Transport route + secure-default refusals.
    const route: Record<string, unknown> = {};
    if (spec.transport === "cli") {
      if (!action.cli) throw new Error(`action "${action.name}" uses cli transport but has no cli route`);
      const issue = checkCliBin(action.cli.bin);
      if (issue) {
        throw new Error(
          `refusing to scaffold cli bin "${action.cli.bin}" for action "${action.name}": ${issue} (secure default: bare, non-shell command names only)`,
        );
      }
      route.bin = action.cli.bin;
      if (action.cli.args) route.args = action.cli.args;
      // user-confirmed allow-list pinning the exact bin (surfaced at register-confirm).
      route.allowedBins = [action.cli.bin];
      if (action.cli.secret) {
        if (!secrets.some((s) => s.name === action.cli!.secret)) {
          throw new Error(`cli action "${action.name}" references secret "${action.cli.secret}" not declared in secrets[]`);
        }
        route.secret = action.cli.secret;
      }
    } else if (spec.transport === "local-rest") {
      if (!action.rest) throw new Error(`action "${action.name}" uses local-rest transport but has no rest route`);
      // If the pathTemplate is a full URL it MUST be loopback (secure egress floor).
      if (/^[a-z]+:\/\//i.test(action.rest.pathTemplate) && !isLoopbackUrl(action.rest.pathTemplate)) {
        throw new Error(
          `refusing to scaffold a non-loopback rest URL "${action.rest.pathTemplate}" for action "${action.name}" (secure default: loopback-only)`,
        );
      }
      route.method = action.rest.method ?? "GET";
      route.pathTemplate = action.rest.pathTemplate;
      if (action.rest.secret) {
        if (!secrets.some((s) => s.name === action.rest!.secret)) {
          throw new Error(`rest action "${action.name}" references secret "${action.rest.secret}" not declared in secrets[]`);
        }
        route.secret = action.rest.secret;
      }
    }

    // Bundled usage skill (default ON) — declare a kind:"skill" entry + attach it.
    const wantsSkill = action.attachUsageSkill !== false;
    if (wantsSkill) {
      const skillName = `${action.name}.how-to-use`;
      const skillMarkdown =
        action.usageSkillMarkdown ?? defaultUsageSkillMarkdown(source, action);
      capabilities.push({
        name: skillName,
        kind: "skill",
        label: `How to use ${action.label}`,
        describe: `Usage guidance for ${source}.${action.name}: ${firstLine(action.describe)}`,
        grants: [],
        transport: "skill",
        body: { format: "markdown", markdown: skillMarkdown },
      });
      route.attachSkills = [skillName];
    }

    if (Object.keys(route).length > 0) decl.route = route;
    capabilities.push(decl);
  }

  const manifest: ExtensionManifest = {
    manifest: "plexus-extension/0.1",
    source,
    label: spec.label,
    transport: spec.transport,
    capabilities,
  };
  if (secrets.length > 0) manifest.secrets = secrets;
  if (spec.serviceHint) manifest.serviceHint = spec.serviceHint;
  return manifest;
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? s).trim();
}

/** A usage-skill body mirroring the shipped how-to-cite-vault structure. */
export function defaultUsageSkillMarkdown(source: string, action: ActionSpec): string {
  const id = `${source}.${action.name}`;
  const verbs = (action.grants && action.grants.length > 0 ? action.grants : ["read"]).join(", ");
  const fields = Object.keys(action.inputProperties ?? {});
  const callShape = fields.length > 0 ? `\`{ ${fields.join(", ")} }\`` : "no input";
  return `# How to use ${action.label} (\`${id}\`)

## Calling it
Invoke \`${id}\` with ${callShape}. Requires the verb(s): **${verbs}**.

## Discovery-first workflow
- Check the manifest entry for \`${id}\` before calling; read its \`io.input\` schema.
- Prefer the narrowest call that answers the task; do not over-fetch.

## Using it well
- ${firstLine(action.describe)}

## What you CANNOT do
- This capability is granted per the verb(s) above ONLY; it cannot exceed them.
- It is confined to the local ${action.label} surface — it cannot reach other apps or the network beyond its declared transport.
`;
}

// ── The pre-register validator (EXTENSION-SPEC §13 conformance checklist) ──────

export interface ValidationResult {
  ok: boolean;
  /** Spec-rule violations (empty ⇒ spec-compliant). */
  errors: string[];
  /** Secure-default advisories that did not block but should be surfaced. */
  warnings: string[];
}

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SKILL_BODY_BYTES = 64 * 1024;
const MAX_MANIFEST_CAPABILITIES = 256;
const AUTHOR_TRANSPORTS = new Set<AuthorTransport>([
  "local-rest", "stdio", "ipc", "cli", "skill", "workflow",
]);

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Validate a manifest against the EXTENSION-SPEC §13 conformance checklist + §8
 * gateway rules + the secure-default discipline. A manifest that passes (ok:true)
 * is structurally what the gateway's `validateRegistration` accepts; the skill
 * REFUSES to register anything with `errors`.
 *
 * Mirrors: `validateManifest` (shape/size/secret-name) + the §8 structural rules
 * (skill/workflow shape, route.secret/attachSkills resolution, JSON-Schema input)
 * + `validateWorkflowGraph` (present members, verbs ⊆ member grants, anti-cycle).
 */
export function validateExtension(manifest: ExtensionManifest): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. manifest literal.
  if (manifest?.manifest !== "plexus-extension/0.1") {
    errors.push(`manifest must be the literal "plexus-extension/0.1"`);
  }
  // 2. source + label.
  if (!manifest?.source) errors.push("source is required");
  else if (!isValidSourceId(manifest.source)) errors.push(`source "${manifest.source}" is not a valid lower-kebab/dot SourceId`);
  if (!manifest?.label) errors.push("label is required");

  // Stop if structurally broken (mirrors gateway short-circuit).
  if (errors.length > 0) return { ok: false, errors, warnings };

  // size limits.
  let serialized = "";
  try {
    serialized = JSON.stringify(manifest);
  } catch {
    errors.push("manifest is not JSON-serializable");
    return { ok: false, errors, warnings };
  }
  if (byteLen(serialized) > MAX_MANIFEST_BYTES) {
    errors.push(`manifest too large (${byteLen(serialized)} > ${MAX_MANIFEST_BYTES})`);
  }

  // 3. transport ≠ mcp, in the authorable set.
  if (!AUTHOR_TRANSPORTS.has(manifest.transport)) {
    errors.push(`manifest transport "${manifest.transport}" is not an authorable transport (never "mcp")`);
  }

  // 4. ≥1 capability.
  const caps = manifest.capabilities ?? [];
  if (caps.length === 0) errors.push("manifest must declare at least one capability");
  if (caps.length > MAX_MANIFEST_CAPABILITIES) {
    errors.push(`too many capabilities (${caps.length} > ${MAX_MANIFEST_CAPABILITIES})`);
  }

  // secret refs declared in secrets[] must be safe names.
  const declaredSecrets = new Set<string>();
  for (const ref of manifest.secrets ?? []) {
    if (!isSafeSecretName(ref.name)) {
      errors.push(`secret ref "${ref.name}" is unsafe (path traversal / not a plain name)`);
    }
    declaredSecrets.add(ref.name);
  }

  // Per-decl checks.
  const declNames = new Set<string>();
  const skillNames = new Set<string>();
  // First pass: collect names + ids for resolution.
  const declIds = new Map<string, ExtensionCapabilityDecl>();
  for (const decl of caps) {
    if (decl.kind === "skill") skillNames.add(decl.name);
    declIds.set(`${manifest.source}.${decl.name}`, decl);
  }

  for (const decl of caps) {
    const where = `capability "${decl.name}"`;
    // 5. unique, non-empty <noun>.<verb> name.
    if (!decl.name) errors.push(`${where}: name is required`);
    else if (!isValidDeclName(decl.name)) errors.push(`${where}: name must be a <noun>.<verb> slug`);
    if (declNames.has(decl.name)) errors.push(`${where}: duplicate name (collides on the same id)`);
    declNames.add(decl.name);

    if (!decl.label) errors.push(`${where}: label is required`);
    if (!decl.describe) errors.push(`${where}: describe is required (the agent-relevance signal)`);
    if (decl.describe && decl.describe.length > 0) {
      const first = firstLine(decl.describe);
      if (!/[.!?]$/.test(first)) {
        warnings.push(`${where}: the first line of describe should be a complete sentence (it becomes the .well-known teaser)`);
      }
    }
    if (!Array.isArray(decl.grants)) errors.push(`${where}: grants[] is required`);

    // per-decl transport.
    const t = decl.transport ?? manifest.transport;
    if (!AUTHOR_TRANSPORTS.has(t)) errors.push(`${where}: transport "${t}" is not authorable (never "mcp")`);

    // 6. skill shape.
    if (decl.kind === "skill") {
      if (!decl.body) errors.push(`${where}: kind:"skill" requires body`);
      if (decl.body) {
        if (decl.body.format === "markdown" && typeof decl.body.markdown === "string" && byteLen(decl.body.markdown) > MAX_SKILL_BODY_BYTES) {
          errors.push(`${where}: skill body.markdown too large (${byteLen(decl.body.markdown)} > ${MAX_SKILL_BODY_BYTES})`);
        }
      }
      if ((decl.grants ?? []).length !== 0) errors.push(`${where}: kind:"skill" must have grants:[]`);
      if (decl.transport !== "skill") errors.push(`${where}: kind:"skill" must have transport:"skill"`);
      if (decl.io) errors.push(`${where}: kind:"skill" must not carry io`);
      if (decl.members) errors.push(`${where}: kind:"skill" must not carry members`);
    }

    // 7. workflow shape.
    if (decl.kind === "workflow") {
      if (!decl.members || decl.members.length === 0) {
        errors.push(`${where}: kind:"workflow" requires a non-empty members[]`);
      }
      for (const m of decl.members ?? []) {
        const target = declIds.get(m.id);
        // member may also resolve to a pre-existing (foreign) entry not in this manifest;
        // the validator can only assert same-manifest resolution. Foreign members are a
        // cross-source concern the gateway gates — warn, don't fail.
        if (!target) {
          warnings.push(`${where}: member "${m.id}" is not declared in THIS manifest; it must already be a present registry entry at register time`);
          continue;
        }
        const memberGrants = new Set(target.grants ?? []);
        for (const v of m.verbs) {
          if (!memberGrants.has(v)) {
            errors.push(`${where}: member "${m.id}" verb "${v}" is not a subset of that member's grants (${[...memberGrants].join(",")})`);
          }
        }
      }
    }

    // 8. capability shape — minimal verbs + JSON-Schema input.
    if (decl.kind === "capability") {
      if (!decl.grants || decl.grants.length === 0) {
        errors.push(`${where}: a capability must declare its minimum verb set`);
      }
      for (const v of decl.grants ?? []) {
        if (v !== "read" && v !== "write" && v !== "execute") errors.push(`${where}: invalid verb "${v}"`);
      }
      if (decl.io?.input !== undefined && !isValidJsonSchema(decl.io.input)) {
        errors.push(`${where}: io.input is not a valid JSON Schema object`);
      }
      // Secure-default advisory: declaring write/execute is louder than read-only.
      if ((decl.grants ?? []).includes("write") || (decl.grants ?? []).includes("execute")) {
        warnings.push(`${where}: declares ${decl.grants?.join("+")} — confirm this is the MINIMUM; the user sees these verbs at the grant prompt`);
      }
    }

    // 9. route.secret resolution.
    const route = decl.route as Record<string, unknown> | undefined;
    const routeSecret = route?.["secret"];
    if (typeof routeSecret === "string" && !declaredSecrets.has(routeSecret)) {
      errors.push(`${where}: route.secret "${routeSecret}" is not declared in secrets[]`);
    }
    // SECURE: cli bin hard-deny floor.
    if (t === "cli") {
      const bin = route?.["bin"];
      const issue = checkCliBin(bin);
      if (issue) errors.push(`${where}: cli bin "${String(bin)}" is unsafe (${issue}) — the gateway transport will hard-deny it`);
    }
    // SECURE: local-rest full-URL pathTemplate must be loopback.
    if (t === "local-rest") {
      const pt = route?.["pathTemplate"];
      if (typeof pt === "string" && /^[a-z]+:\/\//i.test(pt) && !isLoopbackUrl(pt)) {
        errors.push(`${where}: local-rest pathTemplate "${pt}" is a non-loopback URL — the gateway egress policy will deny it`);
      }
    }

    // 10. route.attachSkills resolution.
    const attach = route?.["attachSkills"];
    if (Array.isArray(attach)) {
      for (const s of attach) {
        if (typeof s !== "string" || !skillNames.has(s)) {
          errors.push(`${where}: route.attachSkills entry "${String(s)}" does not name a kind:"skill" declaration in this manifest`);
        }
      }
    }
  }

  // Anti-cycle over same-manifest workflow members (mirrors validateWorkflowGraph).
  const cycleReason = detectWorkflowCycle(manifest);
  if (cycleReason) errors.push(cycleReason);

  return { ok: errors.length === 0, errors, warnings };
}

function isValidJsonSchema(schema: JsonSchema): boolean {
  if (typeof schema === "boolean") return true;
  if (typeof schema !== "object" || schema === null) return false;
  // A minimal sanity check: it must be a plain object; if it has `type` it must be a string,
  // and `properties` (if present) must be an object. JSON Schema 2020-12 keywords pass through.
  if ("type" in schema && typeof schema.type !== "string" && !Array.isArray(schema.type)) return false;
  if ("properties" in schema && (typeof schema.properties !== "object" || schema.properties === null)) return false;
  if ("required" in schema && !Array.isArray(schema.required)) return false;
  return true;
}

function detectWorkflowCycle(manifest: ExtensionManifest): string | null {
  const idOf = (name: string) => `${manifest.source}.${name}`;
  const wf = new Map<string, string[]>();
  for (const d of manifest.capabilities) {
    if (d.kind === "workflow") {
      wf.set(idOf(d.name), (d.members ?? []).map((m) => m.id));
    }
  }
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  let cycle: string | null = null;
  const dfs = (id: string, path: string[]): void => {
    color.set(id, GREY);
    for (const next of wf.get(id) ?? []) {
      if (!wf.has(next)) continue; // edges only into present workflow nodes
      const c = color.get(next) ?? WHITE;
      if (c === GREY) {
        const idx = path.indexOf(next);
        const loop = (idx >= 0 ? path.slice(idx) : path).concat(next);
        cycle = `workflow cycle detected: ${loop.join(" → ")}`;
      } else if (c === WHITE) {
        dfs(next, [...path, next]);
      }
    }
    color.set(id, BLACK);
  };
  for (const id of wf.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE) dfs(id, [id]);
  }
  return cycle;
}
