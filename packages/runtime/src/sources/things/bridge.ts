/**
 * Things 3 PER-SESSION bridge (first-party source).
 *
 * Mirrors the cc-master in-process-handler pattern: the three Things capabilities are
 * best served by gateway-owned local code that drives the injected {@link ThingsProvider},
 * so the bridge intercepts their ids and runs the provider directly, then normalizes +
 * audits the result (the `ipc` transport wire is never reached). Everything else (the
 * how-to-use SKILL) takes the standard `BaseCapabilityBridge` path.
 *
 *   things.todos.list    → provider.listTodos({ list? })   (READ, AppleScript in real)
 *   things.projects.list → provider.listProjects()          (READ, AppleScript in real)
 *   things.todos.add     → provider.addTodo({ ... })         (WRITE, URL-scheme in real)
 *
 * The provider is INJECTED (constructor) or selected by `selectThingsProvider()` — the
 * fake when `PLEXUS_FAKE_APPLE=1`, else the real osascript/URL-scheme provider — so the
 * automated probe + tests are hermetic.
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
  THINGS_SOURCE_ID,
  TODOS_LIST_ID,
  PROJECTS_LIST_ID,
  TODOS_ADD_ID,
} from "./entries.ts";
import {
  selectThingsProvider,
  type AddTodoArgs,
  type ThingsProvider,
} from "./provider.ts";

/** An in-process handler: input + provider → real local op → TransportResult. */
type ThingsHandler = (
  input: Record<string, unknown>,
  provider: ThingsProvider,
) => Promise<TransportResult>;

function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

const HANDLERS: Record<string, ThingsHandler> = {
  [TODOS_LIST_ID]: async (input, provider) => {
    const list = strOf(input.list);
    const todos = await provider.listTodos(list ? { list } : undefined);
    return { ok: true, data: { todos, count: todos.length } };
  },
  [PROJECTS_LIST_ID]: async (_input, provider) => {
    const projects = await provider.listProjects();
    return { ok: true, data: { projects, count: projects.length } };
  },
  [TODOS_ADD_ID]: async (input, provider) => {
    const title = strOf(input.title);
    if (!title) {
      return { ok: false, error: { code: "schema_validation_failed", message: "`title` is required" } };
    }
    const args: AddTodoArgs = { title };
    const notes = strOf(input.notes);
    const when = strOf(input.when);
    const list = strOf(input.list);
    if (notes) args.notes = notes;
    if (when) args.when = when;
    if (list) args.list = list;

    const res = await provider.addTodo(args);
    return {
      ok: res.ok,
      data: { ok: res.ok, url: res.url, ...(res.id ? { id: res.id } : {}) },
      ...(res.ok ? {} : { error: { code: "transport_error", message: res.reason ?? "add failed" } }),
    };
  },
};

export class ThingsBridge extends BaseCapabilityBridge {
  private readonly provider: ThingsProvider;

  constructor(
    deps: BridgeDeps,
    sessionId: string,
    entries: CapabilityEntry[],
    provider?: ThingsProvider,
  ) {
    super(THINGS_SOURCE_ID, deps, sessionId, entries);
    // real by default; fake when PLEXUS_FAKE_APPLE=1; or an explicit injected provider.
    this.provider = selectThingsProvider(provider);
  }

  override async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    const handler = HANDLERS[req.id];
    if (!handler) {
      // The skill (and anything else) takes the standard base path.
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
      // Redaction-safe: the op name + kind only, never the title/notes text.
      detail: { transport: "in-process", kind: entry.kind, op: req.id },
    });
    return normalizeResult(entry.id, result, audit.id);
  }
}
