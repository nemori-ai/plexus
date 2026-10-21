/**
 * Passive availability for macOS app integrations. Reading an application's scripting
 * properties launches it, even without an `activate` command. Lifecycle probes must
 * therefore inspect installation only; OS access belongs to an authorized invocation.
 */
import { existsSync } from "node:fs";
import type { SourceHealth } from "@plexus/protocol";

export interface AppleAvailability {
  ok: boolean;
  reason?: string;
  /** False when only installation was checked, so health must not claim access is OK. */
  accessChecked?: boolean;
}

type AppleApp = "Calendar" | "Reminders" | "Notes" | "Photos" | "Mail" | "Contacts" | "Shortcuts";

export function inspectAppleApp(
  app: AppleApp,
  options: { platform?: NodeJS.Platform; exists?: (path: string) => boolean } = {},
): AppleAvailability {
  if ((options.platform ?? process.platform) !== "darwin") {
    return { ok: false, reason: `${app} requires macOS.` };
  }
  const exists = options.exists ?? existsSync;
  const installed = app === "Shortcuts"
    ? exists("/usr/bin/shortcuts")
    : exists(`/System/Applications/${app}.app`) || exists(`/Applications/${app}.app`);
  if (!installed) return { ok: false, reason: `${app} is not installed on this Mac.` };
  return {
    ok: true,
    accessChecked: false,
    reason: `${app} access is checked when an enabled, authorized capability is invoked.`,
  };
}

export function appleAvailabilityHealth(availability: AppleAvailability): SourceHealth {
  if (!availability.ok) {
    return { status: "unavailable", ...(availability.reason ? { detail: availability.reason } : {}) };
  }
  if (availability.accessChecked === false) {
    return { status: "unknown", ...(availability.reason ? { detail: availability.reason } : {}) };
  }
  return { status: "ok" };
}
