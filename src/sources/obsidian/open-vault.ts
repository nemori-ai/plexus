/**
 * Obsidian — "open a vault read-only" (Acceptance Scenario B).
 *
 * THE ONE-SENTENCE FLOW: a user says "open my Obsidian vault at <path> read-only".
 * `openVaultManifest(vaultPath)` turns that single input into an
 * `ExtensionManifest` declaring exactly one read-only capability —
 * `obsidian.vault.read` — plus a bundled usage skill `obsidian.vault.how-to-cite`.
 * `openVaultExtension(vaultPath)` additionally supplies the in-process handler that
 * performs the path-confined, read-only filesystem read.
 *
 * Hand the manifest + handlers to `capabilities.registerExtension(...)` and the
 * capability appears in the live registry / `.well-known` / handshake manifest,
 * grant it `["read"]`, and `POST /invoke { id: "obsidian.vault.read", input: {...} }`
 * returns real note content. No Obsidian app, no REST plugin, no secret required.
 *
 * MECHANISM: direct filesystem read of the vault folder (see `vault-reader.ts`).
 * Chosen over the Obsidian Local REST API plugin because a vault is just a folder
 * of `.md` files — the fs path has no runtime dependency on Obsidian and is the
 * most robust for a demo, while read-only + path-confinement are enforced in
 * gateway-owned code we fully test.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CapabilityEntry,
  ExtensionManifest,
  TransportResult,
} from "@plexus/protocol";
import type { ExtensionHandler } from "../extension.ts";
import { VaultConfinementError, readVaultPath } from "./vault-reader.ts";

/** Stable source id + capability/skill names for the Obsidian vault extension. */
export const OBSIDIAN_SOURCE_ID = "obsidian" as const;
export const VAULT_READ_NAME = "vault.read" as const;
export const VAULT_SKILL_NAME = "vault.how-to-cite" as const;
export const VAULT_READ_ID = "obsidian.vault.read" as const;
export const VAULT_SKILL_ID = "obsidian.vault.how-to-cite" as const;

/** Load the bundled how-to-cite-vault skill body from disk (alongside this file). */
function loadCiteSkill(): string {
  try {
    const here = fileURLToPath(new URL("./skills/how-to-cite-vault.md", import.meta.url));
    return readFileSync(here, "utf-8");
  } catch {
    return "# How to cite an Obsidian vault\nRead notes by their vault-relative path; cite by relative path; read-only.";
  }
}

/**
 * Build the `ExtensionManifest` for opening a vault read-only. The `vaultPath` is
 * baked into the capability's `route.vaultPath` (read only by the handler, never by
 * core). The capability declares `grants: ["read"]` — READ-ONLY by construction.
 */
export function openVaultManifest(vaultPath: string): ExtensionManifest {
  const vaultName = basename(vaultPath) || "vault";
  return {
    manifest: "plexus-extension/0.1",
    source: OBSIDIAN_SOURCE_ID,
    label: `Obsidian vault (${vaultName})`,
    // The vault read is served by an in-process, path-confined fs handler. We label
    // its transport "ipc" (a local in-process bridge) — the bridge runs the handler
    // directly, so no external wire is involved.
    transport: "ipc",
    capabilities: [
      {
        name: VAULT_READ_NAME,
        kind: "capability",
        label: `Read Obsidian vault "${vaultName}"`,
        describe:
          `Read notes from the Obsidian vault "${vaultName}" READ-ONLY. ` +
          `Use when you need the text of the user's notes to answer, summarize, or cite. ` +
          `Pass { path } relative to the vault root to read a note; omit path to list notes. ` +
          `Path-confined to the vault; never writes.`,
        io: {
          input: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "Vault-relative path of the note to read, e.g. 'Daily/2026-06-23.md'. Omit or '' to list the vault.",
              },
            },
          },
          output: {
            type: "object",
            description: "Either a file read ({ content, relativePath, bytes }) or a directory listing ({ entries }).",
          },
        },
        grants: ["read"],
        transport: "ipc",
        // route is read ONLY by the handler/bridge. vaultPath confines every read;
        // attachSkills links the bundled usage skill to this capability.
        route: { vaultPath, attachSkills: [VAULT_SKILL_NAME] },
      },
      {
        name: VAULT_SKILL_NAME,
        kind: "skill",
        label: "How to cite an Obsidian vault",
        describe:
          "Usage guidance for obsidian.vault.read: read notes by vault-relative path, cite by relative path, read-only + path-confined.",
        grants: [],
        transport: "skill",
        body: { format: "markdown", markdown: loadCiteSkill() },
      },
    ],
  };
}

/**
 * The in-process handler for `obsidian.vault.read`. Reads the requested vault path
 * READ-ONLY and PATH-CONFINED (see `vault-reader.ts`). A confinement violation is
 * mapped to a `transport_error` (NOT a thrown exception). The vault root is read
 * from `entry.extras.route.vaultPath`.
 */
export const vaultReadHandler: ExtensionHandler = async (
  entry: CapabilityEntry,
  input: Record<string, unknown>,
): Promise<TransportResult> => {
  const route = entry.extras?.route as { vaultPath?: string } | undefined;
  const vaultPath = route?.vaultPath;
  if (!vaultPath) {
    return {
      ok: false,
      error: { code: "transport_error", message: "obsidian: no vaultPath configured", capabilityId: entry.id },
    };
  }
  const rawPath = input.path;
  const requestPath = typeof rawPath === "string" ? rawPath : "";

  try {
    const data = await readVaultPath(vaultPath, requestPath);
    return { ok: true, data };
  } catch (err) {
    if (err instanceof VaultConfinementError) {
      // A traversal / escape attempt — REJECTED. This is the real read-only +
      // confinement denial (never a fake-green pass).
      return {
        ok: false,
        error: {
          code: "transport_error",
          message: `obsidian: path denied (confinement): ${err.message}`,
          capabilityId: entry.id,
          detail: { reason: "path_confinement" },
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "transport_error",
        message: err instanceof Error ? err.message : String(err),
        capabilityId: entry.id,
      },
    };
  }
};

/**
 * The full "open vault" entrypoint: the manifest + the handler map ready to hand to
 * `capabilities.registerExtension(manifest, { handlers })`.
 */
export function openVaultExtension(vaultPath: string): {
  manifest: ExtensionManifest;
  handlers: Record<string, ExtensionHandler>;
} {
  return {
    manifest: openVaultManifest(vaultPath),
    handlers: { [VAULT_READ_NAME]: vaultReadHandler },
  };
}
