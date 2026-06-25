/**
 * cc-master BOARD primitives — the REAL, local, offline-executable operations that
 * back the orchestration workflow's three members (Acceptance Scenario A leaf).
 *
 * A cc-master orchestration board is a plain local JSON file living at
 * `<claudeDir>/cc-master/<boardId>.json`. Creating, reading, and recording dispatch
 * intent against that file are GENUINE local operations that do NOT need the LLM —
 * so the workflow's members can perform a real action and return `ok:true` honestly,
 * verifiable by reading the board file back off disk.
 *
 * HONEST BOUNDARY (`agent.dispatch`): the full LLM-driven agent run happens INSIDE
 * Claude Code once cc-master is loaded. Offline, we do NOT spawn a real background
 * agent (that would be a fake green). Instead `agent.dispatch` performs the real,
 * verifiable LOCAL half of a dispatch: it appends a `dispatched` node to the board
 * with a `pending` execution status and stamps the board's `updatedAt`. The board
 * file change is the genuine, readable artifact; the actual agent execution is
 * documented as deferred to Claude Code (see DEMO.md).
 *
 * SAFETY: the board directory lives under `~/.plexus/cc-master/` (NOT `~/.claude` —
 * Plexus never touches the user's Claude Code config). It is `PLEXUS_HOME`-overridable
 * (the SAME override the rest of the gateway state honors), so the demo + tests target
 * a TEMP `~/.plexus/cc-master/` and the real home is NEVER written unprompted. A
 * `claudeDir` arg is still accepted (now meaning "the base dir") so existing call
 * sites + tests keep working without churn.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { plexusHome } from "../../core/paths.ts";

/**
 * Resolve the base directory boards live under. Tests/callers may inject an explicit
 * dir (a temp dir); otherwise boards live under `~/.plexus` (PLEXUS_HOME-overridable).
 * This REPLACES the old `~/.claude` resolution — Plexus never touches `~/.claude`.
 */
function resolveBoardBase(baseDir?: string): string {
  if (baseDir) return baseDir;
  return plexusHome();
}

/** A single task/agent node tracked on the board. */
export interface BoardNode {
  /** Stable node id. */
  id: string;
  /** Human label / the task this node represents. */
  label: string;
  /** Coordination state of the node. */
  state: "ready" | "dispatched" | "blocked" | "done";
  /** Execution status of a dispatched node (the real local half of a dispatch). */
  execution?: "pending" | "running" | "succeeded" | "failed";
  /** When this node was last touched. */
  at: string;
}

/** The on-disk shape of a cc-master orchestration board. */
export interface CcMasterBoard {
  /** Schema marker so a board file is self-identifying. */
  kind: "cc-master.board";
  schemaVersion: 1;
  /** Stable board id (derived from the goal — same goal ⇒ same board). */
  boardId: string;
  /** The long-horizon goal this board tracks. */
  goal: string;
  createdAt: string;
  updatedAt: string;
  /** The task-dependency nodes (seeded on create, grown by dispatch). */
  nodes: BoardNode[];
}

/** A compact, non-sensitive status summary `board.status` returns. */
export interface BoardStatusSummary {
  boardId: string;
  goal: string;
  total: number;
  ready: number;
  dispatched: number;
  done: number;
  blocked: number;
  /** True when at least one node has been dispatched (orchestration underway). */
  underway: boolean;
  updatedAt: string;
}

/** Where board files live under the (injectable) base dir — `~/.plexus/cc-master/`. */
export function boardDir(claudeDir?: string): string {
  return join(resolveBoardBase(claudeDir), "cc-master");
}

/** The absolute path of a board file for a given boardId. */
export function boardPath(boardId: string, claudeDir?: string): string {
  return join(boardDir(claudeDir), `${boardId}.json`);
}

/**
 * Derive a STABLE boardId from a goal string, so the three members of a single
 * workflow fan-out (which all receive the same `{goal}` input) operate on the SAME
 * board. Short, filesystem-safe, deterministic.
 */
export function boardIdForGoal(goal: string): string {
  const slug =
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "board";
  const hash = createHash("sha256").update(goal).digest("hex").slice(0, 8);
  return `board-${slug}-${hash}`;
}

/** Atomic JSON write (`.tmp` then rename) so a crash never corrupts a board. */
function writeBoardAtomic(path: string, board: CcMasterBoard): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.plexus.tmp`;
  writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

/** Read a board file, or `undefined` when absent/malformed. */
export function readBoard(boardId: string, claudeDir?: string): CcMasterBoard | undefined {
  const path = boardPath(boardId, claudeDir);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as CcMasterBoard;
  } catch {
    return undefined;
  }
}

/**
 * board.create — REAL local op. Create (or no-op re-open) the board JSON for a goal
 * and seed it with a root node. Idempotent: re-creating the same goal returns the
 * existing board (so a re-run of the workflow does not clobber dispatched state).
 * Returns the boardId and the path actually written.
 */
export function createBoard(
  goal: string,
  claudeDir?: string,
): { boardId: string; path: string; created: boolean; board: CcMasterBoard } {
  const boardId = boardIdForGoal(goal);
  const path = boardPath(boardId, claudeDir);

  const existing = readBoard(boardId, claudeDir);
  if (existing) {
    return { boardId, path, created: false, board: existing };
  }

  const now = new Date().toISOString();
  const board: CcMasterBoard = {
    kind: "cc-master.board",
    schemaVersion: 1,
    boardId,
    goal,
    createdAt: now,
    updatedAt: now,
    nodes: [
      { id: "root", label: goal, state: "ready", at: now },
    ],
  };
  writeBoardAtomic(path, board);
  return { boardId, path, created: true, board };
}

/**
 * agent.dispatch — the REAL local half of a dispatch. Appends a `dispatched` node to
 * the board (a genuine, readable board mutation) with `execution:"pending"`, marking
 * intent to run a sub-agent. The ACTUAL agent run is deferred to Claude Code (honest
 * boundary — see this module's header + DEMO.md). Creates the board first if absent
 * (the member may be invoked standalone with just a goal).
 */
export function dispatchAgent(
  goal: string,
  node: string | undefined,
  claudeDir?: string,
): { boardId: string; path: string; nodeId: string; deferredTo: string } {
  const { boardId } = createBoard(goal, claudeDir);
  const board = readBoard(boardId, claudeDir)!;

  const now = new Date().toISOString();
  const dispatchedCount = board.nodes.filter((n) => n.state === "dispatched").length;
  const nodeId = `dispatch-${dispatchedCount + 1}`;
  board.nodes.push({
    id: nodeId,
    label: node && node.trim().length > 0 ? node : `advance: ${goal}`,
    state: "dispatched",
    execution: "pending",
    at: now,
  });
  board.updatedAt = now;
  writeBoardAtomic(boardPath(boardId, claudeDir), board);

  return {
    boardId,
    path: boardPath(boardId, claudeDir),
    nodeId,
    // HONEST: the local board records dispatch intent; the agent itself runs in CC.
    deferredTo: "claude-code",
  };
}

/**
 * board.status — REAL local read. Reads the board file off disk and returns a
 * compact status summary. Creates the board first if absent so a standalone status
 * read against a goal still returns a real (freshly-seeded) board rather than an
 * error.
 */
export function boardStatus(goal: string, claudeDir?: string): BoardStatusSummary {
  const { boardId } = createBoard(goal, claudeDir);
  const board = readBoard(boardId, claudeDir)!;

  const count = (s: BoardNode["state"]) => board.nodes.filter((n) => n.state === s).length;
  const dispatched = count("dispatched");
  return {
    boardId,
    goal: board.goal,
    total: board.nodes.length,
    ready: count("ready"),
    dispatched,
    done: count("done"),
    blocked: count("blocked"),
    underway: dispatched > 0,
    updatedAt: board.updatedAt,
  };
}

/** List the board ids present under the (injectable) claude dir — for diagnostics/tests. */
export function listBoards(claudeDir?: string): string[] {
  const dir = boardDir(claudeDir);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}
