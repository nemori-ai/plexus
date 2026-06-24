#!/usr/bin/env bash
# Stop hook — the goal-hook. It reads the Stop event's stdin JSON, filters this session's ACTIVE board
# (a *.board.json with owner.active:true AND owner.session_id == this session's id), and decides
# whether to let the agent stop. Pure bash, NO jq/node, ship-anywhere (Bedrock/Vertex/Foundry).
#
# A Stop hook cannot soft-nudge — only block (decision:block) or allow (exit 0). So it gates on the
# board's status enum distribution (it never reads the conversation or rebuilds the deps graph), and
# forces ONE self-check handshake per DISTINCT completion state before releasing it. State for the
# handshake and the anti-deadlock fuse lives in a sidecar file the hook owns — the board stays the
# agent's single source of truth and is NEVER written here.
#
# Decision table (on THIS session's active board):
#   no matching active board   → allow (dormant)
#   empty (0 tasks)            → block (DAG never filled)
#   has ready / uncertain      → block (actionable work / output pending verification) + reset handshake
#   else (all in_flight/blocked/done/failed/escalated/stale) → fingerprint-keyed self-check handshake
# Handshake key: a fingerprint of the status multiset. If the current completion state was already
# handshook (fp unchanged), allow — DON'T re-ask. Only a CHANGED completion state re-forces the
# self-check. This stops the same board state being re-self-checked over a long background wait.
# Fuse: every block bumps block_streak; >= FUSE forces allow; every allow clears the sidecar.
set -uo pipefail

FUSE=5
HOME_DIR="${CC_MASTER_HOME:-${CLAUDE_PROJECT_DIR:-$(pwd)}/.claude/cc-master}"

# ── stdin → session_id (pure bash, no jq) ─────────────────────────────────────────────────────────
input="$(cat)"
sid="$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"

# Sidecar: one line "<block_streak> <last_handshook_fp>". last_handshook_fp is the status-multiset
# fingerprint we last forced a self-check on ("-" = none yet). Empty sid → degraded full-home scan +
# a stable .nosession sidecar so the fuse still works.
sc_name=".nosession.stopcheck"
[ -n "$sid" ] && sc_name=".${sid}.stopcheck"
SIDECAR="$HOME_DIR/$sc_name"

block_streak=0; last_handshook_fp="-"
if [ -f "$SIDECAR" ]; then
  read -r block_streak last_handshook_fp < "$SIDECAR" 2>/dev/null || true
  case "$block_streak"      in ''|*[!0-9]*) block_streak=0;;       esac
  case "$last_handshook_fp" in '') last_handshook_fp="-";; esac
fi

# owner_region BOARD — print the ROOT "owner" object's DEPTH-1 FIELD STREAM only, via a string- and
# escape-aware depth scan ([ ] and { }) in POSIX awk (a shell tool, like tasks_region — NOT a jq/node
# runtime). The board is one root object; this enters ONLY the `"owner"` key found at ROOT depth (curly
# depth 1, bracket depth 0) and emits the chars at the owner object's own field level (active /
# session_id / heartbeat) — every value nested DEEPER inside owner, or anywhere else in the file
# (tasks[], log[], deps[]), is dropped wholesale. FORMAT-AGNOSTIC: single-line and multi-line JSON behave
# identically. Used so the arming gate reads `active` / `session_id` ONLY from the board-root owner
# sub-object — an `"active":true` or a `session_id` buried in an agent-shaped task/log payload of an
# ARCHIVED board can never masquerade as owner's and false-arm the hook (CODEX7, red line 6). Only a
# ROOT-depth `"owner"` key is honored (goal prose or a task with its own `"owner"` field can never be
# captured — same root-only caveat as tasks_region's `"tasks"` key). Same string/escape rules as tasks_region.
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

# ── board matching = THE ARMING GATE ────────────────────────────────────────────────────────────────
# A board is "mine" when active AND (sid empty → degraded: any active board; else owner.session_id==sid).
# The degrade is ASYMMETRIC — it fires ONLY when the STDIN sid is empty (ADR-007 §2.3: a compaction that
# drops session_id; the OWNING session re-anchoring across a compaction boundary). A board stamped with an
# EMPTY owner.session_id is NOT adopted: it falls through to the literal compare "" = "<non-empty sid>" →
# false → DORMANT (fail-safe). Auto-adopting blank-session boards was tried (CODEX12) and REVERTED (CODEX14):
# it armed EVERY unrelated session, re-introducing exactly the cross-session pollution red line 6 forbids.
# Official resume/compaction PRESERVES session_id, so a legitimately-resumed board carries its ORIGINAL
# session_id (never blank) and matches normally; a blank board is only the anomaly of bootstrap building a
# board on a sid-less stdin, and the correct way to claim it is an explicit re-arm (re-run
# as-master-orchestrator → bootstrap re-stamps owner.session_id). → ADR-007 (board-derived armed-gate).
# This board_matches IS this hook's arming gate: every cc-master hook stays dormant until THIS session
# is armed (an active board it owns), and only a matched board drives any behavior below. (Unified
# armed-hook discipline — same gate in reinject.sh / posttool-batch.sh and the node
# usage-pacing.js; bootstrap-board.sh is the ARM action and is the sole gate-exempt hook.)
# active AND session_id are read ONLY from the ROOT owner sub-object (owner_region above) — NEVER full-text
# grep: a flexible tasks[]/log[] payload of an ARCHIVED board carrying `"active":true` must never false-arm
# the hook (CODEX7, red line 6).
board_matches() { # $1 = board path
  owner="$(owner_region "$1")"
  printf '%s' "$owner" | grep -qE '"active"[[:space:]]*:[[:space:]]*true' || return 1
  [ -z "$sid" ] && return 0
  # owner.session_id must equal $sid EXACTLY. Never splice $sid into a grep -E pattern: a session id
  # carrying regex metachars (., *, [, etc.) would otherwise match the wrong board. Instead extract owner's
  # session_id *value* with a fixed regex, then compare as a literal shell string. A blank board_sid falls
  # through to "" = "<non-empty sid>" → false → DORMANT (blank board is NOT auto-adopted; red line 6).
  board_sid="$(printf '%s' "$owner" | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
               | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  [ "$board_sid" = "$sid" ]
}

# tasks_region BOARD — print the TOP-LEVEL FIELD STREAM of each object in the "tasks" array, via a
# string- and escape-aware double-depth scan ([ ] and { }) in POSIX awk (a shell tool, like the
# cksum|awk below — NOT a jq/node runtime). FORMAT-AGNOSTIC: multi-line and compact single-line
# JSON behave identically — no per-line layout assumption. Only characters at task-object top level
# (bracket depth 1 inside the array, curly depth 1 inside the task) are emitted: nested flexible
# fields — a task-local "log" array, structured entries like {"id":"L1","status":"ready"} inside it
# (codex review catches, rounds 1+2) — are dropped wholesale, so they can neither truncate the scan
# nor masquerade as task id/status/blocked_on state. Sole remaining caveat: the first quoted
# literal `"tasks"` token in the file must be the tasks key itself (true for the pinned waist;
# goal/log prose never needs that exact quoted token).
tasks_region() {
  awk '
    { s = s $0 "\n" }
    END {
      i = index(s, "\"tasks\""); if (!i) exit
      s = substr(s, i + 7)
      j = index(s, "["); if (!j) exit
      s = substr(s, j + 1)                 # start INSIDE the tasks array
      bd = 1; cd = 0; instr = 0; esc = 0; out = ""
      n = length(s)
      for (k = 1; k <= n; k++) {
        ch = substr(s, k, 1)
        if (instr) {
          if (bd == 1 && cd == 1) out = out ch
          if (esc) esc = 0
          else if (ch == "\\") esc = 1
          else if (ch == "\"") instr = 0
          continue
        }
        if (ch == "\"") { instr = 1; if (bd == 1 && cd == 1) out = out ch; continue }
        if (ch == "[") { bd++; continue }
        if (ch == "]") { bd--; if (bd == 0) break; continue }
        if (ch == "{") { cd++; continue }
        if (ch == "}") { cd--; continue }
        if (bd == 1 && cd == 1) out = out ch
      }
      printf "%s", out
    }' "$1" 2>/dev/null
}

# pending_user_decisions BOARD — print, one per line, the human label of every task object that is
# GENUINELY parked on the user: its TOP-LEVEL fields carry BOTH `"status":"blocked"` AND
# `"blocked_on":"user"` (whitespace-tolerant) — the `blocked(blocked_on:"user")` contract. Requiring
# status:"blocked" (not just blocked_on) excludes ANSWERED decisions: a task already `status:"done"`
# that still carries stale `blocked_on:"user"` metadata is no longer pending, so it is not re-warned.
# Label = its "title" if present, else its "id". This is a PER-OBJECT scan (tasks_region above flattens every object's fields into one
# stream and so cannot bind a title back to the object whose blocked_on it belongs to). Same
# string/escape/double-depth ([ ] and { }) awareness as tasks_region, so it is FORMAT-AGNOSTIC:
# single-line and multi-line JSON behave identically. Only characters at the task-object top level
# (bracket depth 1 inside the tasks array, curly depth 1 inside the task) are buffered per object —
# nested flexible fields (a task-local "log" array, structured entries inside it) are dropped
# wholesale, so they can neither inject a spurious blocked_on:user nor masquerade as a title/id.
pending_user_decisions() {
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
    # emit OBJ — list OBJ as an unanswered user decision ONLY if it is genuinely parked on the user:
    # top-level status MUST be "blocked" AND blocked_on MUST be "user" (the blocked(blocked_on:"user")
    # contract). A task already status:"done" (etc.) that still carries stale blocked_on:"user"
    # metadata is an ANSWERED decision — excluding it stops the Stop handshake re-warning on it forever.
    # Read both fields from this object OWN top-level fields via field() (per-object, nested log cannot leak).
    function emit(o,   lbl) {
      if (field(o, "status") != "blocked") return
      if (field(o, "blocked_on") != "user") return
      lbl = field(o, "title")
      if (lbl == "") lbl = field(o, "id")
      if (lbl != "") print lbl
    }
    # field(O, NAME) — extract the string value of top-level key NAME from object buffer O ("" if absent).
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

# rollup_violations BOARD — print, one per line, "<ownerId>\t<childId>\t<childStatus>" for every
# (owner, child) pair that violates the rollup invariant: the owner task is itself status:"done" but
# the child (a task whose top-level `parent` points at that owner) is NOT done. This is the bash side
# of the rollup-aware Stop gate (D3 / path-ii, ADR-012) — it answers "is any owner marked done while a
# child it contains is still in flight?", the silent-failure盲区 of a parent错标done而子在飞.
#
# WHY A FLAT, SINGLE-LAYER SCAN IS SOUND (max depth=1): `parent` is a single-value string pointer and
# the depth=1 type invariant means an owner's children are themselves leaves (no grandchildren). So the
# whole computation is a flat set operation over (id, status, parent) triples — NO recursion, NO depth
# walk, NO awk depth门 on the relation. We do it in TWO awk passes folded into one per-object scan:
# build (id→status) and (child→parent) flat maps, then for each child whose parent is a DONE owner and
# whose own status≠done, emit the violation. Self-implemented flat set运算 here mirrors EXACTLY
# board-graph-core.js rollupConsistency() (statusOf(owner)==='done' ∧ child status!=='done') — one口径,
# two consumers (the JS lib for board-lint R7d, this bash for the Stop gate).
#
# GRACEFUL-DEGRADE (red line 2, same discipline as the三时间锚 / wakeup soft-observed reads): a board
# with NO `parent` edges (old board / hand-written board) yields an EMPTY child→parent map → zero
# owners → zero violations → the gate degrades to the existing flat behavior. A `parent` pointing at a
# non-existent owner id, or at an owner whose status is not "done", simply produces no violation (we
# only flag a child against an owner that is BOTH a real task AND status:"done", exactly like
# graph-core where statusOf(owner)===undefined ≠ 'done'). A malformed parent never breaks the Stop gate.
#
# Same per-object, string/escape/double-depth ([ ] and { }) awareness as pending_user_decisions, so it
# is FORMAT-AGNOSTIC (single-line == multi-line) and a nested flexible `parent` in a task-local log
# payload can never masquerade as a top-level container edge (only task-object top-level fields are
# buffered per object — nested objects are dropped wholesale).
rollup_violations() { # $1 = board path
  awk '
    { s = s $0 "\n" }
    END {
      i = index(s, "\"tasks\""); if (!i) exit
      s = substr(s, i + 7)
      j = index(s, "["); if (!j) exit
      s = substr(s, j + 1)                 # start INSIDE the tasks array
      bd = 1; cd = 0; instr = 0; esc = 0; obj = ""
      n = length(s)
      ntask = 0                            # collected task objects (top-level field buffers)
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
          if (bd == 1 && cd == 0) {                                            # closed a task object
            id = field(obj, "id"); st = field(obj, "status"); pa = field(obj, "parent")
            if (id != "") { ntask++; tid[ntask] = id; tst[ntask] = st; tpa[ntask] = pa; statusById[id] = st }
          }
          continue
        }
        if (bd == 1 && cd == 1) obj = obj ch
      }
      # Flat rollup pass: for each task that HAS a parent, check whether that parent is a DONE owner and
      # the child itself is not done → violation. statusById maps an existing top-level task id to its
      # status; a parent pointing at a missing id yields statusById[pa]=="" ≠ "done" → no violation.
      for (t = 1; t <= ntask; t++) {
        if (tpa[t] == "") continue                       # no parent edge → not a child → skip
        if (statusById[tpa[t]] != "done") continue       # owner missing or not done → no rollup gate
        if (tst[t] == "done") continue                   # child already done → consistent
        print tpa[t] "\t" tid[t] "\t" tst[t]             # owner done but child not done → violation
      }
    }
    # field(O, NAME) — extract the string value of top-level key NAME from object buffer O ("" if absent).
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

# wakeup_is_object BOARD — exit 0 iff the board carries a ROOT-depth `"wakeup"` key whose value is an
# OBJECT (opens with `{`). This is the soft-observed read of the optional top-level `wakeup` watchdog
# record (ADR-011): present-and-an-object → a watchdog is armed; absent OR a non-object value → no
# watchdog (graceful-degrade, exactly like wip_limit). String/escape/depth-aware in POSIX awk (a shell
# tool, NOT jq/node) so it is FORMAT-AGNOSTIC (single-line == multi-line) and a `"wakeup"` buried in an
# agent-shaped task/log payload can never masquerade as the root field (same root-only discipline as
# owner_region / tasks_region). After the root `"wakeup"` key is seen, the value is whatever non-space
# char follows the `:` — only `{` counts as the armed object; anything else (a string, null, number,
# array, false placeholder) is treated as "no watchdog" → reminder still fires.
wakeup_is_object() { # $1 = board path
  awk '
    { s = s $0 "\n" }
    END {
      n = length(s)
      cd = 0; bd = 0; instr = 0; esc = 0
      capkey = 0; key = ""; pendKey = ""        # pendKey: last completed ROOT-depth key string
      afterColon = 0                            # 1 once we are reading the root wakeup value
      for (k = 1; k <= n; k++) {
        ch = substr(s, k, 1)
        if (instr) {                            # skip over string contents (track key capture only)
          if (esc) { esc = 0; if (capkey) key = key ch; continue }
          if (ch == "\\") { esc = 1; if (capkey) key = key ch; continue }
          if (ch == "\"") { instr = 0; if (capkey) { capkey = 0; pendKey = key } continue }
          if (capkey) key = key ch
          continue
        }
        if (afterColon) {                       # reading the value that follows root "wakeup":
          if (ch == " " || ch == "\t" || ch == "\n" || ch == "\r" || ch == ":") continue
          if (ch == "{") { print "yes"; exit }  # object → watchdog armed
          exit                                  # any other value → not an object → no watchdog
        }
        if (ch == "\"") {                        # a string starting at ROOT depth is a candidate key
          instr = 1
          if (cd == 1 && bd == 0) { capkey = 1; key = "" } else capkey = 0
          continue
        }
        if (ch == "[") { bd++; pendKey = ""; continue }
        if (ch == "]") { if (bd > 0) bd--; continue }
        if (ch == "{") { cd++; pendKey = ""; continue }
        if (ch == "}") { if (cd > 0) cd--; pendKey = ""; continue }
        if (ch == ":") { if (cd == 1 && bd == 0 && pendKey == "wakeup") afterColon = 1; continue }
        if (ch == ",") pendKey = ""
      }
    }' "$1" 2>/dev/null | grep -q "yes"
}

# wakeup_fire_at BOARD — print the STRING value of `fire_at` nested ONE level inside the ROOT-depth
# `"wakeup"` object ("" if there is no root wakeup object, or it carries no fire_at string). Same
# root-only, string/escape/depth-aware discipline as wakeup_is_object / owner_region: we only enter the
# ROOT `"wakeup"` object (curly depth 1, bracket depth 0) and read `fire_at` at THAT object's own field
# level (curly depth 2, bracket depth 0) — a `fire_at` nested deeper inside wakeup, or anywhere else in
# the file (a task/log payload's own `wakeup.fire_at`), is never captured. FORMAT-AGNOSTIC (single-line
# == multi-line). This is the expiry-aware half of the soft-observed watchdog read (ADR-011, Finding #56
# family / 簇#2 self-heal): the watchdog判定 below treats an EXPIRED fire_at as "not armed" so a stale
# wakeup left behind by a watchdog that already should have fired no longer silences the reminder.
wakeup_fire_at() { # $1 = board path
  awk '
    { s = s $0 "\n" }
    END {
      n = length(s)
      cd = 0; bd = 0; instr = 0; esc = 0
      capkey = 0; key = ""; pendKey = ""        # pendKey: last completed key string at current depth
      inwk = 0; wd = 0                          # inwk: inside root wakeup object, opened at curly depth wd
      capval = 0; val = ""                      # capval: capturing the fire_at string value
      for (k = 1; k <= n; k++) {
        ch = substr(s, k, 1)
        if (inwk) {                             # already inside the root wakeup object (opened at depth wd)
          if (instr) {
            if (esc) { esc = 0; if (capkey) key = key ch; else if (capval) val = val ch; continue }
            if (ch == "\\") { esc = 1; if (capkey) key = key ch; else if (capval) val = val ch; continue }
            if (ch == "\"") {
              instr = 0
              if (capkey) { capkey = 0; pendKey = key }
              else if (capval) { print val; exit }   # closed the fire_at string value → done
              continue
            }
            if (capkey) key = key ch
            else if (capval) val = val ch
            continue
          }
          if (ch == "\"") {                     # a string at wakeup-field level is a key, or the fire_at value
            instr = 1
            if (cd == wd && bd == 0 && pendKey == "fire_at") { capval = 1; val = "" }
            else if (cd == wd && bd == 0) { capkey = 1; key = "" }
            else { capkey = 0; capval = 0 }
            continue
          }
          if (ch == "[") { bd++; continue }
          if (ch == "]") { if (bd > 0) bd--; continue }
          if (ch == "{") { cd++; pendKey = ""; continue }
          if (ch == "}") { cd--; pendKey = ""; if (cd < wd) { inwk = 0; break } continue }   # wakeup closed → no fire_at
          if (ch == ":") continue
          if (ch == ",") pendKey = ""
          continue
        }
        if (instr) {                            # in a string while still scanning for root "wakeup":{
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
          if (cd == 2 && bd == 0 && pendKey == "wakeup") { inwk = 1; wd = 2 }   # entered root wakeup{}
          pendKey = ""
          continue
        }
        if (ch == "}") { if (cd > 0) cd--; pendKey = ""; continue }
        if (ch == ",") pendKey = ""
      }
    }' "$1" 2>/dev/null
}

# wakeup_armed BOARD — exit 0 iff the board carries a watchdog that should be honored as ARMED, i.e. NOT
# stale (Finding #56 family / 簇#2 self-heal, ADR-011). "Armed" = a root `wakeup` OBJECT whose `fire_at`
# is EITHER absent / not in strict ISO-8601-UTC `YYYY-MM-DDTHH:MM:SSZ` form (graceful-degrade: an old or
# agent-shaped board we can't reason about is left ALONE → treated as armed, today's behavior) OR a
# legal fire_at that is still in the FUTURE (>= now). The ONLY case treated as "not armed" is the trio
# "object + legal fire_at + already past now" — a watchdog that should already have fired but a task is
# still in_flight: that IS the silent-failure signal, so the reminder must fire again (self-heal).
# ISO-8601-UTC strings (fixed-width, Z suffix) sort lexicographically in time order, so a plain string
# compare `fire_at < now` is a valid time compare (pure bash, no date math). Graceful-degrade is red
# line 2 (wakeup is soft-observed / agent-shaped, NOT pinned waist): a malformed/absent fire_at must
# never break an older board — only the fully-determined stale trio downgrades to "not armed".
ISO_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
wakeup_armed() { # $1 = board path
  wakeup_is_object "$1" || return 1            # no root wakeup object → not armed
  fa="$(wakeup_fire_at "$1")"
  [ -z "$fa" ] && return 0                     # object but no fire_at → graceful-degrade → armed
  printf '%s' "$fa" | grep -qE "$ISO_RE" || return 0   # malformed fire_at → graceful-degrade → armed
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  [ "$fa" \< "$now" ] && return 1              # legal fire_at already in the past → STALE → not armed
  return 0                                     # legal fire_at still in the future → armed
}

active_found=0; empty_active=0; actionable=0
watchdog_needed=0                          # 1 if any matched board has an in_flight task but no armed wakeup
matched_boards=""                          # newline-separated paths of THIS session's active boards
for b in "$HOME_DIR"/*.board.json; do
  [ -e "$b" ] || continue                 # no boards → unexpanded glob
  board_matches "$b" || continue          # archived or not this session's → ignore
  active_found=1
  matched_boards="$matched_boards$b
"
  # All detection below is scoped to the tasks REGION, never the whole file — log/owner fields can
  # then never masquerade as tasks, regardless of how the JSON is line-wrapped.
  region="$(tasks_region "$b")"
  # Count task objects by their "id" key inside the region. Keep the fallback OUTSIDE the
  # substitution: grep -c prints "0" AND exits 1 on zero matches, so a `|| echo 0` inside $(...)
  # would append a second "0" → "0\n0" → integer test crash.
  tc="$(printf '%s' "$region" | grep -cE '"id"[[:space:]]*:')" || tc=0
  [ "$tc" -eq 0 ] && empty_active=1
  # Actionable = a ready or uncertain TASK remains (log entries excluded by the region scope).
  if printf '%s' "$region" | grep -qE '"status"[[:space:]]*:[[:space:]]*"(ready|uncertain)"'; then
    actionable=1
  fi
  # Watchdog (ADR-011): if THIS board has an in_flight TASK but no ARMED `wakeup`, a background task
  # could fail silently with no one coming back to recon it. Soft-observed (graceful-degrade like
  # wip_limit): only the completion-state handshake below acts on this — actionable/empty boards block
  # earlier and never reach it. in_flight is read from the tasks REGION (log entries excluded).
  # EXPIRY-AWARE (Finding #56 family / 簇#2 self-heal): wakeup_armed counts a STALE wakeup (object with a
  # legal fire_at already in the past) as NOT armed, so a stale safety net left behind by a watchdog that
  # should already have fired no longer silences the reminder while a task is still in_flight.
  if printf '%s' "$region" | grep -qE '"status"[[:space:]]*:[[:space:]]*"in_flight"'; then
    wakeup_armed "$b" || watchdog_needed=1
  fi
done

# Fingerprint of THIS session's matched boards' completion state (pure bash, no jq). cksum over the
# per-task id+status+blocked_on+parent quads IN FILE ORDER (NOT sorted) → the digest binds each id to
# its status, so swapping two tasks' statuses or changing a task's blocked_on yields a DIFFERENT
# fingerprint and re-forces the self-check (Finding #21). Status-multiset-only hashing missed those.
# PARENT DIMENSION (D3 / ADR-012): `parent` is now a pinned-waist container edge. Folding it in means a
# CHILD's status flipping (e.g. an owner's last in_flight child → done) changes the fingerprint of the
# owner sub-graph it rolls into → the rollup-aware Stop gate's reminder is re-evaluated across a
# compaction (a done-owner-with-non-done-child state hashes differently from the same triples without
# the parent edge). An OLD board with no `parent` field contributes no `"parent":"..."` token → it
# hashes EXACTLY as the pre-D3 formula did (graceful-degrade: no spurious handshake churn on flat boards).
# SCOPING (Finding #22 + format-agnostic rework): only the tasks REGION is fingerprinted (see
# tasks_region above), so audit-log prose or other non-task fields can never look like a changed
# completion state — and a log append between Stops never re-forces a handshake. Works identically
# on single-line and multi-line JSON; no per-line layout assumption remains.
# WATCHDOG DIMENSION (Finding #56 family, codex round-2): the watchdog_needed bit (0/1) is FOLDED INTO
# the cksum input too. Two reasons: (1) a completion state needing a watchdog nudge (watchdog_needed=1)
# must hash DIFFERENTLY from the same task triples WITHOUT it (=0), so transitioning into "needs
# watchdog" re-forces the handshake that carries the reminder. (2) UPGRADE SAFETY — the fingerprint
# FORMULA now changed, so any stale `.stopcheck` written by an OLDER hook (which hashed task triples
# only, no watchdog dimension) can never equal the new digest → an in_flight/no-wakeup board that was
# already handshook under the old logic is forced through ONE fresh handshake → watchdog reminder fires
# instead of being silently skipped via the allow-early-exit path. watchdog_needed is computed in the
# board scan ABOVE, so its value is already settled when this runs.
# FIRE_AT DIMENSION (簇#2 self-heal): each matched board's root `wakeup.fire_at` value is ALSO folded in
# — but ONLY when it is non-empty (a board with NO wakeup contributes nothing, so it hashes EXACTLY as
# the pre-fire_at formula did → no spurious handshake churn on the no-wakeup majority, and the test
# mirror for no-wakeup boards stays valid). Re-arming a stale watchdog with a FRESH future fire_at flips
# watchdog_needed 1→0 (the digest already changes from the watchdog bit), but folding fire_at itself in
# also makes "swap one future fire_at for another future fire_at" (watchdog_needed stays 0 both times)
# count as a CHANGED completion state → re-force ONE fresh handshake so the orchestrator re-confirms the
# new watchdog rather than silently riding the old handshook fingerprint.
status_fingerprint() {
  { printf 'watchdog_needed:%s\n' "$watchdog_needed"
    printf '%s' "$matched_boards" | while IFS= read -r bp; do
      [ -n "$bp" ] || continue
      fa="$(wakeup_fire_at "$bp")"
      [ -n "$fa" ] && printf 'fire_at:%s\n' "$fa"
      tasks_region "$bp" \
        | grep -oE '"(id|status|blocked_on|parent)"[[:space:]]*:[[:space:]]*"[^"]*"'
    done
  } | cksum | awk '{print $1}'
}

# ── decision ──────────────────────────────────────────────────────────────────────────────────────
emit_block() { # $1 = reason text — bump streak, fuse-check, write sidecar, print decision or force-allow
  block_streak=$((block_streak+1))
  if [ "$block_streak" -ge "$FUSE" ]; then
    # Fuse tripped: force allow + warning, then clear the sidecar (streak resets).
    warn="cc-master: fuse tripped — blocked $block_streak times in a row. Releasing the stop. If you are stuck, check the board for a \`ready\` task that cannot actually proceed (mark it \`blocked\`/\`escalated\`) before continuing."
    esc="$(printf '%s' "$warn" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')"
    rm -f "$SIDECAR"
    printf '{"reason":%s}\n' "$esc"   # no decision:block → not a block; agent stops with a warning shown
    exit 0
  fi
  # Atomic write (tmp + mv): a concurrent Stop never observes a torn sidecar.
  printf '%s %s\n' "$block_streak" "$last_handshook_fp" > "$SIDECAR.tmp.$$" && mv -f "$SIDECAR.tmp.$$" "$SIDECAR"
  esc="$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')"
  printf '{"decision":"block","reason":%s}\n' "$esc"
  exit 0
}
allow() { rm -f "$SIDECAR"; exit 0; }   # allow → clear sidecar (streak → 0)
# allow_handshook_fp — allow, but KEEP the handshook fingerprint so the SAME completion state keeps
# allowing on every subsequent Stop (it has already been self-checked). Streak resets to 0; only a
# CHANGED fingerprint (or actionable work, which writes "-") will re-force a self-check.
allow_handshook_fp() { printf '0 %s\n' "$last_handshook_fp" > "$SIDECAR.tmp.$$" && mv -f "$SIDECAR.tmp.$$" "$SIDECAR"; exit 0; }

# No matching active board → dormant → allow.
[ "$active_found" -eq 0 ] && allow

# Empty active board → bootstrap never filled → block.
if [ "$empty_active" -eq 1 ]; then
  emit_block 'cc-master: an active board in your home has no tasks. Decompose the goal into a dependency DAG and write tasks[] into it (or archive it with /cc-master:stop) before ending.'
fi

# Actionable work (ready/uncertain) → block. This is NOT a completion-state handshake, so it carries
# no fingerprint: reset last_handshook_fp to "-" so the NEXT completion state must self-check anew.
if [ "$actionable" -eq 1 ]; then
  last_handshook_fp="-"
  emit_block 'cc-master: this board still has a `ready` or `uncertain` task. A `ready` task can proceed now; an `uncertain` one has output awaiting verification. Resolve it (or mark it `blocked`/`escalated`) before stopping.'
fi

# Completion state (all in_flight/blocked/done/failed/escalated/stale) → fingerprint-keyed handshake.
# If THIS exact completion state was already handshook (fp unchanged), allow — don't re-ask. Only a
# changed completion state re-forces the self-check. (Fixes: same board state re-self-checked on a
# long background wait, since every allow used to zero the handshake flag.)
fp_now="$(status_fingerprint)"
if [ "$last_handshook_fp" = "$fp_now" ]; then
  allow_handshook_fp   # this completion-state fingerprint was already handshook → allow + KEEP fp
fi
# New (or changed) completion state → record the fingerprint we are handshaking on, then block.
last_handshook_fp="$fp_now"
handshake_reason='cc-master: before you stop, self-check against this board'\''s `goal`. (1) Is every point that needs the user surfaced / marked `blocked_on:"user"`? (2) Against the **original goal**, is every to-do actually done — including any NOT yet listed on the board? If something is missing, add it to `tasks[]` and keep going; only stop once the goal is truly met.'
# H3: if any task on a matched board is parked on the user (status blocked, `blocked_on:"user"`),
# name those open decisions in the handshake so the agent cannot silently exit on an unanswered one.
# Collect the human label (title, else id) of each across all of THIS session's matched boards.
pending_list=""
while IFS= read -r bp; do
  [ -n "$bp" ] || continue
  pending_list="$pending_list$(pending_user_decisions "$bp")
"
done <<EOF
$matched_boards
EOF
# Join the non-empty labels with "; " (pure bash; preserves file order, dedup not needed for naming).
pending_joined=""
while IFS= read -r lbl; do
  [ -n "$lbl" ] || continue
  if [ -z "$pending_joined" ]; then pending_joined="$lbl"; else pending_joined="$pending_joined; $lbl"; fi
done <<EOF
$pending_list
EOF
if [ -n "$pending_joined" ]; then
  handshake_reason="$handshake_reason Unanswered user decisions still on this board: $pending_joined. Confirm each is genuinely still pending (or resolve it) before you stop — don't silently exit on an open user decision."
fi
# Watchdog reminder (ADR-011): the board is in a completion state but still has an in_flight background
# task with NO armed `wakeup` record. The harness auto-reawakens on a tracked task's COMPLETION, but a
# task that hangs / dies silently / was never dispatched emits no completion event — so nobody comes
# back. Before stopping, arm a watchdog wakeup (CronCreate one-shot / ScheduleWakeup / Monitor /
# background-shell `until` floor) and write what to recon into the board's `wakeup.checklist`. Soft-
# observed: an already-armed `wakeup` object silences this (graceful-degrade like wip_limit). The
# canonical anchor phrase "arm a watchdog wakeup" maps to the wait-edge in the orchestration skill.
# CEILING = RECON TRIGGER, NOT DEATH VERDICT (Finding #60): an expired fire_at while still in_flight
# nudges the agent to come back and recon ground truth (git/mtime/long-silent-command), NOT to kill a
# healthy long-runner. The wording must say "recon, not verdict" + "generous time ceiling, never
# output-size stall as liveness signal" so the reminder cannot induce false-killing a healthy task that
# is legitimately blocked on a long silent command (run-tests / big compile). See async-hitl.md
# §ceiling = recon 触发器.
if [ "$watchdog_needed" -eq 1 ]; then
  handshake_reason="$handshake_reason This board has an in_flight background task but no armed watchdog (the \`wakeup\` field is missing, or its \`fire_at\` is already in the past). An expired \`fire_at\` while a task is still in_flight is a trigger to come back and RECON ground truth — NOT a death verdict: if recon shows it healthy (git moving / output mtime still changing / legitimately blocked on a long silent command like run-tests), extend / re-arm the watchdog and let it run; only a task frozen with no ground-truth change well past a generous ceiling is judged hung. Before you stop, arm a watchdog wakeup (CronCreate one-shot / ScheduleWakeup / Monitor / background-shell \`until\`) for the in_flight tasks that could fail silently — use a generous time ceiling, never an output-size stall as the liveness signal — and record what to recon when it fires in the board's \`wakeup.checklist\` — otherwise a silently-failing background task leaves no one to come back and look."
fi
# Rollup-aware reminder (D3 / path-ii, ADR-012, Q-N1 = SOFT reminder, NOT a hard block): on a completion
# state, if any owner task is marked status:"done" while a child it contains (a task whose `parent` points
# at it) is NOT done, the owner sub-graph is rolled up inconsistently — the parent was likely错标 done
# while a child is still in flight, which would silently漏掉 the whole sub-graph. Collected ONLY over THIS
# session's matched (= armed) boards (red line 6: the loop is inside the board_matches gate — an unarmed
# session never reaches here, so no rollup reminder is ever injected when dormant). Graceful-degrade: an
# old board with no `parent` edge yields zero violations and this block is silently skipped — the existing
# flat Stop behavior is untouched. Same soft-nudge form as the watchdog / pending reminders (appended to
# the self-check handshake reason, never a hard block — Q-N1: a parent done整合中、子刚标完 transient
# would be误伤 by a hard gate, and it matches cc-master's "hook soft-reminds, never hard-stops" house style).
rollup_pairs=""
while IFS= read -r bp; do
  [ -n "$bp" ] || continue
  rollup_pairs="$rollup_pairs$(rollup_violations "$bp")
"
done <<EOF
$matched_boards
EOF
# Join the violations into a human list "owner X done but child Y is <status>; ...". Pure bash,
# file order, dedup not needed for naming.
rollup_joined=""
while IFS="$(printf '\t')" read -r owner child cstatus; do
  [ -n "$owner" ] || continue
  one="owner $owner is \`done\` but child $child is \`$cstatus\`"
  if [ -z "$rollup_joined" ]; then rollup_joined="$one"; else rollup_joined="$rollup_joined; $one"; fi
done <<EOF
$rollup_pairs
EOF
if [ -n "$rollup_joined" ]; then
  handshake_reason="$handshake_reason Rollup inconsistency on this board ($rollup_joined): a parent (owner) node should NOT be \`done\` while a child under its \`parent\` is still unfinished — a done parent means全子 done ∧ the parent's own端点验收 passed. Either the parent was错标 done while a child is in flight (un-done the parent and finish the child), or the child finished and just needs its status updated. Don't stop on a rolled-up-inconsistent owner sub-graph."
fi
emit_block "$handshake_reason"
