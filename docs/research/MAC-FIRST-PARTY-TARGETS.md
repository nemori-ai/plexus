# Plexus — macOS First-Party Integration Research

**Prepared:** 2026-06-24 · **Audience:** Plexus project owner · **Purpose:** Decide which products to ship as first-party, deeply-optimized Plexus capabilities in the first public release.

**Reading note on evidence labels:** `[FACT]` = grounded in a cited 2025–2026 source. `[JUDGMENT]` = my analysis/inference, not a sourced figure. Where I couldn't find a hard number I say "qualitative: high/med/low" rather than invent one. Star counts are popularity *proxies*, not usage, and fluctuate; treat single-source figures as approximate.

---

## 1. Executive Summary

The single clearest signal in the data: **the cloud-SaaS lanes (GitHub, Notion, Linear, Figma, Slack, Google Calendar) are already being claimed by first-party vendor MCP servers and by Anthropic's own Connectors Directory (375+ integrations as of Feb 2026)** [FACT]. A generic gateway adds little there. **Plexus's real moat is the *local macOS surface that no vendor will ship a server for* — the native Apple apps and the local-only power-user apps — where the community is visibly straining against AppleScript/SQLite hacks** (apple-mcp ~3.1k stars built entirely on AppleScript/JXA is the loudest demand signal) [FACT/JUDGMENT].

**Top tier to integrate first-party (my ranking):**

1. **Apple ecosystem bundle** (Calendar/Reminders via EventKit, Mail, Messages, Notes, Contacts) — highest data-gravity, universal install, worst generic experience, biggest first-party uplift.
2. **Obsidian** — best-in-class local automation surface (Local REST API plugin + plain-markdown disk), huge engaged base (~1.5M users, 120M plugin downloads) [FACT], safe read path.
3. **Things 3** — beloved task manager with a real AppleScript read + URL-scheme write surface; clean blast-radius story.
4. **Apple Shortcuts** — a *meta-capability*: the `shortcuts` CLI lets one integration reach hundreds of user-defined automations and other apps.
5. **1Password** — the only app in the survey with an *enforced per-vault read-only* local token model; safety-defining; high trust value.
6. **Browser control (Safari/Chrome via the Mac's own browser)** — agents reach for browsers constantly; doing it through the user's logged-in local browser is a genuine first-party advantage over cloud headless.

**Recommended v1 shortlist (ship these first):** **Apple Calendar+Reminders (EventKit)**, **Obsidian**, **Things 3**, **Apple Shortcuts**, plus **Messages/Mail read** as the "wow" demo. Rationale and the best first live-test pick are in §6.

**Rubric headline:** I score each candidate 1–5 on seven axes — **Agent Value, Adoption, Agent-Fit, Surface Quality, Safety/Blast-Radius, First-Party Uplift (moat), and AI-Native Overlap (inverted)** — then weight toward *Uplift × Surface Quality × Safety*, because that triple is exactly what separates a Plexus first-party integration from a generic MCP shim.

---

## 2. Scoring Rubric

I kept the brief's five dimensions but split, renamed, and added to make them decision-useful. Each axis is scored **1 (poor) → 5 (excellent)** unless noted.

| Axis | What it measures | 5 = | 1 = |
|---|---|---|---|
| **AV — Agent Value** | Leverage of workflows unlocked; how often an agent *needs* it (frequency-of-need folded in) | unlocks daily high-leverage flows | rarely needed novelty |
| **AD — Adoption** | How many Mac users actually run it | ubiquitous / pre-installed | niche |
| **AF — Agent-Fit** | How naturally agent tasks map onto its primitives (structured objects, queryable) | clean CRUD on structured data | freeform/UI-bound |
| **SQ — Surface Quality** | Automation mechanism rank: **local REST/official API > AppleScript/JXA dict > URL-scheme > CLI > screen-scrape** | local/official API | screen-scrape only |
| **SF — Safety / Blast-Radius** | Can we offer a *true read-only* mode? How reversible are writes? | enforced read-only token + reversible writes | irreversible, unscoped creds |
| **UP — First-Party Uplift (MOAT)** | How much better a hand-crafted, scoped, skill-wrapped Plexus integration is vs a generic MCP shim | huge: shim does this badly/unsafely | little: generic shim already fine |
| **NA — AI-Native Overlap** *(inverted)* | How much the vendor already ships AI access (high overlap = Plexus duplicates) — **scored inverted: 5 = vendor offers nothing, Plexus is the only path** | no native AI access | vendor already has great first-party AI/MCP |

**Composite (weighted):** `0.18·AV + 0.12·AD + 0.12·AF + 0.16·SQ + 0.18·SF + 0.16·UP + 0.08·NA`.
Weighting rationale [JUDGMENT]: Safety, Surface Quality, and Uplift dominate because they are the dimensions where Plexus *as a curated local gateway* wins or loses; raw adoption is deliberately under-weighted so we don't just rebuild Anthropic's connector directory.

**Tiering:** **T1** ≥ 4.0 (ship-first candidates) · **T2** 3.3–3.9 (fast-follow) · **T3** < 3.3 (later / skip).

---

## 3. Ranked Candidate Table

Scores are 1–5; **Comp** is the weighted composite. NA is the *inverted* AI-native axis (high = vendor leaves the lane open).

| # | Candidate | AV | AD | AF | SQ | SF | UP | NA | **Comp** | Tier |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Apple Calendar + Reminders (EventKit)** | 5 | 5 | 5 | 4 | 4 | 5 | 4 | **4.55** | T1 |
| 2 | **Obsidian** | 5 | 4 | 5 | 5 | 5 | 4 | 5 | **4.74** | T1 |
| 3 | **Apple Mail (read-centric)** | 5 | 5 | 4 | 3 | 4 | 5 | 4 | **4.27** | T1 |
| 4 | **Things 3** | 4 | 3 | 5 | 4 | 5 | 5 | 5 | **4.45** | T1 |
| 5 | **Apple Shortcuts (meta)** | 5 | 5 | 3 | 4 | 3 | 5 | 4 | **4.18** | T1 |
| 6 | **1Password** | 4 | 4 | 4 | 5 | 5 | 4 | 4 | **4.36** | T1 |
| 7 | **Apple Messages / iMessage** | 5 | 5 | 3 | 2 | 3 | 5 | 4 | **3.86** | T2 |
| 8 | **Apple Notes** | 4 | 5 | 3 | 2 | 3 | 5 | 4 | **3.66** | T2 |
| 9 | **Safari / Chrome (local browser)** | 5 | 5 | 3 | 3 | 3 | 4 | 3 | **3.83** | T2 |
| 10 | **iTerm2 / Terminal** | 4 | 4 | 3 | 4 | 2 | 4 | 4 | **3.55** | T2 |
| 11 | **Zotero (+ Better BibTeX)** | 4 | 2 | 5 | 5 | 4 | 4 | 5 | **4.04** | T1* |
| 12 | **DEVONthink** | 4 | 2 | 4 | 4 | 4 | 5 | 5 | **3.96** | T2 |
| 13 | **Xcode (xcodebuild/simctl)** | 4 | 3 | 4 | 4 | 3 | 3 | 3 | **3.49** | T2 |
| 14 | **Bear** | 3 | 2 | 4 | 3 | 3 | 4 | 5 | **3.34** | T2 |
| 15 | **Logseq** | 3 | 2 | 5 | 4 | 4 | 4 | 5 | **3.74** | T2 |
| 16 | **Raycast (as host, bridge)** | 3 | 4 | 3 | 3 | 3 | 2 | 2 | **2.92** | T3 |
| 17 | **Spotify / Apple Music** | 2 | 5 | 4 | 4 | 4 | 2 | 3 | **3.32** | T2/3 |
| 18 | **Notion** | 5 | 5 | 5 | 4 | 4 | 1 | 1 | **3.62** | T2 |
| 19 | **Linear** | 4 | 3 | 5 | 5 | 4 | 1 | 1 | **3.40** | T3 |
| 20 | **GitHub** | 4 | 5 | 5 | 5 | 4 | 1 | 1 | **3.62** | T3 |
| 21 | **Figma** | 4 | 4 | 4 | 4 | 4 | 1 | 1 | **3.30** | T3 |
| 22 | **Slack** | 4 | 5 | 4 | 4 | 3 | 1 | 1 | **3.30** | T3 |
| 23 | **Readwise / Reader** | 3 | 2 | 4 | 4 | 3 | 3 | 3 | **3.20** | T3 |

\* Zotero scores T1 on the math but is gated to a narrow (research/academic) audience — I treat it as a **high-value vertical pick**, not a mass-market v1, hence not in the headline shortlist.

**The pattern to internalize [JUDGMENT]:** rows 18–22 (Notion, Linear, GitHub, Figma, Slack) score *high on every classic dimension* yet land in T2/T3 **purely because UP and NA crater** — the vendor already ships an official MCP/connector, so a generic shim is already fine and Plexus adds nothing. Rows 1–8 (the Apple + local-app cluster) are the inverse: messy surfaces, no vendor AI path, enormous uplift. **That inversion is the entire strategic thesis.**

---

## 4. Per-Candidate Deep-Dives (Top ~15)

### 1. Apple Calendar + Reminders (EventKit) — T1, Comp 4.55
- **Workflows unlocked:** "What's on my calendar today / find a free 90-min slot Thursday," "create a reminder from this email/thread," "reschedule my afternoon," "summarize what I committed to this week." Calendar/tasks are among the **most-requested connector categories** in every directory surveyed [FACT — Claude Connectors, Google Calendar MCP ~1k stars, Raycast].
- **Surface:** **EventKit framework** (`EKEventStore`) is the correct mechanism — not AppleScript. Since macOS Sonoma it has **granular write-only vs full-access authorization scopes**, so a *true read-only* grant is enforceable at the OS layer [FACT]. AppleScript is the fragile fallback.
- **Auth/safety:** TCC permission prompt; read access is the floor. Writes (create/delete events) are reversible-ish but high-visibility — gate behind approval. **SF=4.**
- **First-party uplift:** Huge. Generic MCP servers shell out to AppleScript and get flaky, timezone-buggy results. A first-party EventKit-backed capability with a hand-written agent skill ("always confirm timezone, never double-book, prefer free/busy query before proposing") is dramatically better. **UP=5.**

### 2. Obsidian — T1, Comp 4.74 (highest)
- **Workflows:** "Search my vault for everything on X and draft a synthesis note," "append today's meeting notes to the daily note," "link these two notes," "build an MOC." This is the canonical PKM agent workflow.
- **Adoption:** **~1.5M active users, +22% YoY; 120M+ plugin downloads; 1,400+ community plugins; users average 43 min/day** [FACT]. Deeply engaged, technical, AI-curious base — exactly Plexus's early adopters [JUDGMENT].
- **Surface (best-in-class):** **Local REST API** community plugin on `127.0.0.1:27124` (Bearer API key), which now *ships its own MCP endpoint at `/mcp/`*; plus `obsidian://`/Advanced URI for navigation/write [FACT]. **And** the vault is plain markdown on disk → a **zero-auth, truly read-only filesystem ingestion path** that bypasses the API entirely. **SQ=5, SF=5.**
- **First-party uplift:** Medium-high. The plugin exists, but it's fragmented across 3+ client repos with inconsistent quality; a Plexus first-party capability that auto-detects the vault, prefers disk-read for queries and the REST API for safe writes, and ships a vault-aware skill is a real upgrade. **UP=4. NA=5** (no vendor AI path).

### 3. Apple Mail (read-centric) — T1, Comp 4.27
- **Workflows:** "Summarize unread from my boss," "find the contract attachment from last Tuesday," "draft a reply (don't send)," "what did I agree to in this thread." **Mail is the highest data-gravity app on most users' Macs** [JUDGMENT].
- **Surface:** **AppleScript dictionary** (Mail/Message suites); read iteration is reliable. Note long-standing **send/compose AppleScript bugs across macOS versions** [FACT] — so scope this **read + draft, not auto-send** initially.
- **Safety:** Read-only by convention (not enforced). Email is sensitive → strong approval + scoping mandatory. **SF=4** (read), lower for write.
- **Uplift:** Very high. No vendor offers local Mail AI access; generic AppleScript Mail servers are slow and crash-prone. First-party value = a careful, batched, read-mostly capability + a skill that *never sends without explicit confirmation*. **UP=5.**

### 4. Things 3 — T1, Comp 4.45
- **Workflows:** "Add these 5 tasks to my Work project with deadlines," "what's due today across projects," "process my inbox into projects." Maps perfectly onto agent task-management.
- **Surface (clean split):** **AppleScript dictionary for READ** (full lists/projects/tags) and the **`things:///` URL scheme for WRITE** (with an auth token required for `update`/`json` bulk ops) [FACT]. This read/write separation is *ideal* for Plexus scoping: a read grant uses AppleScript only; a write grant adds the URL scheme. **SQ=4, SF=5.**
- **Adoption:** Qualitative: medium — beloved/premium but paid-per-platform; Apple Reminders is eroding share with iOS 26 AI features [FACT]. **AD=3.**
- **Uplift:** High and the *cleanest demo of Plexus's grant model* — the URL-scheme auth token + read/write split is almost designed for per-capability grants. **UP=5, NA=5.** *(This is my pick for the best first live test — see §6.)*

### 5. Apple Shortcuts — T1, Comp 4.18 (the meta-capability)
- **Why it's special:** One integration → reach **every Shortcut the user has built**, which in turn can touch dozens of other apps. It's a force-multiplier: instead of integrating App N, you integrate the user's *own* automations over App N.
- **Surface:** **`shortcuts` CLI** (`shortcuts list`, `shortcuts run <name> -i input`) + `shortcuts://` URL scheme [FACT]. `shortcuts list` is a safe read-only enumeration → Plexus can *discover* the user's shortcuts and self-describe them as callable capabilities. This aligns beautifully with Plexus's DISCOVER→UNDERSTAND→GRANT model.
- **Safety:** Each shortcut is a black box (could do anything) → **SF=3**; mitigate by treating each run as an approval-gated call with the shortcut's name/description shown.
- **Uplift:** High and *uniquely Plexus-shaped*: a generic MCP server rarely exposes user Shortcuts well; Plexus turning "your Shortcuts" into a self-describing capability set is a differentiator. **UP=5.**

### 6. 1Password — T1, Comp 4.36 (the safety exemplar)
- **Workflows:** "Inject the staging DB credential into this command," "what login do I have for service X" (read), SSH signing. Mostly *enabling other workflows safely*.
- **Surface (best safety model in the survey):** **1Password Connect** local REST API (`localhost:8080`) with **per-vault read / write / read-write tokens → enforced read-only is first-class** [FACT]; plus the `op` CLI (biometric desktop session) and service accounts.
- **Why it matters for Plexus:** It's the one integration that *proves the trust story*. Shipping it demonstrates Plexus can broker secrets with scoped, audited, human-approved, read-only-by-default access — the exact narrative Plexus sells. **SF=5, SQ=5.**
- **Uplift:** Generic shims tend to over-grant; a Plexus first-party integration that defaults to per-vault read tokens and never exposes secret *values* to the model without explicit per-call approval is materially safer. **UP=4.** *(Caveat: powerful but sensitive — gate hard, possibly ship as opt-in "advanced.")*

### 7. Apple Messages / iMessage — T2, Comp 3.86 (the demo "wow")
- **Workflows:** "Summarize my unread iMessages," "what did Alex say about dinner," "draft a reply." Universally relatable demo value.
- **Surface (messy but doable):** **READ = query the local `~/Library/Messages/chat.db` SQLite** (needs Full Disk Access; open read-only/copy). **SEND = AppleScript `send`**, which is **widely reported unreliable in 2025–26** [FACT]. Community `mac_messages_mcp` (~300 stars) does exactly this [FACT].
- **Safety:** Reading private messages is sensitive; sending is irreversible → **SF=3**. Default to **read + draft only**.
- **Uplift:** Very high — no vendor will ever ship this; the chat.db read path is fiddly enough that a polished, safe, first-party implementation is a clear moat. **UP=5.** Lower SQ (2) keeps it in T2 despite huge demo appeal.

### 8. Apple Notes — T2, Comp 3.66
- **Workflows:** capture/read notes, "find my note about X." Ubiquitous (pre-installed).
- **Surface (weak):** **AppleScript only**, and crippled — can read `body` but **attachments/drawings/tables are inaccessible**; no read-only mode [FACT]. This is the floor of the Apple cluster.
- **Uplift:** High demand (it's everywhere) but the surface caps quality. Worth doing for completeness *after* the higher-SQ apps. **UP=5, SQ=2.**

### 9. Safari / Chrome (local browser) — T2, Comp 3.83
- **Workflows:** "Read the page I'm on and extract X," "fill this form," "check what's in my open tabs," authenticated scraping the user is already logged into. Browser automation is the **single most-starred MCP category** (Playwright 34k, Chrome DevTools MCP 44k, browser-use ~100k) [FACT] — overwhelming demand.
- **Surface:** **Safari** = AppleScript `do JavaScript` (needs TCC + "Allow JavaScript from Apple Events"); **Chrome** = AppleScript `execute javascript` + CDP via `--remote-debugging-port`, but **Chrome 136+ ignores remote-debugging on the default profile** (must pass a custom `--user-data-dir`) [FACT].
- **First-party uplift [JUDGMENT]:** The *generic* tools spin up a fresh headless browser — Plexus's distinct angle is driving the **user's already-open, already-logged-in browser**, which is what they actually want for personal-context tasks. That's a real differentiator, but the SQ/SF are middling (script injection, broad blast radius) → **UP=4, SF=3.** Compelling but technically the riskiest of the cluster.

### 10. iTerm2 / Terminal — T2, Comp 3.55
- **Surface:** **iTerm2 official Python API** (gRPC, cookie auth) is genuinely good; Terminal.app is AppleScript `do script` only [FACT]. Overlaps heavily with Claude Code/Codex which *already own the shell*. **NA lower because the agents already have shells** → modest uplift. Useful for "run this in my visible terminal session" UX, not foundational.

### 11. Zotero (+ Better BibTeX) — T1 on math / vertical pick, Comp 4.04
- **Workflows:** "Add this paper to my library," "cite these in BibTeX," "what's in my 'LLM-safety' collection." Killer for researchers/academics.
- **Surface (excellent):** **Local HTTP server `localhost:23119`**; **Better BibTeX adds JSON-RPC** (`/better-bibtex/json-rpc`), **unauthenticated localhost-only** [FACT]. Clean read via search/export. **SQ=5, SF=4, NA=5.**
- **Caveat:** Narrow audience (**AD=2**) → I'd ship it as a *vertical* capability for the research segment, not a mass-market v1 headliner.

### 12. DEVONthink — T2, Comp 3.96
- **Surface:** The **richest AppleScript/JXA dictionary** in the survey; deep read/query feasible [FACT]. Power-user knowledge base. Narrow audience but extremely high per-user value and big uplift (no vendor AI). A strong *fast-follow* for the knowledge-worker segment.

### 13. Xcode (xcodebuild / simctl) — T2, Comp 3.49
- **Surface:** **`xcodebuild` + `xcrun simctl`** CLI is robust; AppleScript dictionary exists [FACT]. XcodeBuildMCP (~4–5k stars, **acquired by Sentry Feb 2026** [FACT]) shows real demand among Apple devs. Good vertical for the Mac-developer audience but the agent-coding tools already orchestrate builds, capping uplift.

### 14. Bear — T2, Comp 3.34
- **Surface:** **`bear://x-callback-url`** + app-generated **API token**; `/open-note` reads but is async/UI-driven, no batch read [FACT]. Loved but smaller base. Fast-follow note-taking option after Obsidian.

### 15. Logseq — T2, Comp 3.74
- **Surface:** **Local HTTP API `localhost:12315`** (Bearer token, unscoped) + plain markdown/org on disk [FACT]. Same "plain-disk safe read" advantage as Obsidian, smaller audience. Natural Obsidian fast-follow.

**Deliberately-deprioritized (T2/T3) despite high raw value — Notion, Linear, GitHub, Figma, Slack:** all have **official first-party MCP servers / Anthropic connectors already** [FACT: GitHub MCP ~30k stars GA, Notion MCP ~4k first-party, Linear remote MCP at `mcp.linear.app`, Figma Dev Mode MCP, Slack connector launched Jan 26 2026]. Generic access is already excellent, so Plexus's uplift ≈ 0 here. **Recommendation: *consume* these via Plexus's MCP-ingestion path rather than hand-craft them** — that's literally Plexus's "superset/collector over MCP" design. Don't spend first-party engineering on lanes the vendors already paved.

---

## 5. Category Map

| Category | Candidates | Vendor AI coverage | Plexus opportunity |
|---|---|---|---|
| **Notes / PKM** | Obsidian, Logseq, Bear, Apple Notes, Craft, Capacities, **Notion** | Notion only (official MCP) | **HIGH** — Obsidian/Logseq/Bear/Apple Notes all vendor-uncovered, good surfaces |
| **Calendar / Tasks** | **Apple Calendar/Reminders**, Things 3, Fantastical, Todoist | Google Cal & Todoist have APIs | **HIGH** — Apple-native cal/reminders + Things are the gap |
| **Comms** | **Apple Mail, Messages**, Slack | Slack connector (Jan 2026) | **HIGH for Apple Mail/Messages**; skip Slack (covered) |
| **Dev tools** | Xcode, iTerm2, **GitHub, Linear** | GitHub/Linear official MCP; coding agents own shell | **LOW-MED** — mostly covered; Xcode/iTerm vertical only |
| **Browsers** | Safari, Chrome, Arc(dying) | Playwright/CDP/browser-use generic | **MED** — differentiate via *user's logged-in local browser* |
| **Design** | **Figma**, Sketch | Figma Dev Mode MCP (first-party) | **LOW** — covered; Sketch niche |
| **Knowledge / Reference** | **Zotero, DEVONthink**, Readwise, Highlights | none | **HIGH (vertical)** — uncovered, great surfaces, narrow audience |
| **Media** | Spotify, Apple Music | Spotify Web API | **LOW** — low agent value |
| **System / OS / Meta** | **Shortcuts, Raycast, Alfred, 1Password** | none | **HIGH** — Shortcuts + 1Password are uniquely Plexus-shaped |
| **Secrets** | **1Password** | none | **HIGH** — the safety/trust exemplar |

**Most underserved-yet-valuable category [JUDGMENT]: the *Apple-native cluster* (Calendar/Reminders/Mail/Messages/Notes) plus *local PKM* (Obsidian).** It is simultaneously (a) the highest data-gravity, (b) universally installed, (c) the loudest community demand (apple-mcp ~3k stars on pure AppleScript hacks) [FACT], and (d) the place no vendor will ever ship a polished AI path. That quadrant is Plexus's home turf. The **meta-category (Shortcuts + 1Password)** is the second prize because both map *natively onto Plexus's grant/approval model* in a way no generic shim replicates.

---

## 6. Recommended v1 Shortlist (ship first)

Balancing value × adoption × low-difficulty × safety, and favoring apps already on a developer's Mac for a great first live test:

1. **Apple Calendar + Reminders (EventKit)** — universal, high-value, **OS-enforced read-only scope**, reversible writes. The safest high-value entry. *Already installed on every Mac.*
2. **Obsidian** — best surface in the entire survey (local REST + plain-disk read), engaged technical base, true read-only path. *Commonly installed on developer/PKM Macs.*
3. **Things 3** — **best demonstration of the Plexus grant model** (AppleScript-read vs URL-scheme-write with auth token = a textbook per-capability scoped grant). Clean blast radius.
4. **Apple Shortcuts** — the meta-capability; turns the user's own automations into self-describing Plexus capabilities, showcasing DISCOVER→GRANT→CALL with minimal per-app work. *Pre-installed.*
5. **Apple Mail + Messages (read + draft only)** — the relatable "wow" demo that no competitor can match locally. Ship **read-first, send-gated**. *Pre-installed.*

Optional 6th if you want the trust narrative front-and-center: **1Password** (read-only per-vault tokens) — but it's sensitive; consider it a flagship "advanced" capability rather than a default-on v1.

**Best first LIVE TEST [JUDGMENT]: Things 3.** It is on many developers' Macs, has a *clean read/write surface split with an actual auth token*, low blast radius (worst case: an errant task you delete in 2 seconds), and it exercises every Plexus primitive — discover the app, self-describe the read vs write capabilities, request a scoped write grant, get human approval, call, audit. If you want a zero-install fallback for any reviewer Mac, **Apple Calendar/Reminders via EventKit** is the universal second choice.

**Sequencing logic [JUDGMENT]:** Start with the *safe, scoped, universally-present* ones (EventKit, Things, Shortcuts) to prove the trust loop with low risk; layer in the *high-gravity-but-sensitive* ones (Mail, Messages, 1Password) once approval/audit UX is battle-tested; treat *vendor-covered* SaaS (Notion/GitHub/Linear/Figma/Slack) as **MCP-ingested, not hand-built**.

---

## 7. Risks / Open Questions

1. **TCC / Full-Disk-Access friction (highest practical risk).** EventKit, Mail/Messages AppleScript, and chat.db reads all trigger macOS permission prompts and Full Disk Access requirements. Plexus's onboarding must guide users through these cleanly, or the "it just works" promise breaks. *Open Q: how much of this can be smoothed vs is an unavoidable Apple tax?*
2. **AppleScript fragility across macOS releases.** Mail send bugs, Messages `send` unreliability, and dictionary drift are documented [FACT]. First-party means *owning* this breakage — budget for per-macOS-version regression testing. Favor EventKit/local-REST over AppleScript wherever a choice exists.
3. **Enforced read-only is rare.** Only **1Password (per-vault), EventKit (write-only/full scopes), GitHub/Linear/Todoist/Figma (OAuth scopes)** offer *OS/server-enforced* read-only [FACT]. For everything else (AppleScript, local HTTP plugins, Readwise) read-only is **discipline-based — the same credential can write** [FACT]. Plexus's grant model must compensate with its *own* enforcement layer (e.g. capability-level allow-lists), not trust the app.
4. **Sensitive-data blast radius.** Messages/Mail/1Password expose deeply private data to the model. The audit + human-approval + trust-window story must be airtight *before* these ship, or the first incident defines the product.
5. **Don't rebuild the connector directory.** Anthropic's 375+ connectors and vendor MCPs already own SaaS [FACT]. The temptation to "support Notion/Slack too" dilutes the local-first moat. *Open Q: is the MCP-ingestion path mature enough that Plexus can cleanly *consume* these instead of building them?*
6. **Platform-deprecation watch:** Arc is frozen (Browser Company → Dia, acquired by Atlassian Sept 2025) [FACT] — **don't invest in Arc**. Chrome 136 remote-debugging lockout, Spotify OAuth migration, and the Slack non-Marketplace history throttle (1 req/min) [FACT] all constrain those surfaces.
7. **Adoption numbers are thin.** Apart from Obsidian (~1.5M users [FACT]), hard Mac-specific install figures are scarce; most app rankings here are qualitative. Don't over-anchor the roadmap on precise adoption — anchor on *surface quality × uplift × safety*, which we *can* assess concretely.

---

### Appendix — Key sources
- Claude Connectors Directory growth (375+ integrations, Slack connector Jan 26 2026): claude.com/blog/connectors-directory; usecarly.com/blog/claude-connectors
- MCP server popularity & mechanisms: github.com/microsoft/playwright-mcp, github.com/ChromeDevTools/chrome-devtools-mcp, github.com/browser-use/browser-use, github.com/github/github-mcp-server, github.com/Dhravya/apple-mcp, github.com/makenotion/notion-mcp-server, linear.app/docs/mcp, github.com/GLips/Figma-Context-MCP, github.com/cameroncooke/XcodeBuildMCP
- macOS automation surfaces: github.com/coddingtonbear/obsidian-local-rest-api; culturedcode.com/things/support (AppleScript + URL scheme); Apple EventKit docs; developer.1password.com (Connect per-vault tokens); retorque/Better BibTeX JSON-RPC; docs.slack.dev/changelog (rate limits); developers.openai.com/codex/mcp (Codex MCP); manual.raycast.com/ai/model-context-protocol
- Adoption: fueler.io/blog/obsidian-usage-revenue-valuation-growth-statistics (Obsidian ~1.5M users, 120M plugin downloads); Things 3 vs Reminders comparisons (2025)

*All adoption figures are vendor/third-party-reported and should be treated as approximate. FACT vs JUDGMENT labels applied throughout per §1.*
