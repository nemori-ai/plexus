/**
 * THE EXTENSION RELAY — the third way into a browser, and the only one whose consent is durable.
 *
 * WHY THIS EXISTS, given two working transports already. Both existing routes reach a browser
 * through a DevTools port, and that port has two properties the owner feels every day:
 *
 *   - Chrome refuses `--remote-debugging-port` on the default profile (since M136), so the port
 *     route cannot reach the browser the owner is actually logged into at all;
 *   - the `chrome://inspect` route can, but Chrome asks permission on EVERY new connection and
 *     offers no "always allow", so the owner clicks a dialog to start each gateway.
 *
 * An extension has neither problem. `chrome.debugger` is granted ONCE at install, works on the
 * default profile, and gives the same CDP 1.3 surface. This is what Codex and Claude both ship;
 * it is the shape, not an invention here.
 *
 * WHAT PLEXUS DOES DIFFERENTLY. Those extensions hold `<all_urls>` and place their safety in the
 * agent's own instructions — "treat pages as untrusted", "confirm before transmitting". That is
 * a policy the agent can be argued out of by the page it is reading. Here the extension is only
 * a transport: the origin gate, per-use approval and the audit stay in the gateway, where a page
 * cannot reach them.
 *
 * THE SOCKET IS OWNER-AUTHENTICATED. The extension presents a pairing token the owner copied
 * from the console. Without it the socket is closed before a single command crosses — an
 * unauthenticated local socket that drives a logged-in browser would be a hole any local process
 * could walk through.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { homePath, readFileBestEffort, atomicWrite } from "../../core/paths.ts";
import type { Browser } from "./browser.ts";
import type { CdpConversation, CdpTarget } from "./cdp.ts";

/** How long a relayed command may take before the caller is told the extension went quiet. */
const RELAY_TIMEOUT_MS = 20_000;

/** What the gateway asks the extension to do. The extension implements exactly these. */
export type RelayOp =
  | { op: "tabs.list" }
  | { op: "tabs.create" }
  | { op: "tabs.close"; tabIds: string[] }
  | { op: "attach"; tabId: string }
  | { op: "detach"; tabId: string }
  | { op: "cdp"; tabId: string; method: string; params: Record<string, unknown> };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The minimal socket shape the relay needs — kept local so this file does not import Bun. */
export interface RelaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * Constant-time token comparison.
 *
 * A plain `===` on a secret leaks its prefix through timing to anything that can measure it, and
 * a local socket is exactly what can.
 */
function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Where the extension dials. One path, loopback-only, on the gateway's existing port. */
export const EXTENSION_SOCKET_PATH = "/browser-extension";

const TOKEN_FILE = "browser-extension-token";

/**
 * The pairing token, minted once and kept beside the gateway's other secrets.
 *
 * Distinct from the connection-key ON PURPOSE. The connection-key is the OWNER's admin
 * authority; this one only lets a browser extension act as a transport. Reusing the admin key
 * here would put it inside an extension that holds `<all_urls>` — one compromised extension and
 * the whole gateway goes with it.
 */
export function loadPairingToken(): string {
  const path = homePath(TOKEN_FILE);
  const existing = readFileBestEffort(path)?.trim();
  if (existing) return existing;
  const minted = `plx_ext_${randomBytes(24).toString("base64url")}`;
  atomicWrite(path, `${minted}\n`);
  return minted;
}

/**
 * The single connected extension, if any.
 *
 * ONE at a time on purpose: two extensions racing to drive the same browser would make "which
 * tab did that" unanswerable, and the audit's whole job is to answer it. A second connection
 * replaces the first, which is also how an extension reload recovers.
 */
export class ExtensionRelay {
  private socket?: RelaySocket;
  private authenticated = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** CDP events, keyed `tabId\0method`, for the callers that await one. */
  private readonly events = new Map<string, { resolve: () => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly token: string) {}

  get connected(): boolean {
    return !!this.socket && this.authenticated;
  }

  /** Adopt a newly opened socket. It is not usable until it authenticates. */
  attachSocket(socket: RelaySocket): void {
    // A new extension replaces the old one; the old one's in-flight calls cannot be answered.
    if (this.socket) this.dropSocket("replaced by a new extension connection");
    this.socket = socket;
    this.authenticated = false;
  }

  /** Handle one frame from the extension. */
  receive(socket: RelaySocket, raw: string): void {
    if (socket !== this.socket) return;
    let msg: {
      type?: string;
      token?: string;
      id?: number;
      ok?: boolean;
      result?: unknown;
      error?: string;
      event?: string;
      tabId?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "hello") {
      // AUTHENTICATE FIRST. Nothing else is honoured until this passes, and a wrong token closes
      // the socket rather than answering — a local process should not get to probe it.
      if (typeof msg.token !== "string" || !tokensMatch(msg.token, this.token)) {
        socket.send(JSON.stringify({ type: "denied" }));
        socket.close(4001, "bad pairing token");
        this.socket = undefined;
        return;
      }
      this.authenticated = true;
      socket.send(JSON.stringify({ type: "ready" }));
      return;
    }

    if (!this.authenticated) return;

    if (msg.type === "event" && msg.event) {
      const key = `${msg.tabId ?? ""}\0${msg.event}`;
      const waiter = this.events.get(key);
      if (waiter) {
        this.events.delete(key);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      return;
    }

    if (typeof msg.id !== "number") return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok === false) entry.reject(new Error(msg.error ?? "the extension refused that command"));
    else entry.resolve(msg.result ?? {});
  }

  /** The socket went away. */
  detachSocket(socket: RelaySocket): void {
    if (socket !== this.socket) return;
    this.dropSocket("the browser extension disconnected");
  }

  private dropSocket(reason: string): void {
    // CLOSE it, do not merely forget it. A displaced bridge whose socket stays open never
    // learns to exit, and Chrome keeps its port alive — which is how one extension ended up
    // with two host processes fighting over the same relay.
    const displaced = this.socket;
    this.socket = undefined;
    if (displaced) {
      try {
        displaced.close(4000, reason);
      } catch {
        /* already gone */
      }
    }
    this.authenticated = false;
    for (const [, waiter] of this.events) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.events.clear();
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /** Issue one op and await the extension's reply. */
  call<T>(op: RelayOp): Promise<T> {
    const socket = this.socket;
    if (!socket || !this.authenticated) {
      return Promise.reject(
        new Error(
          "the Plexus browser extension is not connected. Install it and pair it from " +
            "Plexus → What I expose → Browser control.",
        ),
      );
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the extension did not answer ${op.op} in time`));
      }, RELAY_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ id, ...op }));
    });
  }

  /** Wait for a CDP event on one tab, or give up quietly. */
  awaitEvent(tabId: string, method: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const key = `${tabId}\0${method}`;
      const existing = this.events.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        existing.resolve();
      }
      const timer = setTimeout(() => {
        this.events.delete(key);
        resolve();
      }, timeoutMs);
      this.events.set(key, { resolve, timer });
    });
  }
}

/** A conversation with one tab, carried over the relay. */
class RelaySession implements CdpConversation {
  private detached = false;
  constructor(private readonly relay: ExtensionRelay, private readonly tabId: string) {}

  get isOpen(): boolean {
    return !this.detached && this.relay.connected;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.detached) return Promise.reject(new Error("the CDP socket is not open"));
    return this.relay.call<T>({ op: "cdp", tabId: this.tabId, method, params });
  }

  await(method: string, timeoutMs: number): Promise<void> {
    return this.relay.awaitEvent(this.tabId, method, timeoutMs);
  }

  close(): void {
    if (this.detached) return;
    this.detached = true;
    void this.relay.call({ op: "detach", tabId: this.tabId }).catch(() => {});
  }
}

/** A {@link Browser} whose commands travel through the extension. */
export class ExtensionBrowser implements Browser {
  readonly kind = "extension" as const;
  constructor(private readonly relay: ExtensionRelay) {}

  async listTargets(types: readonly string[]): Promise<CdpTarget[]> {
    // The extension reports tabs, not CDP targets. A tab IS a page target; frames are not
    // separately enumerable here, which is an honest limit of this transport rather than a
    // silently empty list.
    if (!types.includes("page")) return [];
    const res = await this.relay.call<{ tabs?: { id: string; title?: string; url?: string }[] }>({
      op: "tabs.list",
    });
    return (res.tabs ?? []).map((t) => ({
      targetId: String(t.id),
      type: "page",
      title: t.title ?? "",
      url: t.url ?? "",
    }));
  }

  async session(target: CdpTarget): Promise<CdpConversation> {
    await this.relay.call({ op: "attach", tabId: target.targetId });
    return new RelaySession(this.relay, target.targetId);
  }

  async createTarget(): Promise<CdpTarget> {
    const res = await this.relay.call<{ id: string }>({ op: "tabs.create" });
    return { targetId: String(res.id), type: "page", title: "", url: "about:blank" };
  }

  async closeTargets(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.relay.call({ op: "tabs.close", tabIds: [...ids] }).catch(() => {});
  }

  close(): void {
    /* the socket belongs to the extension, not to one connection */
  }
}
