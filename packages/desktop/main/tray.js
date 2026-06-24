/**
 * ============================================================================
 * Tray (UX §1.1) — resident heartbeat + pending badge + panic switch
 * ============================================================================
 *
 * Icon state: running / paused / error. Menu:
 *   - status line ("● Running" / "◌ Paused" / "⚠ Error")
 *   - "N approvals waiting" (only when >0) → opens the admin/Review window
 *   - Open Dashboard / Open Admin
 *   - Pause Plexus (stop the runtime = deny-all panic switch) / Resume
 *   - Recent submenu (last audit pulses)
 *   - Quit
 *
 * GUI code (depends on Electron). The pure label/state computation lives in the
 * helpers; this file is the thin Electron binding.
 *
 * P6: replaced the P2 empty-image + glyph-title hack with a REAL macOS template
 * tray icon (`assets/trayTemplate.png` / `@2x`). Naming it `…Template.png` +
 * `setTemplateImage(true)` makes macOS auto-invert it for dark/light menubars, so
 * the menubar item is a visible diamond glyph image, not just text. We KEEP a
 * short title for the pending-count badge (macOS trays can't render a numeric
 * badge on the image itself), but it now rides next to a real icon.
 */

import { Tray, Menu, nativeImage } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, "..", "assets");

/**
 * Load the template tray icon as a macOS template image (auto dark/light invert).
 * Falls back to an empty image if the asset is missing, so tray creation never
 * throws (the smoke run + any asset-less checkout still gets a clickable tray).
 * @returns {import('electron').NativeImage}
 */
function loadTrayImage() {
  const p = join(ASSETS, "trayTemplate.png"); // Electron auto-picks @2x for retina
  if (!existsSync(p)) return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(p);
  if (img.isEmpty()) return nativeImage.createEmpty();
  img.setTemplateImage(true); // monochrome → macOS inverts for the menubar theme
  return img;
}

export class PlexusTray {
  /**
   * @param {{
   *   onOpenAdmin: () => void,
   *   onOpenDashboard: () => void,
   *   onTogglePause: () => void,
   *   onQuit: () => void,
   * }} handlers
   */
  constructor(handlers) {
    this.handlers = handlers;
    /** @type {'running'|'paused'|'error'} */
    this.state = "running";
    this.badge = 0;
    /** @type {Array<{label:string, at:string}>} */
    this.recent = [];
    // Real macOS template tray icon (P6) — a diamond glyph that auto-inverts for
    // the menubar theme; falls back to empty if the asset is missing.
    this.tray = new Tray(loadTrayImage());
    this.tray.setToolTip("Plexus");
    this.render();
  }

  /** @param {'running'|'paused'|'error'} state */
  setState(state) {
    this.state = state;
    this.render();
  }

  /** @param {number} count */
  setBadge(count) {
    this.badge = count;
    this.render();
  }

  /** @param {{label:string, at:string}} item */
  pushRecent(item) {
    this.recent.unshift(item);
    this.recent = this.recent.slice(0, 3);
    this.render();
  }

  statusLine() {
    if (this.state === "error") return "⚠ Runtime error";
    if (this.state === "paused") return "◌ Paused";
    return "● Running";
  }

  render() {
    // Never touch a destroyed Tray — setContextMenu/setTitle throw "Tray is destroyed"
    // and crash the whole main process. This races on shutdown: the sidecar's exit event
    // fires a state change (-> setState -> render) after the tray was destroyed on quit.
    if (this.tray.isDestroyed()) return;
    const template = [];
    template.push({ label: this.statusLine(), enabled: false });
    if (this.badge > 0) {
      template.push({
        label: `${this.badge} approval${this.badge === 1 ? "" : "s"} waiting`,
        click: () => this.handlers.onOpenAdmin(),
      });
    }
    template.push({ type: "separator" });
    template.push({ label: "Open Dashboard", click: () => this.handlers.onOpenDashboard() });
    template.push({ label: "Open Admin…", click: () => this.handlers.onOpenAdmin() });
    template.push({ type: "separator" });
    if (this.recent.length) {
      template.push({
        label: "Recent",
        submenu: this.recent.map((r) => ({ label: `${r.label}  ${r.at}`, enabled: false })),
      });
      template.push({ type: "separator" });
    }
    template.push({
      label: this.state === "paused" ? "Resume Plexus" : "Pause Plexus (deny all)",
      click: () => this.handlers.onTogglePause(),
    });
    template.push({ type: "separator" });
    template.push({ label: "Quit Plexus", click: () => this.handlers.onQuit() });

    const menu = Menu.buildFromTemplate(template);
    this.tray.setContextMenu(menu);
    // P6: the icon is now a REAL template image, so the menubar item is visibly a
    // diamond glyph on its own. The title is reserved for the pending-count badge
    // (a count macOS can't paint onto the image) + an error/pause marker. Empty
    // when running with zero pending — just the clean icon.
    if (typeof this.tray.setTitle === "function") {
      let title = "";
      if (this.badge > 0) title = `${this.badge}`;
      if (this.state === "error") title = title ? `! ${title}` : "!";
      else if (this.state === "paused") title = title ? `❙❙ ${title}` : "❙❙";
      this.tray.setTitle(title);
    }
  }

  destroy() {
    try {
      this.tray.destroy();
    } catch {
      /* noop */
    }
  }
}
