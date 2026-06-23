/**
 * `workflow` transport (ADR-013, review #6) — the orchestrator is "just a
 * transport." There is NO external wire: dispatch RE-ENTERS the uniform invoke
 * pipeline per `entry.members[]` via `ctx.invokeById`, so the gateway core NEVER
 * branches on `kind:"workflow"`. Each member dispatch is scope-checked (against the
 * synthesized transitive scopes) + audited, and the originating jti's revocation
 * state is re-checked before EACH member by the core pipeline `invokeById` re-enters.
 *
 * Fan-out is SEQUENTIAL and FAIL-FAST: if a member dispatch comes back not-ok the
 * orchestration halts and surfaces that member's error (a mid-fan-out revoke that
 * the pipeline catches surfaces as token_revoked on the next member and halts the
 * rest — review #3). The member results are collected and returned as the
 * workflow's structured output.
 */

import type {
  WorkflowTransport,
  CapabilityEntry,
  TransportDispatchContext,
  TransportResult,
  InvokeResponse,
} from "../protocol/index.ts";

export class WorkflowOrchestratorTransport implements WorkflowTransport {
  readonly kind = "workflow" as const;

  async dispatch(
    entry: CapabilityEntry,
    input: Record<string, unknown>,
    ctx: TransportDispatchContext,
  ): Promise<TransportResult> {
    const members = entry.members ?? [];
    if (members.length === 0) {
      return {
        ok: false,
        error: {
          code: "transport_error",
          message: `workflow ${entry.id} has no members to orchestrate`,
          capabilityId: entry.id,
        },
      };
    }

    const results: Array<{ id: string; ok: boolean; auditId: string }> = [];

    // SEQUENTIAL fan-out. Each member re-enters the SAME pipeline via invokeById —
    // identical scope-check + audit + transport routing as a top-level invoke. The
    // pipeline re-checks the originating jti's revocation before each dispatch, so a
    // mid-fan-out revoke makes the NEXT call fail (token_revoked) and we halt.
    for (const member of members) {
      let res: InvokeResponse;
      try {
        res = await ctx.invokeById(
          // Members receive the workflow's input verbatim; a richer mapping is a
          // future enhancement, but the re-entrancy contract is what matters here.
          { id: member.id, input },
          ctx.invoke,
        );
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "internal_error",
            message: err instanceof Error ? err.message : String(err),
            capabilityId: member.id,
          },
        };
      }

      results.push({ id: member.id, ok: res.ok, auditId: res.auditId });

      if (!res.ok) {
        // FAIL-FAST: surface the member's error; subsequent members are NOT run.
        return {
          ok: false,
          data: { workflow: entry.id, completed: results, failedAt: member.id },
          error: res.error ?? {
            code: "transport_error",
            message: `workflow member ${member.id} failed`,
            capabilityId: member.id,
          },
        };
      }
    }

    return { ok: true, data: { workflow: entry.id, members: results } };
  }
}
