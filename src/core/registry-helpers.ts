/**
 * ID-derivation helper (frozen contract §0). An id is always
 * `<sourceSlug>.<noun>.<verb>` where `<sourceSlug>` is the SourceId with `:`
 * replaced by `.` (source `mcp:github` ⇒ slug `mcp.github`). The source is
 * therefore RECOVERABLE from the id so routing never needs an id→source map.
 *
 * In practice the gateway prefers the entry's explicit `source` field; this is the
 * fallback the contract guarantees.
 */

import type { CapabilityId, SourceId } from "../protocol/index.ts";

/**
 * Recover the SourceId from a CapabilityId. Re-joins the slug back to the SourceId:
 * the slug is the id minus its last two `.`-segments (`<noun>.<verb>`); a leading
 * `mcp.` slug maps back to the `mcp:` source convention.
 */
export function deriveSource(id: CapabilityId): SourceId {
  const segments = id.split(".");
  // Drop the trailing `<noun>.<verb>` to recover the source slug.
  const slug = segments.length > 2 ? segments.slice(0, -2).join(".") : segments[0] ?? id;
  // The MCP convention slug `mcp.<server>` maps to source `mcp:<server>`.
  if (slug.startsWith("mcp.")) {
    return `mcp:${slug.slice("mcp.".length)}`;
  }
  return slug;
}
