#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Suite-level temp sweep: reap STALE leaked .tmp-ccm.* dirs from helpers.sh's make_project
# (template "${TMPDIR:-/tmp}/.tmp-ccm.XXXXXX"). Run at startup + via trap EXIT.
# AGE-FILTERED (mtime >60min) ON PURPOSE: a blanket `rm -rf ${TMPDIR}/.tmp-ccm.*` would delete
# the LIVE CC_MASTER_HOME / project dirs that a CONCURRENT `bash run-tests.sh` (or the repo's own
# concurrent-isolation tests) created seconds ago — one run's startup sweep, or an earlier-finishing
# run's EXIT trap, would yank another in-flight suite's active temp mid-test and REINTRODUCE flaky
# failures (codex second-endpoint review catch). No suite run lasts 60min, so anything older than
# that is abandoned backlog, never an active run. The source fix (run_resume/run_resume_nosid now
# rm -rf their own dirs) already prevents new leaks; this only reaps pre-existing stale backlog.
# Scoped strictly to the .tmp-ccm.* prefix at depth 1; errors swallowed (glob/empty-dir safe).
sweep_ccm_tmp() {
  find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name '.tmp-ccm.*' -mmin +60 \
    -exec rm -rf {} + 2>/dev/null || true
}
sweep_ccm_tmp
trap sweep_ccm_tmp EXIT

fail=0
echo "== hook tests (bash) =="
for t in tests/hooks/test_*.sh; do
  [ -e "$t" ] || continue
  echo "--- $t"
  bash "$t" || fail=1
done

echo "== script tests (bash) =="
for t in tests/scripts/test_*.sh; do
  [ -e "$t" ] || continue
  echo "--- $t"
  bash "$t" || fail=1
done

echo "== skill prose-lint (out-of-band, node) =="
# Cheap static checks over every SKILL.md: frontmatter quote anti-pattern (Finding #1),
# required name+description fields, and dead relative links. Checker only — never edits.
echo "--- scripts/skill-lint.sh"
bash scripts/skill-lint.sh || fail=1

echo "== node tests (content) =="
# Node 22+ treats `--test` path args as test files/globs, NOT discovery dirs (a bare dir is
# read as a module to execute and errors). So enumerate explicit test files via find — this
# is version-stable (Node 18-26) and avoids the "all three dirs must exist" fragility of a
# multi-glob `ls`. Our paths contain no spaces, so the unquoted expansion is intentional.
node_tests=$(find tests -name '*.test.mjs' 2>/dev/null | sort)
if [ -n "$node_tests" ]; then
  # shellcheck disable=SC2086
  node --test $node_tests || fail=1
fi

[ "$fail" -eq 0 ] && echo "ALL TESTS PASSED" || { echo "TESTS FAILED"; exit 1; }
