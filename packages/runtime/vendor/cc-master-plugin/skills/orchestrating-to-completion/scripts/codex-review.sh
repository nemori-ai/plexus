#!/usr/bin/env bash
# codex-review.sh — use codex as an independent second endpoint verifier.
#
# Out-of-band, manual/orchestrator-driven (NOT a hook). codex runs a review-only,
# read-only-sandbox pass over the diff against a base branch and emits a verdict
# (approve | needs-attention) conforming to the openai-codex plugin's
# review-output.schema.json. This is the dogfood reviewer for skill/plugin quality.
#
# Requires: codex CLI, logged in (OAuth). Usage: codex-review.sh [--base <branch>]
# Env: CODEX_REVIEW_MODEL overrides the review model (default gpt-5.5).
#
# Silent-pass-through guard (see skills/orchestrating-to-completion/references/
# resume-verify.md §3): an empty review or a failed call is treated as NOT passed.
# A null/missing verdict is never silent approval — we exit 2 so the caller's
# endpoint gate maps it to "not passed" (Replan), never to done.
set -euo pipefail

# --- args: [--base <branch>], default main ---
BASE="main"
if [ "${1:-}" = "--base" ]; then
  BASE="${2:-main}"
elif [ -n "${1:-}" ]; then
  BASE="$1"
fi
MODEL="${CODEX_REVIEW_MODEL:-gpt-5.5}"

OUT="$(mktemp -t codex-review.XXXXXX)"
trap 'rm -f "$OUT"' EXIT

# NOTE (Finding #20, found by running this very script at the PR gate): `codex exec review`
# FORBIDS a custom [PROMPT] together with a scope flag (`--base` / `--uncommitted` / `--commit`) —
# they are mutually exclusive. So we do NOT pass a custom focus prompt; codex runs its default
# review over the --base diff and picks up this repo's review conventions from AGENTS.md (which it
# reads). The diff is repo-scoped (only this repo's tracked changes vs <base>), so the "ignore
# other AIs' ~/.claude skill defs" boundary is already moot — those files are not in the diff.
#
# Core call. `< /dev/null` prevents a stdin deadlock. --json streams JSONL events to stdout;
# -o writes the final agent message (the verdict) to $OUT.
# `-c sandbox_mode='"read-only"'` FORCES a read-only sandbox for this review regardless of the
# user's ~/.codex/config.toml (which may be workspace-write or danger-full-access) — a reviewer must
# never mutate the repo (codex review catch, Finding #21).
if ! codex exec review --base "$BASE" \
      -m "$MODEL" -c model_reasoning_effort=high -c sandbox_mode='"read-only"' \
      --json -o "$OUT" < /dev/null; then
  echo "CODEX_REVIEW_FAILED (treat as NOT passed)"
  exit 2
fi

# Empty / whitespace-only review == failure (silent-pass-through guard).
if [ ! -s "$OUT" ] || ! grep -q '[^[:space:]]' "$OUT"; then
  echo "CODEX_REVIEW_FAILED (treat as NOT passed)"
  exit 2
fi

echo "--- codex review verdict ($OUT) ---"
cat "$OUT"
# verdict: approve | needs-attention (per openai-codex review-output.schema.json).
# Caller maps it to the endpoint gate: needs-attention -> Replan(feedback);
# approve + non-empty + diff actually read -> done; empty/failed (exit 2) -> NOT passed.
