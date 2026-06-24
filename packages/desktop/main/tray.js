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
 * helpers; this file is the thin Electron binding. The smoke run constructs it to
 * assert "(b) tray created" then quits, so creation must not require a real icon
 * file (we synthesize an empty nativeImage to stay asset-free in P2).
 */

import { Tray, Menu, nativeImage } from "electron";

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
    // Asset-free in P2: an empty template image still produces a clickable tray.
    const img = nativeImage.createEmpty();
    this.tray = new Tray(img);
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
    // The macOS tray title shows the badge count inline next to the icon.
    if (typeof this.tray.setTitle === "function") {
      this.tray.setTitle(this.badge > 0 ? ` ${this.badge}` : "");
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
