#!/usr/bin/env bash
# account-add.sh — out-of-band「一条命令把当前登录号的完整 OAuth blob 录进 vault + 写一条 registry entry」wrapper（NOT a hook）。
#
# A2 形态：这是 account-management skill 的录号写侧。agent 用 Bash **直接跑**它 → 它**直读 macOS keychain
#   「Claude Code-credentials」(account=$USER) 的完整 claudeAiOauth blob（含 refreshToken·非空）** →
#   严格校验三必需字段 → 存进 vault（keychain 或 0600 文件）→ **写一条 accounts.json registry entry
#   （email→vault 引用 + 时间元信息 + 非密 subscription_type + identity 身份对象）**。
# vault 形态与 switch-account.sh 严格对齐——switch 在配额逼顶换号时**读**这个 vault 取完整 blob 做**无重启换号**
#   （覆写官方共享凭证三存储），本脚本是它的**写**侧之一。
#
# ★为什么直读 keychain（不再用 `claude setup-token`）——dogfood + spike 实证（已端点验过）：
#   · `claude setup-token` 是**坏的**录号源：它重认证、覆写官方登录（把用户登出·401），且**结构上不产生
#     refreshToken**（它铸的是长寿命 headless token、非 /login OAuth）。无重启换号死依赖 refreshToken。
#   · spike（token-blind 只看字段名/布尔）实测：
#       - `~/.claude/.credentials.json` 文件里 claudeAiOauth.refreshToken **字段在但值为空**（残缺副本）。
#       - keychain `security find-generic-password -w -s "Claude Code-credentials" -a "$USER"` 返回的 blob
#         是 `{claudeAiOauth:{accessToken(sk-ant-oat),refreshToken(sk-ant-ort·非空),expiresAt,scopes,
#         subscriptionType,rateLimitTier}}` —— **完整 + 有效 refreshToken**。
#   · 结论：**捕获源 = keychain「Claude Code-credentials」(account=$USER)**——不是文件、不是 setup-token。
#     直读**不扰动登录**（只读不写官方凭证）→ 无需快照/恢复当前登录（旧 setup-token 副作用整套 moot）。
#
# ★无重启换号关键：vault 存的是**完整 claudeAiOauth blob 单行 JSON**
#   `{accessToken,refreshToken,expiresAt,scopes,subscriptionType}`——不是一段裸 access token。完整 blob 含
#   refreshToken（switch 主动续期必需）。keychain 直读拿到的就是这个完整 blob。
#   非 mac / 无 keychain → fallback 读 `~/.claude/.credentials.json` 的 .claudeAiOauth（但它 refreshToken
#   可能空·校验会拦下并给清楚提示）。
#
# ───────────────────────────── 命门：token 永不经过 agent（HARD，逐条不可破）─────────────────────────────
# OAuth token 是 bearer secret（possession-equals-access）。agent 跑本脚本，但 token 全程只活在脚本
# 子进程/管道里、绝不进 agent context / transcript / registry：
#   · keychain 读出的 blob **全程在子进程/管道**——`security … -w | node …`，**绝不 echo / 绝不 print /
#     绝不进 argv / 绝不写任何 log / 绝不进 board / 绝不进 registry**（accounts.json 只写 vault 非密引用）。
#   · keychain 写入把 blob 作 `security … -w "$blob"` 的 argv 参数（**必须** argv 而非 stdin 喂：stdin 喂的 -w
#     走 readpassphrase 有 128 字节硬上限，~471 字节 blob 会被截成残片丢 refreshToken）。token-blind 细化（用户拍板
#     抉择 A）：blob 绝不 echo/print/log/进 registry，接受写 keychain 时经 argv 的 sub-second 本机局部暴露（可读
#     argv 的同用户本就能直接读 keychain）；file 写入用 `printf … >> file`（blob 进文件、不回显终端）。
#   · 用完即 `unset blob`。dry-run / 任何输出里 blob 一律 <redacted>。
#   · 本脚本注释里所有示例 token 一律占位，绝不写真值。
#   · **registry 只写非密**：add 成功后调 accounts-lib.js（node）的 upsertAccount 写 email→vault 引用 +
#     token_added_at/token_refreshed_at/token_expires_at + 非密 subscription_type + identity——这些全非密；
#     blob 那一坨从不进 node、不进 registry。再 best-effort 写一条 last_observed_quota（录号那刻 cc-usage
#     给的 5h/7d used_pct/resets_at/source·全非密·选号弱信号兜底·优化①）——同样只传非密用量给 node。
#
# ───────────────────────── 落点纪律（红线 1/5）─────────────────────────
# 这是 out-of-band 脚本（像 switch-account.sh / cc-usage.sh / codex-review.sh），**绝不进 hooks/**、
# 不是 hook runtime、不新增后台派发机制。它调 `security` / `node`（带外依赖；node 是 Claude
# Code 宿主天然在的 runtime，ADR-006）。Bedrock/Vertex/Foundry 云后端无订阅 OAuth token 可管 → 自检到
# 任一云开关即 no-op 退出（不破 ship-anywhere）。

# ───────────────────────── 安全开头（HARD，token no-leak 第一要务·抄 switch-account.sh）─────────────────────────
# xtrace（set -x）会把变量赋值与命令实参回显到 stderr——直接打印明文 token，破 no-leak 契约。两条来源都堵：
#   ① 有人 `bash -x account-add.sh` 显式调试；② env 继承的 xtrace（export SHELLOPTS=xtrace）。
# 故在任何 token 触碰之前**无条件关掉 xtrace**：`set +x` 关本 shell 的 xtrace 位，并 `unset SHELLOPTS`
# （②的载体——bash 启动时据它恢复 set 选项；清掉它防 xtrace 被继承回来）。这必须先于任何会碰 token 的代码。
set +x                  # 关 xtrace（防 token 赋值 / 写入行被 trace 出来）；真正的关 trace 动作
# SHELLOPTS 在部分 bash 下 readonly（unset 报错），吞掉失败——真正关 trace 的是上一行 set +x，本行额外加固。
unset SHELLOPTS 2>/dev/null || true

# ───────────────────────── 云后端自检（红线 5，no-op 退出·先于任何 token 操作）─────────────────────────
# Bedrock/Vertex/Foundry 是模型后端、非订阅口径：没有可管的订阅 OAuth token。在这些后端上录号 = 多此一举。
# 故在取任何 token 之前自检三个云开关——任一为真 → 提示不适用 + no-op 退出（exit 0）。镜像 accounts.md Step 1。
if [ -n "${CLAUDE_CODE_USE_BEDROCK:-}" ] || [ -n "${CLAUDE_CODE_USE_VERTEX:-}" ] || [ -n "${CLAUDE_CODE_USE_FOUNDRY:-}" ]; then
  printf '%s\n' "account-add: 云后端（Bedrock/Vertex/Foundry）无订阅 OAuth token 可管 —— 录号不适用，no-op 退出。" >&2
  exit 0
fi

set -uo pipefail

# ───────────────────────── 路径自解析（self-contain：node 库与本脚本同 scripts/ 目录）─────────────────────────
# accounts-lib.js 与本脚本同住 ${CLAUDE_SKILL_DIR}/scripts/。优先用 CLAUDE_SKILL_DIR（装机后由 harness 注入），
# 缺失则按本脚本所在目录解析（dev / 直接 bash 跑时）——绝不裸相对路径（会相对用户 cwd 解析、找不到·Finding #37/#38）。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
LIB_JS="${CLAUDE_SKILL_DIR:-$SCRIPT_DIR/..}/scripts/accounts-lib.js"
[ -f "$LIB_JS" ] || LIB_JS="$SCRIPT_DIR/accounts-lib.js"

# ───────────────────────── 跨 skill 路径：cc-usage.sh（优化①·配额快照信号源·抄 switch-account.sh 范式）─────────────────────────
# cc-usage.sh 是 pacing 信号工具、属 orchestrating-to-completion，住
#   ${CLAUDE_PLUGIN_ROOT}/skills/orchestrating-to-completion/scripts/。跨 skill 引用必须
#   ${CLAUDE_PLUGIN_ROOT}/skills/<name>/… 绝对（绝不裸相对路径·Finding #38/#50）；缺 CLAUDE_PLUGIN_ROOT 时
#   （dev / 直接 bash 跑）从本脚本所在目录上溯两级到 skills/ 再下到兄弟 skill（plugin 内相对稳定，两 skill 都 ship）。
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -d "${CLAUDE_PLUGIN_ROOT}/skills/orchestrating-to-completion/scripts" ]; then
  ORCH_SCRIPTS="${CLAUDE_PLUGIN_ROOT}/skills/orchestrating-to-completion/scripts"
else
  # scripts → account-management → skills，再下到 orchestrating-to-completion/scripts。
  ORCH_SCRIPTS="$(cd "$SCRIPT_DIR/../.." 2>/dev/null && pwd)/orchestrating-to-completion/scripts"
fi
# env-可覆写（显式给则用 env·与上面 ORCH_SCRIPTS 推算对偶）——测试注入快 stub 让 e2e 不跑真 cc-usage
# （真 cc-usage 读当前 session 的巨 JSONL 算用量、超长 session 下极慢、会让 e2e/run-tests.sh 卡住）；
# 生产里若用户/上游想换信号源亦可覆写。与其它 CC_* 覆写点（CC_MASTER_HOME 等）对偶。
CC_USAGE_SH="${CC_USAGE_SH:-${ORCH_SCRIPTS}/cc-usage.sh}"

# ───────────────────────── helpers ─────────────────────────
# 所有诊断走 stderr；stdout 留给「进度 / 计划」输出。绝不在任何路径打印 token 变量。
err()  { printf '%s\n' "$*" >&2; }
info() { printf '%s\n' "$*"; }     # 进度行（绝不含 token）

# ── 文件锁封装（codex round#9 Finding C·file vault 跨进程串行化·同 account-delete.sh）─────────────────────
# 锁住 file vault（accounts.env）的「读-筛-写-rename」整段，防 add/writeback 与并发 delete/add 互踩（最后 mv 者赢
#   会复活已删 token / 丢别号刚写 blob）。用 accounts-lib 通用文件锁（O_EXCL + owner token + stale 回收）。锁文件
#   <vf>.lock 只含非密 pid/at/owner·绝不碰 token。
# **fail-closed（codex round#10）**：取锁失败（contention 超时 / 建不了锁文件）→ **绝不无锁跑临界区**（那会重现锁要
#   防的 race），而是 return 1·不执行 command。调用方据此把整个 vault 写当失败处理（原 vault 不动·token-blind）。
with_vault_lock() { # $1 = vault file path; $2... = command (+args) to run while holding the lock
  local vf="$1"; shift
  local owner=""
  # **记本 bash 进程的 $$ 当锁 livePid（codex round#13 Finding A）**：取锁的一次性 node 进程会立即退出·临界区在 bash
  #   里跑——若锁记 node 的 pid，并发对手会立刻把这已死 pid 判 stale 破锁（锁形同虚设）。故把 bash `$$`（临界区期间
  #   一直活着）当 livePid 写进锁文件·并发对手 process.kill($$,0) 看到活着 → 不破锁 → 真串行化。
  owner="$(node -e 'try{const l=require(process.argv[1]);const h=l.acquireFileLock(process.argv[2],{livePid:Number(process.argv[3])});process.stdout.write(h.owner||"")}catch(e){process.stderr.write(String(e&&e.message||e)+"\n");process.exit(1)}' "$LIB_JS" "$vf" "$$" 2>/dev/null)" || owner=""
  if [ -z "$owner" ]; then
    err "vault: 无法取得 vault 文件锁（${vf}.lock·另有进程长时间持锁 / node 不可用）——**拒绝无锁重写 vault**（防并发互踩），未写入。"
    return 1
  fi
  "$@"; local rc=$?
  node -e 'try{const l=require(process.argv[1]);l.releaseFileLock({path:process.argv[2]+".lock",owner:process.argv[3]})}catch(_e){}' "$LIB_JS" "$vf" "$owner" 2>/dev/null
  return $rc
}

usage() {
  err "usage: account-add.sh --email <email> [--vault-kind keychain|file]"
  err "       [--vault-file <path>] [--keychain-service <s>] [--expires YYYY-MM-DDTHH:MM:SSZ] [--dry-run]"
  err ""
  err "  从 macOS keychain「Claude Code-credentials」(account=\$USER) 直读当前登录号的完整 OAuth blob"
  err "  （含 refreshToken）→ 存进 vault → 写一条 accounts.json registry entry（active:true·当前登录号）。"
  err "  身份 guard：--email 必须 == 当前登录身份的 email（防把 B 的 blob 错标成 A）。token 永不进 registry / 永不回显。"
}

# ───────────────────────── arg 解析 ─────────────────────────
# A2：账号标识从任意 key 改为 email（switch / list / delete 全用 email 当唯一标识）。--account 作旧别名兼容。
EMAIL=""; EXPIRES=""; DRY_RUN=0
VAULT_KIND="keychain"
KEYCHAIN_SERVICE="cc-master-oauth"
# A2 §A.1 / G#1：file vault 默认统一到 accounts.json 同一用户级 home（~/.claude/cc-master），与 registry 同目录。
VAULT_FILE="${CC_MASTER_HOME:-${HOME}/.claude/cc-master}/accounts.env"

# value 型 flag 缺值守卫（robustness·codex §7 P2-a·防死循环）：value 型 flag（`--email` 等）需要第二个 arg；
#   若缺（`account-add.sh --email` 末位、或命令层在 `--add` 后没拼 email），`${2:-}` 为空、`shift 2` 因只剩 1 个
#   arg 而**失败**——脚本无 set -e，arg list 不变，`while [ $# -gt 0 ]` 死循环到被 kill。故每个 `shift 2` 前先确认
#   存在第二个 arg（`[ $# -ge 2 ]`），缺值则打印 error+usage 并退出非 0（绝不死循环）。
need_val() { [ "$#" -ge 2 ] || { err "error: option '$1' requires a value."; usage; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --email|--account)  need_val "$@"; EMAIL="$2"; shift 2;;
    --vault-kind)       need_val "$@"; VAULT_KIND="$2"; shift 2;;
    --vault-file)       need_val "$@"; VAULT_FILE="$2"; shift 2;;
    --keychain-service) need_val "$@"; KEYCHAIN_SERVICE="$2"; shift 2;;
    --expires)          need_val "$@"; EXPIRES="$2"; shift 2;;
    --dry-run)          DRY_RUN=1; shift;;
    -h|--help)          usage; exit 0;;
    *) err "unknown arg: $1"; usage; exit 2;;
  esac
done

if [ -z "$EMAIL" ]; then
  err "error: --email <email> is required."
  usage; exit 2
fi
case "$VAULT_KIND" in
  keychain|file) ;;
  *) err "error: --vault-kind must be one of keychain|file (got: $VAULT_KIND)"; exit 2;;
esac

# ───────────────────────── 时间元信息（registry 用·全非密）─────────────────────────
# token_expires_at 默认 = now + 365d（OAuth refresh token 长期有效期量级）；用户 --expires 覆写。
# 严格 ISO-8601 UTC（秒精度、Z 后缀）由 node 现算——与 accounts-lib.js ISO_UTC_RE 对齐，绝不在 bash 里手拼日期。
default_expires_iso() {
  # node 算 now+365d 的严格 ISO（秒精度）；node 失败则回空（registry 写 token_expires_at 缺省，不致命）。
  node -e 'const d=new Date(Date.now()+365*24*3600*1000);process.stdout.write(d.toISOString().replace(/\.\d{3}Z$/,"Z"))' 2>/dev/null || true
}

# ───────────────────────── 完整 blob 提取（无重启换号·主路径·直读 keychain「Claude Code-credentials」）─────────────────────────
# 无重启换号要 vault 里存**完整 claudeAiOauth blob**（含 refreshToken），不是一段裸 access token。
#   spike 实证：完整 + 有效 refreshToken 只在 macOS keychain 的「Claude Code-credentials」(account=$USER)
#   item 里——credentials.json 文件里 refreshToken 值为空（残缺副本）。故**主路径直读 keychain**。
# 机制：`security find-generic-password -w -s "Claude Code-credentials" -a "$USER"` 把 password（= 一坨
#   JSON blob `{claudeAiOauth:{...}}`）打到 stdout → **直接管道喂 node**（token-blind：blob 全程在管道，
#   绝不落 bash 变量、绝不 echo）→ node JSON.parse → 取 .claudeAiOauth → 严格校验三必需字段 → 规整成单行 blob。
# token 安全：blob 经 `security … | node …` 管道，node stdout 才是 shell 捕获的（已规整·仍含 token·**绝不回显**·
#   同 store_blob 的 no-leak 纪律）。三必需字段：accessToken(sk-ant-oat) / refreshToken(sk-ant-ort·**非空**) /
#   expiresAt(数字)。**refreshToken 空/缺 → node 退非 0 + 空 stdout**（绝不存残缺 switchable:false blob）。
# 失败语义：keychain item 不存在 / 非 mac / blob 非法 JSON / .claudeAiOauth 缺 / 三字段任一缺或形态错 →
#   node 退非 0 + 空 stdout → 调用方降级到 credentials.json 文件 fallback / 失败。
#   KEYCHAIN_CRED_SERVICE 可 env 覆写（一般不需要·官方固定为 "Claude Code-credentials"）。
KEYCHAIN_CRED_SERVICE="${KEYCHAIN_CRED_SERVICE:-Claude Code-credentials}"
# node 程序：从 stdin 读 blob（管道喂）→ 取 .claudeAiOauth → 校验三必需字段 → 规整单行 blob。两路径共用。
# shellcheck disable=SC2016
NODE_BLOB_FROM_STDIN='
  "use strict";
  let s = "";
  process.stdin.on("data", (d) => { s += d; }).on("end", () => {
    let j;
    try { j = JSON.parse(s); } catch (_e) { process.stderr.write("keychain/credentials blob 不是合法 JSON。\n"); process.exit(1); }
    const o = j && j.claudeAiOauth;
    if (!o || typeof o !== "object") { process.stderr.write("blob 缺 .claudeAiOauth 对象（Claude Code 升级漂移？）。\n"); process.exit(1); }
    // 严格三必需字段校验（绝不回显值）。
    if (typeof o.accessToken !== "string" || o.accessToken.indexOf("sk-ant-oat") !== 0) { process.stderr.write(".claudeAiOauth.accessToken 缺失 / 前缀非 sk-ant-oat。\n"); process.exit(1); }
    if (typeof o.refreshToken !== "string" || o.refreshToken.indexOf("sk-ant-ort") !== 0 || !o.refreshToken) { process.stderr.write(".claudeAiOauth.refreshToken 缺失 / 空 / 前缀非 sk-ant-ort（无 refresh token → 无重启换号切不进·拒存残缺 blob）。\n"); process.exit(1); }
    if (typeof o.expiresAt !== "number" || !isFinite(o.expiresAt)) { process.stderr.write(".claudeAiOauth.expiresAt 缺失 / 非数字（access token 短期到期 ms）。\n"); process.exit(1); }
    // 规整成单行 blob：三必需 + 可选非密元（scopes/subscriptionType/rateLimitTier，缺则不带）。
    const blob = { accessToken: o.accessToken, refreshToken: o.refreshToken, expiresAt: o.expiresAt };
    if (Array.isArray(o.scopes)) blob.scopes = o.scopes;
    if (typeof o.subscriptionType === "string" && o.subscriptionType) blob.subscriptionType = o.subscriptionType;
    if (typeof o.rateLimitTier === "string" && o.rateLimitTier) blob.rateLimitTier = o.rateLimitTier;
    // JSON.stringify 默认无缩进 = 单行（无内嵌换行；token 串本身 [A-Za-z0-9_-] 无换行）。
    process.stdout.write(JSON.stringify(blob));
  });
'
extract_blob_from_keychain() {
  # 出: stdout = 单行 JSON blob（三必需字段 + 可选 subscriptionType/scopes/rateLimitTier），或空 + 非 0。
  #   绝不在此 echo 任何 token；security 的 password（blob）经管道喂 node，node 只往 stdout 写规整单行 blob。
  if ! command -v security >/dev/null 2>&1; then
    err "keychain: 'security' (macOS keychain) not found — 非 mac，降级读 credentials.json 文件。"
    return 1
  fi
  # security -w 把 password（blob JSON）打到 stdout → 管道喂 node（token-blind·blob 不落变量/argv）。
  #   security 失败（item 不存在 / 未授权）→ 管道左端空/非 0；node 据空 stdin 报「非法 JSON」退非 0。
  security find-generic-password -w -s "$KEYCHAIN_CRED_SERVICE" -a "$USER" 2>/dev/null \
    | node -e "$NODE_BLOB_FROM_STDIN"
}

# extract_blob_from_credentials — **Linux/非-mac fallback**（主路径走 keychain·见上）。从 ~/.claude/.credentials.json
#   读 .claudeAiOauth 单行 blob。spike 实证：mac 上该文件 refreshToken 值为空 → 校验会拦下并提示用户重 /login；
#   但 Linux 上 credentials.json 是官方唯一凭证存储（无 keychain）→ 这里是它的正路。CREDENTIALS_JSON 可 env 覆写（测试注入）。
CREDENTIALS_JSON="${CREDENTIALS_JSON:-${HOME}/.claude/.credentials.json}"
extract_blob_from_credentials() {
  # 出: stdout = 单行 JSON blob（三必需字段 + 可选元），或空 + 非 0。复用 NODE_BLOB_FROM_STDIN（同校验·token-blind）。
  #   绝不在此 echo 任何 token；cat 把文件喂 node stdin，node 只往 stdout 写规整单行 blob。
  if [ ! -f "$CREDENTIALS_JSON" ]; then
    err "credentials.json 读取失败（${CREDENTIALS_JSON}）：不存在。"
    return 1
  fi
  cat "$CREDENTIALS_JSON" 2>/dev/null | node -e "$NODE_BLOB_FROM_STDIN"
}

# validate_blob BLOB → rc 0 合法 / 非 0 不合法。校验单行 JSON blob 含三必需字段（node·token-blind·绝不 echo）。
#   提供给 store_blob 前的最后一道关（extract 已校验，这里冗余兜底 + 单测点）。绝不回显 token。
validate_blob() {
  local b="${1:-}"
  [ -n "$b" ] || return 1
  printf '%s' "$b" | node -e '
    "use strict";
    let s = "";
    process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      let o; try { o = JSON.parse(s); } catch (_e) { process.exit(1); }
      if (!o || typeof o !== "object") process.exit(1);
      const okAt = typeof o.accessToken === "string" && o.accessToken.indexOf("sk-ant-oat") === 0;
      const okRt = typeof o.refreshToken === "string" && o.refreshToken.indexOf("sk-ant-ort") === 0 && !!o.refreshToken;
      const okExp = typeof o.expiresAt === "number" && isFinite(o.expiresAt);
      // 单行守卫：blob 绝不能含内嵌换行（file vault 取行会截断）。
      const oneLine = s.indexOf("\n") === -1 && s.indexOf("\r") === -1;
      process.exit(okAt && okRt && okExp && oneLine ? 0 : 1);
    });
  ' 2>/dev/null
}

# subscription_type_of BLOB → stdout = blob.subscriptionType（非密枚举·或空）。给 registry 写用（绝不带 token）。
#   只抽这一个非密字段喂 node registry 调用——token 那一坨从不进 registry。
subscription_type_of() {
  local b="${1:-}"
  [ -n "$b" ] || return 0
  printf '%s' "$b" | node -e '
    "use strict";
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      let o; try { o = JSON.parse(s); } catch (_e) { process.exit(0); }
      if (o && typeof o.subscriptionType === "string" && o.subscriptionType) process.stdout.write(o.subscriptionType);
    });
  ' 2>/dev/null || true
}

# ───────────────────────── 身份提取（主路径·从 ~/.claude.json oauthAccount）─────────────────────────
# 无重启换号要切**身份**（不只是 token）：账号身份（accountUuid/emailAddress/organization… 16 字段·全非密）在
#   ~/.claude.json 的 oauthAccount、不在 vault blob。本函数用 node 读该文件 → 取 .oauthAccount → 校验非空对象 →
#   process.stdout.write(JSON.stringify(oa)) **单行**。**identity 非密、可经 node stdout 回 bash 变量**（与 token
#   blob 不同·token 仍绝不回显）。也是身份 guard（--email 必须 == 当前登录 email）的 email 来源。
# CLAUDE_JSON_PATH 可 env 覆写（测试注入 stub·与 CREDENTIALS_JSON 对偶）。
# 失败语义：文件不存在 / 非法 JSON / 缺 .oauthAccount / 空对象（CC 漂移 / 未登录）→ node 退非 0 + 空 stdout。
CLAUDE_JSON_PATH="${CLAUDE_JSON_PATH:-${HOME}/.claude.json}"
extract_identity_from_claude_json() {
  # 出: stdout = 单行 JSON identity（= oauthAccount 原样·全非密），或空 + 非 0。
  node -e '
    "use strict";
    const fs = require("fs");
    const cjPath = process.argv[1];
    let raw;
    try { raw = fs.readFileSync(cjPath, "utf8"); }
    catch (e) { process.stderr.write("claude.json 读取失败（" + cjPath + "）：" + (e && e.code || e) + "\n"); process.exit(1); }
    let j;
    try { j = JSON.parse(raw); }
    catch (e) { process.stderr.write("claude.json 不是合法 JSON。\n"); process.exit(1); }
    const oa = j && j.oauthAccount;
    if (!oa || typeof oa !== "object" || Array.isArray(oa)) { process.stderr.write("claude.json 缺 .oauthAccount 对象（CC 升级漂移 / 未登录？）。\n"); process.exit(1); }
    if (Object.keys(oa).length === 0) { process.stderr.write("claude.json .oauthAccount 是空对象（无身份字段）。\n"); process.exit(1); }
    // 原样透传（不做字段白名单·CC 升级自动跟上）。单行 JSON（默认无缩进·无内嵌换行）。identity 全非密。
    process.stdout.write(JSON.stringify(oa));
  ' "$CLAUDE_JSON_PATH"
}

# email_of_identity_json JSON → stdout = identity JSON 的 emailAddress（非密·或空）。身份 guard 用。
email_of_identity_json() {
  local j="${1:-}"
  [ -n "$j" ] || return 0
  printf '%s' "$j" | node -e '
    "use strict";
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      let oa; try { oa = JSON.parse(s); } catch (_e) { process.exit(0); }
      if (oa && typeof oa === "object" && typeof oa.emailAddress === "string" && oa.emailAddress) process.stdout.write(oa.emailAddress);
    });
  ' 2>/dev/null || true
}

# ───────────────────────── vault 写入（blob 进函数后绝不打印）─────────────────────────
# **无重启换号：vault 存的是完整 claudeAiOauth blob（单行 JSON，含 refresh token），不是裸 access token。**
#   keychain 经 `security -w "$blob"`（值作 argv 参数）/ file awk 删旧行 + printf >> 文件——写入的**值**是
#   单行 blob。blob 单行（JSON.stringify 默认无缩进），故 file vault 的 `<email>_TOKEN=<blob>` 仍是单行、取行不截断。
#
# store_blob_keychain BLOB — macOS keychain 非交互写、blob 作 `security` 的 argv 参数。
#   **必须用 `-w "$blob"`（值作 argv）而非 stdin 喂**：`security add-generic-password -w`（末位不带值、从 stdin
#   读密码）走 `readpassphrase`，**有硬上限 128 字节**——完整 OAuth blob ~471 字节会被截成 128 残片（丢
#   refreshToken、非法 JSON）。值作 argv 参数则无此截断、存完整合法 JSON。token-blind 细化（用户拍板抉择 A）：
#   token 绝不进 agent context / transcript / log / registry，但写 keychain 时经 `security` 子进程 argv 的
#   sub-second 本机局部暴露可接受——可读你 argv 的同用户攻击者本就能直接读 keychain 本身，非新暴露面。
store_blob_keychain() {
  local blob="$1"
  if ! command -v security >/dev/null 2>&1; then
    err "vault: 'security' (macOS keychain) not found — 用 --vault-kind file 在非 mac 上。"
    return 1
  fi
  # -U：项已存在则更新（refresh 复用同一条）。-l：人类可读 label。blob 作 argv 参数（避 stdin 128 截断）。
  if security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$EMAIL" -l "cc-master OAuth: $EMAIL" -w "$blob" >/dev/null 2>&1; then
    return 0
  fi
  err "vault: keychain 写入失败（security add-generic-password 非 0）。"
  return 1
}

# store_blob_file BLOB — 0600 文件 vault。先删同 email 旧行（**§A.4 必修 bug**：email 含 `.`/`@` 是正则
# 元字符，旧 `grep -Ev "^${ACCOUNT}_(TOKEN|EXPIRES)="` 会误匹配——改用 accounts-lib.fileVaultLineMatch 给的
# **awk index() 精确前缀**删行，定字符串、对 `.`/`@` 免疫）。再 append 新 _TOKEN=<单行blob> 行 + 可选 _EXPIRES 行。
# blob 进文件不回显终端。**单行不变式**：blob 必须单行（validate_blob 已守 oneLine），否则 _TOKEN= 行被换行截断。
store_blob_file() {
  local blob="$1"
  umask 077
  mkdir -p "$(dirname "$VAULT_FILE")" 2>/dev/null || true
  # 取 email 的安全行前缀（fixed-string）——node 从 accounts-lib 拿，绝不在 bash 手拼正则。
  #   **只匹配本号自己的两类行 `<email>_TOKEN=` / `<email>_EXPIRES=`（codex round#2·重叠标识 bug 收口）**：
  #   旧码用宽前缀 `<email>_`（prefix）筛——脚本接受任意非空 `--email`、file-vault key 是纯字符串，故录/续期 `foo`
  #   会把 `foo_bar_TOKEN=`/`_EXPIRES=`（另一个号 `foo_bar` 的行）一并删掉 → 误毁 sibling 号、使其 unswitchable。
  #   修：删/重写只针对**精确的 `<email>_TOKEN=` 与 `<email>_EXPIRES=` 两个前缀**（tokenLine/expiresLine），
  #   绝不用宽 `<email>_` 前缀。仍是 awk index($0,p)==1 行首锚定·定字符串·对 `.`/`@` 元字符免疫。
  local token_line expires_line
  token_line="$(node -e 'const{fileVaultLineMatch}=require(process.argv[1]);process.stdout.write(fileVaultLineMatch(process.argv[2]).tokenLine)' "$LIB_JS" "$EMAIL" 2>/dev/null)" || token_line=""
  expires_line="$(node -e 'const{fileVaultLineMatch}=require(process.argv[1]);process.stdout.write(fileVaultLineMatch(process.argv[2]).expiresLine)' "$LIB_JS" "$EMAIL" 2>/dev/null)" || expires_line=""
  if [ -z "$token_line" ] || [ -z "$expires_line" ]; then
    err "vault: 无法从 accounts-lib 取 email 安全前缀（node 失败？）——拒绝用裸正则删行（§A.4 元字符 bug），未写入。"
    return 1
  fi
  # **全或无原子写（codex round#1 Finding 3）+ 跨进程串行化（codex round#9 Finding C）**：旧码「先 mv 删旧 _TOKEN
  #   行的版本到位、再 >> append 新 blob」——append 失败/部分写时旧 token 已删、新 token 没写 = vault 无有效 token；
  #   且跨进程不串行（并发 delete/add 改同一文件最后 mv 者赢）。修：① temp 里先写齐（保留旧行 + 新 _TOKEN + 可选
  #   _EXPIRES）全成功才 rename（全或无·原 vault 任一步失败都没动）；② 整段「筛-写-rename」在 vault 文件锁内做
  #   （with_vault_lock·串行化跨进程重写）。token-blind 不变：awk 只按前缀筛行不读值；blob 经 printf 进 temp、不回显。
  _store_blob_file_locked() {
    local vtmp
    vtmp="$(mktemp "${VAULT_FILE}.XXXXXX" 2>/dev/null || printf '%s' "${VAULT_FILE}.tmp.$$")"
    if [ -z "$vtmp" ]; then err "vault: 无法建临时文件——未写入（原 vault 原封不动）。"; return 1; fi
    chmod 600 "$vtmp" 2>/dev/null || true
    # ① 保留的旧行（只删本号**精确**的 _TOKEN= / _EXPIRES= 两类行·codex round#2 重叠标识 bug）：仅当文件已存在才筛；
    #    不存在 = temp 从空起。awk 保留「既不以 <email>_TOKEN= 起头、也不以 <email>_EXPIRES= 起头」的行——`foo_bar_*` 这类
    #    sibling 行（前缀是 `foo_bar_TOKEN=`·不等于 `foo_TOKEN=`）天然保留。awk 非 0（文件不可读）→ 丢 temp 退出。
    if [ -f "$VAULT_FILE" ]; then
      if ! awk -v t="$token_line" -v x="$expires_line" 'index($0, t) != 1 && index($0, x) != 1' "$VAULT_FILE" > "$vtmp" 2>/dev/null; then
        rm -f "$vtmp"; err "vault: 筛旧行失败（awk 非 0·文件不可读？）——保留原文件，未写入。"; return 1
      fi
    fi
    # ② 追加新 _TOKEN=<单行blob> 行进 temp（blob 进文件、不回显）。printf 而非 echo（避免转义歧义）。失败 → 丢 temp、原 vault 不动。
    if ! printf '%s_TOKEN=%s\n' "$EMAIL" "$blob" >> "$vtmp"; then
      rm -f "$vtmp"; err "vault: 写 blob 行失败（磁盘满 / IO 错？）——丢弃临时文件、原 vault 原封不动（旧 token 存活），未写入。"; return 1
    fi
    # ③ 可选 _EXPIRES（非密·refresh token 长期有效期，非 blob 内短期 expiresAt）。同样进 temp、失败即整体丢弃（全或无）。
    if [ -n "$EXPIRES" ]; then
      if ! printf '%s_EXPIRES=%s\n' "$EMAIL" "$EXPIRES" >> "$vtmp"; then
        rm -f "$vtmp"; err "vault: 写 _EXPIRES 行失败——丢弃临时文件、原 vault 原封不动，未写入。"; return 1
      fi
    fi
    # ④ 全部写齐 → 原子 rename 覆盖（同目录 rename 原子）。到这一步原 vault 才被替换；此前任一失败原 vault 都没动。
    if ! mv "$vtmp" "$VAULT_FILE"; then
      rm -f "$vtmp"; err "vault: 原子替换 vault 文件失败（rename 错）——原 vault 原封不动（旧 token 存活），未写入。"; return 1
    fi
    return 0
  }
  with_vault_lock "$VAULT_FILE" _store_blob_file_locked
}

store_blob() {
  case "$VAULT_KIND" in
    keychain) store_blob_keychain "$1";;
    file)     store_blob_file "$1";;
  esac
}

# ───────────────────────── registry 写入（A2 增量·全非密·token 那一坨从不进 node）─────────────────────────
# add 成功后调 accounts-lib.js（node）的 upsertAccount 写一条 entry：email → vault 引用 + 时间元信息。
#   **绝不传 token 给 node**——只传 email / vault 形态 / 时间戳（全非密）。upsertAccount 自身有 token-leak
#   断言（FORBIDDEN_FIELD_RE + sk-ant- 形态），即便误传也拒写。registry 写失败**不回滚 vault**（token 已安全
#   入 vault 是主目标；registry 是非密对账层，缺一条 entry 可用 list / 重跑修复）——但要 surface 给用户。
write_registry_entry() {
  # 入参全非密：email / vault-kind / keychain-service / vault-path / expires-iso / now-iso / subscription-type
  #   / identity-json / switchable / is_active。
  #   $1（可选）= subscription_type（非密订阅枚举·来自 blob.subscriptionType，缺则空·绝不是 token）。
  #   $2（可选）= identity JSON（= ~/.claude.json oauthAccount 原样·**全非密**；缺则空·不写 identity）。
  #     identity 非密可经 argv（与 token 不同·token 绝不进 argv）；upsert 仍对 identity 子树跑值扫描兜底拦 token 误入。
  #   $3（可选）= switchable（"false" → 标残缺号不可切·防御路；"true" → 成功 add 路径显式标可切·**覆写旧 false**·
  #     清掉 fallback 留下的 switchable:false 让 recovery 生效；其它/缺 → 不写该字段·视作可切）。
  #   $4（可选）= is_active（"1" → 录的是当前登录号·upsert 后调 setActive 标该号 active:true·其余 false；
  #     其它/缺 → 维持 upsert 默认 active:false）。setActive 自身维护 active 唯一性。
  local sub_type="${1:-}"
  local identity_json="${2:-}"
  local switchable_arg="${3:-}"
  local is_active_arg="${4:-}"
  local now_iso added_iso refreshed_iso
  # node 现算 now 的严格 ISO（与 lib nowIso 一致）。
  now_iso="$(node -e 'process.stdout.write(new Date().toISOString().replace(/\.\d{3}Z$/,"Z"))' 2>/dev/null || true)"
  added_iso="$now_iso"; refreshed_iso="$now_iso"
  # 调 node：require lib → 读现有 registry（loadRegistry，缺文件=空池）→ upsertAccount → saveRegistry（原子写+校验）。
  #   token_added_at 仅在该号是新增时盖（已存在=保留原 added，只更新 refreshed）；node 内部处理。
  #   **token_expires_at = refresh token 长期有效期（now+365d·非 blob 内短期 expiresAt）**——短期 expiresAt 只进 vault blob。
  #   所有值经 process.argv 传入（**全非密**：subscription_type 是订阅枚举·identity 是非密身份对象·绝不是 token）；
  #   token/blob 绝不出现在任何 argv。identity JSON 经 JSON.parse 塞 fields.identity（upsert 对其跑值扫描兜底）。
  # **整个 load→改→save 在 mutateRegistry 锁内做（codex round#7 Finding C·防并发 lost-update）**：并发录号/换号
  #   各自 load 同一旧态、各自改、后写 rename 覆盖先写 = 丢号 / active 错。mutateRegistry 加咨询文件锁串行化 RMW。
  node -e '
    "use strict";
    const lib = require(process.argv[1]);
    const [ , , email, vaultKind, kcService, vaultPath, expiresIso, nowIso, subType, identityJson, switchableArg, isActiveArg ] = process.argv;
    const regPath = lib.defaultRegistryPath();
    const out = lib.mutateRegistry(regPath, (reg) => {       // 锁内 load 最新态 → 改 → save（缺文件 = 空池·设计稿 §F）
      const prev = (reg.accounts && reg.accounts[email]) || {};
      const vault = vaultKind === "keychain"
        ? { kind: "keychain", service: kcService, account: email }
        : { kind: "file", path: vaultPath, key: email };
      const fields = {
        vault,
        // token_added_at 只在新增时盖；已存在的号保留原 added（refresh 不改首次录入时刻）。
        token_added_at: (prev && prev.token_added_at) ? prev.token_added_at : nowIso,
        token_refreshed_at: nowIso,
      };
      if (expiresIso) fields.token_expires_at = expiresIso;
      if (subType) fields.subscription_type = subType;       // 非密订阅枚举（来自 blob.subscriptionType）。
      // identity：JSON.parse 校验是对象再塞；解析失败 / 非对象 → 不写 identity（降级·不阻断）。
      //   upsertAccount 对 fields.identity 跑带豁免 flag 的 scanForTokenLeak（保留值扫描），token 误入会抛错拦下。
      if (identityJson) {
        let id = null;
        try { id = JSON.parse(identityJson); } catch (_e) { id = null; }
        if (id && typeof id === "object" && !Array.isArray(id) && Object.keys(id).length > 0) fields.identity = id;
      }
      // switchable（残缺号标注防御路）：仅 "false" 时显式写 false（标不可切）；"true" 时显式写 true
      //   （成功 add 路径·**覆写旧 false**·清掉之前 fallback 留下的 switchable:false → recovery 路径生效）；
      //   缺省（其它/空）不写（视作可切·不破完整号）。upsertAccount 的 `if (f.switchable !== undefined)` 会
      //   把这个 true 写进 entry.switchable（覆写旧 false·已核对·无需改 accounts-lib）。
      if (switchableArg === "false") fields.switchable = false;
      else if (switchableArg === "true") fields.switchable = true;
      lib.upsertAccount(reg, email, fields);                 // 绝不传 token——upsert 自带 token-leak 断言（含 identity 值扫描）
      // is_active：录的是**当前登录号** → setActive 标该号 active:true（其余 false·setActive 维护 active 唯一性·
      //   设计 §A.1 不变式3）。**绝不放宽 validateRegistry 的 active 唯一性**——setActive 已保证唯一，saveRegistry 校验仍把关。
      if (isActiveArg === "1") {
        lib.setActive(reg, email);                           // 该 email active=true·其余全 false（唯一性）。
        process.stderr.write("registry: 录的是当前登录号 → 标 " + email + " active:true（其余 false）。\n");
      }
    });
    process.stderr.write("registry: 已写入 " + out + "\n");
  ' "$LIB_JS" "$EMAIL" "$VAULT_KIND" "$KEYCHAIN_SERVICE" "$VAULT_FILE" "$EXPIRES" "$now_iso" "$sub_type" "$identity_json" "$switchable_arg" "$is_active_arg" 2>&1
}

# ───────────────────────── 录号那刻配额快照（优化①·best-effort·token-blind·全非密）─────────────────────────
# 录号成功后，跑 cc-usage.sh 取**当前 session 这个号**的 5h/7d 配额状态，写进刚录号的 last_observed_quota，
#   让选号算法对刚录的号也有恢复估计依据（否则刚录的号无 last_switch_out → select 当「满血/全新」处理，缺真实配额）。
#
# ★关键诚实局限（注释 + 字段语义 + select-account warning 三处都写清）：cc-usage 反映的是**当前 session 这个
#   账号**的配额（从本地 JSONL / status-line sidecar 算）。直读 keychain 录的就是**当前登录号** → cc-usage 拿到的
#   就是它的真实配额 → 准确（比旧 setup-token 流更准·被录号天然是当前登录号）。
#
# token-blind：cc-usage 只读本地用量、绝不碰 token；写 last_observed_quota 经 accounts-lib（node）只传非密
#   used_pct/resets_at/source——token 那一坨从不进 node、不进 registry（同 switch-account.sh record_switch_out 范式）。
# best-effort：失败（cc-usage 缺 / node 出错 / saveRegistry 拒写）**绝不阻断录号、绝不回滚 vault/registry**——
#   缺它只是选号少一个弱信号，surface 一行警告即可（同 write_registry_entry 容错纪律）。
write_observed_quota() {
  # cc-usage.sh 拿账户权威 {source, five_hour:{used_percentage,resets_at}, seven_day:{...}}；缺/降级则 source=local-derived-approx。
  if [ ! -f "$CC_USAGE_SH" ]; then
    err "  （提示：未找到 cc-usage.sh（${CC_USAGE_SH}）——跳过录号配额快照 last_observed_quota，选号少一个弱信号。）"
    return 0
  fi
  # ── best-effort 时限（可移植纯 bash·无 timeout/gtimeout 依赖·macOS 上它们不保证在）─────────────────
  # 真 cc-usage 读当前 session 的 JSONL transcript 算用量——超长 session 下 JSONL 巨大 → cc-usage 极慢，
  # 会让 add 长等（生产）/ 让 e2e 测试 + run-tests.sh 卡住（端点实测分钟级不出）。故用「后台跑进临时文件 +
  # watchdog 轮询 + 超时 kill」可移植模式给它兜一个上限（CC_USAGE_TIMEOUT_S 默认 60s·可 env 覆写）：
  #   · 后台 bash 跑 cc-usage、stdout 重定向进 mktemp 临时文件；最多等 N 秒（每 0.2s 轮询子进程是否退出）。
  #   · 超时未退 → kill（TERM 后 KILL 兜底）、当 cc-usage 无输出处理（best-effort 跳过·选号少一个弱信号）。
  #   · 任何分支都 return 0 不阻断录号。token 安全：cc-usage 本就 token-blind；临时文件只承非密用量 JSON、
  #     用完即删；kill 只针对 cc-usage 子进程、不碰任何 token。
  local timeout_s="${CC_USAGE_TIMEOUT_S:-60}"
  local usage_tmp usage_json=""
  usage_tmp="$(mktemp 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}/cc-usage-oq.$$.tmp")"
  ( bash "$CC_USAGE_SH" >"$usage_tmp" 2>/dev/null ) &
  local ccu_pid=$!
  # 轮询最多 timeout_s 秒（0.2s 步进 → 5 次/秒）。子进程退出即提前 break。
  local waited=0 max_ticks=$(( timeout_s * 5 ))
  while [ "$waited" -lt "$max_ticks" ]; do
    kill -0 "$ccu_pid" 2>/dev/null || break
    sleep 0.2
    waited=$(( waited + 1 ))
  done
  if kill -0 "$ccu_pid" 2>/dev/null; then
    # 超时仍在跑 → kill（防巨 JSONL 下无限等）。TERM 后短等再 KILL 兜底。绝不阻断录号。
    kill "$ccu_pid" 2>/dev/null || true
    sleep 0.2
    kill -9 "$ccu_pid" 2>/dev/null || true
    err "  （提示：cc-usage.sh 超过 ${timeout_s}s 未返回（多半当前 session JSONL 过大）——已中止，跳过录号配额快照 last_observed_quota，选号少一个弱信号。）"
  fi
  wait "$ccu_pid" 2>/dev/null || true
  usage_json="$(cat "$usage_tmp" 2>/dev/null || true)"
  rm -f "$usage_tmp" 2>/dev/null || true
  if [ -z "$usage_json" ]; then
    err "  （提示：cc-usage.sh 无输出——跳过录号配额快照 last_observed_quota，选号少一个弱信号。）"
    return 0
  fi

  # node：解析 cc-usage 输出 → 规整成 recordObservedQuota 的 {fiveHour,sevenDay}.{used_pct,resets_at,source}
  #   （used_percentage → 0-100 整数；resets_at epoch 秒 → 严格 ISO；缺则留空）→ loadRegistry → recordObservedQuota
  #   → saveRegistry（原子+校验·含 token-leak 拒写）。**绝不传 token**；usage_json 是非密用量。镜像 switch-account.sh record_switch_out 的 win()。
  local oq_out
  oq_out="$(node -e '
    "use strict";
    const lib = require(process.argv[1]);
    const [ , , email, usageRaw ] = process.argv;
    const regPath = lib.defaultRegistryPath();             // 与 write_registry_entry 同一默认路径（${CC_MASTER_HOME:-~/.claude/cc-master}/accounts.json）。

    function epochToIso(ep) {
      if (typeof ep !== "number" || !isFinite(ep)) return undefined;
      return new Date(ep * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    }
    function intPct(v) {
      const n = Number(v);
      if (!isFinite(n)) return undefined;
      return Math.max(0, Math.min(100, Math.round(n))); // 钳到 [0,100]（lib 校验 used_pct 是 0-100 整数）。
    }

    let usage = null;
    try { usage = usageRaw ? JSON.parse(usageRaw) : null; } catch (_e) { usage = null; }
    const src = (usage && typeof usage.source === "string") ? usage.source : "local-derived-approx";
    const fh = (usage && usage.five_hour) || {};
    const sd = (usage && usage.seven_day) || {};
    function win(w) {
      const o = { used_pct: intPct(w.used_percentage), source: src };
      const ra = epochToIso(w.resets_at);
      if (ra) o.resets_at = ra;
      return o;
    }

    // 锁内 RMW（codex round#7 Finding C·防并发 lost-update·与 write_registry_entry 串行不互踩）。
    let skipped = false;
    lib.mutateRegistry(regPath, (reg) => {
      if (!reg.accounts || !reg.accounts[email]) {
        process.stderr.write("observed-quota: " + email + " 不在 registry——跳过（registry 写应已先于本步）。\n");
        skipped = true; return;                             // 不改不存（mutateRegistry 仍会 save 一份不变态·无害）。
      }
      lib.recordObservedQuota(reg, email, { fiveHour: win(fh), sevenDay: win(sd) });
    });
    if (!skipped) process.stderr.write("observed-quota: 已写 " + email + " 的 last_observed_quota（source=" + src + "·录号即当前登录号视角·选号信号）。\n");
  ' "$LIB_JS" "$EMAIL" "$usage_json" 2>&1)" || {
    # 写失败（多半 used_pct 降级被拒写 / node 错）——best-effort，绝不阻断、绝不回滚。
    err "  （提示：写录号配额快照 last_observed_quota 失败（多半 cc-usage 降级、used_pct 缺失被拒写）——录号已成、选号少一个弱信号："
    err "    $oq_out）"
    return 0
  }
  [ -n "$oq_out" ] && err "$oq_out"
}

# ── 探测 cc-master vault 是否已有该 email 的有效 blob（手动恢复闭环·token-blind）──────────────────────
# 用途：fallback（自动提取失败）路径在标 switchable 前先探一道——用户照手动指引把有效 blob 存进 cc-master
#   vault 后**重跑 --add**，若自动提取仍失败（非 mac / 官方登录非目标号），没有这道探测就永远标 switchable:false
#   → 该号被 select-account / usage-pacing effective-N 永久排除、手动恢复路隐身。探测命中（vault 已有有效 blob）
#   → 升 switchable:true，手动恢复闭环。
# token-blind 铁律不破：blob 全程在 `security … | node …` 管道 / 子进程；node **只输出 yes/no 布尔**、绝不回显
#   blob 值；本函数返回 0=有效 / 1=无（经 RC，不经 stdout 漏 blob）。读 cc-master vault（KEYCHAIN_SERVICE /
#   VAULT_FILE），**不是**官方「Claude Code-credentials」(那是自动提取的源)。
# vault 存的是**规整后**的单行 blob `{accessToken,refreshToken,expiresAt}`（store_blob 落的形态·无 claudeAiOauth
#   包裹）——故校验顶层 refreshToken（sk-ant-ort·非空）+ 合法 JSON，与自动提取路径校验的 `.claudeAiOauth.*` 形态不同。
probe_vault_has_valid_blob() {
  # node 校验器：从 stdin 读规整 blob → JSON.parse → 顶层 refreshToken 非空且前缀 sk-ant-ort → 输出 yes/no（绝不回显 blob）。
  local validator='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let ok=false;try{const o=JSON.parse(s);ok=o&&typeof o==="object"&&typeof o.refreshToken==="string"&&o.refreshToken.indexOf("sk-ant-ort")===0&&typeof o.accessToken==="string"&&o.accessToken.indexOf("sk-ant-oat")===0;}catch(_e){ok=false;}process.stdout.write(ok?"yes":"no");});'
  local verdict=""
  if [ "$VAULT_KIND" = "keychain" ]; then
    command -v security >/dev/null 2>&1 || return 1
    # security -w 把 cc-master vault 里该 email 的 blob 打到 stdout → 直接管道喂 node（blob 不落 bash 变量）。
    #   keychain item 不存在 → security 非 0 → 管道 node 收空 → "no"。account=email（cc-master vault 用 email 当 account）。
    verdict="$(security find-generic-password -a "$EMAIL" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null | node -e "$validator" 2>/dev/null)" || verdict="no"
  else
    # file vault：取本号 _TOKEN= 行（awk index($0,p)==1 行首锚定·对 . / @ 元字符免疫·§A.4）→ 参数展开切前缀取值
    #   进 local（与 read_blob_file 同一隔离边界·local 变量·绝不 echo）→ 管道喂 node 校验。
    [ -f "$VAULT_FILE" ] || return 1
    local prefix line blob
    prefix="$(node -e 'const{fileVaultLineMatch}=require(process.argv[1]);process.stdout.write(fileVaultLineMatch(process.argv[2]).tokenLine)' "$LIB_JS" "$EMAIL" 2>/dev/null)" || prefix=""
    [ -n "$prefix" ] || return 1
    line="$(awk -v p="$prefix" 'index($0, p) == 1' "$VAULT_FILE" 2>/dev/null | head -1)" || line=""
    [ -n "$line" ] || return 1
    blob="${line#"$prefix"}"   # 切掉 <email>_TOKEN= 前缀取值（awk 已保证 line 以 prefix 起头）·仅入 local·绝不回显。
    verdict="$(printf '%s' "$blob" | node -e "$validator" 2>/dev/null)" || verdict="no"
    unset line blob
  fi
  [ "$verdict" = "yes" ]
}

# ── try_mark_switchable_from_vault：纯「手动恢复确认」路径（codex §7 P2-b·身份 guard 旁路）──────────────────
# **不从官方 keychain 捕获**——只确认 cc-master vault 自身**已有**该 email 的有效 blob，然后标 switchable:true，
#   **不依赖当前登录**、无 mislabel 风险（probe 读的是 vault 自身的有效 blob·token-blind·不碰官方 keychain）。
# 命中（vault 有有效 blob）→ 标 switchable:true + 打印成功提示 + return 0（caller 据此 exit 0·跳过身份 guard 失败）。
# 未命中（vault 无有效 blob）→ return 1（caller 维持身份 guard 失败的现有行为：既不能从 keychain 捕获[登录不对]、
#   又无可恢复的 vault blob）。本函数**绝不**读/写官方三存储、绝不捕获 keychain——只读 cc-master vault 自身。
try_mark_switchable_from_vault() {
  probe_vault_has_valid_blob || return 1
  # 手动恢复已完成（vault 已有含非空 refreshToken 的有效 blob）→ 升可切（与 print_manual_fallback 命中分支同义）。
  if write_registry_entry "" "" "true" >/dev/null 2>&1; then
    err "  ✓ 检测到 cc-master vault 已有 ${EMAIL} 的有效 blob（含非空 refreshToken）→ 已标 **switchable:true（可切）**。"
    err "    手动恢复闭环完成：该备号现已对 account-list.sh 可见、**计入 effective-N / 可被选号当备号**——无须当前登录匹配。"
    err "    （registry entry 全非密·不含 token；blob 仍只在你手动写入的 vault 里、脚本只 token-blind 探了「有没有」、绝不碰官方 keychain。）"
    return 0
  else
    # **registry 写失败 → 退非 0（codex round#9 Finding B·不谎报恢复成功）**：vault 有有效 blob，但 entry 没标成
    #   switchable:true → 该号仍被 select-account / effective-N 排除（恢复未生效）。返回非 0 让 caller 不 exit 0 谎报成功。
    err "  注意：检测到 vault 有有效 blob，但自动登记 registry entry 失败（坏 JSON / 不可写 / 锁超时）——**恢复未完成**："
    err "    该号尚未标 switchable:true、仍被选号 / effective-N 排除。修好 accounts.json 后重跑本脚本补登记。token 是安全的（从不经过脚本/registry）。"
    return 1
  fi
}

# ───────────────────────── fallback 手动录入（自动提取失败时·绝不静默/绝不存错）─────────────────────────
# 退回手工的安全骨架：打印让用户在自己终端跑的命令骨架，凭证由 OS 工具（security -w 交互提示）在用户终端静默收，
# 绝不经过本脚本变量。本函数**不收凭证**、只打印骨架。
# **无重启换号**：vault 应存**完整 claudeAiOauth blob**（单行 JSON·含 refresh token），故手动骨架引导用户从
#   keychain「Claude Code-credentials」直读完整 blob（用 node·绝不 jq），而非只录一段 access token。
print_manual_fallback() {
  err ""
  err "════════════════════════════════════════════════════════════════════"
  err "  自动提取失败（keychain「${KEYCHAIN_CRED_SERVICE}」无 item / refreshToken 空 / 非 mac credentials.json 残缺）。"
  err "  绝不静默、绝不存错——请确认你**当前登录的就是 ${EMAIL}**（Orca / claude login），再手动把**完整 blob**录入 vault："
  err "════════════════════════════════════════════════════════════════════"
  err ""
  err "  # mac：从 keychain 直读完整单行 blob（含 refresh token·无重启换号必需）："
  err "  BLOB=\$(security find-generic-password -w -s \"${KEYCHAIN_CRED_SERVICE}\" -a \"\$USER\" | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const o=JSON.parse(s).claudeAiOauth;process.stdout.write(JSON.stringify({accessToken:o.accessToken,refreshToken:o.refreshToken,expiresAt:o.expiresAt,scopes:o.scopes,subscriptionType:o.subscriptionType}))})')"
  if [ "$VAULT_KIND" = "keychain" ]; then
    err ""
    err "  # keychain vault 形态：blob 作 -w 的 argv 参数写入（**必须用 -w \"\$BLOB\"**——stdin 喂的 -w 走 readpassphrase 有 128 字节硬上限，~471 字节 blob 会被截成残片丢 refreshToken）："
    err "  security add-generic-password -U -s $KEYCHAIN_SERVICE -a $EMAIL -l \"cc-master OAuth: $EMAIL\" -w \"\$BLOB\"; unset BLOB"
    err ""
    err "  blob 作 security 的 argv 参数写入 keychain（避 128 截断·存完整合法 JSON）；blob 从不经过本脚本/agent，写完即 unset。"
  else
    err ""
    err "  # file 形态：单行 blob 写进 \$VAULT_FILE 的 <email>_TOKEN= 行（blob 单行·取行不截断）。"
    err "  # **全或无 + 精确前缀**（与 store_blob_file 同款·codex round#3/#11）：temp 里先写齐（只删本号**精确** _TOKEN="
    err "  #   行·绝不用宽 ${EMAIL}_ 前缀以免误删 sibling 如 ${EMAIL}_bar_TOKEN= ；append 新行）→ **每步用 && 串联·任一步"
    err "  #   失败就 rm \$VT 中止、绝不 mv**（否则 awk/printf 出错时 mv 仍会用只含新行的残缺 temp 覆盖 vault·丢别号·codex round#11）。"
    err "  umask 077; mkdir -p \"$(dirname "$VAULT_FILE")\" && \\"
    err "  VT=\"\$(mktemp \"$VAULT_FILE.XXXXXX\")\" && \\"
    err "  { [ ! -f \"$VAULT_FILE\" ] || awk -v t=\"${EMAIL}_TOKEN=\" 'index(\$0,t)!=1' \"$VAULT_FILE\" > \"\$VT\"; } && \\"
    if [ -n "$EXPIRES" ]; then
      err "  awk -v x=\"${EMAIL}_EXPIRES=\" 'index(\$0,x)!=1' \"\$VT\" > \"\$VT.2\" && mv \"\$VT.2\" \"\$VT\" && \\"
      err "  printf '%s_TOKEN=%s\\n' \"$EMAIL\" \"\$BLOB\" >> \"\$VT\" && \\"
      err "  printf '%s_EXPIRES=%s\\n' \"$EMAIL\" \"$EXPIRES\" >> \"\$VT\" && \\"
      err "  mv \"\$VT\" \"$VAULT_FILE\" || { rm -f \"\$VT\" \"\$VT.2\"; echo '录入失败·原 vault 原封不动（旧 token 存活）·未写入' >&2; }"
    else
      err "  printf '%s_TOKEN=%s\\n' \"$EMAIL\" \"\$BLOB\" >> \"\$VT\" && \\"
      err "  mv \"\$VT\" \"$VAULT_FILE\" || { rm -f \"\$VT\"; echo '录入失败·原 vault 原封不动（旧 token 存活）·未写入' >&2; }"
    fi
    err "  unset BLOB   # 写完即清（无论成功失败）。"
    err "  # 说明：上面整条用 && 串联——awk 筛旧行失败（vault 不可读）/ printf 写 temp 失败（磁盘满）等任一步出错都不会"
    err "  #   走到 mv，\$VT 被 rm、原 vault 原封不动（真全或无·旧 token 存活）。绝不用只含新行的残缺 temp 覆盖好 vault。"
  fi
  err ""
  err "  录完用 'security find-generic-password -s $KEYCHAIN_SERVICE -a $EMAIL'（不带 -w）或 account-list.sh 对账。"

  # ── fallback 也自动写一条**非密** registry entry，让该备号对号池可发现 ──
  # 病根：旧 fallback 存了（指引用户手动存）token 却**显式不写 accounts.json registry**——而 list/选号/effective-N
  #   全靠 registry 发现账号，故手动备号对号池**隐形**（除非用户显式 --email 覆写）。
  # 修：fallback 在打印手动存 token 指引的同时，**自动写好 registry entry**——registry entry 是**非密**的
  #   （email→vault 引用 + token_expires_at + 时间戳·**不含 token**），脚本能自己写（复用 write_registry_entry，
  #   它经 node upsertAccount 只传 email/vault 形态/时间戳，token 那一坨从不进 node、有 token-leak 断言兜底）。
  # **switchable 怎么标——先探 cc-master vault 是否已有有效 blob（手动恢复闭环·codex P2）**：
  #   - 旧逻辑无条件标 switchable:false，假设「重跑 --add 自动提取成功 → 升可切」。但**若自动提取仍失败**
  #     （非 mac / 官方登录非目标号），用户照手动指引把有效 blob 存进 vault 后**没东西翻 switchable:true**
  #     → 该号被 select-account / usage-pacing effective-N 永久排除、手动恢复路隐身。
  #   - 修：标 switchable 前先 probe_vault_has_valid_blob（token-blind·只返 yes/no）——
  #     · **vault 已有有效 blob**（手动恢复已完成）→ 标 **switchable:true**（升为可切）；
  #     · **vault 无 blob**（自动提取失败、token 待手动补）→ 维持 **switchable:false**（write_registry_entry 第 3 参
  #       传 "false"），否则 usage-pacing poolStatus / select-account 会把这条**没存 token** 的 entry 当可切
  #       capacity（它们不探 vault）→ phantom 备号 → 假「切号」pacing 提示 + 后续切号失败。switchable:false 时
  #       entry 仍**可发现**（account-list 列出）但**不计入 effective-N**（poolStatus / select-account 排除）。
  err ""
  if probe_vault_has_valid_blob; then
    # 手动恢复已完成（vault 已有含非空 refreshToken 的有效 blob）→ 升可切。
    if write_registry_entry "" "" "true" >/dev/null 2>&1; then
      err "  ✓ 检测到 cc-master vault 已有 ${EMAIL} 的有效 blob（含非空 refreshToken）→ 已标 **switchable:true（可切）**。"
      err "    手动恢复闭环完成：该备号现已对 account-list.sh 可见、**计入 effective-N / 可被选号当备号**——无须自动提取成功。"
      err "    （registry entry 全非密·不含 token；blob 仍只在你手动写入的 vault 里、脚本只 token-blind 探了「有没有」。）"
    else
      err "  注意：检测到 vault 有有效 blob，但自动登记 registry entry 失败（node/registry 写出错）——"
      err "    跑 account-list.sh 确认，或重跑本脚本。token 是安全的（从不经过脚本/registry）。"
    fi
  elif write_registry_entry "" "" "false" >/dev/null 2>&1; then
    err "  ✓ 已为你自动登记 accounts.json registry entry（email→vault 引用 + 时间元信息，**非密·不含 token**·标 switchable:false）——"
    err "    该备号现已对 account-list.sh **可见**（无须 --email 覆写），但因 vault 尚无有效 blob 而标 **不可切**（switchable:false）："
    err "    **不计入 effective-N / 不被选号当备号**（避免假「切号」提示）。"
    err "    **token 仍需你按上面指引手动存进 vault**：registry 已登记，token 那一坨脚本绝不碰、只走你手动的 vault 路径。"
    err "    存完后**重跑 \`--add ${EMAIL}\`**：脚本会**探测到 cc-master vault 已有有效 blob 并自动标为可切（switchable:true）**——"
    err "    **无需自动提取成功**（非 mac / 官方登录非目标号也能恢复），手动恢复路就此闭环。"
  else
    err "  注意：自动登记 registry entry 失败（node/registry 写出错）——手动存完 token 后跑 account-list.sh 确认，"
    err "    或重跑本脚本让探测到 vault 有效 blob 时补写 entry。token 是安全的（从不经过脚本/registry）。"
  fi
}

# ───────────────────────── 主流程 ─────────────────────────

# 到期日：用户给了就用；没给则 node 现算 now+365d（严格 ISO）。dry-run 也算（展示）。
if [ -z "$EXPIRES" ]; then
  EXPIRES="$(default_expires_iso)"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  info "── account-add.sh DRY-RUN（不真读 keychain、不真写 vault、不真写 registry）──"
  info "email          : $EMAIL"
  info "vault kind     : $VAULT_KIND"
  case "$VAULT_KIND" in
    keychain) info "vault target   : keychain service=$KEYCHAIN_SERVICE account=$EMAIL";;
    file)     info "vault target   : file=$VAULT_FILE key=${EMAIL}_TOKEN$([ -n "$EXPIRES" ] && echo " + _EXPIRES=$EXPIRES")";;
  esac
  info "registry       : $(node -e 'const l=require(process.argv[1]);process.stdout.write(l.defaultRegistryPath())' "$LIB_JS" 2>/dev/null || echo '<accounts.json>')  ← 写 email→vault 引用 + 时间元信息（非密，token 不进）"
  info "token_expires_at: ${EXPIRES:-<none>}"
  info "would guard     : 身份匹配——读 ${CLAUDE_JSON_PATH} 的 oauthAccount.emailAddress（当前登录身份），须 == --email ${EMAIL}（否则 FAIL·防把 B 的 blob 错标成 A）"
  info "                 claude.json $([ -f "$CLAUDE_JSON_PATH" ] && echo "存在" || echo "（不存在·未登录？guard 会 FAIL）")"
  info "would read blob: security find-generic-password -w -s \"${KEYCHAIN_CRED_SERVICE}\" -a \"\$USER\" | node …  # keychain 直读完整 blob（含 refreshToken·非空）·token-blind 经管道·绝不回显"
  info "                 keychain 直读不扰动登录（只读不写官方凭证）→ 无快照/恢复（旧 setup-token 副作用整套已删）"
  info "                 非 mac fallback：node 读 ${CREDENTIALS_JSON} → .claudeAiOauth（但该文件 refreshToken 可能空→校验拦下）"
  info "would identity : node 读 ${CLAUDE_JSON_PATH} → .oauthAccount → 单行 identity JSON（accountUuid/emailAddress/org… 16 字段·**全非密**）"
  info "would validate : blob 须有 accessToken(sk-ant-oat) + refreshToken(sk-ant-ort·非空) + expiresAt(num)；refreshToken 空/缺 → FAIL（绝不存残缺 switchable:false blob）"
  info "would store    : 完整 blob <redacted>（含 refresh token·单行 JSON·keychain 经 security -w \"\$blob\" argv 写入避 128 截断 / file awk 删旧行 + printf >> 文件，均不回显）"
  info "would register : accounts-lib upsertAccount（vault 引用 + 时间戳 + 非密 subscription_type + identity·**active:true 当前登录号**，token/blob 绝不进 node/registry）"
  info "                 token_expires_at = refresh token 长期有效期 ${EXPIRES:-now+365d}（**非** blob 内短期 access expiresAt）"
  info "would observe  : cc-usage → last_observed_quota（录号即当前登录号·5h/7d 配额准确·选号信号·best-effort·token-blind）"
  info "                 cc-usage 源：$CC_USAGE_SH$([ -f "$CC_USAGE_SH" ] || echo "（缺·跳过该弱信号）")"
  info "on read-fail   : keychain 无 item / refreshToken 空 → 手动骨架（绝不静默、绝不存错）"
  info "── end DRY-RUN（未读 keychain、未写 vault、未写 registry、未泄 token）──"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  err "error: 'node' not found in PATH — 无法读 blob / 写 accounts.json registry（accounts-lib.js 需 node）。"
  err "       （node 是 Claude Code 宿主天然在的 runtime；若缺则环境异常。）"
  exit 1
fi

# 1) 抓**身份**（主路径·从 ~/.claude.json oauthAccount）：= 当前登录号的非密身份（16 字段）。
#    identity 非密 → 可经 node stdout 回 bash 变量（与 token 不同）。也是身份 guard 的 email 来源。
NEW_IDENTITY="$(extract_identity_from_claude_json 2>/dev/null)" || NEW_IDENTITY=""

# 2) **身份匹配 guard**：--email 必须 == 当前登录身份的 email。
#    keychain「Claude Code-credentials」(account=$USER) 永远是**机器当前登录号**的 blob（与 --email 无绑定）。
#    若 --email != 当前登录 email，直读 keychain 会把**当前登录号 B 的 blob** 错标成 --email A 存进 vault/registry
#    （A 的 entry 实指 B 的凭证）→ 选号/换号灾难。故在读 blob 之前**硬 guard**：不匹配立刻 FAIL，提示用户先登录目标号再重跑。
#    **手动恢复旁路（codex §7 P2-b·补全 round-2 修复）**：身份 guard 的本意是防**从官方 keychain 捕获**时把 B 的
#    blob 错标成 A（捕获路必须 current-login==email）。但**手动恢复路不从官方 keychain 捕获**——它只确认 cc-master
#    vault 自身**已有**该 email 的有效 blob、然后标 switchable:true，**不依赖当前登录**、无 mislabel 风险。round-2
#    的 probe_vault_has_valid_blob 只在 print_manual_fallback 里跑，而身份 guard 在 fallback 之前就 exit → 登录在 B
#    （或登出）时重跑 `--add A` 根本到不了 probe，手动恢复/非 mac 号永久 switchable:false 隐身。故：身份 guard **会
#    失败时**（current-login 缺 / != --email），先跑 try_mark_switchable_from_vault（只读 vault 自身有效 blob·
#    token-blind·绝不碰官方 keychain）——vault 已有有效 blob → 标 switchable:true + exit 0（纯恢复标记·不因身份不
#    匹配 exit）；vault 无有效 blob → 维持身份 guard 失败的现有行为（既不能捕获[登录不对]又无可恢复的 vault blob）。
#    **捕获路（current-login==email 时从官方 keychain 直读）的身份 guard 完全不变**——只给「vault 已有有效 blob 的
#    纯恢复标记」开一条不依赖登录的旁路；登录匹配时正常捕获路径不受影响（两个 if 全 pass 才走下面的 keychain 直读）。
CURRENT_EMAIL="$(email_of_identity_json "$NEW_IDENTITY")"
if [ -z "$CURRENT_EMAIL" ]; then
  # 读不出当前登录 email → 不能从 keychain 捕获。先探 vault 是否已被手动恢复（旁路·不依赖登录）。
  if try_mark_switchable_from_vault; then exit 0; fi
  err "error: 无法从 ${CLAUDE_JSON_PATH} 的 oauthAccount 读出当前登录身份的 email（未登录 / CC 升级漂移 / 文件缺）。"
  err "       直读 keychain 录号需要确认「你当前登录的就是 ${EMAIL}」——请先登录 ${EMAIL}（Orca / claude login）再重跑。"
  err "       （或：把 ${EMAIL} 的完整 blob 手动存进 cc-master vault 后重跑——脚本会探测到并标 switchable:true·见下方手动指引。）"
  exit 1
fi
if [ "$CURRENT_EMAIL" != "$EMAIL" ]; then
  # 当前登录 != --email → 不能从 keychain 捕获（捕获会 mislabel）。先探 vault 是否已被手动恢复（旁路·不依赖登录·无 mislabel）。
  if try_mark_switchable_from_vault; then exit 0; fi
  err "error: 身份不匹配——你当前登录的是 ${CURRENT_EMAIL}、不是 ${EMAIL}。"
  err "       keychain「${KEYCHAIN_CRED_SERVICE}」存的是**当前登录号（${CURRENT_EMAIL}）**的凭证；若按 --email ${EMAIL} 录入，"
  err "       会把 ${CURRENT_EMAIL} 的 blob 错标成 ${EMAIL}（A 的 entry 实指 B 的凭证·选号/换号灾难）。"
  err "       要录 ${EMAIL}：请先登录它（Orca / claude login 切到 ${EMAIL}）再重跑本脚本。"
  err "       （或：把 ${EMAIL} 的完整 blob 手动存进 cc-master vault 后重跑——脚本会探测到 vault 有效 blob 并标 switchable:true·不依赖当前登录。）"
  exit 1
fi
info "→ 身份 guard 通过：当前登录身份 email == --email（${EMAIL}）——keychain 里就是它的 blob。"

# 3) **主路径**：直读 keychain「Claude Code-credentials」(account=$USER) 的完整 blob（含 refreshToken）。绝不 echo blob。
#    非 mac / 无 keychain item → 降级读 credentials.json 文件（但该文件 refreshToken 可能空·校验会拦下）。
blob="$(extract_blob_from_keychain 2>/dev/null)" || blob=""
if [ -z "$blob" ]; then
  err "→ 注意：从 keychain「${KEYCHAIN_CRED_SERVICE}」直读完整 blob 失败（无 item / refreshToken 空 / 非 mac）——降级读 credentials.json 文件。"
  blob="$(extract_blob_from_credentials 2>/dev/null)" || blob=""
fi

# 4) 校验 blob（三必需字段·含非空 refreshToken + 单行）。通过 → 存 vault + 写 registry。
if [ -n "$blob" ] && validate_blob "$blob"; then
  # 5) 成功 → 存完整 blob 进 vault（blob 含 refresh token·绝不回显）。
  if store_blob "$blob"; then
    # 抽出非密 subscription_type 给 registry（绝不带 token）；随后即可 unset blob。
    sub_type="$(subscription_type_of "$blob")"
    unset blob 2>/dev/null || true
    info "✓ 已从 keychain 直读完整 blob（含 refresh token）并存入 vault：email=${EMAIL} vault=${VAULT_KIND}（blob <redacted>，从不回显）。"
    if [ "$VAULT_KIND" = "file" ]; then
      info "  vault 文件：$VAULT_FILE$([ -n "$EXPIRES" ] && echo "（到期日 $EXPIRES 已记·refresh token 长期有效期）")"
    fi
    # 6) 写 registry entry（全非密·blob/token 已 unset、绝不进 node；带非密 subscription_type + identity）。
    #    被录号 = 当前登录（身份 guard 已确认）→ is_active="1"：upsert 后 setActive 标该号 active:true（其余 false·唯一性）。
    #    switchable="true"（第 3 参）：成功 add → vault 已有有效 blob → 显式标 entry.switchable=true，
    #      **覆写**之前 fallback 路径可能留下的 switchable:false（否则 select-account/usage-pacing 会继续把这个
    #      已补完 vault 的号当不可切排除·recovery 不生效）。fallback 路径仍传 "false"（vault 尚无 token·标不可切）。
    if write_registry_entry "$sub_type" "$NEW_IDENTITY" "true" "1"; then
      info "✓ 已写 accounts.json registry entry（email→vault 引用 + 时间元信息${sub_type:+ + subscription_type=$sub_type}${NEW_IDENTITY:+ + identity 身份} + active:true（当前登录号），非密）。"
      [ -z "$NEW_IDENTITY" ] && err "  （提示：未从 ~/.claude.json oauthAccount 抓到身份——换号时 ②段会降级保留旧 oauthAccount·登录显示可能不切；建议确认已登录后重跑 --add 补 identity。）"
      # 7) 优化①：录号那刻配额快照 last_observed_quota（best-effort·token-blind·失败不阻断）。
      #     仅在 registry entry 写成后才写（它要 upsert 在·recordObservedQuota 对不在池的号会抛错被容错）。
      write_observed_quota
      unset sub_type 2>/dev/null || true
      info "  对账（不取 blob 值）：account-list.sh  或  security find-generic-password -s $KEYCHAIN_SERVICE -a ${EMAIL}（不带 -w）"
      exit 0
    else
      # **registry 写失败 → 退非 0（codex round#9 Finding A·不谎报录号成功）**：vault 里 secret 是安全的，但号池 entry
      #   没写成 → 该号对 account-list / select-account / effective-N **不可见**（automation 不能当录号已成）。surface +
      #   exit 3（区别于干净成功的 0）：token 已安全进 vault，但需修好 accounts.json 后重跑补写 registry 才算录号完成。
      unset sub_type 2>/dev/null || true
      err "error: vault 已写好（凭证安全·已进 vault），但 accounts.json registry entry 写入失败（坏 JSON / 不可写 / 锁超时）——"
      err "  **录号未完成**：该号对 account-list / select-account / effective-N 不可见。修好 accounts.json 后**重跑 --add ${EMAIL}**"
      err "  补写 registry（脚本会探测到 vault 已有有效 blob·幂等补登记）。对账：account-list.sh。"
      exit 3
    fi
  else
    unset blob 2>/dev/null || true
    err "error: vault 写入失败——blob 未存。请检查上面的 vault 错误后重试，或走手动录入。"
    print_manual_fallback
    exit 1
  fi
fi

# ── 提取失败：keychain 无 item / refreshToken 空 / credentials.json 残缺 → 绝不静默、绝不存错 → 引导手动 ──
unset blob 2>/dev/null || true
err "✗ 未能取到含**非空 refreshToken** 的完整 blob——keychain「${KEYCHAIN_CRED_SERVICE}」无 item / refreshToken 空 / 非 mac credentials.json 残缺。"
err "  无重启换号死依赖 refreshToken（只有 keychain 完整 blob 有）——拒绝存残缺 blob（switchable:false 不可换入）。"
err "  多半你当前没真正 /login 登录 ${EMAIL}（setup-token 不产生 refreshToken）——请用 Orca / claude login 走完整 OAuth 登录后重跑。"
print_manual_fallback
exit 1
