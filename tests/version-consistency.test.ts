/**
 * VERSION CONSISTENCY — one product version, stated everywhere identically.
 *
 * The release process bumps the version in SEVEN places (the root package.json,
 * the five workspace package.jsons, and `PLEXUS_VERSION` in the runtime config).
 * A missed spot ships an inconsistent release (the console banner, `gatewayInfo`,
 * and npm metadata disagree about what is running), and nothing else catches it —
 * so this roster does. When you bump the version, bump ALL of them.
 */

import { describe, it, expect } from "bun:test";
import { PLEXUS_VERSION } from "@plexus/runtime/config.ts";

import rootPkg from "../package.json";
import runtimePkg from "../packages/runtime/package.json";
import protocolPkg from "../packages/protocol/package.json";
import cliPkg from "../packages/cli/package.json";
import desktopPkg from "../packages/desktop/package.json";
import webAdminPkg from "../packages/web-admin/package.json";

const SPOTS: Record<string, string> = {
  "package.json (root)": rootPkg.version,
  "packages/runtime/package.json": runtimePkg.version,
  "packages/protocol/package.json": protocolPkg.version,
  "packages/cli/package.json": cliPkg.version,
  "packages/desktop/package.json": desktopPkg.version,
  "packages/web-admin/package.json": webAdminPkg.version,
  "packages/runtime/src/config.ts (PLEXUS_VERSION)": PLEXUS_VERSION,
};

describe("version consistency: every stated version is the same version", () => {
  it("all seven version spots agree", () => {
    const versions = new Set(Object.values(SPOTS));
    expect(
      versions.size,
      `version spots disagree:\n${Object.entries(SPOTS)
        .map(([k, v]) => `  ${k} = ${v}`)
        .join("\n")}`,
    ).toBe(1);
  });

  it("the version is a well-formed semver (with optional prerelease)", () => {
    expect(PLEXUS_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
