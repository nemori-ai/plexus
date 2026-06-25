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
} from "@plexus/runtime/sources/cc-master/board.ts";
import { CcMasterBridge } from "@plexus/runtime/sources/cc-master/bridge.ts";
import {
  ccMasterEntries,
  AGENT_DISPATCH_ID,
  BOARD_CREATE_ID,
  BOARD_STATUS_ID,
} from "@plexus/runtime/sources/cc-master/entries.ts";
import { CcMasterSource } from "@plexus/runtime/sources/index.ts";
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
} from "@plexus/protocol";

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
  // Boards now live under ~/.plexus/cc-master/ (PLEXUS_HOME-overridable) — NOT ~/.claude.
  claudeDir = mkdtempSync(join(tmpdir(), "plexus-ccm-board-"));
  prevEnv = process.env.PLEXUS_HOME;
  process.env.PLEXUS_HOME = claudeDir;
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.PLEXUS_HOME;
  else process.env.PLEXUS_HOME = prevEnv;
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
    // Headless cc-master launch is gated OFF by default (PLEXUS_CC_HEADLESS_LAUNCH unset),
    // so the dispatch is recorded on the board but the real spawn is skipped honestly.
    expect((d.output as { agentExecution: string }).agentExecution).toBe("recorded");
    expect((d.output as { launched: boolean }).launched).toBe(false);
    // The argv it WOULD spawn carries --plugin-dir <embedded> -p (the injection proof).
    const argv = (d.output as { argv: string[] }).argv;
    expect(argv).toContain("--plugin-dir");
    expect(argv).toContain("-p");

    const s = await bridge.invoke({ id: BOARD_STATUS_ID, input: { goal: "ship it" } }, ctx);
    expect(s.ok).toBe(true);
    expect((s.output as { dispatched: number }).dispatched).toBeGreaterThanOrEqual(1);
  });
});

describe("cc-master scan(): gated on checkRequirements()", () => {
  it("surfaces NO entries when `claude` is absent (orchestration runs inside CC)", async () => {
    const source = new CcMasterSource(platformStub(undefined), { loadCcMaster: true });
    expect((await source.checkRequirements()).ok).toBe(false);
    expect(await source.scan()).toEqual([]);
  });

  it("surfaces the full entry set when `claude` is present + loadCcMaster on", async () => {
    const source = new CcMasterSource(platformStub("/usr/local/bin/claude"), { loadCcMaster: true });
    expect((await source.checkRequirements()).ok).toBe(true);
    const entries = await source.scan();
    expect(entries.length).toBe(ccMasterEntries(true).length);
  });
});
