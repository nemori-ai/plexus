#!/usr/bin/env bash
# SessionStart hook (startup|resume|compact): re-establish the orchestrator ROLE after a fresh
# start / resume / compaction. Compaction can drop "I am an orchestrator" entirely — which the
# agent cannot re-inject for itself — so this hook does it from outside. It points the agent at
# its HOME and lists THIS session's active boards (with goals) but does NOT bind to a specific
# board: the agent re-identifies its own board by goal.
#
# ARMED GATE (session-scoped — the armed-hook discipline): this hook re-anchors ONLY when THIS
# session is armed — armed ⟺ home holds a *.board.json with owner.active:true AND owner.session_id
# == this session's stdin id (board_matches below). Previously it activated on ANY active board in
# home (home-scoped) and discarded stdin — so a brand-new session that never ran
# as-master-orchestrator got falsely re-anchored as an orchestrator just because some OTHER session
# left an active board behind (false-activation gap). It now reads the stdin session_id and gates on
# it. DEGRADED PATH: an empty sid (e.g. a compaction that drops session_id) falls back to matching
# any active board, preserving compaction-boundary robustness.
set -uo pipefail

# ── stdin → session_id (pure bash, no jq; same extraction as verify-board.sh) ───────────────────────
input="$(cat)"
sid="$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"

HOME_DIR="${CC_MASTER_HOME:-${CLAUDE_PROJECT_DIR:-$(pwd)}/.claude/cc-master}"

# owner_region BOARD — print the ROOT "owner" object's DEPTH-1 FIELD STREAM only, via a string- and
# escape-aware depth scan ([ ] and { }) in POSIX awk. The board is one root object; this enters ONLY the
# `"owner"` key found at ROOT depth (curly depth 1, bracket depth 0) and emits the chars at the owner
# object's own field level (active / session_id / heartbeat) — every value nested DEEPER inside owner, or
# anywhere else in the file (tasks[], log[], deps[]), is dropped wholesale. FORMAT-AGNOSTIC: single-line
# and multi-line JSON behave identically. Used so the arming gate reads `active` / `session_id` ONLY from
# the board-root owner sub-object — an `"active":true` or a `session_id` buried in an agent-shaped
# task/log payload of an ARCHIVED board can never masquerade as owner's and false-arm the hook (CODEX7).
# Only a ROOT-depth `"owner"` key is honored (goal prose or a task with its own `"owner"` field can never
# be captured — same root-only caveat as the tasks-region scan). Same string/escape rules as dangling_nodes.
owner_region() {
  awk '
    { s = s $0 "\n" }
    END {
      n = length(s)
      cd = 0; bd = 0; instr = 0; esc = 0
      capkey = 0; key = ""; pendKey = ""        # pendKey: last completed ROOT-depth key string
      inowner = 0; od = 0; out = ""
      for (k = 1; k <= n; k++) {
        ch = substr(s, k, 1)
        if (inowner) {                          # already inside the root owner object (opened at depth od)
          if (instr) {
            if (cd == od + 1 && bd == 0) out = out ch
            if (esc) esc = 0
            else if (ch == "\\") esc = 1
            else if (ch == "\"") instr = 0
            continue
          }
          if (ch == "\"") { instr = 1; if (cd == od + 1 && bd == 0) out = out ch; continue }
          if (ch == "[") { bd++; continue }
          if (ch == "]") { if (bd > 0) bd--; continue }
          if (ch == "{") { cd++; continue }
          if (ch == "}") { cd--; if (cd == od) { inowner = 0; break } continue }   # owner closed → done
          if (cd == od + 1 && bd == 0) out = out ch
          continue
        }
        if (instr) {                            # in a string while still scanning for root "owner":{
          if (esc) { esc = 0; if (capkey) key = key ch; continue }
          if (ch == "\\") { esc = 1; if (capkey) key = key ch; continue }
          if (ch == "\"") { instr = 0; if (capkey) { capkey = 0; pendKey = key } continue }
          if (capkey) key = key ch
          continue
        }
        if (ch == "\"") {                        # a string starting at ROOT depth is a candidate key
          instr = 1
          if (cd == 1 && bd == 0) { capkey = 1; key = "" } else capkey = 0
          continue
        }
        if (ch == "[") { bd++; pendKey = ""; continue }
        if (ch == "]") { if (bd > 0) bd--; continue }
        if (ch == "{") {
          cd++
          if (cd == 2 && bd == 0 && pendKey == "owner") { inowner = 1; od = 1 }   # entered root owner{}
          pendKey = ""
          continue
        }
        if (ch == "}") { if (cd > 0) cd--; pendKey = ""; continue }
        if (ch == ",") pendKey = ""
      }
      printf "%s", out
    }' "$1" 2>/dev/null
}

# ── board matching (the arming gate; mirrors verify-board.sh) ───────────────────────────────────────
# A board is "mine" when active AND (sid empty → degraded: any active board; else owner.session_id==sid).
# The degrade is ASYMMETRIC — it fires ONLY when the STDIN sid is empty (ADR-007 §2.3: a compaction that
# drops session_id; the OWNING session re-anchoring across a compaction boundary). A board stamped with an
# EMPTY owner.session_id is NOT adopted: it falls through to "" = "<non-empty sid>" → false → DORMANT
# (fail-safe). Auto-adopting blank-session boards was tried (CODEX12) and REVERTED (CODEX14): it armed
# EVERY unrelated session, re-introducing the cross-session pollution red line 6 forbids. Official
# resume/compaction PRESERVES session_id, so a legitimately-resumed board carries its ORIGINAL session_id
# (never blank) and matches normally; a blank board is only bootstrap's anomaly on a sid-less stdin, claimed
# by an explicit re-arm (re-run as-master-orchestrator → bootstrap re-stamps it). → ADR-007.
# active AND session_id are read ONLY from the ROOT owner sub-object (owner_region above) — NEVER full-text
# grep: a flexible tasks[]/log[] payload of an ARCHIVED board carrying `"active":true` must never false-arm
# the hook (CODEX7, red line 6).
board_matches() { # $1 = board path
  owner="$(owner_region "$1")"
  printf '%s' "$owner" | grep -qE '"active"[[:space:]]*:[[:space:]]*true' || return 1
  [ -z "$sid" ] && return 0
  # owner.session_id must equal $sid EXACTLY. Never splice $sid into a grep -E pattern: a session id
  # carrying regex metachars (., *, [, etc.) would otherwise match the wrong board. Extract owner's
  # session_id *value* with a fixed regex, then compare as a literal shell string. A blank board_sid falls
  # through to "" = "<non-empty sid>" → false → DORMANT (blank board is NOT auto-adopted; red line 6).
  board_sid="$(printf '%s' "$owner" | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
               | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  [ "$board_sid" = "$sid" ]
}

# dangling_nodes BOARD — print, one per line, "<id>\t<parent>" for every task object whose TOP-LEVEL
# "status" is `stale` or `escalated` (the unresolved nodes left over from a prior, un-reconciled plan
# update). `<parent>` is that node's top-level `parent` container edge (D3.7 grouping annotation) or
# empty when the node is a bare top-level node (no `parent` → graceful degrade to the bare form). The
# tab-separated pair lets the listing builder annotate a stale CHILD with its owner ("owner X 的子 Y")
# while leaving a bare top-level node un-annotated. PER-OBJECT scan (same string/escape/double-depth
# [ ] and { } awareness as verify-board.sh's pending_user_decisions / tasks_region) → FORMAT-AGNOSTIC:
# single-line and multi-line JSON behave identically. Only characters at the task-object top level
# (bracket depth 1 inside the tasks array, curly depth 1 inside the task) are buffered per object —
# nested flexible fields (a task-local "log" array, structured entries inside it) are dropped wholesale,
# so a log entry's stale/escalated status (or a nested `parent`) can neither masquerade as a task status
# nor inject a spurious id/owner.
dangling_nodes() {
  awk '
    { s = s $0 "\n" }
    END {
      i = index(s, "\"tasks\""); if (!i) exit
      s = substr(s, i + 7)
      j = index(s, "["); if (!j) exit
      s = substr(s, j + 1)                 # start INSIDE the tasks array
      bd = 1; cd = 0; instr = 0; esc = 0; obj = ""
      n = length(s)
      for (k = 1; k <= n; k++) {
        ch = substr(s, k, 1)
        if (instr) {
          if (bd == 1 && cd == 1) obj = obj ch
          if (esc) esc = 0
          else if (ch == "\\") esc = 1
          else if (ch == "\"") instr = 0
          continue
        }
        if (ch == "\"") { instr = 1; if (bd == 1 && cd == 1) obj = obj ch; continue }
        if (ch == "[") { bd++; continue }
        if (ch == "]") { bd--; if (bd == 0) break; continue }
        if (ch == "{") { cd++; if (bd == 1 && cd == 1) obj = ""; continue }   # open a task object → fresh buffer
        if (ch == "}") {
          cd--
          if (bd == 1 && cd == 0) emit(obj)   # closed a task object → decide on its top-level fields
          continue
        }
        if (bd == 1 && cd == 1) obj = obj ch
      }
    }
    # emit OBJ — if OBJ has a top-level "status":"stale"|"escalated", print "<id>\t<parent>" (parent "" if
    # the node has no top-level parent container edge → bare form, graceful degrade).
    function emit(o,   id, pa) {
      if (o !~ /"status"[ \t]*:[ \t]*"(stale|escalated)"/) return
      id = field(o, "id")
      if (id == "") return
      pa = field(o, "parent")
      print id "\t" pa
    }
    # field(O, NAME) — string value of top-level key NAME from object buffer O ("" if absent).
    function field(o, name,   re, m) {
      re = "\"" name "\"[ \t]*:[ \t]*\""
      if (match(o, re)) {
        m = substr(o, RSTART + RLENGTH)
        sub(/".*/, "", m)
        return m
      }
      return ""
    }' "$1" 2>/dev/null
}

# Collect THIS session's active boards (armed gate: board_matches) into a single-line listing
# "<name> [<goal>]", and gather the ids of any unresolved (stale/escalated) nodes across THEM (only)
# for the resume note (H4). Boards owned by other sessions are skipped — they are not this session's
# to re-anchor or reconcile.
listing=""
active_found=0
dangling_ids=""
for b in "$HOME_DIR"/*.board.json; do
  [ -e "$b" ] || continue
  board_matches "$b" || continue          # not this session's active board → ignore (arming gate)
  active_found=1
  goal="$(sed -n 's/.*"goal"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$b" | head -1)"
  [ -n "$goal" ] || goal="(goal not recorded yet)"
  listing="${listing} • $(basename "$b") [${goal}]"
  # Each dangling line is "<id>\t<parent>". Annotate a stale CHILD with its owner ("Y (owner X)") for the
  # at-a-glance grouping (D3.7); a bare top-level node (empty parent) keeps the un-annotated form (graceful
  # degrade for old / flat boards — no `parent` edge → no owner annotation, never an invented owner).
  while IFS="$(printf '\t')" read -r did dpar; do
    [ -n "$did" ] || continue
    if [ -n "$dpar" ]; then entry="${did} (owner ${dpar})"; else entry="$did"; fi
    if [ -z "$dangling_ids" ]; then dangling_ids="$entry"; else dangling_ids="$dangling_ids, $entry"; fi
  done <<EOF
$(dangling_nodes "$b")
EOF
done

[ "$active_found" -eq 0 ] && exit 0   # no active orchestration → dormant, stay silent

ctx="You are a cc-master master orchestrator. Your orchestration board(s) live in ${HOME_DIR}. Active:${listing}. Re-read the board for the task you are working on (recognise it by its goal), then invoke the orchestrating-to-completion skill and continue the decision program. Do not restart work already done/verified; integrate any completed background results first."

# H4: name any unresolved (stale/escalated) nodes left from a prior, un-reconciled plan update so the
# transaction break is called out on resume. Empty → ctx stays byte-for-byte identical to before.
if [ -n "$dangling_ids" ]; then
  ctx="$ctx Note on resume: your board has unresolved node(s) needing attention — stale/escalated: ${dangling_ids}. Reconcile these (re-run stale, re-altitude escalated) before scheduling new work."
fi
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}\n' "$(printf '%s' "$ctx" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')"
exit 0
