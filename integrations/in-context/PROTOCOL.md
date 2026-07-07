<!-- BEGIN PLEXUS -->
## Plexus — the user's local capability gateway (HTTP-only, no install)

This user runs **Plexus**, a local capability gateway. It exposes their local
capabilities — reading their notes, running a sandboxed local tool, any registered
local source — behind one uniform HTTP protocol.

You reach it over **plain HTTP** at `{{GATEWAY_URL}}`. There is **nothing to install**:
no CLI, no plugin, no filesystem writes. You already have an HTTP client (your own
`fetch` / `curl`), so the whole integration is: speak HTTP to the gateway, following
its own self-description.

### The protocol is SELF-DESCRIBING — bootstrap from `.well-known`, don't guess

Before anything else, read the gateway's self-description (no auth required):

```
GET {{GATEWAY_URL}}/.well-known/plexus
```

It returns a capability summary plus an `auth` block that tells you, machine-readably,
exactly how to call every endpoint:

- `auth.requestShapes` — the precise request shape (URL, method, auth, body field
  names) for `handshake`, `grantRequest`, and `invoke`.
- `auth.enrollment` — how to turn your one-time code into your own durable credential
  (the request body, the success shape, and where to store the result).

**Follow that self-description.** The steps below are the shape you will find there;
if a field ever differs, the live `.well-known` document wins.

### Every request carries a `Host` header matching the gateway

Send `Host: {{GATEWAY_HOST}}` on every request (a loopback host guard rejects a
mismatch). A normal HTTP client aimed at `{{GATEWAY_URL}}` sets this for you; only set
it by hand if you are hand-crafting requests.

### The five steps

1. **DISCOVER** — `GET {{GATEWAY_URL}}/.well-known/plexus` (no auth). Read the
   capability summary + `auth.requestShapes` + `auth.enrollment`.

2. **ENROLL** — redeem the one-time code your administrator gave you for your own
   durable credential (a **PAT**). Do this ONCE:
   ```
   POST {{GATEWAY_URL}}/agents/enroll
   Content-Type: application/json

   { "code": "<your one-time enrollment code (plx_enroll_…)>" }
   ```
   The success response returns your PAT (a `plx_agent_…` string) and your `agentId`.
   The PAT is returned **only once** — **store it yourself** (in your own memory /
   context / secret store). You never touch the one-time code again.

3. **HANDSHAKE** — open a session and receive the FULL manifest:
   ```
   POST {{GATEWAY_URL}}/link/handshake
   Authorization: Bearer <your PAT (plx_agent_…)>
   ```
   (No body — your PAT alone authenticates.) The response gives you a `sessionId` and
   the complete `manifest` (`manifest.entries[]`, each with its full call contract).

4. **GRANT** — request the capabilities you intend to call in this session:
   ```
   PUT {{GATEWAY_URL}}/grants
   Content-Type: application/json

   { "sessionId": "<from handshake>", "grants": { "<capabilityId>": "allow" } }
   ```
   On success you receive a **scoped JWT** that authorizes the granted calls. (A
   capability already granted standing by the owner short-circuits — the call just
   works. A not-yet-approved one comes back needing the owner's approval; relay that,
   don't retry blindly.)

5. **INVOKE** — call a capability with the scoped token:
   ```
   POST {{GATEWAY_URL}}/invoke
   Authorization: Bearer <the scoped JWT from GRANT>
   Content-Type: application/json

   { "id": "<capabilityId>", "input": { … } }
   ```
   On success you get the real result. Branch on `error.code` (a closed set) rather
   than retrying blindly.

### Read each call's input SHAPE from the manifest — not from prose

To build the `input` for a call, read the **structured JSON Schema** at
`manifest.entries[<the entry>].io.input` from your HANDSHAKE response. That schema is
authoritative for any capability — bind your arguments to it. Do NOT infer argument
names from the capability's human summary; the `io.input` schema is what the gateway
validates against.

### Your credential is your PAT — NEVER the connection-key

You authenticate with **your own PAT** (`plx_agent_…`), minted at ENROLL and stored
by you. The admin **connection-key** (`plx_live_…`) is the owner's out-of-band trust
boundary — it is **never** yours, never sent by you, and never needed for any step
above. If a step seems to want the connection-key, you have taken the owner/admin
path by mistake — use the PAT (Bearer) path.

### PAT lifecycle

Enrollment happens **once**; the stored PAT authenticates every later session
(HANDSHAKE → GRANT → INVOKE). A short-lived / single-shot agent may keep the PAT only
in memory for the run. A stateful cloud agent should retain its PAT across its own
session so it can re-handshake without re-enrolling — the one-time code is single-use,
so do not enroll twice.

### What a grant means

Every call is governed by a **grant**: a standing, human-approved permission for this
agent to use a capability, bounded by a **trust-window**. A standing, unexpired grant
short-circuits the re-ask. When a call comes back needing approval, relay the
gateway's narration verbatim, name the real trust-window (never call a `7d` grant
"just this once"), point the user to the Plexus console to approve, then re-run.
<!-- END PLEXUS -->
