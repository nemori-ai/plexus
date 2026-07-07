/**
 * G1-GENERIC — the deterministic renderer for the PORTABLE ("generic") agent integration.
 *
 * SSOT: docs/design/agent-skill-compile-domain-model.md §5 (deliver·P), ADR-8; and
 *       integrations/generic/ (the static instruction SSOT + repo-mode setup).
 *
 * WHAT THIS IS — the generic counterpart to `render-plugin.ts`. Where Claude Code gets a
 * bespoke COMPILED plugin, any OTHER agent gets a PORTABLE delivery: a self-contained
 * `setup.sh` (installs the sanctioned `plexus` CLI on PATH + lands a filled-in
 * `AGENTS.plexus.md`) plus the instruction TEXT itself (copy-able, to paste straight into
 * an agent). Both are pure functions of (agentId, gatewayBaseUrl) + the committed sources.
 *
 * INV III / secret hygiene — NO secret is ever written into a served file. The served
 * `setup.sh` is CODE-FREE and KEY-FREE: it never carries the one-time enrollment code, the
 * durable PAT, or the admin connection-key. The one-time code is delivered SEPARATELY, only
 * in the mgmt-gated JSON response (`enrollCode`), exactly like the CC install command. After
 * setup the agent runs `plexus enroll <code>` once, out of band.
 *
 * INV VI (sanctioned auth core) — the engine `setup.sh` materializes is the committed
 * `tools/plexus-cli/plexus` copied BYTE-FOR-BYTE (the SAME engine `render-plugin.ts` bundles,
 * verified byte-identical by `verify-plugin.ts`). Nothing here is model-authored.
 */

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

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
/** A fixed, collision-proof heredoc terminator for the inlined engine (deterministic). */
const ENGINE_DELIM = "PLEXUS_EOF_ENGINE";
/** A fixed, collision-proof heredoc terminator for the inlined instruction (deterministic). */
const AGENTS_DELIM = "PLEXUS_EOF_AGENTS_MD";
/** A fixed, collision-proof heredoc terminator for the inlined launcher (deterministic). */
const LAUNCHER_DELIM = "PLEXUS_EOF_LAUNCHER";

export interface RenderGenericInput {
  /** The agent this integration is delivered for (the enrollment/PAT identity). */
  agentId: string;
  /** The gateway's canonical base URL (from the Floor: `floor.gateway.baseUrl`). */
  gatewayBaseUrl: string;
  /** Override the engine source path (tests only). Defaults to `tools/plexus-cli/plexus`. */
  enginePath?: string;
  /** Override the AGENTS.plexus.md source path (tests only). */
  agentsMdPath?: string;
}

/** The portable delivery — the served setup.sh + the copy-able instruction text. */
export interface RenderedGeneric {
  /** The self-contained, CODE-FREE bootstrap served at `/integration/:agentId/setup.sh`. */
  setupSh: string;
  /** The filled-in AGENTS.plexus.md instruction TEXT (console URL substituted). */
  instruction: string;
  /** The copy-able one-command SETUP string (code-free). */
  setupCommand: string;
}

function stripSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

function requireNonEmpty(v: string, name: string): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`renderGeneric: ${name} must be a non-empty string`);
  }
  return v;
}

/** Single-quote a value for safe literal use in the generated shell (POSIX-safe). */
function shSingleQuote(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** Strip exactly one trailing newline (the heredoc re-adds it). */
function stripOneTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

/**
 * Fill the static instruction block with the real console URL (`<gatewayBaseUrl>/admin`).
 * Pure. The result is what the console shows as copy-able text and what setup.sh lands.
 */
export function renderGenericInstruction(gatewayBaseUrl: string, agentsMdPath?: string): string {
  const base = stripSlash(requireNonEmpty(gatewayBaseUrl, "gatewayBaseUrl"));
  const raw = readFileSync(agentsMdPath ?? AGENTS_MD_SOURCE, "utf8");
  return raw.split(CONSOLE_URL_TOKEN).join(`${base}/admin`);
}

/** The launcher installed on the agent's PATH — execs the sanctioned engine as this agent. */
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
 * setup.sh | bash` with NO surrounding directory. It:
 *   1. materializes the sanctioned engine (byte-identical) at `$PLEXUS_HOME/bin/plexus`,
 *   2. installs a `plexus` launcher on PATH (default ~/.local/bin) bound to this agent,
 *   3. pins the gateway (`$PLEXUS_HOME/gateway`),
 *   4. lands the filled-in AGENTS.plexus.md (marker-guarded), then
 *   5. tells the operator to run `plexus enroll <code>` with the code shown in the console.
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

  // Deterministic guard: an inlined file must never contain a line equal to its heredoc
  // terminator (would truncate the file). Our fixed delimiters can't collide with content.
  for (const [body, delim, name] of [
    [engineBody, ENGINE_DELIM, "engine"],
    [agentsBody, AGENTS_DELIM, "instruction"],
    [launcherBody, LAUNCHER_DELIM, "launcher"],
  ] as const) {
    if (body.split("\n").some((line) => line === delim)) {
      throw new Error(`renderGeneric: heredoc delimiter '${delim}' collides with ${name} content`);
    }
  }

  L.push(
    "#!/usr/bin/env bash",
    `# Plexus generic-agent setup — compiled for agent '${agentId}'.`,
    "#",
    "# SELF-CONTAINED bootstrap — safe under:  curl -fsSL <gateway>/integration/<agentId>/setup.sh | bash",
    "# with NO surrounding directory. It materializes the sanctioned 'plexus' CLI on PATH, pins the",
    "# gateway, and lands a filled-in AGENTS.plexus.md. CODE-FREE + KEY-FREE (Inv III): no one-time",
    "# code, no PAT, no connection-key is ever written here. After setup, ask your administrator for",
    "# a one-time code and run once:  plexus enroll <code>",
    "set -euo pipefail",
    "",
    `AGENT_ID=${shSingleQuote(agentId)}`,
    'PLEXUS_GATEWAY="${PLEXUS_GATEWAY:-' + gatewayBaseUrl + '}"',
    'PLEXUS_HOME="${PLEXUS_HOME:-$HOME/.plexus}"',
    'BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"',
    'AGENTS_FILE="${AGENTS_FILE:-$PLEXUS_HOME/AGENTS.plexus.md}"',
    'ENGINE="$PLEXUS_HOME/bin/plexus"',
    "",
    'mkdir -p "$PLEXUS_HOME/bin" "$PLEXUS_HOME/agents" "$BIN_DIR" "$(dirname "$AGENTS_FILE")"',
    'chmod 700 "$PLEXUS_HOME" 2>/dev/null || true',
    "",
    "# 1. Materialize the sanctioned engine (byte-identical to the committed CLI).",
    `cat > "$ENGINE" <<'${ENGINE_DELIM}'`,
    engineBody,
    ENGINE_DELIM,
    'chmod 755 "$ENGINE"',
    "",
    "# 2. Install the 'plexus' launcher on PATH (bound to this agent; execs the engine).",
    `cat > "$BIN_DIR/plexus" <<'${LAUNCHER_DELIM}'`,
    launcherBody,
    LAUNCHER_DELIM,
    'chmod 755 "$BIN_DIR/plexus"',
    'echo "==> installed plexus launcher at $BIN_DIR/plexus"',
    "case \":$PATH:\" in",
    '  *":$BIN_DIR:"*) ;;',
    '  *) echo "    NOTE: $BIN_DIR is not on your PATH — add it (e.g. in your shell rc):"',
    '     echo "          export PATH=\\"$BIN_DIR:\\$PATH\\"" ;;',
    "esac",
    "",
    "# 3. Pin the gateway for the CLI engine so 'plexus <cap>' reaches the right port.",
    `printf '%s\\n' "$PLEXUS_GATEWAY" > "$PLEXUS_HOME/gateway"`,
    "",
    "# 4. Land the AGENTS.plexus.md instruction block (marker-guarded, idempotent).",
    'touch "$AGENTS_FILE"',
    `BLOCK_TMP="$(mktemp)"`,
    `cat > "$BLOCK_TMP" <<'${AGENTS_DELIM}'`,
    agentsBody,
    AGENTS_DELIM,
    'if grep -q "<!-- BEGIN PLEXUS -->" "$AGENTS_FILE"; then',
    '  TMP="$(mktemp)"',
    "  awk '",
    "    /<!-- BEGIN PLEXUS -->/ {skip=1; while ((getline line < BLOCK) > 0) print line; next}",
    "    /<!-- END PLEXUS -->/   {skip=0; next}",
    "    skip!=1 {print}",
    '  \' BLOCK="$BLOCK_TMP" "$AGENTS_FILE" > "$TMP"',
    '  mv "$TMP" "$AGENTS_FILE"',
    '  echo "==> refreshed the Plexus block in $AGENTS_FILE"',
    "else",
    "  { printf '\\n'; cat \"$BLOCK_TMP\"; } >> \"$AGENTS_FILE\"",
    '  echo "==> appended the Plexus block to $AGENTS_FILE"',
    "fi",
    'rm -f "$BLOCK_TMP"',
    "",
    'echo "plexus setup: done. Next — ask your administrator for a one-time code, then run: plexus enroll <code>"',
  );

  return L.join("\n") + "\n";
}

/**
 * Render the full generic delivery for `agentId` against `gatewayBaseUrl`. Pure w.r.t. its
 * inputs. The returned `setupSh` + `instruction` are the served/copy-able artifacts; the
 * caller (D1-ENDPOINT) is responsible for delivering the one-time code SEPARATELY (never here).
 */
export function renderGeneric(input: RenderGenericInput): RenderedGeneric {
  const agentId = requireNonEmpty(input.agentId, "agentId");
  const base = stripSlash(requireNonEmpty(input.gatewayBaseUrl, "gatewayBaseUrl"));
  const engine = readFileSync(input.enginePath ?? ENGINE_SOURCE, "utf8");
  const instruction = renderGenericInstruction(base, input.agentsMdPath);
  const setupSh = renderSetupSh(agentId, base, engine, instruction);
  return {
    setupSh,
    instruction,
    setupCommand: `curl -fsSL ${base}/integration/${agentId}/setup.sh | bash`,
  };
}

/**
 * Assert the generic delivery is SAFE to serve (the generic analogue of `assertVerified`):
 *   1. NO forbidden secret (the admin connection-key, a durable PAT, or a live one-time code)
 *      appears in ANY served artifact — the setup.sh, the instruction, or the setup command.
 *   2. The setup.sh embeds the SANCTIONED engine VERBATIM (Inv VI) — the byte-identical
 *      committed CLI, not a hand/model-authored auth path.
 * Throws on any violation. Deterministic; no network, no clock.
 */
export function assertGenericVerified(
  rendered: RenderedGeneric,
  opts: { forbiddenSecrets?: string[]; enginePath?: string } = {},
): void {
  const haystacks: [string, string][] = [
    ["setup.sh", rendered.setupSh],
    ["instruction", rendered.instruction],
    ["setupCommand", rendered.setupCommand],
  ];

  // 1. No forbidden secret leaks into any served artifact.
  for (const secret of opts.forbiddenSecrets ?? []) {
    if (!secret) continue;
    for (const [where, text] of haystacks) {
      if (text.includes(secret)) {
        throw new Error(`assertGenericVerified: a forbidden secret leaked into the served ${where}`);
      }
    }
  }

  // 1b. Structural denylist — no baked PAT / one-time code, in any served artifact.
  for (const [where, text] of haystacks) {
    if (/plx_agent_[A-Za-z0-9_-]{16,}/.test(text)) {
      throw new Error(`assertGenericVerified: a durable PAT appears in the served ${where}`);
    }
    if (/plx_enroll_[A-Za-z0-9_-]{16,}/.test(text)) {
      throw new Error(`assertGenericVerified: a one-time enrollment code appears in the served ${where}`);
    }
  }

  // 2. The engine is embedded byte-identical (Inv VI) — a self-authored auth path is refused.
  const engine = readFileSync(opts.enginePath ?? ENGINE_SOURCE, "utf8");
  if (!rendered.setupSh.includes(stripOneTrailingNewline(engine))) {
    throw new Error("assertGenericVerified: setup.sh does not embed the sanctioned engine verbatim (Inv VI)");
  }
}
