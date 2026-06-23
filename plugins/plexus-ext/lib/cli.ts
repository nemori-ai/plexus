#!/usr/bin/env bun
/**
 * plexus-ext CLI — the skill-invoked entrypoint.
 *
 * The `create-extension` skill drives this with Bash. Two subcommands:
 *
 *   bun lib/cli.ts generate <spec.json>     → writes the scaffold + prints a report
 *   bun lib/cli.ts validate <manifest.json> → validates a manifest, prints PASS/FAIL
 *
 * `generate` takes a `CapabilitySpec` JSON (the interview answers the skill
 * gathered) and emits, under `plexus-extensions/<source>/`:
 *   - manifest.json     (the spec-compliant ExtensionManifest)
 *   - skills/<n>.how-to-use.md  (the bundled usage-skill bodies)
 *   - register.sh       (a curl POST /extensions that reads sessionId from $PLEXUS_SESSION;
 *                        NEVER embeds a live token/connection-key)
 *   - README.md, secrets.README.md (if secrets)
 *
 * It REFUSES to write a scaffold whose manifest fails `validateExtension`.
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  generateManifest,
  validateExtension,
  type CapabilitySpec,
  type ExtensionManifest,
} from "./generate.ts";

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/** A register.sh that reads the sessionId from the environment — no secret on disk. */
export function registerScript(manifestRelPath: string): string {
  return `#!/usr/bin/env bash
# Register this Plexus extension via the running gateway.
#
# SECURITY: this script embeds NO connection-key and NO token. It reads a LIVE
# handshake sessionId from the environment ($PLEXUS_SESSION) and the gateway base
# URL from $PLEXUS_URL (default loopback). Obtain a sessionId by handshaking with a
# connection-key from the management client; never paste a key into this file.
#
# POST /extensions PENDS for a human to approve in the management client. cli bins /
# non-loopback rest hosts require explicit approval there.
set -euo pipefail
cd "$(dirname "$0")"

: "\${PLEXUS_URL:=http://127.0.0.1:7077}"
if [ -z "\${PLEXUS_SESSION:-}" ]; then
  echo "set PLEXUS_SESSION to a live handshake sessionId (from POST /link/handshake)" >&2
  exit 1
fi

MANIFEST="\$(cat ${manifestRelPath})"
curl -fsS -X POST "\${PLEXUS_URL}/extensions" \\
  -H "Content-Type: application/json" \\
  -H "Host: 127.0.0.1:\${PLEXUS_URL##*:}" \\
  --data "{\\"sessionId\\":\\"\${PLEXUS_SESSION}\\",\\"manifest\\":\${MANIFEST}}"
echo
echo "Submitted. Approve the registration in the Plexus management client."
`;
}

export function readmeFor(manifest: ExtensionManifest): string {
  const lines: string[] = [];
  lines.push(`# Plexus extension: ${manifest.label} (\`${manifest.source}\`)`);
  lines.push("");
  lines.push(`Transport: \`${manifest.transport}\`. Registered via \`POST /extensions\` (PENDS for human approval).`);
  lines.push("");
  lines.push("## Capabilities");
  for (const d of manifest.capabilities) {
    const id = `${manifest.source}.${d.name}`;
    const cost = d.kind === "skill" ? "no grant (read-as-context)" : `grant cost: ${d.grants.join(", ") || "none"}`;
    lines.push(`- \`${id}\` (${d.kind}) — ${cost}`);
  }
  lines.push("");
  lines.push("## Registering");
  lines.push("1. Start the Plexus gateway.");
  lines.push("2. Handshake with a connection-key from the management client to get a `sessionId`.");
  lines.push("3. `PLEXUS_SESSION=<sessionId> ./register.sh`");
  lines.push("4. Approve the pending registration in the management client (cli bins / non-loopback hosts require explicit approval).");
  if (manifest.secrets?.length) {
    lines.push("");
    lines.push("## Secrets");
    lines.push("This extension needs secret values provisioned out of band — see `secrets.README.md`. No values are stored here.");
  }
  return lines.join("\n") + "\n";
}

export function secretsReadme(manifest: ExtensionManifest): string {
  const lines = [`# Secret provisioning for \`${manifest.source}\``, ""];
  lines.push("Provision these secret VALUES into `~/.plexus/secrets/` (OS keychain where available).");
  lines.push("The manifest carries only the REFERENCE; no value is ever written here.");
  lines.push("");
  for (const s of manifest.secrets ?? []) {
    lines.push(`- \`${s.name}\` — attached as \`${s.attach}\`${s.as ? ` (key: \`${s.as}\`)` : ""}.`);
  }
  return lines.join("\n") + "\n";
}

function cmdGenerate(specPath: string, outRoot: string): void {
  let spec: CapabilitySpec;
  try {
    spec = JSON.parse(readFileSync(specPath, "utf8")) as CapabilitySpec;
  } catch (e) {
    die(`cannot read spec ${specPath}: ${(e as Error).message}`);
  }

  let manifest: ExtensionManifest;
  try {
    manifest = generateManifest(spec);
  } catch (e) {
    die(`generation refused: ${(e as Error).message}`);
  }

  const v = validateExtension(manifest);
  if (!v.ok) {
    console.error("VALIDATION FAILED — not writing scaffold:");
    for (const err of v.errors) console.error(`  - ${err}`);
    process.exit(1);
  }

  const dir = join(outRoot, "plexus-extensions", manifest.source);
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const d of manifest.capabilities) {
    if (d.kind === "skill" && d.body?.markdown) {
      writeFileSync(join(dir, "skills", `${d.name}.md`), d.body.markdown);
    }
  }
  writeFileSync(join(dir, "register.sh"), registerScript("manifest.json"), { mode: 0o755 });
  writeFileSync(join(dir, "README.md"), readmeFor(manifest));
  if (manifest.secrets?.length) {
    writeFileSync(join(dir, "secrets.README.md"), secretsReadme(manifest));
  }

  console.log(`PASS — scaffold written to ${dir}`);
  console.log(`  manifest.json (${manifest.capabilities.length} entries), register.sh, README.md`);
  for (const w of v.warnings) console.log(`  warning: ${w}`);
}

function cmdValidate(manifestPath: string): void {
  let manifest: ExtensionManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExtensionManifest;
  } catch (e) {
    die(`cannot read manifest ${manifestPath}: ${(e as Error).message}`);
  }
  const v = validateExtension(manifest);
  if (v.ok) {
    console.log("PASS — manifest is spec-compliant (will pass the gateway validateRegistration)");
    for (const w of v.warnings) console.log(`  warning: ${w}`);
    process.exit(0);
  }
  console.error("FAIL — manifest is not spec-compliant:");
  for (const err of v.errors) console.error(`  - ${err}`);
  process.exit(1);
}

function main(): void {
  const [, , sub, arg, ...rest] = process.argv;
  if (sub === "generate") {
    if (!arg) die("usage: cli.ts generate <spec.json> [outDir]");
    cmdGenerate(arg, rest[0] ?? process.cwd());
  } else if (sub === "validate") {
    if (!arg) die("usage: cli.ts validate <manifest.json>");
    cmdValidate(arg);
  } else {
    die("usage: cli.ts <generate|validate> <file>");
  }
}

// Run main() ONLY when executed directly (bun lib/cli.ts …), never when imported
// (the tests + skill import the helpers as a library). `import.meta.main` is true
// only for the entry module.
if (import.meta.main) {
  main();
}
