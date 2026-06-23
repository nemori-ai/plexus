/**
 * MOCK / EXAMPLE source module — the reference implementation of the two-layer
 * adapter contract, used by `tests/adapter-*` and as the worked example a real
 * first-party source (obsidian in t9, cc-master in t8) is built against.
 *
 * It is NOT registered in the production `MODULES` map (that stays empty until real
 * sources land); tests construct it directly. It exercises every shape:
 *   - a `capability` entry over the `cli` transport,
 *   - a `skill` entry (read-as-context, transport "skill"),
 *   - a `workflow` entry whose members resolve to present registry entries, so its
 *     transitive grants have real targets (ADR-012) and the workflow transport can
 *     fan out (ADR-013).
 *
 * The lifecycle source subclasses `BaseCapabilitySource`; the bridge subclasses
 * `BaseCapabilityBridge`. Both demonstrate the minimal surface a real source needs.
 */

import type {
  BridgeDeps,
  CapabilityBridge,
  CapabilityEntry,
  CapabilitySource,
  PlatformServices,
  SourceModule,
  SourceRequirementResult,
} from "../../protocol/index.ts";
import { BaseCapabilitySource, BaseCapabilityBridge } from "../base.ts";

export const MOCK_SOURCE_ID = "mock" as const;

/** The fixed entry set the mock source advertises (ids follow the derivation rule). */
export function mockEntries(): CapabilityEntry[] {
  const echo: CapabilityEntry = {
    id: "mock.echo.run",
    source: MOCK_SOURCE_ID,
    kind: "capability",
    label: "Echo",
    describe: "Echo the input back. Use when you need a no-op probe of the invoke path.",
    io: { input: { type: "object", properties: { text: { type: "string" } } } },
    grants: ["read"],
    transport: "cli",
    // Routing config consumed ONLY by the cli transport (core never reads extras).
    extras: { route: { bin: "echo", args: ["{text}"] } },
  };

  const note: CapabilityEntry = {
    id: "mock.note.write",
    source: MOCK_SOURCE_ID,
    kind: "capability",
    label: "Write note",
    describe: "Persist a note. Use when the agent must record durable state.",
    io: { input: { type: "object", properties: { body: { type: "string" } }, required: ["body"] } },
    grants: ["write"],
    transport: "cli",
    extras: { route: { bin: "true", args: [] } },
  };

  const skill: CapabilityEntry = {
    id: "mock.echo.howto",
    source: MOCK_SOURCE_ID,
    kind: "skill",
    label: "How to echo well",
    describe: "Usage guidance for mock.echo.run.",
    grants: [],
    transport: "skill",
    body: { format: "markdown", markdown: "# Echo\nPass `{ text }`; the string is returned verbatim." },
  };

  const workflow: CapabilityEntry = {
    id: "mock.pipeline.run",
    source: MOCK_SOURCE_ID,
    kind: "workflow",
    label: "Echo then write",
    describe: "Run echo, then write a note. Demonstrates transitive grants + fan-out.",
    grants: ["execute"],
    transport: "workflow",
    // Members MUST resolve to present registry entries (ADR-012). Verbs ⊆ member grants.
    members: [
      { id: "mock.echo.run", verbs: ["read"] },
      { id: "mock.note.write", verbs: ["write"] },
    ],
  };

  return [echo, note, skill, workflow];
}

class MockSource extends BaseCapabilitySource {
  readonly id = MOCK_SOURCE_ID;
  readonly label = "Mock source";
  readonly transport = "cli" as const;

  // Allow a test to flip availability + push a live entry-set change.
  constructor(private readonly _platform: PlatformServices) {
    super();
  }

  override async checkRequirements(): Promise<SourceRequirementResult> {
    return { ok: true, resolved: "mock (always available)" };
  }

  async scan(): Promise<CapabilityEntry[]> {
    return mockEntries();
  }

  /** Test hook: simulate a live `list_changed` by re-emitting the (same) entries. */
  triggerChange(): void {
    this.emitEntriesChanged(mockEntries());
  }
}

/** The mock source module — construct directly in tests; not in production MODULES. */
export const mockSourceModule: SourceModule = {
  id: MOCK_SOURCE_ID,
  label: "Mock source",
  transport: "cli",
  createSource(deps: PlatformServices): CapabilitySource {
    return new MockSource(deps);
  },
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge {
    return new BaseCapabilityBridge(MOCK_SOURCE_ID, deps, sessionId, mockEntries());
  },
};

export { MockSource };
