# Managing capability sources

Plexus exposes external tools to agents as **capability sources**. Sources are
**managed**: you add, remove, enable, disable, and reconfigure them **at runtime**,
they **persist** to `~/.plexus/sources.json`, and they **hot-reload** into the live
registry — **no flag, no gateway restart**. This is the Scan / Adapt / Describe /
Expose thesis in practice.

There are three equivalent entry points, all converging on the one `ManagedSources`
service (so behavior never diverges):

1. the **`/admin` Sources panel** (the trusted same-origin UI) — *primary*;
2. the **`plexus source` CLI** (a thin client over the same admin API) — *primary*;
3. the **launcher flags** (`--vault`, `--obsidian-rest`) — *shortcuts* over the same
   add-and-persist core.

Adding a source makes its capabilities **discoverable only**. Invoking still requires a
per-capability **grant** (default-deny); a write-capable capability still **pends** for
a human grant confirmation.

---

## The model

A configured source is inert, persisted data (`~/.plexus/sources.json`):

| Field | Meaning |
| --- | --- |
| `id` | the source / registry id (also the capability id prefix). |
| `kind` | which adapter materializes it (`obsidian-fs`, `obsidian-rest`, …). |
| `label` | human label shown in the UI/CLI. |
| `enabled` | `false` ⇒ persisted but NOT registered (skipped at boot). |
| `transport` | the resulting transport (`ipc`, `local-rest`, …). |
| `route` | non-secret route config (`baseUrl`, `vaultPath`, …). |
| `secretRef` | the NAME of a secret under `~/.plexus/secrets/`. **Never the value.** |

**Secrets are referenced by name only.** A secret VALUE is written via the write-only
`POST /admin/api/secrets/:name` ingress (the CLI's `--api-key-stdin`); it is never
stored in `sources.json` and never echoed back by any read.

---

## Built-in kinds

| Kind | What | Transport | Secret | Capabilities |
| --- | --- | --- | --- | --- |
| `obsidian-fs` | read-only, path-confined fs read of a vault folder | `ipc` | none | `obsidian.vault.read` |
| `obsidian-rest` | read-WRITE via the Obsidian Local REST API plugin | `local-rest` | `obsidian-local-rest-api-key` (Bearer) | `obsidian-rest.vault.{list,read,write}` |

---

## The `/admin` Sources panel

Open `http://127.0.0.1:<port>/admin` and pick the **Sources** tab:

- **Detected** sources (e.g. a running Obsidian Local REST API) show with one-click **Add**.
- **Add Obsidian REST** form: base URL + API key. The key is stored by name; only the
  reference is persisted.
- Each configured source has **enable / disable / remove / reconfigure** controls.

Because `/admin` is same-origin + connection-key authenticated, the local user is the
human approver — adding a write-capable source there does not require a separate pend.

---

## The `plexus source` CLI

A thin HTTP client over the `/admin` API, authenticated by `~/.plexus/connection-key`.
Run it against a gateway that is already running:

```sh
plexus source list                          # configured sources + live status
plexus source detect                        # reachable, addable sources
plexus source add obsidian-fs --vault-path ~/Documents/MyVault
printf %s "$KEY" | plexus source add obsidian-rest \
    --base-url https://127.0.0.1:27124 --secret-name obsidian-local-rest-api-key --api-key-stdin
plexus source enable  <id>
plexus source disable <id>
plexus source reconfigure <id> --base-url https://127.0.0.1:27123
plexus source remove  <id>
```

(In a checkout, invoke it as `bun run integrations/cli/plexus-cli.ts source …`.)

The API key is read from **STDIN only** (`--api-key-stdin`) — never argv, which would
leak via `ps`.

---

## Launcher-flag shortcuts

The flags persist + register the same managed source, then auto-load on the next boot:

```sh
bun run start --vault ~/Documents/MyVault                          # ⇒ obsidian-fs
bun run start --obsidian-rest --rest-url https://127.0.0.1:27124   # ⇒ obsidian-rest
```

Add `--ephemeral` to register for this run only (no persist; for CI / one-offs). After
the first start, manage from the Sources panel or CLI — no flag re-supply needed.

---

## Hot-reload + lockstep semantics

`ManagedSources` is the only writer of both the live registry and `sources.json`, kept
in lockstep:

- **add / enable** — register LIVE first, then persist. A source that won't register is
  never written; a persist failure rolls back the live register (no orphan capability).
- **disable** — unregister live, keep the entry in the file with `enabled:false`.
- **remove** — unregister live, drop from the file, and **purge the source's grants**.
- **reconfigure** — re-register (hot-swap the module for the same id) + persist.

Every mutation bumps the manifest revision and emits `manifest_changed`, so connected
agents re-fetch `GET /manifest` with **no gateway restart**.

---

## Reconfigure purges grants on a security-surface change

A reconfigure that changes a source's **security surface** — its `route.baseUrl` /
`route.vaultPath` (WHERE it connects), its `secretRef` (WHICH credential it attaches),
its `transport`, or its `kind` — **purges the grants** for that source's capabilities
before the hot-swap. A prior human approval was given for the OLD target; it must not
silently carry over to the new one. After such a reconfigure, an agent must request a
fresh grant — a previously minted token no longer authorizes the call.

A label-only / cosmetic reconfigure does **not** purge grants (the approval still points
at the same target).

This is the same purge `remove` and `DELETE /extensions` perform, reusing
`grants.removeForCapability` per capability id.

---

## Security invariants (unchanged)

- **Default-deny + per-capability grants.** Registering a source only makes it
  discoverable; invoking needs a grant. Write-capable capabilities pend for a human.
- **Secrets by reference only.** `sources.json` holds names, never values. The
  value-ingress is write-only and name-validated against path traversal.
- **Egress / loopback confinement.** Detection rides the loopback-only
  `locateLocalService`; the `local-rest` transport re-validates the resolved host. A
  non-loopback `baseUrl` is denied `host_forbidden` and the secret is never attached.
- **No function over the wire.** Trusted in-process handlers (e.g. the obsidian-fs read)
  are bound only via the kind adapter on the trusted path, never from `sources.json`.

See [`MANAGED-SOURCES-DESIGN.md`](../archive/sources/MANAGED-SOURCES-DESIGN.md) for the full design.
