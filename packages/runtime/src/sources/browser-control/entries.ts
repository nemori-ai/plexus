/**
 * browser-control self-describe ENTRIES (first-party source).
 *
 * Separate from the read-only `browser` source on purpose: that one is read-only BY
 * CONSTRUCTION (tabs / bookmarks / history, no mutating provider method), and folding page
 * control into it would quietly make that guarantee false.
 *
 * Every entry resolves to a target URL, and every call is refused unless that URL's ORIGIN is
 * one the owner authorized. `navigate` is gated on its destination; everything else is gated on
 * the target tab's CURRENT url, re-read at call time — a tab that was allowed while it was on an
 * authorized site is not allowed once it has navigated away.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CapabilityEntry } from "@plexus/protocol";

export const BROWSER_CONTROL_SOURCE_ID = "browser-control" as const;

export const BC_TABS_ID = "browser-control.tabs.list" as const;
export const BC_READ_ID = "browser-control.page.read" as const;
export const BC_SCREENSHOT_ID = "browser-control.page.screenshot" as const;
export const BC_NAVIGATE_ID = "browser-control.page.navigate" as const;
export const BC_CLICK_ID = "browser-control.page.click" as const;
export const BC_TYPE_ID = "browser-control.page.type" as const;
export const BC_HOW_TO_USE_ID = "browser-control.how-to-use" as const;

/** Ops the bridge intercepts (carried on extras.route.op). */
export const OP_TABS = "tabs" as const;
export const OP_READ = "read" as const;
export const OP_SCREENSHOT = "screenshot" as const;
export const OP_NAVIGATE = "navigate" as const;
export const OP_CLICK = "click" as const;
export const OP_TYPE = "type" as const;

const VERSION = "0.1.0";

/** The optional tab selector shared by every page op. */
const TARGET_FIELD = {
  targetId: {
    type: "string",
    description:
      "Which tab to act on — a targetId from browser-control.tabs.list. Omit to use the tab " +
      "Plexus opened for you. Only tabs on authorized domains are listed or addressable.",
  },
} as const;

function loadSkill(): string {
  try {
    return readFileSync(fileURLToPath(new URL("./skills/how-to-use-browser-control.md", import.meta.url)), "utf-8");
  } catch {
    return (
      "# How to use browser-control\n" +
      "Call `browser-control.tabs.list` to see the tabs you may drive, then `page.navigate` / " +
      "`page.read` / `page.click` / `page.type` / `page.screenshot`. Only domains the owner " +
      "authorized are reachable; everything else is refused."
    );
  }
}

function tabsEntry(): CapabilityEntry {
  return {
    id: BC_TABS_ID,
    source: BROWSER_CONTROL_SOURCE_ID,
    kind: "capability",
    label: "List controllable tabs",
    describe:
      "List the browser tabs you are allowed to drive, with their targetId, title and URL. The " +
      "list is FILTERED to the domains the owner authorized — tabs on any other site are not " +
      "shown and cannot be addressed, so this is also how you discover what you may touch. An " +
      "empty list means the owner has authorized no sites yet (ask them), not that the browser " +
      "is empty.",
    io: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: {
          tabs: { type: "array", description: "Controllable tabs: { targetId, title, url }." },
          mode: { type: "string", description: "`launch` (a clean Plexus-owned browser) or `attach` (the owner's own Chrome)." },
        },
        required: ["tabs"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: BC_HOW_TO_USE_ID, label: "How to use browser-control" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_TABS } },
  };
}

function readEntry(): CapabilityEntry {
  return {
    id: BC_READ_ID,
    source: BROWSER_CONTROL_SOURCE_ID,
    kind: "capability",
    label: "Read the current page",
    describe:
      "Return the tab's URL, title and visible text. Use this after navigating, and between " +
      "actions, to see what is actually on the page rather than assuming. The text is the " +
      "rendered text, truncated — it is for reading and deciding, not for scraping wholesale. " +
      "Refused unless the tab is on a domain the owner authorized.",
    io: {
      input: { type: "object", properties: { ...TARGET_FIELD } },
      output: {
        type: "object",
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          text: { type: "string", description: "Rendered page text, truncated." },
          truncated: { type: "boolean" },
        },
        required: ["url"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: BC_HOW_TO_USE_ID, label: "How to use browser-control" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_READ } },
  };
}

function screenshotEntry(): CapabilityEntry {
  return {
    id: BC_SCREENSHOT_ID,
    source: BROWSER_CONTROL_SOURCE_ID,
    kind: "capability",
    label: "Screenshot the current page",
    describe:
      "Capture the visible viewport as a base64 PNG. Use it when layout or a visual detail " +
      "matters and the page text is not enough. Refused unless the tab is on an authorized domain.",
    io: {
      input: { type: "object", properties: { ...TARGET_FIELD } },
      output: {
        type: "object",
        properties: {
          url: { type: "string" },
          imageBase64: { type: "string", description: "PNG bytes, base64." },
        },
        required: ["url", "imageBase64"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: BC_HOW_TO_USE_ID, label: "How to use browser-control" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_SCREENSHOT } },
  };
}

function navigateEntry(): CapabilityEntry {
  return {
    id: BC_NAVIGATE_ID,
    source: BROWSER_CONTROL_SOURCE_ID,
    kind: "capability",
    label: "Navigate a tab",
    describe:
      "Point a tab at an absolute http(s) URL and wait for it to load, then report where it " +
      "actually ended up (a redirect can land somewhere else — check the returned url). The " +
      "DESTINATION must be on a domain the owner authorized (its subdomains included), and a " +
      "redirect that leaves those domains is reported rather than followed silently. This is an " +
      "execute capability: unless the owner pre-authorized it for you, each call waits for " +
      "their approval.",
    io: {
      input: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL on an authorized domain." },
          ...TARGET_FIELD,
        },
        required: ["url"],
      },
      output: {
        type: "object",
        properties: {
          url: { type: "string", description: "Where the tab actually ended up." },
          title: { type: "string" },
          targetId: { type: "string" },
        },
        required: ["url"],
      },
    },
    grants: ["execute"],
    transport: "ipc",
    skills: [{ id: BC_HOW_TO_USE_ID, label: "How to use browser-control" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_NAVIGATE } },
  };
}

function clickEntry(): CapabilityEntry {
  return {
    id: BC_CLICK_ID,
    source: BROWSER_CONTROL_SOURCE_ID,
    kind: "capability",
    label: "Click an element",
    describe:
      "Click the first element matching a CSS selector on the current page, then report the URL " +
      "afterwards (a click often navigates). Read the page first so the selector comes from what " +
      "is there rather than a guess. Refused unless the tab is on an authorized domain; if the " +
      "click navigates somewhere unauthorized, that is reported. Execute capability — approval " +
      "applies per call unless the owner pre-authorized it.",
    io: {
      input: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector, e.g. `button[type=submit]`." },
          ...TARGET_FIELD,
        },
        required: ["selector"],
      },
      output: {
        type: "object",
        properties: {
          clicked: { type: "boolean" },
          url: { type: "string", description: "The URL after the click." },
        },
        required: ["clicked", "url"],
      },
    },
    grants: ["execute"],
    transport: "ipc",
    skills: [{ id: BC_HOW_TO_USE_ID, label: "How to use browser-control" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_CLICK } },
  };
}

function typeEntry(): CapabilityEntry {
  return {
    id: BC_TYPE_ID,
    source: BROWSER_CONTROL_SOURCE_ID,
    kind: "capability",
    label: "Type into a field",
    describe:
      "Focus the element matching a CSS selector and set its value, firing the input events a " +
      "real keystroke would. Use it to fill forms. NEVER type a credential, a card number or a " +
      "one-time code: the owner is not watching every call, and this capability is not a place " +
      "to put secrets. Refused unless the tab is on an authorized domain. Execute capability.",
    io: {
      input: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector for an input/textarea." },
          text: { type: "string", description: "The value to set." },
          ...TARGET_FIELD,
        },
        required: ["selector", "text"],
      },
      output: {
        type: "object",
        properties: { typed: { type: "boolean" }, url: { type: "string" } },
        required: ["typed", "url"],
      },
    },
    grants: ["execute"],
    transport: "ipc",
    skills: [{ id: BC_HOW_TO_USE_ID, label: "How to use browser-control" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_TYPE } },
  };
}

function howToUseSkill(): CapabilityEntry {
  return {
    id: BC_HOW_TO_USE_ID,
    source: BROWSER_CONTROL_SOURCE_ID,
    kind: "skill",
    label: "How to use browser-control",
    describe:
      "Usage guidance for driving a browser through Plexus: the two modes, why only some domains " +
      "are reachable, the read-then-act loop, and what never to type into a page. " +
      "Read-as-context; not invoked over a wire.",
    grants: [],
    transport: "skill",
    body: { format: "markdown", markdown: loadSkill() },
    version: VERSION,
    extras: { firstParty: true },
  };
}

/**
 * The browser-control entry set. UNGATED — availability (Chrome present, a debugging endpoint
 * reachable, any origin authorized) surfaces via HEALTH, not by hiding the entries, so an agent
 * is told WHY it cannot drive a browser instead of never learning the capability exists.
 */
export function browserControlEntries(): CapabilityEntry[] {
  return [
    tabsEntry(),
    readEntry(),
    screenshotEntry(),
    navigateEntry(),
    clickEntry(),
    typeEntry(),
    howToUseSkill(),
  ];
}
