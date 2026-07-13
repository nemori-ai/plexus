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
 * (the ORACLE) and ASSERTS five independent axes of NON-over-reach, returning a structured
 * pass/fail verdict + reasons. It is the gate that lets D1-ENDPOINT / tests REFUSE to serve a
 * plugin that could reach beyond the Floor.
 *
 * THE AXES (each maps to an oracle check against the Floor / the committed core):
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
 *
 *   5. PROSE INTEGRITY (Inv VI) — the hand-authored [P] SKILL body is HASH-PINNED: the source
 *      prose must hash to the pinned oracle (any edit forces a deliberate re-review + re-pin) AND
 *      the rendered SKILL.md carries that exact prose verbatim. This closes the paraphrase gap in
 *      the axis-2/4 prose denylists structurally. Oracle: `SKILL_BODY_SHA256_PIN`.
 */

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import type { WellKnownDocument } from "@plexus/protocol";
import type { RenderedPlugin, RenderedFile } from "./render-plugin.ts";
import { stripOneTrailingNewline } from "./shell-util.ts";
import {
  BAKED_PAT,
  BAKED_ENROLL_CODE,
  BAKED_CONNECTION_KEY,
  ENGINE_SHA256_PIN,
} from "./secret-denylist.ts";

// The committed sanctioned engine SSOT — the SAME path render-plugin.ts copies verbatim into
// the artifact's `bin/plexus`. Resolved relative to this module (same dir as render-plugin.ts).
const ENGINE_SOURCE = fileURLToPath(new URL("../../../../tools/plexus-cli/plexus", import.meta.url));

// The hand-authored [P] prose body of the SKILL — the SAME source render-plugin.ts embeds
// (comment-stripped) into `skills/use-plexus/SKILL.md`. Its hash is PINNED below (axis 5) so
// any prose edit forces deliberate re-review + re-pin.
const SKILL_BODY_SOURCE = fileURLToPath(new URL("./templates/skill-body.md", import.meta.url));

/** The tier-3 auth core inside every artifact — owned/verified by axis 1 (the oracle itself). */
const AUTH_CORE_PATH = "bin/plexus";

/** The rendered tier-1/2 SKILL — its prose region is hash-pinned by axis 5. */
const SKILL_PATH = "skills/use-plexus/SKILL.md";

// ── SOURCE HASH PINS (F4 prose / F6 engine) ──────────────────────────────────────────
// The ENGINE source pin now lives in `secret-denylist.ts` (shared with the generic verifier,
// so both paths assert the SAME sanctioned engine). The SKILL-BODY pin stays local (CC-only).
// Recompute the skill-body pin (after stripping its leading HTML comment, exactly as
// render-plugin embeds it — see STRIP_LEADING_COMMENT) with:
//   node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(P)).digest("hex"))'
const SKILL_BODY_SHA256_PIN = "de76d2948a6c560e168e3eeba9839bb341eb5c32f76674d39e3ca394cacc5fb5";

/** The leading-comment strip render-plugin.ts applies before embedding the [P] body. */
const STRIP_LEADING_COMMENT = /^<!--[\s\S]*?-->\n*/;

// ── Public API ───────────────────────────────────────────────────────────────────────

/** Tuning + oracle inputs for the verifier (all optional; defaults enforce the base contract). */
export interface VerifyPluginOptions {
  /** Override the committed engine path (tests only). Defaults to `tools/plexus-cli/plexus`. */
  enginePath?: string;
  /** Override the [P] skill-body source path (tests only). Defaults to `templates/skill-body.md`. */
  skillBodyPath?: string;
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
  /** Axis number 1–5 (stable across runs). */
  axis: 1 | 2 | 3 | 4 | 5;
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
    verifySanctionedFlow(rendered, floor, options),
    verifyProseIntegrity(rendered, options),
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

  // F6 — pin the engine SOURCE bytes too, so a source-level tamper (an un-reviewed edit to the
  // sanctioned engine itself, which axis 1's byte-compare would otherwise silently bless as the
  // new "oracle") is caught, not just a rendered↔source divergence.
  checked.push(`committed engine source sha-256 == pinned oracle [${ENGINE_SHA256_PIN.slice(0, 12)}…]`);
  if (wantHash !== ENGINE_SHA256_PIN) {
    reasons.push(
      `the committed sanctioned engine source (${enginePath}) sha-256 ${wantHash.slice(0, 12)}… does ` +
        `NOT match the pinned oracle ${ENGINE_SHA256_PIN.slice(0, 12)}… — the engine changed without a ` +
        `re-pin (deliberate review required; update ENGINE_SHA256_PIN).`,
    );
  }

  checked.push(`\`${AUTH_CORE_PATH}\` mode has the executable bit`);
  if ((bin.mode & 0o111) === 0) {
    reasons.push(`\`${AUTH_CORE_PATH}\` is not executable (mode ${bin.mode.toString(8)}).`);
  }

  return { axis: 1, name: "sanctioned-auth-core", ok: reasons.length === 0, reasons, checked };
}

// ── Axis 2: no baked secret (Inv III) ───────────────────────────────────────────────────

// The structural secret patterns (`BAKED_PAT` / `BAKED_ENROLL_CODE` / `BAKED_CONNECTION_KEY`) live
// in the shared `secret-denylist.ts`, so this CC verifier and the generic verifier enforce the
// SAME denylist (no asymmetry). See that module for the "prefix + substantial body" rationale.

function verifyNoBakedSecret(rendered: RenderedPlugin, options: VerifyPluginOptions): AxisResult {
  const checked: string[] = [
    "no distributed file matches a durable PAT `plx_agent_<body>`",
    "no distributed file matches a baked one-time code `plx_enroll_<body>`",
    "no distributed file matches an admin connection-key `plx_live_<hex>`",
  ];
  const forbidden = (options.forbiddenSecrets ?? []).filter((s) => typeof s === "string" && s.length > 0);
  if (forbidden.length) checked.push(`no distributed file contains any of ${forbidden.length} caller-supplied secret(s)`);
  const reasons: string[] = [];

  for (const f of rendered.files) {
    const pat = f.content.match(BAKED_PAT);
    if (pat) reasons.push(`\`${f.path}\` bakes a durable PAT (matched \`${redact(pat[0])}\`) — Inv III.`);
    const code = f.content.match(BAKED_ENROLL_CODE);
    if (code) reasons.push(`\`${f.path}\` bakes a one-time enrollment code (matched \`${redact(code[0])}\`) — it must ride the install command, not a file.`);
    const key = f.content.match(BAKED_CONNECTION_KEY);
    if (key) reasons.push(`\`${f.path}\` bakes an admin connection-key (matched \`${redact(key[0])}\`) — the agent flow is PAT-only, never the admin key (Inv III).`);
    for (const secret of forbidden) {
      if (f.content.includes(secret)) {
        reasons.push(`\`${f.path}\` contains a caller-supplied durable secret (matched \`${redact(secret)}\`).`);
      }
    }
  }

  return { axis: 2, name: "no-baked-secret", ok: reasons.length === 0, reasons, checked };
}

// ── Axis 3: only advertised / granted caps (Inv II) ─────────────────────────────────────

// EVERY backtick-wrapped cap-shaped id anywhere in an instruction file — not just the tier-2
// bullets. A cap id is a dotted, LETTER-leading token (`source.capability[.sub]`); requiring a
// dot + letter lead is what separates a real cap from prose (`--json`, `127.0.0.1`) so an inline
// over-reach like `sys.rootExec` slipped into the prose is caught, while numeric/IP tokens are not.
// (Documented trade-off, F2: the SKILL prose must not backtick a dotted non-cap token like
// `error.code`; if it does, that is a false positive the author fixes by de-backticking — the
// rendered skill should not backtick bare cap-like ids it does not mean as caps.)
const CAP_TOKEN = /`([A-Za-z][\w-]*(?:\.[\w-]+)+)`/g;

function verifyOnlyAdvertisedCaps(
  rendered: RenderedPlugin,
  floor: WellKnownDocument,
  options: VerifyPluginOptions,
): AxisResult {
  const advertised = new Set((floor.capabilities ?? []).map((c) => c.id));
  const granted = options.expectedCapabilityIds ? new Set(options.expectedCapabilityIds) : null;
  const checked: string[] = [
    `the compiled cap-set (expectedCapabilityIds) is provided (fail-closed if absent)`,
    `every SKILL/plugin-referenced cap ∈ Floor catalog (${advertised.size} advertised)`,
  ];
  if (granted) checked.push(`every referenced cap ∈ compiled cap-set (${granted.size} granted)`);
  const reasons: string[] = [];

  // F3 — FAIL CLOSED. Without the compiled cap-set the "over-reach-beyond-grant" half of this
  // axis cannot be checked; verifying anyway would silently pass a plugin that references an
  // advertised-but-NOT-granted cap. Refuse instead of degrading to advertised-only.
  if (!granted) {
    reasons.push(
      `no compiled cap-set was provided (options.expectedCapabilityIds absent) — the ` +
        `over-reach-beyond-grant check is undefined, so verification FAILS closed (Inv II). ` +
        `Pass the granted capability ids.`,
    );
  }

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

/**
 * Collect the capability ids the artifact references. F2: scans EVERY backtick-wrapped cap-shaped
 * token across the instruction surface (SKILL.md prose + bullets AND plugin.json), not just the
 * tier-2 bullets — so an un-advertised cap slipped inline into the prose is caught — plus the
 * plugin.json description's bare comma-separated cap list (which is not backticked).
 */
function referencedCaps(rendered: RenderedPlugin): Set<string> {
  const ids = new Set<string>();
  const scanBackticks = (content: string) => {
    for (const m of content.matchAll(CAP_TOKEN)) ids.add(m[1]!);
  };

  const skill = fileAt(rendered, SKILL_PATH);
  if (skill) scanBackticks(skill.content);

  // plugin.json description embeds the granted-cap id list ("…on PATH: a, b. Use when…").
  const plugin = fileAt(rendered, ".claude-plugin/plugin.json");
  if (plugin) {
    scanBackticks(plugin.content);
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

function verifySanctionedFlow(
  rendered: RenderedPlugin,
  floor: WellKnownDocument,
  options: VerifyPluginOptions,
): AxisResult {
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
  // install.sh is now a SELF-CONTAINED bootstrap that INLINES the byte-verified engine verbatim
  // (a quoted heredoc) so `curl … | bash` can reconstruct `bin/plexus`. That inlined engine
  // legitimately NEGATES the admin connection-key in its own prose (axis 1 owns it), so we remove
  // that verified engine region from install.sh before flow-scanning the installer's OWN
  // instructions — otherwise the engine's negated prose would false-trip the denylist. A tamper
  // that adds an improvised auth path OUTSIDE the engine region is still caught (it is not part of
  // the byte-verified engine substring, so it survives the removal).
  // The strip needle is the COMMITTED engine oracle (the SAME bytes axis 1 pins + render-plugin
  // inlines) — NOT the rendered `bin/plexus` file, which a tamper may have mutated (that tamper is
  // axis 1's to catch; here we must still excise the pristine engine region install.sh actually
  // inlined, else a bin tamper would spuriously trip THIS axis on the engine's legitimate prose).
  let engineBody: string | null = null;
  try {
    engineBody = stripOneTrailingNewline(readFileSync(options.enginePath ?? ENGINE_SOURCE, "utf8"));
  } catch {
    engineBody = null; // build/env error; axis 1 reports the unreadable engine — don't strip here.
  }
  checked.push("no instruction file improvises an auth path (admin-key read / token forge)");
  if (engineBody) checked.push("install.sh: the inlined byte-verified engine region is excluded from the flow scan");
  for (const f of rendered.files) {
    if (f.path === AUTH_CORE_PATH) continue; // byte-verified in axis 1; owns its own (negated) prose
    let content = f.content;
    if (f.path === "install.sh" && engineBody) {
      // Excise the verbatim inlined engine (axis 1's oracle) so only the installer's own text is scanned.
      content = content.split(engineBody).join("\n");
    }
    for (const { pattern, why } of FORBIDDEN_FLOW) {
      if (pattern.test(content)) {
        reasons.push(`\`${f.path}\` ${why} (non-sanctioned flow).`);
      }
    }
  }

  return { axis: 4, name: "sanctioned-flow", ok: reasons.length === 0, reasons, checked };
}

// ── Axis 5: prose integrity (F4 — hash-pin the hand-authored [P] SKILL body) ─────────────

/**
 * The SKILL body is a single hand-authored, byte-stable [P] file (`templates/skill-body.md`).
 * axes 2/4 scan its prose with denylists that a paraphrase can dodge; this axis closes that gap
 * STRUCTURALLY: it pins the known-good sha-256 of the body (comment-stripped, exactly as
 * render-plugin embeds it) and asserts (a) the SOURCE still hashes to the pin — so ANY prose edit
 * forces a deliberate re-review + re-pin — and (b) the RENDERED SKILL.md actually carries that
 * exact pinned prose verbatim (no substitution between source and artifact).
 */
function verifyProseIntegrity(rendered: RenderedPlugin, options: VerifyPluginOptions): AxisResult {
  const checked: string[] = [];
  const reasons: string[] = [];

  const skillBodyPath = options.skillBodyPath ?? SKILL_BODY_SOURCE;
  const rawBody = readFileSync(skillBodyPath, "utf8"); // build/env error if unreadable — intentional throw
  // The SAME transform render-plugin.ts applies before embedding the body (strip leading comment).
  const embeddedBody = rawBody.replace(STRIP_LEADING_COMMENT, "");
  const bodyHash = sha256(embeddedBody);

  // (a) the source prose is the reviewed, pinned prose — ANY edit changes the hash and FAILS
  //     this axis until a deliberate re-review + re-pin (that is the forcing function).
  checked.push(`SKILL body (${skillBodyPath}) sha-256 == pinned oracle [${SKILL_BODY_SHA256_PIN.slice(0, 12)}…]`);
  if (bodyHash !== SKILL_BODY_SHA256_PIN) {
    reasons.push(
      `the hand-authored SKILL prose (${skillBodyPath}) sha-256 ${bodyHash.slice(0, 12)}… does NOT ` +
        `match the pinned oracle ${SKILL_BODY_SHA256_PIN.slice(0, 12)}… — the prose changed without a ` +
        `re-pin. Re-review the change, then update SKILL_BODY_SHA256_PIN.`,
    );
  }

  // (b) the rendered artifact carries EXACTLY that prose (source→artifact fidelity).
  const skill = fileAt(rendered, SKILL_PATH);
  checked.push(`rendered \`${SKILL_PATH}\` carries the pinned SKILL prose verbatim`);
  if (!skill) {
    reasons.push(`the artifact has no \`${SKILL_PATH}\` — the pinned SKILL prose cannot be verified.`);
  } else if (!skill.content.includes(embeddedBody)) {
    reasons.push(
      `the rendered \`${SKILL_PATH}\` does NOT contain the pinned SKILL prose verbatim — the ` +
        `artifact's prose region diverges from the reviewed [P] body (F4).`,
    );
  }

  return { axis: 5, name: "prose-integrity", ok: reasons.length === 0, reasons, checked };
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
