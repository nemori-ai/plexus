#!/usr/bin/env bash
# account-list.sh — out-of-band「列号池对账」wrapper（NOT a hook）。
#
# A2 account-management skill 的只读对账侧：列号池里每个 email 的非密信息——
#   vault 形态（keychain/file）· token 到期日 · active（当前在用号）· 最近一次切出时间 · token 是否已过期。
# 纯只读：读 accounts.json registry 的非密字段 + （可选）keychain `find`（**绝不带 -w**，只确认项在不在、不取值）。
#
# ───────────────────────────── 命门：绝不取 / 绝不打印 token 值（HARD）─────────────────────────────
# 本脚本**永不读 token 值**——更强：file-vault 的密 blob **绝不进本脚本的 node 渲染进程**（codex §7 P2）：
#   · registry 本就零 token（只有 vault 引用 + 时间元信息），读它无害。
#   · keychain 探活用 `security find-generic-password -a <email> -s <service>` **不带 `-w`**——
#     带 -w 才打印密码值；不带 -w 只回项的元信息（确认在不在）。本脚本严格不带 -w。
#   · file vault 的「<email>_TOKEN= 行存在**且非空**」这个**布尔**判定，在 **bash 层 token-blind 预计算**——
#     用 `awk -v p=<tokenLine> 'index($0,p)==1 ...'`（行首锚定·定字符串前缀·对 `.`/`@` 元字符免疫，前缀由
#     accounts-lib.fileVaultLineMatch 给，**绝不手拼正则**）只产出 `1`/`0` 哨兵：blob（`$0`）虽过 awk buffer，
#     但**只有哨兵进 stdout**——blob 绝不落进任何被捕获的 shell 变量、绝不 echo/log。这个**非密布尔**喂给 node 渲染。
#     → 对标 keychain：keychain 探活用 `security find …`（**不带 -w**）只确认项在不在、绝不取值；file 形态等价做到
#       「只回布尔、blob 不进诊断进程」。**node 渲染进程绝不再 readFileSync vault、绝不碰任何 blob**（P2 修复前它把
#       整个 accounts.env 所有号的密 blob 读进 node 内存——本修复彻底消除该暴露面）。
# stdout 全程只有非密对账表，绝不含任何 token。set +x / unset SHELLOPTS 加固。
#
# ───────────────────────── 落点纪律（红线 1/5）─────────────────────────
# out-of-band 脚本，**绝不进 hooks/**；调 `node`（读 registry）/ 可选 `security`（探活，云后端 no-op）。

# ───────────────────────── 安全开头（HARD）─────────────────────────
set +x
unset SHELLOPTS 2>/dev/null || true

# ───────────────────────── 云后端自检（红线 5，no-op 退出）─────────────────────────
if [ -n "${CLAUDE_CODE_USE_BEDROCK:-}" ] || [ -n "${CLAUDE_CODE_USE_VERTEX:-}" ] || [ -n "${CLAUDE_CODE_USE_FOUNDRY:-}" ]; then
  printf '%s\n' "account-list: 云后端（Bedrock/Vertex/Foundry）无订阅 OAuth 号池 —— 列号不适用，no-op 退出。" >&2
  exit 0
fi

set -uo pipefail

# ───────────────────────── 路径自解析（self-contain）─────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
LIB_JS="${CLAUDE_SKILL_DIR:-$SCRIPT_DIR/..}/scripts/accounts-lib.js"
[ -f "$LIB_JS" ] || LIB_JS="$SCRIPT_DIR/accounts-lib.js"

err()  { printf '%s\n' "$*" >&2; }
info() { printf '%s\n' "$*"; }

usage() {
  err "usage: account-list.sh [--probe-keychain] [--registry <path>]"
  err ""
  err "  只读列号池：email · vault 形态 · 到期日 · active · 最近切出 · 是否过期。绝不取/打印 token 值。"
  err "  --probe-keychain：额外用 security find（不带 -w）确认 keychain 项是否真在（只验存在性，不取值）。"
}

# ───────────────────────── arg 解析 ─────────────────────────
PROBE_KEYCHAIN=0
REGISTRY_PATH=""
# value 型 flag 缺值守卫（robustness·codex §7 P2-a·防死循环）：value 型 flag 缺第二个 arg 时 `shift 2` 失败、
#   arg list 不变 → `while [ $# -gt 0 ]` 死循环到被 kill（脚本无 set -e）。故 `shift 2` 前确认存在第二个 arg。
need_val() { [ "$#" -ge 2 ] || { err "error: option '$1' requires a value."; usage; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --probe-keychain) PROBE_KEYCHAIN=1; shift;;
    --registry)       need_val "$@"; REGISTRY_PATH="$2"; shift 2;;
    -h|--help)        usage; exit 0;;
    *) err "unknown arg: $1"; usage; exit 2;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  err "error: 'node' not found in PATH — 无法读 accounts.json registry。"
  exit 1
fi

# ───────────────────────── 主体：node 读 registry 非密字段 → 输出对账行（TSV，bash 再排版）─────────────────────────
# node 输出每号一行 TSV：ROW \t email \t vault_kind \t expires \t active \t switchable \t token_state \t last_switch_out_at \t vault_locator \t file_vault_path
#   全字段非密（vault_locator = keychain service / file path，是「token 在哪」的指针不是值）。绝不输出 token。
#   **node 绝不 readFileSync vault、绝不碰任何 blob（codex §7 P2·token-blind）**：file-vault 号的 token_state 由 node 置
#   `PROBE-FILE` 占位，交由下游 **bash 层 token-blind awk 探测**（见「file-vault token 存在性 bash 预计算」）resolve 成
#   ok/EXPIRED/no-token——密 blob 绝不进 node 渲染进程。file_vault_path = file 形态的 vault 路径（非密指针·供 bash awk
#   探测），非 file 形态留空。
#   switchable=no（显式 switchable:false·残缺号无 vault token）时 token_state=no-token，绝不呈现成健康 ok（这条与 vault
#   形态无关，故仍由 node 直接定，不下放 bash）。
#   过期判定用 ISO 字典序（定宽 + Z → 字典序==时间序，纯字符串比较，与 lib ISO_UTC_RE 对齐）。
# 顶行另输出 meta：账号数 / registry 路径 / registry 是否存在。
rows="$(node -e '
  "use strict";
  const lib = require(process.argv[1]);
  const fs = require("fs");
  const regPath = process.argv[2] || lib.defaultRegistryPath();
  const exists = fs.existsSync(regPath);
  let reg;
  try { reg = lib.loadRegistry(regPath); }
  catch (e) { process.stdout.write("ERR\t" + (e && e.message || e) + "\n"); process.exit(0); }
  const accounts = reg.accounts || {};
  const emails = Object.keys(accounts);
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/,"Z");
  // meta 行：META \t count \t regPath \t exists
  process.stdout.write("META\t" + emails.length + "\t" + regPath + "\t" + (exists ? "1" : "0") + "\n");
  for (const email of emails) {
    const e = accounts[email] || {};
    const v = e.vault || {};
    const kind = v.kind || "?";
    const locator = kind === "keychain" ? (v.service || "") : (v.path || "");
    const expires = e.token_expires_at || "";
    const active = e.active === true ? "yes" : "no";
    // switchable：非密 boolean（缺省/null 视作可切；只有显式 false 才是不可切——fallback/手动录入残缺号·
    //   vault 尚无 token）。选号/pacing 排除 switchable:false；list 必须把它显式标成「不可切·无 token」，
    //   绝不按 token_expires_at 把一个无 token 的残缺号呈现成健康 ok（否则 --list 这个恢复 UI 会骗用户）。
    const switchable = e.switchable === false ? "no" : "yes";
    // TOKEN 列（token_state）：先看 switchable——不可切（无 vault token）一律标 no-token，绝不显示 ok/EXPIRED（它没有
    //   token 可言、token_expires_at 是占位）。
    //   **file 形态的 token 存在性绝不在此读 vault（codex §7 P2·token-blind）**：node 不再 readFileSync vault、不碰任何
    //   blob——改置 PROBE-FILE 占位，下游 bash 层用 awk index($0,p)==1（行首锚定·定字符串前缀·blob 只过 awk buffer、
    //   只回布尔哨兵）token-blind 探测后 resolve（含「行在且非空 → 按 expires 判 ok/EXPIRED」「行缺/空值 → no-token」）。
    //   keychain / 其它可切形态：node 直接按 token_expires_at 严格 ISO 字典序判过期（< now 即过期）。
    let tokenState = "?";
    if (switchable === "no") {
      tokenState = "no-token";
    } else if (kind === "file") {
      tokenState = "PROBE-FILE";       // ← 占位：交 bash 层 token-blind awk 探测 resolve（node 绝不碰 blob）。
    } else if (expires && lib.ISO_UTC_RE.test(expires)) {
      tokenState = (expires < nowIso) ? "EXPIRED" : "ok";
    }
    const lso = (e.last_switch_out && e.last_switch_out.at) ? e.last_switch_out.at : "-";
    // file_vault_path：file 形态给 vault 路径（非密指针·供 bash awk 探测）；非 file 留空。
    const fileVaultPath = kind === "file" ? (v.path || "") : "";
    // 字段间绝无 token；TAB 分隔，email/locator/path 不含 TAB（email/路径不会有 TAB）。
    process.stdout.write([ "ROW", email, kind, expires||"-", active, switchable, tokenState, lso, locator, fileVaultPath ].join("\t") + "\n");
  }
' "$LIB_JS" "$REGISTRY_PATH" 2>&1)" || { err "error: 读 registry 失败。"; exit 1; }

# ── node 报硬错（坏 JSON 等）→ fail-safe 降级（codex round#2·与 select-account.js 优雅降级一致）──
#   契约（SKILL「缺失/坏 JSON 一律 fail-safe 降级单账号，绝不崩」）：list 是诊断/恢复 UI——registry 坏掉时**正是
#   最需要它能跑**的时候。旧码坏 JSON 直接 exit 1 让 list 在此刻不可用、且与 select-account.js 的「坏 registry →
#   降级空池·不崩」不一致。修：坏 JSON 当**空池**处理（warn 提示坏 + 怎么修），照常打印「号池为空」骨架、exit 0。
if printf '%s' "$rows" | head -1 | grep -q '^ERR	'; then
  reason="$(printf '%s' "$rows" | head -1 | sed 's/^ERR	//')"
  err "注意：accounts.json 读取失败（坏 JSON？）：$reason"
  err "  → 降级按**空号池**显示（天然单账号）。修复：人工修正该 JSON，或删除该文件（删除 = 干净降级回天然单账号空池）。"
  info "── cc-master 号池（accounts.json） ──"
  info "registry : $(node -e 'process.stdout.write(require(process.argv[1]).defaultRegistryPath())' "$LIB_JS" 2>/dev/null || echo '<accounts.json>')  (坏 JSON → 降级空池)"
  info "号池为空 / 不可读（0 个可列号）。修好 accounts.json 或删除它后重试；用 account-add.sh --email <email> 重录备号。"
  exit 0
fi

# ── meta 行 ──
meta_line="$(printf '%s' "$rows" | grep -m1 '^META	')"
count="$(printf '%s' "$meta_line" | cut -f2)"
reg_path="$(printf '%s' "$meta_line" | cut -f3)"
reg_exists="$(printf '%s' "$meta_line" | cut -f4)"

info "── cc-master 号池（accounts.json） ──"
info "registry : $reg_path$([ "$reg_exists" = "0" ] && echo "  (不存在 = 天然单账号空池)")"
if [ "${count:-0}" -eq 0 ]; then
  info "号池为空（0 个号）。用 account-add.sh --email <email> 录第一个备号。"
  exit 0
fi
info "共 $count 个号："
info ""
# 表头（定宽，便于人读；email 可能较长，留 28 列）。SWITCHABLE 列显式呈现号是否可无重启切入。
printf '  %-28s %-9s %-22s %-7s %-12s %-9s %-22s %s\n' "EMAIL" "VAULT" "EXPIRES" "ACTIVE" "SWITCHABLE" "TOKEN" "LAST-SWITCH-OUT" "VAULT-LOCATOR"

# ───────────── file-vault token 存在性 bash 预计算（token-blind·codex §7 P2）─────────────
# node 对 file 形态置 token_state=PROBE-FILE（绝不读 vault）。这里在 bash 层 token-blind 探测
# 「<email>_TOKEN= 行存在**且**等号后非空」这个**布尔**，再 resolve 成 ok/EXPIRED/no-token。
#
# token-blind 三道防护（密 blob 绝不进诊断进程的任何被捕获处）：
#   ① 前缀绝不手拼正则：用 accounts-lib.fileVaultLineMatch(email).tokenLine（`<email>_TOKEN=`）当 awk 定字符串前缀，
#      对 email 的 . / @ 元字符天然免疫（§A.4 元字符 bug：裸 `^email_TOKEN=` 下 `.` 匹配任意字符会取错号）。
#   ② awk 只回布尔哨兵：`index($0,p)==1`（行首锚定·定字符串）选「以前缀**起头**」的行，`length($0)>length(p)`（等号后
#      非空）才 `print "1"; exit`——**只有哨兵 1 进 stdout，整行 blob（$0）虽过 awk buffer 却绝不进 stdout / 绝不落任何
#      shell 变量 / 绝不 echo**。这正是 keychain `security find`（不带 -w·只回存在性）的 file 形态等价。
#   ③ node 渲染进程已彻底不碰 vault（不 readFileSync·见上 node 块）——blob 暴露面从「整个 accounts.env 所有号的密 blob
#      读进 node 内存」收敛为零。
# 不存在 vault 文件 / 行缺 / 等号后空 → 哨兵为空（视作 no-token·如实·不冒充 ok）。语义对齐 codex round#7/#8 Finding B。
file_token_present() {       # $1=file_vault_path $2=email → echo "1"（存在且非空）/ ""（缺/空/读不到）
  local vpath="$1" eml="$2" prefix=""
  [ -n "$vpath" ] && [ -f "$vpath" ] || return 0   # 文件不存在 → 空输出（no-token·如实）
  # tokenLine 前缀经 accounts-lib（绝不在 bash 手拼正则·§A.4）。node 失败 → 前缀空 → 当 no-token（不冒充 ok）。
  prefix="$(node -e 'const{fileVaultLineMatch}=require(process.argv[1]);process.stdout.write(fileVaultLineMatch(process.argv[2]).tokenLine)' "$LIB_JS" "$eml" 2>/dev/null)" || prefix=""
  [ -n "$prefix" ] || return 0
  # awk 行首锚定·定字符串前缀；仅当匹配行等号后非空才印哨兵 1。blob（$0）只过 awk buffer、绝不进 stdout / 变量。
  awk -v p="$prefix" 'index($0,p)==1 && length($0)>length(p) { print "1"; exit }' "$vpath" 2>/dev/null
}

# ── 逐 ROW 排版 + 可选 keychain 探活 + file-vault token-blind resolve ──
while IFS=$'\t' read -r tag email kind expires active switchable expired lso locator file_vault_path; do
  [ "$tag" = "ROW" ] || continue
  # file 形态的 PROBE-FILE 占位 → bash token-blind 探测 resolve（密 blob 绝不进任何变量）。
  if [ "$expired" = "PROBE-FILE" ]; then
    if [ -n "$(file_token_present "$file_vault_path" "$email")" ]; then
      # 行存在且非空 → 按 expires 判过期（与 node keychain 分支同口径）。
      #   **无到期记录（expires='-'）或算不出 now → '?'（不可比·与 keychain 行 / footer 同口径·codex §7 P3）**，
      #   绝不把无到期元信息的老/手动 file 号冒充成健康 ok。仅当有合法 ISO 才严格字典序比（< now = EXPIRED·否则 ok）。
      now_iso="$(node -e 'process.stdout.write(new Date().toISOString().replace(/\.\d{3}Z$/,"Z"))' 2>/dev/null || echo '')"
      if [ "$expires" = "-" ] || [ -z "$now_iso" ]; then
        expired="?"
      elif [ "$expires" \< "$now_iso" ]; then
        expired="EXPIRED"
      else
        expired="ok"
      fi
    else
      expired="no-token"   # 行缺 / 等号后空 / vault 文件读不到 → 如实 no-token（不冒充健康 ok·round#7/#8 Finding B）。
    fi
  fi
  probe=""
  if [ "$PROBE_KEYCHAIN" -eq 1 ] && [ "$kind" = "keychain" ] && command -v security >/dev/null 2>&1; then
    # 探活：不带 -w（只确认项在不在，绝不取 token 值）。
    if security find-generic-password -a "$email" -s "$locator" >/dev/null 2>&1; then
      probe=" [keychain✓]"
    else
      probe=" [keychain✗缺]"
    fi
  fi
  # SWITCHABLE 列：yes=可无重启切入 / no=不可切（残缺号·vault 尚无 token·需补录）。
  # TOKEN 列只显示存在性/过期状态（ok/EXPIRED/no-token/?），绝不显示 token 值。
  #   no-token = switchable:false 的残缺号（vault 无 token，token_expires_at 仅占位），绝不冒充健康 ok。
  sw_disp="$switchable"
  [ "$switchable" = "no" ] && sw_disp="no(补录)"
  printf '  %-28s %-9s %-22s %-7s %-12s %-9s %-22s %s%s\n' \
    "$email" "$kind" "$expires" "$active" "$sw_disp" "$expired" "$lso" "$locator" "$probe"
done < <(printf '%s\n' "$rows")

info ""
info "（SWITCHABLE：yes=可无重启切入 / no(补录)=残缺号 vault 尚无 token·需手动补录。）"
info "（TOKEN 列只示存在性/过期：ok=未过期 / EXPIRED=已过期 / no-token=无 vault token(不可切) / ?=无到期记录。绝不取 token 值。）"
exit 0
