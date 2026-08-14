/**
 * browser-control END TO END against a REAL Chrome (launch mode).
 *
 * Drives the actual bridge — the same code path an agent's invoke takes — so this proves the
 * origin gate holds where it matters (in front of a live browser), not just as a pure function.
 *
 * Skipped when Chrome is absent or in bare CI: it spawns a real browser and reaches the network.
 * The gate's own logic is covered hermetically in `browser-control-origin-gate.test.ts`.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditEvent, AuditEventInput, BridgeDeps, InvokeContext } from "@plexus/protocol";
import { BrowserControlBridge } from "@plexus/runtime/sources/browser-control/bridge.ts";
import {
  browserControlEntries,
  BC_TABS_ID,
  BC_READ_ID,
  BC_NAVIGATE_ID,
  BC_SCREENSHOT_ID,
  BC_CLICK_ID,
  BC_SCROLL_ID,
  BC_WAIT_ID,
} from "@plexus/runtime/sources/browser-control/entries.ts";
import { shutdownBrowserControl, type BrowserControlConfig } from "@plexus/runtime/sources/browser-control/endpoint.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUNNABLE = process.platform === "darwin" && existsSync(CHROME) && !process.env.CI;

const CTX: InvokeContext = { jti: "tok_t", sessionId: "sess_t", agentId: "agent-t", scopes: [] };
const profile = mkdtempSync(join(tmpdir(), "plexus-bc-e2e-"));

function deps(): { deps: BridgeDeps; events: AuditEventInput[] } {
  const entries = browserControlEntries();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const events: AuditEventInput[] = [];
  return {
    events,
    deps: {
      audit: async (e) => {
        events.push(e);
        return { ...e, id: `a-${events.length}`, at: new Date().toISOString() } as unknown as AuditEvent;
      },
      getTransport: () => {
        throw new Error("browser-control is served in-process");
      },
      getEntry: (id) => byId.get(id),
      invokeById: async () => {
        throw new Error("browser-control does not re-enter the pipeline");
      },
    },
  };
}

function cfg(allowlist: string[]): BrowserControlConfig {
  return { mode: "launch", allowlist, attachPort: 9222, profileDir: profile, binary: CHROME };
}

afterAll(async () => {
  // Close the tabs these bridges opened as well as the browser — otherwise the persistent
  // launch profile carries them into the next run.
  await shutdownBrowserControl();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe.skipIf(!RUNNABLE)("browser-control e2e — the gate holds in front of a live browser", () => {
  it("navigates an authorized origin, reads it, screenshots it — and audits the mode", async () => {
    const { deps: d, events } = deps();
    const bridge = new BrowserControlBridge(d, "s1", browserControlEntries(), cfg(["example.com"]));

    const nav = await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://example.com/" } }, CTX);
    expect(nav.ok).toBe(true);
    const navOut = nav.output as Record<string, unknown>;
    expect(String(navOut.url)).toStartWith("https://example.com");
    expect(navOut.leftAuthorizedOrigin).toBeUndefined();

    const read = await bridge.invoke({ id: BC_READ_ID, input: {} }, CTX);
    expect(read.ok).toBe(true);
    const readOut = read.output as Record<string, unknown>;
    expect(String(readOut.title)).toContain("Example");
    expect(String(readOut.text)).toContain("Example Domain");

    const shot = await bridge.invoke({ id: BC_SCREENSHOT_ID, input: {} }, CTX);
    expect(shot.ok).toBe(true);
    expect(String((shot.output as Record<string, unknown>).imageBase64).length).toBeGreaterThan(1000);

    // The OWNER's audit records which mode drove the browser; the agent's result does not
    // carry the profile path, the binary or the port.
    const navEvent = events.find((e) => e.capabilityId === BC_NAVIGATE_ID)!;
    expect((navEvent.detail as Record<string, unknown>).mode).toBe("launch");
    const wire = JSON.stringify(nav.output);
    expect(wire).not.toContain(profile);
    expect(wire).not.toContain(CHROME);
  }, 60_000);

  it("REFUSES an unauthorized origin before any navigation happens", async () => {
    const { deps: d } = deps();
    const bridge = new BrowserControlBridge(d, "s2", browserControlEntries(), cfg(["example.com"]));
    const res = await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://example.org/" } }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("example.org");
    // The refusal must not disclose what IS authorized.
    expect(res.error?.message).not.toContain("example.com");
  }, 60_000);

  it("REFUSES everything when the owner has authorized nothing", async () => {
    const { deps: d } = deps();
    const bridge = new BrowserControlBridge(d, "s3", browserControlEntries(), cfg([]));
    const res = await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://example.com/" } }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("no authorized sites");
  }, 60_000);

  it("lists only tabs on authorized origins, so an unlisted tab is undiscoverable", async () => {
    const { deps: d } = deps();
    // Open a page on example.com under an allowlist that permits it…
    const open = new BrowserControlBridge(d, "s4", browserControlEntries(), cfg(["example.com"]));
    await open.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://example.com/" } }, CTX);
    const listedWhenAllowed = await open.invoke({ id: BC_TABS_ID, input: {} }, CTX);
    const allowedTabs = (listedWhenAllowed.output as { tabs: unknown[] }).tabs;
    expect(allowedTabs.length).toBeGreaterThan(0);

    // …then list with a DIFFERENT allowlist: the same tab is now invisible.
    const other = new BrowserControlBridge(d, "s5", browserControlEntries(), cfg(["some-other-site.test"]));
    const listedWhenNot = await other.invoke({ id: BC_TABS_ID, input: {} }, CTX);
    expect((listedWhenNot.output as { tabs: unknown[] }).tabs).toEqual([]);
  }, 60_000);

  it("refuses a targetId the agent is not authorized for, with no hint that it exists", async () => {
    const { deps: d } = deps();
    const allowed = new BrowserControlBridge(d, "s6", browserControlEntries(), cfg(["example.com"]));
    await allowed.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://example.com/" } }, CTX);
    const tabs = (await allowed.invoke({ id: BC_TABS_ID, input: {} }, CTX)).output as {
      tabs: { targetId: string }[];
    };
    const realId = tabs.tabs[0]!.targetId;

    // A bridge with a different allowlist knows that id is real, but must refuse it the SAME
    // way it refuses a made-up one — otherwise the error is an existence oracle for tabs.
    const stranger = new BrowserControlBridge(d, "s7", browserControlEntries(), cfg(["some-other-site.test"]));
    const real = await stranger.invoke({ id: BC_READ_ID, input: { targetId: realId } }, CTX);
    const fake = await stranger.invoke({ id: BC_READ_ID, input: { targetId: "not-a-real-target" } }, CTX);
    expect(real.ok).toBe(false);
    expect(fake.ok).toBe(false);
    expect(real.error?.message).toBe(fake.error?.message);
  }, 60_000);

  it("holds one debugging socket across a run of calls instead of redialling", async () => {
    const { deps: d, events } = deps();
    const bridge = new BrowserControlBridge(d, "s9", browserControlEntries(), cfg(["example.com"]));
    // The first call has to open a socket; every later call on that tab must reuse it. In
    // attach mode this is the difference between one debugging session and one per invoke.
    await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://example.com/" } }, CTX);
    await bridge.invoke({ id: BC_READ_ID, input: {} }, CTX);
    await bridge.invoke({ id: BC_READ_ID, input: {} }, CTX);
    const reuse = events
      .filter((e) => e.capabilityId === BC_NAVIGATE_ID || e.capabilityId === BC_READ_ID)
      .map((e) => (e.detail as Record<string, unknown>).reusedSocket);
    expect(reuse).toEqual([false, true, true]);
  }, 60_000);

  it("covers subdomains of an authorized domain, so an apex redirect stays in bounds", async () => {
    const { deps: d } = deps();
    // `github.com` authorizes `gist.github.com` — one domain, as the owner meant it.
    const bridge = new BrowserControlBridge(d, "s10", browserControlEntries(), cfg(["github.com"]));
    const res = await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://gist.github.com/" } }, CTX);
    expect(res.ok).toBe(true);
    const out = res.output as Record<string, unknown>;
    expect(String(out.url)).toContain("github.com");
    expect(out.leftAuthorizedOrigin).toBeUndefined();
  }, 60_000);

  it("scrolls a long page and reports whether the bottom is reached", async () => {
    const { deps: d } = deps();
    const bridge = new BrowserControlBridge(d, "s11", browserControlEntries(), cfg(["deepseek.com"]));
    await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://deepseek.com/harness/en/" } }, CTX);
    const top = (await bridge.invoke({ id: BC_SCROLL_ID, input: { to: "top" } }, CTX)).output as Record<string, unknown>;
    expect(top.scrollY).toBe(0);
    expect(top.atBottom).toBe(false);
    const bottom = (await bridge.invoke({ id: BC_SCROLL_ID, input: { to: "bottom" } }, CTX)).output as Record<string, unknown>;
    expect(Number(bottom.scrollY)).toBeGreaterThan(0);
    expect(bottom.atBottom).toBe(true);
  }, 60_000);

  it("waits for content, and reports a timeout as an answer rather than an error", async () => {
    const { deps: d } = deps();
    const bridge = new BrowserControlBridge(d, "s12", browserControlEntries(), cfg(["example.com"]));
    await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://example.com/" } }, CTX);
    const hit = await bridge.invoke({ id: BC_WAIT_ID, input: { text: "Example Domain" } }, CTX);
    expect(hit.ok).toBe(true);
    expect((hit.output as Record<string, unknown>).found).toBe(true);

    const miss = await bridge.invoke({ id: BC_WAIT_ID, input: { selector: "#never-appears", timeoutMs: 1200 } }, CTX);
    // A timeout is a fact about the page, not a broken call.
    expect(miss.ok).toBe(true);
    expect((miss.output as Record<string, unknown>).found).toBe(false);
  }, 60_000);

  it("captures the whole page, not just what fits on screen", async () => {
    const { deps: d } = deps();
    const bridge = new BrowserControlBridge(d, "s13", browserControlEntries(), cfg(["deepseek.com"]));
    await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://deepseek.com/harness/en/" } }, CTX);
    const viewport = await bridge.invoke({ id: BC_SCREENSHOT_ID, input: {} }, CTX);
    const full = await bridge.invoke({ id: BC_SCREENSHOT_ID, input: { fullPage: true } }, CTX);
    const vBytes = String((viewport.output as Record<string, unknown>).imageBase64).length;
    const fBytes = String((full.output as Record<string, unknown>).imageBase64).length;
    expect(fBytes).toBeGreaterThan(vBytes);
  }, 90_000);

  it("a click that navigates reports where it landed", async () => {
    const { deps: d } = deps();
    // example.com's only link goes to iana.org — authorize only example.com, so the landing
    // origin is outside the allowlist and must be REPORTED rather than silently accepted.
    const bridge = new BrowserControlBridge(d, "s8", browserControlEntries(), cfg(["example.com"]));
    await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://example.com/" } }, CTX);
    const res = await bridge.invoke({ id: BC_CLICK_ID, input: { selector: "a" } }, CTX);
    expect(res.ok).toBe(true);
    const out = res.output as Record<string, unknown>;
    expect(out.clicked).toBe(true);
    if (!String(out.url).startsWith("https://example.com")) {
      expect(out.leftAuthorizedOrigin).toBe(true);
    }
  }, 60_000);
});
