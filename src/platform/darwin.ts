/**
 * macOS implementation of the PlatformServices seam (§6b).
 *
 * CONCRETELY IMPLEMENTED:
 *  - resolveBinary / getEnrichedPath — login-shell PATH capture + fallback dirs
 *    (path-resolver.ts).
 *  - locateLocalService — resolve a known app's localhost service (e.g. Obsidian
 *    Local REST API) by probing its default port(s) for reachability.
 *  - spawnProcess       — NDJSON-framed subprocess (used by stdio + mcp-stdio
 *    transports), spawned with the enriched PATH.
 *  - resolveSecret      — read a named secret from the `~/.plexus/secrets/` store.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";

import type {
  PlatformServices,
  LocalServiceHint,
  LocalServiceLocation,
  SpawnSpec,
  SpawnedProcess,
} from "../protocol/index.ts";
import {
  resolveBinary as resolveBinaryImpl,
  getEnrichedPath as getEnrichedPathImpl,
} from "./path-resolver.ts";

/**
 * Known localhost service profiles. The adapter passes a `LocalServiceHint`
 * naming the app; this table supplies the default port(s), scheme, and the secret
 * name the transport must present. Kept here (behind the platform seam) so the
 * adapter stays OS-neutral.
 */
const KNOWN_SERVICES: Record<
  string,
  { scheme: "http" | "https"; ports: number[]; secretRef?: string }
> = {
  // Obsidian Local REST API plugin: HTTPS on 27124 (self-signed) and HTTP on 27123.
  obsidian: { scheme: "https", ports: [27124, 27123], secretRef: "obsidian-rest-api-key" },
};

/** Probe a TCP host:port for reachability with a bounded timeout. */
async function probeTcp(host: string, port: number, timeoutMs = 600): Promise<boolean> {
  const net = await import("node:net");
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

export class DarwinPlatformServices implements PlatformServices {
  readonly platform = "darwin" as const;

  /** CONCRETE: resolve a binary via which + enriched PATH. */
  async resolveBinary(name: string): Promise<string | undefined> {
    return resolveBinaryImpl(name);
  }

  /** CONCRETE: capture the user's real interactive shell PATH. */
  async getEnrichedPath(): Promise<string> {
    return getEnrichedPathImpl();
  }

  /**
   * CONCRETE: locate a known app's localhost service. Uses the app profile (or the
   * hint's `defaultPort`) and returns the FIRST reachable address. Returns
   * undefined when nothing is reachable (the source's `checkRequirements` reports
   * `source_unavailable`).
   */
  async locateLocalService(hint: LocalServiceHint): Promise<LocalServiceLocation | undefined> {
    const profile = KNOWN_SERVICES[hint.app];
    const scheme = profile?.scheme ?? "http";
    const secretRef = profile?.secretRef;
    const ports = hint.defaultPort
      ? [hint.defaultPort, ...(profile?.ports ?? [])]
      : (profile?.ports ?? []);

    // De-dupe ports preserving order.
    const seen = new Set<number>();
    for (const port of ports) {
      if (seen.has(port)) continue;
      seen.add(port);
      if (await probeTcp("127.0.0.1", port)) {
        return {
          kind: "http",
          address: `${scheme}://127.0.0.1:${port}`,
          ...(secretRef ? { secretRef } : {}),
        };
      }
    }
    return undefined;
  }

  /**
   * CONCRETE: spawn a subprocess with the enriched PATH. The returned handle gives
   * the caller an NDJSON line framer over stdout (one callback per `\n`-terminated
   * line) — used by the generic stdio transport AND the MCP stdio client. stderr is
   * left to flow to the parent for diagnostics.
   */
  spawnProcess(spec: SpawnSpec): SpawnedProcess {
    const enriched = getEnrichedPathImpl();
    const mergedPath = [spec.env?.PATH, enriched, process.env.PATH]
      .filter(Boolean)
      .join(delimiter);

    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env, PATH: mergedPath },
      stdio: ["pipe", "pipe", "inherit"],
    });

    const lineSubs = new Set<(line: string) => void>();
    const exitSubs = new Set<(code: number | null) => void>();
    let buffer = "";

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) {
          for (const cb of lineSubs) cb(line);
        }
      }
    });

    child.on("exit", (code) => {
      // Flush any trailing unterminated line before signaling exit.
      if (buffer.trim().length > 0) {
        for (const cb of lineSubs) cb(buffer.trim());
        buffer = "";
      }
      for (const cb of exitSubs) cb(code);
    });

    return {
      pid: child.pid ?? -1,
      write(data: string) {
        child.stdin?.write(data);
      },
      onLine(cb) {
        lineSubs.add(cb);
      },
      onExit(cb) {
        exitSubs.add(cb);
      },
      kill() {
        child.kill();
      },
    };
  }

  /**
   * CONCRETE: resolve a named secret from the `~/.plexus/secrets/` store. The store
   * is a directory of `<name>` files (raw value) OR a single `secrets.json` map.
   * The value is handed ONLY to the calling transport; it never enters an entry,
   * the manifest, the well-known doc, or audit. Returns undefined when absent.
   *
   * (A macOS Keychain backend is a future enhancement behind this same method.)
   */
  async resolveSecret(name: string): Promise<string | undefined> {
    const base = process.env.PLEXUS_HOME
      ? join(process.env.PLEXUS_HOME, "secrets")
      : join(homedir(), ".plexus", "secrets");

    // 1) per-secret file: ~/.plexus/secrets/<name>
    const file = join(base, name);
    if (existsSync(file)) {
      try {
        return readFileSync(file, "utf-8").trim();
      } catch {
        return undefined;
      }
    }

    // 2) consolidated map: ~/.plexus/secrets/secrets.json  →  { "<name>": "<value>" }
    const mapFile = join(base, "secrets.json");
    if (existsSync(mapFile)) {
      try {
        const parsed = JSON.parse(readFileSync(mapFile, "utf-8")) as Record<string, unknown>;
        const v = parsed[name];
        return typeof v === "string" ? v : undefined;
      } catch {
        return undefined;
      }
    }

    return undefined;
  }
}
