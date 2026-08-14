/**
 * Async invoke run store (ADR-029) — the record behind an {@link InvokeRunHandle}.
 *
 * A run exists for exactly one reason: a capability whose runtime outlives the caller's
 * connection needs somewhere for its result to LAND. Without it the gateway finishes the
 * work, audits it, and discards the answer because the requester is gone.
 *
 * THREE PROPERTIES CARRY THE SECURITY OF THIS STORE:
 *
 *   1. The handle is a LOCATOR, NOT A CREDENTIAL. A `runId` grants nothing. Every read is
 *      re-authorized against the run's bound principal (`canCollect`), so a leaked runId
 *      yields 403 and never output. This is why the id may travel in a URL at all.
 *   2. BOUND TO THE AGENT, NOT THE EPISODE. Collection requires the same `agentId` — the
 *      durable PAT identity — not the session that accepted the call. A run legitimately
 *      outlives its 60-minute episode (ADR-028); binding to the session would strand the
 *      agent's own result behind a re-handshake it is required to perform. The episode
 *      still bounds what the agent can START; it does not bound reading back what it
 *      already legitimately ran.
 *   3. IN-FLIGHT RUNS ARE NEVER SWEPT. The retention window is measured from COMPLETION,
 *      so a long run cannot have its own result expired out from under it mid-flight.
 *
 * In-memory and process-scoped, exactly like sessions: a gateway restart drops in-flight
 * runs. That is the honest bound — the run's audit record is the durable artifact, the
 * result cache is not.
 */

import { randomUUID } from "node:crypto";
import type {
  CapabilityId,
  InvokeResponse,
  InvokeRunState,
  IsoTimestamp,
} from "@plexus/protocol";

/**
 * How long a SETTLED run stays collectable, measured from completion (not from
 * acceptance — see property 3 above). One hour: generous next to any agent's poll
 * interval, and short enough that captured outputs are not a long-lived in-memory pile.
 */
export const RUN_RETENTION_MS = 60 * 60 * 1000;

/**
 * Ceiling on simultaneously-RUNNING async invokes per agent. Async removes the natural
 * backpressure of call-once-and-wait — an agent that had to hold a connection per call
 * could not trivially start fifty sandboxed coding runs. This restores a bound. Settled
 * runs awaiting collection do not count; only in-flight work does.
 */
export const MAX_CONCURRENT_RUNS_PER_AGENT = 8;

export interface InvokeRun {
  runId: string;
  capabilityId: CapabilityId;
  /**
   * The bound principal — the enrolled agent that made the call. Absent only for a
   * session-only (anonymous) caller, in which case `sessionId` is the sole binding.
   */
  agentId?: string;
  /** The session that ACCEPTED the run (audit linkage, and the fallback binding). */
  sessionId: string;
  /** The token the accept was authorized under (audit linkage only, never re-verified). */
  jti: string;
  status: InvokeRunState;
  startedAt: IsoTimestamp;
  finishedAt?: IsoTimestamp;
  /** When the record is discarded. Re-stamped on settle so the window starts at completion. */
  expiresAt: IsoTimestamp;
  /** The response the synchronous path would have returned. Present once settled. */
  result?: InvokeResponse;
}

export interface InvokeRunStore {
  /**
   * Open a run record for an ALREADY-AUTHORIZED invoke. Callers must have cleared
   * `InvokePipeline.precheck` first — this store makes no authorization decision.
   * Returns `undefined` when the agent is at {@link MAX_CONCURRENT_RUNS_PER_AGENT}.
   */
  open(fields: {
    capabilityId: CapabilityId;
    agentId?: string;
    sessionId: string;
    jti: string;
  }): InvokeRun | undefined;
  /** Record a terminal outcome and start the collection window. */
  settle(runId: string, result: InvokeResponse): InvokeRun | undefined;
  /** Read a run, or `undefined` if unknown or past retention. */
  get(runId: string): InvokeRun | undefined;
  /**
   * Whether `requester` may read this run's result. The single authorization predicate
   * for collection — the status endpoint owns no rule of its own.
   */
  canCollect(run: InvokeRun, requester: { agentId?: string; sessionId?: string }): boolean;
  /** In-flight run count for an agent (the concurrency bound's input). */
  runningFor(agentId: string | undefined): number;
  all(): InvokeRun[];
}

class InMemoryInvokeRunStore implements InvokeRunStore {
  private readonly runs = new Map<string, InvokeRun>();

  open(fields: {
    capabilityId: CapabilityId;
    agentId?: string;
    sessionId: string;
    jti: string;
  }): InvokeRun | undefined {
    this.sweep();
    if (this.runningFor(fields.agentId) >= MAX_CONCURRENT_RUNS_PER_AGENT) return undefined;
    const now = Date.now();
    const run: InvokeRun = {
      runId: `run_${randomUUID()}`,
      capabilityId: fields.capabilityId,
      ...(fields.agentId ? { agentId: fields.agentId } : {}),
      sessionId: fields.sessionId,
      jti: fields.jti,
      status: "running",
      startedAt: new Date(now).toISOString(),
      // Provisional: a RUNNING record is never swept, and this is re-stamped from the
      // real completion time in `settle`. It is a floor, never a deadline on the work.
      expiresAt: new Date(now + RUN_RETENTION_MS).toISOString(),
    };
    this.runs.set(run.runId, run);
    return run;
  }

  settle(runId: string, result: InvokeResponse): InvokeRun | undefined {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") return undefined;
    const now = Date.now();
    run.status = result.ok ? "succeeded" : "failed";
    run.finishedAt = new Date(now).toISOString();
    run.expiresAt = new Date(now + RUN_RETENTION_MS).toISOString();
    run.result = result;
    return run;
  }

  get(runId: string): InvokeRun | undefined {
    this.sweep();
    return this.runs.get(runId);
  }

  canCollect(run: InvokeRun, requester: { agentId?: string; sessionId?: string }): boolean {
    // Bound to the enrolled identity when there is one — a new episode of the SAME agent
    // collects its own result (property 2). Falls back to the exact accepting session for
    // an anonymous caller, which has no durable identity to bind to.
    if (run.agentId) return !!requester.agentId && requester.agentId === run.agentId;
    return !!requester.sessionId && requester.sessionId === run.sessionId;
  }

  runningFor(agentId: string | undefined): number {
    let n = 0;
    for (const run of this.runs.values()) {
      if (run.status !== "running") continue;
      if ((run.agentId ?? undefined) === agentId) n++;
    }
    return n;
  }

  all(): InvokeRun[] {
    this.sweep();
    return [...this.runs.values()];
  }

  /** Drop SETTLED runs past their collection window. Running records are never swept. */
  private sweep(): void {
    const now = Date.now();
    for (const [id, run] of this.runs) {
      if (run.status === "running") continue;
      if (Date.parse(run.expiresAt) <= now) this.runs.delete(id);
    }
  }
}

export function createInvokeRunStore(): InvokeRunStore {
  return new InMemoryInvokeRunStore();
}
