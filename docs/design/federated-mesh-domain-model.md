# Plexus Federated Capability Mesh — Domain Model (DDD)

> Status: **design draft** (RFC). This is a forward-looking domain analysis for evolving
> Plexus from a single local gateway into a **federated capability mesh**: a `primary`
> gateway (the authority an agent integrates against) aggregating capabilities from many
> `proxy` gateways living next to the real services (another host, another machine), with
> audit and catalog cascading up.
>
> It is written DDD-style: ubiquitous language first, then strategic design (bounded
> contexts + context map), then tactical design (aggregates, entities, value objects,
> invariants), then domain events and the load-bearing policies. Terms already present in
> the codebase are marked `[existing]`; terms the federation introduces are marked `[new]`.

---

## 0. The two orthogonal axes (read this first)

Everything below hangs off two **independent** axes. Conflating them is the most common
way to get this design wrong.

| Axis | Question | Values | Decided |
| --- | --- | --- | --- |
| **Authority** (mode) | Who terminates authorization & faces the agent? | `primary` \| `proxy` | at **boot** (immutable) |
| **Resource-bearing** (workload) | Does this gateway expose local capabilities of its own? | yes / no | at runtime (sources added/removed) |

These do **not** correlate:

- A **`primary`** is the authority root (agent-facing, holds grants, runs the authorizer,
  audit sink) **and MAY also bear its own workload** — expose capabilities from the very
  machine it runs on. A "0-source primary" is just the *minimal* deployment (handy to test
  connectivity at boot); it is **not** a constraint.
- A **`proxy`** delegates authorization upward and is typically resource-bearing, but its
  defining trait is *delegation*, not *having services*.

> **Invariant A — Mode ⟂ Workload.** A gateway's authority mode is independent of whether it
> exposes local capabilities. Exactly **one** gateway in a mesh is `primary`; **any** gateway
> (including the primary) may bear a workload.

---

## 1. Ubiquitous Language (统一语言)

### The expose spine — `[existing]`
| Term | 中文 | Meaning |
| --- | --- | --- |
| **Connector** | 连接器 | *How* Plexus attaches to a kind of backend (catalog type, no secret). |
| **Source** | 源 | A *configured instance* of a connector (the real thing you connected). |
| **Capability** | 能力 | One callable operation a source contributes. The leaf of the spine. |
| **Companion Skill** | 配套技能 | Agent-facing usage doc compiled for a capability (`AttachedSkillRef`). |
| **Provenance** | 来源 | `first-party` \| `managed` \| `extension` — the organizing axis of the model. |
| **Sensitivity** | 敏感度 | `low` \| `elevated` \| `high` — drives default risk/HITL. |

### The mesh — `[new]`
| Term | 中文 | Meaning |
| --- | --- | --- |
| **Gateway** | 网关 | A Plexus runtime node. Has a **Mode**. |
| **Mode** | 模式 | `primary` \| `proxy`. The authority axis. Boot-fixed. |
| **Primary** | 主网关 | The authority root: agent-facing, holds grants, runs authorizer, audit sink. May bear a workload. |
| **Proxy** | 代理网关 | Subordinate: bears local sources, attaches upstream, keeps local exposure veto + local audit, **delegates authorization up**. |
| **Tenant** | 租户 | Org/ownership coordinate (enterprise). Top namespace coordinate. |
| **Workload** | 工作负载 | The identity a gateway claims for its local capabilities; the namespace coordinate. Unique under its parent. |
| **Capability Address** | 能力地址 | `Tenant / <workload-path…> / Source.capability` — the **logical identity** (URN) of a capability. Variable-depth location path (v1 convention: depth-1). Stable. The join key. |
| **Route** | 路由 | The current physical location/transport to reach a capability (URL). Mutable. |
| **Resolution** | 解析 | Health-aware `Address → Route` mapping. |
| **Enrollment** | 入网 | Boot-time handshake where a proxy joins a primary (mode + upstream + workload + join token → validated, unique, recognized). |

### Access & audit — mostly `[existing]`, enriched `[new]`
| Term | 中文 | Meaning |
| --- | --- | --- |
| **Agent** | 智能体 | The consumer (Claude Code, Codex). Talks **only** to the primary. `[existing]` |
| **Principal** | 主体 | The human/service-account an agent acts **on behalf of**. `[new, enterprise]` |
| **Grant** | 授权 | Authorization that a subject may invoke addresses matching a **pattern**, within scope + trust-window. Lives at the primary. (`StandingGrant`) `[existing]` |
| **Trust Window** | 信任窗口 | `once` \| `1h` \| `1d` \| `7d` \| `until-revoked` \| `custom`. (`once` = ad-hoc mode.) `[existing]` |
| **Exposure** | 暴露 | A host-operator's local on/off **veto** for a capability. Evaluated at the resource-owning gateway. `[existing]` |
| **Authorizer** | 授权器 | Decision component at the primary (HITL / policy). Modes: `confirm-risky` \| `confirm-all`. `[existing]` |
| **Audit Event** | 审计事件 | A recorded lifecycle fact. Recorded locally + bubbled up. (`AuditAppendedEvent`) `[existing]` |
| **Attribution** | 归因 | who/why behind an event: agent + principal + grant ref + policy ref. `[new]` |

---

## 2. Strategic design — Bounded Contexts

Five contexts, each with its own language and lifecycle. (Access is one context holding two
aggregates — Authorization and Exposure — because they are the two halves of one rule but
owned by different actors at different tiers.)

| Context | 中文 | Owns | Core language |
| --- | --- | --- | --- |
| **Topology** | 拓扑 | gateways, modes, enrollment, workload identity, resolution table, health | primary/proxy, enroll, workload, route, resolve, healthy/degraded |
| **Catalog** | 目录 | capabilities, addresses, provenance, companion skills, the aggregated/cascaded directory, discovery | capability, address, skill, summary/full tier, mount |
| **Access** | 访问 | grants, principals, authorizer, policy, exposure, revocation | grant, granted, exposed, revoke, scope, trust-window, glob |
| **Invocation** | 调用 | the runtime path: resolve → route → forward → execute → fallback | invoke, resolve, forward, dispatch, fallback |
| **Audit** | 审计 | audit events, attribution, redaction, cascade, retention/export | event, record, bubble-up, redact, attribute |

### Context map (关系)

```
                         ┌─────────────┐
            publishes ▲  │   Catalog   │  addresses referenced by grants
   (proxy → primary)  │  │  (目录)     │◄───────────────┐
                      │  └─────────────┘                │ (conformist on
                ┌─────┴──────┐                          │  address grammar)
                │  Topology  │  resolve(address)→route  │
                │  (拓扑)    │◄───────────┐             │
                └────────────┘            │             │
                      ▲ health            │      ┌─────────────┐
                      │                    └──────│   Access    │
                ┌─────┴───────┐   granted? exposed?│  (访问)     │
                │ Invocation  │───────────────────►└─────────────┘
                │  (调用)     │                          │
                └─────┬───────┘                          │ emits
                      │ emits domain events              │ domain events
                      ▼                                  ▼
                ┌──────────────────────────────────────────┐
                │              Audit  (审计)                │  ◄ observes all
                └──────────────────────────────────────────┘
```

- **Topology → Catalog** (Customer/Supplier): proxies publish their capabilities upward;
  the primary's directory is the aggregate of self + cascaded children.
- **Catalog ← Access** (Conformist): grants/exposure reference catalog **addresses**; Access
  conforms to the address grammar Catalog defines.
- **Invocation** orchestrates: asks Access (granted ∧ exposed?), asks Topology (resolve
  address → route), dispatches, falls back on unhealthy route.
- **Audit** is a downstream consumer of every context's domain events (Published Language).

---

## 3. Tactical design — Aggregates, Entities, Value Objects

### 3.1 Topology context

- **Gateway** — *aggregate root*. `{ id, mode, workload?, upstream?, enrollment? }`.
  - Invariants: `mode` immutable after boot; a `proxy` MUST hold a valid `Enrollment` to be
    active; **Invariant A** (mode ⟂ workload).
- **Enrollment** `[new]` — *aggregate*. The proxy↔primary join. `{ workload, joinToken, claimedAt, status }`.
  - Invariants: workload name **unique under the primary**; a valid **one-time** join token
    **auto-admits** (no per-join human gate), but the new workload enters **zero-exposure** —
    its capabilities default **hidden** (a remote-proxy default differs from a local source's
    default-exposed) and ungranted, so *join ≠ access* (exposure + grant still gate). Mutual
    identity via **Ed25519 keys pinned at join** (§7 Q2); mode declared at join.
- **ResolutionTable** `[new]` — *aggregate root at the primary*. `Address → { route, health }`.
  - Invariants: every advertised address resolves to exactly **one** current route or is
    marked unavailable; **resolution changes never mutate addresses** (Invariant B).
- Value objects: **Mode** (`primary`|`proxy`), **WorkloadName**, **Route**, **HealthStatus** `[existing enum]`.

### 3.2 Catalog context

- **CapabilityDirectory** — *aggregate root, per gateway*. The set of addresses this gateway
  advertises = own capabilities ∪ cascaded-up children.
  - Invariants: every **Address** unique within the directory; cascaded addresses are
    **prefixed/rewritten on ascent** (mount/NAT — Invariant F). The **primary mounts** (applies
    the tenant/workload prefix per its enrollment record); a **proxy advertises bare local
    `source.capability` ids and is workload-agnostic on the wire** — it never embeds its own
    mesh name, so it is renamable/relocatable without redeploy (§7 Q4).
- **Capability** `[existing, re-addressed]` — *entity*. `{ address, source, provenance, sensitivity, ioSchema, companionSkill }`.
- Value objects:
  - **CapabilityAddress** `[new]` — the URN. Grammar: `tenant / <workload-path…> / source.capability`
    — a **variable-depth** location path (`/` separates location segments, `.` separates
    source.capability). Today's `CapabilityId` is the `source.capability` tail; federation
    prepends the location path. **Depth is a property of the grammar, not a fixed tuple** —
    this is what keeps it consistent with Invariant F (cascade = mount/ascent-rewrite, which
    implies arbitrary depth). **v1 convention caps operational depth at 1** (one workload
    segment) via enrollment policy, NOT via grammar — so addresses never need a format
    migration when deeper topologies arrive. Separate concerns: the *identity grammar* is
    future-proof now (cheap); the *operational topology* is capped now, lifted cheaply later.

> **Worked example — "a group of machines egressing through one proxy" needs NO extra depth.**
> egress is a **routing** fact, not an **identity** fact (Invariant B). The egress node is a
> **workload-less proxy** (Invariant A: a proxy may bear no workload) — a pure router. The
> machines keep flat, distinct identities (`acme/m1/…`, `acme/m2/…`); the egress proxy never
> appears in their addresses, it only contributes a shared **route** in the resolution table
> ("m1 reached via tunnel→P→m1"), exactly as a network router's IP isn't part of a host's
> identity. Depth >1 is needed only when the intermediate is an **authority/aggregation
> boundary** (a regional hub doing its own exposure/audit before bubbling up) — that is the
> `primary`-behind-`primary` **regional delegation** parked out of scope in §6, not egress.
  - **CompanionSkill** `[existing: AttachedSkillRef]` — travels with the address up the cascade.
  - **ProvenanceTag** `[existing]`.

### 3.3 Access context — the two halves

- **Grant** `[existing: StandingGrant]` — *aggregate root, at the primary*.
  `{ id, subject: {agent, principal?}, addressPattern, verbs, contentConstraint?, scope, trustWindow, status, attribution }`.
  - Invariants: authorizes **only** addresses matching `addressPattern` (a glob over address
    space) **whose `input` satisfies `contentConstraint`** (`ScopeConstraint`, narrows-only —
    content-aware authz `[existing]` already in code); out-of-coverage input **re-pends** (not a
    hard deny); revocation is **terminal** (tombstone); validity bounded by `trustWindow`.
- **ExposurePolicy** `[existing]` — *aggregate root, at each resource-bearing gateway*.
  Per-capability enabled/disabled, default-enabled.
  - Invariants: **evaluated at the resource-owning gateway**; a disabled capability is
    invisible in discovery **and** denies invoke even with a valid grant (intersection).
- **Authorizer** `[existing]` — *domain service at the primary*. Decision is a function of
  **(subject, address, input)** — not just (subject, address): maps a grant/invoke request →
  decision (HITL when risky / `confirm-all` / out-of-coverage content; else policy/auto). The
  **approval surface must render the actual payload** (what's being written + the motive), since
  that is the decision basis. In enterprise the "human at the gate" generalizes to a **policy**
  evaluation; HITL is reserved for high-sensitivity / novel content.
- Value objects: **AddressPattern** (glob) `[new]`, **Scope** `[existing: ScopeConstraint]`,
  **TrustWindow** `[existing]`, **Principal** `[new]`, **Justification** `[new]`.

> **The core domain rule (Invariant C):**
> `effective_access(subject, address, INPUT) = grant.matchesAddress(address) ∧ grant.coversInput(INPUT) ∧ exposure.isEnabled(address) ∧ ¬revoked`
> — `granted` (address-match ∧ content-coverage) evaluated at the **primary**, `exposed` at the
> **resource-owning gateway**. **Authorization is content-dependent**: `coversInput` is trivially
> true for an unconstrained (whole-capability) grant, or the `ScopeConstraint` check for a
> content-scoped one. When the address matches but `coversInput` is **false**, it is **not a hard
> deny — it re-pends** (asks the human again *with this input*). This is why the same capability
> can be allowed once and denied next: a standing grant is **content-level trust** ("I trust this
> *kind* of write"), not a capability-level blanket allow; out-of-coverage content falls back to
> the human. The authority must therefore see the payload to gate it — which is *why* the data
> plane is passthrough (§7 Q1), not a mere convenience.

### 3.4 Invocation context

- **Invocation** — *process aggregate*. `{ address, args, resolvedRoute?, result?, error? }`.
  - Invariants: MUST pass Access check (granted ∧ exposed ∧ coversInput) **before** dispatch;
    routed via ResolutionTable; on unhealthy route → **typed `capability_unavailable`** carrying
    `unavailableSince` (how long down), never a hang (Invariant E). **No replica/failover** — a
    capability has exactly one home (its workload); "unavailable" = that home is down, here is the
    accurate signal. (This is NOT distributed-system DR.)
- **InvocationRouter** `[new]` — *domain service*. `resolve(address) → route → forward (down
  the cascade) → execute → return`. In the proxy/passthrough model the primary forwards down
  a persistent reverse tunnel the proxy dialed out on (mutually authenticated, §7 Q2). The
  **proxy trusts any invoke arriving on that tunnel as already-authorized** (tunnel-trust,
  Invariant E) — it only applies its local exposure veto + records audit; it never re-decides.

### 3.5 Audit context

- **AuditLog** `[existing]` — *aggregate root, per gateway*. Append-only local log.
  - Invariants: **append-only**; **redaction before persist**; bubbles a copy upstream
    **best-effort, never blocking** the invoke hot path (Invariant D). The **proxy's local log is
    authoritative** for its own capabilities; the **primary keeps a full mirror** (redacted
    content + metadata, §7 Q7) for single-pane audit — both tiers run the **same redactor** so the
    mirror never reveals more than the local log. Redaction **keeps substantive content, masks
    secrets** (the content *is* the audit/approval basis — see §3.3).
- **AuditEvent** `[existing, enriched]` — *entity*. `{ type, address, attribution, input?,
  output?, at, correlationId, tier }`. `input/output` already added (redacted+truncated).
- Value objects: **Attribution** `[new]` (agent + principal + grant ref + policy ref),
  **CorrelationId** `[new]` (threads edge-span → workload-span), **RedactedPayload** `[existing]`.

---

## 4. Domain Events (领域事件)

The lifecycle, as events. (`PlexusEvent` already exists; federation adds the topology/cascade ones.)

| Event | Context | Notes |
| --- | --- | --- |
| `ProxyEnrolled` `[new]` | Topology | a workload joined a primary |
| `CapabilityPublished` / `…Withdrawn` `[new]` | Catalog | cascades up; rewrites address on ascent |
| `CapabilityHealthChanged` `[existing: SourceStatusEvent]` | Topology | updates resolution, not address |
| `GrantRequested`/`Approved`/`Denied`/`Revoked` `[existing]` | Access | `GrantResolvedEvent`, `TokenRevokedEvent` |
| `ExposureChanged` `[existing: exposure.set]` | Access | proxy-local veto flipped |
| `InvocationRequested`/`Completed`/`Failed` `[existing]` | Invocation | |
| `InvocationDeniedUnexposed` `[existing: capability_unexposed]` | Invocation | intersection denial |
| `AuditEventRecorded` `[existing: AuditAppendedEvent]` | Audit | + best-effort bubble-up |

---

## 5. The load-bearing invariants (一处汇总)

- **A — Mode ⟂ Workload.** Authority mode is independent of bearing local capabilities.
  Exactly one `primary`; any gateway may bear a workload.
- **B — Address is identity; route is location.** Grants & audit bind to **address**;
  resolution binds address→route. Re-enrollment / health changes never mutate addresses
  ⇒ grants survive restarts; failover touches no grants.
- **C — Effective access = granted ∧ exposed ∧ ¬revoked ∧ coversInput**, with `exposed`
  evaluated at the resource-owning gateway and `coversInput` (content-coverage) at the primary;
  out-of-coverage input **re-pends** rather than hard-denies (authorization is content-dependent).
- **D — Audit is local-authoritative + bubbles up.** Recorded near the resource; aggregated
  at the primary; redaction before persist; bubble-up never blocks the hot path.
- **E — Authority terminates at the primary.** Proxies delegate authorization upward; no
  proxy decides grants. Authority topology = routing tree, decision at the root.
- **F — Workload unique under parent; addresses cascade-rewritten on ascent** (mount / NAT-for-names).
- **G — Companion skill travels with the capability address.**

---

## 6. Open decisions (待定，正交于上述模型)

The data-plane fork, cross-tier trust, enrollment, addressing, exposure-config and audit-landing
are now **resolved — see §7**. Genuinely-open items, orthogonal to the model:

1. **E2E payload sealing for an untrusted edge.** §7 Q1 picks data-plane passthrough (A) with the
   primary **inside the user's trust domain** (plaintext acceptable — and *required* for
   content-aware approval, §3.3). A future **untrusted-edge / multi-tenant-SaaS** deployment may
   want the primary to route opaque **sealed** payloads — it then loses content audit/approval (a
   per-deployment trade). Not v1.
2. **Version as a separate axis**, not part of the address (address = identity, version = property).
3. **Regional delegation** (a `primary` behind another `primary`, double-NAT for authority) —
   explicitly **out of scope** for v1; the model composes to it later without new nouns.
4. **In-flight invoke on revoke.** Revoke stops new forwards + writes the tombstone; an
   already-dispatched long-running invoke is **best-effort** (let complete / cancel). Exact
   semantics TBD.

---

## 7. Resolved Decisions (ADR ledger)

Walked as a design-tree interview; each row is a committed decision with the one-line why. The
aggregates and invariants above already reflect these.

| # | Decision | Resolution | Why |
| --- | --- | --- | --- |
| **Q1** | Data-plane shape | **(A) primary passthrough** — agent talks only to the primary; it forwards invokes down to proxies | Content-aware approval (§3.3) requires the authority to see the payload *before* execution — **structurally required**, not a convenience; (B) control-plane-registry can't gate on content and is **out** |
| **Q2** | Cross-tier trust | **Tunnel-trust** + **Ed25519 mutual auth** (pubkeys pinned at enrollment) + **optional, default-on channel encryption** | Authority terminates at primary (Inv E); asymmetric/standard, no invented crypto, no shared secret; identity ⟂ encryption (works over an already-encrypted underlay). Existing agent↔primary HS256 JWT is untouched — a **second** trust boundary |
| **Q3** | Enrollment admission | **Valid one-time join token auto-admits, zero-exposure entry** (remote caps default hidden) | join ≠ access; the real gates (exposure + grant) stay deliberate; a leaked token = a visible, zero-exposure rogue workload |
| **Q4** | Address ownership | **Primary mount** — proxy advertises bare local ids (workload-agnostic on the wire); primary applies tenant/workload prefix + translates at the forwarding boundary | mount = the parent's act (Inv F); proxy renamable/relocatable; tenant (which the proxy needn't know) applied cleanly |
| **Q5** | Tenant default | logical address always carries tenant; personal = a single implicit `local` tenant (elided in UI), enterprise sets it explicitly | keep-in-model, cap-operationally (same principle as address depth) |
| **Q6** | Exposure config source | evaluated **locally always** (Inv C); v1 switch is **local-only**, enterprise adds **primary-pushed** policy later | one mechanism, two config sources |
| **Q7** | Audit landing | **Full mirror** — primary persists redacted content + metadata; proxy's local log authoritative; **same redactor** both tiers | single-pane audit; (A) already routes plaintext, so storing *redacted* content centrally costs little; redaction keeps substance, masks secrets |
| **—** | Content-dependence | authorization is `f(subject, address, **input**)`; **Inv C gains `coversInput`**; standing = content-level trust; out-of-coverage **re-pends**; approval renders the payload | "same capability allowed once, denied next" (already half-built: `ScopeConstraint` / `constraintSatisfied`) |
| **Q8** | Backward compat | today's single gateway = a depth-1 `primary` bearing its own workload; bare `CapabilityId` resolves under the default tenant/workload; addresses are a **strict superset** | no breaking migration; existing grants/tokens keep resolving |
| **—** | Health fallback | typed **`capability_unavailable` + `unavailableSince`**; **no replica/failover** | accurate signal to the caller; not distributed-system DR |
| **—** | Revocation / skill cascade | revoke = stop-forward + tombstone (proxy holds no grant); proxy pushes `CapabilityEntry[]`+skills, primary **mounts** them (Inv G) | near-forced by tunnel-trust + mount |

**Transport premise (asserted, NAT-forced).** A proxy **dials out** a persistent, mutually
authenticated tunnel to its primary; enrollment, catalog-push, invoke-forward and audit-bubble all
multiplex over it. The primary pushes invokes **down** that dialed connection — no inbound hole on
the proxy host.

**Two trust boundaries (do not conflate).** ① agent ↔ primary — today's connection-key / HS256
scoped-token, **unchanged**. ② primary ↔ proxy — the new Ed25519 mutual-auth tunnel (Q2). Different
credentials, different lifecycles.
