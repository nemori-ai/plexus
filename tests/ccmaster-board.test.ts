/**
 * tp1 — cc-master REAL board operations + the green-leaf bridge + scan-gating.
 *
 * Proves the members are no longer hollow `cli` routes that return transport_error:
 *  - board.create / agent.dispatch / board.status are GENUINE local ops on a board
 *    JSON file under a TEMP `<claudeDir>/cc-master/` — asserted by reading the file
 *    back off disk (never trusting the return value),
 *  - the CcMasterBridge serves those members in-process and returns ok:true,
 *  - scan() is GATED on checkRequirements() (no `claude` ⇒ no entries),
 *  - create is idempotent (same goal ⇒ same board, dispatched state preserved).
 *
 * SAFETY: every test points `PLEXUS_CC_CLAUDE_DIR` at a fresh TEMP dir, so the real
 * `~/.claude/cc-master/` is NEVER touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  boardIdForGoal,
  boardPath,
  boardStatus,
  createBoard,
  dispatchAgent,
  listBoards,
  readBoard,
} from "../src/sources/cc-master/board.ts";
import { CcMasterBridge } from "../src/sources/cc-master/bridge.ts";
import {
  ccMasterEntries,
  AGENT_DISPATCH_ID,
  BOARD_CREATE_ID,
  BOARD_STATUS_ID,
} from "../src/sources/cc-master/entries.ts";
import { CcMasterSource } from "../src/sources/index.ts";
import type {
  AuditEvent,
  AuditEventInput,
  BridgeDeps,
  CapabilityId,
  InvokeContext,
  InvokeRequest,
  InvokeResponse,
  PlatformServices,
  Transport,
  TransportKind,
} from "../src/protocol/index.ts";

function platformStub(claudePath: string | undefined): PlatformServices {
  return {
    platform: "darwin",
    async resolveBinary(name) {
      return name === "claude" ? claudePath : undefined;
    },
    async getEnrichedPath() {
      return "/usr/bin";
    },
    async locateLocalService() {
      return undefined;
    },
    spawnProcess() {
      throw new Error("not used");
    },
    async resolveSecret() {
      return undefined;
    },
  };
}

let claudeDir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  claudeDir = mkdtempSync(join(tmpdir(), "plexus-ccm-board-"));
  prevEnv = process.env.PLEXUS_CC_CLAUDE_DIR;
  process.env.PLEXUS_CC_CLAUDE_DIR = claudeDir;
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.PLEXUS_CC_CLAUDE_DIR;
  else process.env.PLEXUS_CC_CLAUDE_DIR = prevEnv;
  rmSync(claudeDir, { recursive: true, force: true });
});

describe("cc-master board: real local primitives (verified by reading the file)", () => {
  it("createBoard writes a real board JSON; read back has the goal + a root node", () => {
    const goal = "ship plexus v1";
    const res = createBoard(goal);
    expect(res.created).toBe(true);
    expect(existsSync(res.path)).toBe(true);
    expect(res.path).toBe(boardPath(boardIdForGoal(goal)));

    const board = readBoard(res.boardId)!;
    expect(board.kind).toBe("cc-master.board");
    expect(board.goal).toBe(goal);
    expect(board.boardId).toBe(boardIdForGoal(goal));
    expect(board.nodes.some((n) => n.id === "root" && n.state === "ready")).toBe(true);
  });

  it("createBoard is idempotent: same goal ⇒ same board, dispatched state preserved", () => {
    const goal = "long horizon goal";
    const first = createBoard(goal);
    expect(first.created).toBe(true);

    dispatchAgent(goal, "do the thing");
    const second = createBoard(goal);
    expect(second.created).toBe(false);
    expect(second.boardId).toBe(first.boardId);

    const board = readBoard(second.boardId)!;
    expect(board.nodes.some((n) => n.state === "dispatched")).toBe(true);
    expect(listBoards()).toEqual([first.boardId]);
  });

  it("dispatchAgent records a real dispatched node (agent RUN honestly deferred)", () => {
    const goal = "parallelize the work";
    const res = dispatchAgent(goal, "node-A");
    const board = readBoard(res.boardId)!;
    const node = board.nodes.find((n) => n.id === res.nodeId)!;
    expect(node.state).toBe("dispatched");
    expect(node.execution).toBe("pending");
    expect(res.deferredTo).toBe("claude-code");
  });

  it("boardStatus reads a real summary off disk", () => {
    const goal = "summarize me";
    createBoard(goal);
    dispatchAgent(goal, undefined);
    const status = boardStatus(goal);
    expect(status.boardId).toBe(boardIdForGoal(goal));
    expect(status.goal).toBe(goal);
    expect(status.total).toBeGreaterThanOrEqual(2);
    expect(status.dispatched).toBeGreaterThanOrEqual(1);
    expect(status.underway).toBe(true);
  });
});

describe("cc-master bridge: members run as GREEN in-process board ops", () => {
  function makeBridge() {
    const entries = ccMasterEntries();
    const byId = new Map(entries.map((e) => [e.id, e]));
    const events: AuditEventInput[] = [];
    const audit = async (e: AuditEventInput): Promise<AuditEvent> => {
      events.push(e);
      return { ...e, id: `a-${events.length}`, at: new Date().toISOString() };
    };
    const invokeById = async (req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> =>
      bridge.invoke(req, ctx);
    const deps: BridgeDeps = {
      audit,
      getTransport: (_k: TransportKind): Transport => {
        throw new Error("members are in-process; no transport expected");
      },
      getEntry: (id: CapabilityId) => byId.get(id),
      invokeById,
    };
    const bridge = new CcMasterBridge(deps, "s1", entries);
    return { bridge, events };
  }

  const ctx: InvokeContext = { jti: "jti-1", sessionId: "s1", agentId: "agentX", scopes: [] };

  it("board.create member returns ok:true and creates a real board file", async () => {
    const { bridge, events } = makeBridge();
    const res = await bridge.invoke({ id: BOARD_CREATE_ID, input: { goal: "ship it" } }, ctx);
    expect(res.ok).toBe(true);
    const out = res.output as { boardId: string; op: string };
    expect(out.op).toBe("board.create");
    // Read the board back off disk — the honest green.
    const board = readBoard(out.boardId)!;
    expect(board.goal).toBe("ship it");
    // Exactly one audit, ok, redaction-safe (no goal text).
    expect(events.length).toBe(1);
    expect(events[0]!.outcome).toBe("ok");
    expect(JSON.stringify(events[0]!.detail)).not.toContain("ship it");
  });

  it("agent.dispatch + board.status members run ok in-process", async () => {
    const { bridge } = makeBridge();
    const d = await bridge.invoke({ id: AGENT_DISPATCH_ID, input: { goal: "ship it", node: "n1" } }, ctx);
    expect(d.ok).toBe(true);
    expect((d.output as { agentExecution: string }).agentExecution).toBe("deferred");

    const s = await bridge.invoke({ id: BOARD_STATUS_ID, input: { goal: "ship it" } }, ctx);
    expect(s.ok).toBe(true);
    expect((s.output as { dispatched: number }).dispatched).toBeGreaterThanOrEqual(1);
  });
});

describe("cc-master scan(): gated on checkRequirements()", () => {
  it("surfaces NO entries when `claude` is absent (orchestration runs inside CC)", async () => {
    const source = new CcMasterSource(platformStub(undefined), { claudeDir });
    expect((await source.checkRequirements()).ok).toBe(false);
    expect(await source.scan()).toEqual([]);
  });

  it("surfaces the full entry set when `claude` is present", async () => {
    const source = new CcMasterSource(platformStub("/usr/local/bin/claude"), { claudeDir });
    expect((await source.checkRequirements()).ok).toBe(true);
    const entries = await source.scan();
    expect(entries.length).toBe(ccMasterEntries().length);
  });
});
