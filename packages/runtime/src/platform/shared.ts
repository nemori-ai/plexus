/**
 * OS-neutral building blocks shared across the platform-seam implementations
 * (darwin / linux / win32). Extracted so the Linux + Windows impls inherit the
 * genuinely cross-platform pieces verbatim instead of re-deriving them, and so the
 * platform-specific *logic* (PATH enrichment, PATHEXT resolution, `.cmd` spawn
 * argument construction) can be expressed as PURE functions with injected
 * env / fs / runner — making them deterministically testable on any OS (incl. the
 * macOS dev box, where Linux/Windows code paths can never actually execute).
 *
 * Nothing here changes darwin.ts or the PlatformServices interface.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SpawnSpec, SpawnedProcess } from "@plexus/protocol";

// ----------------------------------------------------------------------------
// KNOWN_SERVICES — OS-neutral local-service profile table (mirrors darwin.ts).
// ----------------------------------------------------------------------------

export const KNOWN_SERVICES: Record<
  string,
  { scheme: "http" | "https"; ports: number[]; secretRef?: string }
> = {
  // Obsidian Local REST API plugin: HTTPS on 27124 (self-signed) and HTTP on 27123.
  obsidian: { scheme: "https", ports: [27124, 27123], secretRef: "obsidian-rest-api-key" },
};

// ----------------------------------------------------------------------------
// TCP probe — OS-neutral (node:net), inherited by every platform.
// ----------------------------------------------------------------------------

/** Probe a TCP host:port for reachability with a bounded timeout. */
export async function probeTcp(host: string, port: number, timeoutMs = 600): Promise<boolean> {
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

// ----------------------------------------------------------------------------
// locateLocalService — OS-neutral resolution over KNOWN_SERVICES + a probe.
// ----------------------------------------------------------------------------

import type { LocalServiceHint, LocalServiceLocation } from "@plexus/protocol";

/**
 * OS-neutral local-service location: walk the candidate ports (hint default first,
 * then the profile's) and return the FIRST reachable address. The probe is injected
 * so this is unit-testable without opening real sockets. darwin/linux/win32 all
 * share this; named-pipe (Win) / UDS (Linux) remain additive future work.
 */
export async function locateLocalServiceWith(
  hint: LocalServiceHint,
  probe: (host: string, port: number) => Promise<boolean> = probeTcp,
): Promise<LocalServiceLocation | undefined> {
  const profile = KNOWN_SERVICES[hint.app];
  const scheme = profile?.scheme ?? "http";
  const secretRef = profile?.secretRef;
  const ports = hint.defaultPort
    ? [hint.defaultPort, ...(profile?.ports ?? [])]
    : (profile?.ports ?? []);

  const seen = new Set<number>();
  for (const port of ports) {
    if (seen.has(port)) continue;
    seen.add(port);
    if (await probe("127.0.0.1", port)) {
      return {
        kind: "http",
        address: `${scheme}://127.0.0.1:${port}`,
        ...(secretRef ? { secretRef } : {}),
      };
    }
  }
  return undefined;
}

// ----------------------------------------------------------------------------
// NDJSON line-framing spawn — OS-neutral wrapper over node:child_process.spawn.
// ----------------------------------------------------------------------------

/**
 * Wrap a Node child-process spawn with an NDJSON line framer (one callback per
 * `\n`-terminated line; trailing `\r` stripped so it works for CRLF output too).
 * This is the exact framing darwin.ts uses; pulling it here lets linux/win32 reuse
 * it verbatim. The caller supplies the already-resolved spawn options (so the
 * Windows `.cmd`/shell nuance lives in the win32 impl, not here).
 */
export function spawnWithLineFraming(
  command: string,
  args: string[],
  options: Parameters<typeof nodeSpawn>[2],
): SpawnedProcess {
  const child = nodeSpawn(command, args, options);

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

// ----------------------------------------------------------------------------
// Secret store — `~/.plexus/secrets/` file store (cross-platform). Pure-logic
// core takes an injected fs reader so it is testable without touching real disk.
// ----------------------------------------------------------------------------

/** Minimal fs surface the secret resolver needs (injectable for tests). */
export interface SecretFs {
  exists(path: string): boolean;
  read(path: string): string;
}

const realSecretFs: SecretFs = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, "utf-8"),
};

/** Resolve the base directory of the secret store (`PLEXUS_HOME` override aware). */
export function secretsBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLEXUS_HOME
    ? join(env.PLEXUS_HOME, "secrets")
    : join(homedir(), ".plexus", "secrets");
}

/**
 * PURE: resolve a named secret given an explicit base dir + fs reader. The store is
 * a directory of `<name>` files (raw value) OR a single `secrets.json` map. Returns
 * undefined when absent or unreadable. This is the OS-neutral heart of
 * `resolveSecret` for every platform — darwin keeps its own copy untouched.
 */
export function resolveSecretFrom(
  name: string,
  baseDir: string,
  fs: SecretFs = realSecretFs,
): string | undefined {
  // 1) per-secret file: <base>/<name>
  const file = join(baseDir, name);
  if (fs.exists(file)) {
    try {
      return fs.read(file).trim();
    } catch {
      return undefined;
    }
  }

  // 2) consolidated map: <base>/secrets.json  →  { "<name>": "<value>" }
  const mapFile = join(baseDir, "secrets.json");
  if (fs.exists(mapFile)) {
    try {
      const parsed = JSON.parse(fs.read(mapFile)) as Record<string, unknown>;
      const v = parsed[name];
      return typeof v === "string" ? v : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export type { SpawnSpec, SpawnedProcess, LocalServiceHint, LocalServiceLocation };
