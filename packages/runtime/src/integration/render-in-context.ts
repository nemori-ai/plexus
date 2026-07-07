/**
 * G1-IN-CONTEXT — the deterministic renderer for the HTTP-ONLY ("in-context") agent integration.
 *
 * SSOT: docs/design/agent-skill-compile-domain-model.md §5 (deliver·P), ADR-8; and
 *       integrations/in-context/PROTOCOL.md (the static pure-HTTP protocol instruction SSOT).
 *
 * WHAT THIS IS — the THIRD delivery form, alongside `render-plugin.ts` (Claude Code) and
 * `render-generic.ts` (portable CLI). Where those materialize files on disk, IN-CONTEXT
 * materializes NOTHING: a light / cloud agent with no filesystem gets a pure-HTTP-protocol
 * instruction TEXT (the committed PROTOCOL.md with the gateway URL filled in) that it feeds
 * straight into its own context and follows with its own `fetch`/`curl`. There is no CLI, no
 * plugin, no bootstrap script — hence no public route: the endpoint returns the instruction +
 * the one-time enroll code ONLY in the mgmt-gated JSON.
 *
 * INV III / secret hygiene — the instruction is CODE-FREE + KEY-FREE. It carries no one-time
 * enrollment code, no durable PAT, and no admin connection-key; it references only the bare
 * credential PREFIXES (`plx_agent_…` / `plx_enroll_…` / `plx_live_…`) as protocol markers. The
 * one-time code is delivered SEPARATELY, only in the mgmt-gated JSON (`enrollCode`) — never in the
 * instruction. `assertInContextVerified` enforces this at serve time (shared `secret-denylist.ts`).
 *
 * Unlike the generic renderer there is NO engine to embed (in-context installs nothing), so this
 * module has no engine-SHA pin — only the shared structural + caller-supplied secret scan.
 */

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { stripSlash, requireNonEmpty } from "./shell-util.ts";
import { assertNoSecretsIn } from "./secret-denylist.ts";

// The static, agent-agnostic pure-HTTP protocol block — the SSOT the endpoint serves as copy-able
// text. Carries `{{GATEWAY_URL}}` + `{{GATEWAY_HOST}}` placeholders the endpoint fills.
const PROTOCOL_SOURCE = fileURLToPath(
  new URL("../../../../integrations/in-context/PROTOCOL.md", import.meta.url),
);

/** The token the endpoint fills with the gateway's canonical base URL (e.g. `http://127.0.0.1:PORT`). */
const GATEWAY_URL_TOKEN = "{{GATEWAY_URL}}";
/** The token the endpoint fills with the gateway's `host:port` (for the loopback Host guard). */
const GATEWAY_HOST_TOKEN = "{{GATEWAY_HOST}}";

export interface RenderInContextInput {
  /**
   * The gateway's canonical base URL (from the Floor: `floor.gateway.baseUrl`). May be undefined
   * when the Floor is missing it — this is the SINGLE normalization point: a missing/empty base
   * throws here (⇒ the endpoint 500s) rather than silently emitting a host-less instruction.
   */
  gatewayBaseUrl: string | undefined;
  /** Override the PROTOCOL.md source path (tests only). */
  protocolPath?: string;
}

/** The HTTP-only delivery — just the filled-in, copy-able protocol instruction text. */
export interface RenderedInContext {
  /** The filled-in PROTOCOL.md instruction TEXT (gateway URL + host substituted). Code-free. */
  instruction: string;
}

/** Derive the `host:port` authority from a base URL, for the loopback Host guard hint. */
function hostAuthority(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    // Fall back to a scheme-strip if the base is not a full URL (defensive; requireNonEmpty already ran).
    return baseUrl.replace(/^[a-z]+:\/\//i, "");
  }
}

/**
 * Fill the static protocol block with the real gateway URL + host. Pure. The result is what the
 * console shows as copy-able text and what the agent pastes into its own context.
 */
export function renderInContextInstruction(gatewayBaseUrl: string, protocolPath?: string): string {
  const base = stripSlash(requireNonEmpty(gatewayBaseUrl, "gatewayBaseUrl"));
  const host = hostAuthority(base);
  const raw = readFileSync(protocolPath ?? PROTOCOL_SOURCE, "utf8");
  return raw.split(GATEWAY_URL_TOKEN).join(base).split(GATEWAY_HOST_TOKEN).join(host);
}

/**
 * Render the full in-context delivery for `gatewayBaseUrl`. Pure w.r.t. its inputs. The returned
 * `instruction` is the served/copy-able artifact; the caller (D1-ENDPOINT) delivers the one-time
 * enroll code SEPARATELY (never here). No agentId is needed — the agent learns its own agentId from
 * the enroll response.
 */
export function renderInContext(input: RenderInContextInput): RenderedInContext {
  const base = stripSlash(requireNonEmpty(input.gatewayBaseUrl, "gatewayBaseUrl"));
  const instruction = renderInContextInstruction(base, input.protocolPath);
  return { instruction };
}

/**
 * Assert the in-context delivery is SAFE to serve (the in-context analogue of `assertVerified` /
 * `assertGenericVerified`): NO structural secret (`plx_agent_` / `plx_enroll_` / `plx_live_` + a
 * real body — the SHARED denylist) and NO caller-supplied literal secret (the one-time code, the
 * connection-key) appears in the served instruction. Throws on any violation. Deterministic; no
 * network, no clock. There is no engine to embed, so — unlike the generic verifier — there is no
 * engine-SHA axis; this is purely the shared secret scan.
 */
export function assertInContextVerified(
  rendered: RenderedInContext,
  opts: { forbiddenSecrets?: string[] } = {},
): void {
  assertNoSecretsIn(
    [{ label: "instruction", text: rendered.instruction }],
    opts.forbiddenSecrets ?? [],
  );
}
