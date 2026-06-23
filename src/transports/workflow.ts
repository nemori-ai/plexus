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

/**
 * DEPTH BACKSTOP (security review must-fix #4). The registration-time anti-cycle
 * walk (`core/workflow-validate.ts`) is the primary defense, but it is a static
 * graph check; a runtime cycle could still slip through a TOCTOU re-register or a
 * cross-source member the static walk could not fully resolve. This hard cap on
 * re-entrant fan-out DEPTH is the runtime backstop: a workflow fan-out chain deeper
 * than `MAX_WORKFLOW_DEPTH` is halted with a `transport_error` instead of recursing
 * to a stack overflow.
 *
 * Depth is tracked per ORIGINATING jti — the whole fan-out tree of one /invoke runs
 * under the same jti (the pipeline re-checks that jti's revocation before each
 * member), so counting active re-entries per jti measures exactly the workflow
 * nesting depth. The counter is incremented on enter and decremented on exit, so it
 * is self-cleaning and never leaks across calls.
 */
export const MAX_WORKFLOW_DEPTH = 16;

/** Active re-entrant workflow depth, keyed by originating jti. */
const depthByJti = new Map<string, number>();

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

    // DEPTH BACKSTOP: refuse to begin a fan-out that would exceed the hard cap. A
    // cycle that escaped the static anti-cycle walk (TOCTOU/cross-source) would
    // re-enter this transport repeatedly under the SAME jti; once the active depth
    // hits the cap we halt with a transport_error rather than recursing to a stack
    // overflow. self-reference (A→A) and A→B→A both trip this on the way down.
    const jti = ctx.invoke.jti;
    const currentDepth = depthByJti.get(jti) ?? 0;
    if (currentDepth >= MAX_WORKFLOW_DEPTH) {
      return {
        ok: false,
        error: {
          code: "transport_error",
          message: `workflow ${entry.id} exceeded max fan-out depth (${MAX_WORKFLOW_DEPTH}); aborted to prevent unbounded recursion`,
          capabilityId: entry.id,
          detail: { reason: "workflow_depth_exceeded", depth: currentDepth },
        },
      };
    }
    depthByJti.set(jti, currentDepth + 1);

    try {
      return await this.fanOut(entry, members, input, ctx);
    } finally {
      // Self-clean: restore the prior depth (or drop the key at the root).
      if (currentDepth === 0) depthByJti.delete(jti);
      else depthByJti.set(jti, currentDepth);
    }
  }

  private async fanOut(
    entry: CapabilityEntry,
    members: NonNullable<CapabilityEntry["members"]>,
    input: Record<string, unknown>,
    ctx: TransportDispatchContext,
  ): Promise<TransportResult> {
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
