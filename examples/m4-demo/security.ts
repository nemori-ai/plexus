/**
 * m4-demo — SECURITY spot-check.
 *
 * Proves, against the meta-skill's ACTUAL generator + validator, the secure-default
 * discipline the EXTENSION-SPEC mandates — the same floors the gateway hard-enforces
 * at dispatch (transport-policy):
 *
 *   • a cli scaffold naming a SHELL interpreter / absolute path is REFUSED by the
 *     generator (it never emits an over-privileged cli bin) — a cli/non-loopback
 *     scaffold cannot be authored past the secure default without explicit, surfaced
 *     human approval at register-confirm.
 *   • a non-loopback rest host is REFUSED by the generator (loopback-only egress).
 *   • a well-formed read-only local-rest scaffold passes validation (the honest path
 *     the headline loop drives) — the secure default is permissive ONLY for the safe
 *     shape.
 *
 * (The "un-approved register stays inert" half of the spot-check is proven inside the
 * headline loop: an agent's POST /extensions PENDS and does not self-activate.)
 */

import {
  generateManifest,
  validateExtension,
  type CapabilitySpec,
} from "../../plugins/plexus-ext/lib/generate.ts";
import { check, type CheckResult } from "./report.ts";

export interface SecuritySpotCheck {
  pass: boolean;
  checks: CheckResult[];
}

export function runSecuritySpotCheck(): SecuritySpotCheck {
  const checks: CheckResult[] = [];

  // 1. A cli scaffold naming a shell interpreter is REFUSED by construction.
  const cliShellSpec: CapabilitySpec = {
    sourceName: "danger-cli",
    label: "Danger CLI",
    transport: "cli",
    actions: [
      {
        name: "shell.run",
        label: "Run a shell",
        describe: "Run a shell command.",
        grants: ["execute"],
        cli: { bin: "bash" }, // a shell interpreter — must be refused
      },
    ],
  };
  let cliRefused = false;
  let cliReason = "";
  try {
    generateManifest(cliShellSpec);
  } catch (e) {
    cliRefused = true;
    cliReason = (e as Error).message;
  }
  checks.push(
    check(
      cliRefused && cliReason.toLowerCase().includes("shell"),
      "generator REFUSES an over-privileged cli bin (a shell interpreter) — a cli scaffold needs explicit approval",
      cliReason.slice(0, 80),
    ),
  );

  // 2. A non-loopback rest host is REFUSED by construction (loopback-only egress).
  const nonLoopbackSpec: CapabilitySpec = {
    sourceName: "exfil-rest",
    label: "Exfil REST",
    transport: "local-rest",
    actions: [
      {
        name: "data.read",
        label: "Read remote",
        describe: "Read from a remote host.",
        grants: ["read"],
        rest: { method: "GET", pathTemplate: "http://169.254.169.254/latest/meta-data" },
      },
    ],
  };
  let restRefused = false;
  let restReason = "";
  try {
    generateManifest(nonLoopbackSpec);
  } catch (e) {
    restRefused = true;
    restReason = (e as Error).message;
  }
  checks.push(
    check(
      restRefused && restReason.toLowerCase().includes("loopback"),
      "generator REFUSES a non-loopback rest host (loopback-only egress secure default)",
      restReason.slice(0, 80),
    ),
  );

  // 3. The safe read-only local-rest shape DOES pass validation (the honest path).
  const safeSpec: CapabilitySpec = {
    sourceName: "safe-facts",
    label: "Safe Facts",
    transport: "local-rest",
    actions: [
      {
        name: "facts.read",
        label: "Read a fact",
        describe: "Read a local fact. Read-only.",
        grants: ["read"],
        rest: { method: "GET", pathTemplate: "/facts/{topic}" },
      },
    ],
  };
  const safe = validateExtension(generateManifest(safeSpec));
  checks.push(
    check(
      safe.ok,
      "the SAFE read-only local-rest scaffold passes validation (secure default permits only the safe shape)",
      `errors=${safe.errors.join("; ") || "none"}`,
    ),
  );

  return { pass: checks.every((c) => c.ok), checks };
}
