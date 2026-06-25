/**
 * Preload (REDESIGN §3.5 renderer isolation). `contextIsolation:true`,
 * `nodeIntegration:false`, `sandbox:true`.
 *
 * F2: the admin page (the TRUSTED management surface) needs the management
 * connection-key to authenticate its mutating admin calls, but the key must NEVER
 * be fetchable over HTTP — an untrusted agent only speaks HTTP over loopback, and
 * any HTTP disclosure would let it escalate. So the desktop shell delivers the key
 * OUT OF BAND: `main` read `~/.plexus/connection-key` and answers the
 * `plexus:connection-key` IPC channel; here we expose ONLY a narrow async getter on
 * the existing `plexusDesktop` bridge. We invoke through `ipcRenderer` but never
 * leak `ipcRenderer` itself to the page — contextIsolation + sandbox stay intact,
 * no node/fs/raw-IPC reaches the page globals.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("plexusDesktop", {
  isDesktop: true,
  platform: process.platform,
  /**
   * Resolve the management connection-key from the trusted main process (it read
   * the key file). Returns a Promise<string|null>; null when main has no key (the
   * page then falls back to a human-paste affordance). The page caches the result;
   * this channel is the ONLY path the key reaches the renderer — never over HTTP.
   */
  getConnectionKey: () => ipcRenderer.invoke("plexus:connection-key"),
});
