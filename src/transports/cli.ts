/**
 * `cli` transport — invoke a CLI binary with argv, capture stdout (optionally
 * `--format json`). Binary located via the platform path-resolver. (ADR-003.)
 *
 * Routing config on `entry.extras.route` (read ONLY by this transport):
 *
 *   route = {
 *     bin: string,                 // binary name (resolved via PATH) or absolute path
 *     args?: string[],             // base argv; {tokens} substituted from input
 *     argsFrom?: "input",          // append `--<key> <value>` for each input key
 *     json?: boolean,              // append "--format json" and JSON.parse stdout
 *     cwd?: string,
 *     env?: Record<string,string>,
 *   }
 *
 * Stdout is captured to exhaustion; on a non-zero exit the transport reports
 * `transport_error`.
 */

import type {
  Transport,
  CapabilityEntry,
  TransportDispatchContext,
  TransportResult,
} from "../protocol/index.ts";
import type { PlatformServices } from "../platform/index.ts";

interface CliRoute {
  bin: string;
  args?: string[];
  argsFrom?: "input";
  json?: boolean;
  cwd?: string;
  env?: Record<string, string>;
}

export class CliTransport implements Transport {
  readonly kind = "cli" as const;

  constructor(private readonly platform: PlatformServices) {}

  async dispatch(
    entry: CapabilityEntry,
    input: Record<string, unknown>,
    _ctx?: TransportDispatchContext,
  ): Promise<TransportResult> {
    const route = entry.extras?.route as CliRoute | undefined;
    if (!route || !route.bin) {
      return { ok: false, error: { code: "transport_error", message: `cli: entry ${entry.id} has no extras.route.bin` } };
    }

    const bin = (await this.platform.resolveBinary(route.bin)) ?? route.bin;

    // Build argv: base args with {token} substitution, then optional input flags.
    const argv: string[] = [];
    for (const a of route.args ?? []) {
      argv.push(
        a.replace(/\{(\w+)\}/g, (_m, key: string) => {
          const v = input[key];
          return v === undefined || v === null ? "" : String(v);
        }),
      );
    }
    if (route.argsFrom === "input") {
      for (const [k, v] of Object.entries(input)) {
        argv.push(`--${k}`, String(v));
      }
    }
    if (route.json) argv.push("--format", "json");

    // Spawn and capture stdout to exhaustion via the NDJSON line framer (we just
    // reassemble the lines — the binary need not emit NDJSON).
    return new Promise<TransportResult>((resolve) => {
      let proc;
      try {
        proc = this.platform.spawnProcess({
          command: bin,
          args: argv,
          ...(route.cwd ? { cwd: route.cwd } : {}),
          ...(route.env ? { env: route.env } : {}),
        });
      } catch (err) {
        resolve({
          ok: false,
          error: {
            code: "transport_error",
            message: err instanceof Error ? err.message : String(err),
            capabilityId: entry.id,
          },
        });
        return;
      }

      const lines: string[] = [];
      proc.onLine((line) => lines.push(line));
      proc.onExit((code) => {
        const stdout = lines.join("\n");
        if (code !== 0 && code !== null) {
          resolve({
            ok: false,
            error: {
              code: "transport_error",
              message: `cli: ${route.bin} exited ${code}`,
              capabilityId: entry.id,
              detail: { exitCode: code },
            },
          });
          return;
        }
        let data: unknown = stdout;
        if (route.json && stdout.trim().length > 0) {
          try {
            data = JSON.parse(stdout);
          } catch {
            data = stdout;
          }
        }
        resolve({ ok: true, data });
      });
    });
  }
}
