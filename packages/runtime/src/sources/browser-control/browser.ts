/**
 * THE TWO SHAPES A DEBUGGABLE CHROME COMES IN.
 *
 * A Chrome started with `--remote-debugging-port` serves the classic HTTP discovery surface:
 * `/json/list` enumerates targets and each one carries its own WebSocket. Every CDP tool starts
 * there.
 *
 * A Chrome the user enabled from `chrome://inspect/#remote-debugging` (M144+) DOES NOT. Verified
 * against Chrome 151: every `/json/*` path answers **404**, and the only thing on the port is a
 * WebSocket upgrade at `/devtools/browser`. That is the whole reason tools "cannot connect to
 * 9222" after enabling the built-in toggle — they ask for discovery that is not there.
 *
 * This matters because it is the ONLY route to the browser the user is actually logged into:
 * since Chrome 136 the binary refuses `--remote-debugging-port` on the default profile outright
 * ("DevTools remote debugging requires a non-default data directory"). So the built-in toggle is
 * not a convenience — it is the mechanism, and a client that only speaks HTTP discovery can
 * never attach to a real, logged-in browser.
 *
 * Both shapes are presented as one {@link Browser}. Above this file nothing knows which it got.
 */

import {
  BrowserSocket,
  CdpSession,
  createTarget as httpCreateTarget,
  listTargets as httpListTargets,
  normalizeTarget,
  probeEndpoint,
  type CdpConversation,
  type CdpEndpoint,
  type CdpTarget,
} from "./cdp.ts";

export interface Browser {
  /** Which shape this connection turned out to be — owner diagnostics only. */
  readonly kind: "http" | "ws";
  /** Targets of the given types, as Chrome currently reports them. */
  listTargets(types: readonly string[]): Promise<CdpTarget[]>;
  /** A conversation with one target. */
  session(target: CdpTarget): Promise<CdpConversation>;
  /** Open a new blank tab. */
  createTarget(): Promise<CdpTarget>;
  /** Close tabs by id. Best-effort; a tab the user already closed is not an error. */
  closeTargets(ids: readonly string[]): Promise<void>;
  /** Release what we hold. NEVER quits the browser — an attached one is the user's. */
  close(): void;
}

/** Connect to whichever shape is on this port. Throws if nothing usable is there. */
export async function connectBrowser(ep: CdpEndpoint): Promise<Browser> {
  const shape = await probeEndpoint(ep);
  if (shape === "http") return new HttpBrowser(ep);
  if (shape === "ws") return new WsBrowser(await BrowserSocket.open(ep));
  throw new Error(`nothing is answering the DevTools protocol on port ${ep.port}`);
}

/** The classic shape: HTTP discovery, one WebSocket per target. */
class HttpBrowser implements Browser {
  readonly kind = "http" as const;
  constructor(private readonly ep: CdpEndpoint) {}

  listTargets(types: readonly string[]): Promise<CdpTarget[]> {
    return httpListTargets(this.ep, types);
  }
  session(target: CdpTarget): Promise<CdpConversation> {
    return CdpSession.open(target);
  }
  createTarget(): Promise<CdpTarget> {
    return httpCreateTarget(this.ep);
  }
  async closeTargets(ids: readonly string[]): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        try {
          await fetch(`http://${this.ep.host}:${this.ep.port}/json/close/${id}`, {
            signal: AbortSignal.timeout(2_000),
          });
        } catch {
          /* the browser may already be gone */
        }
      }),
    );
  }
  close(): void {
    /* nothing held: each session owns its own socket */
  }
}

/**
 * The built-in-toggle shape: ONE browser socket, a `sessionId` per target ("flat" mode).
 *
 * Discovery becomes `Target.getTargets` and attaching becomes `Target.attachToTarget`. Those are
 * browser-global commands — which is exactly why they are refused to AGENTS by the CDP policy
 * and used here by the gateway: reaching every tab is how the boundary gets enforced, not
 * something the boundary lets through.
 */
class WsBrowser implements Browser {
  readonly kind = "ws" as const;
  constructor(private readonly socket: BrowserSocket) {}

  async listTargets(types: readonly string[]): Promise<CdpTarget[]> {
    const res = await this.socket.send<{ targetInfos?: unknown[] }>("Target.getTargets");
    return (res.targetInfos ?? []).map(normalizeTarget).filter((t) => types.includes(t.type));
  }

  session(target: CdpTarget): Promise<CdpConversation> {
    return this.socket.attach(target.targetId);
  }

  async createTarget(): Promise<CdpTarget> {
    const res = await this.socket.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    // `Target.createTarget` answers with an id only; the rest of the record arrives on the next
    // listing. A blank tab has nothing else worth reporting anyway.
    return { targetId: res.targetId, type: "page", title: "", url: "about:blank" };
  }

  async closeTargets(ids: readonly string[]): Promise<void> {
    for (const targetId of ids) {
      try {
        await this.socket.send("Target.closeTarget", { targetId });
      } catch {
        /* already closed */
      }
    }
  }

  close(): void {
    this.socket.close();
  }
}
