#!/usr/bin/env bun
/**
 * ============================================================================
 * build-compile.ts — compile the runtime to single-file native executables
 * (REDESIGN-ARCHITECTURE §5.1 — the Bun sidecar the Electron app spawns)
 * ============================================================================
 *
 * `bun build --compile` produces a standalone native executable that carries its
 * own Bun — NO Bun install is required on the user's machine. We emit one binary
 * per macOS arch so electron-builder can ship the right one as an extraResource:
 *
 *   dist/plexus-runtime-darwin-arm64   (Apple Silicon)
 *   dist/plexus-runtime-darwin-x64     (Intel)
 *
 * The exe boots through the SAME `src/index.ts` seam as `bun run` (ready line +
 * /v1/health + runtime.json), so the supervisor code is identical dev vs prod.
 *
 * Usage:
 *   bun run build:compile                 # both macOS arches (default)
 *   bun run build:compile -- --target=bun-darwin-arm64   # one arch
 *
 * NOTE on distribution: the compiled Bun exe is a native Mach-O binary; for real
 * macOS distribution it MUST be codesigned (Developer ID) and the app notarized,
 * otherwise Gatekeeper blocks the spawned child. See packages/desktop/BUILD.md.
 */

import { $ } from "bun";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(PKG_ROOT, "src", "index.ts");
const DIST = join(PKG_ROOT, "dist");

/** The macOS targets we ship. Each → one extraResource binary. */
const ALL_TARGETS = [
  { target: "bun-darwin-arm64", outfile: "plexus-runtime-darwin-arm64" },
  { target: "bun-darwin-x64", outfile: "plexus-runtime-darwin-x64" },
] as const;

function selectTargets() {
  const arg = process.argv.find((a) => a.startsWith("--target="));
  if (!arg) return ALL_TARGETS;
  const wanted = arg.slice("--target=".length);
  const hit = ALL_TARGETS.filter((t) => t.target === wanted);
  if (hit.length === 0) {
    throw new Error(
      `unknown --target=${wanted}; known: ${ALL_TARGETS.map((t) => t.target).join(", ")}`,
    );
  }
  return hit;
}

async function main() {
  await mkdir(DIST, { recursive: true });
  const targets = selectTargets();
  for (const { target, outfile } of targets) {
    const out = join(DIST, outfile);
    console.log(`[build-compile] ${target} → ${out}`);
    await $`bun build --compile --target=${target} ${ENTRY} --outfile ${out}`;
  }
  console.log(`[build-compile] done (${targets.length} target(s))`);
}

await main();
