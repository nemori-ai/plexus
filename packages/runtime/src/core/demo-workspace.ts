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

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CapabilityId } from "@plexus/protocol";
import { ensureDir, atomicWrite } from "./paths.ts";
import type { ManagedSources } from "../sources/config/manage.ts";
import type { ConfiguredSource } from "../sources/config/types.ts";
import { WORKSPACE_DIR_KIND, normalizeWorkspaceDirRoot } from "../sources/workspace/open-dir.ts";
import { workspaceEntries } from "../sources/workspace/entries.ts";

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

Plexus is a capability gateway running on its owner's machine. It takes things that live there —
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

/**
 * Materialize the demo files under `root`, writing ONLY what is absent — durably (each
 * file goes through `atomicWrite` = temp-write + rename, so a crash mid-write can never
 * freeze a half-written `welcome.md` under the "never overwrite" rule). `root` MUST be
 * pre-normalized (absolute); callers use `normalizeWorkspaceDirRoot`.
 */
export function materializeDemoFiles(root: string): { createdFiles: string[] } {
  const createdFiles: string[] = [];
  ensureDir(join(root, DEMO_INTRO_DIR));
  ensureDir(join(root, DEMO_SECRET_DIR));
  for (const [rel, content] of Object.entries(DEMO_FILES)) {
    const abs = join(root, rel);
    if (existsSync(abs)) continue; // never overwrite a user's edits — idempotent.
    atomicWrite(abs, content);
    createdFiles.push(rel);
  }
  return { createdFiles };
}

/**
 * The CAPABILITY ids a workspace-dir source id derives to — the actual `kind:"capability"`
 * entries only (list/read/write), NOT the how-to-use skill. Derived from the same
 * parameterized builder that materializes the entries (no hardcoded verb list).
 */
function demoCapabilityIds(sourceId: string): CapabilityId[] {
  return workspaceEntries(sourceId)
    .filter((e) => e.kind === "capability")
    .map((e) => e.id as CapabilityId);
}

/** Optional seams the endpoint threads in (kept optional so unit tests can omit them). */
export interface DemoWorkspaceDeps {
  /**
   * The capability ids CURRENTLY LIVE (registered) for a source — the endpoint passes
   * a reader over the capability registry so the `alreadyConfigured` branch reports the
   * REAL live ids (and can tell a disabled/failed source from a healthy one). Absent ⇒
   * fall back to the id-derived capability ids.
   */
  liveCapabilityIds?: (sourceId: string) => CapabilityId[];
}

/**
 * Materialize the demo directory AND ensure the two managed sources exist.
 * Registration is add-if-absent for a HEALTHY existing source (already configured +
 * enabled + live ⇒ reported as-is, its posture/path left exactly as the user has it).
 * An existing but DISABLED source is RE-ENABLED (re-registered) so onboarding's second
 * act can actually pend — otherwise the agent's `your-secret.read` would hit
 * `unknown_capability` and the onboarding spinner would never resolve. Safe to repeat.
 */
export async function setupDemoWorkspace(
  managed: ManagedSources,
  root: string = defaultDemoRoot(),
  deps: DemoWorkspaceDeps = {},
): Promise<DemoWorkspaceResult> {
  // NORMALIZE the root FIRST (expand ~, require absolute) so both the files we write and
  // the confinement roots we register agree, and a relative/`~` path can never land under
  // the process cwd or a literal `~` directory (P1).
  const absRoot = normalizeWorkspaceDirRoot(root);
  const { createdFiles } = materializeDemoFiles(absRoot);

  const wanted: { cfg: ConfiguredSource; approval: "auto" | "ask" }[] = [
    {
      approval: "auto",
      cfg: {
        id: DEMO_INTRO_SOURCE_ID,
        kind: WORKSPACE_DIR_KIND,
        label: "Plexus intro (demo)",
        enabled: true,
        transport: "ipc",
        route: { path: join(absRoot, DEMO_INTRO_DIR) },
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
        route: { path: join(absRoot, DEMO_SECRET_DIR) },
        approval: "ask",
      },
    },
  ];

  const sources: DemoWorkspaceResult["sources"] = [];
  const failures: string[] = [];

  /** The capability ids to report for a source: live if we can see them, else derived. */
  const capsFor = (sourceId: string): CapabilityId[] => {
    const live = deps.liveCapabilityIds?.(sourceId) ?? [];
    return live.length ? live : demoCapabilityIds(sourceId);
  };

  for (const { cfg, approval } of wanted) {
    const current = managed.list().find((s) => s.id === cfg.id);
    if (current) {
      const live = deps.liveCapabilityIds?.(cfg.id) ?? [];
      // An existing source that is DISABLED (or enabled-but-not-live) would report as
      // "ready" while its capabilities aren't callable — the agent then gets
      // unknown_capability and onboarding hangs. Re-enable it (re-register) so it is
      // actually usable, then report the real live ids.
      if (!current.enabled || live.length === 0) {
        const res = await managed.enable(cfg.id, { approvedByHuman: true });
        if (!res.ok) {
          failures.push(`${cfg.id}: could not re-enable (${res.reason ?? "register failed"})`);
          continue;
        }
      }
      sources.push({
        id: cfg.id,
        path: typeof current.route?.path === "string" ? current.route.path : (cfg.route?.path as string),
        // Report the user's ACTUAL posture (they may have retuned it deliberately).
        approval: (current.approval ?? "auto") as "auto" | "ask",
        capabilities: capsFor(cfg.id),
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
      capabilities: res.registered.length ? (res.registered as CapabilityId[]) : capsFor(cfg.id),
      alreadyConfigured: false,
    });
  }

  return {
    ok: failures.length === 0,
    root: absRoot,
    createdFiles,
    sources,
    ...(failures.length ? { reason: failures.join("; ") } : {}),
  };
}
