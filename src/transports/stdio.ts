/**
 * `stdio` transport — spawn a subprocess and talk a line/JSON protocol (NDJSON)
 * over its stdin/stdout. Generic non-MCP stdio adapters. (ADR-003.)
 *
 * Routing config on `entry.extras.route` (read ONLY by this transport):
 *
 *   route = {
 *     command: string,             // binary name or absolute path
 *     args?: string[],
 *     cwd?: string,
 *     env?: Record<string,string>,
 *     persistent?: boolean,        // (reserved) keep the process alive across calls
 *   }
 *
 * Protocol: one request = the JSON-serialized `input` written as a single NDJSON
 * line; the first JSON line the process emits on stdout is the response. The
 * process is spawned per-call (a persistent variant is a future enhancement).
 */

import type {
  Transport,
  CapabilityEntry,
  TransportDispatchContext,
  TransportResult,
} from "@plexus/protocol";
import type { PlatformServices } from "../platform/index.ts";

interface StdioRoute {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export class StdioTransport implements Transport {
  readonly kind = "stdio" as const;

  constructor(private readonly platform: PlatformServices) {}

  async dispatch(
    entry: CapabilityEntry,
    input: Record<string, unknown>,
    _ctx?: TransportDispatchContext,
  ): Promise<TransportResult> {
    const route = entry.extras?.route as StdioRoute | undefined;
    if (!route || !route.command) {
      return { ok: false, error: { code: "transport_error", message: `stdio: entry ${entry.id} has no extras.route.command` } };
    }

    const command = (await this.platform.resolveBinary(route.command)) ?? route.command;

    return new Promise<TransportResult>((resolve) => {
      let settled = false;
      const done = (r: TransportResult) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      let proc;
      try {
        proc = this.platform.spawnProcess({
          command,
          args: route.args ?? [],
          ...(route.cwd ? { cwd: route.cwd } : {}),
          ...(route.env ? { env: route.env } : {}),
        });
      } catch (err) {
        done({
          ok: false,
          error: {
            code: "transport_error",
            message: err instanceof Error ? err.message : String(err),
            capabilityId: entry.id,
          },
        });
        return;
      }

      proc.onLine((line) => {
        try {
          const data = JSON.parse(line);
          proc.kill();
          done({ ok: true, data });
        } catch {
          // Not the JSON response line (e.g. a log line) — keep waiting.
        }
      });

      proc.onExit((code) => {
        done({
          ok: false,
          error: {
            code: "transport_error",
            message: `stdio: ${route.command} exited (${code}) before emitting a JSON response`,
            capabilityId: entry.id,
            ...(code !== null ? { detail: { exitCode: code } } : {}),
          },
        });
      });

      // Send the request line.
      proc.write(JSON.stringify(input) + "\n");
    });
  }
}
