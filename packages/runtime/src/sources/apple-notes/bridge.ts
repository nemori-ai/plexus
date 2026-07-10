/**
 * Apple Notes PER-SESSION bridge (first-party, read + CREATE-ONLY write).
 *
 * Mirrors the apple-reminders in-process-handler pattern: the four `ipc` capability
 * ids are served by REAL in-process handlers that call the injected `NotesProvider`
 * (real osascript/JXA or the fake in-memory store). The SKILL entry falls through to
 * the standard base path (read-as-context, never invoked). Every invoke is
 * normalized + audited through the shared base helpers.
 *
 * Input validation happens HERE, before the provider is touched: a bad query /
 * missing id-or-title / missing title is rejected with `schema_validation_failed`
 * and `limit` is clamped to 1..MAX_SEARCH_LIMIT — agent input never reaches
 * osascript unvalidated (and even then only via the argv vector, never a script body).
 *
 * CREATE-ONLY: the HANDLERS map has exactly ONE mutating entry (`notes.create`).
 * There is no update/delete/move handler because no such capability exists.
 */

import type {
  BridgeDeps,
  CapabilityEntry,
  InvokeContext,
  InvokeRequest,
  InvokeResponse,
  TransportResult,
} from "@plexus/protocol";
import { BaseCapabilityBridge, normalizeResult } from "../base.ts";
import {
  APPLE_NOTES_SOURCE_ID,
  NOTES_CREATE_ID,
  NOTES_FOLDERS_LIST_ID,
  NOTES_READ_ID,
  NOTES_SEARCH_ID,
} from "./entries.ts";
import {
  clampLimit,
  NoteNotFoundError,
  NotesNotAuthorizedError,
  selectNotesProvider,
  type NotesProvider,
} from "./provider.ts";

/** An in-process handler: input + provider → TransportResult. */
type NotesHandler = (
  input: Record<string, unknown>,
  provider: NotesProvider,
) => Promise<TransportResult>;

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

/** Map provider errors to graceful, structured transport errors (never a crash). */
function providerErrorResult(capabilityId: string, err: unknown): TransportResult {
  if (err instanceof NotesNotAuthorizedError) {
    return {
      ok: false,
      error: {
        code: "transport_error",
        message: err.message,
        capabilityId,
        detail: { reason: "not_authorized" },
      },
    };
  }
  if (err instanceof NoteNotFoundError) {
    return {
      ok: false,
      error: {
        code: "transport_error",
        message: err.message,
        capabilityId,
        detail: { reason: "not_found" },
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "transport_error",
      message: err instanceof Error ? err.message : String(err),
      capabilityId,
    },
  };
}

const HANDLERS: Record<string, NotesHandler> = {
  [NOTES_FOLDERS_LIST_ID]: async (_input, provider) => {
    const folders = await provider.listFolders();
    return { ok: true, data: { folders } };
  },
  [NOTES_SEARCH_ID]: async (input, provider) => {
    const query = str(input, "query");
    if (!query) {
      return {
        ok: false,
        error: { code: "schema_validation_failed", message: "`query` is required (a non-empty string)" },
      };
    }
    // Clamp — never trust the agent's number; default 20, hard cap 50.
    const limit = clampLimit(input.limit);
    const notes = await provider.searchNotes({ query, limit });
    return { ok: true, data: { notes } };
  },
  [NOTES_READ_ID]: async (input, provider) => {
    const id = str(input, "id");
    const title = str(input, "title");
    if (!id && !title) {
      return {
        ok: false,
        error: {
          code: "schema_validation_failed",
          message: "provide `id` (from notes.search, preferred) or an exact `title`",
        },
      };
    }
    const note = await provider.readNote(id ? { id } : { title: title as string });
    return { ok: true, data: note };
  },
  [NOTES_CREATE_ID]: async (input, provider) => {
    const title = str(input, "title");
    if (!title) {
      return { ok: false, error: { code: "schema_validation_failed", message: "`title` is required" } };
    }
    const args: { title: string; body?: string; folder?: string } = { title };
    const body = input.body;
    if (typeof body === "string" && body.length > 0) args.body = body;
    const folder = str(input, "folder");
    if (folder) args.folder = folder;
    const created = await provider.createNote(args);
    return { ok: true, data: created };
  },
};

export class AppleNotesBridge extends BaseCapabilityBridge {
  private readonly provider: NotesProvider;

  constructor(
    deps: BridgeDeps,
    sessionId: string,
    entries: CapabilityEntry[],
    provider?: NotesProvider,
  ) {
    super(APPLE_NOTES_SOURCE_ID, deps, sessionId, entries);
    this.provider = selectNotesProvider(provider);
  }

  override async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    const handler = HANDLERS[req.id];
    if (!handler) {
      // The skill entry (and anything else) takes the standard base path.
      return super.invoke(req, ctx);
    }

    const entry = this.deps.getEntry(req.id) ?? this.getCapabilities().find((e) => e.id === req.id);
    if (!entry) {
      const audit = await this.deps.audit({
        type: "invoke",
        jti: ctx.jti,
        sessionId: ctx.sessionId,
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        capabilityId: req.id,
        outcome: "error",
        detail: { reason: "unknown_capability" },
      });
      return {
        id: req.id,
        ok: false,
        error: { code: "unknown_capability", message: `no such entry: ${req.id}`, capabilityId: req.id },
        auditId: audit.id,
      };
    }

    let result: TransportResult;
    try {
      result = await handler(req.input ?? {}, this.provider);
    } catch (err) {
      result = providerErrorResult(entry.id, err);
    }

    const audit = await this.deps.audit({
      type: "invoke",
      jti: ctx.jti,
      sessionId: ctx.sessionId,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      capabilityId: entry.id,
      verbs: entry.grants,
      outcome: result.ok ? "ok" : "error",
      // Redaction-safe: op + kind only; never queries/titles/bodies.
      detail: { transport: "in-process", kind: entry.kind, op: req.id },
      // Request + result for the Activity view (writer redacts + truncates).
      input: req.input ?? {},
      output: result.ok ? result.data : result.error,
    });
    return normalizeResult(entry.id, result, audit.id);
  }
}
