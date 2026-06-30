/**
 * Apple Reminders PER-SESSION bridge (first-party, read + write).
 *
 * Mirrors the cc-master / obsidian in-process-handler pattern: the capability ids are
 * served by REAL in-process handlers that call the injected `RemindersProvider` (real
 * osascript or the fake in-memory store). The bridge intercepts the four `ipc`
 * capability ids and runs the provider directly; the SKILL entry falls through to the
 * standard base path (read-as-context, never invoked). Every invoke is normalized +
 * audited through the shared base helpers.
 *
 * The provider is INJECTABLE (tests + the hermetic probe pass a `FakeRemindersProvider`);
 * the default is `selectRemindersProvider()` (fake when `PLEXUS_FAKE_APPLE === "1"`,
 * else the real osascript provider).
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
  APPLE_REMINDERS_SOURCE_ID,
  LISTS_LIST_ID,
  REMINDERS_COMPLETE_ID,
  REMINDERS_CREATE_ID,
  REMINDERS_LIST_ID,
} from "./entries.ts";
import {
  type RemindersProvider,
  selectRemindersProvider,
} from "./provider.ts";

/** An in-process handler: input + provider → TransportResult. */
type RemindersHandler = (
  input: Record<string, unknown>,
  provider: RemindersProvider,
) => Promise<TransportResult>;

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const HANDLERS: Record<string, RemindersHandler> = {
  [LISTS_LIST_ID]: async (_input, provider) => {
    const lists = await provider.listLists();
    return { ok: true, data: { lists } };
  },
  [REMINDERS_LIST_ID]: async (input, provider) => {
    const query: { list?: string; completed?: boolean } = {};
    const list = str(input, "list");
    if (list) query.list = list;
    if (typeof input.completed === "boolean") query.completed = input.completed;
    const reminders = await provider.listReminders(query);
    return { ok: true, data: { reminders } };
  },
  [REMINDERS_CREATE_ID]: async (input, provider) => {
    const title = str(input, "title");
    if (!title) {
      return { ok: false, error: { code: "schema_validation_failed", message: "`title` is required" } };
    }
    const args: { title: string; list?: string; notes?: string; dueDate?: string } = { title };
    const list = str(input, "list");
    const notes = str(input, "notes");
    const dueDate = str(input, "dueDate");
    if (list) args.list = list;
    if (notes) args.notes = notes;
    if (dueDate) args.dueDate = dueDate;
    const reminder = await provider.createReminder(args);
    return { ok: true, data: reminder };
  },
  [REMINDERS_COMPLETE_ID]: async (input, provider) => {
    const id = str(input, "id");
    if (!id) {
      return { ok: false, error: { code: "schema_validation_failed", message: "`id` is required" } };
    }
    const reminder = await provider.completeReminder({ id });
    return { ok: true, data: reminder };
  },
};

export class AppleRemindersBridge extends BaseCapabilityBridge {
  private readonly provider: RemindersProvider;

  constructor(
    deps: BridgeDeps,
    sessionId: string,
    entries: CapabilityEntry[],
    provider?: RemindersProvider,
  ) {
    super(APPLE_REMINDERS_SOURCE_ID, deps, sessionId, entries);
    this.provider = selectRemindersProvider(provider);
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
      const audit = await this.deps.audit({
        type: "invoke",
        jti: ctx.jti,
        sessionId: ctx.sessionId,
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        capabilityId: entry.id,
        verbs: entry.grants,
        outcome: "error",
        detail: { reason: "handler_threw", op: req.id },
      });
      return {
        id: entry.id,
        ok: false,
        error: {
          code: "transport_error",
          message: err instanceof Error ? err.message : String(err),
          capabilityId: entry.id,
        },
        auditId: audit.id,
      };
    }

    const audit = await this.deps.audit({
      type: "invoke",
      jti: ctx.jti,
      sessionId: ctx.sessionId,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      capabilityId: entry.id,
      verbs: entry.grants,
      outcome: result.ok ? "ok" : "error",
      // Redaction-safe: op + kind only; never titles/notes/output.
      detail: { transport: "in-process", kind: entry.kind, op: req.id },
      // Request + result for the Activity view (writer redacts + truncates).
      input: req.input ?? {},
      output: result.ok ? result.data : result.error,
    });
    return normalizeResult(entry.id, result, audit.id);
  }
}
