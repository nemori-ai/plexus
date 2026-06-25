/**
 * ============================================================================
 * Management event stream client (REDESIGN §2.3) — main-process SSE consumer
 * ============================================================================
 *
 * Subscribes to `GET /v1/events` (key-gated) and surfaces parsed `PlexusEvent`s.
 * On drop, reconnects with backoff and emits `reconnect` so the caller can
 * re-snapshot `GET /v1/admin/api/pending` to rebuild the badge (the stream has
 * NO replay — P1 note).
 *
 * Uses the pure `SseParser` + `buildEventsRequest` from helpers.js; the only
 * non-pure part here is the actual `fetch`/stream read.
 */

import { EventEmitter } from "node:events";
import { SseParser, buildEventsRequest } from "./helpers.js";

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export class EventStream extends EventEmitter {
  /** @param {{ port:number, connectionKey:string }} opts */
  constructor(opts) {
    super();
    this.opts = opts;
    this.closed = false;
    this.reconnectAttempts = 0;
    /** @type {AbortController | null} */
    this.controller = null;
  }

  start() {
    this.closed = false;
    this._connect();
  }

  async _connect() {
    if (this.closed) return;
    const req = buildEventsRequest(this.opts);
    const controller = new AbortController();
    this.controller = controller;
    const parser = new SseParser();
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`events stream HTTP ${res.status}`);
      }
      this.reconnectAttempts = 0;
      this.emit("connected");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const ev of parser.push(chunk)) this.emit("event", ev);
      }
      throw new Error("events stream ended");
    } catch (err) {
      if (this.closed || controller.signal.aborted) return;
      this._scheduleReconnect(err);
    }
  }

  _scheduleReconnect(err) {
    this.reconnectAttempts += 1;
    const backoff = Math.min(
      RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1),
      RECONNECT_MAX_MS,
    );
    this.emit("reconnect", { attempt: this.reconnectAttempts, delayMs: backoff, error: err });
    setTimeout(() => this._connect(), backoff);
  }

  stop() {
    this.closed = true;
    try {
      this.controller?.abort();
    } catch {
      /* noop */
    }
  }
}
