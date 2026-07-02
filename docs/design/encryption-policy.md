# Encryption policy — mandatory channel encryption + cert/key management

> Status: **design** (drives the "encryption hardening" implementation track).
> SSOT = `federated-mesh-domain-model.md` (esp. §7 Q2).
> This doc covers a primary-side **mandatory-encryption policy** (refuse plain-ws
> proxy tunnels, accept only `wss`/enc-ON), and the cert/key management story (TLS cert
> reload, Ed25519 + TLS rotation procedure).

## 0. The axis this is on — identity ⟂ encryption (mesh §7 Q2)

Q2 commits two **orthogonal** layers on the proxy↔primary tunnel:

1. **Identity** — **Ed25519 mutual auth**, pubkeys pinned at enrollment. This is *who* the
   peer is. It is **always on**: every tunnel, ws or wss, completes the mutual challenge
   before a single data frame is honored (`handshake.ts`). The encryption policy does **not**
   touch identity.
2. **Channel encryption** — an **optional, default-on** confidentiality layer (`wss`/TLS)
   *underneath* the identity layer. Because identity is asymmetric and pinned, the channel
   can be a self-signed `wss` (confidentiality only — the Ed25519 layer already authenticates,
   so a self-signed cert is sufficient; mesh §7 Q2 "works over an already-encrypted underlay",
   B7 "self-signed-confidentiality is OK").

The mandatory-encryption policy is purely about **layer 2**: it makes the primary *require*
the `wss` channel and **refuse** a plain-ws tunnel. Identity is unaffected — a plain-ws proxy
with a perfectly valid pinned key is still refused, because the **channel** is not encrypted.

## 1. The policy knob — `PLEXUS_MESH_REQUIRE_ENCRYPTION`

- **Config.** `PLEXUS_MESH_REQUIRE_ENCRYPTION=1` (truthy: `1`/`true`/`yes`/`on`) parsed in
  `config.ts` into `MeshTunnelBind.requireEncryption`. Default **off** ⇒ today's behavior
  exactly (plain ws still works — backward compatible, mesh §7 Q8).
- **Fail-fast misconfig.** `requireEncryption` with **no** TLS material is a dead-end (the
  primary would refuse *every* proxy, since plain ws is then the only listener). Config load
  **throws** a clear error: require-encryption needs `PLEXUS_MESH_TLS_CERT` +
  `PLEXUS_MESH_TLS_KEY` (and therefore a `wss` listener). This mirrors the existing
  `PLEXUS_MESH_WSS_PORT`-without-TLS fail-fast.
- **Enforcement point — the handshake, fail-closed with a typed reason.** The `MeshServer`
  binds **two** listeners that share one connection model (B7): the plain-`ws` acceptor and
  the `wss` acceptor. Each carries a per-connection `encrypted` flag (true on the `wss`
  listener, false on the `ws` one). The flag is threaded into the **primary handshake driver**.
  When `requireEncryption` is set and a connection is **not** encrypted, the driver — at the
  **first** inbound handshake message, *before* any `admit()` / pin check — emits
  `auth-fail` with reason **`encryption_required`** and fails the socket closed. So:
  - A plain-ws **enroll** is refused *before the one-time token is consumed* — the operator can
    retry the same token over `wss` (nothing was burned).
  - A plain-ws **challenge-only reconnect** (already-enrolled workload) is likewise refused.
  - A `wss` tunnel proceeds normally (encrypted ⇒ policy satisfied) — identity still gates it.
- **Why the handshake, not the socket.** Refusing at the handshake gives the proxy a *clear
  typed reason* (`encryption_required`) instead of a bare socket close it would read as a
  generic blip. It is also exactly where "this connection's credentials/channel are
  unacceptable" already lives (the same place `not_enrolled` / `bad_signature` are emitted).

## 2. Cert/key management

Two distinct key materials, two lifecycles — **do not conflate** (mesh §7 "two trust
boundaries"):

| Material | What it secures | Rotation cadence | Pinned by |
| --- | --- | --- | --- |
| **Ed25519 mesh identity** (primary + each proxy) | *Identity* (layer 1) — the mutual-auth pin | rare (key compromise / policy) | the peer, at enrollment |
| **TLS cert/key** (`wss` listener) | *Channel encryption* (layer 2) — confidentiality | routine (cert expiry, e.g. 90d) | TLS trust store / `tls.ca` |

### 2.1 TLS cert reload — without a full process restart

The TLS material is read from `PLEXUS_MESH_TLS_CERT` / `_KEY` files at primary `start()`.
A cert rotation should not require bouncing the whole gateway (the agent↔primary HTTP plane,
grants, sessions, audit are all unrelated to the mesh TLS cert). The `MeshServer` exposes a
**`reloadTls()`** seam that re-reads the configured cert/key files and rebinds **only the
`wss` listener** — the plain-`ws` listener, all in-flight `ws` connections, and the whole HTTP
plane are untouched. Existing `wss` connections drop and **auto-reconnect** (§networking-
resilience) onto the freshly-bound listener with the new cert; the Ed25519 identity is
unchanged, so they re-authenticate without re-enrollment.

> **CAVEAT — listener-rebind, not in-place socket re-key.** Bun's `Bun.serve({ tls })` takes
> its TLS material at construction; there is **no public API to swap a live listener's cert
> in place**. So `reloadTls()` is implemented as **stop-the-wss-listener + re-`Bun.serve` it**
> with the new material (the `ws` listener and connection model persist). The cost is that
> open `wss` tunnels are dropped and must reconnect — which the resilience track makes cheap
> and automatic (capped backoff + re-auth + catalog re-push). If a future Bun exposes a live
> cert swap, `reloadTls()` becomes the natural home for it with no caller change. A full
> process restart remains the fallback for environments that cannot tolerate the brief `wss`
> reconnect.

> **ROLLBACK ON A FAILED REBIND.** Because the rebind is stop-then-re-serve on the *same* port,
> there is a window where the old listener is already stopped before the new `Bun.serve` runs. If
> the new material is bad (malformed cert/key, or the port is not yet reusable) the re-serve
> throws — leaving the `wss` plane DOWN with a dangling stopped reference. `reloadTls()` guards
> this: on a failed rebind it **rolls back** by re-serving with the previous known-good material,
> so the channel comes back up on the old cert; the new material is committed only on a successful
> rebind. If the rollback *also* fails, the server reference is set to `null` (a consistent DOWN
> state, no dangling ref). Either way the original error is **rethrown loudly** so the admin caller
> sees that the requested reload did not take effect.

### 2.2 Rotation procedures

**TLS cert rotation (routine, e.g. before 90-day expiry):**
1. Issue the new cert/key (same CN/SAN for the primary's reachable host); write them to the
   paths `PLEXUS_MESH_TLS_CERT` / `_KEY` point at (atomic replace).
2. Call `reloadTls()` (admin action / signal) — the `wss` listener rebinds with the new cert.
3. `wss` proxies drop and auto-reconnect onto the new cert. If proxies pin the cert via a
   custom CA (`upstream.tls.ca`), distribute the new CA **first** (overlap window) so a
   reconnecting proxy trusts the new cert. With a publicly-trusted cert, no proxy-side change.
4. No Ed25519 re-enrollment — identity is independent of the channel.

**Ed25519 mesh-identity rotation (rare — primary key compromise/policy):**
The primary's Ed25519 key is the **mesh trust root** every proxy pins as
`upstream.primaryPubKey` (M1). Rotating it is a **re-pin**, not a cert swap:
1. Generate the new primary identity (out-of-band); publish the new public key.
2. Distribute the new `PLEXUS_UPSTREAM_PUBKEY` to each proxy operator.
3. Proxies restart with the new pin; they re-enroll (mint fresh one-time join tokens — the
   old pin no longer matches, so the mutual challenge would fail closed otherwise).
4. The old identity is retired. (A proxy-side Ed25519 rotation is symmetric: the proxy
   re-enrolls so the primary re-pins its new pubkey; until then the old pin gates it.)

> The asymmetry is deliberate: a **TLS** rotation is hot-reloadable + transparent (channel
> only); an **Ed25519** rotation is a deliberate trust event that re-pins the mutual-auth
> anchor and therefore flows through enrollment. Conflating them (e.g. re-pinning on every
> cert renewal) would defeat Q2's identity ⟂ encryption separation.

## 3. Test obligations

- **Require-encryption ON ⇒ plain-ws refused, wss accepted.** With the flag set, a plain-ws
  proxy enrollment is refused (typed `encryption_required`, token **not** consumed, workload
  **not** enrolled) while a `wss` proxy enrolls + forwards normally.
- **Default off ⇒ plain ws still works** (back-compat — covered by the existing dual-listener
  spec, which sets no flag).
- **Fail-fast** when `requireEncryption` is set without TLS material (config throws).
