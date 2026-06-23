# `plexus` — the shared Plexus integration CLI

The single client engine both per-agent wrappers (ti-cc, ti-codex) drive over the
shell. It wraps the agent-side `PlexusClient` (`examples/min-agent/client.ts`) and
exposes the Plexus protocol as four shell-friendly verbs.

## Run

```sh
bun integrations/cli/bin/plexus <command> [options]
```

## Commands

- `discover` — **scan**: `GET /.well-known/plexus`, print id/kind/label/one-line
  describe/grants/transport per entry. Pre-session; no connection-key.
- `manifest` — handshake → the FULL manifest (full describe / io / attached skills).
- `skills [<id>]` — list `kind:"skill"` entries; with `<id>`, **FETCH the skill
  body** (the usage knowledge). The "skill" half of "API + skill".
- `call <id> [--input <json>]` — handshake → grant (poll if `grant_pending_user`,
  pointing the user to `/admin`) → invoke → print the REAL result.
- `source <subcommand>` — **manage capability sources** over the same-origin admin
  API (`/admin/api/sources*`). Not a protocol command — a thin HTTP client over the
  trusted local management surface (see below).

## `source` — manage capability sources

```sh
plexus source list                 # configured sources: id/kind/transport/enabled/live/capabilityCount
plexus source detect               # sources the gateway detects as reachable + a hint how to add each
plexus source add <kind> [opts]    # register LIVE + persist a source
plexus source enable  <id>         # re-register + persist enabled:true
plexus source disable <id>         # unregister + persist enabled:false (config kept)
plexus source remove  <id>         # unregister + drop from config + purge its grants
```

`add` flags: `--id <id>` (default: the kind), `--base-url <url>` (REST kinds),
`--vault-path <path>` (fs kinds), `--secret-name <name>` (the secret it references),
`--api-key-stdin`, `--label <label>`, `--transport <t>`.

**API key via STDIN (never argv).** `--api-key-stdin` reads the key from STDIN and
`POST`s it to `/admin/api/secrets/<--secret-name>` FIRST (write-only, stored 0600),
then registers the source with `secretRef = <name>`. The key NEVER appears on argv —
no shell-history / process-table leak:

```sh
printf %s "$OBSIDIAN_KEY" | plexus source add obsidian-rest \
    --base-url https://127.0.0.1:27124 --secret-name obsidian-key --api-key-stdin
```

**Auth.** The admin API is the trusted local management surface: it is guarded by the
gateway's loopback Host/Origin guard and reads the connection-key server-side. So
`source` (like the protocol commands) requires the local `~/.plexus/connection-key`
(or `--key` / `PLEXUS_CONNECTION_KEY`) and ALWAYS sends the loopback `Host` header
plus the `X-Plexus-Connection-Key` management header. Target the gateway via `--url`
/ `PLEXUS_URL` / `PLEXUS_PORT`. `--json` makes every subcommand machine-parseable.

## Targeting + auth

- Gateway URL: `--url` > `PLEXUS_URL` > `http://127.0.0.1:${PLEXUS_PORT:-7077}`.
- Connection-key (handshake-backed commands only): `--key` > `PLEXUS_CONNECTION_KEY`
  > `${PLEXUS_HOME:-~/.plexus}/connection-key` (auto-read — a local agent needs no
  paste). `discover` needs no key.
- Always sends the loopback `Host` header (gateway host/origin guard).
- `--json` makes any command machine-parseable; failures carry the closed
  `ErrorCode`. Exit code 0 on success, non-zero on protocol/usage failure.

## Examples

```sh
plexus discover
plexus skills obsidian.vault.how-to-cite
plexus call obsidian.vault.read --input '{"path":"Index.md"}'
plexus call obsidian.vault.read --input '{"path":"Index.md"}' --json
```

## Verified

`tests/integrations-cli-e2e.test.ts` boots a real gateway + real read-only vault
and drives this binary as a subprocess, asserting real discovered ids, a real
fetched skill body, and a real note's content via invoke. No mock.

`tests/msrc-t3-source-cli.test.ts` boots a real gateway (throwaway PLEXUS_HOME) and
drives `plexus source` as a subprocess: `detect` finds a reachable source, `add
… --api-key-stdin` reads the key from STDIN (asserting it never hits argv) + stores
it 0600 + the source goes LIVE (shows in `source list` and `discover`), and
`disable`/`enable`/`remove` flip live/enabled state.
