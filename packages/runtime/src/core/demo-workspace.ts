/**
 * Demo workspace — the ONBOARDING DIRECTORY STORY (P1b).
 *
 * One call materializes a small demo directory and exposes it as TWO managed
 * `workspace-dir` sources with OPPOSITE approval postures:
 *
 *   <root>/plexus-intro/  → source `demo-intro`  (approval:auto — reads flow)
 *   <root>/your-secret/   → source `your-secret` (approval:"ask" — EVERY verb pends)
 *
 * The point is to let a brand-new user FEEL the trust loop in five minutes:
 * their agent reads the intro folder freely (and can introduce Plexus from it),
 * then hits the protected folder and PENDS — the user approves or denies right
 * inside onboarding, and either outcome is the lesson (deny ⇒ the agent gets an
 * explicit DENIED; approve ⇒ the obviously-fake secret comes back).
 *
 * IDEMPOTENT by construction:
 *   - files are written ONLY when absent (a user's edits are never overwritten);
 *   - sources are registered ONLY when their id is not already configured
 *     (re-running never re-registers, never flips a user's changed posture).
 *
 * Pure over its deps (the ManagedSources seam + a root path) so tests drive it
 * against a temp root + temp PLEXUS_HOME with zero real-home leakage. The admin
 * endpoint (`POST /admin/api/demo-workspace`) is a thin wrapper.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CapabilityId } from "@plexus/protocol";
import type { ManagedSources } from "../sources/config/manage.ts";
import type { ConfiguredSource } from "../sources/config/types.ts";
import { WORKSPACE_DIR_KIND } from "../sources/workspace/open-dir.ts";

/** The two demo source ids (also the folder names' registry identities). */
export const DEMO_INTRO_SOURCE_ID = "demo-intro" as const;
export const DEMO_SECRET_SOURCE_ID = "your-secret" as const;

/** The folder names under the demo root. */
export const DEMO_INTRO_DIR = "plexus-intro" as const;
export const DEMO_SECRET_DIR = "your-secret" as const;

/** The obviously-fake secret the approval demo guards. */
export const DEMO_FAKE_SECRET = "demo-secret: tangerine-42 🍊" as const;

/** Default materialization root (the UI path; tests always pass an explicit tmp root). */
export function defaultDemoRoot(): string {
  return join(homedir(), "PlexusDemo");
}

/**
 * The demo content, keyed by root-relative path. Written in the docs-site voice —
 * short enough to skim, substantial enough that an agent reading the intro folder
 * can give the user a real introduction to Plexus (that IS the first act).
 */
export const DEMO_FILES: Record<string, string> = {
  [`${DEMO_INTRO_DIR}/welcome.md`]: `# Welcome to Plexus

You are reading this through Plexus — which means the loop already works.

Plexus is a local capability gateway. It takes things that live on this machine —
notes, folders, calendars, local tools — and packages each one as a **capability**
an AI agent can call: a small, described, schema'd operation like
\`demo-intro.read\` or \`your-secret.read\`.

Three ideas carry everything:

1. **Default deny.** Discovering a capability grants nothing. Every call needs a
   grant, and grants come from the owner — never from the agent itself.
2. **The owner decides — with context.** When an agent needs something risky, the
   request *pends*: the owner sees who is asking, for what, and why, then approves
   with a **trust window** (once, an hour, a day…) or denies. That single decision
   is the whole authorization ceremony.
3. **Everything lands in the audit.** Handshake, grant, call, denial, revoke —
   an append-only trail the owner can read back at any time.

If an agent asked you to summarize this folder: tell your human what Plexus is,
in your own words, using the three ideas above. Then read \`the-trust-loop.md\`
for how a request actually flows.
`,

  [`${DEMO_INTRO_DIR}/the-trust-loop.md`]: `# The trust loop

Every Plexus call walks the same loop:

**discover → request → decide → call → audit**

- **Discover.** The agent lists what exists (\`plexus list\`). Seeing a capability
  costs nothing and grants nothing.
- **Request.** The agent asks for a grant on one capability. Low-risk reads on
  sources the owner already vetted flow straight through. Anything else — writes,
  executes, extension-sourced capabilities, or a source the owner marked
  **Protected** — *pends* for a human decision.
- **Decide.** The owner approves with a trust window, or denies. A window bounds
  the blast radius in time: \`once\` is single-use; \`1h\`/\`1d\`/\`7d\` create a standing
  grant that expires on its own. Deny is a first-class outcome — the agent gets an
  explicit DENIED, not a silent hang.
- **Call.** With a grant, the agent invokes and gets real data. Without one, the
  gateway answers with a clean, machine-readable refusal.
- **Audit.** Every step above is already in the owner's activity trail by the time
  you read this sentence.

And when trust ends, **revoke is the complete stop**: standing grants die, live
tokens die with them, and re-acquiring requires a fresh human decision.

Right next to this folder sits \`your-secret/\` — the same kind of folder, but
marked Protected. Reading it will pend. That is not a bug; that is the product.
`,

  [`${DEMO_INTRO_DIR}/what-you-can-do.md`]: `# What you can do next

This demo folder is the small version of everything Plexus does:

- **Expose your real things.** An Obsidian vault, any folder on disk, Apple
  Calendar and Reminders, local tools — each becomes a source whose capabilities
  agents can request. You choose per source whether reads flow (\`auto\`) or
  everything asks first (**Protected**, \`ask\`).
- **Connect more agents.** Each agent enrolls with its own credential and gets its
  own grants — different agents, different scenarios, different capability sets,
  each independently revocable.
- **Watch the ledger.** The admin console shows who holds what ("Who I trust"),
  what is exposed ("What I expose"), what is waiting on you (Approvals), and
  everything that ever happened (Activity).

Try the second act now: ask your agent to read \`secret.md\` from the protected
folder (\`your-secret.read\`). Watch it pend, then decide — approve with a window,
or deny and watch the agent receive an explicit DENIED. Either way, you have now
operated the trust loop yourself.
`,

  [`${DEMO_SECRET_DIR}/secret.md`]: `# The protected note

${DEMO_FAKE_SECRET}

This is a fake secret for the approval demo — nothing real is guarded here. The
point is what just happened on the way in: this folder is marked **Protected**
(approval: ask), so your agent could not read it until you, the owner, approved
that exact request. If you denied it instead, the agent received an explicit
DENIED — which is the other half of the same lesson.
`,
};

/** Result of one demo-workspace setup call (the endpoint's response body). */
export interface DemoWorkspaceResult {
  ok: boolean;
  /** The materialized demo root (absolute). */
  root: string;
  /** Root-relative files written THIS call (existing files are never overwritten). */
  createdFiles: string[];
  /** The two demo sources (whether registered now or already configured). */
  sources: {
    id: string;
    path: string;
    approval: "auto" | "ask";
    capabilities: CapabilityId[];
    /** True when the id was already configured (this call changed nothing about it). */
    alreadyConfigured: boolean;
  }[];
  reason?: string;
}

/** Materialize the demo files under `root`, writing ONLY what is absent. */
export function materializeDemoFiles(root: string): { createdFiles: string[] } {
  const createdFiles: string[] = [];
  mkdirSync(join(root, DEMO_INTRO_DIR), { recursive: true });
  mkdirSync(join(root, DEMO_SECRET_DIR), { recursive: true });
  for (const [rel, content] of Object.entries(DEMO_FILES)) {
    const abs = join(root, rel);
    if (existsSync(abs)) continue; // never overwrite a user's edits — idempotent.
    writeFileSync(abs, content, "utf-8");
    createdFiles.push(rel);
  }
  return { createdFiles };
}

/** The capability ids a workspace-dir source id derives to (id-derivation rule). */
function demoCapabilityIds(sourceId: string): CapabilityId[] {
  return ["list", "read", "write", "how-to-use"].map((v) => `${sourceId}.${v}` as CapabilityId);
}

/**
 * Materialize the demo directory AND ensure the two managed sources exist.
 * Registration is add-if-absent: an id already in the config is reported
 * `alreadyConfigured:true` and left EXACTLY as the user has it (enabled state,
 * posture, path — nothing is touched). The whole call is safe to repeat.
 */
export async function setupDemoWorkspace(
  managed: ManagedSources,
  root: string = defaultDemoRoot(),
): Promise<DemoWorkspaceResult> {
  const { createdFiles } = materializeDemoFiles(root);

  const wanted: { cfg: ConfiguredSource; approval: "auto" | "ask" }[] = [
    {
      approval: "auto",
      cfg: {
        id: DEMO_INTRO_SOURCE_ID,
        kind: WORKSPACE_DIR_KIND,
        label: "Plexus intro (demo)",
        enabled: true,
        transport: "ipc",
        route: { path: join(root, DEMO_INTRO_DIR) },
      },
    },
    {
      approval: "ask",
      cfg: {
        id: DEMO_SECRET_SOURCE_ID,
        kind: WORKSPACE_DIR_KIND,
        label: "Your secret (demo, protected)",
        enabled: true,
        transport: "ipc",
        route: { path: join(root, DEMO_SECRET_DIR) },
        approval: "ask",
      },
    },
  ];

  const existing = new Set(managed.list().map((s) => s.id));
  const sources: DemoWorkspaceResult["sources"] = [];
  const failures: string[] = [];

  for (const { cfg, approval } of wanted) {
    if (existing.has(cfg.id)) {
      // IDEMPOTENT: already configured ⇒ report as-is, change nothing (not even a
      // reconfigure — the user may have retuned posture/path deliberately).
      const current = managed.list().find((s) => s.id === cfg.id);
      sources.push({
        id: cfg.id,
        path: typeof current?.route?.path === "string" ? current.route.path : (cfg.route?.path as string),
        approval: (current?.approval ?? "auto") as "auto" | "ask",
        capabilities: demoCapabilityIds(cfg.id),
        alreadyConfigured: true,
      });
      continue;
    }
    // The admin endpoint is the trusted local human surface — approvedByHuman.
    const res = await managed.add(cfg, { approvedByHuman: true });
    if (!res.ok) {
      failures.push(`${cfg.id}: ${res.reason ?? "register failed"}`);
      continue;
    }
    sources.push({
      id: cfg.id,
      path: cfg.route?.path as string,
      approval,
      capabilities: res.registered.length ? res.registered : demoCapabilityIds(cfg.id),
      alreadyConfigured: false,
    });
  }

  return {
    ok: failures.length === 0,
    root,
    createdFiles,
    sources,
    ...(failures.length ? { reason: failures.join("; ") } : {}),
  };
}
