# Plexus — Desktop App Product + UX Redesign (DESIGN ONLY)

> Derives from `docs/design/DESKTOP-RUNTIME-REDESIGN.md` (the desktop shape) and
> `docs/design/AUTHZ-UX-MODEL.md` (the mental model). Design-only: textual
> wireframes, flows, IA, decisions, roadmap. No code.
>
> **The thesis the whole experience must carry:** *Transparency is the product.*
> Plexus packages your machine's capabilities for agents (AI-native: it generates
> the skills + workflows), then governs **who** may use **what**, **why**, and
> **for how long** — and shows you **who did what**. The redesign exists because the
> current admin's *organizational logic* hides that arc behind six peer tabs.

---

## 0. ONE VOCABULARY (frozen — every surface uses exactly these words)

| Term | Meaning (the user-facing definition) |
|---|---|
| **Agent** | A caller identity (self-asserted `agentId`, e.g. `claude-code`, `plexus-cli`). The connection-key is the trust boundary; the agent id is for scoping, confinement, audit. |
| **Capability** | One grantable thing a source exposes (its **verbs**: read / write / execute). |
| **Source** | Where capabilities come from (Obsidian vault, NAS fs, cc-master…). Has a **provenance**: first-party / managed / extension. |
| **Scope** | A capability + the verb subset + optional **constraint** (`path under Inbox/`, `calendarId in [work]`). |
| **Grant** | Standing trust: an Agent may use a Scope until its **trust-window** ends. The thing you revoke. |
| **Trust-window** | How long a grant lives: Once · 1h · 1d · 7d · Until I revoke · Custom. |
| **Token** | A short-lived (15-min) auto-refreshed view of a grant. Plumbing — you never manage it. |
| **Bundle** | A **task grant** (Mode-2): N scoped grants + attached context, named, granted to one agent, approved once. |
| **Provenance** | Source class — neutral, not a warning. Drives default trust-windows. |
| **Sensitivity** | Derived risk tier of a capability (low/…/high). |
| **Pending** | A request awaiting your decision (Mode-1 approval, a bundle request, or an extension register). |
| **Purpose** | The agent's declared free-text "why now" — *"the agent says"*. Rendered, never trusted. |
| **Narration** | Gateway-authored plain-language explanation — *"Plexus says"*. The anti-injection counterweight to Purpose. |

Two ideas dominate the IA and must never blur:
- **Mode 1 — Ad-hoc approval.** Per-operation. "Agent X, to do Z, wants Y. Approve once / for a window / deny."
- **Mode 2 — Task bundle.** Pre-authorize a scoped bundle to one agent; it then works in-scope **silently**; out-of-scope falls back to Mode 1.

---

## 1. PRODUCT SURFACES & THEIR JOBS

Plexus ships as **one Electron app** that supervises a **headless runtime** (Bun sidecar
child process). The app is four surfaces over that one runtime, each doing a distinct job,
all handing off to each other. The runtime is the only source of truth; every surface is a
view + a verb onto its HTTP/WS API.

```
                         ┌──────────────────────────────────────────┐
                         │   Plexus runtime (Bun sidecar, headless)  │
                         │   grants · bundles · pending · audit · WS │
                         └───────────────▲──────────────────────────┘
              WS push (pending/audit)    │   HTTP (read/verb)
        ┌──────────────┬─────────────────┼──────────────┬──────────────┐
        ▼              ▼                 ▼              ▼              ▼
    ┌────────┐   ┌───────────┐   ┌──────────────┐  ┌──────────┐  ┌──────────┐
    │  TRAY  │   │  NOTIF.   │   │    ADMIN     │  │DASHBOARD │  │ ONBOARD  │
    │ status │──▶│ approvals │──▶│  trust mgmt  │◀─│ overview │  │first-run │
    │ glance │   │ (native)  │   │  (the depth) │  │ (the hub)│  │  (arc)   │
    └────────┘   └───────────┘   └──────────────┘  └──────────┘  └──────────┘
```

### 1.1 TRAY (always present; the resident heartbeat)
**Job:** at-a-glance status + the pending-approval count + the two-or-three actions you
reach for without opening a window. It is the app's permanent presence; the main window is
disposable.

**Menubar icon states:**
- `◆` calm (running, 0 pending) · `◆²` badge (2 pending) · `◇` paused/stopped · `⚠` runtime error.

```
┌─ Plexus ─────────────────────────────┐
│ ● Running · 3 agents active          │   ← status line (green/amber/grey dot)
│ 2 approvals waiting          ⌥⌘P  ▸  │   ← only shown when >0; opens review window
│──────────────────────────────────────│
│ Open Dashboard                  ⌘D    │
│ Open Admin…                     ⌘,    │
│──────────────────────────────────────│
│ Recent                                │
│   ✓ claude-code · read Index.md  2m   │   ← live audit pulse (last 3), click → Audit
│   ✓ codex · wrote Inbox/note.md  9m   │
│──────────────────────────────────────│
│ Pause Plexus   (deny everything)      │   ← the panic switch: stop the runtime
│ Quit                                  │
└──────────────────────────────────────┘
```
**Hand-offs:** "approvals waiting" → opens the **Review window** (§4a). "Recent" rows →
Admin ▸ Activity. "Open Dashboard / Admin" → the main window on that route.

### 1.2 NOTIFICATIONS (native; the Mode-1 surface)
**Job:** bring an approval (or a notable event) **to** the user in-context, so a decision is
one glance, not a context switch. This is where Mode-1 lives by default — the admin's
"Pending" tab becomes a *fallback list*, not the primary path.

Three notification archetypes (native macOS, action buttons inline):

**(a) Mode-1 approval** — the core card, glanceable:
```
┌ Plexus ───────────────────────────────────┐
│ claude-code wants to WRITE your Obsidian   │   title = WHO + verb + WHAT
│ vault                                      │
│ “to file today's meeting notes into        │   subtitle = the agent's PURPOSE
│  Inbox/2026-06-24.md”                       │   (quoted = the agent says)
│  ⚠ extension source · write                 │   provenance + sensitivity chip
│ [ Approve once ] [ for 1 day ] [ Deny ]    │   ← actions = the trust-window choice
│                              Review… ↗     │   ← opens the full Review window
└────────────────────────────────────────────┘
```
- The two approve buttons are the *gateway's two recommended trust-windows* for this
  provenance×verb (here `once` and `1d` because it's an extension write). **Review…** opens
  the window to pick any window / inspect narration / re-target the agent.
- **Deny** is always a single tap. No default action on dismiss (dismiss ≠ approve).

**(b) Bundle request** — an agent proposes a task bundle:
```
┌ Plexus ───────────────────────────────────┐
│ claude-code proposes a task:               │
│ “Organize NAS Inbox” — 3 capabilities      │
│ [ Review bundle… ]            [ Deny ]     │   ← bundles ALWAYS open Review (never 1-tap)
└────────────────────────────────────────────┘
```
Bundles grant broader standing trust → never one-tap approve from the notification; they
open the Review window's bundle view.

**(c) Notable events** (configurable, off by default except revocation confirmations):
"Granted `fs.write` to codex for 7 days · Undo", "A grant expired", "Source `obsidian` went
offline". These are *informational*, dismissible, with at most an Undo.

**Hand-offs:** any notification → Review window; the tray badge mirrors the count; resolving
in the notification clears both.

### 1.3 ADMIN (the depth; the trust-management surface)
**Job:** the place you *go* (vs. notifications that *come to you*) to manage standing trust,
sources, agents, and read the audit. Reorganized from scratch (see §2). This is the redesign's
center of gravity — but it is no longer where Mode-1 lives day-to-day.

### 1.4 DASHBOARD (the hub; the overview)
**Job:** the answer to "what is Plexus doing right now and what have I trusted?" One screen,
read-mostly, the default landing surface of the main window. Drills into Admin everywhere.
(Content in §5.)

### 1.5 ONBOARDING (first-run; the arc, felt once)
**Job:** install → "what is this" → connect an agent → add a source → witness a real call +
its grant + its audit. It makes the mental-model arc *felt*, then dissolves into the Dashboard.
(Flow in §3.)

**Surface map in one line each:**
> **Tray** = resident heartbeat + panic switch · **Notifications** = Mode-1 comes to you ·
> **Admin** = manage standing trust in depth · **Dashboard** = what's happening + what I've
> trusted · **Onboarding** = feel the arc once.

---

## 2. THE REDESIGNED ADMIN IA

### 2.1 Why the current six tabs fail
Today: `Capabilities · Sources · Pending · Grants · Tokens · Audit` — six **peer** tabs with
no spine. The mental model is an *arc* (what is this → it packages capabilities → per-agent
authz → audit), but the tabs are a flat list of *nouns the engineer implemented*. "Tokens" is
plumbing the user was told never to manage, yet it's a top-level tab. "Capabilities" (a
ledger you grant from) and "Grants" (the standing ledger) are two tabs doing halves of one
job. "Pending" is Mode-1 living inside a tab when it should live in notifications. There is no
"Agents" view at all, though *per-agent* trust is the whole point.

### 2.2 The new spine — organize around the mental-model arc, not the nouns

The IA is a **left sidebar** (desktop, not web tabs) whose order *is* the arc, grouped into
three bands:

```
┌─────────────────────┬───────────────────────────────────────────────────┐
│  PLEXUS    ◆ running │   < the selected section renders here >           │
│  ───────────────────│                                                   │
│  ▸ Overview      [hub]                                                   │
│                     │                                                   │
│  WHAT I EXPOSE      │   ← band 1: "it packages my machine's caps"       │
│  ▸ Sources          │                                                   │
│  ▸ Capabilities     │                                                   │
│                     │                                                   │
│  WHO I TRUST        │   ← band 2: "per-agent, per-scenario authz"       │
│  ▸ Agents           │                                                   │
│  ▸ Approvals    (2) │      (Mode-1 history + the pending fallback)      │
│  ▸ Task Grants      │      (Mode-2 bundles)                             │
│  ▸ Standing Grants  │                                                   │
│                     │                                                   │
│  WHAT HAPPENED      │   ← band 3: "audit — who did what is crystal clear"│
│  ▸ Activity         │                                                   │
│  ───────────────────│                                                   │
│  Connection key ⧉   │   ← persistent footer (bootstrap an agent)        │
│  Settings · Help    │                                                   │
└─────────────────────┴───────────────────────────────────────────────────┘
```

**Why this maps to the arc cleanly:**
- **Overview** = the hub (answers "what is this / what's happening").
- **Band "WHAT I EXPOSE"** = the *supply* side: Sources (where caps come from) → Capabilities
  (the grantable surface + the AI-native skills/workflows they generate).
- **Band "WHO I TRUST"** = the *demand/authz* side, the heart of the two modes:
  **Agents** (the new spine — trust seen per-caller), **Approvals** (Mode-1 record + fallback
  approve), **Task Grants** (Mode-2 bundles), **Standing Grants** (the flat ledger + revoke).
- **Band "WHAT HAPPENED"** = **Activity** (audit).

### 2.3 Every existing function, mapped (nothing lost)

| Old tab / function | New home | Change |
|---|---|---|
| Capabilities ledger (grant-from) | **Capabilities** | Becomes a *catalog/inspector*, not the primary grant surface. Grants now start from an Agent or a Source or an approval. Shows attached skills + transitive workflow grants. |
| "Grant access" issue-bar (admin-initiated grant) | **Agents ▸ [agent] ▸ Grant…** and **Capabilities ▸ [cap] ▸ Grant to…** | Same composer, reachable from both the *who* and the *what* side. |
| Sources (add/detect/enable/disable/remove) | **Sources** | Unchanged in function; gains the onboarding detect cards + secret entry inline. |
| Add-Obsidian form / secrets | **Sources ▸ Add source** | Same; framed as "connect a source". |
| cc-master install tile | **Sources ▸ Add source ▸ First-party adapters** | Folded into "add a source", not a loose masthead tile. |
| Pending (Mode-1 approvals + register) | **Notifications (primary)** + **Approvals (fallback list + history)** | Mode-1 moves to native notifications; Approvals keeps a list for when notifications were missed + a permanent record. |
| Pending bundle request | **Approvals ▸ Bundle requests** + Review window | Grouped card preserved. |
| Pending extension register | **Approvals ▸ Registrations** | The security-sensitive cli-bins/rest-hosts/cross-source surface preserved verbatim. |
| Grants (standing ledger + revoke) | **Standing Grants** | The flat per-(agent,cap) ledger. Also surfaced grouped under **Agents**. |
| New task grant composer (bundle) | **Task Grants ▸ New task grant** | Reimagined for desktop (§4b). |
| Bundle-grouped grants view | **Task Grants** | Each bundle = a card; revoke bundle. Also under Agents. |
| Tokens tab | **demoted** → Agents ▸ [agent] ▸ "Active now" + Activity | No longer top-level. Tokens shown as live "active sessions" detail, never as a thing to manage. A Settings ▸ Advanced toggle reveals the raw token list for power users. |
| Audit | **Activity** | Renamed to the user's word; gains filters (by agent / capability / outcome) + the live pulse. |
| Connection key tile | **Sidebar footer + Agents ▸ Connect** | Persistent, plus the first step of "connect an agent". |
| Gateway/masthead status | **Sidebar header chip + Overview** | The `● running · vN · protocol` line. |

### 2.4 Screen-by-screen (textual wireframes)

**OVERVIEW** — see §5.

**SOURCES** — *"where capabilities come from."*
```
Sources                                              [ + Add source ]
─────────────────────────────────────────────────────────────────────
  ● Obsidian            local-rest · managed      12 capabilities  live
     https://127.0.0.1:27124 · key: obsidian-key       [Disable] [Remove]
  ● NAS filesystem      fs · managed                8 capabilities  live
  ○ cc-master           first-party                 — offline      [Enable]
─────────────────────────────────────────────────────────────────────
  Detected nearby:  Obsidian (REST) · [Add]    (from /sources/detect)

  [ + Add source ] →  ┌ Add a source ─────────────────────────┐
                      │ ◦ Obsidian vault (REST)               │
                      │ ◦ Filesystem folder                   │
                      │ ◦ First-party adapter (cc-master)     │
                      │ ◦ Custom REST / MCP…                  │
                      └───────────────────────────────────────┘
```
Provenance shown as a neutral badge; adding here is a trusted same-origin action (no agent
approval). Capabilities stay default-denied until granted.

**CAPABILITIES** — *"the catalog of grantable things + what AI-native artifacts they generate."*
```
Capabilities                          12 registered · revision 8 · default-deny
─────────────────────────────────────────────────────────────────────
 obsidian.vault.read     [read]   managed · low                    [Grant to…]
   reads a note by path · attached skills: how-to-cite, frontmatter
 obsidian.vault.write    [write]  managed · medium                 [Grant to…]
 nas.fs.organize (workflow)       managed · high                   [Grant to…]
   ↳ transitive grants: nas.fs.read[read] · nas.fs.move[write]
─────────────────────────────────────────────────────────────────────
 Filter: [ all ] [ read ] [ write/exec ]   Source: [ all ▾ ]
```
This is where the **AI-native** story is legible: each capability shows its **attached skills**
and (for workflows) its **transitive member grants** — "from the exposed set, Plexus generated
the matching skills + workflows." `[Grant to…]` opens the grant composer pre-scoped to that cap.

**AGENTS** — *the new spine; trust seen per-caller.*
```
Agents
─────────────────────────────────────────────────────────────────────
 claude-code            active now · 2 tokens     8 grants · 1 bundle  ▸
 codex                  idle                       3 grants            ▸
 plexus-cli             idle                       1 grant             ▸
─────────────────────────────────────────────────────────────────────
 [ + Connect an agent ]   ← connection-key paste OR guided integration

 ── claude-code ──────────────────────────────────────────── (expanded) ─
   Active now:  reading obsidian.vault.read  (token exp in 12m)
   Standing grants (8):
     obsidian.vault.read   [read]   7d · ends in 5d        [Revoke]
     obsidian.vault.write  [write]  1d · ends in 18h       [Revoke]
   Task grants (1):
     “Organize NAS Inbox”  3 caps · 1d   [Review] [Revoke bundle]
   Recent activity:  ✓ read Index.md 2m · ✓ wrote note 9m  → Activity
   [ Grant a capability… ]   [ New task grant… ]   [ Revoke all ]
```
*Why Agents is the spine:* the model's substance is "give **different agents**, in different
scenarios, different capability sets, each independently authorized." Seeing trust **by agent**
is the mental model rendered. Standing Grants (flat) and Task Grants (bundles) are the same data
re-cut by capability/bundle for when you think that way.

**APPROVALS** — *Mode-1 record + the fallback when a notification was missed.*
```
Approvals                                          2 waiting · history below
─────────────────────────────────────────────────────────────────────
 WAITING
  ▸ claude-code · WRITE obsidian.vault   “file today's notes”   [Review…]
  ▸ codex · REGISTER extension “weather”  ⚠ cli bin, rest host  [Review…]
 ─────────────────────────────────────────────────────────────────────
 HISTORY
  ✓ approved  claude-code · read   1d    yesterday 14:02
  ✗ denied    unknown · execute          yesterday 11:40
```
The "Review…" rows open the **same Review window** the notifications open (§4a). Registration
cards keep the full security surface (cli binaries / rest hosts / cross-source attach). Mode-1
*can* be fully driven here if notifications are off or missed — nothing is lost.

**TASK GRANTS** — *Mode-2 bundles.*
```
Task Grants                                          [ + New task grant ]
─────────────────────────────────────────────────────────────────────
 “Organize NAS Inbox”  → claude-code   1d · ends in 18h    [Revoke bundle]
    nas.fs.read   [read]                                   ends in 18h
    nas.fs.move   [write]  ↳ only path under Inbox/        ends in 18h
    nas.fs.delete [write]  ↳ only path under Inbox/Trash/  ends in 18h
    context: organize-style, inbox-conventions
 “Weekly report”      → codex          7d · ends in 5d     [Revoke bundle]
```
The composer (§4b) is the desktop reimagining of the existing `NewTaskGrantComposer`.

**STANDING GRANTS** — *the flat ledger + revoke (today's Grants table, kept).*
```
Standing Grants                                              [ Refresh ]
─────────────────────────────────────────────────────────────────────
 agent        capability            verbs   source     trust-window  ↻
 claude-code  obsidian.vault.read   read    managed     5d left    [Revoke]
 codex        nas.fs.read           read    managed     until-revoke[Revoke]
─────────────────────────────────────────────────────────────────────
 ⓘ Standing grants are scoped by agent id (self-asserted; the connection-key
   is the trust boundary — rotate it to revoke all).
```

**ACTIVITY** — *audit, the user's word.*
```
Activity                Filter: agent[all▾] capability[all▾] outcome[all▾]
─────────────────────────────────────────────────────────────────────
 14:32  invoke   obsidian.vault.read   allow   claude-code · jti…a91
 14:31  grant    obsidian.vault.read   allow   claude-code (7d)
 14:30  handshake —                    —       claude-code
─────────────────────────────────────────────────────────────────────
 Append-only, redacted. Every handshake, grant, token, invoke, revoke.
```

---

## 3. ONBOARDING FLOW (first run)

Goal: in ~4 steps the user *feels* the arc — packages capabilities → AI-native → per-agent
authz → audit — by doing one real call, not reading a tour. Each step is skippable; the spine
is guided.

```
 STEP 0  INSTALL & LAUNCH
 ─────────────────────────
 Drag Plexus.app → Applications → open. Electron boots the runtime sidecar.
 [TCC] First system prompt: "Plexus.app would like to send you notifications."
        → Allow. (We explain WHY first, in-app, before triggering it — see step 4.)
 The tray icon appears (◆). The main window opens to the onboarding pane.

 STEP 1  "WHAT IS THIS" — the value in one breath
 ─────────────────────────
 ┌──────────────────────────────────────────────────────────┐
 │              Plexus                                       │
 │  Your machine's capabilities, packaged for agents —      │
 │  and governed.                                           │
 │                                                          │
 │  • Plexus exposes things on your computer (your notes,   │
 │    your files) as capabilities an AI agent can use.      │
 │  • It generates the skills + workflows agents need.      │
 │  • You decide which agent gets what, why, and for how    │
 │    long — and you see everything they do.                │
 │                                                          │
 │            [ Set up Plexus → ]   [ Skip, I'll explore ]  │
 └──────────────────────────────────────────────────────────┘
 Three bullets = the arc. No jargon. One screen.

 STEP 2  CONNECT YOUR FIRST AGENT  ("who I trust")
 ─────────────────────────
 ┌──────────────────────────────────────────────────────────┐
 │  Connect an agent                                        │
 │  An agent is an AI tool that will use your capabilities. │
 │                                                          │
 │  ◉ Install the Claude Code integration   [ Install ]     │  ← guided: drops the
 │     adds the `plexus` skill to Claude Code               │     plugin, agent self-
 │  ◯ Install the Codex integration         [ Install ]     │     reads the local key
 │  ◯ I have another agent — paste its setup                │
 │     Connection key:  ┌───────────────────────────┐ ⧉    │  ← manual paste path
 │                      │  px_live_8f2a…             │      │
 │                      └───────────────────────────┘      │
 │  ⓘ The connection key is the trust boundary. Anything    │
 │    holding it can talk to Plexus as any agent name.      │
 │                                       [ Continue → ]     │
 └──────────────────────────────────────────────────────────┘
 Guided install writes the integration so the local agent auto-reads
 ~/.plexus/connection-key — no paste. Manual path = copy the key.

 STEP 3  ADD YOUR FIRST SOURCE  ("what I expose")
 ─────────────────────────
 We run /sources/detect immediately and lead with what we found:
 ┌──────────────────────────────────────────────────────────┐
 │  Give your agent something to work with                  │
 │                                                          │
 │  ✓ We detected Obsidian on this Mac.                     │
 │     Vault REST API · https://127.0.0.1:27124            │
 │     API key: ┌────────────────────┐  [ Connect Obsidian ]│
 │              │ paste Local REST key│                      │
 │              └────────────────────┘                      │
 │  …or  ◦ Connect a folder   ◦ Add cc-master   ◦ Skip      │
 └──────────────────────────────────────────────────────────┘
 [TCC] If "Connect a folder" picks a path under Documents/Desktop/Downloads,
        macOS shows the folder-access prompt — we pre-explain it.
 On connect: "12 capabilities discovered — default-denied until you grant them."
 → the arc's first beat (packages capabilities) is now concrete and on screen.

 STEP 4  WITNESS A REAL CALL  (the payoff — authz + audit, felt)
 ─────────────────────────
 We ask the agent to make one real, read-only call (or the user triggers it):
   "Ask Claude Code to read your vault's index note."
 The agent runs `plexus call obsidian.vault.read` → a grant request arrives.
 BEFORE the OS notification fires, we explain it in-app, then let it fire:
 ┌──────────────────────────────────────────────────────────┐
 │  Here's the heart of Plexus.                             │
 │  claude-code just asked to READ your vault.              │
 │  Approve it the way you always will — from a notification.│
 │            (a native notification appears now ↗)         │
 └──────────────────────────────────────────────────────────┘
 [TCC] the notification we primed in step 0 now does its job.
 User clicks "Approve once" → the call completes → we show, inline:
   • the result it returned (proof it was real),
   • the GRANT it created (Standing Grants now has a row),
   • the AUDIT line (Activity now has handshake → grant → invoke).
 ┌──────────────────────────────────────────────────────────┐
 │  ✓ Done. That's the whole loop:                          │
 │    claude-code  →  asked (why)  →  you approved (window)  │
 │                 →  it ran       →  it's in your audit.    │
 │  Everything an agent does flows through here, visibly.   │
 │                                  [ Go to Dashboard → ]   │
 └──────────────────────────────────────────────────────────┘
 Onboarding dissolves into the Dashboard, now non-empty (1 agent, 1 source,
 1 grant, 3 audit events) — the user's own data, not a demo.
```

**TCC (macOS permission) moments, each pre-explained before triggering:**
1. **Notifications** (step 0) — primed at step 4 ("approvals come as notifications").
2. **Folder access** (step 3, only if connecting a folder under a protected dir).
3. **Full Disk Access** (deferred; only if a source needs it — surfaced contextually in
   Sources with a "Plexus needs Full Disk Access to read this folder → Open System Settings"
   helper, never up-front).
4. **Login item / launch-at-login** — offered in Settings, not onboarding.

---

## 4. CORE INTERACTIONS, END TO END

### 4a. Ad-hoc Mode-1 approval — notification → tray → Review window

```
 (1) Agent runs:  plexus call obsidian.vault.write --purpose "file today's notes"
     → runtime creates a PENDING grant, pushes over WS to all surfaces.

 (2) NATIVE NOTIFICATION fires (the default path):
     ┌ claude-code wants to WRITE your Obsidian vault ─────┐
     │ “to file today's meeting notes into Inbox/…”        │  ← the agent says (Purpose)
     │ ⚠ extension · write                                 │
     │ [Approve once] [for 1 day] [Deny]      Review… ↗   │
     └─────────────────────────────────────────────────────┘
     Simultaneously the TRAY badge → ◆¹ and "1 approval waiting" appears.

 (3) THREE outcomes:
     • Approve once / for 1 day  → grant minted (trust-window = the button) →
       call completes → toast "✓ approved · Undo". Done in one tap.
     • Deny → runtime denies; agent gets grant_denied; nothing granted.
     • Review… (or click the tray "approvals waiting") → REVIEW WINDOW:

     ┌ Review approval ─────────────────────────────────────────────┐
     │  claude-code   ·   client: Claude Code 1.4   ·  ⚠ extension   │  WHO + client chip
     │  ───────────────────────────────────────────────────────────  │
     │  THE AGENT SAYS                                               │  (1) agent says —
     │  “to file today's meeting notes into Inbox/2026-06-24.md”     │      quoted, isolated
     │  ───────────────────────────────────────────────────────────  │      (anti-injection)
     │  PLEXUS SAYS                                                  │  (2) gateway narration
     │  This grants WRITE on obsidian.vault — the agent can create   │
     │  and modify notes in your vault. Extension source: Plexus     │
     │  always checks with you. Sensitivity: medium.                │
     │  ───────────────────────────────────────────────────────────  │
     │  SCOPE   obsidian.vault.write  [write]                        │  (3) scope/constraint
     │          ↳ (no constraint — whole vault)                      │
     │  Agent requested: 1 day  (advisory — you decide)             │
     │  ───────────────────────────────────────────────────────────  │
     │  Grant to agent: [ claude-code ▾ ]                            │  (4) controls
     │  Trust window:   [ Once · 1h · ◉1d · 7d · until I revoke · …] │
     │           [ Approve ]                       [ Deny ]          │
     └──────────────────────────────────────────────────────────────┘
```
The Review window is the existing `PendingCard` four-block layout (agent says → Plexus says →
scope → controls), lifted into a focused desktop window with the trust-window picker + agent
re-target. The **anti-injection rule holds**: "the agent says" is never adjacent to / merged
with "Plexus says."

### 4b. Mode-2 task bundle — composer → agent works silently

Two entry points: the **owner composes** one (Task Grants ▸ New task grant) or the **agent
proposes** one (notification → Review bundle). Same shape.

```
 ┌ New task grant ──────────────────────────────────────────────┐
 │ Task name:    [ Organize NAS Inbox                ]          │
 │ Grant to:     [ claude-code ▾ ]      Window: [ 1 day ▾ ]     │
 │ ───────────────────────────────────────────────────────────  │
 │ CAPABILITIES IN SCOPE                                        │
 │  [ nas.fs.read   ▾ ] [read]            (no constraint)   ✕  │
 │  [ nas.fs.move   ▾ ] [write] only [ path under ] Inbox/  ✕  │
 │  [ nas.fs.delete ▾ ] [write] only [ path under ] Inbox/Trash/ ✕│
 │  [ + Add capability ]                                        │
 │ ───────────────────────────────────────────────────────────  │
 │ CONTEXT FOR THE AGENT                                        │
 │  Attach skills:  [ inbox-conventions ✕ ] [ + ]              │
 │  Task note (becomes a skill):                                │
 │  ┌────────────────────────────────────────────────────────┐ │
 │  │ Move each Inbox capture into Inbox/YYYY/MM/ by date.    │ │
 │  │ Never touch anything outside Inbox/.                    │ │
 │  └────────────────────────────────────────────────────────┘ │
 │ ───────────────────────────────────────────────────────────  │
 │  Preview:  3 grants · confined to Inbox/ · expires in 1 day  │
 │                         [ Create task grant ]   [ Cancel ]   │
 └──────────────────────────────────────────────────────────────┘
```
After create: the bundle appears under Task Grants and under Agents ▸ claude-code. The agent
**works silently in-scope** — no notifications for in-scope calls. **Confinement:** any call
*outside* the bundle's scope (e.g. `nas.fs.move` to `Photos/`) falls back to **Mode-1** — a
notification pops exactly as in 4a. That fallback is the safety rail that makes broad pre-auth
acceptable. (Owner-composed bundles via the trusted admin surface are created directly;
agent-*proposed* bundles PEND and must be approved — the anti-self-grant linchpin.)

### 4c. Reviewing / revoking standing trust + reading the audit

```
 REVOKE a single grant:  Standing Grants (or Agents ▸ agent) → [Revoke] on the row.
   → toast "Revoked obsidian.vault.write for claude-code · Undo (30s)".
   → its tokens die at next 15-min refresh; Activity logs grant.revoke.
 REVOKE a bundle:        Task Grants → [Revoke bundle] → members + context + tokens gone.
 ROTATE the key (nuclear): Settings ▸ Connection key ▸ Rotate → ALL standing grants drop
   (epoch-bound). Confirmation explains the blast radius.
 PAUSE (panic):          Tray ▸ Pause Plexus → runtime stops answering; everything denied
   until resumed. The instant "stop the world" without revoking anything.
 READ the audit:         Activity → filter by agent/capability/outcome. The audit is the
   proof surface: "which agent did what is crystal clear." Tray "Recent" + Dashboard pulse
   are live windows onto the same stream.
```

---

## 5. DASHBOARD CONTENT (the Overview hub)

The default landing surface. Read-mostly; every tile drills into Admin. Answers two questions:
*what is happening right now* and *what have I trusted*.

```
┌ Overview ───────────────────────────────────────── ● running · v0.5.1 · proto 0.1.2 ┐
│                                                                                      │
│  ┌ ACTIVE NOW ─────────────────┐   ┌ NEEDS YOU ──────────────────────────────────┐ │
│  │ 3 agents active             │   │ ⚠ 2 approvals waiting        [ Review → ]   │ │
│  │  claude-code  reading vault │   │ ⚠ 1 source offline (cc-master) [ Fix → ]    │ │
│  │  codex        idle          │   │ ✓ otherwise all clear                       │ │
│  │  plexus-cli   idle          │   └─────────────────────────────────────────────┘ │
│  └─────────────────────────────┘                                                    │
│                                                                                      │
│  ┌ ACTIVITY PULSE (live) ──────────────────────────────────────────────────────┐  │
│  │ 14:32 ✓ claude-code  read   obsidian.vault.read                              │  │
│  │ 14:31 ✓ claude-code  grant  obsidian.vault.read (7d)                         │  │
│  │ 14:18 ✓ codex        write  nas.fs.move  (in “Organize NAS Inbox”)           │  │
│  │                                                            [ Full activity → ]│  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                      │
│  ┌ STANDING TRUST ─────────────────────┐  ┌ EXPOSURE HEALTH ──────────────────────┐│
│  │ 12 standing grants · 2 task grants  │  │ Sources:  2 live · 1 offline          ││
│  │  ▸ claude-code  8 grants, 1 bundle  │  │ Capabilities: 20 (8 granted, 12 dark) ││
│  │  ▸ codex        3 grants            │  │ Skills/workflows generated: 14        ││
│  │  ▸ plexus-cli   1 grant             │  │                       [ Sources → ]   ││
│  │              [ Manage trust → ]     │  └───────────────────────────────────────┘│
│  └─────────────────────────────────────┘                                           │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**Tiles & their drill-downs:**
- **Active now** — agents currently holding live tokens + what they're doing → Agents.
- **Needs you** — pending count + offline sources + key-rotation reminders → Approvals / Sources.
- **Activity pulse** — last ~6 audit events, live (WS) → Activity.
- **Standing trust** — grants + bundles grouped by agent at a glance → Agents / Standing Grants.
- **Exposure health** — sources live/offline, capabilities granted vs dark, AI-native artifact
  count (the "it generates skills + workflows" beat, quantified) → Sources / Capabilities.

---

## 6. DECISIONS

**DECISION: IA top-level structure.**
→ **Recommend** a desktop **left sidebar** with the three-band arc:
`Overview` · **WHAT I EXPOSE** (Sources, Capabilities) · **WHO I TRUST** (Agents, Approvals,
Task Grants, Standing Grants) · **WHAT HAPPENED** (Activity), with Connection-key + Settings in
the footer. Make **Agents** the new spine (per-caller trust = the model rendered). Demote
**Tokens** out of top-level (it's plumbing; show as "active now" detail + a Settings ▸ Advanced
raw list). Move **Pending/Mode-1** primarily to **Notifications**, keeping **Approvals** as the
record + fallback. Rationale: the bands *are* the mental-model arc, so the IA teaches the model
just by existing.

**DECISION: drop the web admin or keep it as fallback.**
→ **Recommend keep it as an optional, runtime-served fallback** (same React app, reskinned to
the new IA), but make the **Electron desktop app the canonical, promoted experience**. The
runtime is already a headless loopback HTTP/WS service; the web admin is just one client. A
served web admin is near-free and is the right answer for **headless Linux servers** (until the
planned TUI lands) and remote access. Notifications/tray simply degrade to the in-app Approvals
list in the web build. Do **not** invest in web-only polish; it rides the shared component layer.

**DECISION: how much onboarding is guided vs optional.**
→ **Recommend a guided spine, every step skippable.** The 4-step arc (what-is-this → connect
agent → add source → witness a real call) is the default and is *strongly* guided, because the
payoff (step 4, a real call + its grant + its audit) is what makes the model click. But each
step has a visible "Skip / I'll explore" and the app is fully usable if abandoned at step 1.
Never block the app behind onboarding. Re-offer the unfinished steps as Dashboard "Needs you"
nudges.

**DECISION: notification granularity (every grant vs risky only).**
→ **Recommend: notify for every Mode-1 approval *request* (these REQUIRE a decision), but for
informational *events*, default to risky-only.** Concretely: (a) **always** notify Mode-1
approval requests + bundle requests + registrations — they're blocking. (b) For *outcomes*,
notify by default only revocations and "Undo" confirmations + source-offline; suppress routine
in-scope invokes (those are the Activity pulse / tray Recent). (c) Expose a Settings dial:
`Notify me about → [All events · Approvals + risky (default) · Approvals only]`. Mode-2 in-scope
calls are **silent by design** — that silence is the Mode-2 value. Out-of-scope fallbacks notify.

**DECISION: reuse existing React components (reskinned) vs fresh.**
→ **Recommend reuse + reorganize, not rewrite.** The existing components encode hard-won
correctness: the four-block approval card (agent-says vs Plexus-says anti-injection), the
trust-window picker + provenance×verb defaults, the bundle composer with constraints, the
grouped bundle view, the audit grouping. Keep these as a shared component library; the redesign
is **new IA shells + new surfaces (tray/notifications/dashboard/onboarding) + a reskin**, with
the high-value cards (Review window, composer) lifted into focused desktop windows. The data
layer (`api.ts`) and protocol contract are unchanged. This matches the north star's
"formalize + extend + reskin, not a runtime rewrite."

**DECISION: runtime-in-desktop model.**
→ **Recommend Bun sidecar child process supervised by Electron-main** (per the north star),
keeping the runtime untouched and the client↔runtime seam real (the same seam a future TUI and
the web admin speak). Electron-main owns: spawning/supervising the sidecar, the tray, native
notifications (bridging WS pending-events → `Notification`), and TCC prompts; the renderer hosts
Admin/Dashboard/Onboarding. Note Tauri as a lighter alternative (smaller bundle) the owner
already decided against — recorded only as a tradeoff.

---

## 7. PHASED BUILD ROADMAP (each phase independently demoable)

**Phase 0 — Formalize the seam (enabler, demoable as "same app, sidecar").**
Wrap the existing runtime as a supervised **Bun sidecar**; Electron shell hosts the *current*
React admin unchanged in its renderer; add a basic tray (running / quit). Add a WS (or poll)
**pending/audit event stream** the main process can subscribe to.
*Demo:* Plexus runs as a desktop app; the existing admin works inside it; tray shows status.

**Phase 1 — Tray + native notifications + the panic switch (the desktop payoff).**
Real tray menu (status, pending count, Recent pulse, Pause, Open). Native **Mode-1 approval
notifications** with inline Approve-once / Approve-window / Deny, wired to the runtime's
pending/resolve. Bundle-request + registration notifications open the (still-old) Pending tab as
the Review target. Settings notification dial (stub).
*Demo:* an agent's `plexus call` pops a native notification; approve from it; the call completes
— no window opened.

**Phase 2 — Redesigned Admin IA (the reorganization).**
Build the sidebar three-band IA; introduce **Agents** as the spine; split today's tabs into the
new screens (Sources, Capabilities-as-catalog, Agents, Approvals, Task Grants, Standing Grants,
Activity); demote Tokens; lift the approval card into the focused **Review window** and the
composer into the Task-Grant window. Reskin shared components.
*Demo:* the new admin navigates the mental-model arc; every old function reachable in its new
home; nothing lost.

**Phase 3 — Onboarding (first-run arc).**
The 4-step guided flow: what-is-this → connect agent (guided integration install + key paste) →
add source (detect-led) → witness a real call → dissolve into Dashboard. Pre-explained TCC
moments (notifications, folder access).
*Demo:* fresh machine → install → 4 steps → the user has made one real, audited, granted call.

**Phase 4 — Dashboard (the hub).**
The Overview surface: Active-now, Needs-you, live Activity pulse, Standing-trust-by-agent,
Exposure-health. Becomes the default landing route; tray "Open Dashboard" lands here.
*Demo:* one screen answers "what's Plexus doing + what have I trusted," everything drillable.

**Phase 5 — Cross-platform + web/TUI seams (north-star tail).**
Finish the Win/Linux runtime platform seam (deferred t15); ship the reskinned **web admin** as
the served fallback; scaffold the **Linux-server TUI** client against the same formalized seam;
package the runtime inside the desktop installer (one app, separation invisible).
*Demo:* the same trust model on Windows/Linux; web admin for headless; TUI stub on a server.

---

## APPENDIX — design invariants (carry through every phase)
- **Transparency is the product** — never hide the grant/why/window/audit to look "smooth."
- **Anti-injection** — "the agent says" (Purpose) is always visually isolated from "Plexus
  says" (Narration); the agent's words never style or merge with the gateway's.
- **Anti-self-grant** — an agent's *request* (Mode-1) or *proposed bundle* always PENDS for the
  human; only the trusted local admin surface grants directly.
- **Default-deny** — capabilities are dark until granted; the UI states it everywhere.
- **One vocabulary** — §0 words only, on every surface, in every notification.
- **The connection-key is the trust boundary** — say so wherever per-agent trust is shown;
  rotate = revoke-all.
```
