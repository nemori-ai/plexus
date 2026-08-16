/**
 * Plexus Browser Control — the extension side of the relay.
 *
 * WHAT THIS IS: a transport, and deliberately nothing more. It dials the gateway, proves it was
 * paired by the owner, and relays DevTools Protocol commands to tabs. It holds no policy — no
 * allowlist, no approval logic, no idea which sites an agent may touch.
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
 */

const PAIRING_KEY = "plexus.pairing";
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const AGENT_GROUP_TITLE = "Plexus agent";

let socket;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer;

/** Tabs this extension has a debugger attached to, so detach/cleanup is exact. */
const attached = new Set();
/** Tabs Plexus opened itself — the only ones it will ever close. */
const ownTabs = new Set();

// ── connection ────────────────────────────────────────────────────────────────

async function pairing() {
  const stored = await chrome.storage.local.get(PAIRING_KEY);
  return stored[PAIRING_KEY] ?? null;
}

async function connect() {
  clearTimeout(reconnectTimer);
  const cfg = await pairing();
  if (!cfg?.url || !cfg?.token) return; // not paired yet; the popup arms this

  try {
    socket = new WebSocket(cfg.url);
  } catch {
    return scheduleReconnect();
  }

  socket.addEventListener("open", () => {
    // Authenticate FIRST; the gateway answers nothing else until this passes.
    socket.send(JSON.stringify({ type: "hello", token: cfg.token }));
  });

  socket.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "ready") {
      reconnectDelay = RECONNECT_MIN_MS;
      setBadge("on");
      return;
    }
    if (msg.type === "denied") {
      // A rejected token is a configuration error, not a blip: retrying in a loop would just
      // hammer the gateway with a credential that will never work.
      setBadge("bad");
      socket = undefined;
      return;
    }
    if (typeof msg.id === "number") void handle(msg);
  });

  socket.addEventListener("close", () => {
    setBadge("off");
    socket = undefined;
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    try {
      socket?.close();
    } catch {
      /* already gone */
    }
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

function reply(id, ok, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(ok ? { id, ok: true, result: payload } : { id, ok: false, error: String(payload) }));
}

// ── the ops the gateway can ask for ───────────────────────────────────────────

async function handle(msg) {
  try {
    reply(msg.id, true, await run(msg));
  } catch (err) {
    reply(msg.id, false, err?.message ?? err);
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
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (source.tabId === undefined) return;
  socket.send(JSON.stringify({ type: "event", event: method, tabId: String(source.tabId) }));
});

// Chrome detaches on navigation-to-another-process, tab close, or the user opening DevTools.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attached.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  ownTabs.delete(tabId);
});

chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.storage.onChanged.addListener((changes) => {
  if (changes[PAIRING_KEY]) {
    reconnectDelay = RECONNECT_MIN_MS;
    try {
      socket?.close();
    } catch {
      /* fine */
    }
    void connect();
  }
});

void connect();
