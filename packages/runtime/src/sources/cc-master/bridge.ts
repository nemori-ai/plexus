/**
 * cc-master PER-SESSION bridge (managed-headless launch, v1).
 *
 * Identical to `BaseCapabilityBridge` for the orchestration WORKFLOW (it delegates
 * to the workflow transport, which fans out across the members via the uniform
 * pipeline) and for the SKILL entries — but the coordination members + the base
 * launch capability are served by REAL in-process handlers:
 *
 *  - `cc-master.session.launch` — REALLY launches a Plexus-managed headless Claude
 *    Code session (`claude -p`, with the embedded cc-master plugin injected via
 *    `--plugin-dir` when the profile loads cc-master), captures its output, and
 *    returns it. Never touches ~/.claude.
 *  - `cc-master.agent.dispatch` — REALLY launches the embedded cc-master headless
 *    with the goal/node as the prompt (honest: "dispatched to a Plexus-launched
 *    cc-master headless session", with its real output) AND records the dispatch on
 *    the local board. This replaces the old `agentExecution:"deferred"` stub.
 *  - `cc-master.board.create` / `cc-master.board.status` — REAL local board ops (a
 *    cc-master board is a plain local JSON file; create/read are genuine local ops).
 *
 * This mirrors the Obsidian `ExtensionBridge` in-process-handler pattern: a
 * capability best served by gateway-owned local code runs that code directly and the
 * bridge only normalizes + audits the result. The workflow transport re-enters
 * through the SAME `invokeById` pipeline, so each member dispatch is still
 * scope-checked + audited before it reaches us.
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
  SESSION_LAUNCH_ID,
} from "./entries.ts";
import { boardStatus, createBoard, dispatchAgent } from "./board.ts";
import { ClaudeLauncher } from "./launch.ts";
import { getPlatformServices } from "../../platform/index.ts";

/** A member's in-process handler: input → real local op / launch → TransportResult. */
type BoardHandler = (
  input: Record<string, unknown>,
  launcher: ClaudeLauncher,
) => TransportResult | Promise<TransportResult>;

/**
 * SAFETY GATE: a real headless cc-master launch (its hooks bootstrap an orchestration
 * — creating boards etc.) is OPT-IN via `PLEXUS_CC_HEADLESS_LAUNCH=1`. Default OFF so
 * automated tests + the e2e demo NEVER auto-spawn the real embedded cc-master plugin
 * (the guardrail). When off, `session.launch` / `agent.dispatch` do the real LOCAL
 * half (record the board) and report the headless launch as not performed, honestly.
 */
function headlessLaunchEnabled(): boolean {
  return process.env.PLEXUS_CC_HEADLESS_LAUNCH === "1";
}

function goalOf(input: Record<string, unknown>): string {
  const g = input.goal;
  return typeof g === "string" && g.trim().length > 0 ? g : "untitled orchestration";
}

function promptOf(input: Record<string, unknown>): string {
  const p = input.prompt;
  return typeof p === "string" && p.trim().length > 0 ? p : "";
}

/**
 * The in-process handler for each member id. Board ops run gateway-owned local code;
 * `session.launch` + `agent.dispatch` REALLY launch a Plexus-managed headless Claude
 * Code session via the injected `ClaudeLauncher`. None touch ~/.claude.
 */
const HANDLERS: Record<string, BoardHandler> = {
  [SESSION_LAUNCH_ID]: async (input, launcher) => {
    const prompt = promptOf(input);
    if (!prompt) {
      return { ok: false, error: { code: "schema_validation_failed", message: "`prompt` is required" } };
    }
    // SAFETY GATE: only really spawn when explicitly enabled (the guardrail).
    if (!headlessLaunchEnabled()) {
      return {
        ok: true,
        data: {
          op: "session.launch",
          launched: false,
          argv: launcher.argvFor(true, prompt),
          note: "headless launch disabled (set PLEXUS_CC_HEADLESS_LAUNCH=1 to spawn a real managed cc session)",
        },
      };
    }
    // Real managed headless launch — cc-master injected via --plugin-dir; ~/.claude untouched.
    const res = await launcher.launch({ loadCcMaster: true, prompt });
    return {
      ok: res.ok,
      data: {
        op: "session.launch",
        launched: true,
        ccMasterLoaded: res.ccMasterLoaded,
        exitCode: res.exitCode,
        output: res.output,
        ...(res.reason ? { reason: res.reason } : {}),
      },
      ...(res.ok ? {} : { error: { code: "transport_error", message: res.reason ?? "launch failed" } }),
    };
  },
  [BOARD_CREATE_ID]: (input) => {
    const { boardId, path, created } = createBoard(goalOf(input));
    return { ok: true, data: { boardId, path, created, op: "board.create" } };
  },
  [AGENT_DISPATCH_ID]: async (input, launcher) => {
    const goal = goalOf(input);
    const node = typeof input.node === "string" ? input.node : undefined;
    // REAL local half: record the dispatch on the board (a genuine, readable mutation).
    const rec = dispatchAgent(goal, node);
    const prompt = node && node.trim().length > 0 ? node : goal;

    // SAFETY GATE: only really spawn the embedded cc-master headless when explicitly
    // enabled. Default OFF so automated tests/demo never bootstrap a real orchestration.
    if (!headlessLaunchEnabled()) {
      return {
        ok: true,
        data: {
          boardId: rec.boardId,
          path: rec.path,
          dispatchedNode: rec.nodeId,
          agentExecution: "recorded",
          launchMode: "managed-headless",
          launched: false,
          argv: launcher.argvFor(true, prompt),
          note: "dispatch recorded on board; headless cc-master launch disabled (set PLEXUS_CC_HEADLESS_LAUNCH=1)",
          op: "agent.dispatch",
        },
      };
    }

    // REAL agent run: launch the embedded cc-master headless with the node/goal prompt.
    const launch = await launcher.launch({ loadCcMaster: true, prompt });
    return {
      ok: launch.ok,
      data: {
        boardId: rec.boardId,
        path: rec.path,
        dispatchedNode: rec.nodeId,
        // HONEST: dispatched to a Plexus-LAUNCHED cc-master headless session (real run).
        agentExecution: "launched",
        launchMode: "managed-headless",
        launched: true,
        ccMasterLoaded: launch.ccMasterLoaded,
        exitCode: launch.exitCode,
        output: launch.output,
        op: "agent.dispatch",
        ...(launch.reason ? { reason: launch.reason } : {}),
      },
      ...(launch.ok
        ? {}
        : { error: { code: "transport_error", message: launch.reason ?? "cc-master launch failed" } }),
    };
  },
  [BOARD_STATUS_ID]: (input) => {
    const summary = boardStatus(goalOf(input));
    return { ok: true, data: { ...summary, op: "board.status" } };
  },
};

export class CcMasterBridge extends BaseCapabilityBridge {
  private readonly launcher: ClaudeLauncher;

  constructor(deps: BridgeDeps, sessionId: string, entries: CapabilityEntry[], launcher?: ClaudeLauncher) {
    super(CC_MASTER_SOURCE_ID, deps, sessionId, entries);
    // Inject the launcher (tests substitute a fake-spawn launcher). Default: resolve
    // `claude` through the live platform seam + spawn-and-capture the real headless run.
    this.launcher =
      launcher ??
      new ClaudeLauncher({
        resolveBinary: (name) => getPlatformServices().resolveBinary(name),
      });
  }

  override async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    const handler = HANDLERS[req.id];
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
      result = await handler(req.input ?? {}, this.launcher);
    } catch (err) {
      const audit = await this.deps.audit({
        type: "invoke",
        jti: ctx.jti,
        sessionId: ctx.sessionId,
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        capabilityId: entry.id,
        verbs: entry.grants,
        outcome: "error",
        detail: { reason: "handler_threw", op: req.id },
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
      // Redaction-safe: the op name + kind only, never the goal/prompt text or output.
      detail: { transport: "in-process", kind: entry.kind, op: req.id },
    });
    return normalizeResult(entry.id, result, audit.id);
  }
}
