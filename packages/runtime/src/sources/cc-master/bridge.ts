/**
 * cc-master PER-SESSION bridge.
 *
 * Identical to `BaseCapabilityBridge` for the orchestration WORKFLOW (it delegates
 * to the workflow transport, which fans out across the members via the uniform
 * pipeline) and for the SKILL entries — but the three coordination MEMBERS
 * (`board.create` / `agent.dispatch` / `board.status`) are served by REAL in-process
 * board operations (see `board.ts`) instead of an external `cli` wire.
 *
 * This mirrors the Obsidian `ExtensionBridge` in-process-handler pattern: a
 * capability best served by gateway-owned local code runs that code directly and the
 * bridge only normalizes + audits the result. No core change is needed — the bridge
 * is private to this source and the workflow transport re-enters through the SAME
 * `invokeById` pipeline, so each member dispatch is still scope-checked + audited by
 * the pipeline before it reaches us.
 *
 * Why in-process rather than a `cli` route: a cc-master board is a plain local JSON
 * file, and board create/read/dispatch-record are genuine local operations that do
 * NOT require the LLM. So the member can perform a REAL, file-verifiable action and
 * return `ok:true` honestly — the missing piece that previously made the leaf return
 * `transport_error` (no spawnable binary).
 */

import type {
  BridgeDeps,
  CapabilityEntry,
  InvokeContext,
  InvokeRequest,
  InvokeResponse,
  TransportResult,
} from "@plexus/protocol";
import { BaseCapabilityBridge, normalizeResult } from "../base.ts";
import {
  CC_MASTER_SOURCE_ID,
  AGENT_DISPATCH_ID,
  BOARD_CREATE_ID,
  BOARD_STATUS_ID,
} from "./entries.ts";
import { boardStatus, createBoard, dispatchAgent } from "./board.ts";

/** A member's in-process board handler: input → real local board op → TransportResult. */
type BoardHandler = (input: Record<string, unknown>) => TransportResult;

function goalOf(input: Record<string, unknown>): string {
  const g = input.goal;
  return typeof g === "string" && g.trim().length > 0 ? g : "untitled orchestration";
}

/**
 * The board-op handler for each member id. These run gateway-owned local code (no
 * external wire), reading the install target dir from `resolveClaudeDir` (env/HOME),
 * so the demo + tests hit a TEMP `.claude/cc-master/`.
 */
const BOARD_HANDLERS: Record<string, BoardHandler> = {
  [BOARD_CREATE_ID]: (input) => {
    const { boardId, path, created } = createBoard(goalOf(input));
    return { ok: true, data: { boardId, path, created, op: "board.create" } };
  },
  [AGENT_DISPATCH_ID]: (input) => {
    const node = typeof input.node === "string" ? input.node : undefined;
    const res = dispatchAgent(goalOf(input), node);
    return {
      ok: true,
      data: {
        boardId: res.boardId,
        path: res.path,
        dispatchedNode: res.nodeId,
        // HONEST: the local board records the dispatch; the agent runs inside CC.
        agentExecution: "deferred",
        deferredTo: res.deferredTo,
        op: "agent.dispatch",
      },
    };
  },
  [BOARD_STATUS_ID]: (input) => {
    const summary = boardStatus(goalOf(input));
    return { ok: true, data: { ...summary, op: "board.status" } };
  },
};

export class CcMasterBridge extends BaseCapabilityBridge {
  constructor(deps: BridgeDeps, sessionId: string, entries: CapabilityEntry[]) {
    super(CC_MASTER_SOURCE_ID, deps, sessionId, entries);
  }

  override async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    const handler = BOARD_HANDLERS[req.id];
    if (!handler) {
      // Workflow + skills (and anything else) take the standard base path.
      return super.invoke(req, ctx);
    }

    const entry = this.deps.getEntry(req.id) ?? this.getCapabilities().find((e) => e.id === req.id);
    if (!entry) {
      const audit = await this.deps.audit({
        type: "invoke",
        jti: ctx.jti,
        sessionId: ctx.sessionId,
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        capabilityId: req.id,
        outcome: "error",
        detail: { reason: "unknown_capability" },
      });
      return {
        id: req.id,
        ok: false,
        error: { code: "unknown_capability", message: `no such entry: ${req.id}`, capabilityId: req.id },
        auditId: audit.id,
      };
    }

    let result: TransportResult;
    try {
      result = handler(req.input ?? {});
    } catch (err) {
      const audit = await this.deps.audit({
        type: "invoke",
        jti: ctx.jti,
        sessionId: ctx.sessionId,
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        capabilityId: entry.id,
        verbs: entry.grants,
        outcome: "error",
        detail: { reason: "board_op_threw", op: req.id },
      });
      return {
        id: entry.id,
        ok: false,
        error: {
          code: "transport_error",
          message: err instanceof Error ? err.message : String(err),
          capabilityId: entry.id,
        },
        auditId: audit.id,
      };
    }

    const audit = await this.deps.audit({
      type: "invoke",
      jti: ctx.jti,
      sessionId: ctx.sessionId,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      capabilityId: entry.id,
      verbs: entry.grants,
      outcome: result.ok ? "ok" : "error",
      // Redaction-safe: the op name + kind only, never the goal text or board contents.
      detail: { transport: "in-process", kind: entry.kind, op: req.id },
    });
    return normalizeResult(entry.id, result, audit.id);
  }
}
