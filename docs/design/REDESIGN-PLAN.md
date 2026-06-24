# Plexus — Desktop + Runtime Redesign: SYNTHESIS / PLAN OF RECORD

> The unified plan, synthesizing the two design explorations:
> - `REDESIGN-ARCHITECTURE.md` — runtime/client separation, LRA contract, sidecar, cross-platform, distribution.
> - `REDESIGN-PRODUCT-UX.md` — desktop surfaces, admin IA redesign, onboarding, interactions.
> North star: `DESKTOP-RUNTIME-REDESIGN.md`. Authz model served: `AUTHZ-UX-MODEL.md`.
> Version posture: next release **≥ 0.5.1, non-rc, no rush.**

## Verdict (both docs agree)
**This is formalize + extend + reskin, NOT a rewrite.** The runtime is already a headless
loopback service: `Bun.serve` is the only Bun-specific code (2 sites); the web admin and the
`plexus` CLI are already clients of its HTTP API; the auth/authz substance (grants, constraints,
bundles, audit, sources) lives entirely in `GatewayState` and is untouched. The work is to
(a) carve the runtime into a package + stable entrypoint, (b) formalize the client API + add the
one missing piece (a management push stream), (c) build an Electron desktop client that supervises
the runtime and adds tray/notifications/dashboard, (d) redesign the admin IA, (e) finish the
cross-platform seam.

## Architecture (from REDESIGN-ARCHITECTURE.md)
- **Core runtime** = today's `src/**`, headless, cross-platform. Carved into `packages/runtime`
  with a single supervised `plexus serve` entrypoint (machine-readable ready line + `runtime.json`
  port file + a thin listen-adapter seam so `app.fetch` could run under node-server if ever needed).
- **LRA v1** (Local Runtime API) = the stable versioned local contract every client speaks: the
  union of today's agent wire (frozen 0.1.2) + management API (`/admin/api/*` promoted under `/v1`)
  + **a NEW management SSE push stream** `GET /v1/events` carrying `pending_added` /
  `pending_resolved` / `audit_appended` (+ thin `/v1/status`, `/v1/health`, `/v1/config`,
  `/v1/connection-key/rotate`). The push stream is THE key new runtime capability (today the UI must
  poll for pending approvals → wrong for a tray/notification).
- **Embedding** = the Electron **main** process spawns/supervises the runtime as a **Bun
  single-file-exe sidecar** (`bun build --compile`). Separation stays real; runtime untouched; crash
  isolation. Auth handoff: main reads `~/.plexus/connection-key` and injects it to the renderer via
  `contextBridge` (no paste; reuses the proven management-key gate; renderer isolated).
- **Clients** = `desktop` (Electron), `web-admin` (same React SPA, runtime-served fallback), `cli`
  (exists), future `tui` (server-side, same LRA + event stream). Shared `protocol` package = the
  compiler-enforced contract.
- **Cross-platform** = fill the two `PlatformServices` stubs (`win32`/`linux`); the seam is already
  isolated. Linux-first (server/TUI), then Windows (desktop). Parallelizable with the Electron work.
- **Distribution** = electron-builder bundles the per-OS runtime exe as an extraResource; one app,
  separation invisible; state stays in shared `~/.plexus`; same runtime ships standalone for servers.

## Product / UX (from REDESIGN-PRODUCT-UX.md)
- **Five surfaces over one runtime**: **Tray** (resident heartbeat + pending badge + Recent pulse +
  Pause panic switch) · **Notifications** (native; where Mode-1 approvals now live) · **Admin** (the
  depth) · **Dashboard** (the hub) · **Onboarding** (the arc, felt once).
- **Admin IA = a left sidebar whose order IS the mental-model arc**, in three bands:
  `Overview` · **WHAT I EXPOSE** (Sources, Capabilities) · **WHO I TRUST** (**Agents** ← the new
  spine, Approvals, Task Grants, Standing Grants) · **WHAT HAPPENED** (Activity). Every current tab
  remapped, nothing lost; **Tokens demoted** (plumbing); **Mode-1 → Notifications** (Approvals = the
  fallback/history list). The fix for "unclear logic": the bands teach the model by existing, and
  trust is seen **per-agent**.
- **Onboarding** = 4 guided-but-skippable steps: what-is-this → connect an agent (guided integration
  install OR key paste) → add a source (detect-led) → **witness one real call** + see its grant +
  its audit. The payoff makes the model click. TCC moments pre-explained.
- **Interactions** specified end-to-end: Mode-1 via notification→tray→Review window (the existing
  4-block agent-says/Plexus-says/scope/controls card, anti-injection preserved); Mode-2 composer →
  agent works silently in-scope, out-of-scope → Mode-1 fallback; revoke grant/bundle, rotate-key
  (revoke-all), pause, read audit.
- **Components**: reuse + reorganize + reskin, not rewrite (the approval card, trust-window picker,
  bundle composer, audit grouping encode hard-won correctness). Data layer (`api.ts`) + contract
  unchanged.

## Consolidated DECISIONS (both docs aligned; for owner ratification)
1. **Embedding**: Bun sidecar supervised by Electron-main (not ported into Node).
2. **Web admin**: keep, demoted to optional runtime-served fallback (same React codebase); desktop canonical.
3. **Cross-platform**: parallel with desktop, Linux-first then Windows.
4. **Framework**: Electron (over Tauri — maturity of tray/notification/auto-update outweighs size).
5. **Monorepo**: `packages/{protocol,runtime,cli,desktop,web-admin,tui}`; `protocol` is the keystone.
6. **Push transport**: SSE (`GET /v1/events`), not WS.
7. **Auth handoff**: Electron-main reads `~/.plexus/connection-key` → `contextBridge` → renderer (no paste).
8. **IA**: 3-band sidebar arc; **Agents** as the spine; Tokens demoted; Mode-1 → Notifications.
9. **Onboarding**: guided spine, every step skippable; payoff = witness a real call.
10. **Notifications**: always notify approval *requests* (blocking); informational events risky-only
    (a Settings dial); Mode-2 in-scope calls silent by design.
11. **Components**: reuse + reorganize + reskin, not rewrite.

## UNIFIED phased roadmap (merge of both; each phase independently demoable/shippable)
- **P0 — Monorepo carve + protocol package + sidecar seam.** (S, low risk) Extract `packages/protocol`;
  workspace; `packages/{runtime,cli,web-admin}` with no behavior change; runtime gains a supervised
  `plexus serve` entrypoint (ready line + port file + listen-adapter seam). Demo: same product,
  cleaner boundaries; runtime runnable as a supervised process. (CI parity via existing tests.)
- **P1 — LRA v1 + management event stream.** (S–M) Thin `/v1/{status,health,config,connection-key/rotate}`;
  `/admin/api/*` aliased under `/v1`; the NEW `pending_added`/`pending_resolved`/`audit_appended`
  events + `GET /v1/events` SSE. Demo: web admin drops polling, gains live pending/audit push.
- **P2 — Electron desktop shell (macOS): supervisor + tray + native notifications + panic.** (L) The
  Electron app hosts the CURRENT admin in its renderer; supervisor (spawn/health/restart/single-instance);
  connection-key handoff; tray; native Mode-1 approval notifications driven by the event stream. Demo:
  an agent's `plexus call` pops a native notification → approve from it → call completes, no window.
- **P3 — Redesigned Admin IA.** (L, can overlap P2) The 3-band sidebar; Agents spine; all tabs remapped
  to the new screens; Review window + Task-Grant composer windows; reskin shared components over the
  stable LRA. Demo: the admin navigates the mental-model arc; nothing lost.
- **P4 — Onboarding.** (M) The 4-step first-run arc, pre-explained TCC. Demo: fresh machine → 4 steps →
  one real, audited, granted call.
- **P5 — Dashboard.** (M) The Overview hub (Active-now / Needs-you / live Activity pulse / Standing-trust-by-agent
  / Exposure-health). Default landing surface.
- **P6 — Cross-platform + web/TUI + distribution.** (M each, parallelizable from P2) Fill Linux→Windows
  platform seams; ship the reskinned web-admin fallback; scaffold the Linux-server TUI; electron-builder
  packaging (signed/notarized, auto-update, bundled runtime exe). Also folds in the deferred P4
  authz discovery-confinement (per-session visibility filter) as part of the redesigned client/runtime.

**Critical path to a daily-driver macOS desktop app**: P0 → P1 → P2 (then P3 makes it the redesigned
experience). Windows desktop adds P6 (Win32 seam). Cross-platform runtime + TUI parallelizable.

This document is the plan of record; the two detail docs carry the endpoint tables + wireframes.

---

## Owner refinements (ratification 2026-06-24 — folded in)

### Refinement 1 — the UI MUST distinguish "expose a capability" from "install an integration into an agent"
Two distinct, both-supported things the IA must never blur (cc as the example):
- **EXPOSE (core Plexus):** open *this machine's* cc orchestration capability **outward** so other
  agents can call it. `cc-master` is a **Source** under **WHAT I EXPOSE** → its capabilities get
  granted to agents. This is the core thesis (broker local capabilities to agents).
- **INSTALL INTEGRATION (a convenience FEATURE — tuck it deeper):** install the Plexus plugin/skill
  **into** cc (or codex) so that agent can **consume** Plexus (the agent becomes a *client* of
  Plexus). This is a usability/onboarding convenience, **NOT a core capability** — frame it as a
  product feature, surfaced inside the "Connect an agent" / onboarding flow, never as a top-level
  core concept.

IA implications:
- An **Agent** (WHO I TRUST → Agents) is a **consumer** identity we grant capabilities to.
  "Connect an agent" = make an agent able to *talk to* Plexus (guided integration-install OR
  key-paste) — the convenience.
- A **Source** (WHAT I EXPOSE → Sources) = capabilities exposed **outward**. `cc-master`-as-source
  lives here.
- The same app (cc) can appear in **both** roles; the copy must make it explicit — *"expose cc's
  capability to agents"* (Source, core) vs *"let cc use Plexus"* (install integration, convenience).
  The "install the integration into cc/codex" helper is **tucked into Connect-an-agent / onboarding**,
  framed as quick-setup, not a core concept.
- **Lands in:** P3 (admin IA — the Sources-vs-Agents distinction + copy) and P4 (onboarding —
  the "connect an agent" framing). Capture now; no rework to P0–P2.

### Refinement 2 — reserve room for **agent-driven extension authoring** (a distinctive product feature)
A standout feature to leave a home for: launch cc/codex loaded with a *"Plexus extension authoring"*
capability (**builds on the existing M4 meta-skill**, `plugins/plexus-ext/`) so the user can **build
their own Plexus extension/plugin conversationally ("用嘴")** and install it into their local Plexus
instance — i.e. *"talk to an agent → it scaffolds + registers a new extension for you."*
- Reserve a place: a **"Create / author an extension"** affordance (likely under **WHAT I EXPOSE**,
  near Sources/Capabilities, or a dedicated "Build" action) that kicks off the agent-driven
  authoring flow. It's a **product feature** designed in its own phase (post-core-desktop),
  building on the shipped M4 scaffolder — not core-runtime; surfaced in the client.
- **Lands in:** a future feature phase (after the desktop core lands); noted now so the IA leaves a
  home for it and onboarding can hint at it.

