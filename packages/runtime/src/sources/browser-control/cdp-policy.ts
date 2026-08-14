/**
 * WHICH CDP COMMANDS ARE PAGE-SCOPED — the one line that keeps the domain boundary true.
 *
 * The owner's real decision is WHICH BROWSER an agent gets: a fresh empty profile that is
 * nobody, or the browser they are logged into. Inside an authorized page, withholding verbs
 * buys nothing — `click` + `type` already equal full user agency on that site — so the page
 * surface is open, `Runtime.evaluate` included.
 *
 * What is NOT open is the part of CDP that does not belong to any page. Chrome's protocol mixes
 * two very different things under one socket:
 *
 *   PAGE-SCOPED     acts as the document you are attached to, and is therefore bounded by the
 *                   browser's OWN same-origin policy. "Anything you like, as github.com" is a
 *                   real limit enforced by the browser, not by us.
 *   BROWSER-GLOBAL  acts as the browser. `Target.attachToTarget` reaches the tab holding your
 *                   bank; `Network.getAllCookies` hands over every site at once. These take the
 *                   domain out of the question entirely.
 *
 * Withholding the second group is what lets "the agent can do anything on github.com, and
 * cannot reach your bank" stay a true sentence rather than a slogan.
 *
 * ALLOWLIST, NOT DENYLIST. A domain Chrome adds next version is refused until someone looks at
 * it. A denylist would silently open each new hole on upgrade.
 */

/**
 * Domains that act as the attached page.
 *
 * `Debugger`/`Profiler`/`HeapProfiler` are included deliberately: they inspect the page's own
 * JavaScript, which `Runtime.evaluate` already reaches.
 */
const PAGE_DOMAINS = new Set([
  "Accessibility",
  "Animation",
  "Audits",
  "CSS",
  "DOM",
  "DOMDebugger",
  "DOMSnapshot",
  "Debugger",
  "Emulation",
  "Fetch",
  "HeapProfiler",
  "IO",
  "Input",
  "LayerTree",
  "Log",
  "Media",
  "Network",
  "Overlay",
  "Page",
  "Performance",
  "PerformanceTimeline",
  "Profiler",
  "Runtime",
  "WebAudio",
]);

/**
 * Commands inside a page domain that are NOT page-scoped, or that would step around a boundary
 * Plexus enforces elsewhere. Each is here for its own reason:
 *
 *  - the cookie jar is shared by every site, so any command that reads or writes it by URL or
 *    in bulk is a way to ask about a site you were never authorized for;
 *  - `Page.navigate` is the domain gate's primary subject and has its own gated verb, so
 *    accepting it raw would be a second, ungated door to the same act;
 *  - `DOM.setFileInputFiles` is how a file leaves this machine, and it has its own jailed verb;
 *  - the download-behaviour setters choose where the browser writes to disk, which is a
 *    machine-level decision rather than a page one.
 */
const BLOCKED_METHODS = new Set([
  "Network.getAllCookies",
  "Network.getCookies",
  "Network.setCookie",
  "Network.setCookies",
  "Network.deleteCookies",
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
  "Page.navigate",
  "Page.navigateToHistoryEntry",
  "Page.setDownloadBehavior",
  "DOM.setFileInputFiles",
]);

export type CdpMethodVerdict =
  | { allowed: true; domain: string }
  | { allowed: false; reason: "malformed" | "browser-global" | "blocked-method"; domain?: string };

/** Split `Domain.command`; anything else is malformed. */
export function judgeCdpMethod(method: string | undefined): CdpMethodVerdict {
  const raw = (method ?? "").trim();
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1 || raw.slice(dot + 1).includes(".")) {
    return { allowed: false, reason: "malformed" };
  }
  const domain = raw.slice(0, dot);
  if (!PAGE_DOMAINS.has(domain)) return { allowed: false, reason: "browser-global", domain };
  if (BLOCKED_METHODS.has(raw)) return { allowed: false, reason: "blocked-method", domain };
  return { allowed: true, domain };
}

/**
 * The agent-facing refusal. Says what class the command falls in and what to use instead, and
 * never enumerates the rest of the policy — a denial should not be a way to map the surface.
 */
export function cdpRefusal(v: Extract<CdpMethodVerdict, { allowed: false }>): string {
  switch (v.reason) {
    case "malformed":
      return "`method` must be a CDP command of the form `Domain.command`.";
    case "browser-global":
      return (
        `${v.domain ?? "that"} acts on the browser rather than on this page, so it is not ` +
        `available. Everything that acts as the page you are on is.`
      );
    case "blocked-method":
      return (
        "that command reaches past the page it is issued on. Navigation, file attachment and " +
        "the cookie jar have their own capabilities, which apply the owner's boundaries."
      );
  }
}
