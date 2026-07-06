# GOAL — Mesh security audit (Plexus 1.0-RC flagship)

You are a **cloud agent** authorized through a Plexus parent gateway. You reach every
machine ONLY through Plexus capabilities — you have no shell, no direct filesystem, and no
network of your own. Your job is ONE security-audit run:

> Scan a Linux server's status and its security/access log → have Codex analyze the log →
> write the conclusion as a note into the user's Obsidian vault.

Then the user inspects the per-host audit, reads the note, and **revokes** you — and your
very next call fails closed.

This goal is executed by `agent/driver.py`. It is **address-agnostic**: it never hard-codes
a capability id — it discovers what it can call from the handshake manifest and matches each
leg by *id suffix*, so the SAME run works in both topologies (below).

---

## The capabilities you need (matched by suffix, not by address)

| Leg | Capability (suffix match) | Grant class | Behavior |
|-----|---------------------------|-------------|----------|
| scan resources | `*sysinfo.resources.read` | read | auto-approve; standing OK |
| scan processes | `*sysinfo.processes.list` | read | auto-approve; standing OK |
| scan log | `*sysinfo.log.read` | read | auto-approve; standing OK |
| analyze | `*codex.run` | **execute** | **PENDS every call** (never standing) |
| write verdict | `*obsidian-rest.vault.write` / `*workspace.write` | **write** | **PENDS** (never standing) |

In the **local topology** the Mac IS the primary, so `codex.run` and `workspace.write` are
LOCAL bare ids and only `sysinfo.*` is mesh-mounted (`local/linux/sysinfo.*`). In the
**cloud topology** everything is mesh-mounted (`local/mac/codex.run`, `local/linux/…`). The
suffix match makes the driver oblivious to the difference.

Mutating grants (`codex.run`, the vault write) **pend for the machine owner**. When you call
one, the driver BLOCKS and polls until the owner approves in the Plexus UI. You CANNOT
self-approve — call the capability ONCE and WAIT. Never look for another way in.

---

## The flow

1. **Enroll + handshake** with your OWN per-agent PAT (redeem the one-time
   `PLEXUS_ENROLL_CODE` on the first run; reuse the stored PAT afterward). You never hold
   the admin connection-key.
2. **Discover** the manifest; resolve each leg by suffix.
3. **Scan** (`sysinfo.*`, read): a cpu/mem/disk snapshot, the top processes, and the tail of
   the security/access log (default `auth.log`, override with `PLEXUS_SYSINFO_LOG_FILE`).
4. **Analyze** (`codex.run`, execute → PENDS): hand the log tail to Codex with the security
   analysis prompt below, `cwd` = the analysis dir. In record-mode (Tier H) the agent's
   result carries only `ok / launched / sandboxed / reason` (the jail path + sandbox argv
   are the owner's, in the per-host audit — the wire/audit split); with Real launch enabled
   for Codex (or `PLEXUS_CODEX_HEADLESS_LAUNCH=1`, Tier L) it runs a real analysis.
5. **Write** (`*.vault.write` / `workspace.write`, write → PENDS): write the conclusion note.

### The Codex analysis prompt (what leg 4 asks)

> You are a Linux security analyst. Analyze the tail of a server's security/access log for
> authentication anomalies (brute-force / credential-stuffing, invalid-user probes, repeated
> failures from one source IP, a successful login after a burst of failures), then any
> privilege-escalation / suspicious post-login activity. List the source IPs of concern and
> the accounts they targeted. Give a short RISK verdict (low/medium/high) with 2–4 concrete
> remediation steps. Output clean Markdown with `## Findings` and `## Verdict`. Do not invent
> log lines that are not present.

---

## The output note

- **Path** (vault-relative, override with `PLEXUS_NOTE_PATH`):
  `Security/linux-access-log-analysis.md`
- **Shape:** a Markdown note with a header block (generated timestamp, source host, log file,
  analysis engine), an optional server-snapshot section, and the analysis. In Tier L the
  analysis IS Codex's `## Findings` / `## Verdict` output; in Tier H the note embeds the
  recorded (jailed, un-spawned) codex invocation plus the raw log tail so the artifact still
  materializes. It always ends with a provenance line noting it was written via the vault
  write capability.

---

## After the run

- **Per-host audit** (the payoff): on the **Linux proxy** the `sysinfo.*` invokes; on the
  **primary** the `codex.run` + vault-write invokes; on the **parent** the grant lifecycle +
  forwards. `scripts/show-audit.sh` labels the split.
- **Revoke:** the owner revokes you (`POST /admin/api/agents/revoke`). Your next call fails
  closed (`token_revoked` / handshake fail). `scripts/revoke.sh` demonstrates it.
