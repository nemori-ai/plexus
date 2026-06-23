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
   `grants` (the cost: `read`/`write`/`execute`), `transport`, one-line describe,
   plus trust posture when present (`provenance` source-class, `sensitivity`,
   `recommendedTrustWindow`) — read it so you can state the cost before requesting.
2. **Read the usage skill BEFORE calling.** `plexus skills <id> --json`
   Fetches the capability's usage guidance (input shape, conventions, gotchas).
   This is why Plexus beats a raw tool list — read it, then call correctly.
3. **Call.** `plexus call <id> --input '<json>' --json`
   Runs handshake → grant → invoke and prints the real result as an
   `InvokeResponse` (`ok`, `output`, `auditId`, or `error.code`).

Use `--json` everywhere so you can parse rather than scrape.

### What a grant means — explain it before you request it

Every call is governed by a **grant**. Use this vocabulary verbatim (same words as
the UI / API / docs):

- **agent** — the self-asserted label your standing grants are scoped to
  (`plexus-cli`, the handshake `client.agentId`). A stable `agentId` lets Plexus
  remember your standing grants across sessions (a convenience, **not** a security
  boundary — the connection-key is the boundary; rotate it to revoke all). An `anon:*`
  agent gets **no standing trust** and re-asks every session.
- **capability** (the `id`) · **scope** (one `capability × verbs` line on a token) ·
  **grant** (standing, **human-approved** `(agentId, capabilityId, verbs)`) ·
  **trust-window** (how long the grant stands before re-asking) · **token** (a
  ≈15-min auto-refreshed **view** of the grant — you never manage it).
- **provenance / source-class**: `first-party` / `managed` / `extension`.
  **sensitivity**: `low` / `elevated` / `high`.

**Two clocks, kept straight:** **token-lifetime** (~15 min — blast radius of a
leaked credential; auto-refreshed; not your concern) vs **trust-window** (how long
the human's approval stands before Plexus re-asks — the one you NARRATE).

**Source-class explains the asking:** first-party + managed **reads** may
auto-allow (still listed in `/admin` → Grants — nothing silent); **all
write/execute pend**; **extension capabilities always ask — even for reads** (not
an error). A standing unexpired grant short-circuits the re-ask; a `once` grant is
single-use and never does.

### Handling responses

- **Success:** `ok: true` with `output` — use it.
- **`grant_pending_user`:** the capability needs the user's approval. The CLI prints
  a stderr notice carrying a **gateway-authored `pendingNarration.summary`**.
  **Relay that summary verbatim**, then state the **capability**, **verbs**,
  **trust-window**, and that it is **revocable anytime**. Point the user to
  `/admin` → **Pending** to approve (e.g. `http://127.0.0.1:7077/admin`) and
  `/admin` → **Grants** to revoke. The CLI polls until resolved, then completes.
  **Truthfulness rule:** never say "one-time" / "just this once" unless the
  trust-window is actually `once` — name the **real** window (a `7d` grant keeps
  working for a week). Pass `--trust-window once` if you want single-use (advisory:
  the human may shorten, never lengthen past the per-class ceiling).
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
