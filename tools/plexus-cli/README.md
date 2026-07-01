# `plexus` — the encapsulated call-script (G2-SCRIPTS)

The thin, native-feeling CLI an agent uses to call its Plexus capabilities. It **eats
the ugliness**: the agent sees only

```
plexus enroll <one-time-code>      # first run: redeem your code -> durable PAT (stored once)
plexus <capabilityId> <args...>    # e.g.  plexus workspace.read README.md
```

and never the plumbing. A capability call silently runs the whole chain

```
read local PAT → handshake (Bearer PAT) → (standing) scoped token → invoke
```

inside this binary; only the invoke **result** reaches the agent's stdout.

> SSOT: [`docs/design/agent-skill-compile-domain-model.md`](../../docs/design/agent-skill-compile-domain-model.md)
> §4 + Inv III/VI, and [`docs/design/cc-plugin-artifact-spec.md`](../../docs/design/cc-plugin-artifact-spec.md) §3/§4/§5.

## Command surface

| Command | What it does |
|---|---|
| `plexus enroll <one-time-code>` | Redeems the one-time enrollment code (`plx_enroll_…`) over HTTP for a durable per-agent PAT (`plx_agent_…`), stores it locally (once), and prints success. |
| `plexus <capabilityId> <arg…>` | Positional args bind, in order, to the capability's declared input fields (read from the Floor/manifest `io.input` — never guessed). |
| `plexus <capabilityId> key=value …` | Named input fields. |
| `plexus <capabilityId> --input '<json>'` | Full JSON input object (wins over positionals). |
| `plexus <capabilityId> --json` | Print the raw `InvokeResponse` JSON. |
| `plexus help` | Usage. |

Options: `--url <base>` (gateway base URL), `--agent <id>` (pick a PAT when several are enrolled).

## How the PAT is stored / read (never baked)

- **Enroll writes** the PAT to `~/.plexus/agents/<agentId>.pat` (mode `0600`) — the base dir
  is `$PLEXUS_HOME` if set, else `~/.plexus`. The distributable script dir carries **no**
  credential; the PAT lives only in the agent's own store.
- **Calls read** the PAT with this precedence (the agent's own paradigm first):
  1. `$PLEXUS_PAT` env var,
  2. a project-local `.env` line `PLEXUS_PAT=plx_agent_…`,
  3. `~/.plexus/agents/<agentId>.pat`.
- **Inv III:** this script reads only the agent's **own** PAT. It never reads, requires, or
  presents the admin **connection-key** (no `connectionKey` body field, no
  `X-Plexus-Connection-Key` header, no `plx_live_` value).

## Routes come from the Floor (Inv VI)

Every route and request shape is read from `GET /.well-known/plexus` → `auth.*`
(`enrollment`, `requestShapes.handshake/grantRequest/invoke`, `handshakeUrl`,
`grantRequestUrl`, `invokeUrl`, `sessionHeader`). Nothing is hard-coded, so the flow stays
**deterministic and verifiable against the same oracle** — never LLM-authored. The gateway
base URL comes from `--url`, else `$PLEXUS_GATEWAY`, else a `~/.plexus/gateway` pointer file,
else the loopback default (the port is configurable, not hard-assumed).

## Engine self-containment (the runtime choice)

This is **one file, zero dependencies**, written in plain ES-module JavaScript using only
Node built-ins (`node:fs/os/path`) + the web-standard global `fetch`. It therefore:

- runs **unmodified under Node ≥18 _and_ under Bun** (no build step, no `node_modules`);
- can be dropped verbatim into a compiled Claude Code plugin's `bin/plexus` — it references
  **no files outside its own dir** and **does not assume `bun` is present**, which is exactly
  the constraint a cached CC plugin must satisfy (`cc-plugin-artifact-spec.md` §6 risk #2).

This deliberately replaces the older shim that forwarded to a sibling `packages/cli` path run
under `bun` — the highest-risk cold-agent dependency the G0 doc flagged.

## Test

`tests/g2-plexus-cli-e2e.test.ts` boots a real gateway + a read-only vault, mints an
enrollment code + a standing grant, then drives `node tools/plexus-cli/plexus enroll <code>`
followed by the native call end-to-end — asserting the PAT is stored (not baked), the native
command returns the real invoke result, and no connection-key is ever read.
