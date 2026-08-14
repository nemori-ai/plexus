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
  const raw = (await res.json()) as unknown;
  return (Array.isArray(raw) ? raw : []).map(normalizeTarget).filter((t) => t.type === "page");
}

/**
 * Normalize one discovery record.
 *
 * Chrome's HTTP endpoints (`/json/list`, `/json/new`) name the target id **`id`**, while the CDP
 * *domain* (`Target.*`) names it `targetId`. Reading `targetId` straight off the HTTP JSON
 * silently yields `undefined` — which does not throw, it just makes every id-keyed lookup miss.
 * Normalizing here keeps that discrepancy in one place instead of at each call site.
 */
function normalizeTarget(raw: unknown): CdpTarget {
  const t = (raw ?? {}) as Record<string, unknown>;
  return {
    targetId: String(t.targetId ?? t.id ?? ""),
    type: String(t.type ?? ""),
    title: String(t.title ?? ""),
    url: String(t.url ?? ""),
    ...(typeof t.webSocketDebuggerUrl === "string" ? { webSocketDebuggerUrl: t.webSocketDebuggerUrl } : {}),
  };
}

/**
 * Tabs PLEXUS ITSELF opened, so teardown can close them.
 *
 * Without this a tab is left behind by every session, and they accumulate — visibly, in the
 * user's own window under `attach`, and across runs under `launch` because the profile is
 * persistent. A tab Plexus opened is Plexus's to clean up; a tab the user opened is never
 * touched, which is why only `createTarget` records here.
 */
const ownTabs = new Set<string>();
let lastEndpoint: CdpEndpoint | undefined;

/** Open a new blank tab and return it, normalized. */
export async function createTarget(ep: CdpEndpoint, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CdpTarget> {
  const res = await fetch(`${baseUrl(ep)}/json/new?about:blank`, {
    method: "PUT",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`could not open a new tab (HTTP ${res.status})`);
  const target = normalizeTarget(await res.json());
  if (target.targetId) {
    ownTabs.add(target.targetId);
    lastEndpoint = ep;
  }
  return target;
}

/** Close every tab Plexus opened. Best-effort: a tab the user already closed is not an error. */
export async function closeOwnTabs(): Promise<void> {
  const ep = lastEndpoint;
  const ids = [...ownTabs];
  ownTabs.clear();
  if (!ep) return;
  await Promise.all(
    ids.map(async (id) => {
      try {
        await fetch(`${baseUrl(ep)}/json/close/${id}`, { signal: AbortSignal.timeout(2_000) });
      } catch {
        /* the browser may already be gone; nothing to clean up then */
      }
    }),
  );
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
 * Every open session, so process teardown can close them.
 *
 * A session is HELD ACROSS CALLS (see the bridge), which is what makes attach mode a
 * continuous conversation rather than a redial per invoke — but it also means nothing else
 * would close them if the gateway stopped.
 */
const liveSessions = new Set<CdpSession>();

/** The literal errors that mean "the socket died", as opposed to "the page said no". */
const SOCKET_GONE = new Set([
  "the CDP socket is not open",
  "the browser closed the debugging connection",
  "the debugging connection was closed",
]);

/**
 * Is this error the socket dying rather than the operation failing?
 *
 * The distinction decides whether a call may be RETRIED. A dead socket means nothing ran, so
 * reconnecting and repeating is safe; anything else may have already had its effect, and
 * retrying a click would click twice.
 */
export function isSocketGone(err: unknown): boolean {
  return err instanceof Error && SOCKET_GONE.has(err.message);
}

/** Close every open session (process teardown / tests). */
export function closeAllSessions(): void {
  for (const s of [...liveSessions]) s.close();
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
  private readonly events = new Map<string, { resolve: () => void; timer: ReturnType<typeof setTimeout> }>();

  private constructor(private readonly wsUrl: string, private readonly timeoutMs: number) {}

  /** Open a session against a specific page target. */
  static async open(target: CdpTarget, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CdpSession> {
    if (!target.webSocketDebuggerUrl) {
      throw new Error("target exposes no debugger socket (it may already be attached elsewhere)");
    }
    const s = new CdpSession(target.webSocketDebuggerUrl, timeoutMs);
    await s.connect();
    liveSessions.add(s);
    return s;
  }

  /** Whether this session's socket is still usable — checked before a held session is reused. */
  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
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
    if (typeof msg.id !== "number") {
      // An EVENT. Only awaited ones are kept; the rest are dropped rather than queued, so an
      // idle session does not accumulate every frame notification Chrome emits.
      const method = (msg as { method?: string }).method;
      if (method) {
        const waiter = this.events.get(method);
        if (waiter) {
          this.events.delete(method);
          clearTimeout(waiter.timer);
          waiter.resolve();
        }
      }
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error.message ?? "CDP call failed"));
    else entry.resolve(msg.result ?? {});
  }

  private failAll(reason: string): void {
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

  /**
   * Wait for the next occurrence of a CDP event, or give up quietly.
   *
   * RESOLVES ON TIMEOUT rather than rejecting: callers use this to know a page finished loading,
   * and a page that never fires `load` is a slow page, not a failed call. The listener must be
   * armed BEFORE the command that triggers it, or the event races past it.
   */
  await(method: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const existing = this.events.get(method);
      if (existing) {
        clearTimeout(existing.timer);
        existing.resolve();
      }
      const timer = setTimeout(() => {
        this.events.delete(method);
        resolve();
      }, timeoutMs);
      this.events.set(method, { resolve, timer });
    });
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
    liveSessions.delete(this);
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
