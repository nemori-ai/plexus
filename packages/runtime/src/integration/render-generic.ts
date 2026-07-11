/**
 * G1-GENERIC — the deterministic renderer for the PORTABLE ("generic") agent integration.
 *
 * SSOT: docs/design/agent-skill-compile-domain-model.md §5 (deliver·P), ADR-8; and
 *       integrations/generic/ (the static instruction SSOT + repo-mode setup).
 *
 * WHAT THIS IS — the generic counterpart to `render-plugin.ts`. Where Claude Code gets a
 * bespoke COMPILED plugin, any OTHER agent gets a PORTABLE delivery: a self-contained
 * `setup.sh` (materializes the sanctioned engine + this agent's launcher INSIDE the state
 * home, lands a filled-in Plexus block at the project's `./AGENTS.md`) plus the instruction
 * TEXT itself (copy-able, to paste straight into an agent). Both are pure functions of
 * (agentId, gatewayBaseUrl, plexusHome) + the committed sources.
 *
 * PROJECT SCOPING (docs/design/agent-integration-project-scope.md §4) — every per-agent
 * injection lands in the PROJECT the setup command is pasted in; `$PLEXUS_HOME` is the only
 * home-dir write. The launcher lives at `$PLEXUS_HOME/agents/<agentId>/bin/plexus` — identity
 * carried by the PATH SEGMENT (agents/<agentId>/bin/), the structural close of the Bug B
 * shadowing class for this delivery: no global `plexus` name exists to shadow or be shadowed
 * by, and two agents on one machine can never collide. The instruction teaches that ABSOLUTE
 * launcher path via the `{{PLEXUS_CMD}}` token (codex sets a per-call `workdir`, so a
 * project-relative command would be fragile — the absolute path is the robust form).
 *
 * INV III / secret hygiene — NO secret is ever written into a served file. The served
 * `setup.sh` is CODE-FREE and KEY-FREE: it never carries the one-time enrollment code, the
 * durable PAT, or the admin connection-key. The one-time code is delivered SEPARATELY, only
 * in the mgmt-gated JSON response (`enrollCode`), exactly like the CC install command. After
 * setup the agent runs `<abs-launcher> enroll <code>` once, out of band.
 *
 * INV VI (sanctioned auth core) — the engine `setup.sh` materializes is the committed
 * `tools/plexus-cli/plexus` copied BYTE-FOR-BYTE (the SAME engine `render-plugin.ts` bundles,
 * verified byte-identical by `verify-plugin.ts`). Nothing here is model-authored.
 */

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import {
  shSingleQuote,
  stripSlash,
  requireNonEmpty,
  stripOneTrailingNewline,
  assertSafeAgentId,
  assertNoHeredocCollision,
} from "./shell-util.ts";
import { assertNoSecretsIn, assertEngineSourceSanctioned } from "./secret-denylist.ts";

// The committed sanctioned engine SSOT — the SAME path render-plugin.ts copies verbatim into
// the CC artifact's `bin/plexus`. Materialized (byte-identical) by the generic setup.sh too.
const ENGINE_SOURCE = fileURLToPath(new URL("../../../../tools/plexus-cli/plexus", import.meta.url));
// The static, agent-agnostic instruction block — the SSOT the console serves as copy-able
// text AND lands on disk via setup.sh. Carries a `{{PLEXUS_CONSOLE_URL}}` placeholder.
const AGENTS_MD_SOURCE = fileURLToPath(
  new URL("../../../../integrations/generic/AGENTS.plexus.md", import.meta.url),
);

/** The token in the static AGENTS.plexus.md the endpoint fills with the real console URL. */
const CONSOLE_URL_TOKEN = "{{PLEXUS_CONSOLE_URL}}";
/**
 * The token in the static AGENTS.plexus.md that stands for the ABSOLUTE per-agent launcher
 * command. Filled two ways, deliberately: the served instruction TEXT is filled SERVER-side
 * from the gateway's resolved home (sound: gateway and agent share the machine — loopback),
 * while setup.sh carries the token into its embedded block and fills it at RUN time from its
 * own `$PLEXUS_HOME` (respecting an install-time override).
 */
const PLEXUS_CMD_TOKEN = "{{PLEXUS_CMD}}";
/** A fixed, collision-proof heredoc terminator for the inlined engine (deterministic). */
const ENGINE_DELIM = "PLEXUS_EOF_ENGINE";
/** A fixed, collision-proof heredoc terminator for the inlined instruction (deterministic). */
const AGENTS_DELIM = "PLEXUS_EOF_AGENTS_MD";
/** A fixed, collision-proof heredoc terminator for the inlined launcher (deterministic). */
const LAUNCHER_DELIM = "PLEXUS_EOF_LAUNCHER";

export interface RenderGenericInput {
  /** The agent this integration is delivered for (the enrollment/PAT identity). */
  agentId: string;
  /**
   * The gateway's canonical base URL (from the Floor: `floor.gateway.baseUrl`). May be undefined
   * when the Floor is missing it — this is the SINGLE normalization point: a missing/empty base
   * throws here (⇒ the endpoint 500s) rather than silently emitting a host-less `curl`.
   */
  gatewayBaseUrl: string | undefined;
  /**
   * The gateway's resolved Plexus state home (absolute, e.g. `~/.plexus` expanded). An EXPLICIT
   * renderer input (like `compileStamp` on the CC side) so rendering stays a pure function —
   * tests inject a fixed one. Fills `{{PLEXUS_CMD}}` in the SERVED instruction text with
   * `<plexusHome>/agents/<agentId>/bin/plexus`; the caller (D1-ENDPOINT) passes its own
   * resolved home, sound because gateway and agent share the machine (loopback).
   */
  plexusHome: string;
  /** Override the engine source path (tests only). Defaults to `tools/plexus-cli/plexus`. */
  enginePath?: string;
  /** Override the AGENTS.plexus.md source path (tests only). */
  agentsMdPath?: string;
}

/** The portable delivery — the served setup.sh + the copy-able instruction text. */
export interface RenderedGeneric {
  /** The self-contained, CODE-FREE bootstrap served at `/integration/:agentId/setup.sh`. */
  setupSh: string;
  /** The filled-in AGENTS.plexus.md instruction TEXT (console URL + launcher path substituted). */
  instruction: string;
  /** The copy-able one-command SETUP string (code-free). */
  setupCommand: string;
  /**
   * The ABSOLUTE per-agent launcher path the instruction teaches
   * (`<plexusHome>/agents/<agentId>/bin/plexus`) — the one command the agent types. Exposed so
   * the endpoint can spell the out-of-band enroll as `<launcherPath> enroll <code>`.
   */
  launcherPath: string;
}

/** The per-agent launcher's absolute path inside the state home. Identity rides the PATH
 *  SEGMENT (`agents/<agentId>/bin/`) exactly as the CC plugin carries it in the launcher NAME
 *  (`plexus-<agentId>`) — collision-proof, and never on the shell PATH. */
function launcherPathFor(plexusHome: string, agentId: string): string {
  return `${stripSlash(plexusHome)}/agents/${agentId}/bin/plexus`;
}

/**
 * Fill the static instruction block for serving as copy-able TEXT: the console URL
 * (`<gatewayBaseUrl>/admin`) + `{{PLEXUS_CMD}}` → the ABSOLUTE per-agent launcher path.
 * Pure w.r.t. its explicit inputs (the launcher path is derived from the injected home —
 * determinism like `compileStamp`). The SSOT block file stays agent-agnostic; the FILLED
 * instruction is per-agent (it is already served per-agent under `/integration/:agentId`).
 */
export function renderGenericInstruction(
  gatewayBaseUrl: string,
  launcherPath: string,
  agentsMdPath?: string,
): string {
  const base = stripSlash(requireNonEmpty(gatewayBaseUrl, "gatewayBaseUrl"));
  const cmd = requireNonEmpty(launcherPath, "launcherPath");
  return instructionTemplate(base, agentsMdPath).split(PLEXUS_CMD_TOKEN).join(cmd);
}

/** The console-URL-filled instruction that still CARRIES `{{PLEXUS_CMD}}` — what setup.sh
 *  embeds (it fills the token at run time from its own `$PLEXUS_HOME`). */
function instructionTemplate(base: string, agentsMdPath?: string): string {
  const raw = readFileSync(agentsMdPath ?? AGENTS_MD_SOURCE, "utf8");
  return raw.split(CONSOLE_URL_TOKEN).join(`${base}/admin`);
}

/** The per-agent launcher — lives at `$PLEXUS_HOME/agents/<agentId>/bin/plexus` (NOT on the
 *  shell PATH); execs the sanctioned engine as this agent. */
function renderLauncher(agentId: string): string {
  return [
    "#!/usr/bin/env bash",
    `# Plexus launcher for agent '${agentId}' — execs the sanctioned engine under node/bun.`,
    "# Secret-free: no PAT, no code, no connection-key. The engine resolves the gateway from the",
    "# pin file ($PLEXUS_HOME/gateway) written at setup, and this agent's PAT from PLEXUS_AGENT_ID.",
    "set -euo pipefail",
    `export PLEXUS_AGENT_ID=${shSingleQuote(agentId)}`,
    'PLEXUS_HOME="${PLEXUS_HOME:-$HOME/.plexus}"',
    'ENGINE="$PLEXUS_HOME/bin/plexus"',
    'if [ ! -f "$ENGINE" ]; then',
    '  echo "plexus: engine not found at $ENGINE — re-run the Plexus setup command." >&2',
    "  exit 127",
    "fi",
    'if command -v node >/dev/null 2>&1; then exec node "$ENGINE" "$@"',
    'elif command -v bun >/dev/null 2>&1; then exec bun "$ENGINE" "$@"',
    'else echo "plexus: neither '+"'node'"+' nor '+"'bun'"+' is on PATH — install one to run the Plexus CLI." >&2; exit 127',
    "fi",
    "",
  ].join("\n");
}

/**
 * Render the self-contained generic setup.sh. Piped as `curl -fsSL <gw>/integration/<agent>/
 * setup.sh | bash` with NO surrounding directory, IN the project the agent runs from ($PWD at
 * paste time IS the project context — agent-integration-project-scope §2). It:
 *   1. materializes the sanctioned engine (byte-identical) at `$PLEXUS_HOME/bin/plexus`,
 *   2. installs this agent's launcher at `$PLEXUS_HOME/agents/<agentId>/bin/plexus` — inside
 *      the state home, NOT on the shell PATH, identity carried by the path itself,
 *   3. pins the gateway (`$PLEXUS_HOME/gateway`),
 *   4. lands the instruction block at `$PWD/AGENTS.md` (marker-guarded; `AGENTS_FILE=`
 *      override kept), filling `{{PLEXUS_CMD}}` at RUN time from its own `$PLEXUS_HOME`, then
 *   5. tells the operator to run `<abs-launcher> enroll <code>` with the code from the console.
 *
 * CODE-FREE + KEY-FREE (Inv III): no one-time code, no PAT, no connection-key is ever written.
 */
function renderSetupSh(
  agentId: string,
  gatewayBaseUrl: string,
  engine: string,
  instruction: string,
): string {
  const L: string[] = [];
  const engineBody = stripOneTrailingNewline(engine);
  const agentsBody = stripOneTrailingNewline(instruction);
  const launcherBody = stripOneTrailingNewline(renderLauncher(agentId));

  // Deterministic guard: an inlined file must never contain a line equal to its heredoc terminator.
  assertNoHeredocCollision(engineBody, ENGINE_DELIM, "engine");
  assertNoHeredocCollision(agentsBody, AGENTS_DELIM, "instruction");
  assertNoHeredocCollision(launcherBody, LAUNCHER_DELIM, "launcher");

  L.push(
    "#!/usr/bin/env bash",
    `# Plexus generic-agent setup — compiled for agent '${agentId}'.`,
    "#",
    "# SELF-CONTAINED bootstrap — safe under:  curl -fsSL <gateway>/integration/<agentId>/setup.sh | bash",
    "# with NO surrounding directory. Paste it in the PROJECT you run your agent from: it",
    "# materializes the sanctioned engine + this agent's launcher INSIDE the state home",
    "# ($PLEXUS_HOME — the only home-directory write), pins the gateway, and lands the instruction",
    "# block at ./AGENTS.md in the current directory, where your agent discovers it by itself.",
    "# CODE-FREE + KEY-FREE (Inv III): no one-time code, no PAT, no connection-key is ever written",
    "# here. After setup, ask your administrator for a one-time code and run the launcher this",
    "# script prints:  <launcher> enroll <code>",
    "set -euo pipefail",
    "",
    `AGENT_ID=${shSingleQuote(agentId)}`,
    // Bind the baked default to a SINGLE-QUOTED var (inert — no command-substitution), then use it
    // as the `${PLEXUS_GATEWAY:-…}` default: a gatewayBaseUrl with shell metacharacters cannot inject.
    `PLEXUS_GATEWAY_DEFAULT=${shSingleQuote(gatewayBaseUrl)}`,
    'PLEXUS_GATEWAY="${PLEXUS_GATEWAY:-$PLEXUS_GATEWAY_DEFAULT}"',
    'PLEXUS_HOME="${PLEXUS_HOME:-$HOME/.plexus}"',
    "# The instruction lands in THIS project — the directory the command was pasted in. The",
    "# AGENTS_FILE= override is kept for agents that read a different file.",
    'AGENTS_FILE="${AGENTS_FILE:-$PWD/AGENTS.md}"',
    'ENGINE="$PLEXUS_HOME/bin/plexus"',
    "# This agent's launcher — inside the state home, NOT on the shell PATH. Identity is carried",
    "# by the path segment (agents/$AGENT_ID/bin/): two agents can never collide and no global",
    "# 'plexus' name exists to shadow or be shadowed by (the same class the CC plugin's",
    "# per-agent launcher NAME closes).",
    'LAUNCHER="$PLEXUS_HOME/agents/$AGENT_ID/bin/plexus"',
    "",
    'if [ "$PWD" = "$HOME" ]; then',
    '  echo "plexus setup: WARNING — you are running this from your HOME directory, so the instruction block will land at $HOME/AGENTS.md (visible to every agent session started there)." >&2',
    '  echo "plexus setup: WARNING — cd into the project you run your agent in, then re-run this command there. Proceeding anyway (not fatal)." >&2',
    "fi",
    "",
    'mkdir -p "$PLEXUS_HOME/bin" "$PLEXUS_HOME/agents" "$(dirname "$LAUNCHER")" "$(dirname "$AGENTS_FILE")"',
    'chmod 700 "$PLEXUS_HOME" 2>/dev/null || true',
    "",
    "# 1. Materialize the sanctioned engine (byte-identical to the committed CLI).",
    `cat > "$ENGINE" <<'${ENGINE_DELIM}'`,
    engineBody,
    ENGINE_DELIM,
    'chmod 755 "$ENGINE"',
    "",
    "# 2. Install this agent's launcher (bound to this agent; execs the engine).",
    `cat > "$LAUNCHER" <<'${LAUNCHER_DELIM}'`,
    launcherBody,
    LAUNCHER_DELIM,
    'chmod 755 "$LAUNCHER"',
    `echo "==> installed this agent's launcher at $LAUNCHER"`,
    "",
    "# 3. Pin the gateway for the CLI engine so capability calls reach the right port.",
    `printf '%s\\n' "$PLEXUS_GATEWAY" > "$PLEXUS_HOME/gateway"`,
    "",
    "# 4. Land the instruction block at $AGENTS_FILE (marker-guarded, idempotent). {{PLEXUS_CMD}}",
    "#    is filled at RUN time from THIS machine's $PLEXUS_HOME, so the block teaches the",
    "#    absolute launcher path that actually exists here.",
    'touch "$AGENTS_FILE"',
    `BLOCK_TMP="$(mktemp)"`,
    `cat > "$BLOCK_TMP" <<'${AGENTS_DELIM}'`,
    agentsBody,
    AGENTS_DELIM,
    'BLOCK_FILLED="$(mktemp)"',
    'sed "s#{{PLEXUS_CMD}}#$LAUNCHER#g" "$BLOCK_TMP" > "$BLOCK_FILLED"',
    'if grep -q "<!-- BEGIN PLEXUS -->" "$AGENTS_FILE"; then',
    '  TMP="$(mktemp)"',
    "  awk '",
    "    /<!-- BEGIN PLEXUS -->/ {skip=1; while ((getline line < BLOCK) > 0) print line; next}",
    "    /<!-- END PLEXUS -->/   {skip=0; next}",
    "    skip!=1 {print}",
    '  \' BLOCK="$BLOCK_FILLED" "$AGENTS_FILE" > "$TMP"',
    '  mv "$TMP" "$AGENTS_FILE"',
    '  echo "==> refreshed the Plexus block in $AGENTS_FILE"',
    "else",
    "  { printf '\\n'; cat \"$BLOCK_FILLED\"; } >> \"$AGENTS_FILE\"",
    '  echo "==> appended the Plexus block to $AGENTS_FILE"',
    "fi",
    'rm -f "$BLOCK_TMP" "$BLOCK_FILLED"',
    "",
    'echo "==> the Plexus block is in $AGENTS_FILE — your agent (codex, or any AGENTS.md-reading agent) picks it up from this project by itself"',
    'echo "plexus setup: done. Next — ask your administrator for a one-time code, then run: $LAUNCHER enroll <code>"',
  );

  return L.join("\n") + "\n";
}

/**
 * Render the full generic delivery for `agentId` against `gatewayBaseUrl`. Pure w.r.t. its
 * inputs. The returned `setupSh` + `instruction` are the served/copy-able artifacts; the
 * caller (D1-ENDPOINT) is responsible for delivering the one-time code SEPARATELY (never here).
 */
export function renderGeneric(input: RenderGenericInput): RenderedGeneric {
  // agentId flows into shell comments + a curl URL + the installed launcher; REFUSE any id that is
  // not a safe slug so no interpolation point can inject a live shell line (defense-in-depth behind
  // the connect-time check). See shell-util.assertSafeAgentId.
  const agentId = assertSafeAgentId(input.agentId);
  const base = stripSlash(requireNonEmpty(input.gatewayBaseUrl, "gatewayBaseUrl"));
  const launcherPath = launcherPathFor(requireNonEmpty(input.plexusHome, "plexusHome"), agentId);
  const engine = readFileSync(input.enginePath ?? ENGINE_SOURCE, "utf8");
  // TWO fills of the same SSOT block: the served TEXT gets the server-resolved launcher path;
  // setup.sh embeds the still-tokenized template and resolves {{PLEXUS_CMD}} at run time.
  const template = instructionTemplate(base, input.agentsMdPath);
  const instruction = template.split(PLEXUS_CMD_TOKEN).join(launcherPath);
  const setupSh = renderSetupSh(agentId, base, engine, template);
  return {
    setupSh,
    instruction,
    setupCommand: `curl -fsSL ${base}/integration/${agentId}/setup.sh | bash`,
    launcherPath,
  };
}

/**
 * Assert the generic delivery is SAFE to serve (the generic analogue of `assertVerified`):
 *   1. NO secret — the SHARED structural denylist (`plx_agent_` / `plx_enroll_` / `plx_live_`,
 *      the same one the CC verifier uses) PLUS any caller-supplied literal secret — appears in ANY
 *      served artifact (setup.sh, instruction, or setup command).
 *   2. The setup.sh embeds the SANCTIONED engine VERBATIM (Inv VI) AND that engine source hashes to
 *      the pinned oracle — byte-identical committed CLI, not a hand/model-authored auth path.
 *   3. PROJECT-SCOPE structural guards (agent-integration-project-scope §5.2) — string-structural,
 *      no execution: no retired global-PATH location (`.local/bin`), no `~/.codex/AGENTS.md`
 *      default-expansion, the launcher under `agents/<id>/bin/` inside the state home, the served
 *      instruction token-COMPLETE, and setup.sh carrying its `{{PLEXUS_CMD}}` token ONLY together
 *      with the run-time `sed` fill that resolves it.
 * Throws on any violation. Deterministic; no network, no clock. Symmetric with the CC verifier's
 * axis 1/2 (shared `secret-denylist.ts`), so neither path can drift below the other.
 */
export function assertGenericVerified(
  rendered: RenderedGeneric,
  opts: { forbiddenSecrets?: string[]; enginePath?: string } = {},
): void {
  // 1. No structural OR caller-supplied secret leaks into any served artifact (shared denylist).
  assertNoSecretsIn(
    [
      { label: "setup.sh", text: rendered.setupSh },
      { label: "instruction", text: rendered.instruction },
      { label: "setupCommand", text: rendered.setupCommand },
    ],
    opts.forbiddenSecrets ?? [],
  );

  // 2. The engine source is the pinned sanctioned one AND setup.sh embeds it byte-identical (Inv VI).
  const engine = readFileSync(opts.enginePath ?? ENGINE_SOURCE, "utf8");
  assertEngineSourceSanctioned(engine);
  if (!rendered.setupSh.includes(stripOneTrailingNewline(engine))) {
    throw new Error("assertGenericVerified: setup.sh does not embed the sanctioned engine verbatim (Inv VI)");
  }

  // 3. Project-scope structural guards (§5.2). NOTE: the embedded engine legitimately mentions
  //    nothing here — these needles are renderer-emitted forms, absent from the engine SSOT.
  for (const { label, text } of [
    { label: "setup.sh", text: rendered.setupSh },
    { label: "instruction", text: rendered.instruction },
    { label: "setupCommand", text: rendered.setupCommand },
  ]) {
    if (text.includes(".local/bin")) {
      throw new Error(`assertGenericVerified: ${label} references the retired global-PATH location .local/bin`);
    }
    if (/AGENTS_FILE="\$\{AGENTS_FILE:-[^}"]*\.codex\//.test(text)) {
      throw new Error(`assertGenericVerified: ${label} defaults AGENTS_FILE into ~/.codex (a user-global write)`);
    }
  }
  if (!rendered.setupSh.includes('LAUNCHER="$PLEXUS_HOME/agents/$AGENT_ID/bin/plexus"')) {
    throw new Error(
      "assertGenericVerified: setup.sh does not install the launcher at $PLEXUS_HOME/agents/$AGENT_ID/bin/plexus",
    );
  }
  if (rendered.instruction.includes("{{PLEXUS_")) {
    throw new Error("assertGenericVerified: the served instruction text carries an unfilled {{PLEXUS_ token");
  }
  if (!rendered.setupSh.includes('sed "s#{{PLEXUS_CMD}}#$LAUNCHER#g"')) {
    throw new Error("assertGenericVerified: setup.sh lacks the run-time {{PLEXUS_CMD}} sed fill");
  }
}
