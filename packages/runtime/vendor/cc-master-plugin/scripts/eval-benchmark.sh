#!/usr/bin/env bash
# eval-benchmark.sh — run skill-creator Track B (orchestration-discipline
# benchmark) AGGREGATION for one cc-master skill. Thin wrapper: it owns no eval
# logic, it only resolves paths and shells out to skill-creator's
# `scripts.aggregate_benchmark`, which reads the per-run grading.json files in an
# iteration directory and emits benchmark.json + benchmark.md (pass_rate / time /
# tokens with mean ± stddev and the with_skill−without_skill delta).
#
# IMPORTANT — this is only the LAST mechanical step of Track B. Track B is an
# agent-orchestrated, half-manual loop (spawn with_skill + without_skill runs,
# grade each transcript against the behavioral assertions, then aggregate, then
# pair with a codex second judge). The full human/agent procedure — the fixture,
# the behavioral assertion set, the grader/codex pairing, and how to read the
# numbers honestly — lives in:
#     design_docs/eval/track-b-benchmark.md
# Read that first; this script just wraps the aggregation call so you do not have
# to remember the cd-into-skill-creator dance.
#
# Dependencies: uv + Python 3.12 (the system 3.9 cannot run skill-creator's
# PEP-604 code). No `claude`/`codex` needed for THIS step — those are spent in the
# upstream run + grading + codex-pairing steps described in the doc.
# It must `cd` into the skill-creator directory so the `scripts.` package
# resolves; $REPO is derived from this script's own location (unused here but kept
# for parity with eval-trigger.sh and in case the iter-dir is passed relative).
#
# Usage:  scripts/eval-benchmark.sh <iteration-dir> <skill-name>
#   e.g.  scripts/eval-benchmark.sh \
#           ./orchestrating-to-completion-workspace/iteration-1 \
#           orchestrating-to-completion
#
# <iteration-dir> is the workspace iteration directory holding eval-*/ run trees
# (eval-N/{with_skill,without_skill}/run-*/grading.json). Pass an ABSOLUTE path,
# or a path relative to your current shell — it is resolved before the cd.
set -euo pipefail

ITER_DIR="${1:?usage: eval-benchmark.sh <iteration-dir> <skill-name>}"
SKILL="${2:?usage: eval-benchmark.sh <iteration-dir> <skill-name>}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SC="${CC_MASTER_SKILL_CREATOR:-$HOME/.claude/plugins/cache/claude-plugins-official/skill-creator/unknown/skills/skill-creator}"
command -v uv >/dev/null 2>&1 || { echo "uv not found on PATH — install uv (https://docs.astral.sh/uv/) first" >&2; exit 1; }

# Resolve the iteration dir to an absolute path BEFORE we cd into skill-creator,
# so a caller-relative path keeps pointing at the right place.
[ -d "$ITER_DIR" ] || { echo "iteration dir not found: $ITER_DIR" >&2; exit 1; }
ITER_ABS="$(cd "$ITER_DIR" && pwd)"

[ -d "$SC" ] || { echo "skill-creator not found at: $SC (set CC_MASTER_SKILL_CREATOR to override)" >&2; exit 1; }
[ -f "$SC/scripts/aggregate_benchmark.py" ] || {
  echo "aggregate_benchmark.py missing under: $SC/scripts" >&2; exit 1; }

cd "$SC"
uv run --python 3.12 python -m scripts.aggregate_benchmark \
  "$ITER_ABS" \
  --skill-name "$SKILL" \
  --skill-path "$REPO/skills/$SKILL"
