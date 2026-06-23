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
