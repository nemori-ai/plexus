/**
 * Apple Calendar — `CalendarProvider` SELECTION (the OS-access seam's wiring).
 *
 * The single place that decides REAL vs FAKE:
 *   - FAKE when `process.env.PLEXUS_FAKE_APPLE === "1"` (tests + the hermetic e2e set
 *     this) — deterministic in-memory fixtures, NO macOS permission.
 *   - REAL otherwise — shells `osascript`/JXA (triggers macOS TCC on first live use).
 *
 * Both the lifecycle source (`manifest.ts`) and the per-session bridge resolve through
 * this helper, so live use and tests pick the same provider. A provider can also be
 * injected directly (source/bridge constructor) for focused unit tests, bypassing env.
 */

import type { CalendarProvider } from "./calendar-reader.ts";
import { FakeCalendarProvider } from "./provider-fake.ts";
import { RealCalendarProvider } from "./provider-real.ts";

/** The env var that selects the FAKE provider (tests + hermetic e2e). */
export const FAKE_APPLE_ENV = "PLEXUS_FAKE_APPLE" as const;

/** True iff the fake provider is selected via env (`PLEXUS_FAKE_APPLE=1`). */
export function fakeAppleSelected(): boolean {
  return process.env[FAKE_APPLE_ENV] === "1";
}

/**
 * Resolve the active `CalendarProvider`: fake when `PLEXUS_FAKE_APPLE=1`, else the real
 * osascript-backed provider. Read fresh each call so a test that toggles the env between
 * source instantiations gets the matching provider.
 */
export function resolveCalendarProvider(): CalendarProvider {
  return fakeAppleSelected() ? new FakeCalendarProvider() : new RealCalendarProvider();
}
