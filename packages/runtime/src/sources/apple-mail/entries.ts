/**
 * Apple Mail self-describe ENTRIES (STRICTLY READ-ONLY first-party source, v1).
 *
 * Three READ capabilities + a bundled how-to-use skill, mirroring the apple-calendar
 * first-party entry-set pattern:
 *
 *  - `apple-mail.mailboxes.list`   — accounts + mailboxes with unread counts (no input).
 *  - `apple-mail.messages.search`  — BOUNDED search within ONE mailbox (limit ≤ 50).
 *  - `apple-mail.message.read`     — one message's plain text by id (char-capped).
 *  - `apple-mail.how-to-use`       — the bundled usage skill (read-as-context).
 *
 * READ-ONLY BY CONSTRUCTION: every capability declares `grants: ["read"]`, and the
 * provider seam (`MailProvider`) has NO draft/send/move/delete method — no drafting or
 * sending capability EXISTS in this source. That is the safety story.
 *
 * The source id is reserved in `RESERVED_SOURCE_IDS`, so every entry is gateway-stamped
 * `provenance: "first-party"` and a wire extension cannot impersonate it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CapabilityEntry } from "@plexus/protocol";
import {
  MAIL_CONTENT_MAX_CHARS,
  MAIL_SEARCH_LIMIT_DEFAULT,
  MAIL_SEARCH_LIMIT_MAX,
} from "./provider.ts";

/** Stable source id + capability/skill names for the Apple Mail source. */
export const APPLE_MAIL_SOURCE_ID = "apple-mail" as const;
export const MAIL_MAILBOXES_LIST_ID = "apple-mail.mailboxes.list" as const;
export const MAIL_MESSAGES_SEARCH_ID = "apple-mail.messages.search" as const;
export const MAIL_MESSAGE_READ_ID = "apple-mail.message.read" as const;
export const MAIL_SKILL_ID = "apple-mail.how-to-use" as const;

const VERSION = "0.1.0";

/** Load the bundled how-to-use skill body from disk (alongside this file). */
function loadSkill(): string {
  try {
    const here = fileURLToPath(new URL("./skills/how-to-use-mail.md", import.meta.url));
    return readFileSync(here, "utf-8");
  } catch {
    return (
      "# How to use Apple Mail (read-only)\n" +
      "List mailboxes, search ONE mailbox with bounded results, read one message by id. " +
      "STRICTLY read-only — no drafting or sending capability exists. Results are bounded/truncated."
    );
  }
}

/** READ-ONLY: accounts + mailboxes with unread counts (no input). */
function mailboxesList(): CapabilityEntry {
  return {
    id: MAIL_MAILBOXES_LIST_ID,
    source: APPLE_MAIL_SOURCE_ID,
    kind: "capability",
    label: "List Apple Mail accounts + mailboxes",
    describe:
      "List the user's Apple Mail accounts and each account's mailboxes with unread counts, " +
      "READ-ONLY. Use this first to discover which account/mailbox to search (e.g. 'Work' ▸ " +
      "'INBOX') or to answer 'how many unread emails?'. Takes no input. Returns " +
      "{ accounts: [{ account, mailboxes: [{ name, unreadCount }] }] }. Requires macOS " +
      "Automation access to Mail (one-time approval). Never writes, drafts, or sends.",
    io: {
      input: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {} },
      output: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          accounts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                account: { type: "string" },
                mailboxes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      unreadCount: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
        required: ["accounts"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: MAIL_SKILL_ID, label: "How to use Apple Mail (read-only)" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: "mailboxes.list" } },
  };
}

/** READ-ONLY: bounded search within ONE mailbox. */
function messagesSearch(): CapabilityEntry {
  return {
    id: MAIL_MESSAGES_SEARCH_ID,
    source: APPLE_MAIL_SOURCE_ID,
    kind: "capability",
    label: "Search Apple Mail messages in one mailbox",
    describe:
      "Search messages WITHIN ONE Apple Mail mailbox by sender/subject substring and/or a " +
      "received-date range, READ-ONLY and ALWAYS BOUNDED. Use when you need to find specific " +
      "emails (e.g. 'the latest email from Dana' or 'invoices since June'). Input: " +
      "{ mailbox?: string (default 'INBOX' = the unified inbox), account?: string, sender?: string, " +
      "subject?: string, since?: ISO date, before?: ISO date, limit?: number } — limit defaults to " +
      `${MAIL_SEARCH_LIMIT_DEFAULT} and is HARD-CAPPED at ${MAIL_SEARCH_LIMIT_MAX}. Returns newest-first ` +
      "{ messages: [{ id, sender, subject, date, snippet, mailbox }], total, truncated } — snippets are " +
      "~200 chars; pass an id to apple-mail.message.read for the body. Prefer a date range and/or " +
      "sender/subject filter on large mailboxes (a broad search of a huge mailbox can be slow and will " +
      "time out rather than hang). Requires macOS Automation access to Mail. Never writes, drafts, or sends.",
    io: {
      input: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          mailbox: { type: "string", description: "Mailbox name to search (from mailboxes.list). Default 'INBOX' (unified inbox)." },
          account: { type: "string", description: "Optional account name to disambiguate the mailbox." },
          sender: { type: "string", description: "Case-insensitive substring to match in the sender (name or address)." },
          subject: { type: "string", description: "Case-insensitive substring to match in the subject." },
          since: { type: "string", description: "ISO-8601 lower bound on the received date. Compute from the current date you were given." },
          before: { type: "string", description: "ISO-8601 upper bound on the received date (after `since`)." },
          limit: {
            type: "integer",
            description: `Max results (default ${MAIL_SEARCH_LIMIT_DEFAULT}, hard cap ${MAIL_SEARCH_LIMIT_MAX}).`,
            default: MAIL_SEARCH_LIMIT_DEFAULT,
            maximum: MAIL_SEARCH_LIMIT_MAX,
            minimum: 1,
          },
        },
      },
      output: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        description:
          "{ messages: [{ id, sender, subject, date, snippet, mailbox }], total, truncated } — newest-first; " +
          "`truncated: true` means more matched than the limit returned.",
        properties: {
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                sender: { type: "string" },
                subject: { type: "string" },
                date: { type: "string" },
                snippet: { type: "string" },
                mailbox: { type: "string" },
              },
            },
          },
          total: { type: "integer" },
          truncated: { type: "boolean" },
        },
        required: ["messages", "total", "truncated"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: MAIL_SKILL_ID, label: "How to use Apple Mail (read-only)" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: "messages.search" } },
  };
}

/** READ-ONLY: one message's plain-text content by id (char-capped). */
function messageRead(): CapabilityEntry {
  return {
    id: MAIL_MESSAGE_READ_ID,
    source: APPLE_MAIL_SOURCE_ID,
    kind: "capability",
    label: "Read one Apple Mail message by id",
    describe:
      "Read ONE Apple Mail message's plain-text content by its id (from messages.search), " +
      "READ-ONLY and CHAR-CAPPED. Use after a search when you need the full body, not just the " +
      "snippet. Input: { id: number|string (required), mailbox?: string (default 'INBOX'), " +
      "account?: string, maxChars?: number } — the body is truncated to at most " +
      `${MAIL_CONTENT_MAX_CHARS} chars (response carries truncated + totalChars so you know when ` +
      "content was cut). Returns { id, sender, subject, date, mailbox, content, truncated, totalChars }. " +
      "Requires macOS Automation access to Mail. Never writes, drafts, or sends.",
    io: {
      input: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          id: { type: "string", description: "The message id from messages.search (required; a numeric string — a plain number is also accepted)." },
          mailbox: { type: "string", description: "The mailbox the id came from. Default 'INBOX'." },
          account: { type: "string", description: "Optional account name to disambiguate the mailbox." },
          maxChars: {
            type: "integer",
            description: `Body char cap (default and max ${MAIL_CONTENT_MAX_CHARS}; min 200).`,
            maximum: MAIL_CONTENT_MAX_CHARS,
            minimum: 200,
          },
        },
        required: ["id"],
      },
      output: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        description:
          "{ id, sender, subject, date, mailbox, content, truncated, totalChars } — `truncated: true` " +
          "means the body was longer than the cap and `content` is a prefix.",
        properties: {
          id: { type: "string" },
          sender: { type: "string" },
          subject: { type: "string" },
          date: { type: "string" },
          mailbox: { type: "string" },
          content: { type: "string" },
          truncated: { type: "boolean" },
          totalChars: { type: "integer" },
        },
        required: ["id", "content", "truncated"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: MAIL_SKILL_ID, label: "How to use Apple Mail (read-only)" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: "message.read" } },
  };
}

/** The bundled how-to-use SKILL entry (read-as-context usage knowledge). */
function howToUseSkill(): CapabilityEntry {
  return {
    id: MAIL_SKILL_ID,
    source: APPLE_MAIL_SOURCE_ID,
    kind: "skill",
    label: "How to use Apple Mail (read-only)",
    describe:
      "Usage guidance for apple-mail.mailboxes.list, apple-mail.messages.search, and " +
      "apple-mail.message.read: discover mailboxes first, search ONE mailbox with filters " +
      "(results bounded, snippets/bodies truncated), then read one message by id. STRICTLY " +
      "read-only — no drafting or sending exists. Handle the not-authorized (Automation TCC) " +
      "case by telling the user to grant access.",
    grants: [],
    transport: "skill",
    body: { format: "markdown", markdown: loadSkill() },
    version: VERSION,
    extras: { firstParty: true },
  };
}

/**
 * The apple-mail entry set: three read capabilities + the how-to-use skill. Always the
 * same set (read-only, no config gate); when Mail is unavailable the entries are still
 * exposed and inherit the source's `unavailable` health.
 */
export function appleMailEntries(): CapabilityEntry[] {
  return [mailboxesList(), messagesSearch(), messageRead(), howToUseSkill()];
}
