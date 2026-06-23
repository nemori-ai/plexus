# Plexus minimal AI-agent harness

A standalone, dependency-light client that proves **any AI agent can self-discover
and call a local capability** by speaking only the frozen Plexus M0 protocol
(`v0.1.1`). It drives the full loop end-to-end:

```
DISCOVER  →  UNDERSTAND  →  GRANTED  →  CALL
GET /.well-known   POST /link/handshake   PUT /grants   POST /invoke
```

## Files

- **`client.ts`** — the typed protocol client (`PlexusClient`). Imports the frozen
  types from `src/protocol` and implements the agent side:
  `discover()`, `handshake(connectionKey)`, `requestGrants(ids, { verbs })`
  (transparently handling the `grant_pending_user` poll path), `invoke(id, input)`
  / `invokeOrThrow(...)`, plus `refresh()` and `refreshManifest()`. It always sends
  the correct `Host: 127.0.0.1:<port>` header and reads endpoint URLs from the
  `.well-known` advertisement (never hard-codes paths). Endpoint-level failures are
  raised as a typed `PlexusProtocolError` carrying the closed-union `ErrorCode`.
- **`run.ts`** — a runnable demo: boots a real gateway, registers an Obsidian vault
  read-only capability over a temp vault of `.md` notes, then performs the whole
  loop and prints each step (discovery list → chosen capability → granted read of a
  real note), plus a deliberate un-granted invoke to show the gateway denies it.

## Run the demo

```bash
bun run examples/min-agent/run.ts
```

This is fully self-contained — it boots its own loopback gateway on an ephemeral
port and creates a throwaway vault, so no setup is needed. It exits non-zero if any
step of the loop fails (including if the un-granted invoke is NOT denied).

### Point at an already-running gateway

```bash
PLEXUS_BASE_URL=http://127.0.0.1:7077 \
PLEXUS_CONNECTION_KEY=plx_live_… \
  bun run examples/min-agent/run.ts
```

The connection-key is shown by the management client (the user pastes it in,
`connectionKeyDelivery: "user-paste"`). The external gateway must already have a
capability registered (e.g. an Obsidian vault).

## Use the client in your own agent

```ts
import { PlexusClient } from "./client.ts";

const client = new PlexusClient({
  baseUrl: "http://127.0.0.1:7077",
  client: { name: "my-agent", agentId: "agent-1" },
});

const wk    = await client.discover();              // capability summaries
await client.handshake(connectionKey);              // full manifest
const cap   = client.entries().find(e => e.kind === "capability" && e.grants[0] === "read");
await client.requestGrants([cap.id]);               // read-only scoped token
const out   = await client.invokeOrThrow(cap.id, { path: "Index.md" });
console.log(out.output);                             // real note content
```

The client also accepts an injected `fetch` (e.g. a Hono app's `app.request`) so it
can drive the gateway in-process — that is how `tests/agent-harness-loop.test.ts`
exercises the full loop against the real gateway.
