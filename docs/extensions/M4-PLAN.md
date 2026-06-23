# Plexus M4 — Implementation Plan (the extension ecosystem)

> Status: **M4 foundation plan** · Builds on: v0.1.1 (138 tests green) ·
> Artifacts: [`EXTENSION-SPEC.md`](./EXTENSION-SPEC.md),
> [`META-SKILL-DESIGN.md`](./META-SKILL-DESIGN.md),
> [`USER-AUTHORING-DESIGN.md`](./USER-AUTHORING-DESIGN.md) · Date: 2026-06-23
>
> M4 adds three things on top of the shipped gateway: a **public extension spec**
> (done — the doc), a **Claude Code meta-skill** that scaffolds spec-compliant
> extensions, and **user-defined custom skills + dynamic workflows**. This plan
> breaks the build into parallelizable tasks with file-ownership boundaries and an
> honest-green verification approach. **Discipline: build on what exists; prefer
> additive protocol changes; flag any genuine fork for human ratification.**

---

## 1. Principle: almost everything is additive or doc/skill work

The big de-risking finding from the surface review: **the wire is already
sufficient** for the core of M4. `ExtensionManifest`, `registerExtension`,
`materializeExtension`, `WorkflowTransport`, `TransitiveGrant`, `AttachedSkillRef`,
and `POST /extensions` all ship. The meta-skill and user-authoring are largely:
(1) a Claude Code plugin skill (no gateway change), (2) author-tool validation that
mirrors rules already implied by the types, and (3) two small **additive**
gateway-side enhancements (cross-source skill attach; anti-cycle + present-member
validation; optional unregister). The frozen `src/protocol/types.ts` is **not**
edited by M4 except via the explicitly-proposed v0.2 additions in §4 (gated on human
ratification).

---

## 2. Tasks (parallelizable) with file-ownership boundaries

Four work-streams. The ownership boundaries are drawn so they can be built
**concurrently without file collision**. Shared types/contracts are read-only to all
but their owner.

### T-A · CC meta-skill plugin (`plexus:create-extension`)
**Owns (new files only):**
- `plugins/plexus-ext/.claude-plugin/plugin.json`
- `plugins/plexus-ext/skills/create-extension/SKILL.md`
- `plugins/plexus-ext/skills/create-extension/templates/*.json`, `usage-skill.md`
- (optional) a tiny manifest validator the skill calls — `plugins/plexus-ext/skills/create-extension/validate.ts` (Bun, standalone; imports the published spec rules, NOT gateway internals).

**Does NOT touch:** `src/**`, the gateway types, the gateway tests. It exercises the
gateway ONLY over the published wire (`/.well-known`, `/link/handshake`,
`/extensions`). Per META-SKILL-DESIGN.

**Deliverable:** running `/plexus-ext:create-extension` interviews → scaffolds →
validates → registers a `local-rest` and a `cli` extension end-to-end against a live
gateway.

### T-B · User custom-skill support
**Owns:**
- `src/sources/extension.ts` — extend `manifestEntries()` (and a registry hook) to
  resolve **cross-source** `route.attachTo` back-links (the additive enrichment,
  USER-AUTHORING §A.3 / §D). Same-manifest `attachSkills` already works.
- `src/core/capability-registry.ts` — the refresh/register path that applies the
  cross-source attach enrichment after the entry set is aggregated (so a skill can
  attach onto an entry from any source, resolved post-aggregation).
- New tests: `tests/user-custom-skill.test.ts`.

**Does NOT touch:** the meta-skill plugin, the workflow validation (T-C), the demo
(T-D) except via shared fixtures it adds.

**Deliverable:** register a `kind:"skill"` extension whose body attaches onto an
existing (foreign-source) capability; assert the target entry gains the
`AttachedSkillRef` and the skill is discoverable + non-invocable.

### T-C · User dynamic-workflow support
**Owns:**
- `src/core/capability-registry.ts` — **register-time workflow validation** (present
  members, `verbs ⊆ member.grants`, **anti-cycle** graph check) added to
  `registerExtension` (USER-AUTHORING §B.4 / §D). Reject invalid workflows with
  `ok:false` + a precise `reason` (no wire change; uses the existing
  `ExtensionRegisterResponse.reason`).
- New tests: `tests/user-dynamic-workflow.test.ts`.

**Coordination with T-B:** both touch `capability-registry.ts`. **Boundary:** T-B
owns the *attach-enrichment* function + its call-site; T-C owns the
*workflow-validation* function + its call-site inside `registerExtension`. They are
distinct functions in distinct regions of the file; integrate via one short merge
(sequence T-B then T-C, or each adds its function and a single shared insertion point
is reconciled at the end). If true parallelism is needed, T-C can land its validator
in a new `src/core/workflow-validate.ts` and `registerExtension` calls it — that
removes the shared-file overlap entirely. **Recommended: T-C uses a new
`workflow-validate.ts` so T-B and T-C never collide.**

**Deliverable:** register a user workflow composing two present capabilities; grant
it and assert the synthesized transitive member scopes appear on the token; invoke
it and assert the `WorkflowTransport` really fans out to both members (each a genuine
leaf). Assert a dangling-member workflow and a cyclic workflow are **rejected**.

### T-D · E2E demo (the honest-green proof)
**Owns:**
- `examples/m4-demo/run.ts`, `examples/m4-demo/demo.ts` (mirrors the existing
  `examples/e2e-demo/` structure).
- `tests/m4-demo.test.ts` — asserts the genuine facts of each M4 scenario.

**Does NOT touch:** `src/**` business logic (consumes it), the meta-skill plugin
internals (it may invoke the skill's validator as a library, or just drive the wire).

**Deliverable:** one boot-a-real-gateway demo that runs all three M4 capabilities
end-to-end over the published wire, exits `0` iff every scenario genuinely passes.

### Dependency / sequencing
- T-A is **independent** of T-B/T-C (it only uses the wire). Can start immediately
  and in parallel.
- T-B and T-C are independent if T-C uses `workflow-validate.ts` (recommended).
- T-D depends on T-B + T-C landing (it asserts their behavior) and can consume T-A's
  scaffold output as a fixture.

```
T-A (meta-skill plugin) ───────────────────────────┐
T-B (custom-skill enrich) ──┐                       │
T-C (workflow validate) ────┴──► T-D (e2e demo, honest-green) ─► M4 green
```

---

## 3. Verification approach — honest green

Mirror the shipped `DEMO.md` discipline exactly: **nothing staged, every step
through the published surface, the denial cases really deny, real artifacts read
back off disk.**

**M4 scenario C1 — Meta-skill scaffolds a real extension (T-A/T-D):**
- The meta-skill (or T-D driving the same steps) produces a `local-rest` manifest,
  validates it with the conformance checklist, and `POST /extensions` registers it
  against a real gateway on a free loopback port.
- **Honest green:** `GET /manifest` shows the new capability with `members`/`skills`
  resolved; an un-granted invoke is **DENIED** `grant_required`; after `PUT /grants`
  the invoke routes to a **real local service stub** (T-D stands up a throwaway
  localhost HTTP fixture) and returns its real bytes — not a trusted return value.

**M4 scenario C2 — User custom skill (T-B):**
- Register a `kind:"skill"` extension attaching onto a present capability (e.g. an
  Obsidian/cc-master entry from the existing fixtures).
- **Honest green:** the target entry's `skills[]` now carries the `AttachedSkillRef`
  (assert on the manifest snapshot, read back from `GET /manifest`); the skill entry
  is discoverable; an attempt to **invoke** the skill entry is **DENIED** (skills are
  read-as-context). Zero new grants minted by the skill.

**M4 scenario C3 — User dynamic workflow (T-C):**
- Register a workflow composing two present capabilities (e.g. a board.create +
  board.status, or two fixture capabilities), grant it, invoke it.
- **Honest green:** the granted token carries the synthesized transitive member
  scopes (`synthesizedFor` set); the `WorkflowTransport` fans out and **each member
  runs for real** (read the board JSON / fixture side effect back off disk); a
  dangling-member workflow registration returns `ok:false`; a cyclic workflow is
  rejected; a mid-fan-out revoke halts the remaining member (assert via audit).

**Gate:** `bun test` stays green (existing 138 + the new T-B/T-C/T-D tests), and
`bun run examples/m4-demo/run.ts` exits `0`. No scenario asserts on a trusted return
value where a disk/wire fact is available.

---

## 4. Proposed protocol changes (additive — gated on human ratification)

The frozen `src/protocol/types.ts` is **not edited by these design agents**. The
following are **proposed v0.2 additive changes** with rationale + what each
forecloses. Each is non-breaking (new optional fields / new endpoint; no change to
an existing shape's required fields). **A human ratifies before any type edit.**

### P-1 · Cross-source skill attach (`route.attachTo`) — *additive, recommended ON*
- **Change:** recognize an optional `route.attachTo: CapabilityId[]` on a
  `kind:"skill"` declaration; at register/refresh the registry resolves those ids and
  appends an `AttachedSkillRef` to each present target entry's `skills[]`.
- **Why:** the headline user-authoring use case is teaching an **ingested MCP tool**
  (a foreign source). Today `manifestEntries()` only wires *same-manifest* skill
  back-links. `AttachedSkillRef` already exists on `CapabilityEntry`; only the
  registration wiring is new.
- **Wire impact:** none — `route` is already an open bag core never reads; the new
  behavior is registry-side enrichment. No type field added; purely a recognized
  `route` key + registry logic.
- **Forecloses:** nothing material. (A skill attaching to a not-yet-present target is
  simply not wired until the target appears — define as "attach on next refresh once
  present.")

### P-2 · Register-time workflow validation (present members + verb-subset + anti-cycle) — *additive, required*
- **Change:** `registerExtension` rejects a workflow whose members are not present,
  whose `verbs ⊄ member.grants`, or that forms a cycle — returning the existing
  `ExtensionRegisterResponse { ok:false, reason }`.
- **Why:** ADR-012 already requires present members + verb-subset; M4 makes user
  workflows authorable, so the gateway must enforce it at the user-facing register
  boundary (today the demo relies on first-party correctness). Anti-cycle is new but
  necessary because `WorkflowTransport` re-entry would otherwise recurse.
- **Wire impact:** none — reuses `ExtensionRegisterResponse.reason`. Pure validation.
- **Forecloses:** workflows with forward-declared (not-yet-present) cross-manifest
  members in a single register call (must register members first). Acceptable.

### P-3 · Extension unregister — `DELETE /extensions/:source` — *additive, proposed v0.2, NOT required for M4 green*
- **Change:** a new endpoint to remove a runtime-registered extension (drop the
  overlay module, re-scan, revision bump, `manifest_changed`).
- **Why:** today an extension persists for the process lifetime; authoring iteration
  ("I made a mistake, remove it") currently requires a gateway restart. Useful for the
  authoring loop, not strictly needed to *prove* M4.
- **Wire impact:** a new endpoint + a `ExtensionUnregisterResponse` type. Additive
  (no existing shape changes); advertised in `AuthAdvertisement` like the others.
- **Forecloses:** nothing; re-register already replaces a module, so unregister is the
  complementary half. **Recommendation: defer to a fast-follow unless the authoring
  UX demands it — the meta-skill's re-register-replaces path covers the common case.**

### Not proposed (deliberately not changing the wire)
- In-process `handler` over the wire — **never** (security boundary, EXTENSION-SPEC
  §11). Stays gateway-owned/compile-time.
- New transport for authored extensions — none needed; the existing set covers it.
- Per-instance grant constraints — already deferred post-v1 (ADR-005); M4 enforces
  instance confinement in `io.input` + transport, not the verb model.

---

## 5. Forks flagged for human ratification

Genuine decision points where this design picked a sensible default but a human
should confirm:

1. **P-1 cross-source attach: ship in M4 or defer?**
   *Default: ship in M4 (ON).* It is the headline custom-skill use case (teach an MCP
   tool) and is fully additive. **Alternative:** ship M4 with same-source attach only
   and defer cross-source to v0.2 — smaller blast radius but a weaker custom-skill
   story. → **Recommend ship; ratify.**

2. **P-3 unregister: M4 or fast-follow?**
   *Default: fast-follow (NOT in M4 green).* Re-register-replaces covers iteration;
   unregister is a convenience. **Alternative:** include it for a complete authoring
   lifecycle. → **Recommend fast-follow; ratify.**

3. **Meta-skill register auth: user-paste connection-key vs. management "authoring
   session".**
   *Default: user-paste connection-key → handshake → reuse session (most secure,
   standard agent flow).* **Alternative:** a management-client-issued short-lived
   authoring session (smoother UX, new management surface). → **Recommend
   user-paste for M4; ratify.**

4. **Meta-skill plugin distribution: bundled-and-auto-installed by Plexus vs.
   standalone install.**
   *Default: a first-party Plexus source auto-installs `plexus-ext` the same way
   cc-master self-installs (so "gateway running ⇒ meta-skill available").*
   **Alternative:** ship the plugin dir and let the user `claude --plugin-dir` it.
   → **Recommend auto-install via a first-party source; ratify (this adds a small
   first-party source — a minor `src/sources/` addition, not a protocol change).**

5. **Generated-artifact location: `plexus-extensions/<source>/` in the user's cwd vs.
   under `~/.plexus/extensions/`.**
   *Default: user's cwd (versionable, user-owned authoring artifact; gateway state
   stays separate in `~/.plexus/`).* **Alternative:** `~/.plexus/extensions/` (central,
   but mixes authoring artifacts with gateway state). → **Recommend cwd; ratify.**

None of these forks block starting T-A/T-B/T-C; they shape T-A's UX and the two
additive hooks. Ratify before T-B/T-C edit any type or before P-3 is built.

---

## 6. Definition of done (M4)

- `EXTENSION-SPEC.md` published (✓ this milestone) and referenced by the meta-skill.
- `/plexus-ext:create-extension` scaffolds + validates + registers a `local-rest`
  and a `cli` extension end-to-end.
- A user custom skill attaches onto a foreign-source capability and is discoverable +
  non-invocable (T-B, P-1).
- A user dynamic workflow composes present capabilities, grants synthesize transitive
  scopes, fan-out runs for real, and invalid workflows are rejected (T-C, P-2).
- `examples/m4-demo/run.ts` exits `0`; `bun test` green (existing + new).
- Any type edit (P-1 wiring, P-2 validation reasons) landed as **additive**, with the
  §5 forks ratified by a human.
