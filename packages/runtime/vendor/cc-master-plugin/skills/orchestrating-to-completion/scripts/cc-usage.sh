#!/usr/bin/env bash
# cc-usage.sh — out-of-band 5h/7d usage signal for the orchestrator (NOT a hook).
#
# Ship-anywhere: the system python3 (3.9-compatible) parses local Claude Code JSONL
# (~/.claude/projects/**/*.jsonl, the assistant.message.usage records) and computes the
# current 5h rolling block + the 7d total. Zero network, zero extra deps — and it ALWAYS
# emits the normalized schema below (no external tool whose output shape we don't control).
#
# Out-of-band like codex-review / eval: this is a script the orchestrator's MAIN THREAD
# runs deliberately at a pacing decision point. It is NOT a hook — it does NOT live in
# hooks/ and is NOT bound by red line 1 (pure-bash). It informs usage-aware pacing
# (see skills/orchestrating-to-completion/references/cost-and-pacing.md).
#
# Scope note (honest): context %used (`used_percentage` / `rate_limits.*.used_percentage`)
# lives ONLY in the status-line stdin JSON, not in the JSONL — this script does NOT emit
# it. It emits 5h/7d token usage + a 5h burn rate, which is what a long-horizon
# orchestrator needs to pace against a rolling quota window.
#
# Usage: cc-usage.sh [--dir <jsonl-root>] [--now <ISO8601>]
#   --dir  JSONL root (default ~/.claude/projects) — also lets tests point at a fixture.
#   --now  override "now" with an ISO-8601 instant — makes the rolling window deterministic.
#
# Output (JSON, one line):
#   {"five_hour":{"used_tokens":N,"window_remaining_min":M,"burn_rate_per_min":R},
#    "seven_day":{"used_tokens":N}}
set -uo pipefail

DIR="${HOME}/.claude/projects"; NOW=""
RATE_CACHE="${CC_MASTER_RATE_CACHE:-${HOME}/.claude/.cc-master-rate-limits.json}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2;;
    --now) NOW="$2"; shift 2;;
    --rate-cache) RATE_CACHE="$2"; shift 2;;
    *)     shift;;
  esac
done

# Pure-python parse only — always emits the normalized schema below. (A `ccusage` accelerator
# was intentionally dropped: its raw `blocks --json` shape differs from ours, so piping it
# through verbatim would break any caller parsing the documented schema. A future accelerator
# MUST first normalize ccusage output into THIS schema; until then, zero external-tool dep.)
DIR="$DIR" NOW="$NOW" RATE_CACHE="$RATE_CACHE" python3 - <<'PY'
import os, json, glob, datetime as dt

root = os.environ["DIR"]
now_s = os.environ.get("NOW", "")
now = (dt.datetime.fromisoformat(now_s.replace("Z", "+00:00"))
       if now_s else dt.datetime.now(dt.timezone.utc))

# Dedup tool-iteration rewrites by message.id, keeping the LARGEST usage total per id: a
# rewritten assistant record carries the more-complete (cumulative) usage, so first-seen
# would underreport and make pacing think more quota is left than there actually is.
by_id = {}  # mid -> (ts, total_tokens)
for f in glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True):
    try:
        for line in open(f, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("type") != "assistant":
                continue
            msg = o.get("message") or {}
            u = msg.get("usage")
            mid = msg.get("id")
            if not u or not mid:
                continue
            tok = (u.get("input_tokens", 0) + u.get("output_tokens", 0)
                   + u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0))
            try:
                ts = dt.datetime.fromisoformat(o["timestamp"].replace("Z", "+00:00"))
            except Exception:
                continue
            prev = by_id.get(mid)
            if prev is None or tok > prev[1]:
                by_id[mid] = (ts, tok)
    except Exception:
        continue

# --now is the time anchor: drop rows newer than it so a deterministic / historical evaluation
# never counts usage that hadn't happened yet (no future block can become blocks[-1]).
rows = [r for r in by_id.values() if r[0] <= now]
rows.sort(key=lambda r: r[0])

# 5h rolling block (ccusage口径): a new block starts when the gap to the previous msg exceeds
# 5h (idle) OR when the running block has already spanned a full 5h from its FIRST msg
# (continuous use crossing the boundary — otherwise sustained usage past 5h would wrongly
# report 0). The active block is then the one that still contains now.
five = dt.timedelta(hours=5)
blocks, cur = [], []
for ts, tok in rows:
    if cur and (ts - cur[-1][0] > five or ts - cur[0][0] >= five):
        blocks.append(cur); cur = []
    cur.append((ts, tok))
if cur:
    blocks.append(cur)

# Only the block that still CONTAINS now is the active window. If the most recent activity is
# >5h old, that block already closed (the quota window refreshed) — report a clean zero, never
# a stale used_tokens nor a negative window_remaining_min.
fh = {"used_tokens": 0, "window_remaining_min": 0, "burn_rate_per_min": 0}
if blocks:
    b = blocks[-1]
    start = b[0][0]
    if now <= start + five:
        used = sum(t for _, t in b)
        elapsed_min = max((now - start).total_seconds() / 60, 1)
        fh = {
            "used_tokens": used,
            "window_remaining_min": round(((start + five) - now).total_seconds() / 60),
            "burn_rate_per_min": round(used / elapsed_min),
        }

wk = sum(tok for ts, tok in rows if now - ts <= dt.timedelta(days=7))

# account-authoritative override (Finding #37): 订阅账户的权威 5h/7d used_percentage + resets_at 只在
# status-line stdin 出现(JSONL 里没有),由 statusline-capture.js 落到 sidecar。若 sidecar 存在且 5h 窗口
# 仍有效(resets_at 在未来),用它当权威口径(source:"account");否则诚实退回本地反推(source:"local-derived-
# approx")——绝不让一个看似精确的反推值冒充权威(Finding #37 的核心:反推 reset 倒计时可失真到数量级)。
cache = os.environ.get("RATE_CACHE", "")
acct = None
if cache:
    try:
        acct = json.load(open(cache, encoding="utf-8"))
    except Exception:
        acct = None  # 缺/坏 sidecar → 当作没有 → fallback

now_ep = now.timestamp()
source = "local-derived-approx"
out_fh = fh
out_wk = {"used_tokens": wk}

a5 = acct.get("five_hour") if isinstance(acct, dict) else None
# account 模式仅当 5h reset 在未来(窗口仍有效);resets_at<=now 说明 sidecar 跨过了 reset、已 stale → fallback。
if isinstance(a5, dict) and isinstance(a5.get("resets_at"), (int, float)) and a5["resets_at"] > now_ep:
    source = "account"
    out_fh = {
        "used_percentage": a5.get("used_percentage"),       # 权威
        "resets_at": a5["resets_at"],                       # 权威
        "window_remaining_min": round((a5["resets_at"] - now_ep) / 60),  # 从权威 resets_at 算,非反推
        "used_tokens": fh["used_tokens"],                   # 本地补充(账户不给绝对 token,但 burn 预测要)
        "burn_rate_per_min": fh["burn_rate_per_min"],
    }
    a7 = acct.get("seven_day")
    if isinstance(a7, dict):
        out_wk = {"used_percentage": a7.get("used_percentage"), "used_tokens": wk}
        if isinstance(a7.get("resets_at"), (int, float)):
            out_wk["resets_at"] = a7["resets_at"]

print(json.dumps({"source": source, "five_hour": out_fh, "seven_day": out_wk}))
PY
