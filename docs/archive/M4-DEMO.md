# M4 CAPSTONE — extension-authoring acceptance demo

> Status: **M4 acceptance (capstone)** · Gateway: **Plexus v0.1.2** (security
> foundation reviewed-green, gate 289) · Protocol: **PLEXUS_PROTOCOL_VERSION 0.1.2**
> · Extension manifest: **plexus-extension/0.1**

This is the M4 acceptance doc. It proves the **whole extension-authoring story** end
to end, honest-green: **scaffold an extension with the meta-skill → register it
(human-approved) → an AI agent discovers and USES it**, receiving REAL data from a
REAL backend through the real pend→approve→invoke pipeline. It then folds in the two
other M4 feature tracks (user custom-skill authoring, user dynamic-workflow authoring)
into one consolidated PASS/FAIL verdict.

Nothing here is staged. Every step goes through the published wire contract
(`.well-known` → handshake → grants → invoke), the **actual** meta-skill generator
(`plugins/plexus-ext/lib/generate.ts`), the **actual** gateway, the **actual**
agent client (`examples/min-agent/client.ts`), and a **real** loopback backend.

## Run it

```bash
# The consolidated transcript (headline loop + the three tracks + security spot-check):
bun run examples/m4-demo/run.ts        # exits 0 iff the whole M4 story is green

# The capstone test gate (asserts the agent gets REAL backend data):
bun test tests/m4-demo-capstone.test.ts
bash run-tests.sh                      # the full 289 + the m4-demo capstone tests
```

## The headline loop — meta-skill scaffold → register → agent uses it

The new bit M4 adds. `examples/m4-demo/headline.ts` drives, all through the real wire:

| # | Step | What actually happens | Code |
|---|------|------------------------|------|
| 1 | **SCAFFOLD** | The meta-skill's ACTUAL `generateManifest(spec)` turns an interview `CapabilitySpec` for a read-only `local-rest` facts lookup into a spec-compliant `ExtensionManifest` + a bundled how-to-use skill. The meta-skill's own `validateExtension` PASSES it. The manifest is **generator-authored, never hand-written**. | `plugins/plexus-ext/lib/generate.ts` (read-only import) |
| 2 | **REAL backend** | A loopback "facts" service binds `127.0.0.1:<ephemeral>` and seeds the canonical datum the agent reads back. | `examples/m4-demo/service.ts` (mirrors `m4-user-workflow/server.ts`) |
| 3 | **REGISTER (pends)** | Boot a REAL gateway; the agent `POST /extensions` the generated manifest. It is transport-backed (local-rest) so it **PENDS** (`grant_pending_user`) — an agent cannot activate an extension on its own. | `src/core/handlers.ts` `extensions` |
| 4 | **APPROVE** | A background driver MODELS the management user approving (polls the SAME pending store `/admin/api/pending` reads, approves). Only THEN does the commit run. | `src/core/grant-service.ts` |
| 5 | **AGENT USES IT** | A real `PlexusClient` handshakes, DISCOVERS the capability by reading its `describe` + bundled skill body, requests the READ grant (pends → approved), and INVOKES it → a REAL HTTP GET to the loopback backend via the shipped `LocalRestTransport`. | `examples/min-agent/client.ts`, `src/transports/local-rest.ts` |

**Honest-green proof:** the agent's returned `value` is asserted to **EQUAL the
loopback backend's OWN view** of that record (read back independently). The value is
the proof — it came back through the real pipeline, not a fabricated ok:

```
agent received "Plexus is a local capability gateway, v0.1.2 (gate 289, security reviewed-green)."
backend's own  "Plexus is a local capability gateway, v0.1.2 (gate 289, security reviewed-green)."
match: YES (honest-green)
```

### One register-time bridge (documented, minimal, no src/ edits)

The meta-skill generator emits the EXTENSION-SPEC §6 published route field
`pathTemplate` (the path with `{token}` interpolation). The shipped runtime
`LocalRestTransport` reads `route.path` + resolves the loopback `baseUrl` from the
`serviceHint`. `adaptGeneratedRouteForRuntime` (in `examples/m4-demo/headline.ts`)
performs exactly that register-time bridge — mapping `pathTemplate` → `path` and
pinning the resolved loopback `baseUrl` — touching **only** the transport-routing
fields, never the id / grants / describe / skill body / secret refs the generator
authored. The frozen generator and all of `src/**` are untouched.

## Consolidated M4 verdict (all three deliverables)

`examples/m4-demo/run.ts` runs the headline loop AND the two existing M4 example
engines, printing one verdict:

| Track | M4 deliverable | Engine | Proof |
|-------|----------------|--------|-------|
| meta-skill scaffold → use (HEADLINE) | meta-skill (`plugins/plexus-ext/`) | `examples/m4-demo/headline.ts` | scaffold → register(pend→approve) → agent discovers + invokes → REAL backend data |
| user custom-skill attach | user skill (`examples/m4-user-skill/`) | `runUserSkillDemo` | same-source attach applied freely; cross-source attach DEFAULT-OFF (real wire denial) then opt-in + approval, provenance-stamped, agent-discovered |
| user dynamic-workflow compose → invoke | user workflow (`examples/m4-user-workflow/`) | `runDemo` | two existing caps composed into a `kind:"workflow"`; REAL fan-out (POST then GET); synthesized transitive scopes (no over-grant); dangling + cyclic compositions REJECTED at register |
| security spot-check | EXTENSION-SPEC secure defaults | `examples/m4-demo/security.ts` | generator REFUSES an over-privileged cli bin + a non-loopback rest host; only the safe read-only shape validates; an un-approved register stays inert (proven in the headline loop) |

## Security posture — everything human-approved + confined

This capstone does not weaken the reviewed-green security foundation; it exercises it:

- **Default-deny.** An un-granted invoke of the scaffolded capability is rejected with
  `grant_required`. No backend data leaks in a denial.
- **Human-in-the-loop registration.** An agent holding a connection-key can *request*
  a registration but cannot *activate* it — a transport-backed `POST /extensions`
  PENDS until a human approves in the management client. An un-approved register is
  inert.
- **Human-in-the-loop grants.** The grant for the scaffolded capability PENDS and is
  minted only after the modeled user approves. The minted scope is READ-ONLY (no
  write/execute) by the generator's secure default.
- **Loopback-only egress.** The scaffolded `local-rest` capability is confined to a
  loopback backend. The generator REFUSES a non-loopback rest host by construction
  (`isLoopbackUrl`), the same floor `src/transports/transport-policy.ts` hard-enforces
  at dispatch.
- **No over-privileged cli.** The generator REFUSES a cli bin that is a shell
  interpreter / absolute path / has shell metacharacters — it never emits one; a cli
  scaffold's exact bin is surfaced for explicit human approval at register-confirm.
- **Cross-source attach is gated.** (user-skill track) A cross-source skill attach over
  the wire with no opt-in + no human is rejected outright; with explicit
  `allowCrossSource` opt-in + approval it attaches PROVENANCE-STAMPED, distinguishable
  from a first-party describe.
- **Composition guards.** (user-workflow track) A workflow naming a dangling member or
  forming a cycle is REJECTED at register; granting a workflow synthesizes EXACTLY its
  members' scopes (no phantom id, no widened verb).

## Files (this deliverable)

- `examples/m4-demo/service.ts` — the real loopback backend.
- `examples/m4-demo/headline.ts` — the headline loop engine (scaffold → register → agent uses it).
- `examples/m4-demo/security.ts` — the secure-default spot-check.
- `examples/m4-demo/report.ts` — shared result shapes + helpers.
- `examples/m4-demo/run.ts` — the consolidated transcript + verdict.
- `tests/m4-demo-capstone.test.ts` — the capstone test (asserts REAL backend data).
- `M4-DEMO.md` — this doc.

Imported read-only (not modified): `plugins/plexus-ext/lib/generate.ts`,
`examples/min-agent/client.ts`, `examples/m4-user-skill/demo.ts`,
`examples/m4-user-workflow/demo.ts`, and the gateway `src/**`.
