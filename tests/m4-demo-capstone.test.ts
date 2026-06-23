/**
 * m4-demo (CAPSTONE) — the end-to-end extension-authoring proof.
 *
 * Asserts the HEADLINE LOOP honest-green: the meta-skill's ACTUAL generator scaffolds
 * a read-only local-rest capability whose backend is a REAL loopback service, the
 * manifest is POSTed over the wire (PENDS), a modeled human approves, and a real agent
 * (PlexusClient) discovers + invokes it — receiving REAL backend data. The decisive
 * assertion: the agent's returned value EQUALS the loopback backend's OWN record (the
 * value proves it came back through the real pend→approve→invoke pipeline, not a
 * trusted ok). Also asserts the secure-default refusals + the inert un-approved register.
 *
 * Driven IN-PROCESS via app.request (no socket) for test determinism.
 */

import { describe, it, expect } from "bun:test";

import {
  runHeadline,
  factsLookupSpec,
  FACTS_SOURCE,
  FACTS_READ_ID,
  FACTS_SKILL_ID,
} from "../examples/m4-demo/headline.ts";
import { runSecuritySpotCheck } from "../examples/m4-demo/security.ts";
import { silentLogger } from "../examples/m4-demo/report.ts";
import {
  generateManifest,
  validateExtension,
} from "../plugins/plexus-ext/lib/generate.ts";

describe("m4-demo CAPSTONE — meta-skill scaffold → register → agent uses it (REAL data)", () => {
  it("the agent receives REAL backend data through the full pend→approve→invoke loop", async () => {
    const report = await runHeadline({ logger: silentLogger(), inProcess: true });

    // Every headline check is green.
    for (const c of report.checks) {
      expect(c.ok, `${c.label}${c.detail ? ` — ${c.detail}` : ""}`).toBe(true);
    }
    expect(report.pass).toBe(true);

    // THE HEADLINE PROOF: the agent's value is REAL (non-empty) and EQUALS the
    // loopback backend's own record — proven data, not a trusted ok.
    expect(typeof report.agentValue).toBe("string");
    expect((report.agentValue ?? "").length).toBeGreaterThan(0);
    expect(report.agentValue).toBe(report.backendValue);
    expect(report.agentValue).toContain("local capability gateway");
  });

  it("the manifest is GENERATOR-authored (real meta-skill generator) and spec-compliant", () => {
    // Generate straight from the interview spec — no hand-written manifest.
    const generated = generateManifest(factsLookupSpec(41999));
    expect(generated.source).toBe(FACTS_SOURCE);
    expect(validateExtension(generated).ok).toBe(true);

    // The generator emitted the read-only capability + a bundled usage skill.
    const cap = generated.capabilities.find((c) => c.name === "facts.read");
    expect(cap?.kind).toBe("capability");
    expect(cap?.grants).toEqual(["read"]);
    const skill = generated.capabilities.find((c) => c.kind === "skill");
    expect(skill?.name).toBe("facts.read.how-to-use");
    expect(skill?.body?.markdown ?? "").toContain("How to use");

    // The generator emits the EXTENSION-SPEC §6 published field `pathTemplate` (NOT the
    // legacy `path`) — and there is NO field-name bridge anymore. We register verbatim.
    const genRoute = cap?.route as Record<string, unknown>;
    expect(genRoute?.pathTemplate).toBe("/facts/{topic}");
    expect(genRoute?.path).toBeUndefined();

    // ZERO demo-side bridging (m4fix2): the generator publishes the service-discovery info
    // as a MANIFEST-LEVEL serviceHint; the route itself carries NO app/defaultPort. The
    // gateway materializer is what propagates the serviceHint onto the route at register
    // time, so the manifest is registered 100% verbatim.
    expect(genRoute?.app).toBeUndefined();
    expect(genRoute?.defaultPort).toBeUndefined();
    expect(generated.serviceHint?.app).toBe(FACTS_SOURCE);
    expect(generated.serviceHint?.defaultPort).toBe(41999);
    // Derived ids match the constants.
    expect(`${generated.source}.${cap?.name}`).toBe(FACTS_READ_ID);
    expect(`${generated.source}.${skill?.name}`).toBe(FACTS_SKILL_ID);
  });

  it("SECURITY — the generator refuses over-privileged cli bins + non-loopback hosts", () => {
    const sec = runSecuritySpotCheck();
    for (const c of sec.checks) {
      expect(c.ok, `${c.label}${c.detail ? ` — ${c.detail}` : ""}`).toBe(true);
    }
    expect(sec.pass).toBe(true);
  });
});
