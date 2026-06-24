/**
 * Transport registry — the ONE sanctioned `TransportKind → Transport` mapping.
 *
 * Adding a transport = implement the `Transport` interface and register it here;
 * never edit callers (ADR-003). Callers resolve via `getTransport(kind)`; no
 * `switch (kind)` lives outside this module.
 */

import type { Transport, TransportKind } from "@plexus/protocol";
import type { PlatformServices } from "../platform/index.ts";
import { LocalRestTransport } from "./local-rest.ts";
import { StdioTransport } from "./stdio.ts";
import { IpcTransport } from "./ipc.ts";
import { McpClientTransport } from "./mcp.ts";
import { CliTransport } from "./cli.ts";
import { SkillTransport } from "./skill.ts";
import { WorkflowOrchestratorTransport } from "./workflow.ts";

export {
  LocalRestTransport,
  StdioTransport,
  IpcTransport,
  McpClientTransport,
  CliTransport,
  SkillTransport,
  WorkflowOrchestratorTransport,
};

/**
 * Build the full transport map for a platform. This is the SINGLE place every
 * `TransportKind` is bound to its implementation — the registry consults this.
 */
export function buildTransports(platform: PlatformServices): Record<TransportKind, Transport> {
  return {
    "local-rest": new LocalRestTransport(platform),
    stdio: new StdioTransport(platform),
    ipc: new IpcTransport(platform),
    mcp: new McpClientTransport(platform),
    cli: new CliTransport(platform),
    skill: new SkillTransport(),
    workflow: new WorkflowOrchestratorTransport(),
  };
}
