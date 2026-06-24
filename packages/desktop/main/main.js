/**
 * ============================================================================
 * Electron MAIN — the Plexus desktop shell (P2, macOS-first)
 * ============================================================================
 *
 * Wires the four moving parts (REDESIGN §3, UX §1):
 *   1. SUPERVISOR  — spawn + supervise the runtime sidecar; learn the port;
 *                    poll /v1/health; backoff-restart; SIGTERM on quit; no orphan.
 *   2. TRAY        — status icon + "N approvals waiting" + Pause(=stop)/Resume +
 *                    Open Admin/Dashboard + Recent pulse + Quit.
 *   3. NOTIFICATIONS — on pending_added, fire a native Mode-1 approval card whose
 *                    actions call POST /v1/admin/api/pending/:id.
 *   4. RENDERER    — a BrowserWindow loading the runtime's served `/admin` SPA
 *                    (contextIsolation:true, nodeIntegration:false).
 *
 * It maintains the tray BADGE from pending_added − pending_resolved over the
 * management SSE stream, re-snapshotting `/v1/admin/api/pending` on reconnect
 * (the stream has no replay).
 *
 * requestSingleInstanceLock() so a second launch focuses the window, not a second
 * runtime against the same ~/.plexus.
 *
 * SMOKE MODE (PLEXUS_DESKTOP_SMOKE=1): after confirming (a) the sidecar reached
 * /v1/health, (b) the tray was created, (c) the admin window finished loading, it
 * logs `DESKTOP_SMOKE_OK {port,...}` and QUITS — verifying launch end-to-end
 * without leaving a window open, and killing the sidecar on the way out.
 */

import { app, BrowserWindow } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Supervisor } from "./supervisor.js";
import { EventStream } from "./event-stream.js";
import { PlexusTray } from "./tray.js";
import { NotificationManager } from "./notifications.js";
import { readConnectionKey } from "./connection-key.js";
import {
  PendingTracker,
  buildPendingSnapshotRequest,
  adminUrl,
} from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const SMOKE = process.env.PLEXUS_DESKTOP_SMOKE === "1";

/** @type {Supervisor|null} */ let supervisor = null;
/** @type {EventStream|null} */ let eventStream = null;
/** @type {PlexusTray|null} */ let tray = null;
/** @type {BrowserWindow|null} */ let mainWindow = null;
/** @type {NotificationManager|null} */ let notifications = null;
const tracker = new PendingTracker();
let paused = false;

function log(msg) {
  process.stdout.write(`[main] ${msg}\n`);
}

// ── Single-instance lock (§3.3): a 2nd launch focuses, never double-spawns. ───
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      openAdminWindow();
    }
  });
  app.whenReady().then(boot).catch((err) => {
    log(`boot failed: ${err.stack || err.message}`);
    if (SMOKE) {
      process.exitCode = 1;
    }
    void shutdown();
  });
}

async function boot() {
  const plexusHome = process.env.PLEXUS_HOME; // smoke passes a temp dir

  // (1) SUPERVISOR — spawn + confirm health.
  supervisor = new Supervisor({
    repoRoot: REPO_ROOT,
    plexusHome,
    noRestart: SMOKE, // smoke must not loop-restart on the deliberate quit
  });
  supervisor.on("exit", () => {
    if (!paused) tray?.setState("error");
  });
  supervisor.on("restarting", () => tray?.setState("error"));
  const descriptor = await supervisor.start(); // resolves after /v1/health is 200
  const port = descriptor.port;
  log(`runtime healthy on :${port}`);

  // Connection-key for main's own management calls (SSE + approve).
  const connectionKey = readConnectionKey(plexusHome);
  if (!connectionKey) log("WARNING: no connection-key found; approve actions disabled");

  // (2) TRAY.
  tray = new PlexusTray({
    onOpenAdmin: openAdminWindow,
    onOpenDashboard: openAdminWindow, // P2: dashboard IS the admin SPA (P5 separates)
    onTogglePause: togglePause,
    onQuit: () => {
      void shutdown(0);
    },
  });
  tray.setState("running");

  // (3) NOTIFICATIONS + the management event stream → badge + native Mode-1.
  notifications = new NotificationManager({
    port,
    connectionKey,
    onReview: () => openAdminWindow(),
    onResolved: (pendingId) => {
      tracker.resolve({ type: "pending_resolved", pendingId, kind: "grant", decision: "approved" });
      tray?.setBadge(tracker.count);
    },
  });
  await snapshotPending(port, connectionKey); // seed the badge from the snapshot
  startEventStream(port, connectionKey);

  // (4) RENDERER — host the runtime's served /admin SPA.
  const loaded = await openAdminWindow();

  if (SMOKE) {
    // All three conditions confirmed: (a) health, (b) tray, (c) admin loaded.
    const evidence = {
      port,
      pid: supervisor.pid,
      lraVersion: descriptor.lraVersion,
      tray: !!tray,
      adminLoaded: loaded,
      notificationsSupported: NotificationManager.supported(),
    };
    log(`DESKTOP_SMOKE_OK ${JSON.stringify(evidence)}`);
    await shutdown(0);
  }
}

/** Open (or focus) the BrowserWindow hosting the served `/admin` SPA. */
function openAdminWindow() {
  return new Promise((resolve) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
      resolve(true);
      return;
    }
    if (!supervisor?.descriptor) {
      resolve(false);
      return;
    }
    const port = supervisor.descriptor.port;
    mainWindow = new BrowserWindow({
      width: 1100,
      height: 760,
      show: !SMOKE, // smoke stays headless — never pop a window
      title: "Plexus",
      webPreferences: {
        preload: join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    mainWindow.webContents.once("did-finish-load", () => {
      log(`admin window loaded ${adminUrl(port)}`);
      done(true);
    });
    mainWindow.webContents.once("did-fail-load", (_e, code, desc) => {
      log(`admin window failed to load: ${code} ${desc}`);
      done(false);
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
    mainWindow.loadURL(adminUrl(port));
  });
}

/** Pause = STOP the runtime (deny-all panic switch, UX §1.1). Resume = re-spawn. */
async function togglePause() {
  if (!supervisor) return;
  if (!paused) {
    paused = true;
    tray?.setState("paused");
    await supervisor.stop();
    eventStream?.stop();
    tracker.reset([]);
    tray?.setBadge(0);
  } else {
    paused = false;
    tray?.setState("running");
    const descriptor = await supervisor.start();
    const connectionKey = readConnectionKey(process.env.PLEXUS_HOME);
    await snapshotPending(descriptor.port, connectionKey);
    startEventStream(descriptor.port, connectionKey);
  }
}

/** Subscribe to /v1/events; drive badge + notifications + recent pulse. */
function startEventStream(port, connectionKey) {
  if (!connectionKey) {
    log("no connection-key: skipping management event stream");
    return;
  }
  eventStream?.stop();
  eventStream = new EventStream({ port, connectionKey });
  eventStream.on("event", (ev) => onManagementEvent(ev, port, connectionKey));
  eventStream.on("reconnect", () => {
    // The stream has NO replay → re-snapshot to rebuild the badge (P1 note).
    void snapshotPending(port, connectionKey);
  });
  eventStream.start();
}

function onManagementEvent(ev, _port, _key) {
  switch (ev.type) {
    case "pending_added":
      tracker.add(ev);
      tray?.setBadge(tracker.count);
      notifications?.notifyPendingAdded(ev.item);
      break;
    case "pending_resolved":
      tracker.resolve(ev);
      tray?.setBadge(tracker.count);
      break;
    case "audit_appended":
      tray?.pushRecent({
        label: `${ev.agentId ?? "agent"} · ${ev.auditType}`,
        at: relativeTime(ev.at),
      });
      break;
    default:
      break; // manifest_changed / token_revoked / source_status — ignored in P2
  }
}

/** Re-seed the badge from the authoritative `/v1/admin/api/pending` snapshot. */
async function snapshotPending(port, connectionKey) {
  if (!connectionKey) return;
  try {
    const req = buildPendingSnapshotRequest({ port, connectionKey });
    const res = await fetch(req.url, { method: req.method, headers: req.headers });
    if (!res.ok) return;
    const body = await res.json();
    const items = Array.isArray(body) ? body : body.pending ?? body.items ?? [];
    const ids = items
      .map((it) => it.pendingId ?? it.id)
      .filter((id) => typeof id === "string");
    tracker.reset(ids);
    tray?.setBadge(tracker.count);
  } catch (err) {
    log(`pending snapshot failed: ${err.message}`);
  }
}

function relativeTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

// ── Lifecycle / orphan-safety (§3.3) ─────────────────────────────────────────
app.on("window-all-closed", () => {
  // Keep running in the tray (macOS resident model); do NOT quit on window close.
  // (Smoke quits explicitly, so this never fires there.)
});

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    eventStream?.stop();
    tray?.destroy();
    if (supervisor) await supervisor.stop(); // SIGTERM → SIGKILL; no orphan
  } finally {
    if (typeof code === "number") app.exit(code);
    else app.quit();
  }
}

app.on("will-quit", (e) => {
  if (!shuttingDown) {
    e.preventDefault();
    void shutdown();
  }
});
