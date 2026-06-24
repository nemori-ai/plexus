/**
 * Connector catalog assembler — "What Plexus can connect to".
 *
 * Builds the `ConnectorDescriptor[]` the admin UI (`GET /admin/api/connectors`)
 * renders, from two registry-style sources (no `if (kind === …)` branching):
 *
 *   1. MANAGED kinds — every `SourceKindAdapter` in `SOURCE_KINDS` that ships a
 *      `descriptor` (obsidian-rest, obsidian-fs). These are WIREABLE: the user can
 *      create a new instance via the dynamic form.
 *
 *   2. FIRST-PARTY builtins — the compile-time `MODULES` (e.g. cc-master). These are
 *      what Plexus SHIPS with; they are NOT wireable (no per-machine route/secret to
 *      enter — they self-register in-process), so their descriptors carry
 *      `wireable:false`, `fields:[]`, `provenanceClass:"first-party"`. Derived from the
 *      live module list so the catalog stays in lockstep with what actually ships.
 *
 * Pure advisory data — never a secret value, never a registration. The catalog only
 * tells the UI what CAN be connected; adding an instance is the separate, human-
 * approved `POST /admin/api/sources` path.
 */

import { MODULES } from "../index.ts";
import type { ConnectorDescriptor } from "./connector-descriptor.ts";
import { SOURCE_KINDS } from "./kinds.ts";

/**
 * Project a first-party compile-time `MODULES` entry to a catalog descriptor.
 *
 * The module's `transport` / `label` are read live. cc-master gets a hand-tuned,
 * CONFIGURABLE descriptor: it is the "Claude Code" connector (a first-party app
 * Plexus launches headless with the embedded plugin) and carries a single
 * `loadCcMaster` TOGGLE field (default on) that GATES its orchestration capabilities.
 * It is `wireable:true` so the WHAT-I-EXPOSE form renders the toggle, but the toggle
 * persists via the dedicated `POST /admin/api/cc-master/config` route (it is a
 * first-party launch profile, not a generic `SourceKindAdapter` source). Other
 * first-party modules fall back to a generic informational (non-wireable) descriptor.
 */
function firstPartyDescriptor(mod: {
  id: string;
  label?: string;
  transport?: string;
}): ConnectorDescriptor {
  if (mod.id === "cc-master") {
    return {
      kind: "cc-master",
      label: "Claude Code",
      blurb:
        "Claude Code, launched headless by Plexus with the embedded cc-master plugin injected — " +
        "your ~/.claude is never touched",
      provenanceClass: "first-party",
      transport: mod.transport ?? "workflow",
      detectable: true,
      wireable: true,
      exposesSummary: "orchestrate via a Plexus-launched cc-master session",
      fields: [
        {
          name: "loadCcMaster",
          label: "Load cc-master orchestration",
          type: "toggle",
          required: false,
          default: "true",
          help:
            "When on, Plexus launches `claude --plugin-dir <embedded cc-master>` and exposes the " +
            "orchestration capabilities. When off, only a base managed-launch capability is exposed.",
          target: "route",
        },
      ],
    };
  }
  return {
    kind: mod.id,
    label: mod.label ?? mod.id,
    blurb: `${mod.label ?? mod.id} — a first-party source that ships with Plexus`,
    provenanceClass: "first-party",
    transport: mod.transport ?? "ipc",
    detectable: false,
    wireable: false,
    fields: [],
  };
}

/**
 * Assemble the full connector catalog: managed-kind descriptors (wireable) followed
 * by first-party builtin descriptors (informational). De-duplicated by kind — a
 * managed kind adapter wins over a same-id builtin (none collide today).
 */
export function connectorCatalog(): ConnectorDescriptor[] {
  const out: ConnectorDescriptor[] = [];
  const seen = new Set<string>();

  // 1. Managed, wireable kinds (those that ship a descriptor).
  for (const kind of SOURCE_KINDS) {
    const d = kind.descriptor;
    if (d && !seen.has(d.kind)) {
      out.push(d);
      seen.add(d.kind);
    }
  }

  // 2. First-party builtins (cc-master, …) — what Plexus ships with, not wireable.
  for (const mod of MODULES) {
    if (seen.has(mod.id)) continue;
    // `SourceModule` carries id; label/transport are read best-effort off the module.
    const m = mod as { id: string; label?: string; transport?: string };
    out.push(firstPartyDescriptor(m));
    seen.add(mod.id);
  }

  return out;
}
