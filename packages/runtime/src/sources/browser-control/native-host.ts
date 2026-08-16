#!/usr/bin/env bun
/**
 * THE NATIVE MESSAGING HOST — why the owner pastes nothing.
 *
 * Chrome launches this process itself, as a child, speaking length-prefixed JSON on stdio. There
 * is no port and no listener, and the host manifest names the ONE extension id allowed to start
 * it: the binding is enforced by Chrome, not by a secret. That is the whole reason Codex's
 * extension needs no pairing token, and the reason ours no longer does either.
 *
 * The alternative this replaces — an extension dialling `ws://127.0.0.1` — needed a token for a
 * real reason: a localhost WebSocket is reachable by every process on the machine AND by any
 * WEBSITE the owner visits, since WebSocket has no CORS preflight. A shared secret the owner
 * copies between two windows was the price of that design. Native messaging removes the exposure
 * instead of guarding it, which is strictly better than guarding it well.
 *
 * A token still authenticates the hop from HERE to the gateway, but this process runs as the
 * owner and reads it off disk itself. The owner never sees it.
 */

import { homePath, readFileBestEffort } from "../../core/paths.ts";
import { EXTENSION_SOCKET_PATH, loadPairingToken } from "./extension-relay.ts";

/** Chrome's framing: a little-endian uint32 length, then that many bytes of UTF-8 JSON. */
const HEADER_BYTES = 4;

/** Where the running gateway announced itself. Written by the runtime on every boot. */
function gatewaySocketUrl(): string {
  const raw = readFileBestEffort(homePath("runtime.json"));
  if (!raw) {
    throw new Error("no gateway is running (no runtime.json under PLEXUS_HOME)");
  }
  const info = JSON.parse(raw) as { port?: number; host?: string };
  if (!info.port) throw new Error("runtime.json names no port");
  // Loopback ALWAYS, whatever the gateway advertises: this bridge exists on the same machine,
  // and a host that would dial elsewhere is a host that could be pointed elsewhere.
  return `ws://127.0.0.1:${info.port}${EXTENSION_SOCKET_PATH}`;
}

/** Read Chrome's framed messages off stdin, one callback per complete message. */
function readFrames(onMessage: (msg: unknown) => void): void {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < HEADER_BYTES) return;
      const length = buffer.readUInt32LE(0);
      if (buffer.length < HEADER_BYTES + length) return;
      const body = buffer.subarray(HEADER_BYTES, HEADER_BYTES + length).toString("utf-8");
      buffer = buffer.subarray(HEADER_BYTES + length);
      try {
        onMessage(JSON.parse(body));
      } catch {
        /* a frame we cannot parse is dropped, not fatal */
      }
    }
  });
  // Chrome closing the pipe is how a host is told to exit; without this it lingers forever.
  process.stdin.on("end", () => process.exit(0));
}

/** Write one framed message to Chrome. */
function writeFrame(msg: unknown): void {
  const body = Buffer.from(JSON.stringify(msg), "utf-8");
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

async function main(): Promise<void> {
  const url = gatewaySocketUrl();
  const token = loadPairingToken();
  const socket = new WebSocket(url);

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "hello", token }));
  });
  // Gateway → extension. Commands only; the big payloads (screenshots) travel the other way,
  // which is the direction Chrome does not cap at 1 MB.
  socket.addEventListener("message", (ev: MessageEvent) => {
    try {
      writeFrame(JSON.parse(String(ev.data)));
    } catch {
      /* ignore a frame we cannot parse */
    }
  });
  // The gateway going away must end this process: a host still holding Chrome's pipe with
  // nowhere to send would swallow every command in silence.
  socket.addEventListener("close", () => process.exit(0));
  socket.addEventListener("error", () => process.exit(0));

  // Extension → gateway.
  readFrames((msg) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  });
}

if (import.meta.main) {
  main().catch((err) => {
    // Report the reason to the extension before leaving, so the badge can say WHY.
    writeFrame({ type: "host-error", error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}

export { readFrames, writeFrame, gatewaySocketUrl };