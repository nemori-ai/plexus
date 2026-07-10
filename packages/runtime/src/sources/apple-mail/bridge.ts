/**
 * Apple Mail PER-SESSION bridge (STRICTLY READ-ONLY, v1).
 *
 * Mirrors the apple-calendar in-process-handler pattern: the three read capabilities
 * are served by REAL in-process handlers that read through the injected `MailProvider`
 * (real osascript by default; fake fixtures under `PLEXUS_FAKE_APPLE=1` or when
 * injected). The how-to-use SKILL takes the standard base path (read-as-context).
 *
 *  - `apple-mail.mailboxes.list`  → `provider.listMailboxes()`.
 *  - `apple-mail.messages.search` → `validateSearchInput` FIRST (limit clamped ≤ 50,
 *    dates parsed + re-serialized, strings capped), then `provider.searchMessages`.
 *  - `apple-mail.message.read`    → `validateReadInput` FIRST (id required, maxChars
 *    clamped), then `provider.readMessage`.
 *
 * Bad input is rejected with a clear `invalid_input` transport_error BEFORE the
 * provider (and therefore osascript) is ever touched; an Automation/TCC denial
 * surfaces as a graceful not-authorized transport_error — never a crash.
 *
 * READ-ONLY BY CONSTRUCTION: only the provider's read methods are reachable here,
 * and the seam has no draft/send/write method to reach.
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
  APPLE_MAIL_SOURCE_ID,
  MAIL_MAILBOXES_LIST_ID,
  MAIL_MESSAGES_SEARCH_ID,
  MAIL_MESSAGE_READ_ID,
  appleMailEntries,
} from "./entries.ts";
import {
  MailInputError,
  MailNotAuthorizedError,
  selectMailProvider,
  validateReadInput,
  validateSearchInput,
  type MailProvider,
} from "./provider.ts";

/** Map a provider/validation error to a graceful, structured `transport_error`. */
function mailErrorResult(entry: CapabilityEntry, err: unknown): TransportResult {
  if (err instanceof MailNotAuthorizedError) {
    return {
      ok: false,
      error: {
        code: "transport_error",
        message: err.message,
        capabilityId: entry.id,
        detail: { reason: "not_authorized" },
      },
    };
  }
  if (err instanceof MailInputError) {
    return {
      ok: false,
      error: {
        code: "transport_error",
        message: `apple-mail: invalid input: ${err.message}`,
        capabilityId: entry.id,
        detail: { reason: "invalid_input" },
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

/** The three read handler ids this bridge serves in-process. */
const MAIL_HANDLED_IDS = new Set<string>([
  MAIL_MAILBOXES_LIST_ID,
  MAIL_MESSAGES_SEARCH_ID,
  MAIL_MESSAGE_READ_ID,
]);

export class AppleMailBridge extends BaseCapabilityBridge {
  private readonly provider: MailProvider;

  constructor(deps: BridgeDeps, sessionId: string, entries: CapabilityEntry[], provider?: MailProvider) {
    super(APPLE_MAIL_SOURCE_ID, deps, sessionId, entries);
    // Inject the provider (tests substitute a fake); default selects real/fake by env.
    this.provider = selectMailProvider(provider);
  }

  override async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    if (!MAIL_HANDLED_IDS.has(req.id)) {
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
      if (req.id === MAIL_MAILBOXES_LIST_ID) {
        const data = await this.provider.listMailboxes();
        result = { ok: true, data };
      } else if (req.id === MAIL_MESSAGES_SEARCH_ID) {
        // VALIDATE (and clamp the limit) BEFORE the provider — bad input never reaches osascript.
        const query = validateSearchInput(req.input ?? {});
        const data = await this.provider.searchMessages(query);
        result = { ok: true, data };
      } else {
        const args = validateReadInput(req.input ?? {});
        const data = await this.provider.readMessage(args);
        result = { ok: true, data };
      }
    } catch (err) {
      result = mailErrorResult(entry, err);
    }

    const audit = await this.deps.audit({
      type: "invoke",
      jti: ctx.jti,
      sessionId: ctx.sessionId,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      capabilityId: entry.id,
      verbs: entry.grants,
      outcome: result.ok ? "ok" : "error",
      // Redaction-safe: op + kind only — never senders/subjects/bodies.
      detail: { transport: "in-process", kind: entry.kind, op: req.id },
      // Request + result for the Activity view (writer redacts + truncates).
      input: req.input ?? {},
      output: result.ok ? result.data : result.error,
    });
    return normalizeResult(entry.id, result, audit.id);
  }
}

/** Re-export so the module factory can build the full read-only entry set. */
export { appleMailEntries };
