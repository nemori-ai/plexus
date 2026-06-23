<!-- BEGIN PLEXUS -->
## Plexus — the user's local capability gateway

This machine runs **Plexus**, a local capability gateway (loopback `127.0.0.1`).
It exposes the user's local capabilities — reading their Obsidian vault, running
`cc-master` orchestration, any registered local source — behind one AI-native
protocol, plus a **usage-skill** layer (per-capability "how to use me" guidance).

You reach it through the **`plexus` CLI on your PATH**. Plexus is NOT an MCP
server, so there is nothing to wire into `config.toml` — just run the CLI.

### When to use it

When a task needs something that lives on THIS machine: read the user's notes,
run a local orchestration, call a registered local tool. If unsure what is
available, scan first (`plexus discover`) — it is cheap and read-only.

### How to use it (discovery-first — always scan before calling)

1. **Scan.** `plexus discover --json`
   Lists every entry: `id`, `kind` (`capability` | `skill` | `workflow`),
   `grants` (the cost: `read`/`write`/`execute`), `transport`, one-line describe.
2. **Read the usage skill BEFORE calling.** `plexus skills <id> --json`
   Fetches the capability's usage guidance (input shape, conventions, gotchas).
   This is why Plexus beats a raw tool list — read it, then call correctly.
3. **Call.** `plexus call <id> --input '<json>' --json`
   Runs handshake → grant → invoke and prints the real result as an
   `InvokeResponse` (`ok`, `output`, `auditId`, or `error.code`).

Use `--json` everywhere so you can parse rather than scrape.

### Handling responses

- **Success:** `ok: true` with `output` — use it.
- **`grant_pending_user`:** the capability needs the user's approval. Tell the
  user to open the Plexus management UI (`/admin` on the gateway, e.g.
  `http://127.0.0.1:7077/admin`) and approve the pending grant; the CLI polls
  until resolved, then completes.
- **Other `error.code`** (closed set): `unknown_capability` (re-run `discover`),
  `schema_validation_failed` (fix `--input` against the skill's input shape),
  `source_unavailable` (the backing app isn't running — ask the user to start
  it), `no_connection_key` (the gateway isn't running — ask the user to start
  `bin/plexus`). Branch on the code; don't retry blindly.

### Example

```sh
plexus discover --json
plexus skills obsidian.vault.how-to-cite --json
plexus call obsidian.vault.read --input '{"path":"Projects/Plexus.md"}' --json
```
<!-- END PLEXUS -->
