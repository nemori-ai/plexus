/**
 * browser-control PER-SESSION bridge — where the origin gate actually runs.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD: no CDP command is issued against a page until that
 * page's origin has been judged. `navigate` is judged on its DESTINATION; every other op is
 * judged on the target tab's CURRENT url, re-read from the browser at call time rather than
 * remembered — a tab that was on an authorized site a minute ago may not be now, and a decision
 * cached across calls would be a decision about the wrong page.
 *
 * The wire result carries the page's own content and nothing about the machine: no profile path,
 * no binary path, no port, no other tabs. Those are the owner's, and they go to the audit.
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
import { CdpSession, createTarget, evaluate, listTargets, type CdpTarget } from "./cdp.ts";
import { judgeUrl, refusalMessage } from "./origin-gate.ts";
import { loadBrowserControlConfig, resolveEndpoint, type BrowserControlConfig } from "./endpoint.ts";
import {
  BROWSER_CONTROL_SOURCE_ID,
  BC_TABS_ID,
  BC_READ_ID,
  BC_SCREENSHOT_ID,
  BC_NAVIGATE_ID,
  BC_CLICK_ID,
  BC_TYPE_ID,
} from "./entries.ts";

/** How much rendered page text a read returns. Enough to decide on; not a scraping channel. */
const TEXT_LIMIT = 8_000;

const PAGE_OPS = new Set<string>([BC_READ_ID, BC_SCREENSHOT_ID, BC_NAVIGATE_ID, BC_CLICK_ID, BC_TYPE_ID]);

function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

/** The page-state read every op ends with, so the agent always learns where it actually is. */
const PAGE_STATE_EXPR = `({ url: location.href, title: document.title })`;

export class BrowserControlBridge extends BaseCapabilityBridge {
  private readonly cfg: BrowserControlConfig;
  /** The tab Plexus opened for this session — the polite default in attach mode. */
  private ownTargetId?: string;

  constructor(deps: BridgeDeps, sessionId: string, entries: CapabilityEntry[], cfg?: BrowserControlConfig) {
    super(BROWSER_CONTROL_SOURCE_ID, deps, sessionId, entries);
    this.cfg = cfg ?? loadBrowserControlConfig();
  }

  override async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    if (req.id !== BC_TABS_ID && !PAGE_OPS.has(req.id)) return super.invoke(req, ctx);

    const entry = this.deps.getEntry(req.id) ?? this.getCapabilities().find((e) => e.id === req.id);
    if (!entry) return super.invoke(req, ctx);

    const input = req.input ?? {};
    let result: TransportResult;
    /** Owner-only diagnostics — the audit's, never the wire's. */
    let diagnostics: Record<string, unknown> = { mode: this.cfg.mode };

    try {
      const out = await this.run(req.id, input);
      result = { ok: true, data: out.data };
      diagnostics = { ...diagnostics, ...out.diagnostics };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diagnostics = { ...diagnostics, error: message };
      result = {
        ok: false,
        error: {
          code: message.startsWith("REFUSED:") ? "grant_required" : "transport_error",
          message: message.replace(/^REFUSED:\s*/, ""),
        },
      };
    }

    const audit = await this.deps.audit({
      type: "invoke",
      jti: ctx.jti,
      sessionId: ctx.sessionId,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      capabilityId: entry.id,
      verbs: entry.grants,
      outcome: result.ok ? "ok" : "error",
      // The owner sees WHICH mode, WHICH origin and WHY a call was refused. The agent's result
      // carries none of the machine-shaped detail.
      detail: { transport: "in-process", kind: entry.kind, ...diagnostics },
      input,
      output: result.ok ? result.data : result.error,
    });
    return normalizeResult(entry.id, result, audit.id);
  }

  /** Dispatch one op. Throws `REFUSED: …` for a boundary denial, plain errors for failures. */
  private async run(
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ data: Record<string, unknown>; diagnostics: Record<string, unknown> }> {
    const endpoint = await resolveEndpoint(this.cfg);
    const targets = await listTargets(endpoint);

    if (id === BC_TABS_ID) {
      // The allowlist is also the DIRECTORY: a tab on an unauthorized origin is not listed, so
      // the agent never learns the owner has it open.
      const visible = targets.filter((t) => judgeUrl(t.url, this.cfg.allowlist).allowed);
      return {
        data: {
          mode: this.cfg.mode,
          tabs: visible.map((t) => ({ targetId: t.targetId, title: t.title, url: t.url })),
        },
        diagnostics: { totalTargets: targets.length, visibleTargets: visible.length },
      };
    }

    const target = await this.pickTarget(targets, strOf(input.targetId), endpoint, id === BC_NAVIGATE_ID);

    const session = await CdpSession.open(target);
    try {
      // THE GATE. `navigate` is judged on where it is GOING; every other op on where the tab
      // currently IS — read LIVE from the page, not from the discovery listing. That listing is
      // a snapshot that lags a navigation, so gating on it would both refuse calls on pages that
      // are now authorized and, worse, admit calls on pages that have since moved away.
      let subject: string | undefined;
      if (id === BC_NAVIGATE_ID) {
        subject = strOf(input.url);
        if (!subject) throw new Error("`url` is required");
      } else {
        subject = (await evaluate<{ url: string }>(session, PAGE_STATE_EXPR)).url;
      }
      const verdict = judgeUrl(subject, this.cfg.allowlist);
      if (!verdict.allowed) throw new Error(`REFUSED: ${refusalMessage(verdict)}`);

      switch (id) {
        case BC_NAVIGATE_ID: {
          await session.send("Page.enable");
          await session.send("Page.navigate", { url: subject });
          const state = await this.settle(session);
          // A redirect can land off the authorized origins — report it, never follow silently.
          const after = judgeUrl(state.url, this.cfg.allowlist);
          return {
            data: {
              url: state.url,
              title: state.title,
              targetId: target.targetId,
              ...(after.allowed ? {} : { leftAuthorizedOrigin: true }),
            },
            diagnostics: { requested: subject, landedOn: state.url, stillAuthorized: after.allowed },
          };
        }
        case BC_READ_ID: {
          const page = await evaluate<{ url: string; title: string; text: string }>(
            session,
            `({ url: location.href, title: document.title, text: (document.body?.innerText ?? '').slice(0, ${TEXT_LIMIT + 1}) })`,
          );
          const truncated = (page.text ?? "").length > TEXT_LIMIT;
          return {
            data: {
              url: page.url,
              title: page.title,
              text: (page.text ?? "").slice(0, TEXT_LIMIT),
              truncated,
            },
            diagnostics: { origin: verdict.origin, truncated },
          };
        }
        case BC_SCREENSHOT_ID: {
          const shot = await session.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
          return {
            data: { url: subject, imageBase64: shot.data ?? "" },
            diagnostics: { origin: verdict.origin, bytes: Math.round((shot.data?.length ?? 0) * 0.75) },
          };
        }
        case BC_CLICK_ID: {
          const selector = strOf(input.selector);
          if (!selector) throw new Error("`selector` is required");
          const clicked = await evaluate<boolean>(
            session,
            `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
          );
          if (!clicked) throw new Error("no element matched that selector on this page");
          const state = await this.settle(session);
          const after = judgeUrl(state.url, this.cfg.allowlist);
          return {
            data: { clicked: true, url: state.url, ...(after.allowed ? {} : { leftAuthorizedOrigin: true }) },
            diagnostics: { selector, landedOn: state.url, stillAuthorized: after.allowed },
          };
        }
        case BC_TYPE_ID: {
          const selector = strOf(input.selector);
          const text = typeof input.text === "string" ? input.text : undefined;
          if (!selector) throw new Error("`selector` is required");
          if (text === undefined) throw new Error("`text` is required");
          const typed = await evaluate<boolean>(
            session,
            `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
               el.focus(); el.value = ${JSON.stringify(text)};
               el.dispatchEvent(new Event('input', { bubbles: true }));
               el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
          );
          if (!typed) throw new Error("no element matched that selector on this page");
          const state = await evaluate<{ url: string; title: string }>(session, PAGE_STATE_EXPR);
          // The typed VALUE is never echoed back or put in diagnostics — it may be sensitive
          // even when the skill says not to type secrets.
          return { data: { typed: true, url: state.url }, diagnostics: { selector, chars: text.length } };
        }
        default:
          throw new Error(`unsupported op ${id}`);
      }
    } finally {
      session.close();
    }
  }

  /** Resolve which tab to act on, opening Plexus's own when none is named. */
  private async pickTarget(
    targets: CdpTarget[],
    requested: string | undefined,
    endpoint: { host: string; port: number },
    mayCreate: boolean,
  ): Promise<CdpTarget> {
    if (requested) {
      const found = targets.find((t) => t.targetId === requested);
      // An unlisted tab is refused with the SAME message as an unauthorized one, so the id
      // cannot be used to probe which tabs the owner has open.
      if (!found || !judgeUrl(found.url, this.cfg.allowlist).allowed) {
        throw new Error("REFUSED: that tab is not one you are authorized to drive.");
      }
      return found;
    }
    if (this.ownTargetId) {
      const mine = targets.find((t) => t.targetId === this.ownTargetId);
      if (mine) return mine;
    }
    // No tab of ours yet. Only `navigate` may create one — a read has nothing to read on a
    // blank page, and silently opening tabs during a read would be a side effect on a read verb.
    if (!mayCreate) {
      throw new Error("no tab to act on yet — navigate somewhere first, or pass a targetId from tabs.list");
    }
    const created = await createTarget(endpoint);
    this.ownTargetId = created.targetId;
    return created;
  }

  /** Let a navigation settle, then report where the tab actually is. */
  private async settle(session: CdpSession): Promise<{ url: string; title: string }> {
    await new Promise((r) => setTimeout(r, 800));
    return evaluate<{ url: string; title: string }>(session, PAGE_STATE_EXPR);
  }
}
