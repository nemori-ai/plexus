/**
 * Preload (REDESIGN §3.5 renderer isolation). `contextIsolation:true`,
 * `nodeIntegration:false`. For P2 we host the runtime's served `/admin` SPA,
 * which fetches its OWN connection-key over loopback — so the renderer needs
 * NOTHING injected here (the simpler of the two §3.5 options). This preload
 * exposes only a tiny, read-only marker so the SPA could optionally detect it is
 * running inside the desktop shell. No connection-key, no node, no fs reaches the
 * page globals.
 */

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("plexusDesktop", {
  isDesktop: true,
  platform: process.platform,
});
