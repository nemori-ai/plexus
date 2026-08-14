/**
 * WHICH CDP COMMANDS ARE PAGE-SCOPED — the split that decides whether "the agent can do
 * anything on github.com, and cannot reach your bank" is true or merely said.
 *
 * The page surface is deliberately wide (arbitrary JavaScript included), because inside an
 * authorized page `click` + `type` already equal full user agency and withholding verbs only
 * costs capability. What must NOT be reachable is the part of CDP that acts on the browser
 * instead of the page — that is the part that takes the domain out of the question.
 */
import { describe, it, expect } from "bun:test";
import { cdpRefusal, judgeCdpMethod } from "@plexus/runtime/sources/browser-control/cdp-policy.ts";

const refused = (m: string) => judgeCdpMethod(m) as Extract<ReturnType<typeof judgeCdpMethod>, { allowed: false }>;

describe("cdp policy — the page surface is open", () => {
  it("allows the commands that act as the page, arbitrary evaluation included", () => {
    for (const m of [
      "Runtime.evaluate",
      "Runtime.callFunctionOn",
      "DOM.getDocument",
      "DOM.querySelector",
      "Page.captureScreenshot",
      "Page.reload",
      "Input.dispatchKeyEvent",
      "Input.dispatchMouseEvent",
      "Emulation.setDeviceMetricsOverride",
      "Network.enable",
      "Network.getResponseBody",
      "Debugger.setBreakpointByUrl",
      "Performance.getMetrics",
      "Accessibility.getFullAXTree",
      "Log.enable",
      "Fetch.enable",
    ]) {
      expect(judgeCdpMethod(m).allowed).toBe(true);
    }
  });
});

describe("cdp policy — the browser surface is not", () => {
  it("refuses whole domains that act on the browser rather than the page", () => {
    // `Target.attachToTarget` would reach the tab holding the owner's bank; `Browser.*` and
    // `Storage.*` take origin arguments, so they answer about sites nobody authorized.
    for (const m of [
      "Target.attachToTarget",
      "Target.createTarget",
      "Target.getTargets",
      "Browser.setDownloadBehavior",
      "Browser.getVersion",
      "Storage.getCookies",
      "Storage.clearDataForOrigin",
      "SystemInfo.getInfo",
      "Autofill.trigger",
    ]) {
      const v = refused(m);
      expect(v.allowed).toBe(false);
      expect(v.reason).toBe("browser-global");
    }
  });

  it("refuses the cookie jar even from a page domain — it is shared by every site", () => {
    for (const m of [
      "Network.getAllCookies",
      "Network.getCookies",
      "Network.setCookie",
      "Network.setCookies",
      "Network.deleteCookies",
      "Network.clearBrowserCookies",
    ]) {
      expect(refused(m).reason).toBe("blocked-method");
    }
  });

  it("refuses commands that would step around a boundary with its own gated verb", () => {
    // Raw navigation would be a second, UNGATED door to the act the domain gate exists to
    // judge; raw setFileInputFiles would be one around the upload directory.
    expect(refused("Page.navigate").reason).toBe("blocked-method");
    expect(refused("Page.navigateToHistoryEntry").reason).toBe("blocked-method");
    expect(refused("DOM.setFileInputFiles").reason).toBe("blocked-method");
    expect(refused("Page.setDownloadBehavior").reason).toBe("blocked-method");
  });

  it("is an ALLOWLIST, so a domain Chrome adds later is refused until someone looks at it", () => {
    expect(refused("SomeFutureDomain.doThing").reason).toBe("browser-global");
  });

  it("refuses anything that is not a single Domain.command", () => {
    for (const m of ["", "Runtime", ".evaluate", "Runtime.", "Runtime.evaluate.extra"]) {
      expect(refused(m).reason).toBe("malformed");
    }
    expect(refused(undefined as unknown as string).reason).toBe("malformed");
  });
});

describe("cdp policy — a refusal explains the class, not the map", () => {
  it("says why, and does not enumerate what else is blocked", () => {
    const global = cdpRefusal(refused("Target.attachToTarget"));
    expect(global).toContain("Target");
    expect(global).toContain("browser");
    // The refusal must not become a way to read the rest of the policy off the error messages.
    expect(global).not.toContain("Network.getAllCookies");
    expect(global).not.toContain("Storage");

    const blocked = cdpRefusal(refused("Page.navigate"));
    expect(blocked).toContain("own capabilities");
    expect(blocked).not.toContain("setFileInputFiles");
  });
});
