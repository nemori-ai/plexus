/**
 * ============================================================================
 * m4-user-workflow — the USER-authored DYNAMIC WORKFLOW manifest(s).
 * ============================================================================
 *
 * This is the user-facing authoring artifact for Plexus M4 section B (dynamic
 * workflows, `docs/extensions/USER-AUTHORING-DESIGN.md` §B + EXTENSION-SPEC §12.3).
 *
 * A user COMPOSES two EXISTING capabilities — both declared in the SAME manifest so
 * they enter the registry in one `scan()` (the §12.3 ordering rule) — into ONE new
 * higher-level `kind:"workflow"` capability. NOTHING here is a new gateway mechanism:
 * the workflow is a plain `ExtensionManifest` with `members[]`, registered through
 * the ONE `POST /extensions` path like any extension, invoked through the shipped
 * `WorkflowTransport` which fans out via the uniform invoke pipeline (ADR-013).
 *
 * The two member capabilities are backed by the `local-rest` transport pointed at a
 * LOOPBACK "journal" service the demo stands up (`server.ts`). Loopback is the only
 * egress the transport policy allows by default, so this is honest + confined:
 *   - `journal.entry.append` (write) → POST /entry  (mutates the journal log)
 *   - `journal.log.list`     (read)  → GET  /entries (reads the journal log back)
 *
 * The workflow:
 *   - `journal.note.log` (write) — composes [append(write), list(read)]. Granting it
 *     synthesizes the transitive member scopes (append/write + list/read), surfaced
 *     to the approver and stamped `synthesizedFor` into the token, so member dispatch
 *     is scope-checked through the SAME pipeline (no silent escalation).
 *
 * The same module also exports the GUARD manifests the example proves get REJECTED at
 * register time (a dangling member; a 2-cycle), so a user cannot author a workflow
 * that names a phantom member or recurses unbounded.
 */

import type { ExtensionManifest } from "../../src/protocol/index.ts";

/** Stable source id + the derived capability ids (ID-DERIVATION RULE: <source>.<name>). */
export const JOURNAL_SOURCE_ID = "journal" as const;
export const APPEND_ID = "journal.entry.append" as const;
export const LIST_ID = "journal.log.list" as const;
export const WORKFLOW_ID = "journal.note.log" as const;

/**
 * THE VALID COMPOSITION. A user writes this manifest. `baseUrl` is the loopback
 * journal service the demo booted; it is baked onto each member's `route` (read ONLY
 * by the local-rest transport, never by core).
 *
 * Two existing capabilities + a workflow composing them — co-declared so the workflow
 * members resolve to PRESENT entries in the same scan (§12.3).
 */
export function journalWorkflowManifest(baseUrl: string): ExtensionManifest {
  return {
    manifest: "plexus-extension/0.1",
    source: JOURNAL_SOURCE_ID,
    label: "Journal helpers",
    transport: "local-rest",
    capabilities: [
      // ── member #1: a real WRITE capability (POST /entry) ─────────────────────
      {
        name: "entry.append",
        kind: "capability",
        label: "Append a journal entry",
        describe:
          "Append a line of text to the journal log. Mutates the log ⇒ write. " +
          "Pass { text } — the line to append.",
        io: {
          input: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
        grants: ["write"],
        transport: "local-rest",
        route: { baseUrl, method: "POST", path: "/entry", bodyFrom: "input" },
      },
      // ── member #2: a real READ capability (GET /entries) ─────────────────────
      {
        name: "log.list",
        kind: "capability",
        label: "List journal entries",
        describe:
          "Read the whole journal log back. Read-only. Returns { entries, count }.",
        io: { input: { type: "object", properties: {} } },
        grants: ["read"],
        transport: "local-rest",
        route: { baseUrl, method: "GET", path: "/entries" },
      },
      // ── the COMPOSITION: a workflow over the two members above ───────────────
      {
        name: "note.log",
        kind: "workflow",
        label: "Log a note then read the journal back",
        describe:
          "Append a note to the journal, then read the journal back. Use to journal " +
          "an event and confirm it landed. Composes a write then a read ⇒ granting " +
          "this implies its members' write + read.",
        grants: ["write"],
        transport: "workflow",
        members: [
          { id: APPEND_ID, verbs: ["write"] },
          { id: LIST_ID, verbs: ["read"] },
        ],
      },
    ],
  };
}

/**
 * GUARD #1 — a DANGLING member. The workflow names a member id that no present
 * registry entry resolves to (`journal.entry.delete` is never declared). Registration
 * MUST reject it: a dangling member has no transitive-grant target and no dispatch
 * target (workflow-validate.ts rule 2 / security review must-fix #4).
 */
export function danglingMemberManifest(baseUrl: string): ExtensionManifest {
  return {
    manifest: "plexus-extension/0.1",
    source: JOURNAL_SOURCE_ID,
    label: "Journal helpers (dangling)",
    transport: "local-rest",
    capabilities: [
      {
        name: "entry.append",
        kind: "capability",
        label: "Append a journal entry",
        describe: "Append a line of text to the journal log. Mutates ⇒ write.",
        grants: ["write"],
        transport: "local-rest",
        route: { baseUrl, method: "POST", path: "/entry", bodyFrom: "input" },
      },
      {
        name: "note.log",
        kind: "workflow",
        label: "Log via a phantom member",
        describe: "Composes a present append with a member that does not exist.",
        grants: ["write"],
        transport: "workflow",
        members: [
          { id: APPEND_ID, verbs: ["write"] },
          // ↓ no entry with this id is ever declared/present → dangling → REJECT.
          { id: "journal.entry.delete", verbs: ["write"] },
        ],
      },
    ],
  };
}

/**
 * GUARD #2 — a CYCLE. Two workflows reference each other (A→B→A). The anti-cycle walk
 * is GLOBAL + re-run on every register, so even though A alone is acyclic, registering
 * B (which closes the loop back to A) MUST be rejected (workflow-validate.ts rule 1 /
 * the WorkflowTransport re-entry would otherwise recurse to a stack overflow).
 *
 * Both workflows + the leaf member are co-declared in ONE manifest so the cycle is
 * fully present in a single candidate set the validator sees.
 */
export function cyclicWorkflowManifest(baseUrl: string): ExtensionManifest {
  return {
    manifest: "plexus-extension/0.1",
    source: "loop",
    label: "Cyclic workflows",
    transport: "local-rest",
    capabilities: [
      {
        name: "leaf.run",
        kind: "capability",
        label: "A real leaf",
        describe: "A real read leaf so the workflows have a present member too.",
        grants: ["read"],
        transport: "local-rest",
        route: { baseUrl, method: "GET", path: "/entries" },
      },
      {
        name: "a.run",
        kind: "workflow",
        label: "Workflow A → B",
        describe: "Composes the leaf and workflow B.",
        grants: ["read"],
        transport: "workflow",
        members: [
          { id: "loop.leaf.run", verbs: ["read"] },
          { id: "loop.b.run", verbs: ["read"] },
        ],
      },
      {
        name: "b.run",
        kind: "workflow",
        label: "Workflow B → A (closes the cycle)",
        describe: "Composes the leaf and workflow A — A→B→A is a cycle.",
        grants: ["read"],
        transport: "workflow",
        members: [
          { id: "loop.leaf.run", verbs: ["read"] },
          { id: "loop.a.run", verbs: ["read"] },
        ],
      },
    ],
  };
}
