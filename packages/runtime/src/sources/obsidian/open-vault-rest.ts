/**
 * Obsidian — "open a vault READ-WRITE via the Local REST API" (task rwapi).
 *
 * THE ONE-SENTENCE FLOW: a user says "open my Obsidian vault read-WRITE through the
 * Local REST API". `openVaultRestManifest({...})` turns that into an `ExtensionManifest`
 * declaring five `local-rest` capabilities against the Obsidian Local REST API plugin
 * (HTTPS on loopback, Bearer-authenticated):
 *
 *   - obsidian-rest.vault.list   (read)  — GET  /vault/          list the vault
 *   - obsidian-rest.vault.read   (read)  — GET  /vault/{path}    read one note's markdown
 *   - obsidian-rest.vault.search (read)  — POST /search/simple/  text-search the vault
 *   - obsidian-rest.vault.write  (write) — PUT  /vault/{path}    create/overwrite a note
 *   - obsidian-rest.vault.append (write) — POST /vault/{path}    append to a note's end
 *
 * plus a bundled usage skill `obsidian-rest.vault.how-to-use`.
 *
 * Unlike the direct-filesystem read-only flow (`open-vault.ts`), this is the REAL
 * third-party integration: every call goes through Plexus's `local-rest` TRANSPORT, which
 * resolves the Bearer API key from `~/.plexus/secrets/<secretName>` via the platform
 * `resolveSecret` seam and attaches it ONLY to the loopback Obsidian host (egress
 * confinement in `transport-policy.ts`). No secret value lives in the manifest.
 *
 * SECURITY:
 *  - `route.baseUrl` is loopback HTTPS (`https://127.0.0.1:27124` by default). The
 *    transport re-validates the resolved + final URL host (loopback / allow-listed only);
 *    a non-loopback baseUrl is denied `host_forbidden` and the secret is never attached.
 *  - The self-signed cert the plugin uses is accepted only because the host is loopback.
 *  - `vault.write` and `vault.append` carry `grants:["write"]`, so granting them PENDS
 *    under the user-confirm authorizer — an agent cannot self-grant a mutating capability.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionManifest } from "@plexus/protocol";

/** Stable source id + capability/skill names for the REST-API Obsidian vault extension. */
export const OBSIDIAN_REST_SOURCE_ID = "obsidian-rest" as const;
export const REST_VAULT_LIST_ID = "obsidian-rest.vault.list" as const;
export const REST_VAULT_READ_ID = "obsidian-rest.vault.read" as const;
export const REST_VAULT_SEARCH_ID = "obsidian-rest.vault.search" as const;
export const REST_VAULT_WRITE_ID = "obsidian-rest.vault.write" as const;
export const REST_VAULT_APPEND_ID = "obsidian-rest.vault.append" as const;
export const REST_VAULT_SKILL_ID = "obsidian-rest.vault.how-to-use" as const;

const REST_VAULT_LIST_NAME = "vault.list" as const;
const REST_VAULT_READ_NAME = "vault.read" as const;
const REST_VAULT_SEARCH_NAME = "vault.search" as const;
const REST_VAULT_WRITE_NAME = "vault.write" as const;
const REST_VAULT_APPEND_NAME = "vault.append" as const;
const REST_VAULT_SKILL_NAME = "vault.how-to-use" as const;

/** The default Obsidian Local REST API HTTPS base URL (loopback, self-signed). */
export const DEFAULT_OBSIDIAN_REST_URL = "https://127.0.0.1:27124" as const;
/** The default secret name under `~/.plexus/secrets/` holding the Bearer API key. */
export const DEFAULT_OBSIDIAN_REST_SECRET = "obsidian-local-rest-api-key" as const;

export interface OpenVaultRestOptions {
  /** REST API base URL (configurable; default `https://127.0.0.1:27124`). Loopback-enforced. */
  baseUrl?: string;
  /** Secret name under `~/.plexus/secrets/` for the Bearer key (default `obsidian-local-rest-api-key`). */
  secretName?: string;
}

/** Load the bundled how-to-use-vault-rest skill body from disk (alongside this file). */
function loadUseSkill(): string {
  try {
    const here = fileURLToPath(new URL("./skills/how-to-use-vault-rest.md", import.meta.url));
    return readFileSync(here, "utf-8");
  } catch {
    return (
      "# How to use an Obsidian vault over the Local REST API\n" +
      "Read with obsidian-rest.vault.read { path }, list with obsidian-rest.vault.list {}, " +
      "search with obsidian-rest.vault.search { query }, append to a note with " +
      "obsidian-rest.vault.append { path, content } (preferred for additive edits), " +
      "create/overwrite with obsidian-rest.vault.write { path, content } (REPLACES the whole note). " +
      "Writes pend for human confirmation."
    );
  }
}

/**
 * Build the `ExtensionManifest` for opening a vault READ-WRITE via the Obsidian Local
 * REST API. The base URL + secret name are configurable (CLI flag / env). Every capability
 * is `transport:"local-rest"`; the secret is referenced by name (resolved at dispatch).
 */
export function openVaultRestManifest(opts: OpenVaultRestOptions = {}): ExtensionManifest {
  const baseUrl = opts.baseUrl ?? DEFAULT_OBSIDIAN_REST_URL;
  const secretName = opts.secretName ?? DEFAULT_OBSIDIAN_REST_SECRET;

  /** Shared route fields: loopback HTTPS base + Bearer secret ref. */
  const secret = { name: secretName, attach: "bearer" as const };

  return {
    manifest: "plexus-extension/0.1",
    source: OBSIDIAN_REST_SOURCE_ID,
    label: "Obsidian vault (Local REST API, read-write)",
    transport: "local-rest",
    // Declared so the manifest documents the credential it needs; value lives out of band.
    secrets: [secret],
    capabilities: [
      {
        name: REST_VAULT_LIST_NAME,
        kind: "capability",
        label: "List the Obsidian vault",
        describe:
          "List the notes and folders in the user's Obsidian vault via the Local REST API " +
          "(GET /vault/). Use to discover what notes exist before reading or writing. Read-only.",
        io: {
          input: { type: "object", properties: {} },
          output: { type: "object", description: "The vault listing the REST API returns (files/folders)." },
        },
        grants: ["read"],
        transport: "local-rest",
        route: {
          baseUrl,
          method: "GET",
          pathTemplate: "/vault/",
          secret,
          attachSkills: [REST_VAULT_SKILL_NAME],
        },
      },
      {
        name: REST_VAULT_READ_NAME,
        kind: "capability",
        label: "Read an Obsidian note",
        describe:
          "Read one note's markdown from the user's Obsidian vault via the Local REST API " +
          "(GET /vault/{path}). Pass { path } relative to the vault root, e.g. 'Daily/2026-06-23.md'. " +
          "Use to quote, summarize, or cite the user's notes. Read-only.",
        io: {
          input: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative note path, e.g. 'Daily/2026-06-23.md'." },
            },
            required: ["path"],
          },
          output: { type: "object", description: "The note markdown (and any metadata the REST API returns)." },
        },
        grants: ["read"],
        transport: "local-rest",
        route: {
          baseUrl,
          method: "GET",
          pathTemplate: "/vault/{path}",
          pathTokens: ["path"], // multi-segment path; slashes preserved
          secret,
          attachSkills: [REST_VAULT_SKILL_NAME],
        },
      },
      {
        name: REST_VAULT_SEARCH_NAME,
        kind: "capability",
        label: "Search the Obsidian vault",
        describe:
          "Search the user's Obsidian vault for notes matching a text query via the Local " +
          "REST API (POST /search/simple/). Use when you need to FIND which notes mention a " +
          "topic before reading them — faster than listing and reading every note. Pass " +
          "{ query } (and optional { contextLength }, default 100 chars of context per match); " +
          "each result carries the matching note's path, a relevance score, and the matched " +
          "text in context. Read-only.",
        io: {
          input: {
            type: "object",
            properties: {
              query: { type: "string", description: "The text to search the vault for." },
              contextLength: {
                type: "integer",
                description: "How much context (chars) to return around each match (default 100).",
                default: 100,
                minimum: 0,
              },
            },
            required: ["query"],
          },
          output: {
            type: "object",
            description:
              "Array of matches: [{ filename, score, matches: [{ context, match: { start, end } }] }].",
          },
        },
        grants: ["read"],
        transport: "local-rest",
        route: {
          baseUrl,
          method: "POST",
          pathTemplate: "/search/simple/",
          // The Local REST API takes the search inputs as URL QUERY PARAMS on a POST
          // (no request body): /search/simple/?query=…&contextLength=….
          queryFrom: ["query", "contextLength"],
          bodyFrom: "none",
          secret,
          attachSkills: [REST_VAULT_SKILL_NAME],
        },
      },
      {
        name: REST_VAULT_WRITE_NAME,
        kind: "capability",
        label: "Write an Obsidian note",
        describe:
          "Create or OVERWRITE a note in the user's Obsidian vault via the Local REST API " +
          "(PUT /vault/{path}). Pass { path } (vault-relative) and { content } (the FULL markdown to store). " +
          "WARNING: this REPLACES the whole note — read it first and resend everything you want kept. " +
          "Use only for creating a note or intentionally rewriting one; to ADD content to an " +
          "existing note, use vault.append instead. Mutating — granting it requires a human confirmation.",
        io: {
          input: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative note path to create/overwrite." },
              content: { type: "string", description: "The full markdown body to store at that path." },
            },
            required: ["path", "content"],
          },
          output: { type: "object", description: "The REST API's write acknowledgement (often empty)." },
        },
        grants: ["write"],
        transport: "local-rest",
        route: {
          baseUrl,
          method: "PUT",
          pathTemplate: "/vault/{path}",
          pathTokens: ["path"],
          // Raw-body mode: the `content` field is the request body (text/markdown).
          bodyFrom: "content",
          bodyField: "content",
          bodyContentType: "text/markdown",
          secret,
          attachSkills: [REST_VAULT_SKILL_NAME],
        },
      },
      {
        name: REST_VAULT_APPEND_NAME,
        kind: "capability",
        label: "Append to an Obsidian note",
        describe:
          "Append markdown to the END of a note in the user's Obsidian vault via the Local " +
          "REST API (POST /vault/{path}). Use when ADDING content — log entries, follow-ups, " +
          "captured items — because it preserves everything already in the note (unlike " +
          "vault.write, which replaces it). Pass { path } (vault-relative) and { content } " +
          "(the markdown to append). Creates the note if it does not exist yet. Mutating — " +
          "granting it requires a human confirmation.",
        io: {
          input: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative note path to append to." },
              content: { type: "string", description: "The markdown to append to the end of the note." },
            },
            required: ["path", "content"],
          },
          output: { type: "object", description: "The REST API's append acknowledgement (often empty)." },
        },
        grants: ["write"],
        transport: "local-rest",
        route: {
          baseUrl,
          method: "POST",
          pathTemplate: "/vault/{path}",
          pathTokens: ["path"],
          // Raw-body mode: the `content` field is the request body (text/markdown),
          // appended to the end of the note by the REST API.
          bodyFrom: "content",
          bodyField: "content",
          bodyContentType: "text/markdown",
          secret,
          attachSkills: [REST_VAULT_SKILL_NAME],
        },
      },
      {
        name: REST_VAULT_SKILL_NAME,
        kind: "skill",
        label: "How to use an Obsidian vault over the Local REST API",
        describe:
          "Usage guidance for the Obsidian Local REST API capabilities: list/read/search/write/append " +
          "notes; append adds to a note's end, write REPLACES the whole note; writes pend for " +
          "human confirmation; cite by vault-relative path.",
        grants: [],
        transport: "skill",
        body: { format: "markdown", markdown: loadUseSkill() },
      },
    ],
  };
}

/**
 * The full "open vault read-write via REST" entrypoint: just the manifest (no in-process
 * handlers — every capability routes through the `local-rest` transport). Hand it to
 * `capabilities.registerExtension(manifest)`.
 */
export function openVaultRestExtension(opts: OpenVaultRestOptions = {}): {
  manifest: ExtensionManifest;
} {
  return { manifest: openVaultRestManifest(opts) };
}
