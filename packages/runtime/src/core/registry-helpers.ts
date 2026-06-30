/**
 * ID-derivation helper (frozen contract §0). An id is always
 * `<sourceSlug>.<noun>.<verb>` where `<sourceSlug>` is the SourceId with `:`
 * replaced by `.` (source `mcp:github` ⇒ slug `mcp.github`). The source is
 * therefore RECOVERABLE from the id so routing never needs an id→source map.
 *
 * In practice the gateway prefers the entry's explicit `source` field; this is the
 * fallback the contract guarantees.
 *
 * MESH NOTE (T6, plan risk #5): a mesh-mounted address is `tenant/workload/source.cap`
 * — `/` separates LOCATION segments, `.` the source.capability tail. Mounted entries
 * ALWAYS carry an explicit `source` (`mesh:<workload>`), so the pipeline routes them via
 * `entry.source` and this fallback is never reached for an address. Even so, we strip any
 * leading location path before deriving, so `deriveSource` stays correct (derives from the
 * BARE tail) if it is ever handed a full address — the `/` segments never corrupt the slug.
 */

import type { CapabilityId, SourceId } from "@plexus/protocol";

/**
 * Recover the SourceId from a CapabilityId. Re-joins the slug back to the SourceId:
 * the slug is the id minus its last two `.`-segments (`<noun>.<verb>`); a leading
 * `mcp.` slug maps back to the `mcp:` source convention.
 */
export function deriveSource(id: CapabilityId): SourceId {
  // Strip any mesh location prefix (`tenant/workload/`) so derivation sees only the bare
  // `source.capability` tail — `/` is a LOCATION separator, never part of the slug.
  const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const segments = bare.split(".");
  // Drop the trailing `<noun>.<verb>` to recover the source slug.
  const slug = segments.length > 2 ? segments.slice(0, -2).join(".") : segments[0] ?? bare;
  // The MCP convention slug `mcp.<server>` maps to source `mcp:<server>`.
  if (slug.startsWith("mcp.")) {
    return `mcp:${slug.slice("mcp.".length)}`;
  }
  return slug;
}
