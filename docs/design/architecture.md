# Plexus Architecture — the core map

> Developer-facing. This is the **map** of the whole system: one page that names every
> layer, says what it owns, and points at the design SSOT that treats it in depth. Read
> [`../concepts.md`](../concepts.md) first for the mental model; come here to find where a
> claim lives in code. Paths are relative to the repo root. Status: 1.0-RC.

## 0. One process, four planes

Plexus is **one Bun + Hono process** on the owner's machine, loopback by default
(`127.0.0.1:7077`; a non-loopback bind is opt-in and user-confirmed). Everything the
system does enters through one of four HTTP planes, guarded before auth by a Host/Origin
check on every route (`packages/runtime/src/core/security.ts`):

| Plane | Routes | Credential | Who calls it |
| --- | --- | --- | --- |
| **Agent** | `/.well-known/plexus`, `/agents/enroll`, `/link/handshake`, `/grants*`, `/invoke`, `/manifest`, `/events`, `/extensions` | none → one-time code → per-agent PAT → scoped token | AI agents |
| **Management** | `/admin/api/*`, aliased under `/v1/*` (LRA — the versioned local runtime API, `core/v1.ts`) | connection-key, on every data route (`admin.ts` blanket middleware) | the owner: web console, desktop app, `plexus` CLI |
| **Integration** | `/integration/:agentId` (the copy-able install), backed by `install.sh` | one-time enrollment code rides the command | the agent being onboarded |
| **Mesh** | the tunnel listener (primary accepts; proxy dials out) | Ed25519 mutual auth, join-token enrollment | other Plexus gateways |

The two credentials never cross planes: the **connection-key** is admin-only and no HTTP
route returns or hints at it; each agent holds its **own PAT**
([`security-model.md`](./security-model.md) §1).

## 1. The monorepo at a glance

| Where | What it is |
| --- | --- |
| `packages/protocol` | **The type SSOT.** Every wire shape, `CapabilityEntry`, grants, audit, mesh frames — one `types.ts` the whole repo is typed against. The prose contract lives in [`docs/protocol/PLEXUS-PROTOCOL.md`](../protocol/PLEXUS-PROTOCOL.md) (v0.1.3) + [`DECISIONS.md`](../protocol/DECISIONS.md). |
| `packages/runtime` | **The gateway.** Everything below §2. |
| `packages/cli` | The human/operator CLI (`plexus …`): source, bundle, extension, mesh commands over the management plane. |
| `packages/web-admin` | The `/admin` console (Vite + React): onboarding, grants/approvals, activity, exposure. |
| `packages/desktop` | The Electron shell around the same runtime + console. |
| `integrations/claude-code`, `integrations/codex` | Per-agent integration shims (launcher `bin` + setup) — the consumers of the compile model. |
| `plugins/plexus-ext` | The Claude Code plugin skeleton the compiler renders from. |
| `tools/plexus-cli` | The sanctioned agent-side engine, bundled into every compiled artifact (byte-verified — §4). |
| `examples/` | Runnable proof: `min-agent` (the dependency-light reference client), `mesh-security-audit` (the 1.0-RC flagship), `appliance`. |
| `docs/` | Concepts, guides, protocol, and the design SSOTs this map points into. |

## 2. The runtime spine

The request path is a straight line, and every layer is a seam:

```
server.ts            Hono app assembly: hostOriginGuard → .well-known → planes
  └─ handlers.ts     the session endpoints (enroll/handshake/grants/invoke/…)
       └─ state.ts   GatewayState — the wired stores, constructed once:
                     sources, capabilities, audit, sessions, grants, exposure,
                     revocation, events, connectionKey, agentEnrollment, mode
            └─ pipeline.ts   the UNIFORM invoke pipeline (one path for every call)
                 └─ registry.ts   SourceRegistry — the ONLY source/transport lookup
                      └─ transports/…  → sources/…   (the actual dispatch)
```

- **`core/server.ts`** builds the app; pure construction, injectable for tests
  (`AppOverrides`).
- **`core/state.ts`** owns the stores. Notable: `exposure` (the owner's outer gate —
  effective access = **granted ∧ exposed**), `agentEnrollment` (codes → hashed PATs),
  `revocation` (jti registry), `events` (the management stream).
- **`core/pipeline.ts`** is the one door for invocation — top-level calls **and** workflow
  member fan-out re-enter the same function, so every dispatch is session-checked,
  revocation-checked, scope-checked, schema-checked, and audited identically (ADR-012/013).
  The single guarded exception is the mesh tunnel path, gated by a module-private symbol
  brand that cannot be forged from JSON or from outside the module (§5).
- **`core/registry.ts`** is the only place `sourceId → module` and `transportKind → impl`
  resolve; no `switch (kind)` exists outside it. Adding a transport = implement +
  register (ADR-003).
- **`audit/`** is the single write choke point: every event passes one redaction +
  truncation pass (secrets masked, sizes capped, clips marked), then appends one JSON
  line (append-only JSONL, daily-rotated, default 90d retention).

## 3. The three extension axes

Everything you can add to Plexus enters along one of three axes, and each lands in the
same `CapabilityEntry` shape (ADR-004 — one type, one discovery loop, one grant surface):

1. **Sources** (`runtime/src/sources/`) — what capabilities exist. First-party modules
   ship in-process (workspace, apple-calendar, apple-reminders, obsidian, claudecode,
   codex, things, sysinfo); **managed** sources are added by the owner through
   the connectors catalog, persist to `~/.plexus/sources.json`, and hot-reload;
   **extensions** are wire-registered by agents (`POST /extensions`) and carry the
   strictest provenance. Provenance is stamped by the gateway from origin — an extension
   cannot claim a reserved first-party id.
2. **Transports** (`runtime/src/transports/`) — how a capability is reached: `local-rest`,
   `stdio`, `ipc`, `mcp`, `cli`, plus the non-wire sentinels `skill` / `workflow` and the
   federation transport `mesh`. One `Transport.dispatch()` interface.
3. **Policy** — how grant decisions are made: the `Authorizer` seam
   ([`authz-extensibility.md`](./authz-extensibility.md) S4). Swapping policy never
   touches the wire.

A fourth surface *projects outward* rather than extending inward: the **compile model**
(`runtime/src/integration/`) renders a per-agent artifact (v1: a Claude Code plugin) from
the Floor — deterministically templated, then verified against the Floor by
`verify-plugin.ts` (sanctioned engine byte-identical, no baked secret, only advertised
caps, sanctioned flow). The SSOT is
[`agent-skill-compile-domain-model.md`](./agent-skill-compile-domain-model.md).

## 4. The trust fabric

The authorization model is treated authoritatively in
[`security-model.md`](./security-model.md); its shape in one breath: two credentials
(connection-key = admin boundary; per-agent PAT = agent identity), two clocks
(trust-window = the human's decision; scoped token = the 15-min blast radius),
three provenance classes (first-party / managed / extension) deriving a sensitivity tier,
default-deny with human-approved grants, `execute` never standing, gateway-authored
narration, and per-agent revocation as one immediate act. The seams that let this model
grow (task tickets, enterprise attribution, pluggable policy) are locked in
[`authz-extensibility.md`](./authz-extensibility.md) / ADR-020.

## 5. The federated mesh

A capability need not live on the machine the agent talks to. A **primary** gateway (the
agent's front door: grants, authorizer, audit aggregation) mounts capabilities borne by
**proxy** gateways that dial a persistent, Ed25519-mutually-authenticated tunnel outward
(no inbound hole on a proxy host). Authority terminates at the primary (Invariant E): an
invoke forwarded down the tunnel is already authorized, and the proxy re-checks only its
*local* gates (exposure, schema, health) — join/forward ≠ access. The tunnel-trust ingress
is the pipeline's one guarded auth-skip, provably reachable only from the tunnel
(`core/pipeline.ts`, `mesh/runtime.ts`). Each gateway keeps its own authoritative audit;
proxy events bubble up to the primary's mirror with a shared `correlationId`. The SSOT is
[`federated-mesh-domain-model.md`](./federated-mesh-domain-model.md) (+
[`mesh-model.md`](./mesh-model.md), [`encryption-policy.md`](./encryption-policy.md),
[`networking-resilience.md`](./networking-resilience.md),
[`mesh-health-reporting.md`](./mesh-health-reporting.md)).

## 6. Platform seam & the appliance

`runtime/src/platform/` isolates everything OS-specific behind `PlatformServices`
(darwin / linux / win32 path resolution, sandbox backend selection: macOS seatbelt →
Linux bwrap, [`linux-confinement.md`](./linux-confinement.md)). macOS is the shipped
v1 target; the seam is multi-platform from day one. `runtime/src/appliance/` is the
manifest-driven container boot (`docker/Dockerfile.appliance`) that turns one machine's
capability set into a mesh-joinable appliance — "expose a capability, not a system"
([`capability-appliance.md`](./capability-appliance.md)).

## 7. Boot & supervision

There is **one** boot seam: `runtime/serve.ts#startRuntime` — used identically by
`src/index.ts` (headless), the `bin/plexus` human launcher, the desktop app, and the
appliance entrypoint. It binds loopback, emits the machine-readable ready line, and
writes `~/.plexus/runtime.json` for supervisors. All durable state lives under
`~/.plexus/` (sources, grants, exposure, enrollments, audit; single write path, ADR-009).

## 8. The invariants ledger

The claims the architecture is built to keep true, and where each is enforced:

| Invariant | Enforced at |
| --- | --- |
| Default-deny: reaching ≠ calling; knowledge ≠ authority | `auth/authorizer.ts` + `core/pipeline.ts` scope gate |
| Effective access = granted ∧ exposed (owner's outer gate wins) | `core/exposure.ts`, denial wired **before** the grant check in `pipeline.ts` |
| `execute` can never be standing — approved per use, no admin override | window ceiling in `core/grant-service.ts` (ADR-018) |
| ONE invoke path; workflow fan-out re-enters it (no silent escalation) | `core/pipeline.ts` (ADR-012/013) |
| Connection-key is admin-only; no route returns or hints at it | `core/admin.ts` (deliberately absent route + blanket key gate) |
| The PAT proves the real `agentId`; no self-asserted identity | `core/agent-enrollment.ts` + handshake resolution in `handlers.ts` |
| Tunnel-trust is unforgeable from JSON (symbol brand, module-private) | `core/pipeline.ts` `TUNNEL_TRUST` |
| No durable secret ever ships in a compiled artifact | `integration/verify-plugin.ts` (4-axis Floor verification) |
| The human reads gateway-authored narration, never agent prose | `core/grant-service.ts` narration + purpose sanitization |
| Every audit write passes one redaction/truncation choke point | `audit/index.ts` single writer |
| The bundle join key outlives the grant rows (replayable ticket story) | grant-lifecycle audit stamps ([`authz-extensibility.md`](./authz-extensibility.md) S1) |

If a change would break a row of this table, it is not a refactor — it is a design
change, and it goes through an ADR.
