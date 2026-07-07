/**
 * Workspace self-describe ENTRIES (first-party source).
 *
 * The `workspace` source exposes ONE authorized directory on the owner's machine as a
 * path-confined filesystem surface:
 *   - READ/LIST — `workspace.list`, `workspace.read`, both `grants:["read"]` (auto-grant,
 *     lightweight). Path-confined to the authorized dir (the same lexical + realpath
 *     defense used by the Obsidian vault reader).
 *   - WRITE — `workspace.write`, `grants:["write"]`. A path-confined write that, because
 *     it is a write grant on a FIRST-PARTY source, PENDS for the owner automatically via
 *     `UserConfirmAuthorizer` (this source writes NO authz code).
 *
 * All capability entries are `transport:"ipc"` (in-process / local bridge) and carry an
 * `extras.route.op` the bridge intercepts to drive the injected WorkspaceProvider
 * directly (mirroring the Things in-process-handler pattern — the bridge runs gateway-
 * owned local code and only normalizes + audits; the ipc wire is never reached). A
 * `workspace.how-to-use` SKILL ships the usage guide.
 *
 * MULTI-INSTANCE: every builder is PARAMETERIZED by `sourceId` (default: the reserved
 * compile-time `workspace` singleton). A managed `workspace-dir` instance materializes
 * the SAME entry set under its OWN source id — ids, `extras.route.op`, and the skill
 * back-link all derive from the instance's id, so two directory sources never collide
 * on capability ids nor intercept each other's ops.
 *
 * The id-derivation rule holds: `<sourceId>.<verb>` — the source is recoverable from
 * the id, and ids are unique.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CapabilityEntry, SourceId } from "@plexus/protocol";

/** Stable source id for the workspace first-party adapter (the env-driven singleton). */
export const WORKSPACE_SOURCE_ID = "workspace" as const;

/** Capability + skill ids (id-derivation: workspace.<verb>) — the SINGLETON's ids. */
export const WORKSPACE_LIST_ID = "workspace.list" as const;
export const WORKSPACE_READ_ID = "workspace.read" as const;
export const WORKSPACE_WRITE_ID = "workspace.write" as const;
export const WORKSPACE_HOW_TO_USE_ID = "workspace.how-to-use" as const;

/** The handler op names the bridge intercepts (carried on extras.route.op). */
export const OP_WORKSPACE_LIST = "workspace.list" as const;
export const OP_WORKSPACE_READ = "workspace.read" as const;
export const OP_WORKSPACE_WRITE = "workspace.write" as const;

/** The per-instance verb suffixes (id = `<sourceId>.<suffix>`). */
export const WORKSPACE_VERB_LIST = "list" as const;
export const WORKSPACE_VERB_READ = "read" as const;
export const WORKSPACE_VERB_WRITE = "write" as const;
export const WORKSPACE_VERB_HOW_TO_USE = "how-to-use" as const;

const VERSION = "0.1.0";

/** Load the bundled how-to-use skill body from disk (alongside this file). */
function loadHowToSkill(): string {
  try {
    const here = fileURLToPath(new URL("./skills/how-to-use-workspace.md", import.meta.url));
    return readFileSync(here, "utf-8");
  } catch {
    return (
      "# How to use the Workspace\n" +
      "List a directory with `workspace.list` ({ path? }); read a file with " +
      "`workspace.read` ({ path }); write a file with `workspace.write` ({ path, content }) " +
      "— write PENDS for the owner's approval. All paths are confined to ONE authorized " +
      "directory; traversal/absolute/symlink-escape is rejected."
    );
  }
}

/** The display noun used in describe text ("workspace" for the singleton; the label otherwise). */
function nounFor(sourceId: SourceId, label?: string): string {
  // NB: the describe templates append " directory" themselves — this returns the bare
  // noun only (no trailing "directory"), so a managed instance reads "...authorized
  // \"Notes\" directory." and the singleton reads "...authorized workspace directory."
  if (sourceId === WORKSPACE_SOURCE_ID) return "workspace";
  return label ? `"${label}"` : `"${sourceId}"`;
}

/** LIST: enumerate a directory inside the authorized workspace (read-only). */
function workspaceList(sourceId: SourceId, label?: string): CapabilityEntry {
  const noun = nounFor(sourceId, label);
  return {
    id: `${sourceId}.${WORKSPACE_VERB_LIST}`,
    source: sourceId,
    kind: "capability",
    label: "List workspace directory",
    describe:
      `List a directory inside the user's authorized ${noun} directory. READ-ONLY and ` +
      "path-confined — every path is resolved under the workspace root and rejected if it " +
      "escapes (`..`, absolute, or symlink-out). Pass `{ path }` relative to the workspace " +
      "root (omit or '' to list the root). Use it to discover what files exist before you " +
      "read or write.",
    io: {
      input: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Workspace-relative directory to list, e.g. 'refs'. Omit or '' to list the root.",
          },
        },
      },
      output: {
        type: "object",
        properties: {
          type: { type: "string", description: "Always 'dir'." },
          relativePath: { type: "string" },
          entries: {
            type: "array",
            description: "Directory entries: { name, relativePath, kind: 'file' | 'dir' }.",
          },
        },
        required: ["type", "entries"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: `${sourceId}.${WORKSPACE_VERB_HOW_TO_USE}`, label: "How to use the Workspace" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: `${sourceId}.${WORKSPACE_VERB_LIST}` } },
  };
}

/** READ: read a file inside the authorized workspace (read-only). */
function workspaceRead(sourceId: SourceId, label?: string): CapabilityEntry {
  const noun = nounFor(sourceId, label);
  return {
    id: `${sourceId}.${WORKSPACE_VERB_READ}`,
    source: sourceId,
    kind: "capability",
    label: "Read workspace file",
    describe:
      `Read a file inside the user's authorized ${noun} directory. READ-ONLY and ` +
      "path-confined — every path is resolved under the workspace root and rejected if it " +
      "escapes (`..`, absolute, or symlink-out). Pass `{ path }` relative to the workspace " +
      "root, e.g. 'me.md'. Use it to read the user's files to answer, summarize, or build on.",
    io: {
      input: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file to read, e.g. 'refs/notes.md'.",
          },
        },
        required: ["path"],
      },
      output: {
        type: "object",
        properties: {
          type: { type: "string", description: "Always 'file'." },
          relativePath: { type: "string" },
          content: { type: "string", description: "UTF-8 file content." },
          bytes: { type: "number" },
          modifiedAt: { type: "string" },
        },
        required: ["type", "content"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: `${sourceId}.${WORKSPACE_VERB_HOW_TO_USE}`, label: "How to use the Workspace" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: `${sourceId}.${WORKSPACE_VERB_READ}` } },
  };
}

/** WRITE: write/overwrite a file inside the authorized workspace. PENDS for the owner. */
function workspaceWrite(sourceId: SourceId, label?: string): CapabilityEntry {
  const noun = nounFor(sourceId, label);
  return {
    id: `${sourceId}.${WORKSPACE_VERB_WRITE}`,
    source: sourceId,
    kind: "capability",
    label: "Write workspace file",
    describe:
      `Write (create or overwrite) a file inside the user's authorized ${noun} directory. ` +
      "Path-confined — every path is resolved under the workspace root and rejected if it " +
      "escapes (`..`, absolute, or symlink-out). Pass `{ path, content }`: a workspace-relative " +
      "path + UTF-8 text body. Mutates the user's files ⇒ requires write; on this first-party " +
      "source a write grant PENDS for the owner's approval — call it, then wait for approval.",
    io: {
      input: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file to write, e.g. 'PRD.html'.",
          },
          content: {
            type: "string",
            description: "The UTF-8 text content to write to the file.",
          },
        },
        required: ["path", "content"],
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          relativePath: { type: "string" },
          bytes: { type: "number", description: "Bytes written." },
        },
        required: ["ok"],
      },
    },
    grants: ["write"],
    transport: "ipc",
    skills: [{ id: `${sourceId}.${WORKSPACE_VERB_HOW_TO_USE}`, label: "How to use the Workspace" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: `${sourceId}.${WORKSPACE_VERB_WRITE}` } },
  };
}

/** The how-to-use SKILL (read-as-context usage knowledge). */
function howToUseSkill(sourceId: SourceId): CapabilityEntry {
  return {
    id: `${sourceId}.${WORKSPACE_VERB_HOW_TO_USE}`,
    source: sourceId,
    kind: "skill",
    label: "How to use the Workspace",
    describe:
      "Usage guidance for the workspace capabilities: list/read files inside one authorized " +
      "directory (read, auto-grant), and write files (write — PENDS for the owner). All paths " +
      "are path-confined to the authorized dir. Read-as-context; not invoked over a wire.",
    grants: [],
    transport: "skill",
    body: { format: "markdown", markdown: loadHowToSkill() },
    version: VERSION,
    extras: { firstParty: true },
  };
}

/**
 * The workspace entry set: two READ capabilities (list + read), one WRITE capability,
 * and the how-to-use skill. UNGATED — availability (does the authorized dir exist?) is
 * reported via HEALTH (provider.available()), not by hiding entries.
 *
 * `sourceId` defaults to the compile-time `workspace` singleton (byte-identical output
 * to the pre-multi-instance builder); a managed `workspace-dir` instance passes its own
 * id (+ optional label for the describe noun) so its ids/ops/skill-refs are re-keyed.
 */
export function workspaceEntries(
  sourceId: SourceId = WORKSPACE_SOURCE_ID,
  label?: string,
): CapabilityEntry[] {
  return [
    workspaceList(sourceId, label),
    workspaceRead(sourceId, label),
    workspaceWrite(sourceId, label),
    howToUseSkill(sourceId),
  ];
}
