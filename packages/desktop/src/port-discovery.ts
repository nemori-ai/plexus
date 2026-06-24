/**
 * ============================================================================
 * Port discovery — learn the runtime's bound loopback port (REDESIGN §3.4)
 * ============================================================================
 *
 * The runtime may bind 7077 or, if that's taken, an ephemeral port. The
 * supervisor learns the actual port via "parse-then-confirm" (§3.3):
 *
 *   1. PARSE the machine-readable ready line the runtime prints on stdout:
 *        PLEXUS_READY {"port":54321,"pid":1234,"lraVersion":"1.0"}
 *   2. FALLBACK: read `~/.plexus/runtime.json` ({port, pid, lraVersion}).
 *   3. CONFIRM by polling `GET /v1/health` (done by the supervisor, not here).
 *
 * This module is the pure parser half — no fs, no sockets, no Electron — so it
 * is trivially unit-testable. The supervisor wires it to a real child + fs.
 */

/** The descriptor the runtime announces (mirrors runtime/runtime-file.ts RuntimeInfo). */
export interface RuntimeDescriptor {
  readonly port: number;
  readonly pid: number;
  readonly lraVersion: string;
}

/** The stdout sentinel the runtime prints (must match runtime READY_LINE_PREFIX). */
export const READY_LINE_PREFIX = "PLEXUS_READY" as const;

/**
 * Parse a single line of runtime stdout. Returns a {@link RuntimeDescriptor} iff
 * the line is a well-formed `PLEXUS_READY {...}` sentinel carrying a numeric port,
 * else `null` (so the caller can scan a buffer line-by-line and ignore noise).
 *
 * Tolerant: leading/trailing whitespace, extra fields on the JSON, and a missing
 * `pid`/`lraVersion` (defaulted) are all accepted — only a numeric `port` is
 * required, because the port is the load-bearing fact.
 */
export function parseReadyLine(line: string): RuntimeDescriptor | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(READY_LINE_PREFIX)) return null;
  const jsonPart = trimmed.slice(READY_LINE_PREFIX.length).trim();
  if (!jsonPart) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPart);
  } catch {
    return null;
  }
  return coerceDescriptor(parsed);
}

/**
 * Scan a (possibly multi-line, possibly partial) stdout chunk and return the
 * descriptor from the FIRST valid ready line, or `null`. Used to feed the child's
 * stdout `data` events without assuming line framing.
 */
export function scanForReadyLine(chunk: string): RuntimeDescriptor | null {
  for (const line of chunk.split(/\r?\n/)) {
    const d = parseReadyLine(line);
    if (d) return d;
  }
  return null;
}

/**
 * Parse the contents of `~/.plexus/runtime.json` (the fallback port source). Same
 * coercion as the ready line. Returns `null` on malformed/empty input.
 */
export function parseRuntimeFile(contents: string): RuntimeDescriptor | null {
  if (!contents || !contents.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  return coerceDescriptor(parsed);
}

/** Compose the loopback base URL for a discovered port. Always 127.0.0.1. */
export function baseUrlFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function coerceDescriptor(parsed: unknown): RuntimeDescriptor | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const port = obj.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  const pid = typeof obj.pid === "number" && Number.isInteger(obj.pid) ? obj.pid : 0;
  const lraVersion = typeof obj.lraVersion === "string" ? obj.lraVersion : "unknown";
  return { port, pid, lraVersion };
}
