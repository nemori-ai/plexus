/**
 * ============================================================================
 * Supervisor — spawn + supervise the Plexus runtime sidecar (REDESIGN §3.1-3.4)
 * ============================================================================
 *
 * The Electron main process spawns the runtime as a CHILD process and owns its
 * lifecycle:
 *   - SPAWN the runtime (dev: `bun run <repo>/packages/runtime/bin/plexus`).
 *   - LEARN the bound port by parsing the `PLEXUS_READY {...}` stdout line
 *     (fallback: read `~/.plexus/runtime.json`). (§3.3 parse-then-confirm)
 *   - CONFIRM readiness by polling `GET /v1/health` until 200.
 *   - RESTART on crash with exponential backoff (capped).
 *   - SHUTDOWN: SIGTERM the child on quit; track the pid; SIGKILL as last resort
 *     so no orphan runtime survives.
 *
 * Plain Node/CommonJS-via-ESM (Electron main) — imports the pure helpers from the
 * bundled `helpers.js` (parseReadyLine / parseRuntimeFile / buildHealthRequest).
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { EventEmitter } from "node:events";
import {
  scanForReadyLine,
  parseRuntimeFile,
  buildHealthRequest,
} from "./helpers.js";

const RESTART_BASE_MS = 500;
const RESTART_MAX_MS = 30_000;
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;

/**
 * @typedef {Object} SupervisorOptions
 * @property {string} repoRoot     Absolute path to the monorepo root (to locate bin/plexus).
 * @property {string} [plexusHome] PLEXUS_HOME to pass to the child (smoke uses a temp dir).
 * @property {string} [command]    The resolved executable to spawn (dev: `bun`; prod: the
 *                                  compiled sidecar exe under resourcesPath). When omitted the
 *                                  supervisor falls back to the dev `bun run bin/plexus` path.
 * @property {string[]} [args]     Args for `command` (dev: `["run", <bin/plexus>]`; prod: `[]`).
 *                                  Resolved by `resolveRuntimeCommand` in main.js (§3.1/§5.1).
 * @property {string} [runtimeBin] DEPRECATED: legacy single-exe override (no args). Prefer
 *                                  `command`/`args`. Kept so the P2 smoke harness still works.
 * @property {boolean} [noRestart] Disable auto-restart (smoke mode).
 * @property {number} [port] Preferred port (default: the runtime's own default 7077).
 * @property {boolean} [ephemeral] Force PLEXUS_PORT=0 (ephemeral bind) from the start.
 */

export class Supervisor extends EventEmitter {
  /** @param {SupervisorOptions} opts */
  constructor(opts) {
    super();
    this.opts = opts;
    /** When the preferred port is taken we flip this and retry ephemeral (§3.4). */
    this.useEphemeral = !!opts.ephemeral;
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null;
    /** @type {import('./helpers.js').RuntimeDescriptor | null} */
    this.descriptor = null;
    this.restartAttempts = 0;
    this.shuttingDown = false;
    this.ready = false;
  }

  /** Path to the runtime bin in dev (repo build dir). */
  runtimePath() {
    return join(this.opts.repoRoot, "packages", "runtime", "bin", "plexus");
  }

  /**
   * Resolve the {command, args} to spawn. Priority:
   *   1. explicit `command`/`args` (main.js resolves dev-vs-packaged via the pure
   *      `resolveRuntimeCommand`); identical supervisor code dev + prod (§5.1).
   *   2. legacy `runtimeBin` (a self-contained exe, no args) — P2 smoke override.
   *   3. dev fallback: `bun run <repoRoot>/packages/runtime/bin/plexus`.
   * @returns {{ bin: string, args: string[] }}
   */
  resolveCommand() {
    if (this.opts.command) {
      return { bin: this.opts.command, args: this.opts.args ?? [] };
    }
    if (this.opts.runtimeBin) {
      return { bin: this.opts.runtimeBin, args: [] };
    }
    return { bin: "bun", args: ["run", this.runtimePath()] };
  }

  runtimeHome() {
    return this.opts.plexusHome ?? join(homedir(), ".plexus");
  }

  /**
   * Spawn the runtime, learn its port, and resolve once `GET /v1/health` is 200.
   * @returns {Promise<import('./helpers.js').RuntimeDescriptor>}
   */
  async start() {
    this.shuttingDown = false;
    let descriptor;
    try {
      descriptor = await this._spawnAndDiscover();
    } catch (err) {
      // §3.4 port fallback: the preferred port (7077) is taken → bind ephemeral.
      if (!this.useEphemeral && /EADDRINUSE|port .* in use/i.test(String(err.message))) {
        this.log("preferred port in use → retrying with an ephemeral port (PLEXUS_PORT=0)");
        this.useEphemeral = true;
        descriptor = await this._spawnAndDiscover();
      } else {
        throw err;
      }
    }
    await this._waitForHealth(descriptor.port);
    this.descriptor = descriptor;
    this.ready = true;
    this.restartAttempts = 0;
    this.emit("ready", descriptor);
    return descriptor;
  }

  /** @returns {Promise<import('./helpers.js').RuntimeDescriptor>} */
  _spawnAndDiscover() {
    return new Promise((resolve, reject) => {
      const { bin, args } = this.resolveCommand();
      const env = {
        ...process.env,
        PLEXUS_HOME: this.runtimeHome(),
        // PRODUCT DEFAULT: the shipped/dev desktop app enables REAL headless
        // Claude Code launches (`claude -p`, sandbox-confined) by default. The
        // runtime's bare default stays OFF so `bash run-tests.sh`, the e2e
        // acceptance suite, CI, and a bare `bun run start` remain hermetic/offline —
        // they run the runtime directly, NOT through this supervisor, so they never
        // inherit this flag. Set PLEXUS_CC_HEADLESS_LAUNCH=1 manually for a bare
        // runtime to launch for real. (See DESKTOP-RUNTIME-REDESIGN.)
        PLEXUS_CC_HEADLESS_LAUNCH: "1",
      };
      this.log("real Claude Code headless launch ENABLED (PLEXUS_CC_HEADLESS_LAUNCH=1 for the runtime sidecar)");
      // Port selection (§3.4): prefer the default 7077; `port:0`/ephemeral binds a
      // free port and we learn the actual one from the ready line.
      if (this.useEphemeral) env.PLEXUS_PORT = "0";
      else if (typeof this.opts.port === "number") env.PLEXUS_PORT = String(this.opts.port);

      this.log(`spawning runtime: ${bin} ${args.join(" ")} (PLEXUS_HOME=${env.PLEXUS_HOME})`);
      const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;

      let settled = false;
      let stdoutBuf = "";
      let stderrBuf = "";

      const onReady = (descriptor) => {
        if (settled) return;
        settled = true;
        this.log(`runtime ready line: port=${descriptor.port} pid=${descriptor.pid}`);
        resolve(descriptor);
      };

      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk;
        const d = scanForReadyLine(stdoutBuf);
        if (d) onReady(d);
        // forward for debugging
        process.stdout.write(`[runtime] ${chunk}`);
      });
      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (chunk) => {
        stderrBuf += chunk;
        process.stderr.write(`[runtime:err] ${chunk}`);
      });

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(new Error(`failed to spawn runtime: ${err.message}`));
        }
      });

      child.on("exit", (code, signal) => {
        this.ready = false;
        this.log(`runtime exited code=${code} signal=${signal}`);
        this.emit("exit", { code, signal });
        if (!settled) {
          // Crashed before announcing a port: try the runtime.json fallback once.
          const fromFile = this._readRuntimeFile();
          if (fromFile) {
            settled = true;
            resolve(fromFile);
            return;
          }
          settled = true;
          // Preserve the WHOLE stderr so the EADDRINUSE marker survives for the
          // port-fallback regex in start() (the marker is earlier than the stack).
          const detail = stderrBuf.replace(/\s+/g, " ").trim();
          reject(new Error(`runtime exited before ready (code=${code} signal=${signal}) ${detail}`));
          return;
        }
        if (!this.shuttingDown && !this.opts.noRestart) this._scheduleRestart();
      });

      // Fallback: if no ready line within a grace window, try the port file.
      setTimeout(() => {
        if (settled) return;
        const fromFile = this._readRuntimeFile();
        if (fromFile) onReady(fromFile);
      }, 3_000);
    });
  }

  /** @returns {import('./helpers.js').RuntimeDescriptor | null} */
  _readRuntimeFile() {
    try {
      const p = join(this.runtimeHome(), "runtime.json");
      if (!existsSync(p)) return null;
      return parseRuntimeFile(readFileSync(p, "utf-8"));
    } catch {
      return null;
    }
  }

  /** Poll GET /v1/health until 200 or timeout. @param {number} port */
  async _waitForHealth(port) {
    const req = buildHealthRequest({ port });
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(req.url, { method: req.method, headers: req.headers });
        if (res.ok) {
          this.log(`health OK on :${port}`);
          return;
        }
      } catch {
        /* not up yet */
      }
      await delay(HEALTH_POLL_MS);
    }
    throw new Error(`runtime did not become healthy on :${port} within ${HEALTH_TIMEOUT_MS}ms`);
  }

  _scheduleRestart() {
    this.restartAttempts += 1;
    const backoff = Math.min(RESTART_BASE_MS * 2 ** (this.restartAttempts - 1), RESTART_MAX_MS);
    this.log(`scheduling restart #${this.restartAttempts} in ${backoff}ms`);
    this.emit("restarting", { attempt: this.restartAttempts, delayMs: backoff });
    setTimeout(() => {
      if (this.shuttingDown) return;
      this.start().catch((err) => {
        this.log(`restart failed: ${err.message}`);
        if (!this.shuttingDown) this._scheduleRestart();
      });
    }, backoff);
  }

  /** SIGTERM the child, then SIGKILL after a grace period. No orphan survives. */
  async stop() {
    this.shuttingDown = true;
    this.ready = false;
    const child = this.child;
    if (!child || child.exitCode !== null || child.killed) return;
    this.log(`stopping runtime pid=${child.pid} (SIGTERM)`);
    child.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise((r) => child.once("exit", () => r(true))),
      delay(4_000).then(() => false),
    ]);
    if (!exited && child.exitCode === null && !child.killed) {
      this.log(`runtime did not exit; SIGKILL pid=${child.pid}`);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    this.child = null;
  }

  get pid() {
    return this.child?.pid;
  }

  log(msg) {
    process.stdout.write(`[supervisor] ${msg}\n`);
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
