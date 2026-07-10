/**
 * Apple Contacts self-describe ENTRIES (STRICTLY READ-ONLY first-party source, v1).
 *
 * Two READ capabilities + a bundled how-to-use skill, mirroring the apple-calendar
 * first-party entry-set pattern:
 *
 *  - `apple-contacts.contacts.search` — bounded substring search (name/email/phone).
 *  - `apple-contacts.contacts.read`   — the full card for one contact id.
 *  - `apple-contacts.how-to-use`      — the bundled usage skill (read-as-context).
 *
 * READ-ONLY BY CONSTRUCTION: both capabilities declare `grants: ["read"]`, and the
 * provider seam (`ContactsProvider`) has NO create/update/delete method — no write
 * capability of any kind exists in this source.
 *
 * The source id is reserved in `RESERVED_SOURCE_IDS`, so every entry is gateway-stamped
 * `provenance: "first-party"` and a wire extension cannot impersonate it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CapabilityEntry } from "@plexus/protocol";
import { CONTACTS_SEARCH_LIMIT_DEFAULT, CONTACTS_SEARCH_LIMIT_MAX } from "./provider.ts";

/** Stable source id + capability/skill names for the Apple Contacts source. */
export const APPLE_CONTACTS_SOURCE_ID = "apple-contacts" as const;
export const CONTACTS_SEARCH_ID = "apple-contacts.contacts.search" as const;
export const CONTACTS_READ_ID = "apple-contacts.contacts.read" as const;
export const CONTACTS_SKILL_ID = "apple-contacts.how-to-use" as const;

const VERSION = "0.1.0";

/** Load the bundled how-to-use skill body from disk (alongside this file). */
function loadSkill(): string {
  try {
    const here = fileURLToPath(new URL("./skills/how-to-use-contacts.md", import.meta.url));
    return readFileSync(here, "utf-8");
  } catch {
    return (
      "# How to use Apple Contacts (read-only)\n" +
      "Search by name/email/phone substring (bounded), then read one full card by id. " +
      "Read-only — no create/update/delete exists."
    );
  }
}

/** READ-ONLY: bounded substring search across name/email/phone. */
function contactsSearch(): CapabilityEntry {
  return {
    id: CONTACTS_SEARCH_ID,
    source: APPLE_CONTACTS_SOURCE_ID,
    kind: "capability",
    label: "Search Apple Contacts",
    describe:
      "Search the user's Apple Contacts by a case-insensitive substring of a name, email " +
      "address, or phone number, READ-ONLY and ALWAYS BOUNDED. Use when you need someone's " +
      "contact details (e.g. 'what is Dana's email?') or to resolve a person before reading their " +
      "full card. Input: { query: string (required), limit?: number } — limit defaults to " +
      `${CONTACTS_SEARCH_LIMIT_DEFAULT} and is HARD-CAPPED at ${CONTACTS_SEARCH_LIMIT_MAX}. Phone matching ` +
      "compares digits (the query needs ≥ 3 digits to match a phone). Returns { contacts: [{ id, name, " +
      "organization, emails, phones }], total, truncated }; pass an id to apple-contacts.contacts.read " +
      "for the full card. Requires macOS Automation access to Contacts (one-time approval). Never writes.",
    io: {
      input: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Substring to match against names, email addresses, and phone numbers (case-insensitive).",
          },
          limit: {
            type: "integer",
            description: `Max results (default ${CONTACTS_SEARCH_LIMIT_DEFAULT}, hard cap ${CONTACTS_SEARCH_LIMIT_MAX}).`,
            default: CONTACTS_SEARCH_LIMIT_DEFAULT,
            maximum: CONTACTS_SEARCH_LIMIT_MAX,
            minimum: 1,
          },
        },
        required: ["query"],
      },
      output: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        description:
          "{ contacts: [{ id, name, organization, emails, phones }], total, truncated } — `truncated: true` " +
          "means more matched than the limit returned.",
        properties: {
          contacts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                organization: { type: "string", description: "May be null when unset." },
                emails: { type: "array", items: { type: "string" } },
                phones: { type: "array", items: { type: "string" } },
              },
            },
          },
          total: { type: "integer" },
          truncated: { type: "boolean" },
        },
        required: ["contacts", "total", "truncated"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: CONTACTS_SKILL_ID, label: "How to use Apple Contacts (read-only)" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: "contacts.search" } },
  };
}

/** READ-ONLY: the full card for one contact id. */
function contactsRead(): CapabilityEntry {
  return {
    id: CONTACTS_READ_ID,
    source: APPLE_CONTACTS_SOURCE_ID,
    kind: "capability",
    label: "Read one Apple Contacts card by id",
    describe:
      "Read ONE contact's full card by its id (from contacts.search), READ-ONLY: name, first/last " +
      "name, organization, birthday, and labeled emails, phones, and postal addresses. Use after a " +
      "search when you need details beyond the search summary (e.g. a mailing address or birthday). " +
      "Input: { id: string (required) }. Returns { contact: { id, name, firstName, lastName, " +
      "organization, birthday, emails: [{ label, value }], phones: [{ label, value }], addresses: " +
      "[{ label, value }] } } (absent fields are null / empty arrays). Requires macOS Automation " +
      "access to Contacts. Never writes.",
    io: {
      input: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          id: { type: "string", description: "The contact id from contacts.search (required)." },
        },
        required: ["id"],
      },
      output: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        description:
          "{ contact: { id, name, firstName, lastName, organization, birthday, emails, phones, addresses } } — " +
          "emails/phones/addresses are [{ label, value }]; missing scalars are null.",
        properties: {
          contact: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              firstName: { type: "string", description: "May be null when unset." },
              lastName: { type: "string", description: "May be null when unset." },
              organization: { type: "string", description: "May be null when unset." },
              birthday: { type: "string", description: "ISO date (yyyy-mm-dd) when set; null when unset." },
              emails: {
                type: "array",
                items: {
                  type: "object",
                  properties: { label: { type: "string", description: "May be null." }, value: { type: "string" } },
                },
              },
              phones: {
                type: "array",
                items: {
                  type: "object",
                  properties: { label: { type: "string", description: "May be null." }, value: { type: "string" } },
                },
              },
              addresses: {
                type: "array",
                items: {
                  type: "object",
                  properties: { label: { type: "string", description: "May be null." }, value: { type: "string" } },
                },
              },
            },
            required: ["id", "name"],
          },
        },
        required: ["contact"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: CONTACTS_SKILL_ID, label: "How to use Apple Contacts (read-only)" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: "contacts.read" } },
  };
}

/** The bundled how-to-use SKILL entry (read-as-context usage knowledge). */
function howToUseSkill(): CapabilityEntry {
  return {
    id: CONTACTS_SKILL_ID,
    source: APPLE_CONTACTS_SOURCE_ID,
    kind: "skill",
    label: "How to use Apple Contacts (read-only)",
    describe:
      "Usage guidance for apple-contacts.contacts.search and apple-contacts.contacts.read: " +
      "search by name/email/phone substring first (results bounded), then read one full card by " +
      "id. Read-only — no create/update/delete exists. Handle the not-authorized (Automation TCC) " +
      "case by telling the user to grant access.",
    grants: [],
    transport: "skill",
    body: { format: "markdown", markdown: loadSkill() },
    version: VERSION,
    extras: { firstParty: true },
  };
}

/**
 * The apple-contacts entry set: two read capabilities + the how-to-use skill. Always
 * the same set (read-only, no config gate); when Contacts is unavailable the entries
 * are still exposed and inherit the source's `unavailable` health.
 */
export function appleContactsEntries(): CapabilityEntry[] {
  return [contactsSearch(), contactsRead(), howToUseSkill()];
}
