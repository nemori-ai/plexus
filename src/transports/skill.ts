/**
 * `skill` transport — sentinel for `kind:"skill"` entries (ADR-003). There is NO
 * callable wire: a skill body is delivered as context at handshake/read time, not
 * invoked. `dispatch` exists only to keep the transport map total; invoking a skill
 * is a contract error (skills are read-as-context, never called).
 */

import type {
  Transport,
  CapabilityEntry,
  TransportDispatchContext,
  TransportResult,
} from "../protocol/index.ts";

export class SkillTransport implements Transport {
  readonly kind = "skill" as const;

  async dispatch(
    entry: CapabilityEntry,
    _input: Record<string, unknown>,
    _ctx?: TransportDispatchContext,
  ): Promise<TransportResult> {
    // Skills are read-as-context, never invoked over a wire. The bridge already
    // short-circuits kind:"skill" before reaching here; this is defense-in-depth,
    // surfaced as a clean transport_error rather than a thrown exception so the
    // transport map stays total and the failure is a normal InvokeResponse.
    return {
      ok: false,
      error: {
        code: "transport_error",
        message: "skill entries are read-as-context, not invoked over a wire",
        capabilityId: entry.id,
      },
    };
  }
}
