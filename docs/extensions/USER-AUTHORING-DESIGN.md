# Plexus User-Authoring Design — Custom Skills & Dynamic Workflows

> Status: **M4 design** · Depends on: [`EXTENSION-SPEC.md`](./EXTENSION-SPEC.md) ·
> Reuses: `ExtensionManifest`, `registerExtension`, `WorkflowTransport`,
> `TransitiveGrant` · Date: 2026-06-23
>
> Two user-defined authoring capabilities, both built **additively** on the shipped
> extension machinery — no new wire:
>
> **(a) Custom SKILLS** — attach a `kind:"skill"` usage entry to existing
> capabilities, discoverable as context.
> **(b) Dynamic WORKFLOWS** — compose existing capabilities into a new
> `kind:"workflow"` capability, exposed via self-describe, reusing the
> `WorkflowTransport` + transitive-grant model.
>
> Both register through the **same `POST /extensions` / `registerExtension` path**
> as any extension (an authored skill/workflow IS an extension contributing one or
> a few entries). The user does not learn a second mechanism. **Design only.**

---

## A. User-defined custom SKILLS

### A.1 What it is

A user writes usage knowledge — "how to use capability X well" — and attaches it to
one or more **existing** registry capabilities (an ingested MCP tool, a first-party
adapter capability, another extension's capability). The skill becomes:
- a standalone discoverable `kind:"skill"` entry, AND
- a back-linked `skills:[{id,label}]` reference on the capability(ies) it teaches.

This is exactly the Obsidian `vault.how-to-cite` pattern, but authored by the user
against capabilities they did not write. It is Plexus's headline value over raw
MCP: MCP gives you `description`; Plexus lets the *user* layer "how to use me well."

### A.2 Authoring inputs

| Input | Required | Meaning |
|---|---|---|
| `targetIds: CapabilityId[]` | **yes** | The existing capability ids this skill teaches. Each MUST resolve to a present registry entry. |
| `name` | **yes** | `<noun>.how-to-<x>` skill slug; the entry id = `<source>.<name>` under the authoring source. |
| `label`, `describe` | **yes** | The skill's own label + agent-facing relevance line. |
| `body` | **yes** | The markdown usage guidance (`{ format:"markdown", markdown }`), frontmatter-style per the claude-plugin convention. |

### A.3 How it registers (additive)

A custom skill is authored as a **minimal `ExtensionManifest`** with one (or a few)
`kind:"skill"` declarations and **the back-link expressed via `route.attachSkills`**
on a co-declared re-projection — BUT because the target capabilities live in a
*different source*, the cross-source back-link needs a small additive mechanism.
Two registration shapes, in order of preference:

1. **Same-source authoring (no protocol change).** If the user authors the skill in
   the SAME extension that owns the target capability (e.g. they extend their own
   extension), `route.attachSkills` already wires the back-link via
   `manifestEntries()`. Fully supported today.

2. **Cross-source attach (needs a small additive hook — flagged in M4-PLAN).** To
   attach a user skill onto a capability owned by *another* source (the common case:
   teaching an ingested MCP tool), the skill declaration carries
   `route.attachTo: CapabilityId[]` naming the foreign target ids. At register, the
   registry resolves those ids and adds an `AttachedSkillRef` to each target entry's
   `skills[]`. This is an **additive registry-side enrichment** (the
   `AttachedSkillRef` field already exists on `CapabilityEntry`; no wire type
   changes) but `manifestEntries()` today only wires *same-manifest* skills — so a
   small additive change to the registration/refresh path is required. **Proposed as
   an additive, non-breaking enhancement in M4-PLAN; default ON for M4.**

Either way: the skill entry itself is always a standalone discoverable
`kind:"skill"` entry (works today). The back-link is the only piece that may need
the additive cross-source hook.

### A.4 Validation

- Each `targetIds` / `attachTo` id resolves to a **present** registry entry of kind
  `capability` or `workflow` (you don't attach a skill to a skill).
- `kind:"skill"` shape rules (EXTENSION-SPEC §8 rule 6): `grants:[]`,
  `transport:"skill"`, has `body`, no `io`/`members`.
- `body.markdown` is non-empty; `describe` follows "Action outcome. Use when X."
- Skill ids unique (no collision with an existing entry id).

### A.5 Grants

A `kind:"skill"` entry requires **no grant** (`grants:[]`) — it is read-as-context,
delivered in the handshake manifest, and **never invocable** (the bridge denies an
invoke of a skill entry). So custom skills add **zero new authority**: they only
add discoverable knowledge. This is what makes them safe to author freely. A
malicious skill body is contained because it is *text the agent reads*, not a
capability the agent calls — it cannot cause a side effect; at worst it gives bad
advice, which the user reviews at authoring time (the body is shown before register).

---

## B. User-defined DYNAMIC WORKFLOWS

### B.1 What it is

A user composes several **existing** registry capabilities into ONE higher-level
`kind:"workflow"` capability, exposed via self-describe like any capability, invoked
through the `WorkflowTransport` which fans out to the members through the **uniform
invoke pipeline** (ADR-013). The user gets a new, named, grantable action ("read my
note then append a log line", "create a board then dispatch the first agent")
without writing orchestration code — the *composition* is the declaration.

### B.2 Authoring inputs

| Input | Required | Meaning |
|---|---|---|
| `name` | **yes** | `<noun>.<verb>` workflow slug; id = `<source>.<name>`. |
| `label`, `describe` | **yes** | Label + agent-facing relevance. `describe` MUST note that granting it implies its members' grants. |
| `members: WorkflowMember[]` | **yes** | Ordered `{ id, verbs }`. Each `id` MUST be a present registry entry; each `verbs` ⊆ that member's required `grants`. |
| `grants` | **yes** | The workflow's own required verb(s) — typically the "highest" risk class among members (e.g. a workflow with an execute member declares `["execute"]`; a read+write composition declares `["write"]`). |
| `io` | recommended | The workflow's input schema. The workflow hands its input to members (the cc-master pattern passes `goal` verbatim to every member); document this. |
| `skills` | optional | Attach usage skills (via the custom-skill flow, A) teaching the workflow. |

### B.3 How it registers (additive — reuses the frozen model)

A dynamic workflow is a **minimal `ExtensionManifest`** with one
`kind:"workflow"` declaration (`transport:"workflow"`, `members[]`). Registered via
`POST /extensions` / `registerExtension` exactly like any extension. The gateway:
- materializes it into a source, `scan()`s the workflow entry into the registry,
- the entry is discoverable in `.well-known` (as a `workflow` costing its verbs) and
  the handshake manifest, with `members[]` resolving to present entries,
- on invoke, the `WorkflowTransport.dispatch` re-enters the pipeline per member via
  `BridgeDeps.invokeById` — **no core branching on `kind:"workflow"`**.

This is **100% reuse of shipped machinery**: `WorkflowMember`, `WorkflowTransport`,
`TransitiveGrant`, and the registration path all already exist (cc-master's
`orchestration.run` is the worked first-party example; a user workflow is the same
shape from an extension manifest). **No protocol change is required for the
core case** where members are in a present source.

### B.4 Validation

The strict rules (EXTENSION-SPEC §8 rule 7 + ADR-012), enforced at register:
1. `members[]` non-empty.
2. Every `members[].id` resolves to a **present** registry entry at register time
   (a dangling member has no transitive-grant target — **reject**).
3. Every `members[].verbs` ⊆ the member entry's required `grants` (you cannot
   grant a member more than it requires through a workflow).
4. The workflow's own `grants` are declared (so the user sees the top-level cost).
5. No cycles: a workflow member id must not (transitively) be the workflow itself —
   the author tool resolves the member graph and rejects a cycle (the
   `WorkflowTransport` re-entry would otherwise recurse). **This anti-cycle check is
   a register-time validation the author tool + registry MUST perform** (flagged in
   M4-PLAN as a required additive validation, not a wire change).
6. `transport:"workflow"`, `kind:"workflow"`.

**Ordering note:** because every member must be *present* at register, a workflow
whose members are declared in the SAME manifest must list the member capabilities
before/alongside the workflow (they all enter the registry in one `scan()`, so
co-declaration works — see EXTENSION-SPEC §12.3). Cross-manifest members must
already be registered.

### B.5 Grants & transitive scopes (the security model, reused)

Granting a user-composed workflow uses the **exact frozen transitive-grant model**
(ADR-012, `TransitiveGrant` / `TokenScope.synthesizedFor`):

1. The user grants the workflow id its declared verb (e.g. `notes.daily.log` /
   `write`).
2. The gateway **synthesizes** the member scopes from `members[]` — each member id
   with the verbs the workflow may exercise on it — and **surfaces them to the user
   at grant-confirm time** ("…which will also run `notes.vault.read` (read),
   `notes.vault.append` (write)").
3. Those synthesized scopes are stamped into the issued token's `scopes` flagged
   `synthesizedFor: <workflowId>`, so member dispatch is scope-checked through the
   **same uniform pipeline** — no silent escalation.
4. On invoke, the `WorkflowTransport` fans out; each member dispatch re-checks the
   originating jti's revocation state (a mid-fan-out revoke halts the rest, ADR-010)
   and is audited like any invoke.

**Consequence for the user-authoring threat model:** a user cannot author a workflow
that escalates privilege. The workflow can only exercise member verbs that (a) the
member already requires AND (b) the user explicitly sees and grants. A workflow that
names a high-risk member (an `execute` capability) makes that cost visible at the
grant prompt — the user's defense is exactly the transitive-scope disclosure plus
the audit log plus revoke.

---

## C. Shared authoring surface

Both custom skills and dynamic workflows:
- Are authored as **minimal `ExtensionManifest`s** and registered through the **one**
  `POST /extensions` / `registerExtension` path (one mechanism, EXTENSION-SPEC §9).
- Are **discoverable** the instant they register (revision bump + `manifest_changed`).
- Are **validated** by the §8 rules before/at register; an invalid authoring attempt
  is rejected honestly (`ok:false` + `reason`), never faked green.
- Land as user-owned artifacts (the meta-skill scaffolds them under
  `plexus-extensions/<source>/`; see META-SKILL-DESIGN §4).
- Reuse the **same validation rule set** — the meta-skill's workflow/skill steps
  defer to the rules in this doc rather than duplicating them.

### Authoring inputs summary (what an author tool must collect)

| | Custom skill | Dynamic workflow |
|---|---|---|
| New entry kind | `skill` | `workflow` |
| Targets/members | `attachTo` / `targetIds` (existing capabilities) | `members[]` (existing capabilities) |
| Grants added | **none** (`[]`) | the workflow's own verb (+ surfaced transitive member scopes) |
| Invocable? | no (read-as-context) | yes (fans out) |
| Wire reuse | `AttachedSkillRef` (+ additive cross-source attach hook) | `WorkflowTransport` + `TransitiveGrant` (no change for present-member case) |
| Register path | `POST /extensions` | `POST /extensions` |

---

## D. What needs an additive change vs. works today

| Capability | Works on frozen v0.1.1? | Note |
|---|---|---|
| Custom skill as standalone discoverable entry | **Yes** | `kind:"skill"` extension entry, registers today. |
| Custom skill back-linked to a **same-manifest** capability | **Yes** | `route.attachSkills` + `manifestEntries()`. |
| Custom skill back-linked to a **foreign-source** capability | **Additive hook** | `route.attachTo` → registry-side enrichment of the target's `skills[]`. `AttachedSkillRef` already exists; only the registration/refresh wiring is new. No wire type change. |
| Dynamic workflow over **present** members | **Yes** | Full reuse of `WorkflowTransport` + `TransitiveGrant`. |
| Dynamic workflow **anti-cycle** validation | **Additive validation** | Register-time graph check; no wire change. |
| Workflow/skill **unregister** | **Proposed v0.2** | `DELETE /extensions/:source` (see M4-PLAN). |

All additive items are non-breaking and detailed with rationale in
[`M4-PLAN.md`](./M4-PLAN.md). The frozen wire types in `src/protocol/types.ts` are
**not** edited by these designs.
