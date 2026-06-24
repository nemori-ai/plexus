# Plexus — Authorization & Transparency UX Model (NORTH STAR)

> Recorded 2026-06-24 from the project owner. This is the directional spec for Plexus's
> authorization/authentication UX going forward. All work below builds toward THIS model.
> Wire stays frozen/additive (protocol 0.1.2); changes are additive + UX.

## 1. The adopting user's mental model (the experience we are selling)
A developer/user meeting Plexus should travel this arc:
1. "What is this — another MCP tool? A local API gateway?"
2. "Oh — it packages my machine's capabilities for an Agent to use. And it's AI-native: from
   the exposed capability set it can generate the matching **skills** and **dynamic workflows**.
   Advanced."
3. "There's substance: beyond compiling capabilities, it has **authn + authz** — give different
   Agents, in different scenarios, different packaged capability sets, each with independent
   authorization."
4. "And **audit** — which Agent did what is crystal clear."

**Transparency is the product.** The trust story (default-deny, per-capability, scoped, legible,
revocable, audited) IS the value, not a tax on it.

## 2. The Agent's two operating modes
An Agent holding a local-access skill (e.g. the Claude Code plugin) operates in one of two modes:

### Mode 1 — Ad-hoc / temporary operations (per-operation approval)
Each operation requests authorization. The approval surface must be legible at a glance:
> "**[Agent X]**, in order to **[purpose Z]**, requests **[capability Y]**.
>  Authorize → the Agent may use it **multiple times within \<trust-window\>**, or **single-use**."
- Today: a web page (the management client).
- Future: a native macOS desktop app with **tray + system notifications** — so approval is one
  glanceable, in-context notification, not a context switch.

### Mode 2 — Systematic / scoped tasks (task pre-authorization)
For a defined task, pre-authorize a **task-scoped permission bundle** to a SPECIFIC task-Agent.
Example: "launch Claude Code to organize one folder on my NAS — but I don't want to authorize the
whole NAS." Plexus:
- constructs a **scoped permission set** from the NAS filesystem API (just that folder's surface),
- grants it directly to that task's Agent,
- hands the Agent **in-scope context** (what's in the folder, the desired organization style/
  conventions, etc.),
so the Agent completes the task **without re-requesting authorization each step**.
**Confinement:** the Agent either (a) cannot SEE any out-of-scope API, or (b) even if it sees one,
any call outside the pre-authorized scope behaves like Mode 1 — it pops a notification/approval.

## 3. The core shift (what must change)
When an Agent accesses an API, **what it fills in must get richer**, so the user sees at a glance
**WHICH Agent** and **WHY it needs this API** (its declared purpose/intent) — instead of a bare
"awaiting approve" dialog. The grant request carries intent; the approval surface renders it.

## 4. Identity posture (resolves board decision `duser-identity`)
The **connection-key remains the trust boundary** (local, single-user). `agentId` is meaningful for
**scoping, confinement, audit, and transparency** — which is exactly what this model needs — NOT as
cryptographic authentication. True per-agent cryptographic identity stays a later option, not the
current focus. (Optional cheap hardening still available: bind standing grants to the connection-key
epoch so rotation drops them.)

## 5. Mapping to today's Plexus — DONE vs NEW
**Already shipped (v0.5.0-rc.1):**
- Per-capability scoped grants keyed by agentId; default-deny + scope-confined invoke.
- Trust-window (once vs duration) = the "single-use vs multi-use within \<window\>" choice.
- Gateway-authored pending narration; provenance/sensitivity; Grants view; revoke; audit (JSONL).
- AI-native generation: capability set → skills + dynamic workflows (M4).
- Managed sources (add/scan/hot-reload).

**NEW work toward the north star:**
- **N1 — Agent-declared purpose/intent** on the grant request (`reason`/`purpose`), surfaced in the
  approval UI alongside the gateway narration: "who + why".
- **N2 — Transparent approval presentation**: agent identity + declared purpose + capability + the
  multi-use-within-window vs single-use choice, all glanceable (web now; native notification later).
- **N3 — Scoped task pre-authorization**: a task-scoped capability/permission BUNDLE granted to a
  specific agent, with attached in-scope CONTEXT, so the agent runs a whole task without re-prompts.
- **N4 — Per-agent capability visibility/confinement**: an agent discovers only its granted scope;
  out-of-scope access falls back to Mode-1 approval (default-deny already holds at invoke; the NEW
  part is discovery/visibility scoping per agent/task).
- **N5 (future)** — native macOS tray app with system notifications for approvals.

This document is the reference; the concrete additive design + build plan derives from it.
