/**
 * ============================================================================
 * M4 USER CUSTOM-SKILL — the authored manifests (Flow A, USER-AUTHORING-DESIGN §A).
 * ============================================================================
 *
 * A user authoring "how to use capability X well" knowledge is just an
 * `ExtensionManifest` carrying `kind:"skill"` entries. There is NO second
 * mechanism: a custom skill registers through the SAME `POST /extensions` /
 * `registerExtension` path as any extension (EXTENSION-SPEC §9). These two
 * manifests are the worked artifacts the example + tests register.
 *
 * The design distinguishes two attach shapes (USER-AUTHORING-DESIGN §A.3):
 *
 *   (a) SAME-SOURCE attach — the skill is authored in the SAME extension that
 *       owns the capability it teaches, back-linked via `route.attachSkills`.
 *       `manifestEntries()` wires it freely (no security gate): the author can
 *       only teach their OWN capability, so there is no cross-source trust
 *       boundary to cross. This is the Obsidian `vault.read` ↔ `vault.how-to-cite`
 *       pattern, but authored by the user.
 *
 *   (b) CROSS-SOURCE attach — the skill attaches onto an EXISTING capability
 *       owned by a DIFFERENT source (here the first-party `obsidian.vault.read`),
 *       declared via `route.attachTo: ["<foreign-capability-id>"]`. This is a
 *       prompt-injection channel (a free-text body steering a powerful trusted
 *       capability), so it is DEFAULT-OFF + gated (`allowCrossSource`) + a human
 *       approval + provenance-stamped (`extras.attachedSkillProvenance`) so a
 *       foreign skill stays distinguishable from a first-party describe.
 */

import type { ExtensionManifest } from "../../src/protocol/index.ts";

/** The id of the EXISTING first-party capability a user skill will teach (cross-source). */
export const OBSIDIAN_VAULT_READ_ID = "obsidian.vault.read" as const;

/** The user-authoring source id (the user "owns" this source). */
export const USER_SOURCE = "ezskills" as const;

// Derived entry ids (ID-DERIVATION RULE: `<sourceSlug>.<name>`).
export const SNIPPETS_READ_ID = "ezskills.snippets.read" as const;
export const SAME_SOURCE_SKILL_ID = "ezskills.snippets.how-to-search" as const;
export const CROSS_SOURCE_SKILL_ID = "ezskills.obsidian.how-to-cite-well" as const;

/**
 * The two authored declarations, reused to build both manifests below.
 *
 *   - `snippets.read`        — the user's OWN capability (a tiny cli read).
 *   - `snippets.how-to-search` — a SAME-SOURCE usage skill, back-linked onto
 *                              `snippets.read` via `route.attachSkills`. Applied
 *                              freely (the user teaches their own capability).
 *   - `obsidian.how-to-cite-well` — a CROSS-SOURCE usage skill, attaching onto the
 *                              first-party `obsidian.vault.read` via
 *                              `route.attachTo`. DEFAULT-OFF: applied only with the
 *                              `allowCrossSource` opt-in + a human approval, and then
 *                              provenance-stamped on the host entry.
 *
 * Note every skill carries `grants:[]` + `transport:"skill"` + a `body` (§8 rule 6):
 * a skill adds ZERO authority — it is read-as-context, never invocable.
 */

const SNIPPETS_READ_DECL: ExtensionManifest["capabilities"][number] = {
  name: "snippets.read",
  kind: "capability",
  label: "Read a code snippet",
  describe:
    "Read a saved code snippet by name from the user's local snippet store. Use when the task references a snippet the user has kept. Read-only: never mutates the store.",
  io: {
    input: {
      type: "object",
      properties: { name: { type: "string", description: "Snippet name." } },
      required: ["name"],
    },
  },
  grants: ["read"],
  transport: "cli",
  // (a) SAME-SOURCE attach: back-link the user's own usage skill onto their own cap.
  route: { bin: "snipcat", args: ["{name}"], attachSkills: ["snippets.how-to-search"] },
};

const SAME_SOURCE_SKILL_DECL: ExtensionManifest["capabilities"][number] = {
  name: "snippets.how-to-search",
  kind: "skill",
  label: "How to find the right snippet",
  describe:
    "Usage guidance for ezskills.snippets.read: snippet names are kebab-case; pass the exact name. Use when choosing or reading a snippet.",
  grants: [],
  transport: "skill",
  body: {
    format: "markdown",
    markdown:
      "# How to find the right snippet\n\n" +
      "Snippet names are **kebab-case** (`http-retry`, `zod-parse`).\n" +
      "Pass the exact `name`; there is no fuzzy search. Read-only.\n",
  },
};

const CROSS_SOURCE_SKILL_DECL: ExtensionManifest["capabilities"][number] = {
  name: "obsidian.how-to-cite-well",
  kind: "skill",
  label: "How to cite the Obsidian vault well",
  describe:
    "Usage guidance for the FIRST-PARTY obsidian.vault.read: cite notes by their vault-relative path, never invent a path, prefer the most recent dated note. Use when citing the user's Obsidian notes.",
  grants: [],
  transport: "skill",
  body: {
    format: "markdown",
    markdown:
      "# How to cite the Obsidian vault well\n\n" +
      "When you read a note via `obsidian.vault.read`, cite it by its\n" +
      "**vault-relative path** (e.g. `Projects/Plexus.md`). Never invent a path.\n" +
      "Prefer the most recent dated note when several match.\n",
  },
  // (b) CROSS-SOURCE attach: teach a capability owned by ANOTHER source.
  route: { attachTo: [OBSIDIAN_VAULT_READ_ID] },
};

/**
 * SAME-SOURCE-ONLY manifest. Contains the user's own capability + the usage skill
 * that teaches it. Registers FREELY (no cross-source boundary is crossed), so the
 * back-link wires unconditionally via `manifestEntries()`.
 */
export const SAME_SOURCE_EXTENSION: ExtensionManifest = {
  manifest: "plexus-extension/0.1",
  source: USER_SOURCE,
  label: "Ez's authored usage skills",
  transport: "cli",
  capabilities: [SNIPPETS_READ_DECL, SAME_SOURCE_SKILL_DECL],
};

/**
 * FULL manifest — the same-source pair PLUS the CROSS-SOURCE skill teaching the
 * first-party `obsidian.vault.read`. Because it carries a cross-source `attachTo`,
 * registering it is DEFAULT-OFF: a plain `registerExtension` / wire `POST /extensions`
 * is REJECTED; it commits only with the `allowCrossSource` opt-in (the human's
 * deliberate consent), and the attach is then provenance-stamped.
 */
export const USER_SKILL_EXTENSION: ExtensionManifest = {
  manifest: "plexus-extension/0.1",
  source: USER_SOURCE,
  label: "Ez's authored usage skills",
  transport: "cli",
  capabilities: [SNIPPETS_READ_DECL, SAME_SOURCE_SKILL_DECL, CROSS_SOURCE_SKILL_DECL],
};
