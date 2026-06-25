#!/usr/bin/env bash
# UserPromptSubmit hook: when the as-master-orchestrator command is invoked, deterministically
# create a NEW uniquely-named board in the configurable home, then inject its path + the
# orchestrator role so the agent knows which board is its own. This hook does NOT self-gate on a
# marker (it is the activator) — it gates on a TIGHTENED dual sentinel so that text which merely
# *mentions* the command name (a task-notification, a sub-agent result, a user discussing the
# command) no longer false-triggers an empty board (Finding #15):
#   1. raw command  — the prompt field VALUE starts with /cc-master:as-master-orchestrator
#                     (leading whitespace tolerated); a mid-text mention does not qualify.
#   2. expanded body— the cc-master:bootstrap:v1 marker (an HTML comment that opens the expanded
#                     command body, right after the frontmatter) is the prompt's FIRST non-empty
#                     line. Kept as a safety backup in case UserPromptSubmit sees the expanded body,
#                     not the raw cmd. The marker MUST be the first non-empty line, not a bare
#                     substring anywhere in stdin — otherwise prose that merely *mentions* the marker
#                     mid-sentence (a sub-agent report quoting the command-file convention) would
#                     false-trigger an empty board (Finding #16).
# Pure bash extraction of the JSON prompt field — no jq/node (ship-anywhere).
#
# ARMING NOTE (hook armed-gate discipline): every OTHER cc-master hook stays fully dormant until this
# session is "armed" — armed ⟺ home holds a *.board.json with owner.active:true AND owner.session_id
# == this session's id. This bootstrap hook is the ARM ACTION ITSELF: it is the only hook EXEMPT from
# that gate (it cannot require a prior armed board — it creates the armed state). To make the
# session-scoped gate satisfiable the instant the board is born, it stamps owner.session_id from the
# stdin session_id below (instead of leaving it ""), so the creating session immediately owns its board.
set -uo pipefail

stdin="$(cat)"

# ── stdin → session_id (pure bash, no jq; same extraction as verify-board.sh / reinject.sh) ─────────
# This is the ARM identity stamped onto the new board's owner.session_id, so the armed gate
# (active:true AND owner.session_id==sid) is immediately true for the session that armed it.
sid="$(printf '%s' "$stdin" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# RESUME support (design 2026-06-15-resume-board-mechanism.md). bootstrap's SECOND ARM form: instead
# of creating a fresh board, re-stamp owner onto a SELECTED pre-existing board (cross-session re-arm).
# Everything here is pure bash + awk (a shell tool, NOT jq/node — red line 1 / ADR-006). Functions are
# defined up-front but only invoked from the resume branch below; the fresh path never touches them.
# ════════════════════════════════════════════════════════════════════════════════════════════════

# rewrite_owner_field BOARD FIELD NEWVAL — rewrite owner.FIELD (FIELD ∈ session_id|active|heartbeat)
# IN PLACE, touching ONLY the ROOT "owner" sub-object (red line 2). Reuses verify-board.sh's verified
# owner DEPTH-aware scanner state machine: it walks the file char-by-char tracking curly depth (cd),
# bracket depth (bd) and string state, enters ONLY the root-depth `"owner"` object, and within it
# rewrites the FIRST occurrence of `"FIELD": <value>` — emitting NEWVAL verbatim and skipping the old
# value's bytes. Every other byte (goal, tasks[], log[], git, any session_id-shaped field nested in a
# task/log payload) is passed through untouched. NEWVAL is passed via awk `-v` (NOT spliced into a
# regex/sed replacement) so a value carrying sed metachars (/ & . *) is written literally — this is
# why we use awk, not sed, for the non-empty re-stamp (design §1.3 metachar trap). FORMAT-AGNOSTIC:
# single-line and multi-line JSON behave identically (same guarantee as owner_region/tasks_region).
rewrite_owner_field() { # $1 board $2 field $3 newval
  awk -v field="$2" -v newval="$3" '
    { s = s $0 "\n" }            # buffer the whole file (a trailing "\n" per line; one dropped at EOF)
    END {
      n = length(s)
      cd = 0; bd = 0; instr = 0; esc = 0
      capkey = 0; key = ""; pendKey = ""
      inowner = 0; od = 0; done = 0
      out = ""
      k = 1
      while (k <= n) {
        ch = substr(s, k, 1)
        if (inowner && !done) {
          if (instr) {
            out = out ch
            if (esc) esc = 0
            else if (ch == "\\") esc = 1
            else if (ch == "\"") instr = 0
            k++; continue
          }
          if (ch == "\"") {
            # a string at owner-field depth (cd==od+1, bd==0) may be the FIELD key we want
            if (cd == od + 1 && bd == 0) {
              # peek the key name
              kk = k + 1; nm = ""
              while (kk <= n) {
                c2 = substr(s, kk, 1)
                if (c2 == "\"") break
                if (c2 == "\\") { kk++; nm = nm substr(s, kk, 1); kk++; continue }
                nm = nm c2; kk++
              }
              if (nm == field) {
                # found owner.FIELD key. Emit the key + colon + whitespace verbatim, then replace the
                # VALUE token with newval (quoted for string fields, bare for active=true/false).
                out = out "\"" nm "\""
                p = kk + 1                       # char right after the closing key-quote
                # copy whitespace + the colon + whitespace up to the value start
                while (p <= n) {
                  cc = substr(s, p, 1)
                  if (cc == " " || cc == "\t" || cc == "\n" || cc == ":") { out = out cc; p++; if (cc == ":") break; continue }
                  break
                }
                while (p <= n) {                 # skip whitespace before the value
                  cc = substr(s, p, 1)
                  if (cc == " " || cc == "\t" || cc == "\n") { out = out cc; p++; continue }
                  break
                }
                # now p is at the value start: either a quoted string or a bare token (true/false/null/number)
                vc = substr(s, p, 1)
                if (vc == "\"") {                # string value → skip to matching close-quote
                  p++
                  while (p <= n) {
                    cc = substr(s, p, 1)
                    if (cc == "\\") { p += 2; continue }
                    if (cc == "\"") { p++; break }
                    p++
                  }
                } else {                          # bare token → skip to next , } ] or whitespace
                  while (p <= n) {
                    cc = substr(s, p, 1)
                    if (cc == "," || cc == "}" || cc == "]" || cc == " " || cc == "\t" || cc == "\n") break
                    p++
                  }
                }
                if (field == "active") out = out newval        # bare boolean, no quotes
                else out = out "\"" newval "\""                # string fields → quoted
                done = 1                                       # only the first owner.FIELD is rewritten
                k = p                                          # continue emitting from after the old value
                continue
              }
            }
            out = out ch; instr = 1; k++; continue
          }
          if (ch == "[") { bd++; out = out ch; k++; continue }
          if (ch == "]") { if (bd > 0) bd--; out = out ch; k++; continue }
          if (ch == "{") { cd++; out = out ch; k++; continue }
          if (ch == "}") { cd--; out = out ch; if (cd == od) { inowner = 0 } k++; continue }
          out = out ch; k++; continue
        }
        # ── outside owner (or after done): pass through verbatim, but still track depth to find owner{
        out = out ch
        if (instr) {
          if (esc) { esc = 0; if (capkey) key = key ch; k++; continue }
          if (ch == "\\") { esc = 1; if (capkey) key = key ch; k++; continue }
          if (ch == "\"") { instr = 0; if (capkey) { capkey = 0; pendKey = key } k++; continue }
          if (capkey) key = key ch
          k++; continue
        }
        if (ch == "\"") {
          instr = 1
          if (cd == 1 && bd == 0) { capkey = 1; key = "" } else capkey = 0
          k++; continue
        }
        if (ch == "[") { bd++; pendKey = ""; k++; continue }
        if (ch == "]") { if (bd > 0) bd--; k++; continue }
        if (ch == "{") {
          cd++
          if (cd == 2 && bd == 0 && pendKey == "owner" && !done) { inowner = 1; od = 1 }
          pendKey = ""
          k++; continue
        }
        if (ch == "}") { if (cd > 0) cd--; pendKey = ""; k++; continue }
        if (ch == ",") { pendKey = ""; k++; continue }
        k++
      }
      # strip the single trailing "\n" we synthesized at EOF if the source had none — simplest: print
      # out as-is; callers compare byte content of the regions, and a trailing newline is harmless and
      # matches typical board files (printf ... "\n"). We drop exactly one trailing newline to mirror
      # the original file when it had no trailing blank line.
      sub(/\n$/, "", out)
      printf "%s\n", out
    }' "$1"
}

# owner_field_value BOARD FIELD — print the value of owner.FIELD (string fields unquoted, "active"
# as the bare token true/false). Reuses verify-board's owner_region scanner inline. "" if absent.
owner_field_value() { # $1 board $2 field
  awk -v field="$2" '
    { s = s $0 "\n" }
    END {
      n = length(s)
      cd = 0; bd = 0; instr = 0; esc = 0
      capkey = 0; key = ""; pendKey = ""
      inowner = 0; od = 0; out = ""
      for (k = 1; k <= n; k++) {
        ch = substr(s, k, 1)
        if (inowner) {
          if (instr) { if (cd == od + 1 && bd == 0) out = out ch
            if (esc) esc = 0; else if (ch == "\\") esc = 1; else if (ch == "\"") instr = 0; continue }
          if (ch == "\"") { instr = 1; if (cd == od + 1 && bd == 0) out = out ch; continue }
          if (ch == "[") { bd++; continue }
          if (ch == "]") { if (bd > 0) bd--; continue }
          if (ch == "{") { cd++; continue }
          if (ch == "}") { cd--; if (cd == od) { inowner = 0; break } continue }
          if (cd == od + 1 && bd == 0) out = out ch
          continue
        }
        if (instr) {
          if (esc) { esc = 0; if (capkey) key = key ch; continue }
          if (ch == "\\") { esc = 1; if (capkey) key = key ch; continue }
          if (ch == "\"") { instr = 0; if (capkey) { capkey = 0; pendKey = key } continue }
          if (capkey) key = key ch
          continue
        }
        if (ch == "\"") { instr = 1; if (cd == 1 && bd == 0) { capkey = 1; key = "" } else capkey = 0; continue }
        if (ch == "[") { bd++; pendKey = ""; continue }
        if (ch == "]") { if (bd > 0) bd--; continue }
        if (ch == "{") { cd++; if (cd == 2 && bd == 0 && pendKey == "owner") { inowner = 1; od = 1 } pendKey = ""; continue }
        if (ch == "}") { if (cd > 0) cd--; pendKey = ""; continue }
        if (ch == ",") pendKey = ""
      }
      # out is the owner field stream; pull FIELD value. String fields: "field":"value"; active: bare.
      sfield = "\"" field "\"[ \t]*:[ \t]*\""
      if (match(out, sfield)) { v = substr(out, RSTART + RLENGTH); sub(/".*/, "", v); print v; exit }
      bfield = "\"" field "\"[ \t]*:[ \t]*"
      if (match(out, bfield)) { v = substr(out, RSTART + RLENGTH); sub(/[^A-Za-z0-9._-].*/, "", v); print v; exit }
    }' "$1"
}

# goal_value BOARD — print the top-level "goal" string value (pure bash sed, first match = goal in the
# pinned waist order). Used for substring selection only.
goal_value() { sed -n 's/.*"goal"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1; }

# board_mtime_epoch BOARD — print the file's mtime as epoch seconds (GNU `stat -c` / BSD `stat -f`).
# Empty if neither works (→ treated as "no signal" → conservative).
board_mtime_epoch() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || true
}

# iso8601_to_epoch TS — parse an ISO8601 UTC heartbeat to epoch seconds. TWO precisions are accepted,
# because BOTH are actually in use: a live session / the documented board (board.example.json,
# board.md) flushes MINUTE precision `YYYY-MM-DDTHH:MMZ` (e.g. 2026-06-15T05:52Z), while the takeover
# re-stamp below writes SECOND precision `YYYY-MM-DDTHH:MM:SSZ` (date -u +%Y-%m-%dT%H:%M:%SZ). Prints
# the epoch on success; prints NOTHING (empty) when TS is empty or NOT parseable — the caller treats
# "no output" as "no usable signal" (conservative, design §5.4: heartbeat 解析失败 → 退 mtime-only；两者都
# 拿不到 → 保守要 force). Portability: BSD `date -j -f` (macOS) and GNU `date -d` reject malformed input
# with non-zero RC, so a garbage TS yields empty regardless of platform. TZ=UTC pins the parse so a Z
# timestamp maps to the same epoch on both.
iso8601_to_epoch() { # $1 ts
  [ -n "$1" ] || return 0
  # Shape-gate first: accept YYYY-MM-DDTHH:MM[:SS]Z — seconds OPTIONAL (minute precision is the
  # documented/flushed form; the takeover re-stamp adds seconds). This stops a loose `date` (some GNU
  # builds coerce partial/garbage strings) from inventing an epoch for a non-timestamp value while no
  # longer rejecting the minute-precision heartbeat the board actually carries (round-3 Finding C).
  printf '%s' "$1" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?Z$' || return 0
  # BSD/macOS: `date -j -u -f FMT VALUE +%s`. GNU/Linux: `date -u -d VALUE +%s`. Try the second-precision
  # then the minute-precision BSD format, then GNU (which generally accepts both shapes from the string).
  date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null \
    || date -j -u -f '%Y-%m-%dT%H:%MZ' "$1" +%s 2>/dev/null \
    || date -u -d "$1" +%s 2>/dev/null \
    || true
}

# json_string TEXT — emit TEXT as ONE properly-escaped JSON string literal (including the surrounding
# quotes). A correct escaper: backslash → \\, double-quote → \", and any LITERAL newline → \n, then the
# whole stream wrapped in a single pair of quotes. The fresh path's `sed 's/^/"/; s/$/"/'` quotes
# PER LINE — fine for its single-line context, but the resume disambiguation context carries literal
# newlines (the multi-board candidate listing), which per-line quoting turns into ILLEGAL JSON (each
# physical line gets its own quote pair, raw newlines left between them). So escape newlines to \n and
# wrap once. `awk` (a shell tool, not jq/node — red line 1) reads the whole stream and joins records
# with the two-char sequence backslash-n; ORS="" stops awk re-appending a trailing newline.
json_string() { # $1 text
  printf '%s' "$1" \
    | awk 'BEGIN{ORS=""} { gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); if(NR>1) printf "\\n"; printf "%s",$0 }' \
    | sed 's/^/"/; s/$/"/'
}
# inject_ctx TEXT — emit the UserPromptSubmit additionalContext JSON envelope (a single valid object,
# newline-safe via json_string above).
inject_ctx() {
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":%s}}\n' \
    "$(json_string "$1")"
}

# FRESHNESS_THRESHOLD_SECS — a board touched within this window is treated as "possibly still live"
# (conservative — write-too-loose is safer to bias AGAINST, so the threshold is generous). 10 min.
FRESHNESS_THRESHOLD_SECS=600

# resume_main — the full resume flow: select board → live-safety probe → owner re-stamp → inject.
# selector + HOME_DIR + sid are in scope. Pure bash control flow; per-board reads use the awk helpers.
resume_main() {
  # ── Finding A guard (codex P2): a DEGRADED UserPromptSubmit (no session_id in stdin → $sid empty)
  #    must NEVER touch an EXISTING board. Resume OVERWRITES owner on a selected pre-existing board;
  #    re-stamping owner.session_id="" would (a) erase the original owner and (b) — per the armed gate
  #    (active:true AND owner.session_id==stdin sid) — leave the board DORMANT for every real non-empty
  #    session_id, i.e. "taken over" into permanent silence while the injected context claims success.
  #    The fresh path tolerates an empty sid because it builds a NEW blank board (recoverable); resume
  #    cannot. Refuse up-front — before any board selection or write — leaving every board untouched.
  if [ -z "$sid" ]; then
    inject_ctx "cc-master resume: cannot resume without a session id (degraded hook environment — stdin carried no session_id) — the board was NOT modified. Re-invoke --resume from a session that carries a session_id."
    return 0
  fi
  mkdir -p "$HOME_DIR"
  # ── build the candidate set: ALL *.board.json (active AND archived), excluding boards already owned
  #    by THIS session's sid (fork #4: any board is resumable; only self-owned boards are skipped). ──
  cands=""
  any_board=0
  for b in "$HOME_DIR"/*.board.json; do
    [ -e "$b" ] || continue
    any_board=1
    if [ -n "$sid" ]; then
      bsid="$(owner_field_value "$b" session_id)"
      [ "$bsid" = "$sid" ] && continue          # skip a board this very session already owns
    fi
    cands="$cands$b
"
  done

  # ── zero candidates → nothing to resume ──────────────────────────────────────────────────────────
  if [ "$any_board" -eq 0 ] || [ -z "$cands" ]; then
    inject_ctx "cc-master resume: there is no resumable board in your home (${HOME_DIR}). To start a NEW orchestration, re-run the command WITHOUT --resume and give it a goal."
    return 0
  fi

  # ── selection (design §3 priority): explicit board name/path > timestamp prefix > goal substring ──
  matches=""
  match_count=0
  sel_trim="$selector"
  # strip a trailing --force-takeover / ! token from the selector before matching (it is a directive,
  # not part of the board selector). force is detected separately below.
  force=0
  case " $sel_trim " in
    *" --force-takeover "*) force=1 ;;
  esac
  case "$sel_trim" in
    *!) force=1 ;;
  esac
  # remove the force tokens from the selector string used for matching
  sel_for_match="$(printf '%s' "$sel_trim" | sed -e 's/--force-takeover//g' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$sel_for_match" in
    *!) sel_for_match="${sel_for_match%!}" ;;
  esac
  sel_for_match="$(printf '%s' "$sel_for_match" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

  if [ -n "$sel_for_match" ]; then
    # priority 1+2: explicit board filename / timestamp-prefix — match against the basename.
    while IFS= read -r b; do
      [ -n "$b" ] || continue
      bn="$(basename "$b")"
      case "$bn" in
        "$sel_for_match"|"$sel_for_match".board.json|"$sel_for_match"*) matches="$matches$b
"; match_count=$((match_count+1)) ;;
      esac
    done <<EOF
$cands
EOF
    # priority 3: if no filename/prefix hit, fall to goal substring (case-insensitive LITERAL grep -iF,
    # never spliced into a regex — defends against metachars in the selector, design §3.1).
    if [ "$match_count" -eq 0 ]; then
      matches=""
      while IFS= read -r b; do
        [ -n "$b" ] || continue
        g="$(goal_value "$b")"
        if printf '%s' "$g" | grep -iqF -- "$sel_for_match"; then
          matches="$matches$b
"; match_count=$((match_count+1))
        fi
      done <<EOF
$cands
EOF
    fi
  else
    # empty selector → all candidates are "matches"; if exactly one, it locks; else disambiguate.
    matches="$cands"
    match_count="$(printf '%s' "$cands" | grep -c '.board.json')" || match_count=0
  fi

  # ── ambiguity / missing → NEVER write; inject a disambiguation context (design §3.3) ─────────────
  if [ "$match_count" -eq 0 ]; then
    inject_ctx "cc-master resume: selector '${sel_for_match}' matched no board. $(list_candidates "$cands") Re-send --resume with a more precise selector (a goal substring or the board filename)."
    return 0
  fi
  if [ "$match_count" -gt 1 ]; then
    if [ -z "$sel_for_match" ]; then
      inject_ctx "cc-master resume: your home holds more than one resumable board — pick one. $(list_candidates "$cands") Re-send --resume <selector> with a goal substring or the board filename to choose."
    else
      inject_ctx "cc-master resume: selector '${sel_for_match}' matched more than one board. $(list_candidates "$matches") Re-send --resume with a more precise selector."
    fi
    return 0
  fi

  # ── unique candidate → TARGET locked ─────────────────────────────────────────────────────────────
  TARGET="$(printf '%s' "$matches" | grep -m1 '.board.json')"

  # ── live-safety probe (design §5): is the board possibly still live? heartbeat / mtime freshness ──
  # The freshness gate exists ONLY to protect a possibly-LIVE session from being orphaned. An ARCHIVED
  # board (owner.active:false, just /stop'd) has NO live session — its mtime is fresh precisely because
  # /stop just wrote active:false, so a fresh mtime there is a false "still live" signal. Gate the whole
  # probe on active:true: an archived board skips it and proceeds straight to revive-takeover, no force
  # required (codex Finding 3 — the common "just /stop'd, now --resume to revive" path must not stall).
  target_active="$(owner_field_value "$TARGET" active)"
  fresh=0          # 1 = looks possibly-live (recent activity); 0 = looks abandoned/stale
  signal=0         # 1 = we HAVE a usable freshness signal; 0 = no signal (→ conservative)
  if [ "$target_active" = "true" ]; then
    hb="$(owner_field_value "$TARGET" heartbeat)"
    now="$(date -u +%s)"
    mt="$(board_mtime_epoch "$TARGET")"
    # ── Two freshness channels, treated SYMMETRICALLY (design §5.4: freshness = max(heartbeat 新鲜度,
    #    mtime 新鲜度); signal = 任一通道可定龄). A channel contributes ONLY when it can be DATED to a
    #    NON-FUTURE epoch; a value that cannot be aged contributes NOTHING (not a "present → signal=1").
    # mtime channel: a usable, NON-FUTURE mtime → a signal; within the window → fresh.
    if [ -n "$mt" ] && printf '%s' "$mt" | grep -qE '^[0-9]+$' && [ "$mt" -le "$now" ]; then
      signal=1
      age=$((now - mt))
      [ "$age" -lt "$FRESHNESS_THRESHOLD_SECS" ] && fresh=1
    fi
    # heartbeat channel (Finding B fix): an active session flushes an ISO8601 heartbeat each round, so
    # AGE it — do NOT mis-read mere presence as a signal. Parse to epoch (empty if unparseable/future);
    # a datable, non-future heartbeat is a signal in its own right, and a recent one marks the board
    # possibly-LIVE (→ fresh). An UNPARSEABLE / future heartbeat contributes nothing → with mtime also
    # unusable this lands on the signal==0 conservative "require force" branch (design §5.4 fail-safe),
    # NOT on a silent no-force takeover.
    hb_epoch="$(iso8601_to_epoch "$hb")"
    if [ -n "$hb_epoch" ] && [ "$hb_epoch" -le "$now" ]; then
      signal=1
      hb_age=$((now - hb_epoch))
      [ "$hb_age" -lt "$FRESHNESS_THRESHOLD_SECS" ] && fresh=1
    fi
  fi
  # archived board (active:false) → fresh=0, signal stays at its init; the force==0 block below is a
  # no-op for it (fresh!=1 and we set signal=1 to skip the no-signal branch), so it falls through to
  # the revive-takeover. Make that explicit: an archived board always has "a signal" (it IS abandoned).
  [ "$target_active" = "true" ] || signal=1

  if [ "$force" -eq 0 ]; then
    if [ "$fresh" -eq 1 ]; then
      inject_ctx "cc-master resume: the board ${TARGET} looks like it may still have a LIVE session (recent activity within ${FRESHNESS_THRESHOLD_SECS}s). Taking it over would orphan that session's background work. If you are sure, re-send: --resume ${sel_for_match} --force-takeover"
      return 0
    fi
    if [ "$signal" -eq 0 ]; then
      inject_ctx "cc-master resume: cannot determine whether the board ${TARGET} has a live session (no heartbeat and no usable mtime). Conservatively withholding takeover — if you are sure it is abandoned, re-send: --resume ${sel_for_match} --force-takeover"
      return 0
    fi
  fi

  # ── TAKEOVER: re-stamp owner (only narrow-waist fields). session_id ← new sid; active ← true
  #    (idempotent for abandoned-active, revives archived); heartbeat ← takeover timestamp. ──────────
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tmp="$TARGET.tmp.$$"
  rewrite_owner_field "$TARGET" session_id "$sid" > "$tmp" && mv -f "$tmp" "$TARGET"
  rewrite_owner_field "$TARGET" active true > "$tmp" && mv -f "$tmp" "$TARGET"
  rewrite_owner_field "$TARGET" heartbeat "$ts" > "$tmp" && mv -f "$tmp" "$TARGET"

  inject_ctx "cc-master resume: you have TAKEN OVER the existing orchestration board at ${TARGET}. This is a RESUME, not a fresh start — do NOT re-decompose the goal and do NOT reset tasks[]. Invoke the orchestrating-to-completion skill, then RECONCILE the existing tasks[]: rebuild your mental model from their statuses. Treat every in_flight task as an ORPHAN (its handle died with the prior session) — do not wait on it; run it through endpoint verification (resume-verify content-hash + endpoint check): if its artifact exists and passes, mark it done/verified; otherwise demote it to ready/stale and re-dispatch for a fresh handle. This board is your single source of truth; from now on update owner.heartbeat each time you flush it."
  return 0
}

# list_candidates CANDS — render the candidate boards in TWO groups (active-but-abandoned / archived),
# each line "<basename> [goal]". Pure bash; used inside disambiguation context strings.
list_candidates() { # $1 newline-separated candidate board paths
  act=""; arc=""
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    bn="$(basename "$b")"
    g="$(goal_value "$b")"
    a="$(owner_field_value "$b" active)"
    line="${bn} [${g}]"
    if [ "$a" = "true" ]; then act="${act}    ${line}
"; else arc="${arc}    ${line}
"; fi
  done <<EOF
$1
EOF
  outp="Candidates:"
  [ -n "$act" ] && outp="${outp}
  active-but-abandoned:
${act}"
  [ -n "$arc" ] && outp="${outp}
  archived (will be revived):
${arc}"
  printf '%s' "$outp"
}

# Extract the value of the top-level "prompt" string field. Grab everything after `"prompt":"` up to
# the next unescaped double-quote. This is a best-effort extraction sufficient to test a prefix; if
# no prompt field is present, `prompt` stays empty and the prefix test simply fails.
prompt="${stdin#*\"prompt\":\"}"          # drop everything up to & including  "prompt":"
[ "$prompt" = "$stdin" ] && prompt=""     # no "prompt": field at all → empty
prompt="${prompt%%\"*}"                    # drop from the first " onward → the raw field value
trimmed="${prompt#"${prompt%%[![:space:]]*}"}"   # strip leading whitespace

# Expanded-body backup: unescape \n in the prompt field value, take the first non-empty line, and
# require the bootstrap marker to live ON that line. A mid-prose mention (marker quoted inside a
# sentence) leaves a non-marker first line and does not qualify (Finding #16).
first_line="$(printf '%s' "$prompt" | sed -e 's/\\n/\n/g' | grep -m1 -v '^[[:space:]]*$')"
first_line="${first_line#"${first_line%%[![:space:]]*}"}"   # strip leading whitespace
first_line="${first_line%"${first_line##*[![:space:]]}"}"   # strip trailing whitespace
marker_hit=0
case "$first_line" in
  '<!-- cc-master:bootstrap:v1 -->') marker_hit=1 ;;        # STANDALONE first line only — an inline
                                                            # mention on the first line is NOT enough
                                                            # (codex self-review catch, Finding #16)
esac

case "$trimmed" in
  /cc-master:as-master-orchestrator*) : ;;        # raw command: name is the prompt PREFIX
  *)
    [ "$marker_hit" -eq 1 ] || exit 0 ;;          # not the marker first-line → silent no-op
esac

# Home is configurable (storage preference); default to the project's .claude/cc-master.
HOME_DIR="${CC_MASTER_HOME:-${CLAUDE_PROJECT_DIR:-$(pwd)}/.claude/cc-master}"

# ── INTENT PARSE (resume vs fresh) — runs ONLY AFTER the trigger gate above already passed ──────────
# This is a SECOND demux INSIDE an already-triggered prompt; it does NOT participate in triggering
# (the sentinel/prefix gate is untouched). Detect whether the FIRST token after the command prefix is
# `--resume`. If so → mode=resume + selector (the remaining arg string, possibly empty). Otherwise →
# mode=fresh, the original byte-unchanged path. A `--resume` appearing mid-goal (not the first token)
# stays fresh (Finding-style false-trigger avoidance). → design §1.1/§2.1.
mode=fresh
selector=""
# raw-command path: strip the prefix, ltrim, then test the leading token.
rest="${trimmed#/cc-master:as-master-orchestrator}"
rest="${rest#"${rest%%[![:space:]]*}"}"          # ltrim the arg string
case "$rest" in
  --resume|--resume\ *)
    mode=resume
    selector="${rest#--resume}"
    selector="${selector#"${selector%%[![:space:]]*}"}" ;;   # remaining = selector (may be empty)
esac
# body-sentinel path: the expanded command body cannot conditionally render on $ARGUMENTS (it is
# static markdown), so it UNCONDITIONALLY carries a machine-readable args line right after the
# sentinel: `<!-- cc-master:args: <raw $ARGUMENTS> -->`. When we triggered via the marker (not the raw
# prefix), recover the original args from THAT line and run them through the SAME --resume first-token
# demux as the raw-command path — so fresh/resume routing is identical on both paths (design §2.2;
# codex Finding 2: the old `cc-master:resume` line was never rendered, so --resume fell through to a
# spurious fresh board). The args line must be the SECOND machine-readable line (an HTML comment),
# matched standalone like the sentinel (Finding #16 discipline) — a mid-prose `cc-master:args:`
# mention won't false-route because we anchor on the line and strip the comment wrapper.
if [ "$mode" = "fresh" ] && [ "$marker_hit" -eq 1 ]; then
  args_line="$(printf '%s' "$prompt" | sed -e 's/\\n/\n/g' | grep -m1 -E '^[[:space:]]*<!--[[:space:]]*cc-master:args:' || true)"
  if [ -n "$args_line" ]; then
    # strip the `<!-- cc-master:args:` opener and the trailing ` -->`, then trim → the raw $ARGUMENTS.
    body_args="$(printf '%s' "$args_line" \
      | sed -e 's/^[[:space:]]*<!--[[:space:]]*cc-master:args://' -e 's/[[:space:]]*-->[[:space:]]*$//' \
            -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    case "$body_args" in
      --resume|--resume\ *)
        mode=resume
        selector="${body_args#--resume}"
        selector="${selector#"${selector%%[![:space:]]*}"}" ;;   # remaining = selector (may be empty)
    esac
  fi
fi

if [ "$mode" = "resume" ]; then
  # Delegate the whole resume flow (select → live-safety probe → owner re-stamp → inject context).
  # Keep the fresh path below BYTE-UNCHANGED (zero regression, design §1.1).
  resume_main
  exit 0
fi

# ── A2 T6: --num_account is GONE ─────────────────────────────────────────────────────────────────────
# The FRESH-path `--num_account <n>` flag is REMOVED (A2 account-management refactor §C-T6). pacing's
# effective-N is no longer user-supplied per session via a CLI flag → board top-level num_account; it is
# now DERIVED by usage-pacing.js from the account pool registry (accounts.json: count of non-active,
# token-unexpired switchable backups + 1). No registry = a natural single account (effective-N 1), so
# there is nothing to parse or stamp here anymore. The board TEMPLATE still ships `"num_account": 1` as a
# harmless backward-compat default (an OLD board that already carries num_account is NOT an error — it is
# simply no longer read by the hook), so no template change is required; we just stop WRITING it from a
# CLI arg. → design_docs/plans/2026-06-17-A2-account-management-design.md §C-T6 / §F.

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
TEMPLATE="$PLUGIN_ROOT/skills/orchestrating-to-completion/assets/board.template.json"

mkdir -p "$HOME_DIR"
# Unique, time-sortable name: a UTC timestamp prefix + the pid keeps concurrent bootstraps
# distinct (the human-readable identity lives in the board's "goal" field). Each invocation
# starts a NEW orchestration; archive stale ones with /cc-master:stop.
BOARD="$HOME_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$$.board.json"
# Escape the sid for safe inclusion in the JSON string value (backslash + double-quote only; a
# session id is otherwise printable). Empty sid → stamps "" — an ANOMALY (normal bootstrap stdin
# carries a sid): such a blank board stays DORMANT for every non-empty stdin sid (it is NOT
# auto-adopted — red line 6 / ADR-007 §2.3; hooks degrade to any-active ONLY when THEIR OWN stdin
# sid is empty). Claim it by re-running as-master-orchestrator (re-arm re-stamps owner.session_id).
# Keep this pure bash (no jq) — ship-anywhere.
sid_esc="$(printf '%s' "$sid" | sed 's/\\/\\\\/g; s/"/\\"/g')"
if [ -f "$TEMPLATE" ]; then
  cp "$TEMPLATE" "$BOARD"
  # Stamp owner.session_id with the creating session's id (the ARM identity). The template ships the
  # field as `"session_id": ""`; replace ONLY that empty owner field. A literal-anchored sed on the
  # empty value keeps the substitution from ever touching a non-empty value (none exists in a fresh
  # template, but this stays safe if the template gains other session_id-shaped fields later).
  tmp="$BOARD.tmp.$$"
  sed "s/\"session_id\"[[:space:]]*:[[:space:]]*\"\"/\"session_id\": \"$sid_esc\"/" "$BOARD" > "$tmp" && mv -f "$tmp" "$BOARD"
  # A2 T6: num_account is NO LONGER stamped from a CLI arg (--num_account is gone; pacing's effective-N is
  # derived from the accounts.json pool registry by usage-pacing.js). The template still ships the
  # harmless backward-compat default `"num_account": 1`; we leave it untouched (the hook no longer reads it).
else
  # Template-missing fallback: build the board inline, stamping the real sid into owner.session_id
  # (was a hardcoded empty "" before — that left every bootstrapped board unowned). Seed the
  # agent-shaped meta.template_version too, in parity with board.template.json — it is NOT the hook-read
  # narrow waist `schema` (red line 2): no hook reads it; it lets the timeline gate its real-time axis on
  # this-release-or-later boards. Pure bash printf only — no jq/python/node (red line 1). A2 T6: no
  # num_account field is seeded here — usage-pacing.js no longer reads it (effective-N now comes from
  # accounts.json); an OLD board still carrying it is harmless, it is simply ignored.
  printf '{"schema":"cc-master/v1","meta":{"template_version":1},"goal":"","owner":{"active":true,"session_id":"%s","heartbeat":""},"git":{"worktree":"","branch":""},"wip_limit":4,"tasks":[],"log":[]}\n' "$sid_esc" > "$BOARD"
fi

ctx="cc-master: a fresh orchestration board was created at ${BOARD}. You are now the master orchestrator for this task — remember that path, it is YOUR board. Decompose the goal into a dependency DAG and write tasks[] into that board file, set goal/owner/git, then invoke the orchestrating-to-completion skill and run the decision program."
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":%s}}\n' "$(printf '%s' "$ctx" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')"
exit 0
