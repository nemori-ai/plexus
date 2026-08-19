/**
 * THE EXTENSION RELAY — the wire between a paired browser extension and the gateway.
 *
 * The extension is a TRANSPORT and nothing else: the origin gate, approvals and the audit all
 * run in the gateway, where a page cannot reach them. What must hold here is narrower and
 * sharper — that an unpaired socket cannot drive the owner's browser, and that a relayed
 * command is correlated to the right caller.
 *
 * Hermetic: a fake socket, no browser.
 */
import { describe, it, expect } from "bun:test";
import {
  ExtensionBrowser,
  ExtensionRelay,
  type RelaySocket,
} from "@plexus/runtime/sources/browser-control/extension-relay.ts";

const TOKEN = "plx_ext_test-token-0123456789";

/** A socket that records what the gateway sent and lets the test answer. */
function fakeSocket(): RelaySocket & { sent: Record<string, unknown>[]; closed?: { code?: number } } {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
    close(code?: number) {
      (this as { closed?: { code?: number } }).closed = { code };
    },
  };
}

/** Pair a relay with a socket and return both, ready to use. */
function paired(): { relay: ExtensionRelay; socket: ReturnType<typeof fakeSocket> } {
  const relay = new ExtensionRelay(TOKEN);
  const socket = fakeSocket();
  relay.attachSocket(socket);
  relay.receive(socket, JSON.stringify({ type: "hello", token: TOKEN }));
  return { relay, socket };
}

describe("extension relay — an unpaired socket drives nothing", () => {
  it("refuses a wrong token, closes the socket, and stays disconnected", () => {
    const relay = new ExtensionRelay(TOKEN);
    const socket = fakeSocket();
    relay.attachSocket(socket);
    relay.receive(socket, JSON.stringify({ type: "hello", token: "plx_ext_wrong-token-000000000" }));

    expect(relay.connected).toBe(false);
    expect(socket.sent.at(-1)).toEqual({ type: "denied" });
    // Closing rather than answering: a local process must not get to sit there probing.
    expect(socket.closed?.code).toBe(4001);
  });

  it("ignores commands from a socket that never said hello", () => {
    const relay = new ExtensionRelay(TOKEN);
    const socket = fakeSocket();
    relay.attachSocket(socket);
    // A reply for a call that was never issued must not be honoured, authenticated or not.
    relay.receive(socket, JSON.stringify({ id: 1, ok: true, result: { tabs: [] } }));
    expect(relay.connected).toBe(false);
  });

  it("refuses to relay anything before an extension has paired", async () => {
    const relay = new ExtensionRelay(TOKEN);
    await expect(relay.call({ op: "tabs.list" })).rejects.toThrow(/not connected/i);
  });

  it("accepts the right token and answers ready", () => {
    const { relay, socket } = paired();
    expect(relay.connected).toBe(true);
    expect(socket.sent.at(-1)).toEqual({ type: "ready" });
  });
});

describe("extension relay — commands are correlated to their caller", () => {
  it("routes each reply to the call that made it, in any order", async () => {
    const { relay, socket } = paired();
    const first = relay.call<{ tabs: unknown[] }>({ op: "tabs.list" });
    const second = relay.call<{ id: string }>({ op: "tabs.create" });

    const ids = socket.sent.filter((m) => typeof m.id === "number").map((m) => m.id as number);
    expect(ids.length).toBe(2);

    // Answer them BACKWARDS: a relay that assumed order would hand each caller the other's data.
    relay.receive(socket, JSON.stringify({ id: ids[1], ok: true, result: { id: "42" } }));
    relay.receive(socket, JSON.stringify({ id: ids[0], ok: true, result: { tabs: [{ id: "1" }] } }));

    expect((await second).id).toBe("42");
    expect((await first).tabs.length).toBe(1);
  });

  it("surfaces an extension-side failure as an error, not a silent empty result", async () => {
    const { relay, socket } = paired();
    const call = relay.call({ op: "attach", tabId: "7" });
    const id = socket.sent.at(-1)!.id as number;
    relay.receive(socket, JSON.stringify({ id, ok: false, error: "that tab already has DevTools open" }));
    await expect(call).rejects.toThrow(/DevTools open/);
  });

  it("fails every in-flight call when the extension disconnects", async () => {
    const { relay, socket } = paired();
    const call = relay.call({ op: "tabs.list" });
    relay.detachSocket(socket);
    // A dropped socket must surface, not strand the agent on a promise that never settles.
    await expect(call).rejects.toThrow(/disconnected/i);
    expect(relay.connected).toBe(false);
  });

  it("a reconnecting extension replaces the old socket and fails its outstanding calls", async () => {
    const { relay, socket } = paired();
    const call = relay.call({ op: "tabs.list" });
    const replacement = fakeSocket();
    relay.attachSocket(replacement);
    await expect(call).rejects.toThrow(/replaced/i);
    // The replacement must authenticate on its own before it can drive anything.
    expect(relay.connected).toBe(false);
  });
});

describe("extension relay — the Browser it presents", () => {
  it("maps tabs to page targets and only asks for pages", async () => {
    const { relay, socket } = paired();
    const browser = new ExtensionBrowser(relay);

    const listing = browser.listTargets(["page"]);
    const id = socket.sent.at(-1)!.id as number;
    relay.receive(
      socket,
      JSON.stringify({
        id,
        ok: true,
        result: { tabs: [{ id: "12", title: "GitHub", url: "https://github.com/" }] },
      }),
    );
    expect(await listing).toEqual([
      { targetId: "12", type: "page", title: "GitHub", url: "https://github.com/" },
    ]);

    // An extension enumerates TABS; it has no separate frame targets to offer. Answering an
    // empty list without asking is the honest response, not a relayed round trip.
    const before = socket.sent.length;
    expect(await browser.listTargets(["iframe"])).toEqual([]);
    expect(socket.sent.length).toBe(before);
  });

  it("relays a CDP command for one tab and returns Chrome's reply", async () => {
    const { relay, socket } = paired();
    const browser = new ExtensionBrowser(relay);

    const opening = browser.session({ targetId: "12", type: "page", title: "", url: "https://github.com/" });
    relay.receive(socket, JSON.stringify({ id: socket.sent.at(-1)!.id, ok: true, result: {} }));
    const session = await opening;

    const call = session.send<{ result: { value: string } }>("Runtime.evaluate", { expression: "1" });
    const sent = socket.sent.at(-1)!;
    expect(sent.op).toBe("cdp");
    expect(sent.tabId).toBe("12");
    expect(sent.method).toBe("Runtime.evaluate");
    relay.receive(socket, JSON.stringify({ id: sent.id, ok: true, result: { result: { value: "ok" } } }));
    expect((await call).result.value).toBe("ok");
  });

  it("delivers an awaited CDP event to the tab that is waiting for it", async () => {
    const { relay } = paired();
    const socket = (relay as unknown as { socket: ReturnType<typeof fakeSocket> }).socket;
    const waited = relay.awaitEvent("12", "Page.loadEventFired", 5_000);
    // An event for ANOTHER tab must not satisfy this wait.
    relay.receive(socket, JSON.stringify({ type: "event", event: "Page.loadEventFired", tabId: "99" }));
    let settled = false;
    void waited.then(() => (settled = true));
    await Bun.sleep(20);
    expect(settled).toBe(false);

    relay.receive(socket, JSON.stringify({ type: "event", event: "Page.loadEventFired", tabId: "12" }));
    await waited;
  });
});
