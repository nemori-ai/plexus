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
 * Project a first-party compile-time `MODULES` entry to a (non-wireable) catalog
 * descriptor. The module's `transport` / `label` are read live; the blurb +
 * exposes-summary fall back to a generic first-party line, with a hand-tuned entry
 * for the known cc-master flagship (correctness over elegance for v1).
 */
function firstPartyDescriptor(mod: {
  id: string;
  label?: string;
  transport?: string;
}): ConnectorDescriptor {
  const known: Record<string, { blurb: string; exposesSummary: string }> = {
    "cc-master": {
      blurb: "Claude Code long-horizon orchestration — ships with Plexus",
      exposesSummary: "orchestrate · board create · agent dispatch · status",
    },
  };
  const meta = known[mod.id];
  return {
    kind: mod.id,
    label: mod.label ?? mod.id,
    blurb: meta?.blurb ?? `${mod.label ?? mod.id} — a first-party source that ships with Plexus`,
    provenanceClass: "first-party",
    transport: mod.transport ?? "ipc",
    detectable: false,
    wireable: false,
    fields: [],
    ...(meta?.exposesSummary ? { exposesSummary: meta.exposesSummary } : {}),
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
