# Plexus Security & Threat Model

Plexus hands AI agents real, scoped access to your machine. This document is the
honest account of *how* that stays safe — the trust boundary, the defenses, and,
just as important, **what Plexus does not protect against**. Read it before you
ever change the default network binding.

If you haven't yet, skim [concepts.md](concepts.md) for the trust model
(provenance, scoped grants, the two clocks). This page is the adversarial view of
the same machinery.

---

## 1. The default posture: loopback only

By default the gateway binds **`127.0.0.1` only** — not the LAN, not `0.0.0.0`.
Combined with a Host/Origin guard (below), this means that **in the default
posture** a process on *another machine* simply cannot reach Plexus. The threat
surface starts as "code running on this Mac, as this user." (Binding to a LAN NIC
or `0.0.0.0` is **opt-in** and deliberately changes this boundary — see §5, where
the connection-key gate over every `/admin/api/*` route becomes the trust boundary
for the management surface.)

On top of the loopback bind, **every** request passes a **Host/Origin guard**
before any handler runs. Loopback bind alone stops neither other local processes
nor a DNS-rebinding browser attack, so the guard validates that the `Host` header
is an accepted authority (a loopback authority on the default config) and that any
`Origin` is allow-listed or loopback. A non-loopback `Host` (a LAN IP, a
rebinding hostname like `evil.example.com`, or `0.0.0.0`) is rejected with
`host_forbidden` (HTTP 403). Agent CLIs send no `Origin` and are allowed through;
a cross-origin browser request is not.

---

## 2. The connection-key is the trust boundary

The **connection-key** (`plx_live_…`, stored at `~/.plexus/connection-key`) is the
secret that separates "a process that can reach the gateway" from "the trusted
party." It does two things:

- An **agent** presents it **once** at `POST /link/handshake` to open a session.
  Thereafter the agent holds only short-lived scoped tokens — it **never** sends
  the connection-key again. (A token expiring re-mints from the standing grant via
  `POST /grants/refresh` with the *old token*, not the key.)
- The **management surface** is gated by it: presenting a verified connection-key
  via the `X-Plexus-Connection-Key` header is what proves you are the trusted
  management client, not an arbitrary local caller.

### The key is never served over an agent-reachable API (the F2 fix)

This is the linchpin. **There is deliberately no `GET /admin/api/connection-key`
route — and no payload anywhere hints that such a key exists.** An untrusted agent
only ever speaks HTTP over loopback; any HTTP route that returned (or leaked) the
key would let that agent escalate straight to the management surface. So the key
is obtained strictly **out of band**:

- the **desktop app** reads `~/.plexus/connection-key` and injects it into the
  admin page over Electron IPC;
- the **CLI launcher** prints it to its own terminal at startup for a human to
  paste once into a browser/dev session;
- the **`plexus source` CLI** reads the key file directly.

The web-admin SPA resolves the key in that order (desktop inject → cached → human
paste) and attaches it on every admin API call. The only thing served key-free is
the SPA's own HTML/asset bytes, so the page can load.

**Implication:** keep `~/.plexus/connection-key` private (it's `0600`). Anyone who
can read that file can drive your management surface. Resetting it is as simple as
removing `~/.plexus/` and restarting (you'll get a fresh key + signing secret).

---

## 3. Opting into LAN binding — and why it re-gates everything

You *can* open Plexus to your LAN (e.g. to reach it from your phone), via the
`/admin` Network panel or `~/.plexus/network.json`. This is a deliberate,
validated opt-in:

- A chosen address must be a **loopback literal**, the `0.0.0.0` bind-all
  sentinel, or an address that is **actually one of this machine's interfaces**
  (validated against a live interface scan). A bogus or non-local address is
  rejected — nothing is written. `0.0.0.0`, if chosen, must be the sole entry.
- The Host/Origin guard's accept-set then expands to *exactly* those bound
  addresses (for `0.0.0.0`, a fixed snapshot of this machine's interface IPs) —
  **never "any host."** A foreign `Host` the machine doesn't own is still
  rejected. Loopback is always accepted; the DNS-rebinding defense for the default
  case is untouched.
- Binding changes **persist and require a restart** to take effect (the response
  says `restartRequired: true`).

Crucially, once you bind a LAN interface, a real LAN device can reach
`/admin/api/*` too. So Plexus **re-gates the entire admin data surface behind the
connection-key — reads *and* writes — uniformly.** (Originally the read-only
`GET`s — capabilities, tokens, audit, sources, health — were loopback-only without
a key, which was fine while strictly loopback; opening the bind would otherwise
leak that local discovery state to any LAN peer, so they're all key-gated now.) A
LAN peer only speaks HTTP and can never present the out-of-band key, so it can read
nothing and change nothing.

The agent protocol surface (`.well-known`, `/link/handshake`, `/grants`,
`/invoke`, `/events`, `/manifest`, `POST /extensions`) is *not* under
`/admin/api/*` and keeps its own auth — handshake still requires the
connection-key, invoke still requires a valid scoped token.

---

## 4. Egress confinement — the local-rest redirect re-gating (the F1 fix)

Some sources reach an external listener over HTTP — e.g. the Obsidian Local REST
API plugin on loopback, with a Bearer secret attached. This is an SSRF /
secret-exfiltration risk if not confined, so the `local-rest` transport is
defended at dispatch time, **independent of how the source was registered**:

- **Host allow-list.** The resolved destination is checked with the *same*
  loopback/allow-list logic the gateway's own Host guard uses. Loopback is always
  allowed; a non-loopback host is allowed only if it's on the user-confirmed
  allow-list. A disallowed host → `host_forbidden`, and the **secret is never
  attached**.
- **No automatic redirect-following (the F1 fix).** The request is issued with
  `redirect: "manual"` so `fetch` never auto-follows a `3xx`. Otherwise a
  `local-rest` listener the extension controls could pass the host check, get the
  Bearer attached, then `302` to an attacker host and exfiltrate the secret. On a
  `3xx`, Plexus resolves the `Location` and **re-runs the host gate on the redirect
  target afresh** — re-deciding loopback-TLS relaxation and secret-attach per hop.
  A redirect to a non-allow-listed host is refused and the secret is never
  replayed to it. Redirect chains are bounded to a maximum hop count.
- The secret **value** is resolved at dispatch time and attached per hop only when
  that hop is allowed, so the credential can only ever reach a loopback or
  user-allow-listed host.

---

## 5. CLI transport hardening

Capabilities backed by the `cli` transport invoke a binary with argv. This is the
sharpest edge, so the policy is **default-deny and enforced at dispatch even if the
registration path was bypassed**:

- Absolute/relative paths, shell interpreters, and shell metacharacters are denied
  **unconditionally** — those denials always apply, regardless of policy. On top of
  that, **when an extension declares a binary allow-list, the bin is further
  restricted to the listed names**; when it declares *no* allow-list, a
  structurally-safe bare name (no path separators, no shell metacharacters, not a
  shell/interpreter) is permitted (back-compat). Tightening the no-allow-list path
  to require an explicit allow-list for new extensions is tracked (see
  [KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md)).
- An allowed bare name is resolved via `PATH`; Plexus **never** falls back to
  executing the verbatim string (an unresolved bin is `source_unavailable`, not a
  blind exec).
- Arguments are passed as a real argv vector with `{token}` substitution — never
  string-interpolated into a shell — and the child environment is sanitized.

---

## 6. Default-deny + human approval for anything sensitive

The authorization model (detailed in [concepts.md](concepts.md)) is itself a
security control:

- **Default-deny.** A successful handshake grants *knowledge*, never call
  authority. An agent that has never been granted a capability is denied at
  `/invoke` with `grant_required`.
- **Owner-controlled exposure gate.** Exposure (what-I-expose) is the owner's
  outer gate: a capability the owner disables is invisible in discovery, not
  grantable, and denied at `/invoke` with `capability_unexposed` — enforced
  **before** the grant check. Effective access = **granted ∧ exposed**, so the
  owner can cut off a capability regardless of any standing grant.
- **Per-capability gating by provenance.** A first-party / managed **read**
  auto-approves; a **write** or **execute**, and **any** verb on an
  agent-registered **extension**, **pends for a human** (`grant_pending_user`).
  An agent can never self-grant a sensitive capability — including registering its
  own extension, which validates and then pends a human confirmation before any
  capability activates.
- **Approval is install/config-time, not every-restart.** Human approval gates the
  *act of persisting* a source or grant. On a later restart Plexus **trusts the
  already-persisted config** and boots it without re-prompting — distinct from a
  fresh install/registration, which does pend a human. This is accepted under the
  "same-user malicious process is out of scope" threat model (anyone who can rewrite
  the persisted config already has your user's filesystem access); a write-capable
  boot-load still emits a `source.install` audit event so the trust is observable.
- **Short blast radius.** Scoped tokens default to **15 minutes**, so a leaked
  token is worthless within minutes even while the standing grant persists.
- **Honest, gateway-authored narration.** The risk summary the human approves is
  written by the gateway, not the agent. The agent's optional "why now" purpose is
  shown labeled "the agent says:", is sanitized and truncated, and influences no
  decision.
- **Visible, revocable trust.** Every standing grant is in the `/admin` Grants
  ledger (and the agent's own `GET /grants`); revoke any grant, token (by `jti`),
  or whole task bundle (by `bundleId`) at any time. Every handshake, grant, token,
  invoke, and revoke is recorded to an **append-only local audit trail**
  (`GET /admin/api/audit`) — including pre-dispatch *denials*, and with secrets
  redacted. Treat this as **best-effort observability, not a durable or
  tamper-evident ledger**: persistence is local and failures are swallowed (the
  event id is still returned to the caller even if the write didn't land).
- **Source health is advisory.** The backing-app status surfaced to agents and the
  `/admin` health view is **cached (stale-while-revalidate), not a per-invoke
  liveness guarantee** — a source can read "healthy" and still be down at the moment
  of dispatch (the invoke itself returns `source_unavailable` in that case).

---

## 7. What Plexus does NOT protect against

Be precise about the boundary:

- **A malicious process already running as your user.** Loopback *is* the trust
  boundary, but any code running as you can read `~/.plexus/connection-key`
  directly off disk — and with it drive the management surface or handshake as a
  trusted agent. Plexus is not a sandbox against malware you've already run. It
  raises the bar for *AI agents you connect over the protocol*; it does not contain
  an attacker who already has your user's filesystem access.
- **A connection-key you leak.** Treat it like a password. Pasting it into an
  untrusted agent, a shared terminal log, or a screenshot hands over the
  bootstrap secret. Rotate by removing `~/.plexus/` and restarting.
- **The judgment behind an approval.** Plexus makes risk legible (provenance,
  sensitivity, gateway-authored narration) and time-boxes the grant — but if you
  approve a `write` to an agent that misuses it, that's a granted action, audited,
  not a breach. Pick trust-windows deliberately; prefer `once` or short windows
  for sensitive verbs.
- **The security of sources you add.** A managed source you point at a remote
  endpoint, or an MCP server you ingest, inherits that endpoint's trust. The
  egress and CLI confinements above bound *how* Plexus talks to them; they don't
  vouch for the third party itself.

---

## Reporting & references

- The mental model and authorization UX: [concepts.md](concepts.md).
- The directional north-star spec: the internal
  [AUTHZ-UX-MODEL design doc](archive/design/AUTHZ-UX-MODEL.md).
- Getting started safely on macOS: [getting-started.md](getting-started.md).
