/**
 * cc-master self-describe ENTRIES (managed-headless launch, v1).
 *
 * In the corrected domain model the CONNECTOR is Claude Code (a first-party app
 * Plexus launches + augments) and the SOURCE is a Plexus-managed launch profile
 * whose `loadCcMaster` config GATES this entry set. Plexus does NOT mutate the
 * user's `~/.claude`; it spawns `claude --plugin-dir <EMBEDDED cc-master>` headless
 * (see `launch.ts`), so the cc-master skills load into a Plexus-managed session.
 *
 * The capability set is GATED on `loadCcMaster`:
 *  - ALWAYS exposed: `cc-master.session.launch` — launch a managed headless Claude
 *    Code session (the base capability; honest even when cc-master is off).
 *  - WHEN loadCcMaster ON: the `cc-master.orchestration.run` WORKFLOW + its 3 MEMBER
 *    capability entries (board.create / agent.dispatch / board.status) + the cc-master
 *    SKILL entries. `agent.dispatch` now REALLY launches the embedded cc-master
 *    headless (see bridge.ts) rather than recording a deferred stub.
 *  - WHEN loadCcMaster OFF: NONE of the orchestration entries are exposed — only the
 *    base launch capability.
 *
 * The workflow's `members[]` resolve to present registry entries (transitive grants
 * have real targets, per the frozen `WorkflowMember` contract + ADR-012); the
 * workflow transport fans them out through the uniform invoke pipeline.
 */

import type { CapabilityEntry } from "@plexus/protocol";

/** Stable source id for the cc-master first-party adapter. */
export const CC_MASTER_SOURCE_ID = "cc-master" as const;

/** The base "launch a managed headless cc session" capability (ALWAYS exposed). */
export const SESSION_LAUNCH_ID = "cc-master.session.launch" as const;

/** The flagship workflow id (matches the canonical example + spec). */
export const ORCHESTRATION_RUN_ID = "cc-master.orchestration.run" as const;
export const BOARD_CREATE_ID = "cc-master.board.create" as const;
export const AGENT_DISPATCH_ID = "cc-master.agent.dispatch" as const;
export const BOARD_STATUS_ID = "cc-master.board.status" as const;

/** Skill entry ids (read-as-context usage knowledge). */
export const SKILL_ORCHESTRATING_ID = "cc-master.skill.orchestrating-to-completion" as const;
export const SKILL_AUTHORING_ID = "cc-master.skill.authoring-workflows" as const;
export const SKILL_AS_MASTER_ID = "cc-master.skill.as-master-orchestrator" as const;
export const SKILL_STATUS_ID = "cc-master.skill.status" as const;

const VERSION = "0.1.0";

/**
 * The flagship long-horizon orchestration WORKFLOW. Verbatim-aligned with
 * `docs/protocol/examples/cc-master.orchestration.run.json` (the canonical spec).
 */
function orchestrationRun(): CapabilityEntry {
  return {
    id: ORCHESTRATION_RUN_ID,
    source: CC_MASTER_SOURCE_ID,
    kind: "workflow",
    label: "Run a long-horizon orchestration",
    describe:
      "Turn the Claude Code main session into a long-horizon master orchestrator: build a task " +
      "dependency graph, dispatch sub-tasks in parallel, and resume across compaction and restarts " +
      "toward one large goal. Use when the goal is too big for a single session, needs parallel " +
      "agents, or must survive >24h. This is an EXECUTE capability: it launches and coordinates real " +
      "background work on the user's machine, so it requires explicit grant. Provide a clear `goal`; " +
      "optionally cap parallelism and set a pacing budget. It composes lower-level cc-master " +
      "capabilities (board create, agent dispatch, status) — granting this workflow implies you will " +
      "also be asked for its members' grants.",
    io: {
      input: {
        type: "object",
        properties: {
          goal: { type: "string", description: "The long-horizon objective to orchestrate toward." },
          maxParallel: { type: "integer", description: "Max concurrent background agents.", default: 4 },
          pacingBudget: { type: "string", description: "Optional time/cost budget hint, e.g. '48h'." },
        },
        required: ["goal"],
      },
      output: {
        type: "object",
        properties: {
          boardId: { type: "string", description: "The orchestration board id to track/resume." },
          status: { type: "string", enum: ["started", "queued"] },
        },
        required: ["boardId", "status"],
      },
    },
    grants: ["execute"],
    transport: "workflow",
    // Members MUST resolve to present registry entries (ADR-012). Verbs ⊆ member grants.
    members: [
      { id: BOARD_CREATE_ID, verbs: ["write"] },
      { id: AGENT_DISPATCH_ID, verbs: ["execute"] },
      { id: BOARD_STATUS_ID, verbs: ["read"] },
    ],
    skills: [
      { id: SKILL_ORCHESTRATING_ID, label: "Orchestrating to completion (pacing discipline)" },
      { id: SKILL_AS_MASTER_ID, label: "Initialize this session as the master orchestrator" },
    ],
    version: VERSION,
    extras: {
      firstParty: true,
      // The orchestration RUNS inside a Plexus-LAUNCHED Claude Code session: Plexus
      // spawns `claude --plugin-dir <embedded cc-master> -p ...` (see launch.ts),
      // never mutating ~/.claude. This entry describes + bootstraps that launch.
      runsIn: "claude-code",
      launchMode: "managed-headless",
    },
  };
}

/**
 * The orchestration members — the coordination primitives cc-master drives. They are
 * served by REAL in-process board operations (see `bridge.ts` + `board.ts`): a
 * cc-master board is a plain local JSON file, and board create/read/dispatch-record
 * are genuine local ops that do NOT need the LLM. The `CcMasterBridge` runs those
 * directly, so each member performs a real, file-verifiable action and returns
 * `ok:true` honestly. They are PRESENT registry entries so the workflow's transitive
 * grants have real targets, and the workflow fans out to them through the uniform
 * pipeline.
 *
 * `transport: "ipc"` marks them as in-process (local bridge) rather than an external
 * wire; the bridge intercepts these member ids and runs the board handler. Each takes
 * the orchestration `goal` (the workflow hands its input verbatim to every member),
 * which deterministically identifies the board they all operate on.
 *
 * HONEST BOUNDARY: `agent.dispatch` records dispatch intent on the board (a real,
 * readable board mutation) but defers the actual agent RUN to Claude Code — it never
 * fakes an executed agent offline.
 */
function boardCreate(): CapabilityEntry {
  return {
    id: BOARD_CREATE_ID,
    source: CC_MASTER_SOURCE_ID,
    kind: "capability",
    label: "Create an orchestration board",
    describe:
      "Create a cc-master orchestration board (the persistent task-dependency DAG the master " +
      "orchestrator advances). Use as the first step of an orchestration; returns a boardId to " +
      "dispatch agents against and resume. Mutates durable board state ⇒ requires write.",
    io: {
      input: {
        type: "object",
        properties: { goal: { type: "string", description: "The orchestration goal the board tracks." } },
        required: ["goal"],
      },
      output: {
        type: "object",
        properties: { boardId: { type: "string" } },
        required: ["boardId"],
      },
    },
    grants: ["write"],
    transport: "ipc",
    version: VERSION,
    extras: { firstParty: true, route: { op: "board.create" } },
  };
}

function agentDispatch(): CapabilityEntry {
  return {
    id: AGENT_DISPATCH_ID,
    source: CC_MASTER_SOURCE_ID,
    kind: "capability",
    label: "Dispatch a background agent",
    describe:
      "Dispatch a cc-master sub-agent against a board node — the unit of parallel long-horizon work. " +
      "Plexus REALLY launches the embedded cc-master plugin in a headless Claude Code session " +
      "(`claude --plugin-dir <embedded> -p <node/goal>`, never touching ~/.claude) and returns its " +
      "output. Records the dispatch on the local board too. Launches a real process ⇒ requires execute.",
    io: {
      input: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "The orchestration goal (identifies the board to dispatch against).",
          },
          node: { type: "string", description: "The board node / task to run." },
        },
        required: ["goal"],
      },
    },
    grants: ["execute"],
    transport: "ipc",
    version: VERSION,
    extras: { firstParty: true, route: { op: "agent.dispatch" } },
  };
}

function boardStatus(): CapabilityEntry {
  return {
    id: BOARD_STATUS_ID,
    source: CC_MASTER_SOURCE_ID,
    kind: "capability",
    label: "Read orchestration board status",
    describe:
      "Read a cc-master board's progress, blockers, and pending user decisions. Use to pace the " +
      "orchestration and decide what to dispatch next. Non-mutating ⇒ read-only.",
    io: {
      input: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "The orchestration goal (identifies the board to inspect).",
          },
        },
        required: ["goal"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    version: VERSION,
    extras: { firstParty: true, route: { op: "board.status" } },
  };
}

/**
 * cc-master SKILL entries — agent-facing usage knowledge (read-as-context). These
 * mirror the real skills the installed plugin ships. They carry a short inline
 * body teaser; the full skill body lives in Claude Code once cc-master is loaded.
 */
function skill(
  id: string,
  label: string,
  describe: string,
  markdown: string,
): CapabilityEntry {
  return {
    id,
    source: CC_MASTER_SOURCE_ID,
    kind: "skill",
    label,
    describe,
    grants: [],
    transport: "skill",
    body: { format: "markdown", markdown },
    version: VERSION,
    extras: { firstParty: true },
  };
}

function skillEntries(): CapabilityEntry[] {
  return [
    skill(
      SKILL_ORCHESTRATING_ID,
      "Orchestrating to completion (pacing discipline)",
      "Usage guidance for cc-master.orchestration.run: the master-orchestrator pacing discipline — " +
        "never idle-wait when dispatchable work exists, never manufacture busywork, never pick up the " +
        "instrument yourself, and never auto-decide an irreversible/merge step the user should own.",
      "# Orchestrating to completion\nRun a long-horizon goal as a master orchestrator. After every " +
        "compaction, re-read this. Don't idle-spin and don't fake-busy: dispatch ready DAG nodes, keep " +
        "the critical path advancing, and escalate user-owned decisions instead of deciding them.",
    ),
    skill(
      SKILL_AS_MASTER_ID,
      "Initialize this session as the master orchestrator",
      "Usage guidance: how to initialize the current Claude Code session as a cc-master long-horizon " +
        "master orchestrator for a given goal (build the board, set pacing budget, begin dispatch).",
      "# As master orchestrator\nInitialize the session against a goal: create the board, seed the " +
        "task DAG, set a pacing budget, then drive dispatch via board.status → agent.dispatch loops.",
    ),
    skill(
      SKILL_AUTHORING_ID,
      "Authoring dynamic workflows",
      "Usage guidance: how to author / debug / launch a Claude Code dynamic-workflow script for " +
        "cc-master. Consult before reaching for parallel()/pipeline() — verify determinism + resume " +
        "rules rather than guessing.",
      "# Authoring workflows\nA dynamic workflow takes the 'what runs next' decision away from the LLM " +
        "and hands it to a deterministic script. Check the engine's determinism + resume contract " +
        "before composing parallel()/pipeline().",
    ),
    skill(
      SKILL_STATUS_ID,
      "Render a board status summary",
      "Usage guidance: render a cc-master board summary — progress, blockers, critical-path estimate, " +
        "and decisions awaiting the user.",
      "# Status\nRender the active board: progress, blockers, an estimated critical path, and the " +
        "decisions parked awaiting a user verdict.",
    ),
  ];
}

/**
 * The base "launch a managed headless Claude Code session" capability. ALWAYS
 * exposed (even when `loadCcMaster` is off) because it is the honest minimum of the
 * Claude Code connector: Plexus can spawn the user's `claude` binary headless. When
 * `loadCcMaster` is on the launch injects the embedded cc-master plugin; when off it
 * is a plain managed `claude -p` run. EXECUTE — it runs a real process on the machine.
 */
function sessionLaunch(): CapabilityEntry {
  return {
    id: SESSION_LAUNCH_ID,
    source: CC_MASTER_SOURCE_ID,
    kind: "capability",
    label: "Launch a managed headless Claude Code session",
    describe:
      "Launch a Plexus-managed headless Claude Code session (`claude -p`) and return its output. " +
      "When the launch profile has cc-master enabled, the embedded cc-master plugin is injected via " +
      "`--plugin-dir` WITHOUT touching the user's ~/.claude — so the orchestration plugin loads into a " +
      "Plexus-launched session. Runs a real process on the machine ⇒ requires execute.",
    io: {
      input: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The prompt handed to the headless `claude -p` run." },
        },
        required: ["prompt"],
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          output: { type: "string" },
          exitCode: { type: "integer" },
        },
        required: ["ok"],
      },
    },
    grants: ["execute"],
    transport: "ipc",
    version: VERSION,
    extras: { firstParty: true, route: { op: "session.launch" } },
  };
}

/**
 * The cc-master entry set, GATED on `loadCcMaster`:
 *  - loadCcMaster ON  → base launch + orchestration workflow + 3 members + skills.
 *  - loadCcMaster OFF → ONLY the base launch capability (no orchestration surface).
 *
 * The source's `scan()` reads the persisted launch-profile config and passes the
 * gate here, so flipping the admin toggle + re-scanning re-gates the capabilities.
 */
export function ccMasterEntries(loadCcMaster = true): CapabilityEntry[] {
  if (!loadCcMaster) {
    return [sessionLaunch()];
  }
  return [
    sessionLaunch(),
    orchestrationRun(),
    boardCreate(),
    agentDispatch(),
    boardStatus(),
    ...skillEntries(),
  ];
}
