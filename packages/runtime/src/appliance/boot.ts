/**
 * Plexus Capability-Appliance ENTRYPOINT (`bun run packages/runtime/src/appliance/boot.ts`).
 *
 * This is the manifest-driven boot wrapper the `docker/Dockerfile.appliance` image runs
 * INSTEAD of the stock `src/index.ts`. It is the ONLY appliance file that touches process
 * env / runtime state, and it does so through PUBLIC seams ONLY — it edits NO file owned by
 * another track (`config.ts`, `core/*`, `mesh/*`, `platform/*`, `sources/*` are untouched):
 *
 *   1. READ  the manifest path from the NEW env var `PLEXUS_APPLIANCE_MANIFEST`.
 *   2. PARSE + VALIDATE it (fail-closed: a malformed manifest aborts the boot loudly).
 *   3. TRANSLATE it into the env vars the stock gateway already reads, applied to
 *      `process.env` BEFORE `loadConfig()` (so the curated workspace dir / proxy upstream
 *      flow through the existing, unmodified config path).
 *   4. BOOT through the same supervised `startRuntime` seam the stock image uses.
 *   5. ENFORCE DEFAULT-DENY as a STANDING policy: install a per-id default-exposure
 *      resolver (the public `ExposureStore.setDefaultResolver` seam mesh zero-exposure
 *      uses) so EVERY capability id whose `{source,id}` the manifest does not name
 *      defaults HIDDEN — now AND for any cap that enters the registry later (a scan
 *      finishing after the bounded boot window, an agent `POST /extensions`, an MCP
 *      `list_changed` re-aggregate). `.well-known` (which filters by `exposure.isDisabled`)
 *      and the invoke pipeline (which vetoes a disabled id even on the mesh tunnel path)
 *      therefore advertise + accept ONLY the curated caps, with NO snapshot race.
 *
 * Defense in depth: the Linux portable registry gate (P3-1, `{workspace, sysinfo}`) +
 * the absence of a `claude` binary in the minimal image + this exposure default-deny mean
 * a non-curated capability is, in order, (a) often not even scanned, and (b) if scanned,
 * not exposed. The deeper registry-level gate (never instantiate a non-curated source) is a
 * documented follow-up — see `docs/design/capability-appliance.md`.
 */

import { readFileSync } from "node:fs";
import { loadConfig, baseUrl } from "../config.ts";
import { startRuntime, installSignalHandlers } from "../runtime/serve.ts";
import {
  APPLIANCE_MANIFEST_ENV,
  parseApplianceManifest,
  manifestToEnv,
  isCapabilityExposed,
  type ApplianceManifest,
} from "./manifest.ts";

/** Load + validate the manifest the operator mounted; fail-closed with an actionable error. */
function loadManifestOrExit(): ApplianceManifest {
  const path = process.env[APPLIANCE_MANIFEST_ENV]?.trim();
  if (!path) {
    console.error(
      `[plexus-appliance] ${APPLIANCE_MANIFEST_ENV} is required — point it at the mounted manifest, ` +
        `e.g. -e ${APPLIANCE_MANIFEST_ENV}=/etc/plexus/appliance.json`,
    );
    process.exit(2);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    console.error(`[plexus-appliance] cannot read manifest at ${path}: ${(e as Error).message}`);
    process.exit(2);
  }
  try {
    return parseApplianceManifest(raw);
  } catch (e) {
    console.error(`[plexus-appliance] ${(e as Error).message}`);
    process.exit(2);
  }
}

const manifest = loadManifestOrExit();

// Translate the curated manifest into the STOCK env contract BEFORE loadConfig() reads it.
// (Manifest is authoritative for the appliance — it overwrites any inherited env so the
// declared curation is what boots.)
const translated = manifestToEnv(manifest);
for (const [k, v] of Object.entries(translated)) process.env[k] = v;

// Warn (don't silently drop) about a non-workspace `path` we don't map yet (follow-up).
for (const s of manifest.sources) {
  if (s.path && s.source !== "workspace") {
    console.warn(
      `[plexus-appliance] source "${s.source}" declares path=${s.path} but only "workspace" maps to a ` +
        `confined dir today; ignoring (see capability-appliance.md follow-ups).`,
    );
  }
}

const config = loadConfig();
const runtime = await startRuntime(config);

// ── DEFAULT-DENY ENFORCEMENT — a STANDING resolver, NOT a one-shot snapshot ─────
// SECURITY (critical): curation must be a STANDING intersection, not a boot-time
// enumerate-and-disable. The exposure store DEFAULTS TO ENABLED for local sources
// (core/exposure.ts), so any capability that enters the registry AFTER a one-shot scan
// — a boot scan finishing after the bounded window (core/state.ts BOOT_SCAN_TIMEOUT_MS),
// an agent-driven `POST /extensions`, an MCP `list_changed` / managed-source re-aggregate —
// would otherwise be exposed+invokable, bypassing the manifest allowlist. We close that by
// installing a per-id DEFAULT-EXPOSURE resolver on the public seam (the same hook mesh
// zero-exposure uses, core/state.ts): every id whose `{source,id}` is NOT named by the
// manifest defaults HIDDEN — forever, no matter WHEN the cap appears. `isCapabilityExposed`
// is the allowlist; the resolver makes it the standing default. This is the load-bearing fix.
//
// It SUPERSEDES the mesh resolver wired at state construction, which is safe — and in fact
// strictly stronger: a mesh-mounted address (source `mesh:<workload>`) is never named by an
// appliance manifest, so it too resolves HIDDEN (mesh zero-exposure is preserved, not lost).
runtime.state.exposure.setDefaultResolver((id) => {
  const entry = runtime.state.capabilities.get(id);
  // Fail-closed: an id we cannot attribute to a curated `{source,id}` defaults HIDDEN.
  if (!entry) return "hidden";
  return isCapabilityExposed(manifest, { source: entry.source, id: entry.id }) ? undefined : "hidden";
});

// Classify the already-present caps for the operator-facing boot log. The resolver above
// (not this loop) is what enforces the deny — including for caps that appear later.
const denied: string[] = [];
const exposed: string[] = [];
for (const entry of runtime.state.capabilities.all()) {
  if (isCapabilityExposed(manifest, { source: entry.source, id: entry.id })) {
    exposed.push(entry.id);
  } else {
    denied.push(entry.id);
  }
}

const url = baseUrl({ ...config, port: runtime.info.port });
console.log(`[plexus-appliance] gateway listening on ${url} (manifest-curated)`);
console.log(`[plexus-appliance] discovery: ${url}/.well-known/plexus`);
console.log(
  `[plexus-appliance] curated sources: ${[...new Set(manifest.sources.map((s) => s.source))].join(", ")}`,
);
console.log(`[plexus-appliance] exposed capabilities (${exposed.length}): ${exposed.join(", ") || "(none yet)"}`);
if (denied.length > 0) {
  console.log(`[plexus-appliance] default-denied capabilities (${denied.length}): ${denied.join(", ")}`);
}

installSignalHandlers(runtime);
