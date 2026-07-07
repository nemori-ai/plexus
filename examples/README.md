# Examples

For developers:

- **[`home-gateway/`](./home-gateway/)** — the personal-developer scenario: publish your
  home gateway under one hostname (Cloudflare named tunnel on your own domain — or any
  edge you bring) and let **your** Claude Code on the office machine discover, enroll,
  and call home capabilities from anywhere; reads stand, the write pends for you, one
  revoke fails everything closed. Verified end-to-end against a real domain.
- **[`mesh-security-audit/`](./mesh-security-audit/)** — the 1.0-RC flagship: a cloud agent
  scans a Linux box over the mesh → Codex analyzes its access log → writes the verdict into an
  Obsidian vault, all owner-approved, with a per-host audit split and a fail-closed revoke.
  Runs as a **local hero topology** (Mac primary + Docker-Linux proxy on one machine) or a
  **cloud topology** (Fly compute + Cloudflare Tunnel edge on your own domain).
- **[`min-agent/`](./min-agent/)** — the minimal end-to-end DISCOVER → GRANT → CALL
  (the `bun run demo` target).

Internal acceptance-test harnesses moved to [`tests/harnesses/`](../tests/harnesses/)
(imported by the test suite; not tutorials).
