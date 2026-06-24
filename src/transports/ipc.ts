/**
 * `ipc` transport — OS IPC. (ADR-003.)
 *
 * SCOPE: v1 implements the UNIX DOMAIN SOCKET line/JSON variant (straightforward
 * with node:net, on the macOS critical path for any app exposing a local socket).
 * Named-pipe (win32) and the osascript/AppleScript bridge are HONESTLY DEFERRED
 * post-v1 — they are not on the v1 acceptance critical path and each needs its own
 * platform-seam plumbing. Requesting them returns a clear `transport_error`.
 *
 * Routing config on `entry.extras.route` (read ONLY by this transport):
 *   route = { mode: "unix-socket", socketPath: string }   // line/JSON request-response
 *   route = { mode: "named-pipe" | "osascript", ... }      // → not implemented (post-v1)
 */

import type {
  Transport,
  CapabilityEntry,
  TransportDispatchContext,
  TransportResult,
} from "@plexus/protocol";
import type { PlatformServices } from "../platform/index.ts";

interface IpcRoute {
  mode: "unix-socket" | "named-pipe" | "osascript";
  socketPath?: string;
}

export class IpcTransport implements Transport {
  readonly kind = "ipc" as const;

  constructor(private readonly platform: PlatformServices) {}

  async dispatch(
    entry: CapabilityEntry,
    input: Record<string, unknown>,
    _ctx?: TransportDispatchContext,
  ): Promise<TransportResult> {
    const route = entry.extras?.route as IpcRoute | undefined;
    if (!route) {
      return { ok: false, error: { code: "transport_error", message: `ipc: entry ${entry.id} has no extras.route` } };
    }

    if (route.mode !== "unix-socket") {
      // HONEST STUB: these variants are deferred post-v1.
      return {
        ok: false,
        error: {
          code: "transport_error",
          message: `ipc: mode "${route.mode}" is not implemented in v1 (unix-socket only; named-pipe/osascript are post-v1)`,
          capabilityId: entry.id,
        },
      };
    }

    if (!route.socketPath) {
      return { ok: false, error: { code: "transport_error", message: `ipc: unix-socket mode needs route.socketPath` } };
    }

    const net = await import("node:net");
    return new Promise<TransportResult>((resolve) => {
      let settled = false;
      let buffer = "";
      const done = (r: TransportResult) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(r);
      };

      const socket = net.createConnection(route.socketPath!);
      socket.setEncoding("utf-8");
      socket.setTimeout(5_000);

      socket.on("connect", () => {
        socket.write(JSON.stringify(input) + "\n");
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const nl = buffer.indexOf("\n");
        if (nl >= 0) {
          const line = buffer.slice(0, nl);
          try {
            done({ ok: true, data: JSON.parse(line) });
          } catch {
            done({ ok: false, error: { code: "transport_error", message: "ipc: malformed JSON response", capabilityId: entry.id } });
          }
        }
      });
      socket.on("timeout", () => done({ ok: false, error: { code: "transport_error", message: "ipc: socket timeout", capabilityId: entry.id } }));
      socket.on("error", (err) => done({ ok: false, error: { code: "transport_error", message: `ipc: ${err.message}`, capabilityId: entry.id } }));
    });
  }
}
