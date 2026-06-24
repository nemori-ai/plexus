# Plexus — Desktop App + Runtime/Client Separation Redesign (NORTH STAR)

> Recorded 2026-06-24 from the project owner. A major direction after the authorization
> logic refactor (Mode-1+Mode-2, committed d4c2a41). This reframes Plexus from "a gateway
> with a same-origin web admin" into "a separable cross-platform runtime + independent
> clients, shipped as one desktop app." Design-first; build in phases.

## 0. Version / release posture
Next release is **≥ 0.5.1, NON-rc** (these are substantial changes, not release candidates).
**No rush to publish** — get the architecture + experience right first.

## 1. The pivot (owner's words)
- After the authz logic refactor, the **entire admin UI needs a complete redesign**. The UI
  *style* is fine; the **organizational logic is unclear**. **Forget the current admin** and
  reorganize from scratch — starting from the developer/user **mental model**
  (`docs/design/AUTHZ-UX-MODEL.md`), and design the **onboarding user path** too.
- **Many functions are unnatural as a web page.** Go with an **Electron** desktop app so the
  **admin + tray menu + system notifications** are strung together; fold in a **dashboard**.
- **Re-architect the server-side runtime + the desktop client**, leaving room for cross-platform:
  - **Core runtime**: separated, **headless, cross-platform, extensible**.
  - **Clients**: independent. Electron desktop (Win/Linux/Mac); a future **TUI** for Linux
    *servers* (where a GUI is wrong). Web admin optional.
  - **Distribution**: bundle the runtime into the client app so users don't perceive the
    separation (one installable app), while the architecture stays cleanly separable.

## 2. Framing insight (to validate in design)
The runtime is **already substantially separable**: it is a headless loopback service exposing
an HTTP/WS API; today's web admin is just one client of that API (served same-origin). So the
work is likely **formalize + extend + reskin**, not a runtime rewrite:
1. **Formalize the runtime↔client API** as a stable, versioned contract (the thing every client
   — Electron, TUI, web — speaks).
2. **Build the desktop client** (Electron) that supervises the runtime (likely as a **Bun
   sidecar child process**), and adds tray + native notifications + dashboard.
3. **Redesign the admin IA/UX + onboarding** from the mental model (the React UI is reskinned/
   reorganized, served in Electron's renderer and optionally as web).
4. **Finish cross-platform runtime** (the platform seam is macOS-only today; Win/Linux were
   deferred as t15) + lay the TUI-client seam.
5. **Distribution/bundling** (runtime packaged inside the desktop app).
The auth/authz logic just built (grants, constraints, bundles, audit) is **preserved** — it is
the substance that lives inside the redesigned runtime.

## 3. The experience to design (from the mental model)
- **Onboarding**: first run → "what is this" → connect your first agent (the connection-key
  paste / a guided agent setup) → add your first capability source → see a real call + its
  audit. The mental-model arc (packages capabilities → AI-native skills/workflows → per-agent
  authz → audit) should be felt, not explained.
- **Tray**: at-a-glance status (running, pending approvals count), quick actions, start/stop.
- **Native notifications**: the Mode-1 approval as a system notification — "Agent X wants to
  WRITE your vault, in order to <purpose> — approve once / for 1 day", tap to review.
- **Admin (reorganized)**: around the two modes (ad-hoc approvals vs scoped task bundles),
  the trust surface (capabilities, sources, grants, audit), and transparency.
- **Dashboard**: overview — active agents, recent activity, what's been granted, audit pulse.

## 4. Open decisions (to surface during design)
- How radical is the runtime re-architecture (formalize-the-API vs deeper restructuring)?
- Runtime-in-desktop model: **Bun sidecar child process** (preserve runtime as-is) vs port to
  Node/Electron-main. (Sidecar preferred — keeps the separation real + runtime untouched.)
- Electron vs lighter alternative (Tauri) — owner said Electron; note tradeoffs only.
- Fate of the web admin (drop / keep as optional fallback served by the runtime).
- Cross-platform runtime sequencing (finish Win/Linux now or after the desktop app).
- Phasing of the whole effort.

This doc is the reference; the architecture + product design + phased roadmap derive from it.
