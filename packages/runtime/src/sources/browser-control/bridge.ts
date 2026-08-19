/**
 * browser-control PER-SESSION bridge — where the origin gate actually runs.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD: no CDP command is issued against a page until that
 * page's origin has been judged. `navigate` is judged on its DESTINATION; every other op is
 * judged on the target tab's CURRENT url, re-read from the browser at call time rather than
 * remembered — a tab that was on an authorized site a minute ago may not be now, and a decision
 * cached across calls would be a decision about the wrong page.
 *
 * WHAT IS REUSED ACROSS CALLS IS THE TRANSPORT, NEVER THE VERDICT. A debugging socket is held
 * open for the life of the session, so a run of calls on one tab is a continuous conversation
 * instead of a redial per invoke — which in `attach` mode is also what stops Chrome being asked
 * to re-authorize between two steps of the same task. The gate above still runs every call.
 * Holding the socket makes that tab exclusively this session's: Chrome hands out one debugger
 * per target.
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
import {
  attachFiles,
  DRIVABLE_TARGET_TYPES,
  evaluate,
  isSocketGone,
  type CdpConversation,
  type CdpTarget,
} from "./cdp.ts";
import { confineToVault } from "../obsidian/vault-reader.ts";
import { basename } from "node:path";
import { statSync } from "node:fs";
import { judgeUrl, refusalMessage } from "./origin-gate.ts";
import { cdpRefusal, judgeCdpMethod } from "./cdp-policy.ts";
import {
  loadBrowserControlConfig,
  openBrowser,
  rememberOwnTab,
  type BrowserControlConfig,
} from "./endpoint.ts";
import {
  BROWSER_CONTROL_SOURCE_ID,
  BC_TABS_ID,
  BC_READ_ID,
  BC_SCREENSHOT_ID,
  BC_NAVIGATE_ID,
  BC_CLICK_ID,
  BC_TYPE_ID,
  BC_SCROLL_ID,
  BC_WAIT_ID,
  BC_ELEMENTS_ID,
  BC_PRESS_ID,
  BC_UPLOAD_ID,
  BC_FRAMES_ID,
  BC_EVALUATE_ID,
  BC_CDP_ID,
} from "./entries.ts";


/**
 * JS PRELUDE shared by every expression that touches an element.
 *
 * `__q` is the ONE resolver. A selector the snapshot hands back must resolve in the acting
 * verbs — patching shadow-DOM support into only some expressions passes tests while real use
 * breaks, because modern component libraries put the whole form inside a shadow root.
 *
 * A shadow-hosted element has NO document-level CSS path, so selectors are HOP PATHS:
 * `my-form >>> input[name="email"]` means "find the host, cross into its shadow root, then
 * find the field". A closed shadow root is invisible to page JS and stays unreachable.
 */
const PAGE_HELPERS = `
  const __q = (sel) => {
    let ctx = document, el = null;
    for (const hop of String(sel).split('>>>')) {
      el = ctx.querySelector(hop.trim());
      if (!el) return null;
      ctx = el.shadowRoot ?? el;
    }
    return el;
  };
  const __seg = (el) => {
    const root = el.getRootNode();
    if (el.id && root.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const name = el.getAttribute && el.getAttribute('name');
    if (name) {
      const sel = el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']';
      if (root.querySelectorAll(sel).length === 1) return sel;
    }
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const tag = n.tagName.toLowerCase();
      const sibs = [...(n.parentElement ?? n.getRootNode()).children ?? []].filter((c) => c.tagName === n.tagName);
      parts.unshift(sibs.length > 1 ? tag + ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')' : tag);
      if (!n.parentElement) break;
    }
    return parts.join(' > ');
  };
  /** Full path, crossing shadow boundaries as \`>>>\` hops. */
  const __path = (el) => {
    const hops = [];
    let node = el;
    while (node) {
      hops.unshift(__seg(node));
      const root = node.getRootNode();
      node = root instanceof ShadowRoot ? root.host : null;
    }
    return hops.join(' >>> ');
  };
  /** Every element matching, including inside OPEN shadow roots. */
  const __deepAll = (root, selector) => {
    const out = [...root.querySelectorAll(selector)];
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) out.push(...__deepAll(el.shadowRoot, selector));
    }
    return out;
  };
`;

/** Keys `page.press` accepts. A full keymap is where this bloats; these are the ones that act. */
const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
};

/** How much rendered page text a read returns. Enough to decide on; not a scraping channel. */
const TEXT_LIMIT = 8_000;

const PAGE_OPS = new Set<string>([
  BC_READ_ID,
  BC_SCREENSHOT_ID,
  BC_NAVIGATE_ID,
  BC_CLICK_ID,
  BC_TYPE_ID,
  BC_SCROLL_ID,
  BC_WAIT_ID,
  BC_ELEMENTS_ID,
  BC_PRESS_ID,
  BC_UPLOAD_ID,
  BC_FRAMES_ID,
  BC_EVALUATE_ID,
  BC_CDP_ID,
]);

/** Bounds on `page.wait` — long enough for a slow app, short enough not to hold a grant open. */
const WAIT_DEFAULT_MS = 10_000;
const WAIT_MAX_MS = 30_000;
const WAIT_POLL_MS = 250;

/** Bounds on the post-navigation settle — the document finishing, not the app finishing. */
const SETTLE_MAX_MS = 15_000;
const SETTLE_POLL_MS = 100;

/** How many interactive elements a snapshot returns. Enough for a page; not a DOM dump. */
const ELEMENTS_DEFAULT = 100;
const ELEMENTS_MAX = 300;

/**
 * Set a field's value THE WAY A KEYSTROKE DOES.
 *
 * Assigning `el.value` directly is the obvious approach and it silently fails on every app
 * framework that tracks its own state: React installs its own `value` setter on the prototype,
 * sees no change when the property is written behind its back, and swallows the event — so the
 * field looks filled, the app's state is empty, and the call reports success. Going through the
 * NATIVE prototype setter is what makes the framework's tracker observe a real change.
 *
 * Returns whether the field actually holds the value now — the caller reports that, never the
 * value itself, which may be sensitive even when the skill says not to type secrets.
 */
const SET_VALUE_EXPR = (selector: string, text: string) => `(() => {${PAGE_HELPERS}
  const el = __q(${JSON.stringify(selector)});
  if (!el) return { found: false };
  const want = ${JSON.stringify(text)};
  el.focus?.();
  if (el.tagName === 'SELECT') {
    const opt = [...el.options].find((o) => o.value === want)
             ?? [...el.options].find((o) => (o.label ?? o.text ?? '').trim() === want);
    if (!opt) return { found: true, ok: false, reason: 'no such option' };
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { found: true, ok: el.value === opt.value };
  }
  if (el.isContentEditable) {
    el.textContent = want;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return { found: true, ok: (el.textContent ?? '') === want };
  }
  if (!('value' in el)) return { found: true, ok: false, reason: 'not a field you can type into' };
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, want); else el.value = want;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { found: true, ok: el.value === want };
})()`;

/**
 * Snapshot the interactive elements, each with a selector that will still resolve on the next
 * call. The selector is COMPUTED and the DOM is left untouched — stamping ref attributes onto
 * the user's page would be a mutation we have no business making just to look at it.
 */
const ELEMENTS_EXPR = (within: string | undefined, limit: number) => `(() => {${PAGE_HELPERS}
  const root = ${within ? `__q(${JSON.stringify(within)})` : "document"};
  if (!root) return { elements: [], truncated: false, rootMissing: true };
  const labelOf = (el) => {
    const r = el.getRootNode();
    const byFor = el.id && r.querySelector && r.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    const txt = (byFor?.innerText ?? el.closest?.('label')?.innerText ?? el.getAttribute?.('aria-label')
              ?? el.getAttribute?.('placeholder') ?? el.innerText ?? '').trim();
    return txt.slice(0, 120);
  };
  const all = __deepAll(root.shadowRoot ?? root, 'input, textarea, select, button, a[href], [contenteditable=""], [contenteditable="true"], [role=button], [role=textbox]');
  const out = [];
  for (const el of all) {
    if (out.length >= ${limit}) return { elements: out, truncated: true };
    const rect = el.getBoundingClientRect();
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    const e = {
      selector: __path(el),
      tag: el.tagName.toLowerCase(),
      ...(type ? { type } : {}),
      ...(el.name ? { name: el.name } : {}),
      label: labelOf(el),
      visible: rect.width > 0 && rect.height > 0,
    };
    // A password's CONTENT never leaves the page; its length is enough to tell filled from empty.
    if (type === 'password') e.valueLength = (el.value ?? '').length;
    else if ('value' in el && el.tagName !== 'BUTTON') e.value = String(el.value ?? '').slice(0, 200);
    else if (el.isContentEditable) e.value = (el.textContent ?? '').slice(0, 200);
    if (el.type === 'checkbox' || el.type === 'radio') e.checked = !!el.checked;
    if (el.required) e.required = true;
    if (el.disabled) e.disabled = true;
    if (el.tagName === 'SELECT') e.options = [...el.options].map((o) => o.value).slice(0, 50);
    out.push(e);
  }
  return { elements: out, truncated: false };
})()`;

function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

/** The page-state read every op ends with, so the agent always learns where it actually is. */
const PAGE_STATE_EXPR = `({ url: location.href, title: document.title })`;

export class BrowserControlBridge extends BaseCapabilityBridge {
  private readonly fixedCfg?: BrowserControlConfig;
  /** The tab Plexus opened for this session — the polite default in attach mode. */
  private ownTargetId?: string;
  /** Debugging sockets held open per tab, so consecutive calls do not redial. */
  private readonly sockets = new Map<string, CdpConversation>();

  constructor(deps: BridgeDeps, sessionId: string, entries: CapabilityEntry[], cfg?: BrowserControlConfig) {
    super(BROWSER_CONTROL_SOURCE_ID, deps, sessionId, entries);
    this.fixedCfg = cfg;
  }

  /**
   * The owner's configuration, re-read per call.
   *
   * A change in the console takes effect on the NEXT invoke rather than the next restart —
   * "let it work on this site too" should not require the gateway to come down. A config
   * injected at construction (tests) is used verbatim and never re-read.
   */
  private get cfg(): BrowserControlConfig {
    return this.fixedCfg ?? loadBrowserControlConfig();
  }


  /**
   * Is this browser one with nothing to protect?
   *
   * A browser Plexus LAUNCHED runs on its own empty profile: no cookies, no logged-in sessions.
   * With no domains named, the open web is the sensible default there — a wall around a browser
   * that is nobody protects nothing. The owner's OWN browser is the opposite case, and an empty
   * list there still means "refuse everything".
   */
  private get unrestricted(): boolean {
    // Only a browser PLEXUS launched has nothing to protect. `attach` and `extension` both drive
    // the owner's own, logged-in browser, where an empty list means refuse everything.
    return this.cfg.mode === "launch" && this.cfg.allowlist.length === 0;
  }

  /** The gate, carrying this browser's policy. Every judgement in this file goes through it. */
  private judge(url: string | undefined) {
    return judgeUrl(url, this.cfg.allowlist, this.unrestricted);
  }

  override async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    if (req.id !== BC_TABS_ID && !PAGE_OPS.has(req.id)) return super.invoke(req, ctx);

    const entry = this.deps.getEntry(req.id) ?? this.getCapabilities().find((e) => e.id === req.id);
    if (!entry) return super.invoke(req, ctx);

    const input = req.input ?? {};
    let result: TransportResult;
    /** Owner-only diagnostics — the audit's, never the wire's. */
    let diagnostics: Record<string, unknown> = { mode: this.cfg.mode, unrestricted: this.unrestricted };

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
    if (id === BC_TABS_ID || id === BC_FRAMES_ID) {
      const browser = await openBrowser(this.cfg);
      const targets = await browser.listTargets(id === BC_FRAMES_ID ? ["iframe"] : ["page"]);
      // The allowlist is also the DIRECTORY: a tab on an unauthorized origin is not listed, so
      // the agent never learns the owner has it open.
      const visible = targets.filter((t) => this.judge(t.url).allowed);
      const listed = visible.map((t) => ({ targetId: t.targetId, title: t.title, url: t.url }));
      return {
        data: { mode: this.cfg.mode, ...(id === BC_FRAMES_ID ? { frames: listed } : { tabs: listed }) },
        diagnostics: { connection: browser.kind, totalTargets: targets.length, visibleTargets: visible.length },
      };
    }

    const requested = strOf(input.targetId);
    const held = await this.acquire(requested, id === BC_NAVIGATE_ID);
    try {
      const out = await this.act(id, input, held.session, held.targetId);
      return { ...out, diagnostics: { ...out.diagnostics, reusedSocket: held.reused } };
    } catch (err) {
      // A held socket can die between calls — the tab was closed, the browser quit. That error
      // proves NOTHING RAN, which is the only reason repeating the call is safe: retrying on any
      // other failure could click twice. Re-establish once, then let a second failure through.
      if (!held.reused || !isSocketGone(err)) throw err;
      this.drop(held.targetId);
      const fresh = await this.acquire(requested, id === BC_NAVIGATE_ID);
      const out = await this.act(id, input, fresh.session, fresh.targetId);
      return { ...out, diagnostics: { ...out.diagnostics, reusedSocket: false, reconnected: true } };
    }
  }

  /**
   * Get a debugging socket for the tab this call acts on, reusing a held one when possible.
   *
   * The reuse shortcut applies ONLY to the tab Plexus opened for this session. A call that names
   * a `targetId` always goes through discovery and {@link pickTarget}, so a named tab is judged
   * the same way every time and an unknown id cannot be answered differently from an
   * unauthorized one.
   */
  private async acquire(
    requested: string | undefined,
    mayCreate: boolean,
  ): Promise<{ session: CdpConversation; targetId: string; reused: boolean }> {
    if (!requested && this.ownTargetId) {
      const open = this.sockets.get(this.ownTargetId);
      if (open?.isOpen) return { session: open, targetId: this.ownTargetId, reused: true };
    }
    const browser = await openBrowser(this.cfg);
    const targets = await browser.listTargets(DRIVABLE_TARGET_TYPES);
    const target = await this.pickTarget(targets, requested, browser, mayCreate);
    const open = this.sockets.get(target.targetId);
    if (open?.isOpen) return { session: open, targetId: target.targetId, reused: true };
    this.drop(target.targetId);
    const session = await browser.session(target);
    this.sockets.set(target.targetId, session);
    return { session, targetId: target.targetId, reused: false };
  }

  /**
   * One character as a real key event, so a page listening for keystrokes hears it.
   *
   * A `keyDown` CARRYING `text` already inserts the character. Sending a `char` event as well
   * inserts it a second time — which types "plexus" as "pplleexxuuss".
   */
  private async typeChar(session: CdpConversation, ch: string): Promise<void> {
    const common = { text: ch, key: ch, unmodifiedText: ch };
    await session.send("Input.dispatchKeyEvent", { type: "keyDown", ...common });
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  }

  /** Forget a tab's socket, closing it if it is somehow still alive. */
  private drop(targetId: string): void {
    const open = this.sockets.get(targetId);
    this.sockets.delete(targetId);
    open?.close();
  }

  /** Judge, then act. Throws `REFUSED: …` for a boundary denial. */
  private async act(
    id: string,
    input: Record<string, unknown>,
    session: CdpConversation,
    targetId: string,
  ): Promise<{ data: Record<string, unknown>; diagnostics: Record<string, unknown> }> {
    // THE GATE — run on EVERY call, including calls that reuse a held socket. `navigate` is
    // judged on where it is GOING; every other op on where the tab currently IS, read LIVE from
    // the page rather than from the discovery listing. That listing is a snapshot that lags a
    // navigation, so gating on it would both refuse calls on pages that are now authorized and,
    // worse, admit calls on pages that have since moved away.
    let subject: string | undefined;
    if (id === BC_NAVIGATE_ID) {
      subject = strOf(input.url);
      if (!subject) throw new Error("`url` is required");
    } else {
      subject = (await evaluate<{ url: string }>(session, PAGE_STATE_EXPR)).url;
    }
    const verdict = this.judge(subject);
    if (!verdict.allowed) throw new Error(`REFUSED: ${refusalMessage(verdict)}`);

    switch (id) {
      case BC_NAVIGATE_ID: {
        await session.send("Page.enable");
        // Arm the load listener BEFORE navigating. Polling `readyState` alone is a trap: the
        // OLD document is still there and still `complete` for a moment after `Page.navigate`
        // returns, so a poll can answer about the page we are leaving — which is how a
        // navigation came back with the previous page's (empty) title.
        const loaded = session.await("Page.loadEventFired", SETTLE_MAX_MS);
        await session.send("Page.navigate", { url: subject });
        await loaded;
        const state = await this.settle(session);
        // A redirect can land off the authorized origins — report it, never follow silently.
        const after = this.judge(state.url);
        return {
          data: {
            url: state.url,
            title: state.title,
            targetId,
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
        const fullPage = input.fullPage === true;
        const shot = await session.send<{ data: string }>("Page.captureScreenshot", {
          format: "png",
          // Chrome renders past the window when asked; without this a long page is cropped to
          // whatever happens to be on screen, which reads as "the page is short".
          ...(fullPage ? { captureBeyondViewport: true } : {}),
        });
        return {
          data: { url: subject, imageBase64: shot.data ?? "", ...(fullPage ? { fullPage: true } : {}) },
          diagnostics: { origin: verdict.origin, fullPage, bytes: Math.round((shot.data?.length ?? 0) * 0.75) },
        };
      }
      case BC_CLICK_ID: {
        const selector = strOf(input.selector);
        if (!selector) throw new Error("`selector` is required");
        const clicked = await evaluate<boolean>(
          session,
          `(() => {${PAGE_HELPERS} const el = __q(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView?.({ block: 'center' }); el.click(); return true; })()`,
        );
        if (!clicked) throw new Error("no element matched that selector on this page");
        const state = await this.settle(session);
        const after = this.judge(state.url);
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
        const keystrokes = input.keystrokes === true;
        let res: { found: boolean; ok?: boolean; reason?: string };
        if (keystrokes) {
          // REAL key events. A value written into the field, however correctly, never makes a
          // search box open its suggestions — that listens for keystrokes. Slower on purpose.
          const focused = await evaluate<boolean>(
            session,
            `(() => {${PAGE_HELPERS} const el = __q(${JSON.stringify(selector)});
               if (!el) return false; el.focus?.();
               if ('value' in el) { const p = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                 Object.getOwnPropertyDescriptor(p, 'value')?.set?.call(el, ''); }
               return true; })()`,
          );
          if (!focused) throw new Error("no element matched that selector on this page");
          for (const ch of [...text]) await this.typeChar(session, ch);
          // VERIFY, never assume. Reporting `accepted` without checking is the same lie the
          // direct-value-write used to tell.
          const landed = await evaluate<boolean>(
            session,
            `(() => {${PAGE_HELPERS} const el = __q(${JSON.stringify(selector)});
               const v = el && (el.isContentEditable ? el.textContent : el.value);
               return v === ${JSON.stringify(text)}; })()`,
          );
          res = { found: true, ok: landed, reason: "the field did not end up holding that value" };
        } else {
          res = await evaluate<{ found: boolean; ok?: boolean; reason?: string }>(
            session,
            SET_VALUE_EXPR(selector, text),
          );
        }
        if (!res.found) throw new Error("no element matched that selector on this page");
        if (res.ok === false) throw new Error(res.reason ?? "the field did not accept that value");
        const state = await evaluate<{ url: string; title: string }>(session, PAGE_STATE_EXPR);
        // `accepted` is the verification the agent needs; the VALUE is never echoed back or put
        // in diagnostics — it may be sensitive even when the skill says not to type secrets.
        return {
          data: { typed: true, accepted: true, url: state.url },
          diagnostics: { selector, chars: text.length, keystrokes },
        };
      }
      case BC_SCROLL_ID: {
        const selector = strOf(input.selector);
        const to = strOf(input.to);
        const by = typeof input.by === "number" && Number.isFinite(input.by) ? input.by : undefined;
        if (!selector && !to && by === undefined) {
          throw new Error("say where to scroll: `selector`, `to` (top/bottom), or `by` (pixels)");
        }
        const move = selector
          ? `__q(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center' })`
          : to === "top"
            ? `window.scrollTo(0, 0)`
            : to === "bottom"
              ? `window.scrollTo(0, document.body.scrollHeight)`
              : `window.scrollBy(0, ${by ?? 0})`;
        const state = await evaluate<{
          url: string;
          scrollY: number;
          pageHeight: number;
          atBottom: boolean;
        }>(
          session,
          `(() => {${PAGE_HELPERS} ${move};
             const h = document.documentElement.scrollHeight;
             return { url: location.href, scrollY: Math.round(window.scrollY),
                      pageHeight: h,
                      atBottom: window.innerHeight + window.scrollY >= h - 2 }; })()`,
        );
        return { data: state, diagnostics: { origin: verdict.origin, scrollY: state.scrollY } };
      }
      case BC_WAIT_ID: {
        const selector = strOf(input.selector);
        const text = strOf(input.text);
        const budget = Math.min(
          typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? input.timeoutMs : WAIT_DEFAULT_MS,
          WAIT_MAX_MS,
        );
        const condition = selector
          ? `!!__q(${JSON.stringify(selector)})`
          : text
            ? `(document.body?.innerText ?? '').includes(${JSON.stringify(text)})`
            : `document.readyState === 'complete'`;
        const started = Date.now();
        let found = false;
        while (Date.now() - started < budget) {
          found = await evaluate<boolean>(session, `(() => {${PAGE_HELPERS} try { return ${condition} } catch { return false } })()`);
          if (found) break;
          await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
        }
        const state = await evaluate<{ url: string; title: string }>(session, PAGE_STATE_EXPR);
        // A timeout is an ANSWER, not a failure: the agent learns the thing is not there yet and
        // decides whether to wait again. Throwing would make it look like the call broke.
        return {
          data: { url: state.url, title: state.title, found, waitedMs: Date.now() - started },
          diagnostics: { origin: verdict.origin, waitedFor: selector ?? text ?? "load", found },
        };
      }
      case BC_PRESS_ID: {
        const key = strOf(input.key);
        if (!key) throw new Error("`key` is required");
        const spec = KEYS[key];
        if (!spec) throw new Error(`unsupported key ${key} — use ${Object.keys(KEYS).join(", ")}`);
        const selector = strOf(input.selector);
        if (selector) {
          const focused = await evaluate<boolean>(
            session,
            `(() => {${PAGE_HELPERS} const el = __q(${JSON.stringify(selector)}); if (!el) return false; el.focus?.(); return true; })()`,
          );
          if (!focused) throw new Error("no element matched that selector on this page");
        }
        const base = {
          key: spec.key,
          code: spec.code,
          windowsVirtualKeyCode: spec.vk,
          nativeVirtualKeyCode: spec.vk,
          ...(spec.text ? { text: spec.text } : {}),
        };
        await session.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
        await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
        // Enter can submit, so where the tab ends up is part of the answer.
        const state = await this.settle(session);
        const after = this.judge(state.url);
        return {
          data: { pressed: key, url: state.url, ...(after.allowed ? {} : { leftAuthorizedOrigin: true }) },
          diagnostics: { key, landedOn: state.url, stillAuthorized: after.allowed },
        };
      }
      case BC_UPLOAD_ID: {
        const selector = strOf(input.selector);
        const rel = strOf(input.path);
        if (!selector) throw new Error("`selector` is required");
        if (!rel) throw new Error("`path` is required");
        // FAIL CLOSED, exactly like an empty allowlist: no upload directory means no uploads.
        if (!this.cfg.uploadDir) {
          throw new Error(
            "REFUSED: no upload directory is set, so no file can be attached. The owner sets one " +
              "aside for this in Plexus → What I expose → Browser control.",
          );
        }
        // The SAME confinement the file sources use — lexical reject plus a realpath re-check,
        // so a symlink inside the directory cannot point out of it.
        let abs: string;
        try {
          abs = confineToVault(this.cfg.uploadDir, rel);
        } catch {
          throw new Error("REFUSED: that path is outside the owner's upload directory.");
        }
        const bytes = statSync(abs).size;
        await attachFiles(session, selector, [abs]);
        const state = await evaluate<{ url: string; title: string }>(session, PAGE_STATE_EXPR);
        // The wire gets the FILE NAME; where it lives on this machine is the owner's business.
        return {
          data: { attached: true, fileName: basename(abs), url: state.url },
          diagnostics: { selector, path: abs, bytes },
        };
      }
      case BC_EVALUATE_ID: {
        const expression = strOf(input.expression);
        if (!expression) throw new Error("`expression` is required");
        const value = await evaluate<unknown>(session, expression);
        // The expression can navigate the tab. Report where it ended up, the same way `click`
        // does — the agent cannot READ an unauthorized landing page, but it should know.
        const state = await evaluate<{ url: string; title: string }>(session, PAGE_STATE_EXPR).catch(
          () => ({ url: subject, title: "" }),
        );
        const after = this.judge(state.url);
        return {
          data: {
            value,
            url: state.url,
            ...(after.allowed ? {} : { leftAuthorizedOrigin: true }),
          },
          diagnostics: { origin: verdict.origin, chars: expression.length, stillAuthorized: after.allowed },
        };
      }
      case BC_CDP_ID: {
        const method = strOf(input.method);
        const policy = judgeCdpMethod(method);
        if (!policy.allowed) throw new Error(`REFUSED: ${cdpRefusal(policy)}`);
        const params = (input.params ?? {}) as Record<string, unknown>;
        const result = await session.send<unknown>(method!, params);
        const state = await evaluate<{ url: string; title: string }>(session, PAGE_STATE_EXPR).catch(
          () => ({ url: subject, title: "" }),
        );
        const after = this.judge(state.url);
        return {
          data: { result, url: state.url, ...(after.allowed ? {} : { leftAuthorizedOrigin: true }) },
          diagnostics: { origin: verdict.origin, method, domain: policy.domain, stillAuthorized: after.allowed },
        };
      }
      case BC_ELEMENTS_ID: {
        const within = strOf(input.within);
        const limit = Math.min(
          typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : ELEMENTS_DEFAULT,
          ELEMENTS_MAX,
        );
        const snap = await evaluate<{
          elements: Record<string, unknown>[];
          truncated: boolean;
          rootMissing?: boolean;
        }>(session, ELEMENTS_EXPR(within, limit));
        if (snap.rootMissing) throw new Error("no element matched `within` on this page");
        return {
          data: { url: subject, elements: snap.elements, truncated: snap.truncated },
          diagnostics: { origin: verdict.origin, count: snap.elements.length, truncated: snap.truncated },
        };
      }
      default:
        throw new Error(`unsupported op ${id}`);
    }
  }

  /** Resolve which tab to act on, opening Plexus's own when none is named. */
  private async pickTarget(
    targets: CdpTarget[],
    requested: string | undefined,
    browser: { createTarget(): Promise<CdpTarget> },
    mayCreate: boolean,
  ): Promise<CdpTarget> {
    if (requested) {
      const found = targets.find((t) => t.targetId === requested);
      // An unlisted tab is refused with the SAME message as an unauthorized one, so the id
      // cannot be used to probe which tabs the owner has open.
      if (!found || !this.judge(found.url).allowed) {
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
    const created = await browser.createTarget();
    rememberOwnTab(created.targetId);
    this.ownTargetId = created.targetId;
    return created;
  }

  /**
   * Confirm the document is done, then report where the tab actually is.
   *
   * Called after the load event, so this only covers documents that finish without firing one.
   * An app that keeps rendering after `load` still needs `page.wait`; this promises the
   * document is done, never that the app is.
   */
  private async settle(session: CdpConversation): Promise<{ url: string; title: string }> {
    const deadline = Date.now() + SETTLE_MAX_MS;
    while (Date.now() < deadline) {
      const done = await evaluate<boolean>(session, `document.readyState === 'complete'`).catch(() => false);
      if (done) break;
      await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
    }
    // Reading state can land exactly on a context swap ("execution context was destroyed"),
    // which is a transient of navigating, not a failed navigation. Retry briefly before
    // reporting failure for a page that in fact loaded.
    for (let attempt = 0; ; attempt++) {
      try {
        return await evaluate<{ url: string; title: string }>(session, PAGE_STATE_EXPR);
      } catch (err) {
        if (attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
      }
    }
  }
}
