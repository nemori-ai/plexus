/**
 * sysinfo provider — the INJECTABLE seam (hermetic tests + live host reads).
 *
 * The sysinfo source reads a host's system state three ways; this provider abstracts each
 * behind one interface so the source/bridge never touch the OS directly:
 *   - PROCESSES: shell out to `ps` (portable Linux + macOS) and parse structured rows.
 *   - RESOURCES: Node/Bun `os` module for loadavg + memory (portable), `df -kP` for disk.
 *   - LOG: read the TAIL of a file that is PATH-JAILED under an allowlisted log root, using
 *     the SAME `confineToVault` three-layer defense the workspace / obsidian sources use
 *     (reject absolute, reject `..` traversal, realpath re-check to defeat symlink escape).
 *
 * COMMAND EXECUTION is itself an injectable seam ({@link CommandRunner}) so tests are fully
 * hermetic (canned `ps`/`df` output, no real subprocess) while the live host uses a real
 * `execFile`. A MISSING binary (`ps`/`df` not found) degrades to a typed
 * {@link SysinfoUnavailableError} → the bridge surfaces a clean `source_unavailable`, NEVER
 * a crash. A path-jail violation throws {@link VaultConfinementError} → `transport_error`.
 *
 * TWO IMPLEMENTATIONS:
 *   - {@link RealSysinfoProvider}: real `os` + `df`/`ps` + confined fs under the log root.
 *   - {@link FakeSysinfoProvider}: canned process/resource/log data (no OS access) for tests
 *     + the e2e probe. Confinement is STILL real (it uses `confineToVault` against a temp
 *     log root), so the security negative is exercised the same way live.
 *
 * SELECTION ({@link selectSysinfoProvider}): real by default; the FAKE when
 * `process.env.PLEXUS_FAKE_SYSINFO === "1"`, or an explicit provider injected via the
 * source/bridge constructor.
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { freemem, loadavg, cpus, platform as osPlatform, totalmem, uptime } from "node:os";

import { confineToVault, VaultConfinementError } from "../obsidian/vault-reader.ts";

/** Re-export the confinement error so callers/tests can assert against it. */
export { VaultConfinementError as SysinfoConfinementError } from "../obsidian/vault-reader.ts";

/** A source-unavailable degrade (missing `ps`/`df` binary, unreadable command). */
export class SysinfoUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SysinfoUnavailableError";
  }
}

// ── Result shapes ─────────────────────────────────────────────────────────────

/** One process row. `cpu`/`mem` are percentages. */
export interface ProcessRow {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  command: string;
}

/** The result of a processes.list read. */
export interface ProcessListResult {
  count: number;
  total: number;
  processes: ProcessRow[];
}

/** One filesystem's disk usage. */
export interface DiskUsage {
  filesystem: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPct: number;
}

/** A cpu/mem/disk snapshot. */
export interface ResourceSnapshot {
  platform: string;
  uptimeSeconds: number;
  cpu: { cores: number; loadavg: [number, number, number]; loadPerCore: number };
  memory: { totalBytes: number; usedBytes: number; freeBytes: number; usedPct: number };
  disks: DiskUsage[];
}

/** The result of a log tail read. */
export interface LogTailResult {
  file: string;
  lines: number;
  truncated: boolean;
  content: string;
}

/** Bounds (exported so tests + the bridge agree on the caps). */
export const PROCESS_TOP_DEFAULT = 50;
export const PROCESS_TOP_MAX = 200;
export const LOG_LINES_DEFAULT = 200;
export const LOG_LINES_MAX = 2000;

/** Clamp `top` for processes.list into 1..PROCESS_TOP_MAX (default when absent). */
export function clampTop(top: unknown): number {
  const n = typeof top === "number" && Number.isFinite(top) ? Math.floor(top) : PROCESS_TOP_DEFAULT;
  return Math.max(1, Math.min(PROCESS_TOP_MAX, n));
}

/** Clamp `lines` for log.read into 1..LOG_LINES_MAX (default when absent). */
export function clampLines(lines: unknown): number {
  const n = typeof lines === "number" && Number.isFinite(lines) ? Math.floor(lines) : LOG_LINES_DEFAULT;
  return Math.max(1, Math.min(LOG_LINES_MAX, n));
}

// ── Command runner seam ─────────────────────────────────────────────────────────

/** Result of running a command. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * The subprocess seam. Throws {@link SysinfoUnavailableError} when the binary is missing
 * (ENOENT). Tests inject a canned runner so no real process is spawned.
 */
export type CommandRunner = (cmd: string, args: string[]) => Promise<CommandResult>;

/** REAL command runner over `execFile` (enriched by the ambient PATH). Fail-closed on ENOENT. */
export const realCommandRunner: CommandRunner = (cmd, args) =>
  new Promise<CommandResult>((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) {
        // ENOENT ⇒ the binary is not installed → typed unavailable degrade (not a crash).
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new SysinfoUnavailableError(`\`${cmd}\` not found on PATH`));
          return;
        }
        // A non-zero exit still carries stdout/stderr — surface them (caller decides).
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? err.message),
          code: typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : 1,
        });
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: 0 });
    });
  });

// ── Parsing helpers (portable across Linux + macOS) ─────────────────────────────

/**
 * Parse `ps -A -o pid=,user=,pcpu=,pmem=,comm=` output. Header-suppressed (`=`), so each
 * line is: `<pid> <user> <pcpu> <pmem> <comm...>`. `comm` may contain spaces (a path), so
 * the command is the remainder after the first four whitespace-split fields.
 */
export function parsePsOutput(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number.parseInt(m[1]!, 10);
    if (!Number.isFinite(pid)) continue;
    rows.push({
      pid,
      user: m[2]!,
      cpu: Number.parseFloat(m[3]!) || 0,
      mem: Number.parseFloat(m[4]!) || 0,
      command: m[5]!.trim(),
    });
  }
  return rows;
}

/**
 * Parse `df -kP` (POSIX portable) output. The `-P` flag guarantees one physical line per
 * filesystem with fixed columns: `Filesystem 1024-blocks Used Available Capacity Mounted-on`.
 * Blocks are 1024-byte KiB. The mount point (last field) may contain spaces, so it is the
 * remainder after the first five fields.
 */
export function parseDfOutput(stdout: string): DiskUsage[] {
  const disks: DiskUsage[] = [];
  const lines = stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (i === 0 && /filesystem/i.test(line)) continue; // header
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue;
    const filesystem = parts[0]!;
    const totalKb = Number.parseInt(parts[1]!, 10);
    const usedKb = Number.parseInt(parts[2]!, 10);
    const availKb = Number.parseInt(parts[3]!, 10);
    if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb) || !Number.isFinite(availKb)) continue;
    const mount = parts.slice(5).join(" ");
    const totalBytes = totalKb * 1024;
    const usedBytes = usedKb * 1024;
    disks.push({
      filesystem,
      mount,
      totalBytes,
      usedBytes,
      availableBytes: availKb * 1024,
      usedPct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
    });
  }
  return disks;
}

/** Return the last `n` lines of `text` (and whether older lines were dropped). */
export function tailLines(text: string, n: number): { content: string; lines: number; truncated: boolean } {
  // Split on \n; drop a single trailing empty element from a final newline.
  const all = text.split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  const truncated = all.length > n;
  const kept = truncated ? all.slice(all.length - n) : all;
  return { content: kept.join("\n"), lines: kept.length, truncated };
}

/**
 * The most bytes {@link readLogTail} pulls from the END of a log. `log.read` advertises a
 * LINE cap ({@link LOG_LINES_MAX}), but a naive whole-file read spikes gateway memory on a
 * multi-GB syslog. We instead read only the trailing window — generously sized to hold
 * LOG_LINES_MAX lines even at ~2KB/line — so peak memory is bounded regardless of file size.
 */
export const LOG_TAIL_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Read the last `lines` lines of a file WITHOUT loading the whole thing: seek to a bounded
 * trailing window ({@link LOG_TAIL_MAX_BYTES}) and tail that. On a partial window the first
 * line is likely truncated (and a multi-byte char may be split at the window boundary), so it
 * is dropped — only WHOLE lines are returned, and `truncated` reflects the byte cap too.
 */
export async function readLogTail(
  abs: string,
  size: number,
  lines: number,
  maxBytes: number = LOG_TAIL_MAX_BYTES,
): Promise<{ content: string; lines: number; truncated: boolean }> {
  const budget = Math.min(Math.max(0, size), Math.max(0, maxBytes));
  const partial = budget < size;
  let text = "";
  if (budget > 0) {
    const fh = await open(abs, "r");
    try {
      const buf = Buffer.allocUnsafe(budget);
      const { bytesRead } = await fh.read(buf, 0, budget, size - budget);
      text = buf.toString("utf-8", 0, bytesRead);
    } finally {
      await fh.close();
    }
  }
  if (partial) {
    const nl = text.indexOf("\n");
    text = nl >= 0 ? text.slice(nl + 1) : "";
  }
  const t = tailLines(text, lines);
  return { content: t.content, lines: t.lines, truncated: t.truncated || partial };
}

// ── Provider interface ──────────────────────────────────────────────────────────

/** Availability probe result (drives source HEALTH). */
export interface SysinfoAvailability {
  ok: boolean;
  reason?: string;
}

/**
 * The system-read seam. The source/bridge depend on THIS, never on `os`/`fs`/`execFile`
 * directly — so tests inject the fake. `readLog` is confined to the log root.
 */
export interface SysinfoProvider {
  /** The absolute allowlisted log root `readLog` is confined to. */
  readonly logRoot: string;
  /** Is the log root reachable (exists + is a directory)? Drives health(). */
  available(): Promise<SysinfoAvailability>;
  /** PROCESSES: top-N by cpu. Throws SysinfoUnavailableError if `ps` is missing. */
  listProcesses(top: number): Promise<ProcessListResult>;
  /** RESOURCES: cpu/mem via `os`, disk via `df` (empty disks[] if `df` missing). */
  readResources(): Promise<ResourceSnapshot>;
  /** LOG: tail of a file confined under the log root. Throws VaultConfinementError on escape. */
  readLog(file: string, lines: number): Promise<LogTailResult>;
}

// ── Log-root resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the allowlisted log root. Precedence: explicit arg > `PLEXUS_SYSINFO_LOG_DIR` >
 * platform default (`/var/log` on a Unix host; empty on win32 — no safe default there).
 */
export function resolveLogRoot(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit;
  const fromEnv = process.env.PLEXUS_SYSINFO_LOG_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return osPlatform() === "win32" ? "" : "/var/log";
}

// ── REAL provider ─────────────────────────────────────────────────────────────

export class RealSysinfoProvider implements SysinfoProvider {
  readonly logRoot: string;
  private readonly run: CommandRunner;

  constructor(opts?: { logRoot?: string; run?: CommandRunner }) {
    this.logRoot = resolveLogRoot(opts?.logRoot);
    this.run = opts?.run ?? realCommandRunner;
  }

  async available(): Promise<SysinfoAvailability> {
    if (!this.logRoot) {
      return { ok: false, reason: "no log root configured (set PLEXUS_SYSINFO_LOG_DIR)" };
    }
    try {
      if (!existsSync(this.logRoot)) return { ok: false, reason: `log root not found: ${this.logRoot}` };
      if (!statSync(this.logRoot).isDirectory()) {
        return { ok: false, reason: `log root is not a directory: ${this.logRoot}` };
      }
      return { ok: true, reason: `log root at ${this.logRoot}` };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `log root unreadable: ${this.logRoot} (${why})` };
    }
  }

  async listProcesses(top: number): Promise<ProcessListResult> {
    // `ps -A -o pid=,user=,pcpu=,pmem=,comm=` is portable across Linux (procps) + macOS.
    const res = await this.run("ps", ["-A", "-o", "pid=,user=,pcpu=,pmem=,comm="]);
    if (res.code !== 0 && !res.stdout.trim()) {
      throw new SysinfoUnavailableError(`ps failed (exit ${res.code}): ${res.stderr.trim() || "no output"}`);
    }
    const all = parsePsOutput(res.stdout).sort((a, b) => b.cpu - a.cpu);
    const processes = all.slice(0, top);
    return { count: processes.length, total: all.length, processes };
  }

  async readResources(): Promise<ResourceSnapshot> {
    const cores = cpus().length || 1;
    const la = loadavg();
    const load: [number, number, number] = [la[0] ?? 0, la[1] ?? 0, la[2] ?? 0];
    const totalBytes = totalmem();
    const freeBytes = freemem();
    const usedBytes = Math.max(0, totalBytes - freeBytes);

    // Disk via `df -kP` (POSIX portable). A missing `df` degrades to an EMPTY disk list — a
    // resource snapshot without disk is still useful; we never crash on it.
    let disks: DiskUsage[] = [];
    try {
      const res = await this.run("df", ["-kP"]);
      if (res.stdout.trim()) disks = parseDfOutput(res.stdout);
    } catch (err) {
      if (!(err instanceof SysinfoUnavailableError)) throw err;
      disks = [];
    }

    return {
      platform: osPlatform(),
      uptimeSeconds: Math.round(uptime()),
      cpu: {
        cores,
        loadavg: load,
        loadPerCore: cores > 0 ? Math.round((load[0] / cores) * 1000) / 1000 : 0,
      },
      memory: {
        totalBytes,
        usedBytes,
        freeBytes,
        usedPct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
      },
      disks,
    };
  }

  async readLog(file: string, lines: number): Promise<LogTailResult> {
    if (!this.logRoot) {
      throw new SysinfoUnavailableError("no log root configured (set PLEXUS_SYSINFO_LOG_DIR)");
    }
    // CONFINE FIRST — reject absolute / `..` / symlink-escape — THEN read. The confined
    // absolute path provably lives under the allowlisted log root. `confineToVault` also
    // realpath()-rechecks, so a symlink inside the root pointing out is denied.
    const abs = confineToVault(this.logRoot, file);
    const info = statSync(abs);
    if (info.isDirectory()) {
      throw new SysinfoUnavailableError(`not a file: ${file}`);
    }
    // Bounded tail read — never load a whole (possibly multi-GB) log into memory.
    const t = await readLogTail(abs, info.size, lines);
    return { file: this.relative(file), lines: t.lines, truncated: t.truncated, content: t.content };
  }

  /** Normalize the requested path to a stable root-relative form for the wire. */
  private relative(file: string): string {
    return (file ?? "").replace(/^\.?\/+/, "");
  }
}

// ── FAKE provider (canned data; confinement still REAL against a temp root) ─────

/**
 * Hermetic fake. Process/resource data are canned; log reads use REAL `confineToVault`
 * against the provided temp `logRoot` and read the real file there — so the security
 * negative (path escape) is exercised identically to live, but nothing touches `/var/log`
 * or spawns a subprocess.
 */
export class FakeSysinfoProvider implements SysinfoProvider {
  readonly logRoot: string;

  constructor(opts?: { logRoot?: string }) {
    this.logRoot = opts?.logRoot ?? "";
  }

  async available(): Promise<SysinfoAvailability> {
    return { ok: true, reason: `fake sysinfo provider (log root ${this.logRoot || "<none>"})` };
  }

  async listProcesses(top: number): Promise<ProcessListResult> {
    const all: ProcessRow[] = [
      { pid: 1, user: "root", cpu: 0.1, mem: 0.4, command: "/sbin/init" },
      { pid: 42, user: "root", cpu: 12.5, mem: 3.2, command: "sshd" },
      { pid: 77, user: "www-data", cpu: 88.0, mem: 9.1, command: "nginx: worker" },
      { pid: 91, user: "postgres", cpu: 4.0, mem: 22.5, command: "postgres" },
    ].sort((a, b) => b.cpu - a.cpu);
    const processes = all.slice(0, top);
    return { count: processes.length, total: all.length, processes };
  }

  async readResources(): Promise<ResourceSnapshot> {
    const cores = 4;
    return {
      platform: "linux",
      uptimeSeconds: 123456,
      cpu: { cores, loadavg: [1.2, 0.9, 0.7], loadPerCore: Math.round((1.2 / cores) * 1000) / 1000 },
      memory: {
        totalBytes: 8 * 1024 ** 3,
        usedBytes: 5 * 1024 ** 3,
        freeBytes: 3 * 1024 ** 3,
        usedPct: 62.5,
      },
      disks: [
        {
          filesystem: "/dev/sda1",
          mount: "/",
          totalBytes: 50 * 1024 ** 3,
          usedBytes: 20 * 1024 ** 3,
          availableBytes: 30 * 1024 ** 3,
          usedPct: 40,
        },
      ],
    };
  }

  async readLog(file: string, lines: number): Promise<LogTailResult> {
    if (!this.logRoot) throw new SysinfoUnavailableError("fake provider has no log root configured");
    const abs = confineToVault(this.logRoot, file);
    const info = statSync(abs);
    if (info.isDirectory()) throw new SysinfoUnavailableError(`not a file: ${file}`);
    const t = await readLogTail(abs, info.size, lines);
    return { file: (file ?? "").replace(/^\.?\/+/, ""), lines: t.lines, truncated: t.truncated, content: t.content };
  }
}

// ── Selection ─────────────────────────────────────────────────────────────────

/** True when the fake provider is forced via the env switch. */
export function fakeSysinfoForced(): boolean {
  return process.env.PLEXUS_FAKE_SYSINFO === "1";
}

/**
 * Pick the provider: an explicitly injected one wins; else the FAKE when
 * `PLEXUS_FAKE_SYSINFO=1`; else the REAL provider (log root from `PLEXUS_SYSINFO_LOG_DIR`
 * or the platform default).
 */
export function selectSysinfoProvider(injected?: SysinfoProvider): SysinfoProvider {
  if (injected) return injected;
  if (fakeSysinfoForced()) return new FakeSysinfoProvider();
  return new RealSysinfoProvider();
}
