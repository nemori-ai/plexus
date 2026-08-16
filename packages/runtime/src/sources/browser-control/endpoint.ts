/**
 * Where the CDP endpoint comes from — the ONLY thing the two modes differ by.
 *
 *   `launch`  Plexus spawns its own Chrome on an ephemeral port with its OWN
 *             `--user-data-dir`. That profile has no cookies and no logged-in sessions, so
 *             the blast radius is "a browser that can reach the public web as nobody".
 *   `attach`  Plexus connects to the Chrome the user is already running. Chrome itself gates
 *             this — since M144 it shows a permission dialog per debugging session and flies
 *             the "controlled by automated test software" banner — but Chrome's consent is
 *             ALL-OR-NOTHING, so everything that browser is logged into is in reach. That is
 *             why attach is an owner opt-in and why the origin gate is not optional.
 *
 * Mode selection and the allowlist are OWNER configuration read from the environment; an agent
 * cannot influence either. The source is inert until the owner names at least one origin.
 */

import { mkdirSync } from "node:fs";
import { normalizeAllowlist } from "./origin-gate.ts";
import { closeAllSessions, endpointAlive, type CdpEndpoint } from "./cdp.ts";
import { connectBrowser, type Browser } from "./browser.ts";

export type BrowserControlMode = "launch" | "attach";

/** Chrome's conventional remote-debugging port — what `--remote-debugging-port=9222` uses. */
export const DEFAULT_ATTACH_PORT = 9222;

export interface BrowserControlConfig {
  mode: BrowserControlMode;
  /** Owner-authorized origins. EMPTY ⇒ the source refuses every call (fail closed). */
  allowlist: string[];
  /** Port to attach to in `attach` mode. */
  attachPort: number;
  /** Where a `launch`-mode profile lives (never the user's real profile). */
  profileDir: string;
  /** Absolute path to the Chrome binary, when resolvable. */
  binary?: string;
  /**
   * The ONLY directory a file upload may read from. EMPTY ⇒ every upload is refused.
   *
   * Upload hands a website a file off this machine — an exfiltration channel with a browser in
   * front of it. The jail is not a convenience around the feature; it IS the feature. Unset
   * means the verb exists, explains itself, and refuses, exactly like an empty allowlist.
   */
  uploadDir?: string;
  /**
   * Run a LAUNCHED browser with no window. Irrelevant to `attach`, which uses the browser the
   * owner is already looking at.
   *
   * Off by default: a visible window is how an owner sees what an agent is doing, and hiding it
   * by default would make the automation invisible exactly where it should not be. Tests turn it
   * on, because a suite that steals focus and stacks windows makes the machine unusable while
   * it runs.
   */
  headless?: boolean;
}

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Read the owner's configuration.
 *
 * `PLEXUS_BROWSER_CONTROL_ORIGINS` is the load-bearing one: a comma-separated allowlist.
 * Absent or empty means the capability is present but refuses everything — deliberately, so a
 * gateway that merely has Chrome installed never silently exposes the web to an agent.
 */
export function loadBrowserControlConfig(env: NodeJS.ProcessEnv = process.env): BrowserControlConfig {
  const mode: BrowserControlMode =
    (env.PLEXUS_BROWSER_CONTROL_MODE ?? "").trim().toLowerCase() === "attach" ? "attach" : "launch";
  const allowlist = normalizeAllowlist((env.PLEXUS_BROWSER_CONTROL_ORIGINS ?? "").split(","));
  const portRaw = Number.parseInt(env.PLEXUS_BROWSER_CONTROL_ATTACH_PORT ?? "", 10);
  const attachPort = Number.isFinite(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : DEFAULT_ATTACH_PORT;
  const home = env.PLEXUS_HOME ?? `${env.HOME ?? "."}/.plexus`;
  return {
    mode,
    allowlist,
    attachPort,
    profileDir: `${home}/workspace/browser-control`,
    ...(env.PLEXUS_BROWSER_CONTROL_UPLOAD_DIR?.trim() ? { uploadDir: env.PLEXUS_BROWSER_CONTROL_UPLOAD_DIR.trim() } : {}),
    ...(/^(1|true|yes)$/i.test((env.PLEXUS_BROWSER_CONTROL_HEADLESS ?? "").trim()) ? { headless: true } : {}),
    ...(env.PLEXUS_BROWSER_CONTROL_BINARY ? { binary: env.PLEXUS_BROWSER_CONTROL_BINARY } : {}),
  };
}

/** Resolve the Chrome binary, or `undefined` when it is not installed where we look. */
export function resolveChromeBinary(cfg: BrowserControlConfig): string | undefined {
  if (cfg.binary) return cfg.binary;
  return process.platform === "darwin" ? MAC_CHROME : undefined;
}

/**
 * A launched browser Plexus owns. Held for the process lifetime and REUSED: spawning a browser
 * per call would be both slow and a way to accumulate orphans.
 */
interface LaunchedBrowser {
  endpoint: CdpEndpoint;
  proc: { kill(): void };
}
let launched: LaunchedBrowser | undefined;

/** Pick a free localhost port by letting the OS choose one and releasing it. */
async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port;
  server.stop(true);
  if (typeof port !== "number") throw new Error("could not reserve a local debugging port");
  return port;
}

/**
 * The endpoint for this mode, launching if needed.
 *
 * In `attach` mode nothing is spawned: if the user has not enabled remote debugging, this fails
 * with an instruction rather than silently falling back to launching a browser — quietly
 * downgrading to a different mode than the owner configured would be its own kind of lie.
 */
export async function resolveEndpoint(cfg: BrowserControlConfig): Promise<CdpEndpoint> {
  if (cfg.mode === "attach") {
    const ep = { host: "127.0.0.1", port: cfg.attachPort };
    if (await endpointAlive(ep)) return ep;
    throw new Error(
      `no Chrome is exposing a debugging endpoint on port ${cfg.attachPort}. The owner enables ` +
        `it once at chrome://inspect/#remote-debugging (Chrome 144+) — which is the ONLY way in ` +
        `to a logged-in browser, since Chrome refuses --remote-debugging-port on the default ` +
        `profile. Chrome then asks for permission and shows its automation banner.`,
    );
  }

  if (launched && (await endpointAlive(launched.endpoint))) return launched.endpoint;

  const binary = resolveChromeBinary(cfg);
  if (!binary) throw new Error("Google Chrome was not found on this machine.");
  mkdirSync(cfg.profileDir, { recursive: true });
  const port = await freePort();
  const proc = Bun.spawn(
    [
      binary,
      `--remote-debugging-port=${port}`,
      // ITS OWN PROFILE — never the user's. This is what makes `launch` mode a browser with no
      // cookies and no logged-in sessions rather than a second window onto the user's web.
      `--user-data-dir=${cfg.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(cfg.headless ? ["--headless=new"] : []),
      // The profile PERSISTS between gateway runs, so without these Chrome restores the tabs
      // the last run left open and they accumulate every time the gateway starts.
      "--no-restore-session-state",
      "--hide-crash-restore-bubble",
      "--disable-session-crashed-bubble",
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const endpoint = { host: "127.0.0.1", port };
  for (let i = 0; i < 60; i++) {
    if (await endpointAlive(endpoint)) {
      launched = { endpoint, proc };
      return endpoint;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
  throw new Error("Chrome was launched but never exposed a debugging endpoint.");
}

/**
 * Stop browser control (process teardown / tests).
 *
 * Never kills an ATTACHED browser — that one is the user's — but it does put back everything
 * Plexus took: the debugging sockets bridges hold for the life of a session, and the tabs
 * Plexus itself opened. Leaving those behind is what makes an agent's browsing pile up windows
 * in the user's own Chrome.
 *
 * Awaitable so a caller that is about to exit can let the tab-closes land; the sync
 * {@link shutdownLaunchedBrowser} stays for callers that only need the browser gone.
 */
export async function shutdownBrowserControl(): Promise<void> {
  closeAllSessions();
  await releaseBrowser();
  shutdownLaunchedBrowser();
}

/**
 * The live connection, kept for the process. Reopening the browser socket per call would ask
 * Chrome to re-authorize the session every time under the built-in-toggle flow.
 */
let connection: { endpoint: CdpEndpoint; browser: Browser } | undefined;

/** Connect to the endpoint for this mode, reusing the connection when it is still good. */
export async function openBrowser(cfg: BrowserControlConfig): Promise<Browser> {
  const endpoint = await resolveEndpoint(cfg);
  if (connection && connection.endpoint.port === endpoint.port && connection.browser) {
    return connection.browser;
  }
  connection?.browser.close();
  const browser = await connectBrowser(endpoint);
  connection = { endpoint, browser };
  return browser;
}

/** Tabs PLEXUS ITSELF opened, so teardown can close them (either connection shape). */
const ownTabs = new Set<string>();
export function rememberOwnTab(targetId: string): void {
  if (targetId) ownTabs.add(targetId);
}

/** Close every tab Plexus opened, and release the browser connection. */
export async function releaseBrowser(): Promise<void> {
  const ids = [...ownTabs];
  ownTabs.clear();
  if (connection && ids.length) {
    try {
      await connection.browser.closeTargets(ids);
    } catch {
      /* the browser may already be gone */
    }
  }
  connection?.browser.close();
  connection = undefined;
}

/** Stop a Plexus-launched browser and release its sockets. Never touches an attached one. */
export function shutdownLaunchedBrowser(): void {
  closeAllSessions();
  try {
    launched?.proc.kill();
  } catch {
    /* idempotent */
  }
  launched = undefined;
}
