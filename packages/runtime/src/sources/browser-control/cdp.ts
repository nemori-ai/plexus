/**
 * A minimal Chrome DevTools Protocol client — JSON over one WebSocket.
 *
 * NO DEPENDENCY ON PURPOSE. Puppeteer and Playwright each bring a browser download and a large
 * dependency tree to provide an ergonomics layer we do not need: the whole surface below is a
 * request/response correlator plus five methods. Bun ships `fetch` and `WebSocket` natively, and
 * CDP is `{id, method, params}` in and `{id, result}` back. The cost of the convenience is far
 * larger than the convenience.
 *
 * WHAT THIS IS NOT. It holds no policy. It will drive whatever target it is handed — deciding
 * WHICH targets may be driven is the origin gate's job, and the bridge consults that gate before
 * calling anything here. Keeping the transport policy-free is what makes the gate the single
 * place the boundary lives.
 */

/** One controllable page, as Chrome reports it. */
export interface CdpTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** The endpoint a client talks to — a host:port exposing Chrome's HTTP discovery surface. */
export interface CdpEndpoint {
  host: string;
  port: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** `http://host:port` — the discovery base. Always loopback in practice; never remote. */
function baseUrl(ep: CdpEndpoint): string {
  return `http://${ep.host}:${ep.port}`;
}

/**
 * List the PAGE targets a browser is exposing. Non-page targets (service workers, the browser
 * target itself, extension backgrounds) are filtered out: they are not things an agent drives,
 * and several of them have no origin to gate on.
 */
export async function listTargets(ep: CdpEndpoint, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CdpTarget[]> {
  const res = await fetch(`${baseUrl(ep)}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`CDP discovery failed (HTTP ${res.status})`);
  const raw = (await res.json()) as CdpTarget[];
  return (Array.isArray(raw) ? raw : []).filter((t) => t && t.type === "page");
}

/** True iff something is answering CDP discovery at this endpoint. Never throws. */
export async function endpointAlive(ep: CdpEndpoint, timeoutMs = 2_000): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl(ep)}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * One open CDP conversation with a single page target.
 *
 * Correlates replies by the monotonic `id` CDP requires, and rejects every outstanding call if
 * the socket closes — so a browser that quits mid-call surfaces as a clean error instead of a
 * promise that never settles (the failure mode that turns a hung tab into a hung agent).
 */
export class CdpSession {
  private ws?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  private constructor(private readonly wsUrl: string, private readonly timeoutMs: number) {}

  /** Open a session against a specific page target. */
  static async open(target: CdpTarget, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CdpSession> {
    if (!target.webSocketDebuggerUrl) {
      throw new Error("target exposes no debugger socket (it may already be attached elsewhere)");
    }
    const s = new CdpSession(target.webSocketDebuggerUrl, timeoutMs);
    await s.connect();
    return s;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out opening the CDP socket")), this.timeoutMs);
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.wsUrl);
      } catch (e) {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.ws = ws;
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("could not open the CDP socket"));
      });
      ws.addEventListener("message", (ev: MessageEvent) => this.onMessage(String(ev.data)));
      // A closed socket must fail every in-flight call, not strand it.
      ws.addEventListener("close", () => this.failAll("the browser closed the debugging connection"));
    });
  }

  private onMessage(data: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(data);
    } catch {
      return; // CDP events we do not subscribe to; ignore rather than crash the socket
    }
    if (typeof msg.id !== "number") return; // an event, not a reply
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error.message ?? "CDP call failed"));
    else entry.resolve(msg.result ?? {});
  }

  private failAll(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /** Issue one CDP command and await its reply. */
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("the CDP socket is not open"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* idempotent teardown */
    }
    this.failAll("the debugging connection was closed");
  }
}

/**
 * Evaluate a FIXED, gateway-authored expression in the page and return its value.
 *
 * The expression is ours in every call site — never agent-supplied. Arbitrary evaluation is
 * deliberately not a capability: it would make the origin gate decorative, since a page can
 * `fetch` anywhere its own origin allows.
 */
export async function evaluate<T>(session: CdpSession, expression: string): Promise<T> {
  const res = await session.send<{ result?: { value?: T }; exceptionDetails?: { text?: string } }>(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
  );
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.text ?? "the page threw while being inspected");
  }
  return res.result?.value as T;
}
