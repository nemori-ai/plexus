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
} from "@plexus/protocol";
import type { PlatformServices } from "../platform/index.ts";
import { isBinaryAllowed, cliPolicyFromRoute, sanitizeCliEnv } from "./transport-policy.ts";

interface CliRoute {
  bin: string;
  args?: string[];
  argsFrom?: "input";
  json?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  /** Security policy (read by the cli binary policy, not by core): user-confirmed bins. */
  allowedBins?: string[];
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

    // SECURITY (#2): the cli binary policy. Deny absolute/relative paths, shell
    // interpreters, and shell metacharacters UNCONDITIONALLY; a bare safe bin is
    // permitted only when it passes the structural floor and (if the extension
    // declared one) is on the user-confirmed allow-list. This is enforced at dispatch
    // even if the register path was bypassed — default-deny, no verbatim fallback.
    const policy = cliPolicyFromRoute(route as unknown as Record<string, unknown>);
    const decision = isBinaryAllowed(route.bin, policy);
    if (!decision.allowed) {
      return {
        ok: false,
        error: {
          code: "transport_error",
          message: decision.message ?? "cli: binary not allowed by policy",
          capabilityId: entry.id,
          detail: { policy: "cli-binary", reason: decision.reason },
        },
      };
    }

    // The bin is a policy-allowed BARE name; resolve it via PATH. We never fall back to
    // the verbatim string (an unresolved bin is a source_unavailable, not an exec of an
    // attacker-named path) — resolveBinary returning undefined means "not installed".
    const bin = await this.platform.resolveBinary(route.bin);
    if (!bin) {
      return {
        ok: false,
        error: {
          code: "source_unavailable",
          message: `cli: binary '${route.bin}' not found on PATH`,
          capabilityId: entry.id,
        },
      };
    }

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
      // SECURITY (#2): strip loader/interpreter-hijack vars (PATH, LD_PRELOAD, DYLD_*,
      // NODE_OPTIONS, …) from route.env so an allow-listed bare bin cannot be redirected
      // to an attacker binary or have arbitrary code injected via the environment.
      const safeEnv = sanitizeCliEnv(route.env);
      let proc;
      try {
        proc = this.platform.spawnProcess({
          command: bin,
          args: argv,
          ...(route.cwd ? { cwd: route.cwd } : {}),
          ...(safeEnv ? { env: safeEnv } : {}),
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
