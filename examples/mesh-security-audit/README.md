# mesh-security-audit — the Plexus 1.0-RC flagship example

A **cloud agent** reaches every machine **only through Plexus capabilities** — no shell, no
filesystem, no network of its own — and does one security-audit run:

> **Scan** a Linux server's status + its security/access log → hand the log to **Codex** to
> **analyze** it → **write** the conclusion as a note into the user's **Obsidian/workspace
> vault**. Then the user inspects the **per-host audit**, reads the note, and **revokes** the
> agent — whose very next call **fails closed**.

The point isn't the audit. The point is the **shape of the authorization**: reads stand
frictionlessly, every *mutating* move (`codex.run` execute, the vault write) **PENDS for the
machine owner**, each gateway keeps its **own** append-only audit of what **it** executed, and
one revoke kills the agent everywhere. That is the whole Plexus thesis in one runnable story.

The agent is a fixed, deterministic driver (`agent/driver.py`) so the story reproduces with
**zero model cost**. It is **address-agnostic**: it never hard-codes a capability id — it
discovers what it can call from the handshake manifest and matches each leg by *id suffix*, so
the **same** run works in both topologies below.

---

## Two topologies, one story

| | [`local/`](./local/) — the hero (start here) | [`cloud/`](./cloud/) — production |
|---|---|---|
| Parent | Mac, run **natively** (`codex.run` + `workspace.write` are LOCAL) | Fly.io machine + Cloudflare Tunnel edge (YOUR domain) |
| Linux | **Docker** container = a `proxy` child (`sysinfo.*`) | Docker child dialing the CF edge |
| Codex + vault | on the Mac primary | on a **Mac child** dialing the CF edge |
| Reachable from | one machine | anywhere (NAT-friendly; children dial OUT) |
| Recipe | `up.sh` / `down.sh` (verified end-to-end) | [`cloud/README.md`](./cloud/README.md) |

In `local/` only `sysinfo.*` is mesh-mounted (`local/linux/sysinfo.*`); `codex.run` and
`workspace.write` are the primary's own local caps. In `cloud/` everything is mesh-mounted
(`local/mac/codex.run`, `local/linux/…`). The suffix-match driver is oblivious to the
difference — see [`GOAL.md`](./GOAL.md) for the leg-by-leg contract.

---

## Quick start — the local hero topology

**Prereqs:** `bun`, `docker` (+ `docker compose` v2), `jq`, `curl`, `python3`. `codex` is
optional (only for a *real* analysis — see Tiers below). Everything lands under
`~/PlexusDemo/` (override with `DEMO_ROOT`); ports are non-default (`7801` agent, `8801` mesh)
so the demo never touches a personal gateway on `~/.plexus:7077`.

```bash
# 1. Bring up the mesh: Mac PRIMARY (native) + Docker-Linux PROXY. Idempotent + re-runnable.
cd examples/mesh-security-audit/local
./up.sh
#   → waits until local/linux/sysinfo.{resources.read,processes.list,log.read} mount on the primary.

# 2. Authorize the agent (operator side — connection-key gated). Exposes the proxy sysinfo
#    caps, connects the agent, grants the STANDING read set + codex.run (which the system
#    forces to pend-each-call), and leaves the vault WRITE ungranted so it PENDS too. Prints a
#    one-time enrollment code (the ONLY secret the agent ever receives — never the key).
cd ../../..                                  # back to repo root
PLEXUS_BASE_URL=http://127.0.0.1:7801 \
PLEXUS_HOME=~/PlexusDemo/primary-home \
  bash examples/mesh-security-audit/scripts/grant-setup.sh

# 3. Run the agent. It enrolls with the code (→ durable per-agent PAT stored in agent/.env),
#    scans over the mesh, then BLOCKS on codex.run (execute → PENDS) and again on the vault
#    write (write → PENDS).
PLEXUS_BASE_URL=http://127.0.0.1:7801 \
PLEXUS_ENROLL_CODE=<paste the plx_enroll_… code from step 2> \
  python examples/mesh-security-audit/agent/driver.py --run

# 4. APPROVE the two pending calls while the driver blocks — in the Plexus UI
#    (http://127.0.0.1:7801, connection-key gated) or via the admin API:
#      KEY=$(cat ~/PlexusDemo/primary-home/connection-key)
#      curl -s http://127.0.0.1:7801/admin/api/pending -H "X-Plexus-Connection-Key: $KEY"
#      curl -s -X POST http://127.0.0.1:7801/admin/api/pending/<id> \
#        -H "X-Plexus-Connection-Key: $KEY" -H 'content-type: application/json' \
#        -d '{"action":"approve","agentId":"mesh-security-audit"}'
#    The agent CANNOT self-approve — that human beat is the story.

# 5. The payoff — the note materialized, and the per-host audit split:
open ~/PlexusDemo/vault/Security/linux-access-log-analysis.md      # the artifact
PLEXUS_HOME=~/PlexusDemo/primary-home \
  bash examples/mesh-security-audit/scripts/show-audit.sh          # sysinfo on the proxy; codex+vault on the primary

# 6. Revoke → prove the next call fails closed:
PLEXUS_BASE_URL=http://127.0.0.1:7801 \
PLEXUS_HOME=~/PlexusDemo/primary-home \
  bash examples/mesh-security-audit/scripts/revoke.sh

# 7. Tear down (keeps the audit + vault so you can inspect; --purge wipes the primary home too):
cd examples/mesh-security-audit/local && ./down.sh
```

---

## The two tiers of the analyze leg

`codex.run` runs the Mac's dir-jailed Codex (sandbox-exec confined to the analysis dir). The
example ships **two honest tiers**:

- **Tier H — record mode (default).** Codex is invoked under the seatbelt jail but **not
  spawned** — the call returns the *predicted* sandbox-exec argv + confinement, with **no
  model cost and no login**. The note embeds that recorded invocation plus the raw log tail,
  so the artifact still materializes and the execute path (dir-jail + pends-each-call + local
  audit) is fully proven. This is the reproducible acceptance path.
- **Tier L — real analysis.** Set `PLEXUS_CODEX_HEADLESS_LAUNCH=1` with a logged-in `codex`
  and the note's `## Analysis` becomes Codex's real `## Findings` / `## Verdict` on the log.

Either way the note ends with a provenance line noting it was written via the vault-write
capability.

---

## What to look for (the assertions)

- **Reads stand; execute + write PEND.** In the audit lifecycle you'll see `grant.allow` for
  the three `sysinfo.*` reads immediately, but `grant.pending` → (owner approves) →
  `grant.allow` for `codex.run` and `workspace.write`. The write is *deliberately* never made
  standing — a mutating write pends on **every** call.
- **Per-host audit locality** (`show-audit.sh`, the crux): the **Linux proxy** logs **only**
  its three `sysinfo.*` reads (attributed to the tunnel principal `mesh:primary`); the
  **primary** logs `codex.run` + the vault write it executed, **plus** mirror rows of the
  `local/linux/sysinfo.*` forwards, **plus** the whole grant/handshake/revoke lifecycle.
  Neither host logs the other's *execution*. That split is the mesh story's payoff.
- **Fail-closed on revoke:** after `revoke.sh`, `driver.py --probe` cannot even handshake
  (`session_expired` — the PAT is tombstoned).

---

## Files

```
GOAL.md                    the leg-by-leg capability contract the agent fulfills
agent/driver.py            the shared, address-agnostic cloud-agent driver (scan→analyze→write)
scripts/grant-setup.sh     operator: expose proxy caps + connect the agent + grant the standing set
scripts/show-audit.sh      dump + LABEL the per-host audit split
scripts/revoke.sh          revoke the agent + prove the next call fails closed
local/up.sh · down.sh      bring up / tear down the LOCAL hero topology (Mac primary + Docker proxy)
local/compose.linux.yml    the ONE Docker node (the linux proxy), stock gateway image
local/seed/var-log/auth.log a realistic seeded security log (brute-force → creds-stuffing → privesc)
cloud/                     the production recipe (Fly compute + Cloudflare Tunnel edge) — see cloud/README.md
```
