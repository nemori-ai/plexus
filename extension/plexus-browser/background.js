/**
 * Plexus Browser Control — the extension side of the relay.
 *
 * WHAT THIS IS: a transport, and deliberately nothing more. It relays DevTools Protocol commands
 * from the gateway to tabs. It holds no policy — no allowlist, no approval logic, no idea which
 * sites an agent may touch.
 *
 * WHY IT HOLDS NO POLICY. Other agent extensions put their safety in the agent's own
 * instructions ("treat pages as untrusted", "confirm before transmitting"). That is a rule the
 * agent can be argued out of by the very page it is reading. Plexus decides in the gateway,
 * where a page cannot reach: the origin gate, per-use approval and the audit all run there,
 * before a command is ever handed to this file. Putting a second, weaker copy of those rules
 * here would only create somewhere for them to disagree.
 *
 * WHAT IT DOES OWN is the part only the browser can know: which tabs exist, and keeping the
 * agent's own tabs in their own group so the owner's windows are not rearranged under them.
 *
 * HOW IT REACHES THE GATEWAY, and why there is nothing to configure. Chrome starts a native
 * messaging host as a child process and will only start the one whose manifest names THIS
 * extension's id — the binding is enforced by Chrome. An extension that dialled
 * `ws://127.0.0.1` instead would need a shared secret, because a localhost socket is reachable
 * by every process on the machine and by any website the owner visits (WebSocket has no CORS
 * preflight). Native messaging removes that exposure rather than guarding it, and removes the
 * owner's copy-paste step with it.
 */

const HOST_NAME = "com.plexus.browser_control";
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const AGENT_GROUP_TITLE = "Plexus agent";

let socket;
/**
 * Whether the GATEWAY answered, not merely whether Chrome handed us a pipe.
 *
 * `connectNative` returns a port immediately; the bridge behind it may still fail to find a
 * gateway. Reporting the port as "connected" is the same shape of lie as a call that returns
 * success without checking — the popup would say connected while nothing worked.
 */
let ready = false;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer;
let lastError = "";

/** Tabs this extension has a debugger attached to, so detach/cleanup is exact. */
const attached = new Set();
/** Tabs Plexus opened itself — the only ones it will ever close. */
const ownTabs = new Set();

// ── connection ────────────────────────────────────────────────────────────────

function connect() {
  clearTimeout(reconnectTimer);
  // ONE pipe at a time. The service worker is woken by several events, and dialling again while
  // a port is live starts a SECOND bridge process that races the first for the same relay.
  if (socket) return;
  let port;
  try {
    // Chrome launches the host; there is no address to configure and no secret to hold.
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch {
    return scheduleReconnect();
  }
  socket = port;

  port.onMessage.addListener((msg) => {
    if (msg?.type === "ready") {
      reconnectDelay = RECONNECT_MIN_MS;
      ready = true;
      lastError = "";
      setBadge("on");
      return;
    }
    if (msg?.type === "host-error") {
      ready = false;
      // The host could not reach a gateway — usually because none is running. Surface it rather
      // than showing a hopeful green badge over a dead pipe.
      setBadge("bad");
      lastError = String(msg.error ?? "");
      return;
    }
    if (typeof msg?.id === "number") void handle(msg, port);
  });

  port.onDisconnect.addListener(() => {
    // Only the CURRENT port's death is news. A stale port disconnecting must not clear the live
    // one, or the extension tears down a working pipe and dials a replacement for it.
    if (socket !== port) return;
    lastError = chrome.runtime.lastError?.message ?? lastError;
    ready = false;
    setBadge("off");
    socket = undefined;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  // Back off so a gateway that is simply not running does not get dialled every second forever.
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function setBadge(state) {
  const map = { on: ["", "#16a34a"], off: ["·", "#9ca3af"], bad: ["!", "#dc2626"] };
  const [text, color] = map[state] ?? map.off;
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color });
}

/** Answer on the port the request ARRIVED on, never on whatever is current by then. */
function reply(port, id, ok, payload) {
  try {
    port.postMessage(ok ? { id, ok: true, result: payload } : { id, ok: false, error: String(payload) });
  } catch {
    /* the port closed while we worked; the gateway will time this call out */
  }
}

// ── the ops the gateway can ask for ───────────────────────────────────────────

async function handle(msg, port) {
  try {
    reply(port, msg.id, true, await run(msg));
  } catch (err) {
    reply(port, msg.id, false, err?.message ?? err);
  }
}

async function run(msg) {
  switch (msg.op) {
    case "tabs.list": {
      const tabs = await chrome.tabs.query({});
      // Only real web tabs. A `chrome://` page has no origin the gateway could judge, and its
      // settings pages include the one that governs debugging.
      return {
        tabs: tabs
          .filter((t) => typeof t.url === "string" && /^https?:/.test(t.url))
          .map((t) => ({ id: String(t.id), title: t.title ?? "", url: t.url })),
      };
    }
    case "tabs.create": {
      const tab = await chrome.tabs.create({ url: "about:blank", active: false });
      ownTabs.add(tab.id);
      await groupAgentTab(tab.id);
      return { id: String(tab.id) };
    }
    case "tabs.close": {
      // ONLY tabs Plexus opened. Closing a tab the owner opened would be destroying their work
      // to tidy up after ourselves.
      const mine = (msg.tabIds ?? []).map(Number).filter((id) => ownTabs.has(id));
      for (const id of mine) {
        ownTabs.delete(id);
        attached.delete(id);
        try {
          await chrome.tabs.remove(id);
        } catch {
          /* already closed */
        }
      }
      return { closed: mine.length };
    }
    case "attach":
      await attach(Number(msg.tabId));
      return {};
    case "detach":
      await detach(Number(msg.tabId));
      return {};
    case "cdp": {
      const tabId = Number(msg.tabId);
      await attach(tabId); // idempotent; a tab that reloaded may have dropped the session
      return (await chrome.debugger.sendCommand({ tabId }, msg.method, msg.params ?? {})) ?? {};
    }
    default:
      throw new Error(`unsupported op ${msg.op}`);
  }
}

async function attach(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    // "Another debugger is already attached" means DevTools is open on that tab. Say so plainly
    // rather than surfacing Chrome's phrasing, which reads like a Plexus failure.
    const text = String(err?.message ?? err);
    if (!/already attached/i.test(text)) throw err;
    throw new Error("that tab already has DevTools open; close it and try again");
  }
  attached.add(tabId);
}

async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* the tab may already be gone */
  }
}

/**
 * Put an agent's tab in its own group.
 *
 * The point is that the owner keeps their browser: agent work is visibly labelled and stays out
 * of the way instead of appearing among their tabs.
 */
async function groupAgentTab(tabId) {
  try {
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, { title: AGENT_GROUP_TITLE, color: "blue", collapsed: false });
  } catch {
    /* grouping is a courtesy, never a reason to fail the call */
  }
}

// ── events the gateway may be waiting on ──────────────────────────────────────

chrome.debugger.onEvent.addListener((source, method) => {
  if (!socket || source.tabId === undefined) return;
  socket.postMessage({ type: "event", event: method, tabId: String(source.tabId) });
});

// Chrome detaches on navigation-to-another-process, tab close, or the user opening DevTools.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attached.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  ownTabs.delete(tabId);
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// The popup asks for status rather than configuration; there is nothing left to configure.
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type !== "status") return false;
  respond({ connected: ready, error: lastError });
  return true;
});

connect();
