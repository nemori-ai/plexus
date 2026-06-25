#!/usr/bin/env bash
# eval-trigger.sh — run skill-creator Track A (trigger-accuracy) eval for one
# cc-master skill. Thin wrapper: it owns no eval logic, it just resolves paths
# and shells out to skill-creator's `scripts.run_eval`.
#
# Dependencies: uv + Python 3.12 + the `claude` CLI (logged in via the session;
# no API key needed — run_eval drives `claude -p` under your existing auth).
# It must `cd` into the skill-creator directory so the `scripts.` package
# resolves; $REPO is derived from this script's own location.
#
# Usage:  scripts/eval-trigger.sh <skill-name>
#   e.g.  scripts/eval-trigger.sh orchestrating-to-completion
#         scripts/eval-trigger.sh authoring-workflows
set -euo pipefail

SKILL="${1:?usage: eval-trigger.sh <skill-name>}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SC="${CC_MASTER_SKILL_CREATOR:-$HOME/.claude/plugins/cache/claude-plugins-official/skill-creator/unknown/skills/skill-creator}"

EVAL_SET="$REPO/skills/$SKILL/evals/trigger.json"
SKILL_PATH="$REPO/skills/$SKILL"

command -v uv >/dev/null 2>&1 || { echo "uv not found on PATH — install uv (https://docs.astral.sh/uv/) first" >&2; exit 1; }
[ -d "$SC" ] || { echo "skill-creator not found at: $SC (set CC_MASTER_SKILL_CREATOR to override)" >&2; exit 1; }
[ -f "$EVAL_SET" ] || { echo "no eval set at: $EVAL_SET" >&2; exit 1; }
[ -f "$SKILL_PATH/SKILL.md" ] || { echo "no SKILL.md at: $SKILL_PATH" >&2; exit 1; }

cd "$SC"
uv run --python 3.12 python -m scripts.run_eval \
  --eval-set "$EVAL_SET" \
  --skill-path "$SKILL_PATH" \
  --runs-per-query 3 \
  --verbose
