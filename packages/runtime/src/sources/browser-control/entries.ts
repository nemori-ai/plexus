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
export const BC_SCROLL_ID = "browser-control.page.scroll" as const;
export const BC_WAIT_ID = "browser-control.page.wait" as const;
export const BC_ELEMENTS_ID = "browser-control.page.elements" as const;
export const BC_HOW_TO_USE_ID = "browser-control.how-to-use" as const;

/** Ops the bridge intercepts (carried on extras.route.op). */
export const OP_TABS = "tabs" as const;
export const OP_READ = "read" as const;
export const OP_SCREENSHOT = "screenshot" as const;
export const OP_NAVIGATE = "navigate" as const;
export const OP_CLICK = "click" as const;
export const OP_TYPE = "type" as const;
export const OP_SCROLL = "scroll" as const;
export const OP_WAIT = "wait" as const;
export const OP_ELEMENTS = "elements" as const;

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
      "Capture the page as a base64 PNG — the visible viewport by default, or the WHOLE page " +
      "with `fullPage`. Use it when layout or a visual detail matters and the page text is not " +
      "enough. Refused unless the tab is on an authorized domain.",
    io: {
      input: {
        type: "object",
        properties: {
          fullPage: { type: "boolean", description: "Capture the entire page, not just the viewport." },
          ...TARGET_FIELD,
        },
      },
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
      "to put secrets. Works on text inputs, textareas, `contenteditable`, and `<select>` (pass the " +
      "option value or its visible label). The field is cleared first, and the value is set the " +
      "way a real keystroke sets it, so app frameworks that track their own state actually see " +
      "it. Reports whether the field really holds what you sent — WITHOUT echoing it back. " +
      "Refused unless the tab is on an authorized domain. Execute capability.",
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

function scrollEntry(): CapabilityEntry {
  return {
    id: BC_SCROLL_ID,
    source: BROWSER_CONTROL_SOURCE_ID,
    kind: "capability",
    label: "Scroll the page",
    describe:
      "Move the viewport: to an element (`selector`), to `top`/`bottom`, or by a number of " +
      "pixels (`by`, negative scrolls up). Read and screenshot only see what is on screen, so " +
      "this is how you reach the rest of a long page — and how you trigger a lazy-loading list " +
      "to load more. Returns the new position and whether the bottom is reached, so a loop " +
      "knows when to stop. Refused unless the tab is on an authorized domain.",
    io: {
      input: {
        type: "object",
        properties: {
          selector: { type: "string", description: "Scroll this element into view." },
          to: { type: "string", description: "`top` or `bottom`." },
          by: { type: "number", description: "Pixels to scroll; negative goes up." },
          ...TARGET_FIELD,
        },
      },
      output: {
        type: "object",
        properties: {
          url: { type: "string" },
          scrollY: { type: "number" },
          pageHeight: { type: "number" },
          atBottom: { type: "boolean" },
        },
        required: ["url", "scrollY", "atBottom"],
      },
    },
    // A viewport move dispatches no action on the site's behalf — it cannot submit, follow or
    // activate anything — so it carries the same weight as reading the page.
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: BC_HOW_TO_USE_ID, label: "How to use browser-control" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_SCROLL } },
  };
}

function waitEntry(): CapabilityEntry {
  return {
    id: BC_WAIT_ID,
    source: BROWSER_CONTROL_SOURCE_ID,
    kind: "capability",
    label: "Wait for the page to be ready",
    describe:
      "Block until the page settles or something you name appears — `selector` for an element, " +
      "`text` for a string anywhere in the rendered text. With neither, waits for loading to " +
      "finish. Use it after navigating or clicking on an app that renders late, instead of " +
      "reading too early and concluding the page is empty. Returns `found:false` on timeout " +
      "rather than erroring, so you can decide whether to keep waiting. Refused unless the tab " +
      "is on an authorized domain.",
    io: {
      input: {
        type: "object",
        properties: {
          selector: { type: "string", description: "Wait for this CSS selector to match." },
          text: { type: "string", description: "Wait for this text to appear on the page." },
          timeoutMs: { type: "number", description: "How long to wait. Default 10000, max 30000." },
          ...TARGET_FIELD,
        },
      },
      output: {
        type: "object",
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          found: { type: "boolean", description: "False when it timed out." },
          waitedMs: { type: "number" },
        },
        required: ["url", "found"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: BC_HOW_TO_USE_ID, label: "How to use browser-control" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_WAIT } },
  };
}

function elementsEntry(): CapabilityEntry {
  return {
    id: BC_ELEMENTS_ID,
    source: BROWSER_CONTROL_SOURCE_ID,
    kind: "capability",
    label: "List the things you can act on",
    describe:
      "Snapshot the page's interactive elements — inputs, selects, checkboxes, buttons, links — " +
      "each with a SELECTOR THAT WORKS, its label, its type, and what it currently holds. " +
      "`page.read` returns rendered text, and a form field has no rendered text, so this is how " +
      "you find fields instead of guessing selector names. Call it before filling anything, and " +
      "again afterwards to confirm the values landed. Password fields report only their length, " +
      "never their content. Refused unless the tab is on an authorized domain.",
    io: {
      input: {
        type: "object",
        properties: {
          within: { type: "string", description: "Only elements inside this selector (e.g. a form)." },
          limit: { type: "number", description: "Cap the number returned. Default 100, max 300." },
          ...TARGET_FIELD,
        },
      },
      output: {
        type: "object",
        properties: {
          url: { type: "string" },
          elements: {
            type: "array",
            description:
              "Each: selector, tag, type, label, name, value (or valueLength for passwords), " +
              "checked, required, disabled, options for a select, and whether it is visible.",
          },
          truncated: { type: "boolean" },
        },
        required: ["url", "elements"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: BC_HOW_TO_USE_ID, label: "How to use browser-control" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_ELEMENTS } },
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
    scrollEntry(),
    waitEntry(),
    elementsEntry(),
    howToUseSkill(),
  ];
}
