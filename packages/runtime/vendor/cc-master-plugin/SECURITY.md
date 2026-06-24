# Security Policy

cc-master is a Claude Code plugin. Installing it grants it a real trust surface
in your environment, so please read this before reporting.

## Trust surface

- **Hooks run shell on your machine.** cc-master ships hooks
  (`UserPromptSubmit`, `SessionStart`, `Stop`, `PostToolBatch`) that
  execute locally on every matching event. They are limited to **bash +
  Node.js/JavaScript** — runtimes Claude Code itself guarantees (no
  `jq`/`python`/extra installs; see ADR-006) — and read your project directory +
  write to the cc-master home (`$CC_MASTER_HOME`, else
  `<project>/.claude/cc-master/`).
- **The `Stop` pacing hook reads Claude's local usage JSONL.** One hook
  (`usage-pacing.js`), and only once a session is armed, reads this machine's
  Claude usage/transcript JSONL to compute 5h burn-rate pacing. By default
  this is `~/.claude/projects/**/*.jsonl` (overridable via `CC_MASTER_USAGE_DIR`)
  — which is **outside your project directory and the cc-master home**. The read
  is **read-only**: the hook never writes to those files and never transmits
  their contents off your machine. If you run in a sensitive environment, point
  `CC_MASTER_USAGE_DIR` at a fixture or empty directory to opt out.
- **Hooks stay dormant until you explicitly arm a session.** Every hook except
  `bootstrap-board.sh` is gated **dormant-until-armed** (a non-negotiable red
  line; see ADR-007): until you run `/cc-master:as-master-orchestrator` in *that*
  session, each hook produces no output and never blocks — so a plain coding
  session in the same host is unaffected and unpolluted.
- **The plugin injects context into the agent.** Commands and hooks add text to
  the model's context (role priming, board path, re-injection after compaction).
  Treat any plugin that can shape agent context as part of your trust boundary.

Review the hook scripts under `hooks/scripts/` before installing if you run in a
sensitive environment.

## Reporting a vulnerability

**Do not open a public issue for security reports.**

Report privately via GitHub's
[private vulnerability reporting](https://github.com/nemori-ai/cc-master/security/advisories/new)
(Security → Report a vulnerability). If that is unavailable, email the
maintainer at `qiwei.pan@shanda.com` with a clear description and reproduction
steps.

Please give us a reasonable window to investigate and ship a fix before any
public disclosure. We will acknowledge your report and keep you updated on
progress.

## Supported versions

cc-master is pre-1.0; only the latest released version receives security fixes.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1.0 | No        |
