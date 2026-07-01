/**
 * G3-VERIFY — the deterministic build-time skill↔Floor verifier (Inv VI enforcer).
 *
 * SSOT: docs/design/agent-skill-compile-domain-model.md §4 ("skill↔Floor equivalence …
 *       verifiable: the hardened .well-known is the ORACLE — a build-time check asserts a
 *       generated skill uses the sanctioned flow, reads the local PAT (never bakes it), and
 *       references only caps the integration actually granted"), Inv II + Inv VI, §9 Q#5.
 *
 * WHAT THIS IS — a pure, deterministic function (NO LLM, no network, no clock) that takes a
 * G1-rendered plugin (`RenderedPlugin`, files in memory) + the Floor `.well-known` document
 * (the ORACLE) and ASSERTS four independent axes of NON-over-reach, returning a structured
 * pass/fail verdict + reasons. It is the gate that lets D1-ENDPOINT / tests REFUSE to serve a
 * plugin that could reach beyond the Floor.
 *
 * THE FOUR AXES (each maps to an oracle check against the Floor / the committed core):
 *
 *   1. SANCTIONED AUTH CORE (Inv VI) — `bin/plexus` is BYTE-IDENTICAL to the committed
 *      sanctioned engine (`tools/plexus-cli/plexus`). The auth/invoke plumbing was NOT
 *      hand/LLM-authored or altered. Oracle: the committed engine bytes (sha-256).
 *
 *   2. NO BAKED SECRET (Inv III) — no distributed file contains a durable PAT (`plx_agent_…`),
 *      a baked one-time enrollment code (`plx_enroll_…`), or any caller-supplied durable
 *      credential (e.g. the admin connection-key). The one-time code may ride the install
 *      COMMAND (per G1), but must never be persisted into a distributed file.
 *
 *   3. ONLY ADVERTISED / GRANTED CAPS (Inv II) — every capability the SKILL.md / plugin.json
 *      references is present in the Floor's advertised catalog (and, when given, within the
 *      cap-set the plugin was compiled for). A skill can NEVER reference a cap the Floor does
 *      not advertise. Oracle: `floor.capabilities[].id`.
 *
 *   4. SANCTIONED FLOW — the enroll/handshake/invoke the plugin INSTRUCTS matches the Floor's
 *      `auth.enrollment` / `requestShapes`: the installer redeems the one-time code → PAT at
 *      the Floor-advertised enrollment endpoint via the sanctioned engine, pinned to THIS
 *      Floor's gateway; and NO instruction file improvises an auth path (reads an on-disk admin
 *      connection-key, or forges a token). Handshake/invoke themselves live in the byte-verified
 *      engine (axis 1), which reads every route from the same Floor oracle.
 */

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import type { WellKnownDocument } from "@plexus/protocol";
import type { RenderedPlugin, RenderedFile } from "./render-plugin.ts";

// The committed sanctioned engine SSOT — the SAME path render-plugin.ts copies verbatim into
// the artifact's `bin/plexus`. Resolved relative to this module (same dir as render-plugin.ts).
const ENGINE_SOURCE = fileURLToPath(new URL("../../../../tools/plexus-cli/plexus", import.meta.url));

/** The tier-3 auth core inside every artifact — owned/verified by axis 1 (the oracle itself). */
const AUTH_CORE_PATH = "bin/plexus";

// ── Public API ───────────────────────────────────────────────────────────────────────

/** Tuning + oracle inputs for the verifier (all optional; defaults enforce the base contract). */
export interface VerifyPluginOptions {
  /** Override the committed engine path (tests only). Defaults to `tools/plexus-cli/plexus`. */
  enginePath?: string;
  /**
   * The cap-set the plugin was compiled FOR (the granted ids). When provided, axis 3 also
   * asserts every referenced cap is within this set — not merely advertised. (A cap can be
   * advertised by the Floor yet not granted to THIS agent; referencing it would over-reach.)
   */
  expectedCapabilityIds?: string[];
  /**
   * Extra literal secrets that must NEVER appear in ANY distributed file (axis 2). Pass the
   * admin connection-key, a known durable PAT, etc. Matched as exact substrings.
   */
  forbiddenSecrets?: string[];
}

/** One axis's outcome — a structured, deterministic assertion result. */
export interface AxisResult {
  /** Axis number 1–4 (stable across runs). */
  axis: 1 | 2 | 3 | 4;
  /** Short axis name. */
  name: string;
  /** Passed? */
  ok: boolean;
  /** Failure reasons (empty when `ok`). One entry per distinct violation. */
  reasons: string[];
  /** The oracle checks performed (evidence trail — present whether pass or fail). */
  checked: string[];
}

/** The full verdict — the four axes + a flattened pass/fail + all reasons. */
export interface VerdictResult {
  /** True iff EVERY axis passed. */
  ok: boolean;
  /** Per-axis results, in axis order. */
  axes: AxisResult[];
  /** All failure reasons across axes, flattened (empty when `ok`). */
  reasons: string[];
}

/**
 * Verify a rendered plugin against the Floor oracle. Pure, deterministic, offline. Returns a
 * structured verdict; NEVER throws for a policy violation (that is data, in `reasons`). It only
 * throws if the committed engine SSOT itself is unreadable (an environment/build error).
 */
export function verifyPlugin(
  rendered: RenderedPlugin,
  floor: WellKnownDocument,
  options: VerifyPluginOptions = {},
): VerdictResult {
  const axes: AxisResult[] = [
    verifySanctionedCore(rendered, options),
    verifyNoBakedSecret(rendered, options),
    verifyOnlyAdvertisedCaps(rendered, floor, options),
    verifySanctionedFlow(rendered, floor),
  ];
  const reasons = axes.flatMap((a) => a.reasons);
  return { ok: axes.every((a) => a.ok), axes, reasons };
}

/**
 * The build-time GATE: render + verify in one call. Returns the rendered plugin ONLY if it
 * passes every axis; otherwise throws a `PluginVerificationError` carrying the full verdict, so
 * D1-ENDPOINT / tests can refuse to serve an over-reaching artifact. `rendered` is provided by
 * the caller (already produced by `renderPlugin`), keeping this module free of the renderer's
 * inputs while still offering a single guarded handoff.
 */
export function assertVerified(
  rendered: RenderedPlugin,
  floor: WellKnownDocument,
  options: VerifyPluginOptions = {},
): RenderedPlugin {
  const verdict = verifyPlugin(rendered, floor, options);
  if (!verdict.ok) throw new PluginVerificationError(verdict);
  return rendered;
}

/** Thrown by `assertVerified` when an artifact fails verification — carries the structured verdict. */
export class PluginVerificationError extends Error {
  readonly verdict: VerdictResult;
  constructor(verdict: VerdictResult) {
    const failed = verdict.axes.filter((a) => !a.ok).map((a) => `#${a.axis} ${a.name}`);
    super(
      `plugin failed skill↔Floor verification on axis/axes ${failed.join(", ")}: ` +
        verdict.reasons.join("; "),
    );
    this.name = "PluginVerificationError";
    this.verdict = verdict;
  }
}

// ── Axis 1: sanctioned auth core (Inv VI) ──────────────────────────────────────────────

function verifySanctionedCore(rendered: RenderedPlugin, options: VerifyPluginOptions): AxisResult {
  const checked: string[] = [];
  const reasons: string[] = [];

  const bin = fileAt(rendered, AUTH_CORE_PATH);
  if (!bin) {
    return {
      axis: 1,
      name: "sanctioned-auth-core",
      ok: false,
      reasons: [`the artifact has no \`${AUTH_CORE_PATH}\` — the sanctioned auth core is missing`],
      checked,
    };
  }

  const enginePath = options.enginePath ?? ENGINE_SOURCE;
  const engine = readFileSync(enginePath, "utf8"); // build/env error if unreadable — intentional throw
  const wantHash = sha256(engine);
  const gotHash = sha256(bin.content);
  checked.push(
    `\`${AUTH_CORE_PATH}\` sha-256 == committed engine (${enginePath}) sha-256 ` +
      `[oracle ${wantHash.slice(0, 12)}…]`,
  );
  if (gotHash !== wantHash) {
    reasons.push(
      `\`${AUTH_CORE_PATH}\` is NOT byte-identical to the committed sanctioned engine ` +
        `(got sha-256 ${gotHash.slice(0, 12)}…, want ${wantHash.slice(0, 12)}…) — the auth/invoke ` +
        `core was altered or re-authored (Inv VI).`,
    );
  }

  checked.push(`\`${AUTH_CORE_PATH}\` mode has the executable bit`);
  if ((bin.mode & 0o111) === 0) {
    reasons.push(`\`${AUTH_CORE_PATH}\` is not executable (mode ${bin.mode.toString(8)}).`);
  }

  return { axis: 1, name: "sanctioned-auth-core", ok: reasons.length === 0, reasons, checked };
}

// ── Axis 2: no baked secret (Inv III) ───────────────────────────────────────────────────

// A DURABLE credential = the prefix + a substantial random body. The bare PREFIX strings
// (`plx_agent_`, `plx_enroll_`) legitimately appear as greppable markers in the engine/prose;
// only a prefix followed by a real base64url body (≥16 chars) is an actual baked secret.
const BAKED_PAT = /plx_agent_[A-Za-z0-9_-]{16,}/;
const BAKED_ENROLL_CODE = /plx_enroll_[A-Za-z0-9_-]{16,}/;

function verifyNoBakedSecret(rendered: RenderedPlugin, options: VerifyPluginOptions): AxisResult {
  const checked: string[] = [
    "no distributed file matches a durable PAT `plx_agent_<body>`",
    "no distributed file matches a baked one-time code `plx_enroll_<body>`",
  ];
  const forbidden = (options.forbiddenSecrets ?? []).filter((s) => typeof s === "string" && s.length > 0);
  if (forbidden.length) checked.push(`no distributed file contains any of ${forbidden.length} caller-supplied secret(s)`);
  const reasons: string[] = [];

  for (const f of rendered.files) {
    const pat = f.content.match(BAKED_PAT);
    if (pat) reasons.push(`\`${f.path}\` bakes a durable PAT (matched \`${redact(pat[0])}\`) — Inv III.`);
    const code = f.content.match(BAKED_ENROLL_CODE);
    if (code) reasons.push(`\`${f.path}\` bakes a one-time enrollment code (matched \`${redact(code[0])}\`) — it must ride the install command, not a file.`);
    for (const secret of forbidden) {
      if (f.content.includes(secret)) {
        reasons.push(`\`${f.path}\` contains a caller-supplied durable secret (matched \`${redact(secret)}\`).`);
      }
    }
  }

  return { axis: 2, name: "no-baked-secret", ok: reasons.length === 0, reasons, checked };
}

// ── Axis 3: only advertised / granted caps (Inv II) ─────────────────────────────────────

// The tier-2 granted-cap bullets the SKILL prints, e.g. `- \`workspace.read\` — Vault (read)`.
// These are the caps the skill TELLS the agent it may call — the authoritative reference surface.
const SKILL_CAP_BULLET = /^- `([A-Za-z0-9][\w.-]*)` — /gm;

function verifyOnlyAdvertisedCaps(
  rendered: RenderedPlugin,
  floor: WellKnownDocument,
  options: VerifyPluginOptions,
): AxisResult {
  const advertised = new Set((floor.capabilities ?? []).map((c) => c.id));
  const granted = options.expectedCapabilityIds ? new Set(options.expectedCapabilityIds) : null;
  const checked: string[] = [
    `every SKILL/plugin-referenced cap ∈ Floor catalog (${advertised.size} advertised)`,
  ];
  if (granted) checked.push(`every referenced cap ∈ compiled cap-set (${granted.size} granted)`);
  const reasons: string[] = [];

  const referenced = referencedCaps(rendered);
  checked.push(`referenced caps: {${[...referenced].join(", ") || "∅"}}`);

  for (const id of referenced) {
    if (!advertised.has(id)) {
      reasons.push(
        `the plugin references capability \`${id}\` which the Floor does NOT advertise ` +
          `(over-reach beyond the Floor — Inv II).`,
      );
    } else if (granted && !granted.has(id)) {
      reasons.push(
        `the plugin references capability \`${id}\` which is advertised but NOT in the cap-set ` +
          `this plugin was compiled for (over-reach beyond the grant — Inv II).`,
      );
    }
  }

  return { axis: 3, name: "only-advertised-caps", ok: reasons.length === 0, reasons, checked };
}

/** Collect the capability ids the artifact references, from the SKILL bullets + plugin.json list. */
function referencedCaps(rendered: RenderedPlugin): Set<string> {
  const ids = new Set<string>();

  const skill = fileAt(rendered, `skills/use-plexus/SKILL.md`);
  if (skill) {
    for (const m of skill.content.matchAll(SKILL_CAP_BULLET)) ids.add(m[1]!);
  }

  // plugin.json description embeds the granted-cap id list ("…on PATH: a, b. Use when…").
  const plugin = fileAt(rendered, ".claude-plugin/plugin.json");
  if (plugin) {
    try {
      const doc = JSON.parse(plugin.content) as { description?: string };
      const desc = doc.description ?? "";
      const seg = desc.match(/on PATH:\s*(.+?)\.\s*Use when/);
      if (seg) {
        for (const raw of seg[1]!.split(",")) {
          const id = raw.trim();
          if (id && /^[A-Za-z0-9][\w.-]*$/.test(id)) ids.add(id);
        }
      }
    } catch {
      /* a malformed plugin.json is a structural fault other axes/tests catch; ignore here. */
    }
  }

  return ids;
}

// ── Axis 4: sanctioned flow (matches Floor auth.enrollment / requestShapes) ──────────────

// Improvised / forbidden auth instructions that must NOT appear in any INSTRUCTION file (every
// distributed file EXCEPT the byte-verified engine, which axis 1 owns and which legitimately
// mentions the admin connection-key in NEGATED prose). The sanctioned agent flow is: redeem a
// one-time code → durable PAT, then present the PAT as Bearer. Any of these signals a divergence.
const FORBIDDEN_FLOW: { pattern: RegExp; why: string }[] = [
  { pattern: /connection-?key/i, why: "instructs handling the admin connection-key (the agent's flow is PAT-only, Inv III)" },
  { pattern: /admin[-_ ]?key/i, why: "instructs handling an admin key" },
  { pattern: /\bforge\b[^.\n]*\btoken\b/i, why: "instructs forging a token" },
  { pattern: /\bmint\b[^.\n]*\b(bearer\s+)?token\b/i, why: "instructs minting a token locally" },
];

function verifySanctionedFlow(rendered: RenderedPlugin, floor: WellKnownDocument): AxisResult {
  const checked: string[] = [];
  const reasons: string[] = [];

  // Oracle: the Floor's enrollment advertisement + gateway.
  const enrollUrl = floor.auth?.enrollment?.url ?? floor.auth?.enrollmentUrl ?? "";
  const gatewayUrl = (floor.gateway?.baseUrl ?? "").replace(/\/+$/, "");
  checked.push(
    `Floor advertises enrollment (${enrollUrl || "MISSING"}) redeeming code→PAT; gateway ${gatewayUrl || "MISSING"}`,
  );
  if (!enrollUrl) {
    reasons.push("the Floor advertises no enrollment endpoint — cannot assert a sanctioned enroll flow.");
  }

  // The installer must drive the SANCTIONED enroll: code (via env, not baked) redeemed through the
  // byte-verified engine's `enroll` verb, pinned to THIS Floor's gateway.
  const install = fileAt(rendered, "install.sh");
  if (!install) {
    reasons.push("the artifact has no `install.sh` — the sanctioned enroll flow is absent.");
  } else {
    const sh = install.content;
    checked.push("install.sh: code via $PLEXUS_ENROLL_CODE (never baked)");
    if (!sh.includes("PLEXUS_ENROLL_CODE")) {
      reasons.push("install.sh does not take the one-time code via $PLEXUS_ENROLL_CODE — non-sanctioned enrollment.");
    }
    checked.push("install.sh: redeems via the sanctioned engine `bin/plexus enroll`");
    if (!(sh.includes("bin/plexus") && /\benroll\b/.test(sh))) {
      reasons.push("install.sh does not redeem the code via the sanctioned engine (`bin/plexus enroll`).");
    }
    checked.push("install.sh: pins the gateway to the Floor's gateway.baseUrl");
    if (gatewayUrl && !sh.includes(gatewayUrl)) {
      reasons.push(`install.sh does not pin the gateway to the Floor's advertised gateway (${gatewayUrl}).`);
    }
  }

  // No instruction file may improvise an auth path (the engine, axis 1's oracle, is excluded).
  checked.push("no instruction file improvises an auth path (admin-key read / token forge)");
  for (const f of rendered.files) {
    if (f.path === AUTH_CORE_PATH) continue; // byte-verified in axis 1; owns its own (negated) prose
    for (const { pattern, why } of FORBIDDEN_FLOW) {
      if (pattern.test(f.content)) {
        reasons.push(`\`${f.path}\` ${why} (non-sanctioned flow).`);
      }
    }
  }

  return { axis: 4, name: "sanctioned-flow", ok: reasons.length === 0, reasons, checked };
}

// ── small helpers ───────────────────────────────────────────────────────────────────────

function fileAt(rendered: RenderedPlugin, path: string): RenderedFile | undefined {
  return rendered.files.find((f) => f.path === path);
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Redact a matched secret to a short, non-leaking fingerprint for the reason string. */
function redact(s: string): string {
  if (s.length <= 12) return `${s.slice(0, 4)}…`;
  return `${s.slice(0, 10)}…(${s.length} chars)`;
}
