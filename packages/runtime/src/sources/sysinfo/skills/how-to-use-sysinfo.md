# How to use sysinfo

The `sysinfo` source is a **read-only** window onto one Unix/Linux host's system state.
It exposes three capabilities — none of them can change, kill, start, or write anything.

## Capabilities

### `sysinfo.processes.list` — what's running
Input: `{ top?: number }` (default 50, clamped to 1..200).
Returns the busiest processes by CPU: `{ count, total, processes: [{ pid, user, cpu, mem, command }] }`
(`cpu`/`mem` are percentages). Backed by `ps`, portable across Linux and macOS.
Ask for a small `top` when you only want the heavy hitters.

### `sysinfo.resources.read` — how loaded is the box
Input: `{}` (no arguments).
Returns a snapshot: `{ platform, uptimeSeconds, cpu: { cores, loadavg:[1m,5m,15m], loadPerCore },
memory: { totalBytes, usedBytes, freeBytes, usedPct }, disks: [{ filesystem, mount, totalBytes,
usedBytes, availableBytes, usedPct }] }`. CPU/memory come from the OS directly; disk from `df`.
Call this first when asked "how is the server doing" — it tells you if the host is CPU-bound,
low on RAM, or low on disk.

### `sysinfo.log.read` — read a system/security/access log tail
Input: `{ file: string, lines?: number }` (default 200 lines, clamped to 1..2000).
Returns `{ file, lines, truncated, content }` — the **last N lines** of the file.

**`file` is path-jailed.** It is resolved *relative to an allowlisted log root* (configured by
`PLEXUS_SYSINFO_LOG_DIR`, default `/var/log`). Anything that escapes the root is **rejected**:
absolute paths, `..` traversal, and symlinks whose target lands outside the root all fail closed.
You can **never** read an arbitrary file with this — only files under the log root.

Examples: `{ file: "auth.log" }`, `{ file: "nginx/access.log", lines: 500 }`.

Use it to inspect access/auth activity — failed logins, source IPs, request patterns — when
analyzing a server's security posture.

## Typical flow
1. `sysinfo.resources.read {}` — is the box healthy?
2. `sysinfo.processes.list { top: 10 }` — what's eating CPU/RAM?
3. `sysinfo.log.read { file: "auth.log", lines: 500 }` — what does the access/auth log show?
