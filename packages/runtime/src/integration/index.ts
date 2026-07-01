/**
 * Integration-compile module (G1-TEMPLATE) — the deterministic renderer that projects a
 * granted cap-set + the gateway Floor into a ready-to-install Claude Code plugin.
 *
 * D1-ENDPOINT imports from here to serve `GET /integration/<agent>`.
 */

export {
  renderPlugin,
  writePlugin,
  type RenderPluginInput,
  type RenderedPlugin,
  type RenderedFile,
} from "./render-plugin.ts";

export {
  verifyPlugin,
  assertVerified,
  PluginVerificationError,
  type VerifyPluginOptions,
  type VerdictResult,
  type AxisResult,
} from "./verify-plugin.ts";
