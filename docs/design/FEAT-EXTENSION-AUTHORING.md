# Plexus — Agent-Driven Extension Authoring ("用嘴造扩展") — FEATURE DESIGN (DESIGN ONLY)

> Status: **design** · Date: 2026-06-24 · Owner refinement **R2** in
> [`REDESIGN-PLAN.md`](./REDESIGN-PLAN.md) §"Owner refinements" ·
> Builds on SHIPPED work — this designs the **connective tissue**, it does NOT
> reinvent the authoring engine.
>
> **The feature, in the owner's words:** *"Launch a cc/codex loaded with a 'create
> Plexus extension/plugin' capability, then the user can build their own
> extension/plugin conversationally ('用嘴') and install it into their local Plexus
> instance."* I.e. **talk to an agent → it scaffolds + registers a new extension for
> you.** Surfaced as a **"Create / author an extension"** affordance under
> **WHAT I EXPOSE** in the redesigned admin (it reserves the home P3 left for it).
>
> **The thesis (inherited):** *Transparency is the product.* "用嘴造扩展" must not
> become "用嘴授权" — an agent that can author an extension is an **untrusted-input
> path**; the human stays the approver of every install and every grant.
>
> **Design-only:** journey, reuse map, install path, security, launch mechanism,
> surfacing, decisions, phasing. No code.

---

## 0. Why this is distinctive (and what it is NOT)

Most "gateways" let you *configure* a static integration. Plexus's pitch (§AUTHZ-UX
arc beat 2) is that it is **AI-native** — *"from the exposed capability set it can
generate the matching skills and workflows."* R2 takes the next step: the **user
authors a brand-new capability surface by talking to an agent**, and it lands in the
same governed, default-denied, audited registry as a first-party source. The agent
does the typing; the human does the *deciding*.

This is **not**: an agent silently gaining new powers; an MCP-style "just paste a
server URL"; an in-process/gateway-owned extension (those are first-party only, §5
DECISION-2). It **is**: the M4 meta-skill scaffolder, *launched from the desktop*,
*installed through the LRA*, *pending for human approval*, *surfaced as a managed
source whose caps are dark until granted*.

---

## 1. THE END-TO-END USER JOURNEY ("用嘴 → installed")

### 1.1 The arc in one line

```
 desktop affordance  →  launch agent (cc/codex) preloaded with the authoring skill
   →  conversational build (interview + M4 generator)  →  preview & validate
   →  install into local Plexus via the LRA (POST /extensions)  →  PENDS for human
   →  human approves the registration  →  new SOURCE + capabilities appear,
      default-DENIED until separately granted  →  human grants the caps to an agent
```

Two human gates, never one: **(G1) approve the registration** (does this code/route
get to exist in my registry at all?) and **(G2) grant the capability** (may *this
agent* use it, with which verbs, for how long?). Authoring an extension crosses G1;
it gives the new caps **zero standing trust** — they are dark until G2.

### 1.2 Worked example — "I want a capability that reads my Linear issues"

```
 ┌─ Admin ▸ WHAT I EXPOSE ▸ Sources ──────────────────────────────────┐
 │  [ + Add source ]                  [ ✦ Create an extension… ]       │  ← the R2 affordance
 └────────────────────────────────────────────────────────────────────┘
```

**Step A — launch.** User clicks **✦ Create an extension…**. Plexus launches a
**cc/codex session preloaded with the `create-extension` meta-skill** (the launch
mechanism — §4) and a short task seed: *"Help me author a Plexus extension. Interview
me, scaffold it with the plexus-ext generator, validate it, then register it."* The
agent already has the `use-plexus` integration on PATH (it is a connected agent), so
it can reach the running gateway over loopback.

**Step B — converse.** The user types, in the agent's chat:

> "I want a capability that reads my Linear issues."

The meta-skill runs its interview (SKILL.md Steps 0–7):
- *Step 0* — probes `GET /.well-known/plexus` (the gateway is up), reads
  `EXTENSION-SPEC.md` so the manifest is anchored to the contract.
- *Step 1* — "What's the action and its outcome?" → `issues.list`, describe:
  *"Lists your Linear issues by team/state. Use when the user asks about their Linear
  backlog."*
- *Step 2 — transport.* Linear is an HTTPS API, not localhost. The meta-skill's
  decision rule (§Step 2) does **not** offer `mcp` and **refuses** a non-loopback
  `local-rest` host (the SSRF floor). It picks the **`cli` transport** wrapping the
  user's installed `linear` CLI (bare bin, resolved with `which linear`) — OR, if
  there is no CLI, a `local-rest` route through a **loopback proxy** the user runs.
  (A direct-to-`api.linear.com` extension is **out of scope by construction** — the
  loopback floor; the agent surfaces this honestly rather than smuggling it.)
- *Step 3 — verbs.* Reads only → `grants:["read"]` (the minimal default).
- *Step 4 — secret.* A `LINEAR_API_KEY` **reference** (`{name, attach:"env"}`); the
  agent writes `secrets.README.md` telling the user to provision the *value* into
  `~/.plexus/secrets/` out of band. The value never enters the manifest.
- *Step 5–6* — I/O schema (`{ team?, state? }`) + a bundled **usage skill**
  (`issues.list.how-to-use`) scaffolded by default and back-linked via
  `route.attachSkills`.

**Step C — generate.** The agent runs the generator (never hand-writes JSON):

```
bun plugins/plexus-ext/lib/cli.ts generate linear.spec.json
```

It emits `plexus-extensions/linear/{manifest.json, skills/issues.list.how-to-use.md,
register.sh, README.md, secrets.README.md}` and **refuses to write if
`validateExtension` fails**. The agent shows the user the `manifest.json` + the usage
skill markdown for review/edit.

**Step D — preview & validate.** The desktop shows a **preview panel** (§5.2): the
source id `linear`, the one capability `linear.issues.list` `[read]`, its describe,
its secret reference, its bundled skill — and a green **"PASS — will pass the
gateway's `validateRegistration`"** badge (the generator's pre-validate mirrors the
gateway's §13 checklist). If the user edits, re-validate.

**Step E — install (cross G1).** The agent runs `register.sh`, which `POST`s the
manifest to the LRA (`POST /extensions` with a live handshake `sessionId`). Because
this carries a transport (`cli`) it is **transport-backed → it PENDS** (handlers.ts
§(2) `makeRegisterPending`). The desktop fires a **native registration-approval
notification**:

```
 ┌ Plexus ────────────────────────────────────────────┐
 │ An agent wants to REGISTER a new extension:         │
 │ “linear” — 1 capability · cli bin: linear           │   ← the security surface
 │ ⚠ runs a local binary · reads a secret              │
 │ [ Review registration… ]              [ Deny ]      │   ← registrations NEVER 1-tap
 └─────────────────────────────────────────────────────┘
```

**Step F — human approves (G1).** The user opens the Review (it is the existing
**Approvals ▸ Registrations** card, §5.3): cli bins (`linear`), rest hosts (none),
cross-source attach (none), the verbs, the secret ref. They approve → the pending
callback runs `registerExtension(manifest)` (which **re-validates** before commit, so
nothing slips past unconfirmed) → the module materializes, `scan()`s, bumps the
revision, emits `manifest_changed`.

**Step G — it appears, default-DENIED.** **Sources** now lists `● linear · cli ·
extension · 1 capability`. **Capabilities** lists `linear.issues.list [read] ·
extension · — granted to no one`. Its bundled skill shows as an attached skill. The
capability is **dark until granted** — the journey ends with a **"Grant to…"** CTA
(cross G2, the normal grant composer). Authoring added a *capability*, not an
*authorization*.

> **The full arc the user felt:** they *talked* to an agent, it *built* the
> extension, they *previewed* it, *approved its existence once*, and now *separately
> decide* who may use it — exactly the AUTHZ-UX-MODEL arc (packages caps → AI-native
> generation → per-agent authz → audit), extended to user-authored caps.

---

## 2. REUSE MAP — M4 scaffolder (reuse) vs NEW connective tissue

The authoring **engine already exists and ships**. This feature is almost entirely
*plumbing around it*. Be ruthless about reuse.

| Concern | REUSE (shipped) | NEW (connective tissue) |
|---|---|---|
| Interview → spec → manifest | **`plugins/plexus-ext/` meta-skill** (`SKILL.md` + `lib/generate.ts` `generateManifest` + `lib/cli.ts`). Secure-defaults-by-construction. | — |
| Pre-register validation | **`validateExtension`** (mirrors gateway §13). | — |
| Scaffold artifacts on disk | **`plexus-extensions/<source>/{manifest,skills,register.sh,README,secrets.README}`** (cli.ts). | A chosen **artifacts root** (§6 DECISION-4) so desktop can find/preview them. |
| Install over the wire | **`register.sh` → `POST /extensions`** (LRA); **`registerExtension`/`validateRegistration`** in the registry. | The desktop wiring that *triggers* the install and *surfaces its pending state* via the LRA push channel. |
| Pend-for-approval | **`makeRegisterPending` + `UserConfirmAuthorizer`** (handlers.ts §(2); the M4 security linchpin). | A native **registration-approval notification** (reuses the §5.3 Approvals ▸ Registrations card). |
| Surfacing the result | **Sources / Capabilities / Activity** views; `manifest_changed` event; default-deny. | A **"Create an extension" affordance** + **launch + preview** sub-flow + a **post-install "Grant to…" handoff**. |
| Agent reaching the gateway | **`use-plexus` integration** (CLI on PATH, loopback handshake). | A **launch mechanism** that *also* preloads the **`plexus-ext` authoring plugin** into that agent session (§4). |

**One-line split:** *the brain (interview + generate + validate + register + pend) is
100% M4 + the shipped registry; the new code is a **launcher**, a **preview/approve
surface**, and the **affordance** that ties them to the desktop.*

What is explicitly **NOT** new: the manifest schema, the secure-default refusals
(no shell cli bins, loopback-only rest, secret references only), the validation
rules, the register endpoint, the pending machinery, the grant model. Re-deriving any
of these would be a regression against frozen, security-reviewed contracts.

---

## 3. THE INSTALL PATH + SECURITY (the heart of the feature)

### 3.1 How the authored extension reaches the runtime

```
 agent session                       LRA (loopback runtime)               registry
 ─────────────                       ──────────────────────               ────────
 generate.ts → manifest.json
 register.sh ──POST /extensions──►  handlers.extensions (handlers.ts)
   { sessionId, manifest }           (1) Host/Origin guard (ADR-016)
                                      (2) validateRegistration(manifest)   ──► §13 rules,
                                          ok? ──no──► ok:false + reason          first-party-id
                                          │                                      reservation,
                                          ▼                                      cross-source-off,
                                      (3) buildRegisterSurface                   workflow walk
                                          (cli bins / rest hosts / verbs)
                                      (4) TRANSPORT-BACKED? ──► makeRegisterPending(…, ()=>registerExtension)
                                          │                     ↳ PENDS for human (G1)
                                          │                     ↳ on APPROVE: registerExtension()
                                          │                        RE-validates, then materializes +
                                          │                        scan() + revision bump + manifest_changed
                                          ▼
                                      pure skill/workflow only (no transport)
                                          ──► commit directly (still default-deny at G2)
```

The path is **identical to any extension install** — authoring buys no special lane.
This is the security argument's foundation: there is *one* install path, it is the
one already reviewed for the extension ecosystem, and the agent's authored manifest
goes through it like any other. The LRA reuse is also literal: `POST /extensions` is
already part of the runtime↔client contract (REDESIGN-ARCHITECTURE §2, the protocol
plane LRA includes by reference).

### 3.2 The threat model — *the agent is an untrusted-input path*

An agent authoring an extension is, by construction, **untrusted input** (its prompt
may be poisoned; it may try to over-scope; it may be coaxed into smuggling egress).
The defenses are **layered and pre-existing** — this feature must not punch through
any of them:

1. **Pre-validate (M4 generator).** `generateManifest` **refuses to even emit** a
   shell/absolute/metachar cli bin, a non-loopback rest URL, or an embedded secret
   value. The agent literally cannot scaffold these — the generator throws.
2. **Re-validate at the gateway (`validateRegistration`).** The wire register is
   **untrusted** (`isTrusted` false — no handlers supplied), so it is subject to:
   - **first-party-id reservation** — cannot register under a reserved source id
     (no `obsidian`/`cc-master` impersonation),
   - **cross-source attach OFF by default** — a skill cannot attach onto *another*
     source's capability (the prompt-injection channel) without an explicit
     `allowCrossSource` + user-confirm,
   - the **§13 conformance checklist** (shape/size/secret-name/workflow-graph),
   - **cli-bin hard-deny** + **loopback-only rest** at the transport-policy floor —
     enforced again at *dispatch*, so even a manifest that lied cannot egress.
3. **Pend for the human (G1, the linchpin).** Transport-backed registrations
   **PEND** (`makeRegisterPending`); `registerExtension` runs **only on approve**,
   and the commit **re-validates** so an approval cannot smuggle a changed manifest.
   The **registration card surfaces the security surface verbatim** — cli bins, rest
   hosts, cross-source attach, verbs — so the human decides with the risky bits in
   front of them. **Registrations are never one-tap** (UX invariant, REDESIGN-PRODUCT-UX
   §1.2(b)/§2.3).
4. **Default-deny after install (G2).** A registered capability has **zero standing
   trust**. It is dark until the human grants it to a specific agent for a specific
   trust-window — the normal grant gate, unchanged. So even an *approved-by-mistake*
   extension can do nothing until separately granted, and every use is audited.
5. **Invoke-time floors.** `io.input` schema validation, grant/verb scope-check,
   session liveness, jti revocation — an authored extension "gains NO privileged
   path" (EXTENSION-SPEC §9). A secret stays a *reference*; the value is provisioned
   out of band by the human into the OS keychain.
6. **Audit.** `source.install` is audited at reject/pending/commit; every later
   invoke is audited like any call.

**The one-sentence security claim:** *An agent can author and submit an extension,
but it cannot install a privileged one and cannot grant itself anything — the human
approves the registration (G1, with the risky surface shown) and separately grants
each capability (G2, default-deny), and every transport floor (no shell bins,
loopback-only egress, secret references) is enforced by the generator AND re-enforced
by the gateway AND re-enforced at dispatch.* "用嘴造扩展" never becomes "用嘴授权".

### 3.3 Residual risks & mitigations (called out honestly)

| Risk | Mitigation |
|---|---|
| Human rubber-stamps the registration without reading the cli bin/rest host. | The card leads with the **risky surface** (cli bins / rest hosts / cross-source) and a ⚠ chip; registrations are never one-tap; narration ("Plexus says") explains the blast radius separate from the agent's purpose ("the agent says"). |
| Bad/misleading **usage-skill body** (a `kind:"skill"` is read-as-context). | A skill adds **zero authority** (`grants:[]`, never invocable); worst case is bad advice the user reviews in the preview before approving (USER-AUTHORING-DESIGN A.5). |
| Agent picks an over-broad verb. | Generator defaults to `["read"]` and emits a **warning** on `write`/`execute`; the verbs are shown at G1 and again at every G2 grant. |
| Agent wants raw internet egress (e.g. `api.linear.com`). | **Refused by construction** (loopback-only). The honest path is a user-run loopback proxy or a local CLI — surfaced to the user, not smuggled. |
| Secret value leakage. | Manifest carries **references only**; `register.sh` embeds **no token/key** (reads `sessionId` from env); value lives in `~/.plexus/secrets/` (keychain). |
| Re-register replaces a module silently. | Re-register is still a **register → PENDS (G1)** — a replacement is approved like a fresh install; the module diff is in the card. |

---

## 4. THE LAUNCH MECHANISM (how the desktop launches the authoring agent)

The desktop must start an agent session that has **both** (a) the `use-plexus`
integration (to reach the gateway) and (b) the **`plexus-ext` authoring meta-skill**
(to interview + generate). Three options:

**Option L1 — One-shot CLI invocation with the plugin loaded (RECOMMENDED).**
The desktop shells out to the user's installed agent CLI with the `plexus-ext` plugin
on its plugin path and a seed prompt, e.g. conceptually:
`claude --plugin plexus-ext "Author a Plexus extension with me…"` (or the codex
equivalent via its `AGENTS.md` + skill load). The session opens in a terminal/embedded
pane the user converses in.
- **Pros:** maximal reuse — it is *literally the meta-skill running in a real agent*;
  zero new authoring logic; works for both cc and codex via the existing shims; the
  agent reaches the gateway through the same loopback CLI it always uses.
- **Cons:** requires the agent CLI installed + the plugin discoverable; the
  conversation lives in the agent's UI, not Plexus's (Plexus observes via the LRA
  push channel — it sees the `source.install` pending when register fires).
- **Why recommended:** it honors "launch a cc/codex loaded with a capability" *to the
  letter*, and it keeps Plexus out of the business of re-hosting a chat UI.

**Option L2 — Reuse the integration shims as a managed launch.**
Extend the per-agent integration (the `use-plexus` plugin) to also ship/enable the
`plexus-ext` skill, and have the desktop just deep-link "open your agent and run
*create-extension*". Lower control, but lowest build cost — good as a **fallback when
Plexus cannot spawn the agent itself** (e.g. the user prefers their own terminal).

**Option L3 — A guided in-app flow (Plexus hosts the conversation).**
Plexus embeds a chat surface and drives the meta-skill via the Agent SDK in-process.
- **Pros:** seamless single-app UX; Plexus controls the whole flow and preview.
- **Cons:** re-hosts an agent runtime inside the desktop; couples to a model/SDK;
  duplicates what the agent CLIs already do; highest build + maintenance cost.
- **Verdict:** a **later polish**, not the first cut. The R2 phrasing ("launch a
  cc/codex") points at L1.

**RECOMMENDATION: ship L1 (one-shot launch of the user's cc/codex with the
`plexus-ext` plugin + a seed prompt), with L2 as the no-spawn fallback, and L3
deferred** as an optional in-app experience once the seam is proven. In all three,
the *authoring engine and the install path are identical* — only the launch host
differs. The desktop's job is launch + observe (LRA push) + preview + surface the G1
approval; it never re-implements the generator.

---

## 5. SURFACING (the affordance, the preview, the result)

### 5.1 The "Create an extension" affordance (WHAT I EXPOSE)

Per R2, it lives under **WHAT I EXPOSE** (the supply side). Concretely:

```
 SOURCES                                  [ + Add source ]   [ ✦ Create an extension… ]
 ─────────────────────────────────────────────────────────────────────────────────────
  ● obsidian   …    ● nas   …    ● linear · cli · extension · 1 cap   (newly authored)
```

- **Distinguished from "Add a source":** Refinement R1 insists the UI separate
  "expose a capability" from "install an integration into an agent." "Create an
  extension" is squarely the **expose** side — it is "author a *new* source by
  talking to an agent," a sibling of "+ Add source," not an agent-install. Copy:
  *"Build a new capability by describing it to an agent — Plexus scaffolds, validates,
  and (with your approval) installs it."*
- Also reachable from **Capabilities** ("don't see what you need? **Author it…**")
  and as an **onboarding "Needs you" nudge** once the core arc is felt.

### 5.2 Progress & preview (during authoring)

While the agent session runs (L1), the desktop shows a lightweight **companion panel**
fed by the LRA push channel + the artifacts root:

```
 ┌ Authoring: linear ───────────────────────────────────────────┐
 │ ◌ Agent is interviewing you…  (converse in the agent window)  │
 │ ✓ Scaffold written: plexus-extensions/linear/                 │
 │ ─────────────────────────────────────────────────────────────│
 │ PREVIEW (from manifest.json)                                  │
 │  source: linear · transport: cli                              │
 │  • linear.issues.list  [read]   "Lists your Linear issues…"   │
 │    ↳ bundled skill: issues.list.how-to-use                    │
 │    ↳ secret ref: LINEAR_API_KEY (env) — provision out of band │
 │  ✓ PASS — will pass the gateway's validateRegistration        │
 │ ─────────────────────────────────────────────────────────────│
 │  [ Install (will ask you to approve) ]      [ Discard ]       │
 └───────────────────────────────────────────────────────────────┘
```

The preview is a **read view of the generated manifest** (+ the validator's PASS/FAIL
and warnings) — Plexus does not re-derive anything. "Install" triggers `register.sh`
(or the user lets the agent run it); either way it lands at G1.

### 5.3 The result (post-install) — new source/caps + a path to grant

On approve (G1), `manifest_changed` fires and the desktop updates:
- **Sources** gains `● linear · extension`.
- **Capabilities** gains `linear.issues.list [read] · extension · — granted to no
  one`, with its attached skill shown (the AI-native artifact beat, quantified in
  Dashboard ▸ Exposure health).
- **Activity** logs `source.install … committed`.
- A **success toast** with the **handoff to G2**: *"`linear.issues.list` is
  installed and default-denied. **Grant it to an agent →**"* opening the normal grant
  composer pre-scoped to the new cap.
- **Approvals ▸ Registrations** keeps the record (the security surface preserved
  verbatim — REDESIGN-PRODUCT-UX §2.3).

The artifacts (`plexus-extensions/linear/`) are the user's **versionable, editable**
copy (META-SKILL-DESIGN §4): they can re-open, edit the manifest/skill, re-validate,
and re-register (which re-PENDS at G1).

---

## 6. DECISIONS (each with a recommendation)

**DECISION 1 — Launch mechanism.**
→ **Recommend L1: one-shot launch of the user's cc/codex with the `plexus-ext`
plugin + a seed prompt**, L2 (deep-link, no-spawn) as fallback, L3 (in-app chat)
deferred. Rationale: it *is* the R2 phrasing; maximal reuse of the shipped meta-skill
and integration shims; Plexus observes via the LRA push channel and owns only
launch/preview/approve.

**DECISION 2 — Authored extensions are transport-backed (manifest-only), NEVER
in-process.**
→ **Recommend: user-authored = transport-backed only** (`local-rest`/`cli`/`stdio`/
`ipc`/`skill`/`workflow`). The in-process `handler` channel is **gateway-owned by
construction** (EXTENSION-SPEC §9.2; `route.handler` is stripped over the wire; the
meta-skill never offers it). Rationale: in-process handlers are arbitrary code in the
gateway's address space — they must stay first-party, gateway-tested. A user "用嘴"
extension is **declarative + sandboxed-by-transport** (loopback egress, hard-denied
shell bins), so its blast radius is contained by the transport floors, not trust in
the agent. This is the single most important safety decision.

**DECISION 3 — How much the agent automates vs the human confirms.**
→ **Recommend: agent automates everything up to the wire; the human confirms at the
two gates.** The agent interviews, generates, validates, and *submits* the register —
but **G1 (registration approval) and G2 (per-cap grant) are always human**, and
neither is one-tap for the risky surface. The agent's `--purpose`/narration is shown
("the agent says") isolated from the gateway's narration ("Plexus says"). Never let
the agent both author *and* silently grant — that is the anti-self-grant linchpin.
Optionally allow a **"trusted authoring" express lane** *only* for pure
skill/workflow (zero-new-authority) extensions, which already commit directly when
they carry no transport — but still surface them in Activity.

**DECISION 4 — Where the generated artifacts live.**
→ **Recommend: a Plexus-managed artifacts root the desktop owns**, e.g.
`~/.plexus/authored/plexus-extensions/<source>/`, passed to the agent as the
generator's `outDir`. Rationale: the desktop must reliably **find** the manifest to
preview it and offer re-edit/re-register; the META-SKILL default (the user's cwd)
is right for a standalone CLI author but not for a desktop that needs a known
location. Keep them **user-owned + versionable + editable** (not buried in opaque
state); offer "reveal in Finder" + git-friendliness. (Secret *values* still go to
`~/.plexus/secrets/` — never the artifacts dir.)

**DECISION 5 — Egress posture for "remote API" capabilities (the Linear case).**
→ **Recommend: keep the loopback-only floor; offer two honest paths** — (a) wrap a
**local CLI** (`cli` transport, bare bin), or (b) a **user-run loopback proxy**
(`local-rest` to `127.0.0.1`). **Do not** add a "trusted remote host" allow-list for
user-authored extensions in v1 (it reopens the SSRF/secret-redirect surface the floor
exists to close). The agent surfaces this constraint plainly rather than smuggling a
remote URL.

**DECISION 6 — Surfacing home + relationship to "Add source".**
→ **Recommend: a sibling affordance under WHAT I EXPOSE ▸ Sources** ("✦ Create an
extension…"), distinct from "+ Add source" (R1's expose-vs-install distinction), with
secondary entry from Capabilities and an onboarding nudge. Post-install, route the
user to **Grant to…** (G2). Rationale: authoring *is* exposing a new source; placing
it there teaches the model by IA, consistent with REDESIGN-PRODUCT-UX §2.2.

---

## 7. PHASED BUILD PLAN (post-core feature; reuse M4 maximally)

Depends on: **REDESIGN P0–P2** (sidecar + LRA push channel + new Admin IA with
Approvals ▸ Registrations) and the **shipped M4 `plexus-ext` plugin**. This is a
**post-core-desktop** feature (R2 says so); it reserves a home in P3 and lands after.

| Phase | Scope | Reuse | Effort | Depends on |
|---|---|---|---|---|
| **A0 — Affordance + manual end-to-end (prove the path)** | Add the **"✦ Create an extension…"** entry under Sources; wire it to **L2** (deep-link "open your agent, run create-extension"); ensure the **registration-approval notification + Approvals ▸ Registrations card** render the security surface; confirm the full G1→G2 arc with the *existing* meta-skill + register.sh. | M4 plugin, `POST /extensions`, `makeRegisterPending`, Approvals card. | **S** | REDESIGN P1 (notifications) + P2 (Approvals). |
| **A1 — Launch (L1) + preview panel** | Desktop **spawns** the user's cc/codex with the `plexus-ext` plugin + seed prompt; companion **preview panel** reads the generated `manifest.json` from the **artifacts root** (DECISION-4) and shows the validator PASS/FAIL; "Install" + post-install "Grant to…" handoff. | M4 generator/validator output; LRA push (`source.install` events). | **M** | A0; agent-CLI launch primitive. |
| **A2 — Polish + guardrails surfacing** | Make the **threat-model legible** in the UI (cli-bin/rest-host/secret chips, narration); re-edit/re-register loop from the panel; "reveal artifacts"; onboarding nudge; Dashboard ▸ Exposure-health counts authored caps. | Validator warnings; Activity; Dashboard tiles. | **S–M** | A1. |
| **A3 (optional) — In-app authoring (L3)** | Embed a chat surface driving the meta-skill via the Agent SDK in-process, for a single-app experience. **Only if** demand justifies hosting an agent runtime in the desktop. | The meta-skill prompt + generator (unchanged). | **L** | A1/A2; an in-app agent host. |

**Sequencing rationale:** A0 proves the *whole security-critical path works with zero
new authoring code* (the riskiest assumption — that the shipped pieces compose). A1
adds the launch + preview that make it feel like one product. A2 makes the safety
*visible*. A3 is a UX luxury, gated on real demand, never on the security model.

---

## EXEC SUMMARY (~20 lines)

**The journey.** From the desktop's **"✦ Create an extension…"** (under WHAT I
EXPOSE), Plexus launches a cc/codex session preloaded with the shipped **`plexus-ext`
meta-skill**. The user describes a capability in plain language ("read my Linear
issues"); the agent interviews, scaffolds a spec-compliant `ExtensionManifest` via the
M4 generator, validates it, and submits it to the local runtime over the LRA. The
human **approves the registration once (G1)**, then the new source/capabilities appear
**default-denied** until the human **separately grants** them to an agent (G2).

**Reuse vs new.** The *brain* is 100% reuse: the M4 `plexus-ext` interview + generator
(`generateManifest`) + pre-validator (`validateExtension`) + `register.sh` →
`POST /extensions` + the registry's `validateRegistration`/`registerExtension` +
`makeRegisterPending` pending. **NEW = connective tissue only:** a **launch
mechanism** (spawn cc/codex with the plugin), a **preview/approve surface**, the
**desktop affordance**, and a **post-install "Grant to…" handoff** — no schema, no
validation, no install lane re-invented.

**Security (用嘴 ≠ 用嘴授权).** An authoring agent is **untrusted input**, so the same
floors apply: the generator **refuses** shell cli bins / non-loopback egress /
embedded secrets; the gateway **re-validates** (first-party-id reservation,
cross-source-attach-off, §13 checklist, cli/loopback hard-deny at dispatch); the
install **PENDS for the human (G1)** with the risky surface shown and **re-validates
on commit**; the result is **default-denied (G2)**; everything is audited. The agent
cannot silently install a privileged extension and cannot grant itself anything.

**Decisions (recommendations).** (1) Launch = **L1 one-shot cc/codex + `plexus-ext`
plugin**, L2 fallback, L3 deferred. (2) Authored = **transport-backed only, never
in-process** (in-process stays gateway-owned). (3) Agent automates to the wire; the
**human confirms at G1 + G2**, never one-tap for risky surface. (4) Artifacts in a
**Plexus-managed root** (`~/.plexus/authored/…`), user-owned + editable. (5) Remote
APIs stay **loopback-only** (local CLI or loopback proxy; no remote allow-list). (6)
Affordance is a **sibling of "+ Add source"** under WHAT I EXPOSE, distinct from
agent-install.

**Phases.** **A0** affordance + manual end-to-end (prove the path with the shipped
meta-skill; effort S) → **A1** spawn-launch + preview panel (M) → **A2** guardrail
surfacing + re-edit loop (S–M) → **A3** optional in-app authoring (L, demand-gated).
Depends on REDESIGN P0–P2 + the shipped M4 plugin; it is a post-core feature that
reserves its P3 home and lands after.
