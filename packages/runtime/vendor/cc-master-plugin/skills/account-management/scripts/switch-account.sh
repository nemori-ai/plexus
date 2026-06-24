#!/usr/bin/env bash
# switch-account.sh — out-of-band 账号切换 wrapper（方案 A 落地·NOT a hook）。
#
# 当一份订阅配额（5h/7d）逼近耗尽、而你还握着未消费的备号时，这是最重的一根
# pacing lever：探测逼顶 → **选最优切入号**（select-account.js）→ **从 vault 取下一号的完整 claudeAiOauth
# blob（含 refresh token）**（非变更性 preflight，任一失败即退出、registry 原封不动）→ **主动 refresh**
# （node https·refresh token 放 POST body·不进 argv）→ **回写 vault 保 refresh token 新鲜** → **覆写官方
# 共享凭证三存储**（① credentials.json .claudeAiOauth ② ~/.claude.json oauthAccount ③ keychain
# "Claude Code-credentials"/$USER·先非权威后权威·原子写）→ 全过之后才动 registry：对**切出号**写配额快照
# （recordSwitchOut·best-effort 可降级）+ 切入号置 active（setActive·与快照**解耦**、独立可靠落盘）。
#
# ★无重启换号（设计审查已过）：**不再 exec claude / 不重启进程 / 不 resume 板**。换号 = 覆写官方 claude CLI
#   读取的**共享**凭证存储——运行中的 claude 在 access token 临近过期时**惰性 refresh、重读存储**，于是被覆写的
#   新号被它接管。主路径是**主动 refresh**（写新鲜 8h token，claude 接管后近期不需再 refresh·消竞态）；主动
#   refresh 失败才退化到 force-refresh 兜底（覆写原 blob + expiresAt 临近过期逼 claude 自己 refresh·有 vault-stale 风险）。
#   换号**决策**方法论（何时换、谁拍板）在 orchestrating-to-completion 的 cost-and-pacing.md §换号 lever；
#   换号**机制**（本脚本 + 选号 + vault 安全）在本 skill（account-management）的 SKILL.md + references/。
#
# A2 形态（本次重构·设计稿 §C-T4）：从「用户手指 --account <key>」升级为
#   「**自动选号切入 + 切时写切出快照 + 从 accounts.json registry 取 vault 引用取 token**」。
#   - 切前选号：默认 `email=$(node select-account.js)`——按切出快照 + reset 推算选最优切入号；
#     `--email/--account` 保留为可选覆写（用户显式指定时跳过自动选号）。
#   - select 返回非 0：exit 3（全员逼顶）→ surface 用户（blocked_on:"user"，不硬切）；
#     其它非 0（无候选 / registry 不可用）→ 报「无备号可切」、保持现状。
#   - 取 token：从选中 email 的 registry entry 的 vault 引用（keychain {service,account} /
#     file {path,key}）按 kind 取——file vault 行匹配用 accounts-lib.fileVaultLineMatch 取前缀 +
#     **awk index($0,p)==1**（行首锚定、对 email 的 `.`/`@` 元字符免疫·§A.4 必修 bug + P2-5，绝不
#     grep -m1 "^…" 也绝不 grep -F（子串匹配，重叠标识下取错行→畸形整行注入·P2-5））。
#   - 写快照 + setActive（**两段解耦·codex 二审 P2-1/P2-2 修复**）：**先过全部非变更性 preflight**（选号 +
#     读 token），**才**动 registry——绝不像旧码那样在 token 读之前就翻 active（token 取不到时退出会留下
#     「registry 标新号 active、session 仍旧 token」的损坏态·P2-1）。registry 两件事**解耦、各自独立 save**：
#     ① 快照（recordSwitchOut）= 选号优化层、best-effort——cc-usage 出 local fallback（缺 used_percentage）
#        时 saveRegistry 拒写该快照，但这**只少一条快照**、绝不连累 active（P2-2 病根：旧码两者同一事务，快照
#        校验失败 → setActive 一起丢）；② setActive(切入号) = 必须忠实反映现实的关键状态、独立可靠落盘。
#   token 全程只活在脚本子进程、绝不进 agent context / registry（registry 写的是非密用量快照 + active 翻转）。
#
# 落点纪律（红线 1/5）：这是 out-of-band 脚本（像 cc-usage.sh / codex-review.sh），
# 主线在 pacing 决策点 deliberately 跑它——它**绝不进 hooks/**、不是 hook runtime、
# 不新增后台派发机制。它调 `claude` / `security` / `node` 等带外依赖（node 是 Claude Code
# 宿主天然在的 runtime，ADR-006）。Bedrock/Vertex/Foundry 云后端无订阅 5h/7d 配额窗口 →
# 换号概念不适用 → 探测拿不到订阅 used% → 自然 no-op（不破 ship-anywhere）。
#
# ───────────────────────────── 安全纪律（HARD，逐条不可破）─────────────────────────────
# bearer 凭证 = possession-equals-access。本脚本从 vault 读完整 OAuth blob（含 refresh token）进一个 shell
# 变量后：
#   · 绝不 echo / 绝不 print / 绝不写任何日志文件 / 绝不进 board / 绝不进 registry / 绝不
#     commit / 绝不拼进任何会被打印的字符串（连 set -x 都不开——见下）。
#   · 凭证去向：① **refresh** 时把 refresh token 放 node https 的 **POST body**（不进 argv·绝不用 curl 把 token
#     放命令行）；② **覆写官方三存储**时 ①② 文件经 node **stdin** 喂（不进 argv），③ keychain 用 `security -w
#     "$wrapped"`（值作 **argv** 参数·必须 argv：stdin 喂的 -w 走 readpassphrase 有 128 字节硬上限会截断 blob）；
#     ③ **回写 vault** keychain 同样 `security -w "$blob"` argv 写、file 经 printf 写。keychain argv 写是用户拍板
#     抉择 A 接受的 sub-second 本机局部暴露（token 仍绝不 echo/log/进 registry）。
#   · 选号 / 写快照 / 取 vault 引用全经 accounts-lib（node），**只传 email / vault 形态 /
#     非密用量给 node，token 那一坨从不进 node**——registry 零凭证（§A.1 不变式1）。
#   · 本脚本注释里所有示例 token 一律 <redacted> 占位，绝不写真值。
#   · 绝不跨机器拷 vault（token 可能含机器指纹；possession=access）。
# vault 路径必须在 gitignored 区（~/.claude/cc-master/ 或 ${CC_MASTER_HOME}，绝不在 repo
# 树内）；keychain 优先、0600 文件为 ship-anywhere floor。token 一年期到期是静默失败
# 模式——registry 的 token_expires_at + vault 旁存 <email>_EXPIRES 便于人工/选号巡检。
#
# ───────────────────────────────── 用法 ─────────────────────────────────
# switch-account.sh [--email <email>] [options]
#   --board   <selector>  **deprecated no-op**（无重启换号不重启进程·不再 resume 板）。保留为可选兼容旧调用方。
#   --email   <email>     可选覆写：要切到的备号 email（vault 里的 keychain account / file key）。
#                         **缺省 = 自动选号**（select-account.js 选最优切入号·设计稿 §B）。
#   --account <email>     --email 的旧别名（兼容；同样跳过自动选号）。
#   --registry <path>     accounts.json 路径覆写（默认 ${CC_MASTER_HOME:-~/.claude/cc-master}/accounts.json）。
#   --vault-kind keychain|file|env   token 存储形态覆写。缺省 = 从选中 email 的 registry vault.kind 读。
#   --vault-file <path>   --vault-kind=file 时的 0600 vault 文件（默认
#                         ${CC_MASTER_HOME:-~/.claude/cc-master}/accounts.env；缺省从 registry vault.path 读）。
#   --keychain-service <s>  --vault-kind=keychain 时的 service（默认 cc-master-oauth；缺省从 registry vault.service 读）。
#   --no-snapshot         不对切出号写配额快照（跳过 cc-usage 探测 + recordSwitchOut；调试用）。
#   --now <ISO>           选号 / 快照的「现在」时刻覆写（确定性测试用）。
#   --dry-run             打印「将做什么」(token 永远 <redacted>)、**不真 exec、不真切、不真写 registry**。
#   --skip-token-check    （仅 --dry-run）允许在 vault 取不到 token 时仍走完逻辑打印计划。
#
# 退出码：0 成功（dry-run 走完 / 真 exec 不返回）；2 = 参数/前置校验失败；
#         3 = 全员逼顶（select-account exit 3）→ surface 用户、未切；非 0 其它 = vault/选号失败。
#
# 这个脚本**只**做「选号 + refresh + 覆写三存储 + 写快照」这一机械动作。探测（cc-usage.sh）、drain（handoff）
# 由主线编排器在调用本脚本前后驱动（见 cost-and-pacing.md §换号 lever）——指挥协调、脚本只演奏换号那一下
# （红线 4）。选号是机械选择、切不切仍由编排者/用户拍——尤其全员逼顶（exit 3）要 surface 用户（对齐 7d 总闸纪律）。

# 安全（HARD，token no-leak 第一要务）：本脚本会把 bearer blob 读进 shell 变量、再经 refresh POST body /
#   node stdin / security stdin 注入。**xtrace（set -x）会把变量赋值与命令实参回显到 stderr——直接打印明文凭证，
#   破 no-leak 契约**。两条来源都要堵：
#     ① 有人 `bash -x switch-account.sh` 显式调试；
#     ② env 继承的 xtrace（如 `export SHELLOPTS=xtrace` / `set -x` 后 source 本脚本）。
#   故在任何 vault 读之前**无条件关掉 xtrace**：`set +x` 关本 shell 的 xtrace 位，并 `unset
#   SHELLOPTS`（②的载体——bash 启动时据它恢复 set 选项；清掉它防 xtrace 被继承回来）。这必须是
#   脚本的**第一条可执行语句**，先于任何会碰 token 的代码。set -u 防未定义变量误用。
set +x                  # 关 xtrace（防凭证赋值 / 命令行被 trace 出来）；这是真正的关 trace 动作
# 防 env 继承的 xtrace（SHELLOPTS=xtrace）在子 shell 里复活 set -x。SHELLOPTS 在部分 bash 下是
# readonly（unset 会报错），故吞掉失败——真正关 trace 的是上一行 `set +x`，本行只是额外加固。
unset SHELLOPTS 2>/dev/null || true

# ───────────────────────── 云后端自检（红线 5，no-op 退出·先于任何 token 读）─────────────────────────
# Bedrock/Vertex/Foundry 是模型后端、非订阅口径：没有 5h/7d 订阅配额窗口、没有可换的订阅 OAuth token。
# 在这些后端上跑换号 = 顶替云 auth / 必然失败。故在**取任何 token 之前**（紧随 set +x、先于 set -u 与 arg
# 解析）自检三个云开关——任一为真 → 提示「云后端无订阅配额、换号不适用」+ **no-op 退出（exit 0）**，
# 绝不取 token、绝不选号、绝不 exec。镜像 accounts.md Step 1 的逻辑（命令体写侧 / 脚本切侧两端一致）。只读 env、不碰 token。
if [ -n "${CLAUDE_CODE_USE_BEDROCK:-}" ] || [ -n "${CLAUDE_CODE_USE_VERTEX:-}" ] || [ -n "${CLAUDE_CODE_USE_FOUNDRY:-}" ]; then
  printf '%s\n' "switch-account: 云后端（Bedrock/Vertex/Foundry）无订阅 5h/7d 配额窗口、无可换的订阅 OAuth token —— 换号不适用，no-op 退出。" >&2
  exit 0
fi

set -uo pipefail

# ───────────────────────── 路径自解析（self-contain·T7 搬入后的同目录 + 跨 skill 引用）─────────────────────────
# 本脚本（T7 后）住 ${CLAUDE_PLUGIN_ROOT}/skills/account-management/scripts/。它的依赖分两类：
#   ① 同 skill 同目录兄弟：accounts-lib.js / select-account.js —— 与本脚本同住 account-management/scripts/，
#      用 $SCRIPT_DIR 直接引用（同目录、不跨 skill，绝不裸相对路径·Finding #38/#50）。
#   ② 跨 skill：cc-usage.sh —— 它是 pacing 信号工具、属 orchestrating-to-completion，住
#      ${CLAUDE_PLUGIN_ROOT}/skills/orchestrating-to-completion/scripts/。跨 skill 引用必须
#      ${CLAUDE_PLUGIN_ROOT}/skills/<name>/… 绝对（绝不裸相对路径·Finding #38/#50）；缺 CLAUDE_PLUGIN_ROOT
#      时（dev / 直接 bash 跑）从本脚本所在目录上溯两级到 skills/ 再下到兄弟 skill（plugin 内相对稳定，两 skill 都 ship）。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# ① 同目录兄弟（account-management skill 自身的 scripts/）。
LIB_JS="${SCRIPT_DIR}/accounts-lib.js"
SELECT_JS="${SCRIPT_DIR}/select-account.js"

# ② 跨 skill：cc-usage.sh 住 orchestrating-to-completion 的 scripts/。
#   解析顺序：① CLAUDE_PLUGIN_ROOT（装机后 harness 注入）；② dev 兜底——scripts → account-management →
#   skills → 再下到 orchestrating-to-completion/scripts（self-contain·Finding #38）。
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -d "${CLAUDE_PLUGIN_ROOT}/skills/orchestrating-to-completion/scripts" ]; then
  ORCH_SCRIPTS="${CLAUDE_PLUGIN_ROOT}/skills/orchestrating-to-completion/scripts"
else
  # scripts → account-management → skills，再下到 orchestrating-to-completion/scripts。
  ORCH_SCRIPTS="$(cd "$SCRIPT_DIR/../.." 2>/dev/null && pwd)/orchestrating-to-completion/scripts"
fi
CC_USAGE_SH="${ORCH_SCRIPTS}/cc-usage.sh"

# ───────────────────────── helpers ─────────────────────────
# 所有诊断走 stderr；stdout 留给「计划」输出。绝不在任何路径打印 token 变量。
err()  { printf '%s\n' "$*" >&2; }
plan() { printf '%s\n' "$*"; }    # dry-run 计划行（绝不含 token）

# ── 文件锁封装（codex round#9 Finding C·file vault 跨进程串行化·同 account-add/delete）─────────────────────
# 锁住 file vault（accounts.env）writeback 的「读-筛-写-rename」整段，防与并发 delete/add 互踩（最后 mv 者赢会复活
#   已删 token / 丢别号刚写 blob）。用 accounts-lib 通用文件锁（O_EXCL + owner token + stale 回收）·锁文件零 token。
# **fail-closed（codex round#10）**：取锁失败（contention 超时 / 建不了锁文件）→ **绝不无锁跑临界区**（那会重现锁要防
#   的 race），return 1·不执行 command。writeback 回写失败非致命（caller surface 后换号继续·只是 vault token 没更新到最新）。
with_vault_lock() { # $1 = vault file path; $2... = command (+args) to run while holding the lock
  local vf="$1"; shift
  local owner=""
  # 记本 bash 进程的 $$ 当锁 livePid（codex round#13 Finding A·锁记录的 pid 必须在临界区期间活着·否则并发对手判 stale 破锁）。
  owner="$(node -e 'try{const l=require(process.argv[1]);const h=l.acquireFileLock(process.argv[2],{livePid:Number(process.argv[3])});process.stdout.write(h.owner||"")}catch(e){process.exit(1)}' "$LIB_JS" "$vf" "$$" 2>/dev/null)" || owner=""
  if [ -z "$owner" ]; then
    err "writeback: 无法取得 vault 文件锁（${vf}.lock·另有进程长时间持锁 / node 不可用）——**拒绝无锁回写 vault**（防并发互踩），未回写。"
    return 1
  fi
  "$@"; local rc=$?
  node -e 'try{const l=require(process.argv[1]);l.releaseFileLock({path:process.argv[2]+".lock",owner:process.argv[3]})}catch(_e){}' "$LIB_JS" "$vf" "$owner" 2>/dev/null
  return $rc
}

usage() {
  err "usage: switch-account.sh [--email <email>] [--registry <path>]"
  err "       [--vault-kind keychain|file|env] [--vault-file <path>] [--keychain-service <s>]"
  err "       [--board <selector>] [--no-snapshot] [--now <ISO>] [--dry-run] [--skip-token-check]"
  err ""
  err "  无重启换号：覆写官方共享凭证三存储（\$USER 视角）→ 运行中 claude 惰性重读接管新号（不重启进程）。"
  err "  --email 缺省 = 自动选号（select-account.js 选最优切入号）。--board 已 deprecated（no-op·不再 resume 板）。"
}

# ───────────────────────── arg 解析（无真 token 也能安全 smoke）─────────────────────────
EMAIL=""; BOARD_SEL=""; DRY_RUN=0; SKIP_TOKEN_CHECK=0; NO_SNAPSHOT=0; NOW_OVERRIDE=""
EMAIL_EXPLICIT=0          # 用户显式 --email/--account → 跳过自动选号
VAULT_KIND=""             # 缺省从 registry vault.kind 读；--vault-kind 覆写
VAULT_KIND_EXPLICIT=0
KEYCHAIN_SERVICE=""       # 缺省从 registry vault.service 读；--keychain-service 覆写
KEYCHAIN_SERVICE_EXPLICIT=0
REGISTRY_PATH=""          # 缺省 = accounts-lib defaultRegistryPath()
# A2 §A.1 / G#1：file vault 默认统一到 accounts.json 同一用户级 home（~/.claude/cc-master）。
VAULT_FILE="${CC_MASTER_HOME:-${HOME}/.claude/cc-master}/accounts.env"
VAULT_FILE_EXPLICIT=0

# value 型 flag 缺值守卫（robustness·codex §7 P2-a·防死循环）：value 型 flag 缺第二个 arg 时 `shift 2` 失败、
#   arg list 不变 → `while [ $# -gt 0 ]` 死循环到被 kill（脚本上半身 set -uo pipefail 但无 set -e）。故每个 `shift 2`
#   前先确认存在第二个 arg（`[ $# -ge 2 ]`），缺值则 error+usage 退非 0（绝不死循环）。
need_val() { [ "$#" -ge 2 ] || { err "error: option '$1' requires a value."; usage; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --email|--account)  need_val "$@"; EMAIL="$2"; EMAIL_EXPLICIT=1; shift 2;;
    --board)            need_val "$@"; BOARD_SEL="$2"; shift 2;;
    --registry)         need_val "$@"; REGISTRY_PATH="$2"; shift 2;;
    --vault-kind)       need_val "$@"; VAULT_KIND="$2"; VAULT_KIND_EXPLICIT=1; shift 2;;
    --vault-file)       need_val "$@"; VAULT_FILE="$2"; VAULT_FILE_EXPLICIT=1; shift 2;;
    --keychain-service) need_val "$@"; KEYCHAIN_SERVICE="$2"; KEYCHAIN_SERVICE_EXPLICIT=1; shift 2;;
    --no-snapshot)      NO_SNAPSHOT=1; shift;;
    --now)              need_val "$@"; NOW_OVERRIDE="$2"; shift 2;;
    --dry-run)          DRY_RUN=1; shift;;
    --skip-token-check) SKIP_TOKEN_CHECK=1; shift;;
    -h|--help)          usage; exit 0;;
    *) err "unknown arg: $1"; usage; exit 2;;
  esac
done

# --board：**deprecated no-op**（无重启换号不重启进程、不再 resume 板·设计审查已过）。保留为可选兼容旧调用方。
#   旧形态（exec claude --resume <板>）已删——换号现在覆写官方共享凭证三存储、claude 进程惰性重读接管新号，
#   不换 session、不需 board-resume。传了也无害（仅在 dry-run 计划里标 deprecated）；不传是正常路径。

if ! command -v node >/dev/null 2>&1; then
  err "error: 'node' not found in PATH — 选号 / 读 registry / 写快照都需 node（accounts-lib.js·ADR-006）。"
  err "       （node 是 Claude Code 宿主天然在的 runtime；若缺则环境异常。）"
  exit 1
fi
if [ ! -f "$LIB_JS" ]; then
  err "error: 找不到 accounts-lib.js（${LIB_JS}）——无法读 registry / 选号 / 写快照。"
  err "       检查 CLAUDE_PLUGIN_ROOT 或脚本所在 plugin 布局（account-management skill 应随 plugin 分发）。"
  exit 1
fi

# REGISTRY_PATH 缺省 = accounts-lib 的 defaultRegistryPath（与 add/list/delete 一致）。
if [ -z "$REGISTRY_PATH" ]; then
  REGISTRY_PATH="$(node -e 'process.stdout.write(require(process.argv[1]).defaultRegistryPath())' "$LIB_JS" 2>/dev/null || true)"
fi

# ───────────────────────── 切前选号（select-account.js·设计稿 §B）─────────────────────────
# 用户没显式 --email → 自动选号：node select-account.js 打印选中 email 到 stdout、退出码区分结果：
#   0 = 选中（email 在 stdout）；3 = 全员逼顶（NONE_ALL_EXHAUSTED·surface 用户、不硬切）；
#   1 = 无候选 / registry 不可用（无备号 / 单账号）。stderr 走 reason+warnings（不污染 stdout 纯 email）。
# token-blind：select-account.js 完全不碰 token，只读 accounts.json 非密元信息。
if [ "$EMAIL_EXPLICIT" -ne 1 ]; then
  if [ ! -f "$SELECT_JS" ]; then
    err "error: 找不到 select-account.js（${SELECT_JS}）——无法自动选号。显式传 --email <email> 覆写，或检查 plugin 布局。"
    exit 1
  fi
  # select 的 stderr（reason / warnings / 临近到期 / local-derived-approx 口径不可靠）**捕获后透传**给用户；
  # stdout 仍是纯 email（下游靠它）。P2-14：旧码 `2>/dev/null` 把选号器**自己生成的可操作警告**（选中号
  # token 临近到期 / 快照口径不可靠 / reason）一并吞进黑洞——换号照常进行却隐藏了正是该次选号的告警。改为：
  # 把 stderr 引到一个临时文件（非 token——select-account.js token-blind、stderr 无凭证，但仍按非密处理），
  # stdout 取纯 email；选号成功后把捕获的 stderr 警告透传给用户（exit 3 / exit 1 分支已有各自的 err 提示）。
  sel_args=(--registry "$REGISTRY_PATH")
  [ -n "$NOW_OVERRIDE" ] && sel_args+=(--now "$NOW_OVERRIDE")
  tmp_sel_err="$(mktemp "${TMPDIR:-/tmp}/.ccm-sel-err.XXXXXX")"
  EMAIL="$(node "$SELECT_JS" "${sel_args[@]}" 2>"$tmp_sel_err")"; sel_rc=$?
  # rc 决定分支 + 给用户可操作信息；捕获的 stderr 在成功分支透传，所有出口前清理临时文件。
  if [ "$sel_rc" -eq 3 ]; then
    [ -s "$tmp_sel_err" ] && err "$(cat "$tmp_sel_err")"
    rm -f "$tmp_sel_err"
    err "switch-account: 所有可切换备号都已逼顶 / 不可用（select-account NONE_ALL_EXHAUSTED）。"
    err "  这是 blocked_on:\"user\" 决策——是等 5h/7d reset 还是别的，请用户拍板。**未切换**。"
    err "  细看排名：node \"$SELECT_JS\" --registry \"$REGISTRY_PATH\" --json"
    exit 3
  fi
  if [ "$sel_rc" -ne 0 ] || [ -z "$EMAIL" ]; then
    [ -s "$tmp_sel_err" ] && err "$(cat "$tmp_sel_err")"
    rm -f "$tmp_sel_err"
    err "switch-account: 选号未选出可切入号（无备号 / registry 不可用 / 单账号场景）——保持现状、未切换。"
    err "  先用 /cc-master:accounts --add <email> 录备号，或显式 --email <email>。"
    err "  细看：node \"$SELECT_JS\" --registry \"$REGISTRY_PATH\" --json"
    exit 1
  fi
  # 选号成功：透传选号器在 stderr 出的**可操作警告**（选中号 token 临近到期 / 快照 local-derived-approx
  # 口径不可靠 / reason）——这正是 P2-14 旧码 2>/dev/null 吞掉的那条信息。换号照常进行，但不再隐藏告警。
  [ -s "$tmp_sel_err" ] && err "$(cat "$tmp_sel_err")"
  rm -f "$tmp_sel_err"
  err "switch-account: 自动选号 → 切入号 = ${EMAIL}（按切出快照 + reset 推算的最优切入号·§B）。"
else
  if [ -z "$EMAIL" ]; then
    err "error: --email/--account 传了空值。"
    usage; exit 2
  fi
  err "switch-account: 用户显式指定切入号 = ${EMAIL}（跳过自动选号）。"
fi

# ───────────────────────── 从 registry 读选中 email 的 vault 引用 ─────────────────────────
# 读 selected email 的 vault {kind, service/path, account/key:email}——全非密。
#   --vault-kind / --keychain-service / --vault-file 显式给则覆写 registry 值（调试 / registry 缺该 entry 时）。
#   node 输出三行：kind、service-or-path、account-or-key（都非密）；registry 缺该 entry → 输出空 kind，bash 兜底。
REG_VAULT_KIND=""; REG_VAULT_SVC_OR_PATH=""; REG_VAULT_ACCT_OR_KEY=""
# REG_IDENTITY_JSON：切入号的 registry identity（= ~/.claude.json oauthAccount 原样·**全非密**·身份补全重构）。
#   覆写官方三存储 ②段用它完整替换 oauthAccount，让换号真切**身份**（accountUuid/emailAddress/org…），不只切 token。
#   identity 非密 → 可经 node stdout 回 bash 变量（与 token 不同·token 仍绝不回显）。缺/无 identity → 空 → ②段降级。
REG_IDENTITY_JSON=""
if [ -n "$REGISTRY_PATH" ] && [ -f "$REGISTRY_PATH" ]; then
  # 三行输出（kind / svc-or-path / acct-or-key）；任何异常 → 空（bash 用 flag/默认兜底）。绝不读 token。
  reg_vault="$(node -e '
    "use strict";
    try {
      const lib = require(process.argv[1]);
      const reg = lib.loadRegistry(process.argv[2]);
      const e = (reg.accounts && reg.accounts[process.argv[3]]) || {};
      const v = e.vault || {};
      const kind = (v.kind === "keychain" || v.kind === "file") ? v.kind : "";
      const svcOrPath = kind === "keychain" ? (v.service || "") : (kind === "file" ? (v.path || "") : "");
      const acctOrKey = kind === "keychain" ? (v.account || "") : (kind === "file" ? (v.key || "") : "");
      process.stdout.write([kind, svcOrPath, acctOrKey].join("\n"));
    } catch (_e) { /* 缺/坏 registry → 空输出，bash 兜底 */ }
  ' "$LIB_JS" "$REGISTRY_PATH" "$EMAIL" 2>/dev/null || true)"
  # 逐行拆（IFS=newline；用 read 取前三行，避免 token 之类干扰——这里只有非密 vault 引用）。
  REG_VAULT_KIND="$(printf '%s\n' "$reg_vault" | sed -n '1p')"
  REG_VAULT_SVC_OR_PATH="$(printf '%s\n' "$reg_vault" | sed -n '2p')"
  REG_VAULT_ACCT_OR_KEY="$(printf '%s\n' "$reg_vault" | sed -n '3p')"
  # identity 单独一次 node 读（**全非密**·单行 JSON·缺/无 → 空）。绝不读 token——只取 entry.identity（身份对象）。
  REG_IDENTITY_JSON="$(node -e '
    "use strict";
    try {
      const lib = require(process.argv[1]);
      const reg = lib.loadRegistry(process.argv[2]);
      const e = (reg.accounts && reg.accounts[process.argv[3]]) || {};
      const id = e.identity;
      if (id && typeof id === "object" && !Array.isArray(id) && Object.keys(id).length > 0) process.stdout.write(JSON.stringify(id));
    } catch (_e) { /* 缺/坏 → 空·②段降级 */ }
  ' "$LIB_JS" "$REGISTRY_PATH" "$EMAIL" 2>/dev/null || true)"
fi

# 决定最终 vault 形态：显式 flag > registry 值 > 默认。
if [ "$VAULT_KIND_EXPLICIT" -ne 1 ]; then
  if [ -n "$REG_VAULT_KIND" ]; then
    VAULT_KIND="$REG_VAULT_KIND"
  else
    VAULT_KIND="keychain"   # registry 无该 entry / 缺 vault → 默认 keychain（mac floor）。
  fi
fi
case "$VAULT_KIND" in
  keychain|file|env) ;;
  *) err "error: vault kind must be one of keychain|file|env (got: $VAULT_KIND)"; exit 2;;
esac
# keychain service：显式 > registry > 默认。
if [ "$KEYCHAIN_SERVICE_EXPLICIT" -ne 1 ]; then
  if [ "$VAULT_KIND" = "keychain" ] && [ -n "$REG_VAULT_SVC_OR_PATH" ]; then
    KEYCHAIN_SERVICE="$REG_VAULT_SVC_OR_PATH"
  else
    KEYCHAIN_SERVICE="cc-master-oauth"
  fi
fi
# file vault path：显式 > registry > 默认。
if [ "$VAULT_FILE_EXPLICIT" -ne 1 ] && [ "$VAULT_KIND" = "file" ] && [ -n "$REG_VAULT_SVC_OR_PATH" ]; then
  VAULT_FILE="$REG_VAULT_SVC_OR_PATH"
fi

# ───────────────────────── 切出号配额快照 + setActive（两段解耦·P2-1/P2-2 修复·设计稿 §B.7）─────────────────────────
# **时序与解耦纪律（P2-1 / P2-2 修复·codex 二审）**：换号必须先过**全部非变更性 preflight**（选号 +
#   读 token），**才允许动 registry**。registry 里两件要写的事——快照（snapshot）与 active 翻转
#   （setActive）——**严重度不同、必须解耦**：
#     · **snapshot（recordSwitchOut）= 选号优化层**：best-effort、可降级。cc-usage 出 local fallback（缺
#       used_percentage）时 used_pct=undefined、saveRegistry 会拒写该快照——这**只该少一条快照**，绝不该
#       连累 active 翻转（P2-2 病根：旧码把两者塞进同一 saveRegistry 事务，快照校验失败 → setActive 一起丢）。
#     · **setActive = 必须忠实反映现实的关键状态**：一旦 token 读成功、即将 exec 换号，registry 的 active
#       必须翻到切入号。它**独立、可靠地落盘**（与 snapshot 分两次 save），即便 snapshot 那次失败，setActive
#       仍须成功。
#   故拆成两个函数：record_switch_out()（只写快照，失败容忍）+ set_active_in()（只翻 active，可靠）。
#   **调用顺序在 token 读成功之后**（见下方 vault 读取段后）：record_switch_out → set_active_in → exec。
#   token-blind：cc-usage.sh 只读本地 JSONL / sidecar 算用量，recordSwitchOut/setActive 只写非密字段，绝不碰 token。
SNAPSHOT_PLAN="(skipped: --no-snapshot)"
ACTIVE_PLAN="(not yet set)"
CURRENT_ACTIVE=""
ACTIVE_WRITE_FAILED=0   # set_active_in 落盘失败时置 1（codex round#2 Finding B·最终消息如实标注·不谎报干净成功）。

# 读当前 active 号（registry 维护的「cc-master 换号视角的 active」）。供快照与 dry-run 计划共用。
# 无 active → 无切出号（首次换号 / 单账号建池）。绝不读 token。
detect_current_active() {
  CURRENT_ACTIVE="$(node -e '
    "use strict";
    try {
      const lib = require(process.argv[1]);
      const reg = lib.loadRegistry(process.argv[2]);
      const accts = reg.accounts || {};
      for (const [email, e] of Object.entries(accts)) {
        if (e && e.active === true) { process.stdout.write(email); break; }
      }
    } catch (_e) { /* 缺/坏 registry → 无 active，空输出 */ }
  ' "$LIB_JS" "$REGISTRY_PATH" 2>/dev/null || true)"
}

# ── (A) snapshot（best-effort·可降级）：只对切出号 recordSwitchOut + saveRegistry，绝不碰 active。──
#   失败（快照校验拒写 / registry 写出错 / cc-usage 降级）= 仅少一条快照，**绝不**阻断换号、绝不连累 setActive。
#   **切出号身份必须在 set_active_in 翻 active 之前捕获（codex round#1 Finding 2·split-brain 窗口收口）**：
#   真切路径已把调用顺序改成 set_active_in（关键态·先）→ record_switch_out（best-effort·后），让慢/挂的
#   cc-usage 不再卡在「机器已切新号、registry 仍旧号」窗口。但 set_active_in 一旦翻 active，registry 里的
#   active 已是切入号——此时再 detect_current_active 会把**切入号**当切出号（CURRENT_ACTIVE==EMAIL → 跳过快照）。
#   故调用方在翻 active **之前**先 detect_current_active 把切出号钉进 CURRENT_ACTIVE；本函数**仅当 CURRENT_ACTIVE
#   仍空**才自己探（兼容旧调用 / dry-run 路径）——已被钉好则复用，绝不被翻转后的 active 污染。
record_switch_out() {
  [ -n "$CURRENT_ACTIVE" ] || detect_current_active
  if [ -z "$CURRENT_ACTIVE" ]; then
    SNAPSHOT_PLAN="(no current active account in registry — 首次换号 / 单账号建池，无切出快照可写)"
    return 0
  fi
  if [ "$CURRENT_ACTIVE" = "$EMAIL" ]; then
    SNAPSHOT_PLAN="(current active == switch-in target $EMAIL — 已是该号，无需切出快照)"
    return 0
  fi

  # cc-usage.sh 拿账户权威 {source, five_hour:{used_percentage,resets_at}, seven_day:{...}}。缺/降级则 source=local-derived-approx。
  # ── best-effort 时限（codex round#2 Finding 3·照搬 account-add.sh write_observed_quota 的 timeout 写法）─────────
  #   病根：这个切出快照里的 cc-usage 无 timeout，跑在覆写官方存储**之后**、setActive **之前**——真 cc-usage 读当前
  #   session 巨 JSONL 算用量、超长 session 下极慢；slow/hung 会让机器已切到新号、但 accounts.json 还标旧号 active。
  #   修：用「后台跑进临时文件 + watchdog 轮询 + 超时 kill」可移植模式（无 timeout/gtimeout 依赖·macOS 上它们不保证在）
  #   给它兜上限（CC_USAGE_TIMEOUT_S 默认 60s·可 env 覆写）。超时/失败 → usage_json 空 → 优雅降级（配额字段留空·仍写
  #   last_switch_out 时间戳·继续到 setActive）。best-effort·绝不 wedge 换号。token 安全：cc-usage 本就 token-blind；
  #   临时文件只承非密用量 JSON、用完即删；kill 只针对 cc-usage 子进程、不碰任何 token。
  local usage_json=""
  if [ -f "$CC_USAGE_SH" ]; then
    local cu_args=()
    [ -n "$NOW_OVERRIDE" ] && cu_args+=(--now "$NOW_OVERRIDE")
    local timeout_s="${CC_USAGE_TIMEOUT_S:-60}"
    local usage_tmp
    usage_tmp="$(mktemp 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}/cc-usage-so.$$.tmp")"
    # set -u + bash 3.2（macOS floor）：空数组 "${cu_args[@]}" 展开会 `unbound variable` 报错（cu_args
    #   只在 NOW_OVERRIDE 非空时才 += 元素，正常换号路径它是空数组）。用 ${arr[@]:-} 守卫——空时展开成单个
    #   空串参数（cc-usage.sh 无参运行本就合法，多一个空串 arg 无害；round-3 只扫了 `shift 2`、漏了数组展开）。
    ( bash "$CC_USAGE_SH" "${cu_args[@]:-}" >"$usage_tmp" 2>/dev/null ) &
    local ccu_pid=$!
    # 轮询最多 timeout_s 秒（0.2s 步进 → 5 次/秒）。子进程退出即提前 break。
    local waited=0 max_ticks=$(( timeout_s * 5 ))
    while [ "$waited" -lt "$max_ticks" ]; do
      kill -0 "$ccu_pid" 2>/dev/null || break
      sleep 0.2
      waited=$(( waited + 1 ))
    done
    if kill -0 "$ccu_pid" 2>/dev/null; then
      # 超时仍在跑 → kill（防巨 JSONL 下无限等·让机器卡在「已切新号、registry 仍旧号」半态）。TERM 后短等再 KILL 兜底。
      kill "$ccu_pid" 2>/dev/null || true
      sleep 0.2
      kill -9 "$ccu_pid" 2>/dev/null || true
      err "switch-account: cc-usage.sh 超过 ${timeout_s}s 未返回（多半当前 session JSONL 过大）——已中止，切出快照配额字段留空（仍写 last_switch_out 时间戳）。"
    fi
    wait "$ccu_pid" 2>/dev/null || true
    usage_json="$(cat "$usage_tmp" 2>/dev/null || true)"
    rm -f "$usage_tmp" 2>/dev/null || true
  fi

  # node：解析 cc-usage 输出 → 规整成 recordSwitchOut 的 {fiveHour,sevenDay}.{used_pct,resets_at,source}
  #   （cc-usage 给 used_percentage[account] 或反推；resets_at 是 epoch 秒 → 转严格 ISO；缺则留空）。
  #   **本块只读-改-写 last_switch_out**：loadRegistry → recordSwitchOut(切出号) → saveRegistry（原子+校验）。
  #   **绝不在此 setActive**（active 翻转拆到 set_active_in()·P2-2 解耦：快照校验失败不连累 active）。
  #   绝不传 token；usage_json 是非密用量。--now 透传给 ISO 转换（确定性）。
  local rec_out
  rec_out="$(node -e '
    "use strict";
    const lib = require(process.argv[1]);
    const [ , , regPath, switchOutEmail, usageRaw, nowOverride ] = process.argv;

    function epochToIso(ep) {
      if (typeof ep !== "number" || !isFinite(ep)) return undefined;
      // cc-usage 的 resets_at 是 epoch 秒。→ 严格 ISO-8601 UTC（秒精度、Z）。
      return new Date(ep * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    }
    function intPct(v) {
      const n = Number(v);
      if (!isFinite(n)) return undefined;
      const r = Math.round(n);
      return Math.max(0, Math.min(100, r)); // 钳到 [0,100]（lib 校验 used_pct 是 0-100 整数）。
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

    const fiveWin = win(fh);
    const sevenWin = win(sd);
    // ── 优雅降级闸（P2-2 病根的根治·bug 2）：快照是 pacing 的**可选观测**，丢了非致命。cc-usage 降级/超时
    //   （used_percentage 缺失）→ intPct 返回 undefined → used_pct 非 0-100 整数 → saveRegistry 会 throw + 吐
    //   node stack trace（换号核心其实已不受影响、active 仍翻转，但 trace 看着像崩）。**在构造/落盘快照之前先判
    //   used_pct 是否有效**：任一窗口 used_pct 非 0-100 整数 → **干净跳过这条快照**（不把 undefined 塞进 registry、
    //   绝不调用会 throw 的 saveRegistry），打一行清爽提示（非 stack-trace）后退出。换号核心（三存储覆写 + active
    //   翻转）此前已完成、与本块完全独立，跳过快照绝不回滚换号。
    const pctOk = (v) => Number.isInteger(v) && v >= 0 && v <= 100;
    if (!pctOk(fiveWin.used_pct) || !pctOk(sevenWin.used_pct)) {
      process.stderr.write(
        "snapshot: cc-usage 降级未取到有效 used_pct（5h=" + JSON.stringify(fiveWin.used_pct) +
        " / 7d=" + JSON.stringify(sevenWin.used_pct) + "，source=" + src +
        "）→ 跳过本次切出配额快照·换号不受影响。\n");
      process.exit(0);
    }
    const snap = {
      at: nowOverride && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(nowOverride) ? nowOverride : undefined,
      fiveHour: fiveWin,
      sevenDay: sevenWin,
    };
    // 锁内 RMW（codex round#7 Finding C·防并发 lost-update·与 set_active_in 串行不互踩）。切出号不在池 = 无快照可写
    //   （不是错·active 翻转独立进行）→ mutator 内跳过（不改不存）。
    let skipped = false;
    lib.mutateRegistry(regPath, (reg) => {
      if (!reg.accounts || !reg.accounts[switchOutEmail]) {
        process.stderr.write("snapshot: 切出号 " + switchOutEmail + " 不在 registry——跳过 recordSwitchOut。\n");
        skipped = true; return;
      }
      lib.recordSwitchOut(reg, switchOutEmail, snap);
    });
    if (!skipped) process.stderr.write("snapshot: 已写 " + switchOutEmail + " 的 last_switch_out（source=" + src + "）。\n");
  ' "$LIB_JS" "$REGISTRY_PATH" "$CURRENT_ACTIVE" "$usage_json" "$NOW_OVERRIDE" 2>&1)" || {
    # 快照写失败（多半 used_pct 降级被 saveRegistry 拒写·P2-2）——**仅**少一条快照，绝不连累 setActive、绝不阻断换号。
    err "switch-account: 写切出快照失败（多半 cc-usage 降级、used_pct 缺失被拒写）——换号继续、active 仍会翻转，仅少这一条快照："
    err "$rec_out"
    SNAPSHOT_PLAN="(recordSwitchOut FAILED — see stderr; setActive 与换号不受影响、仍继续)"
    return 0
  }
  # rec_out 是 node 的诊断（非密），透传给用户。
  [ -n "$rec_out" ] && err "$rec_out"
  SNAPSHOT_PLAN="recorded switch-out snapshot for $CURRENT_ACTIVE"
}

# ── (B) setActive（可靠·独立落盘·与 snapshot 解耦）：切入号置 active=true、其余 false。──
#   这是 token 读成功、即将 exec 后**必须忠实反映现实**的关键状态——独立一次 saveRegistry，绝不被快照拖累。
#   切入号须在池中（不在则不强写——vault 取 token 那步已过、能到这里说明 token 拿到了；仍兜底告警）。
#   **调用前置条件（P2-1）**：必在 token 读成功之后调用——绝不在 token 失败路径上翻 active。
set_active_in() {
  local act_out act_rc
  # node 退出码：0=active 已置且落盘成功；5=切入号**不在 registry**（无法置 active·registry 与现实脱节·codex round#3
  #   Finding A）；其它非 0=setActive/saveRegistry 写失败（registry 与现实脱节·codex round#2 Finding B）。后两者都是
  #   「三存储已是切入号、registry active 没对齐」= misalignment，统一置 ACTIVE_WRITE_FAILED=1·主流程不谎报干净成功。
  act_out="$(node -e '
    "use strict";
    const lib = require(process.argv[1]);
    const [ , , regPath, switchInEmail ] = process.argv;
    // 锁内 RMW（codex round#7 Finding C·防并发 lost-update·与 record_switch_out 串行不互踩）：mutateRegistry 持锁
    //   load 最新态，故切入号是否在池、active 翻转都基于最新 registry（并发对手若先加了号 / 翻了 active·这里看得到）。
    let notInRegistry = false;
    lib.mutateRegistry(regPath, (reg) => {
      if (reg.accounts && reg.accounts[switchInEmail]) {
        lib.setActive(reg, switchInEmail);        // active 唯一性：切入号 true、其余 false。
        process.stderr.write("active: 已置 " + switchInEmail + " 为 active（其余号 active=false）。\n");
      } else {
        // 切入号不在 registry——能到这里说明 token 已读成功（多半 --vault-kind/--keychain 显式覆写、号未入池）。
        // 不强写 active（setActive 会对不在池的号抛错）·mutator 内不改不存。**标记 notInRegistry**·锁外 exit 5：
        //   registry active 没对齐到切入号 = misalignment·主流程据此不谎报干净成功（codex round#3 Finding A）。
        process.stderr.write("active: 切入号 " + switchInEmail + " 不在 registry——未置 active（token 已读到、换号已生效；建议 /cc-master:accounts --add 录号让 registry 对齐）。\n");
        notInRegistry = true;
      }
    });
    if (notInRegistry) process.exit(5);
  ' "$LIB_JS" "$REGISTRY_PATH" "$EMAIL" 2>&1)"; act_rc=$?
  if [ "$act_rc" -eq 5 ]; then
    # 切入号不在 registry（codex round#3 Finding A）：三存储已是切入号、但 registry 里没这个号→active 没对齐·
    #   后续选号 / 切出快照会从 stale active 推理。registry misalignment·置 ACTIVE_WRITE_FAILED=1·不谎报干净成功。
    ACTIVE_WRITE_FAILED=1
    [ -n "$act_out" ] && err "$act_out"
    err "switch-account: 切入号 ${EMAIL} 不在 registry——换号本身已生效（三存储已是切入号·token 已读到），但 registry 没有该号 entry、active **未对齐到切入号**（仍指旧号）："
    err "  → 请 /cc-master:accounts --add ${EMAIL} 录号让 registry 对齐（registry entry 全非密·token 已在你手动/keychain vault 里），或 --list 对账。"
    ACTIVE_PLAN="(switch-in not in registry — registry active stale, see stderr; 换号已生效但 registry 需对齐)"
    return 0
  elif [ "$act_rc" -ne 0 ]; then
    # setActive 落盘失败是关键状态写失败——surface（但 token 已在手、不回滚 exec：现实已是切入号，宁可 registry
    #   滞后也不丢 token；下次 detect_current_active 会按 registry 旧 active，属可对账偏差、非 token 泄漏）。
    # **不谎报干净成功（codex round#2 Finding B）**：三存储已是切入号、registry active 却没翻成功 = registry 与现实
    #   脱节（后续选号 / 切出快照会从 stale active 推理）。不回滚存储（回滚一个已成功的 token 切换风险更大），但**置
    #   ACTIVE_WRITE_FAILED=1**，让主流程最终消息**如实标注 registry 落后 + 需手动对账**，绝不打印干净的「✓ 换号完成」。
    ACTIVE_WRITE_FAILED=1
    err "switch-account: setActive 落盘失败（registry 写出错·多半 accounts.json 不可写 / 坏 JSON）——换号本身已生效（三存储已是切入号·token 已读到），但 registry active 标记**未翻成功、与现实脱节**："
    err "$act_out"
    err "  → 请手动对账：跑 /cc-master:accounts --list 看 active 是否正确；修好 accounts.json 后可重跑换号让 active 归位（三存储已是新号·重跑幂等）。"
    ACTIVE_PLAN="(setActive FAILED — registry active stale, see stderr; 换号已生效但 registry 需手动对账)"
    return 0
  fi
  [ -n "$act_out" ] && err "$act_out"
  ACTIVE_PLAN="set active=$EMAIL"
}

# ───────────────────────── vault 读取（blob 进变量后绝不打印）─────────────────────────
# **无重启换号：vault 存的是完整 claudeAiOauth blob（单行 JSON·含 refresh token），不是裸 token。**
# 把 blob 读进 VAULT_BLOB 局部变量。失败时**不**把任何部分回显到日志。每条读取路径都能在「无真凭证」
# 环境下安全失败（返回非 0 / 空变量），不崩、不泄。ACCOUNT = 选中的 email。读取机制与旧码一致（值更长而已·单行）。
VAULT_BLOB=""

read_blob_keychain() {
  # macOS keychain：security 把 blob 打到 stdout——直接捕进变量，绝不再 echo。
  if ! command -v security >/dev/null 2>&1; then
    err "vault: 'security' (macOS keychain) not found — use --vault-kind file on non-mac."
    return 1
  fi
  # -w 只打印 password（blob）到 stdout；2>/dev/null 吞掉「not found」噪声。account = email。
  VAULT_BLOB="$(security find-generic-password -a "$EMAIL" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)" || return 1
  [ -n "$VAULT_BLOB" ]
}

read_blob_file() {
  # 0600 vault 文件，每行 <email>_TOKEN=<单行blob>。逐行取本号的那行、只切出值，
  # 绝不 `. "$VAULT"`（source 会把所有备号凭证灌进当前 env、扩大泄漏面 / 污染子进程）。
  if [ ! -f "$VAULT_FILE" ]; then
    err "vault: file not found: $VAULT_FILE"
    return 1
  fi
  # 安全检查：vault 文件不该 world/group 可读（提醒，不强制 fail——某些 fs 不支持）。
  local perm
  perm="$(stat -f '%Lp' "$VAULT_FILE" 2>/dev/null || stat -c '%a' "$VAULT_FILE" 2>/dev/null || echo '')"
  case "$perm" in
    600|400|"") ;;  # 期望 0600；空=取不到权限，不强判
    *) err "vault: WARNING $VAULT_FILE perms=$perm (expect 0600; bearer credential must not be group/world-readable).";;
  esac
  # ── §A.4 必修 bug：email 含 `.`/`@` 是正则元字符。**绝不** grep -m1 "^${email}_TOKEN="（BRE 下 `.`
  #   匹配任意字符，alice@x.com 会误匹配 alicexxxcom，静默取错行）。改用 accounts-lib.fileVaultLineMatch
  #   取本号的 _TOKEN= 行前缀（对 `.`/`@` 免疫）。绝不在 bash 手拼正则。
  local token_line_prefix
  token_line_prefix="$(node -e 'const{fileVaultLineMatch}=require(process.argv[1]);process.stdout.write(fileVaultLineMatch(process.argv[2]).tokenLine)' "$LIB_JS" "$EMAIL" 2>/dev/null)" || token_line_prefix=""
  if [ -z "$token_line_prefix" ]; then
    err "vault: 无法从 accounts-lib 取 email 安全前缀（node 失败？）——拒绝用裸正则取行（§A.4 元字符 bug）。"
    return 1
  fi
  # P2-5: awk index($0,p)==1 行首锚定取「以该前缀**起头**的首行」（对齐 account-delete/account-add 的范式）。
  #   绝不用 grep -F：它是**子串**匹配、非行首锚定——若两标识重叠（xalice@x.com_TOKEN= 排在 alice@x.com_TOKEN=
  #   之前），grep -F "alice@x.com_TOKEN=" 会先命中 xalice 那行，随后 ${line#prefix} 因前缀不在行首而不剥离
  #   → 整行（畸形）当 blob 注入。awk index($0,p)==1 才保证行首锚定，且对 `.`/`@` 元字符天然免疫（定字符串）。
  #   blob 单行（store_blob 已守 oneLine）→ 整行就是 <email>_TOKEN=<单行blob>，head -1 取首行即完整 blob 行。
  local line
  line="$(awk -v p="$token_line_prefix" 'index($0, p) == 1' "$VAULT_FILE" 2>/dev/null | head -1)" || true
  if [ -z "$line" ]; then
    err "vault: no entry '${token_line_prefix}' in $VAULT_FILE"
    return 1
  fi
  # 参数展开切掉前缀取值（awk index($0,p)==1 已保证 line 以 token_line_prefix 起头）。绝不 echo $line / ${VAULT_BLOB}。
  VAULT_BLOB="${line#"$token_line_prefix"}"
  [ -n "$VAULT_BLOB" ]
}

read_blob_env() {
  # 最弱形态（仅临时/调试）：从已 export 的 <email>_TOKEN 读。进程表/history 泄漏面大。
  # email 含 `.`/`@` 不是合法 shell 变量名——env 形态对 email 标识不通用，仅当用户显式 --vault-kind env
  # 且自己 export 了对应变量时用。间接展开（bash）；空/未设则失败。
  local var="${EMAIL}_TOKEN"
  VAULT_BLOB="${!var:-}"
  if [ -z "$VAULT_BLOB" ]; then
    err "vault(env): \$${var} not set/exported（注意 email 含 . / @ 不是合法变量名，env 形态对 email 标识不通用）。"
    return 1
  fi
}

fetch_blob() {
  case "$VAULT_KIND" in
    keychain) read_blob_keychain;;
    file)     read_blob_file;;
    env)      read_blob_env;;
  esac
}

TOKEN_OK=0
if fetch_blob; then
  TOKEN_OK=1
fi

# 取不到 blob：dry-run + --skip-token-check 时允许继续走计划打印；否则硬失败。
if [ "$TOKEN_OK" -ne 1 ]; then
  if [ "$DRY_RUN" -eq 1 ] && [ "$SKIP_TOKEN_CHECK" -eq 1 ]; then
    err "dry-run: blob unavailable from vault — proceeding to print plan only (--skip-token-check)."
  else
    err "error: could not read OAuth blob for account '$EMAIL' from vault ($VAULT_KIND)."
    err "  录号（一次性人工，在该号已登录环境）: /cc-master:accounts --add $EMAIL → 完整 blob 存进 vault（绝不 commit）。"
    exit 1
  fi
fi

# ───────────────────────── token 到期巡检（best-effort，不读 token 值）─────────────────────────
# 仅在 file vault 形态下、若旁存了 <email>_EXPIRES=YYYY-MM-DD，切前对比当日给软提醒。
# 它读的是 expires 日期（非敏感），绝不碰 token 值。用 awk index($0,p)==1 行首锚定（§A.4：email 元字符安全 +
#   P2-5 同款行首锚定——expires 虽非密，但与 token 取行同 bug 类，保持一致：grep -F 子串匹配可在重叠标识下取错行）。
if [ "$VAULT_KIND" = "file" ] && [ -f "$VAULT_FILE" ]; then
  exp_prefix="$(node -e 'const{fileVaultLineMatch}=require(process.argv[1]);process.stdout.write(fileVaultLineMatch(process.argv[2]).expiresLine)' "$LIB_JS" "$EMAIL" 2>/dev/null)" || exp_prefix=""
  if [ -n "$exp_prefix" ]; then
    exp_line="$(awk -v p="$exp_prefix" 'index($0, p) == 1' "$VAULT_FILE" 2>/dev/null | head -1 || true)"
    if [ -n "$exp_line" ]; then
      exp_date="${exp_line#"$exp_prefix"}"
      today="$(date -u +%Y-%m-%d)"
      # 字符串比较即可（ISO date 字典序 == 时间序）。exp_date 可能是 YYYY-MM-DD 或严格 ISO，取前 10 位比。
      exp_day="${exp_date:0:10}"
      if [ -n "$exp_day" ] && [ "$exp_day" \< "$today" ]; then
        err "WARNING: account '$EMAIL' OAuth token EXPIRED on $exp_day (今天 $today)."
        err "  切到该号可能认证失败——请重新登录该号（Orca / claude login）后跑 /cc-master:accounts --refresh ${EMAIL} 更新 vault。"
      fi
    fi
  fi
fi

# ═══════════════════════════ 无重启换号：覆写官方共享凭证三存储（核心动作·设计审查已过）═══════════════════════════
# **架构（先理解，所有下半身从此推导）**：无重启换号 = 覆写官方 claude CLI 读取的**共享**凭证存储，而非代理 /
#   不重启进程。运行中的 claude 在 access token 临近过期时**惰性 refresh、重读存储**——于是被覆写的新号被它接管。
#   故下半身不再 `exec claude`，而是：refresh 新号 → 回写 vault 保新鲜 → 覆写官方三存储（$USER 视角）→ 翻 registry。
#   全程 token-blind 给 node/registry（凭证只走 vault 读 / refresh POST body / 三存储写，绝不进 argv / registry / agent）。
#
# 三存储（官方 claude CLI 按 $USER 读的共享凭证·覆写顺序：先非权威后权威）：
#   ① ~/.claude/.credentials.json 的 .claudeAiOauth（凭证主存·原子写 tmp+rename·0600）。
#   ② ~/.claude.json 的 oauthAccount（账号身份字段·非 token·原子写·格外小心别整文件重写丢配置）。
#   ③ macOS keychain "Claude Code-credentials" / account=$USER（**注意官方条目名 + $USER**·非 cc-master-oauth+email·
#      经 `security -w "$wrapped"` argv 写入·避 stdin 128 截断）。Linux 无 keychain → 跳过（只写①②·同 `command -v security` 守卫）。

# ── refresh_blob：用 node https 主动 refresh，把 VAULT_BLOB 的 refresh token 换一份新鲜 8h access token ──
#   **绝不用 curl 把 token 放命令行（argv 泄漏）**——node https 把 refresh token 放 POST body、不进 argv。
#   入: $1 = vault blob（单行 JSON·含 refreshToken）。出: stdout = 全新单行 blob（accessToken 新 / expiresAt=now+expires_in*1000 /
#     refreshToken 用响应给的否则保留旧的 / scopes/subscriptionType 保留），rc 0；失败 rc 非 0 + stderr 原因（无 token）。
#   token-blind 给 node 的方式：blob 经 **stdin** 喂给 node（不进 argv）；node 解析 → POST refresh → 输出新 blob 到 stdout。
#   REFRESH_TOKEN_URL 可 env 覆写（测试注入 stub endpoint）。CLIENT_ID 是公开 OAuth client id（非密）。
REFRESH_TOKEN_URL="${REFRESH_TOKEN_URL:-https://platform.claude.com/v1/oauth/token}"
OAUTH_CLIENT_ID="${OAUTH_CLIENT_ID:-9d1c250a-e61b-44d9-88ed-5944d1962f5e}"
refresh_blob() {
  local in_blob="$1"
  printf '%s' "$in_blob" | node -e '
    "use strict";
    const https = require("https");
    const http = require("http");
    const { URL } = require("url");
    const url = process.argv[1];
    const clientId = process.argv[2];
    let s = "";
    process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      let blob; try { blob = JSON.parse(s); } catch (_e) { process.stderr.write("refresh: vault blob 非法 JSON。\n"); process.exit(2); }
      const rt = blob && blob.refreshToken;
      if (typeof rt !== "string" || rt.indexOf("sk-ant-ort") !== 0) {
        process.stderr.write("refresh: vault blob 缺 refreshToken（前缀非 sk-ant-ort）——该号无 refresh token，无法主动续期（多半旧式残缺 blob）。\n");
        process.exit(3);
      }
      let u; try { u = new URL(url); } catch (_e) { process.stderr.write("refresh: REFRESH_TOKEN_URL 非法。\n"); process.exit(2); }
      // **refresh 端点白名单（codex round#7 Finding A·防 refresh token 经 polluted env 被 exfiltrate）**：refresh token
      //   是 bearer secret——POST 到哪个 URL 由 REFRESH_TOKEN_URL 控制，若被污染的 env / 误抄的测试值指到非 Claude 主机
      //   或明文 http，token 就被发到攻击者端（仍满足 token-blind 的「不进 argv/log」，但实质泄漏）。故**在构造含 token 的
      //   POST body 之前**先校验 host：① 授权的 Claude/Anthropic 主机（https·*.claude.com / *.anthropic.com / claude.ai）
      //   永远放行；② loopback（127.0.0.1 / localhost / ::1）仅当显式 opt-in CCM_ALLOW_LOOPBACK_REFRESH=1（测试用·
      //   stub endpoint）才放行；③ 其它一律**拒绝退出（exit 6·绝不发 token）**。token 在拒绝路径上从未进过 body、未上网。
      const host = (u.hostname || "").toLowerCase();
      const isHttps = u.protocol === "https:";
      const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
      const isAuthorizedClaudeHost =
        host === "claude.ai" || host === "claude.com" || host === "anthropic.com" ||
        host.endsWith(".claude.com") || host.endsWith(".anthropic.com");
      const allowLoopback = process.env.CCM_ALLOW_LOOPBACK_REFRESH === "1";
      if (!((isAuthorizedClaudeHost && isHttps) || (isLoopback && allowLoopback))) {
        // 绝不回显 token / 仅报非密的 host + 协议：拒绝把 refresh token 发到未授权端点。
        process.stderr.write("refresh: 拒绝向未授权 refresh 端点发送 refresh token（host=" + host + " proto=" + u.protocol +
          "）——只允许 https://*.claude.com / *.anthropic.com / claude.ai（或显式 opt-in 的 loopback 测试端点 CCM_ALLOW_LOOPBACK_REFRESH=1）。token 未发送。\n");
        process.exit(6);
      }
      // 通过白名单后才构造含 token 的 POST body（refresh token 放 body、绝不进 argv）。
      const body = "grant_type=refresh_token&refresh_token=" + encodeURIComponent(rt) + "&client_id=" + encodeURIComponent(clientId);
      const mod = u.protocol === "http:" ? http : https;
      const opts = {
        method: "POST",
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + (u.search || ""),
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
      };
      const req = mod.request(opts, (res) => {
        let chunks = "";
        res.on("data", (c) => { chunks += c; });
        res.on("end", () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            // 绝不回显响应体（可能含 token / 错误细节）——只报状态码。
            process.stderr.write("refresh: oauth 端点返回 HTTP " + res.statusCode + "（refresh token 可能失效）。\n");
            process.exit(4);
          }
          let r; try { r = JSON.parse(chunks); } catch (_e) { process.stderr.write("refresh: oauth 响应非 JSON。\n"); process.exit(4); }
          const at = r.access_token;
          if (typeof at !== "string" || at.indexOf("sk-ant-oat") !== 0) { process.stderr.write("refresh: oauth 响应缺 access_token（前缀非 sk-ant-oat）。\n"); process.exit(4); }
          const expiresIn = Number(r.expires_in);
          // 响应给了新 refresh token 用新的，否则保留旧的（端点可能轮转 refresh token）。
          const rotated = (typeof r.refresh_token === "string" && r.refresh_token.indexOf("sk-ant-ort") === 0 && r.refresh_token !== rt);
          const newBlob = {
            accessToken: at,
            refreshToken: rotated ? r.refresh_token : rt,
            expiresAt: Date.now() + (isFinite(expiresIn) ? expiresIn : 8 * 3600) * 1000,
          };
          // **非密轮转标记（codex round#15 Finding A）**：refresh token 被轮转时 newBlob 是新 refresh token 的**唯一副本**——
          //   若后续 vault 回写失败、再被某次回滚丢弃 NEW_BLOB，vault 里只剩可能已被服务端吊销的旧 token = 该号 brick。
          //   故 node 在 stderr 打一个**非密**标记（只说「轮转了」·绝不回显 token 值），让 bash 侧据此把回写当硬前提。
          if (rotated) process.stderr.write("refresh: ROTATED\n");
          // scopes：响应给了用响应的（空格分隔），否则保留旧 blob 的。
          if (typeof r.scope === "string" && r.scope) newBlob.scopes = r.scope.split(/\s+/);
          else if (Array.isArray(blob.scopes)) newBlob.scopes = blob.scopes;
          if (typeof blob.subscriptionType === "string" && blob.subscriptionType) newBlob.subscriptionType = blob.subscriptionType;
          if (typeof blob.rateLimitTier === "string" && blob.rateLimitTier) newBlob.rateLimitTier = blob.rateLimitTier;
          process.stdout.write(JSON.stringify(newBlob)); // 单行（无内嵌换行）。
        });
      });
      req.on("error", (e) => { process.stderr.write("refresh: 网络错误（" + (e && e.code || "ERR") + "）。\n"); process.exit(5); });
      // **请求超时（codex round#5·防端点接受连接后挂死不响应 wedge 换号）**：node https.request 默认无超时——
      //   captive proxy / 端点 stall（接了连接却迟迟不回）会让 switch-account.sh 在读完 vault blob 后无限挂等、
      //   既不硬失败也不进 force-refresh 兜底。加 socket-inactivity timeout：到时 destroy 请求 → 当**网络错误**处理
      //   （exit 5 → 上层 force-refresh 兜底·与 req error 同路·正是文档承诺的优雅降级，而非 wedge）。
      //   REFRESH_TIMEOUT_MS 可 env 覆写（默认 15000·测试可注小值）。绝不回显 token（超时只报「超时」非密事实）。
      var toMs = Number(process.env.REFRESH_TIMEOUT_MS);
      if (!isFinite(toMs) || toMs <= 0) toMs = 15000;
      req.setTimeout(toMs, function () {
        process.stderr.write("refresh: oauth 端点 " + toMs + "ms 内无响应（连接 stall / captive proxy？）——当网络不通处理。\n");
        req.destroy(); // 触发上面的 'error'（ECONNRESET/此后 socket 关）；显式 exit 5 兜底防 error 未及时触发。
        process.exit(5);
      });
      req.write(body);
      req.end();
    });
  ' "$REFRESH_TOKEN_URL" "$OAUTH_CLIENT_ID"
}

# ── writeback_vault BLOB：把刷新后的新鲜 blob 回写 cc-master vault（覆写该 email 的 vault 项/行）──
#   关键：vault 里 refresh token 保持新鲜，下次换回仍有效。复用 store_blob 的写骨架（keychain `-w "$blob"` 值作
#   argv / file awk 删旧行 + printf）。**keychain 必须用 `-w "$blob"`（值作 argv）而非 stdin 喂**：stdin 喂的
#   `security -w`（末位不带值）走 readpassphrase 有硬上限 128 字节，~471 字节 blob 会被截成残片丢 refreshToken。
#   token-blind 细化（用户拍板抉择 A）：token 经 `security` argv 参数写入、接受 sub-second 本机局部暴露，绝不进
#   agent context / log / registry。
writeback_vault() {
  local blob="$1"
  case "$VAULT_KIND" in
    keychain)
      command -v security >/dev/null 2>&1 || { err "writeback: keychain 不可用（非 mac）——跳过 vault 回写。"; return 1; }
      security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$EMAIL" -l "cc-master OAuth: $EMAIL" -w "$blob" >/dev/null 2>&1 || { err "writeback: keychain 写失败。"; return 1; }
      ;;
    file)
      umask 077; mkdir -p "$(dirname "$VAULT_FILE")" 2>/dev/null || true
      # **只删 `<email>_TOKEN=` 行·保留 `<email>_EXPIRES=`（codex P3·已坐实）**：旧码用 `.prefix`（`<email>_`）
      #   删**所有** `<email>_` 行（含非密 `<email>_EXPIRES=`），首次换号回写后 _EXPIRES sidecar 即消失 → 后续
      #   file-vault 到期巡检读不到 _EXPIRES 无法告警。改用 `.tokenLine`（`<email>_TOKEN=`）当 awk 匹配前缀，只删
      #   token 行、_EXPIRES 存活。token-blind 不变（awk 只按前缀删行·不读等号右侧 blob 值）。
      local token_line
      token_line="$(node -e 'const{fileVaultLineMatch}=require(process.argv[1]);process.stdout.write(fileVaultLineMatch(process.argv[2]).tokenLine)' "$LIB_JS" "$EMAIL" 2>/dev/null)" || token_line=""
      [ -n "$token_line" ] || { err "writeback: 无法取 email 安全前缀——跳过 vault 回写（拒裸正则）。"; return 1; }
      # **全或无原子写（codex round#1 Finding 3）+ 跨进程串行化（codex round#9 Finding C）**：temp 里先写齐（保留行
      #   [含 _EXPIRES] + 新 _TOKEN 行）全成功才 rename（全或无·原 vault 任一步失败都没动·旧 token 存活），并把整段
      #   「筛-写-rename」放进 vault 文件锁内（with_vault_lock·防与并发 add/delete 互踩最后 mv 者赢）。只删 _TOKEN 行
      #   （token_line 前缀）→ _EXPIRES 在保留集里存活。token-blind 不变（awk 只按前缀筛行不读值；blob 经 printf 进 temp）。
      _writeback_vault_file_locked() {
        local wb_tmp
        wb_tmp="$(mktemp "${VAULT_FILE}.XXXXXX" 2>/dev/null || printf '%s' "${VAULT_FILE}.tmp.$$")"
        [ -n "$wb_tmp" ] || { err "writeback: 无法建临时文件——跳过回写（原 vault 原封不动）。"; return 1; }
        chmod 600 "$wb_tmp" 2>/dev/null || true
        if [ -f "$VAULT_FILE" ]; then
          if ! awk -v p="$token_line" 'index($0, p) != 1' "$VAULT_FILE" > "$wb_tmp" 2>/dev/null; then
            rm -f "$wb_tmp"; err "writeback: 筛旧 _TOKEN 行失败——保留原文件，未回写。"; return 1
          fi
        fi
        if ! printf '%s_TOKEN=%s\n' "$EMAIL" "$blob" >> "$wb_tmp"; then
          rm -f "$wb_tmp"; err "writeback: 写新 vault 行失败（磁盘满 / IO 错？）——丢弃临时文件、原 vault 原封不动（旧 token 存活）。"; return 1
        fi
        if ! mv "$wb_tmp" "$VAULT_FILE"; then
          rm -f "$wb_tmp"; err "writeback: 原子替换 vault 文件失败（rename 错）——原 vault 原封不动（旧 token 存活）。"; return 1
        fi
        return 0
      }
      with_vault_lock "$VAULT_FILE" _writeback_vault_file_locked || return 1
      # 旁存 _EXPIRES（refresh token 长期有效期·非密·token-blind）——沿用 registry 的 token_expires_at 不在此动。
      #   注意：只删 _TOKEN 行（见上）→ 原有 _EXPIRES 行在保留集里存活，不被回写清掉。
      ;;
    env)
      # env 形态无持久存储可回写——跳过（仅调试用·告警）。
      err "writeback: env vault 形态无持久存储——跳过 vault 回写（refresh 后的新鲜 blob 不持久，下次换回需重 refresh）。"
      return 1
      ;;
  esac
  return 0
}

# ── 覆写三存储的 snapshot/rollback temp（codex P2-C·全或无·token-blind·照搬 account-add.sh 的 snapshot 纪律）──
#   病根：三存储覆写顺序 ① credentials.json → ② ~/.claude.json → ③ keychain。若 ③ 在 ①② **已写新号之后**失败，
#   旧码直接 return 1、caller 不翻 registry active（保守留旧号），结果 = split-brain：①② 已是新号、③+registry 仍旧号。
#   修：写 ①② **之前**先 snapshot ①②（文件 cp 到 0600 temp·token 随文件走·绝不读值进变量/argv/echo），③ 失败时
#   把 snapshot cp 回原位（原子：写 tmp + mv），让三存储**全回到旧号**（全或无）；任何退出路径都清理 snapshot temp。
SNAP_CRED_TMP=""   # 0600 temp 备份 credentials.json（含 token·文件 cp·token-blind）；空 = 未 snapshot 或文件不存在
SNAP_CJ_TMP=""     # 0600 temp 备份 ~/.claude.json（非密身份·统一文件 cp）；空 = 未 snapshot 或文件不存在
CRED_PREEXISTED=0  # 1 = credentials.json 换号前已存在（回滚→从 snapshot 恢复）；0 = 换号新建（回滚→rm -f 删回无此文件）
CJ_PREEXISTED=0    # 1 = ~/.claude.json 换号前已存在（回滚→从 snapshot 恢复）；0 = 换号新建（回滚→rm -f 删回无此文件）
# **覆写进行中标志 + 中断回滚（codex round#12 Finding A·中断也保全或无）**：①② 写进官方存储到三存储提交完成之间有
#   一个窗口——若此刻收到 SIGINT/TERM（用户 Ctrl-C / 被 kill），旧码的 EXIT trap 只删 snapshot，留下「①② 已新号、
#   ③+registry 旧号」的 split-brain。修：用 OVERWRITE_IN_PROGRESS 标这段窗口；中断/退出时若仍在窗口内（=1）→ 先把
#   ①② 回滚到旧号（从 snapshot 恢复·token 随文件走·token-blind），再清 snapshot。OVERWRITE_PATHS 存 ①② 路径供 trap 用。
OVERWRITE_IN_PROGRESS=0
OVERWRITE_CRED_PATH=""
OVERWRITE_CJ_PATH=""
# **三存储已提交 + 待对齐 active（codex round#17·post-commit 中断前向恢复）**：一旦最终存储（mac ③ keychain / Linux ②）
#   提交成功，官方存储就**已是新号·不可回滚**（keychain 本脚本回不了）；此后到 set_active_in 跑完之间若被中断，正确
#   恢复**不是回滚**（会制造 split-brain）而是**前向对齐**：让 registry active 也翻到切入号·使存储与 registry 一致。
#   故用 STORES_COMMITTED 标这之后的窗口·trap 据此**前向 setActive**（而非回滚）。ACTIVE_ALIGNED 标 active 已对齐（幂等）。
STORES_COMMITTED=0
ACTIVE_ALIGNED=0
COMMIT_SWITCHIN_EMAIL=""   # 待对齐成 active 的切入号（trap 前向恢复用）。
COMMIT_WRAPPED_BLOB=""     # 待写 keychain ③ 的 wrapped blob（含 token·trap 前向恢复**补写 keychain** 用·codex round#19）。
                           # token-blind：只在前向恢复路经 `security -w` argv 写 keychain（与正路同·决策 A）·绝不 echo/log。
cleanup_overwrite_snapshots() { rm -f "$SNAP_CRED_TMP" "$SNAP_CJ_TMP" 2>/dev/null || true; }
# 换号锁状态（codex round#14·下半身 step 3-4 临界段持锁·防并发 switch 交错官方三存储）。早声明供 trap 统一释放。
SWITCH_LOCK_TARGET=""
SWITCH_LOCK_OWNER=""
release_switch_lock() {
  [ -n "$SWITCH_LOCK_OWNER" ] && [ -n "$SWITCH_LOCK_TARGET" ] && \
    node -e 'try{const l=require(process.argv[1]);l.releaseFileLock({path:process.argv[2]+".lock",owner:process.argv[3]})}catch(_e){}' "$LIB_JS" "$SWITCH_LOCK_TARGET" "$SWITCH_LOCK_OWNER" 2>/dev/null
  SWITCH_LOCK_OWNER=""
}
# EXIT/中断统一清理（codex round#12/#17/#19·双向恢复·按提交阶段选回滚 vs 前向对齐）：
#   · 阶段 A——覆写窗口内、**存储未提交**（OVERWRITE_IN_PROGRESS=1 且 STORES_COMMITTED=0）：中断 → **回滚 ①②** 到旧号
#     （存储还没全提交·安全回滚·三存储与 registry 保守留旧号）。
#   · 阶段 B——**①② 已提交、keychain ③ 提交与否不确定**（STORES_COMMITTED=1 且 ACTIVE_ALIGNED=0）：① credentials.json
#     （claude 主认证源）已是新号·回滚它本身也是可被再中断的 mutation·且 keychain 若已提交就回不去——故中断的正确恢复是
#     **前向把全部对齐到新号**：① **补写 keychain ③**（idempotent `-U`·确保 keychain 也=新号·消除「keychain 旧、①②新」
#     split-brain·codex round#19）+ ② setActive（registry 追上存储）。token-blind：keychain 补写经 `security -w "$wrapped"`
#     argv（与正路同·决策 A），$wrapped 从 COMMIT_WRAPPED_BLOB 取·绝不 echo/log。绝不回滚已提交的 ①。
#   两阶段都：释放换号锁 + 清 snapshot。trap 幂等（再跑一次·标志已清·无副作用）。
on_exit_or_interrupt() {
  if [ "${STORES_COMMITTED:-0}" -eq 1 ] && [ "${ACTIVE_ALIGNED:-0}" -ne 1 ] && [ -n "$COMMIT_SWITCHIN_EMAIL" ]; then
    # 阶段 B·前向对齐：① 补写 keychain ③（idempotent·确保 keychain=新号·消除 keychain-lag split-brain·codex round#19）。
    if [ -n "$COMMIT_WRAPPED_BLOB" ] && command -v security >/dev/null 2>&1; then
      security add-generic-password -U -s "Claude Code-credentials" -a "$USER" -w "$COMMIT_WRAPPED_BLOB" >/dev/null 2>&1 || true
    fi
    # ② best-effort setActive 切入号（让 registry 追上存储·不回滚）。
    #   **align 成败要据实回传**（codex re-§7 P2）：mutateRegistry 自身失败（registry 锁超时 / accounts.json 损坏 /
    #   目录不可写）时，下面收尾消息**绝不能**谎称「registry 一致·split-brain 已避免」——故移除 node 内吞异常的
    #   try/catch，让失败以非零退出冒出来；`if … then REG_ALIGNED=1` 把成败捕进 shell（stderr 仍 /dev/null·不回显），
    #   消息据此分支。语义不变：registry 没追上不是 brick，下次 detect_current_active 仍从存储反向对账（见失败分支消息）。
    #   **切入号不在 registry 也是「未对齐」（RC-P3）**：旧 mutator `if (reg.accounts[email]) setActive(...)` 在切入号
    #   尚未录入 registry 时 guard 为假 → 啥也不做却正常返回（exit 0）→ REG_ALIGNED 误判为 1 → 谎称「三存储与 registry
    #   一致」，实际 registry active 仍指旧号（stale·与存储脱节）= 正是 set_active_in 正常路径 exit-5 处理的同一
    #   stale-registry 情形（codex round#3 Finding A）。修：mutator 在账号缺失时**显式 throw**（非零退出）→ REG_ALIGNED=0
    #   → 走下面已有的诚实失败分支，口径与 set_active_in exit-5 一致·绝不在 trap 路径谎报已对齐。
    REG_ALIGNED=0
    if node -e '
      "use strict";
      const lib = require(process.argv[1]);
      const regPath = process.argv[2], email = process.argv[3];
      lib.mutateRegistry(regPath, (reg) => {
        if (!reg.accounts || !reg.accounts[email]) {
          throw new Error("switch-in email not in registry — cannot align active (RC-P3 stale-registry)");
        }
        lib.setActive(reg, email);
      });
    ' "$LIB_JS" "$REGISTRY_PATH" "$COMMIT_SWITCHIN_EMAIL" >/dev/null 2>&1; then
      REG_ALIGNED=1
    fi
    ACTIVE_ALIGNED=1
    # **trap 幂等·消除前向对齐后第二次 trap 的误回滚 split-brain（codex re-§7 P1）**：INT/TERM 落在「STORES_COMMITTED=1
    #   已置、security 还没返回、OVERWRITE_IN_PROGRESS 还没清」这个窗口时，INT/TERM trap 跑完本前向对齐分支后会 `exit`，
    #   `exit` 又触发 EXIT trap **第二次** on_exit_or_interrupt。第二次：本 if 被 ACTIVE_ALIGNED=1 跳过（对），但**仍为真的**
    #   OVERWRITE_IN_PROGRESS 会让下面 elif 误回滚 ①② 到旧号 → keychain/registry 对齐新号、①② 回退旧号 = split-brain。
    #   修：前向对齐已把状态推到「新号一致」（回滚是错的），故在此**清掉 OVERWRITE_IN_PROGRESS + 覆写路径**——让第二次
    #   trap 既不重复前向对齐（ACTIVE_ALIGNED 守住）、也**绝不**进 elif 回滚分支。两次 trap 净效果 = 一次正确的前向对齐。
    OVERWRITE_IN_PROGRESS=0
    OVERWRITE_CRED_PATH=""
    OVERWRITE_CJ_PATH=""
    if [ "$REG_ALIGNED" -eq 1 ]; then
      err "switch-account: 换号在「①② 已提交、收尾未完成」窗口被中断——已**前向对齐全部到 ${COMMIT_SWITCHIN_EMAIL}**（补写 keychain ③ + registry active），三存储与 registry 一致·避免 split-brain（不回滚已提交的 ①）。"
    else
      err "switch-account: 换号在「①② 已提交、收尾未完成」窗口被中断——已把 ①②③ 三存储前向对齐到 ${COMMIT_SWITCHIN_EMAIL}（补写 keychain ③·不回滚已提交的 ①），但 **registry active 对齐失败**（accounts.json 锁超时/损坏/目录不可写）——registry 暂留旧号、与存储暂不一致，**下次 detect_current_active 将从存储反向对账修正**（非永久 split-brain·可自愈）。"
    fi
  elif [ "${OVERWRITE_IN_PROGRESS:-0}" -eq 1 ] && [ -n "$OVERWRITE_CRED_PATH" ]; then
    # 阶段 A·回滚：覆写窗口内、存储未提交 → 回滚 ①② 到旧号。
    rollback_official_stores_12 "$OVERWRITE_CRED_PATH" "$OVERWRITE_CJ_PATH" >/dev/null 2>&1 || true
    err "switch-account: 换号在覆写窗口内被中断——已尝试把 ①② 官方存储回滚到旧号（避免 split-brain）。三存储与 registry 保守留旧号。"
    OVERWRITE_IN_PROGRESS=0
  fi
  release_switch_lock
  cleanup_overwrite_snapshots
}
trap on_exit_or_interrupt EXIT
# INT/TERM：跑回滚清理后以约定码退出（130=INT·143=TERM·让 trap 链跑·EXIT trap 仍会再跑一次但 IN_PROGRESS 已清·幂等）。
trap 'on_exit_or_interrupt; exit 130' INT
trap 'on_exit_or_interrupt; exit 143' TERM

# rollback_official_stores_12 CRED_PATH CLAUDE_JSON —— 把 ①② 回滚到换号前状态（原子·token 随文件走·绝不 echo）。
#   **全或无含新建文件（codex P2·已坐实）**：文件 **原本存在**（*_PREEXISTED=1）→ 从 snapshot cp 回原位（写 tmp + mv）；
#   文件 **原本不存在**（*_PREEXISTED=0·换号新建的）→ rm -f 删掉它，回到换号前「无此文件」状态（不是留着带新号 token 的新文件）。
#   回 0 = 全回滚成功（或本就无可回滚跳过）；回 1 = 至少一步失败（可能 split-brain）。token-blind：含 token 的 ① 全程文件 cp/rm。
rollback_official_stores_12() {
  local cred_path="$1" claude_json="$2"
  local ok=0
  # ① credentials.json：原本存在 → snapshot 恢复；原本不存在（新建的）→ 删回无此文件状态。
  if [ "$CRED_PREEXISTED" -eq 1 ] && [ -n "$SNAP_CRED_TMP" ] && [ -f "$SNAP_CRED_TMP" ]; then
    if ( umask 077; cp "$SNAP_CRED_TMP" "$cred_path.ccm-rb.$$" 2>/dev/null && mv "$cred_path.ccm-rb.$$" "$cred_path" 2>/dev/null ); then
      chmod 600 "$cred_path" 2>/dev/null || true
    else
      rm -f "$cred_path.ccm-rb.$$" 2>/dev/null || true; ok=1
    fi
  elif [ "$CRED_PREEXISTED" -eq 0 ]; then
    if rm -f "$cred_path" 2>/dev/null; then
      err "stores: 回滚删除换号新建的 ① credentials.json（换号前无此文件·回到无此文件状态·避免 split-brain）。"
    else
      ok=1
    fi
  else
    # **codex §7 P2-c**：原本存在（CRED_PREEXISTED=1）但 snapshot 缺失（SNAP_CRED_TMP 空/丢——换号前 cp 快照失败）。
    #   ② node 块已把 ① 覆写成新号、却无快照可恢复 → 静默跳过会让 ok 维持成功态、caller 谎报「已回滚」，而新号 token
    #   仍在原地 = 正是这段回滚要防的 split-brain。故**标记回滚失败**（ok=1）让 caller 如实报 split-brain 风险 / 需手动对账。
    err "stores: ① credentials.json 换号前已存在但无快照可恢复（换号前快照失败）——无法回滚到旧号·**可能 split-brain**（① 已是新号 token）·需手动对账！"
    ok=1
  fi
  # ② ~/.claude.json：原本存在 → snapshot 恢复；原本不存在（新建的）→ 删回无此文件状态。
  if [ "$CJ_PREEXISTED" -eq 1 ] && [ -n "$SNAP_CJ_TMP" ] && [ -f "$SNAP_CJ_TMP" ]; then
    if ( umask 077; cp "$SNAP_CJ_TMP" "$claude_json.ccm-rb.$$" 2>/dev/null && mv "$claude_json.ccm-rb.$$" "$claude_json" 2>/dev/null ); then
      :
    else
      rm -f "$claude_json.ccm-rb.$$" 2>/dev/null || true; ok=1
    fi
  elif [ "$CJ_PREEXISTED" -eq 0 ]; then
    if rm -f "$claude_json" 2>/dev/null; then
      err "stores: 回滚删除换号新建的 ② ~/.claude.json（换号前无此文件·回到无此文件状态·避免 split-brain）。"
    else
      ok=1
    fi
  else
    # **codex §7 P2-c（CJ 同类分支·一并审）**：② 原本存在但无快照可恢复——② 已被覆写成新号 oauthAccount、无快照恢复。
    #   ② 是身份显示层（非密·非凭证主存），但同样被写成了新号且回不去 → 仍是 split-brain 的一部分，须标回滚失败（不静默跳过）。
    err "stores: ② ~/.claude.json 换号前已存在但无快照可恢复（换号前快照失败）——无法回滚到旧号·**可能 split-brain**（② oauthAccount 已是新号）·需手动对账！"
    ok=1
  fi
  return $ok
}

# ── overwrite_official_stores BLOB IDENTITY：覆写官方共享凭证三存储（$USER 视角·原子写·token-blind 给 node 经 stdin）──
#   blob（含 token·bearer secret）经 **stdin** 喂给一个 node 程序（**绝不**进 argv），node 原子写①②，再由 bash 用 `security -w "$wrapped"` argv 写 keychain③（避 stdin 128 截断·抉择 A 接受的本机局部暴露）。
#   identity（= ~/.claude.json oauthAccount 原样·**全非密**身份字段·无 token-shaped 值）经 **argv** 传给 node（合规·非密）。
#   返回 0 = 全部成功（或 Linux 跳过③）；非 0 = 某步失败（stderr 标到哪步·绝不回显 blob）。
#   **全或无（codex P2-C）**：写 ①② 前先 snapshot ①②（文件 cp·token-blind），③ keychain 失败 → 回滚 ①② 到旧号，
#   三存储全留旧号（换号未发生·可重试），消除 split-brain。
overwrite_official_stores() {
  local blob="$1"
  local identity_json="$2"   # 切入号 registry identity（非密·经 argv）；缺/空 → ②段降级只同步 subscriptionType。
  local node_rc=0            # node 写 ①② 的退出码（PIPESTATUS 取·区分 ①失败 vs ②身份写失败·codex round#1 Finding 1）。
  # ①② 用 node 原子写（凭证经 stdin 不进 argv·identity 经 argv）。CRED_PATH / CLAUDE_JSON_PATH 可 env 覆写（测试注入）。
  local cred_path="${CRED_PATH:-${HOME}/.claude/.credentials.json}"
  local claude_json="${CLAUDE_JSON_PATH:-${HOME}/.claude.json}"

  # ── snapshot ①②（写之前·全或无回滚的前提·token-blind 文件 cp·仅文件存在时做）──────────────────────────
  #   ① credentials.json 含 token → 文件 cp 到 0600 temp（token 随文件走·绝不 cat/读值进变量/echo/argv）。
  #   ② ~/.claude.json 非密 → 也统一文件 cp 到 0600 temp（整文件备份·回滚时整文件写回·只此函数动它）。
  #   **新建文件全或无（codex P2·已坐实）**：node 块会 **创建** 不存在的 ①②（写新号 token）。若文件原本不存在、
  #   snapshot 为空，③ 失败时从空 snapshot 恢复 = 没东西可恢复 → 新建的（带新号 token 的）文件留下 = split-brain。
  #   故记录每个文件 **换号前是否存在**（CRED_PREEXISTED/CJ_PREEXISTED）；rollback 时：原本存在 → 从 snapshot 恢复；
  #   原本不存在（换号新建的）→ rm -f 删回「无此文件」状态，让 rollback 即便文件是新建的也真全或无。
  #   **快照失败 → fail-closed 中止（codex round#2·全或无前提硬化）**：旧码快照 cp 失败只 warn 仍继续覆写——
  #   若后续 ③ keychain（或 ② 身份写）失败要回滚，却没有旧副本可恢复 → ①② 留在新号、③+registry 旧号 = split-brain。
  #   全或无的前提是「能回滚」，而「能回滚」的前提是「快照成功」。故**必需的快照（pre-existing 文件）一旦 cp 失败，
  #   就在覆写任何存储之前 return 1 中止**——三存储原封不动、换号未发生·可重试，绝不进「覆写了却回不去」的险态。
  SNAP_CRED_TMP=""; SNAP_CJ_TMP=""
  CRED_PREEXISTED=0; CJ_PREEXISTED=0
  if [ -f "$cred_path" ]; then
    CRED_PREEXISTED=1
    SNAP_CRED_TMP="$(mktemp 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}/.ccm-sw-credsnap.$$")"
    if ( umask 077; cp "$cred_path" "$SNAP_CRED_TMP" 2>/dev/null ); then
      chmod 600 "$SNAP_CRED_TMP" 2>/dev/null || true
    else
      rm -f "$SNAP_CRED_TMP" 2>/dev/null || true; SNAP_CRED_TMP=""
      err "stores: 快照 ① credentials.json 失败——**中止换号**（无快照则后续失败无法回滚·会 split-brain）：未覆写任何存储、registry 原封不动、可重试。"
      cleanup_overwrite_snapshots; SNAP_CRED_TMP=""; SNAP_CJ_TMP=""
      return 1
    fi
  fi
  if [ -f "$claude_json" ]; then
    CJ_PREEXISTED=1
    SNAP_CJ_TMP="$(mktemp 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}/.ccm-sw-cjsnap.$$")"
    if ( umask 077; cp "$claude_json" "$SNAP_CJ_TMP" 2>/dev/null ); then
      chmod 600 "$SNAP_CJ_TMP" 2>/dev/null || true
    else
      rm -f "$SNAP_CJ_TMP" 2>/dev/null || true; SNAP_CJ_TMP=""
      err "stores: 快照 ② ~/.claude.json 失败——**中止换号**（无快照则后续失败无法回滚·会 split-brain）：未覆写任何存储、registry 原封不动、可重试。"
      cleanup_overwrite_snapshots; SNAP_CRED_TMP=""; SNAP_CJ_TMP=""
      return 1
    fi
  fi

  # **进入覆写窗口（codex round#12 Finding A）**：从这里到三存储提交完成（return 0）/ 显式回滚之间，若被 SIGINT/TERM
  #   中断，on_exit_or_interrupt trap 会据 OVERWRITE_IN_PROGRESS=1 把 ①② 回滚到旧号。记下 ①② 路径供 trap 用。
  OVERWRITE_IN_PROGRESS=1
  OVERWRITE_CRED_PATH="$cred_path"
  OVERWRITE_CJ_PATH="$claude_json"
  # node 退出码语义：0=①②全成（或 ② 优雅降级/跳过·非致命）；1=① credentials.json 写失败（② 未写·无需回滚）；
  #   2=**身份切换路的 ② 写真失败**（① 已写新号·必须回滚 ① 到旧号·避免 split-identity·codex round#1 Finding 1）。
  printf '%s' "$blob" | node -e '
    "use strict";
    const fs = require("fs");
    const path = require("path");
    const credPath = process.argv[1];
    const claudeJson = process.argv[2];
    const identityRaw = process.argv[3] || "";   // 非密 identity JSON（argv·可空 → ②降级）。
    let s = "";
    process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      let blob; try { blob = JSON.parse(s); } catch (_e) { process.stderr.write("stores: blob 非法 JSON。\n"); process.exit(1); }

      // 原子写 helper：写 tmp（0600）→ rename 覆盖（同分区原子）。绝不整文件重建——只改目标子对象、保留其它键。
      function atomicWrite(filePath, obj) {
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const tmp = path.join(dir, "." + path.basename(filePath) + ".tmp-" + process.pid + "-" + Date.now());
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
        try { fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, filePath); fs.chmodSync(filePath, 0o600); }
        catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
      }

      // ① ~/.claude/.credentials.json：读现有→只把 .claudeAiOauth 换成新 blob→保留其它字段→原子写回。
      try {
        let cred = {};
        try { cred = JSON.parse(fs.readFileSync(credPath, "utf8")); } catch (_e) { cred = {}; }
        if (!cred || typeof cred !== "object" || Array.isArray(cred)) cred = {};
        // claudeAiOauth 全量换成新 blob（它本就是 OAuth 凭证子对象）。保留 cred 的其它顶层键（若有）。
        cred.claudeAiOauth = blob;
        atomicWrite(credPath, cred);
        process.stderr.write("stores: ① credentials.json .claudeAiOauth 已覆写（原子·0600）。\n");
      } catch (e) {
        process.stderr.write("stores: ① credentials.json 写失败：" + (e && e.code || e) + "\n");
        process.exit(1);
      }

      // ② ~/.claude.json 的 oauthAccount：读→改 oauthAccount 子对象→保留所有其它键→原子写回。
      //    格外小心别整文件重写丢配置：只在已存在的 ~/.claude.json 上改 oauthAccount，其它 75+ 键原样保留。
      //    **双路**：有 registry identity（非密身份对象·经 argv 传入）→ **完整替换**整个 oauthAccount，让换号真切
      //    身份（accountUuid/emailAddress/organizationUuid/subscriptionType 等全换成切入号）。无/空/解析失败 identity →
      //    **降级**回旧行为：保留旧 oauthAccount、仅当 blob.subscriptionType 存在且 oa 已有该字段时同步它（claude 主要
      //    按 credentials.json 的 token 认证；oauthAccount 是显示层身份）。降级时 surface 一条 stderr 提示补 identity。
      try {
        // 解析 identity（argv·非密）：非空对象 → 走完整替换；否则 → null（降级）。
        let identity = null;
        if (identityRaw) {
          try {
            const parsed = JSON.parse(identityRaw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length > 0) identity = parsed;
          } catch (_e) { identity = null; }
        }
        if (fs.existsSync(claudeJson)) {
          let cj; try { cj = JSON.parse(fs.readFileSync(claudeJson, "utf8")); } catch (_e) { cj = null; }
          if (cj && typeof cj === "object" && !Array.isArray(cj)) {
            if (identity) {
              // 有 identity → 完整替换 oauthAccount（真切身份），保留 cj 所有其它顶层键。
              // **②写失败 → 触发回滚（codex round#1 Finding 1·split-identity 收口）**：身份切换路（identity 在·文件
              //   在·合法 JSON）若 atomicWrite 真失败（权限 / 文件锁 / IO），旧码静默吞、仍让 ①③ 切到新号 → ①③ 是新号
              //   token、② oauthAccount 仍旧号 = split-identity（违背三存储全或无）。修：身份切换路的 atomicWrite 失败
              //   **exit 2** → bash caller 把 ① 回滚到旧号（① 已写新号），三存储全留旧号、换号未发生·可重试（不再 split）。
              //   注意：仅**身份切换路的真写失败**才 exit 2；下面的「无 identity 降级 / 文件缺 / 损坏」是有意的优雅降级、非失败，仍非致命。
              try {
                cj.oauthAccount = identity;
                atomicWrite(claudeJson, cj);
                process.stderr.write("stores: ② ~/.claude.json oauthAccount 已用 registry identity 完整替换（真切身份·其它键保留·原子）。\n");
              } catch (e2) {
                process.stderr.write("stores: ② ~/.claude.json 身份切换写失败（权限 / 锁 / IO）：" + (e2 && e2.code || e2) + " —— 触发回滚 ①（避免 split-identity·三存储全或无）。\n");
                process.exit(2);   // ① 已写新号 → caller 据 exit 2 回滚 ① 到旧号。
              }
            } else {
              // 无 identity → 降级：保留旧 oauthAccount，仅同步 subscriptionType（若 oa 已有该字段）。
              //   这是有意的优雅降级（claude 主要按 ① credentials.json token 认证·② 只同步显示层订阅档），**非身份切换路**：
              //   它本就不切身份、不存在 split-identity 风险，故写失败仍非致命（catch 在外层兜·不 exit）。
              const oa = (cj.oauthAccount && typeof cj.oauthAccount === "object" && !Array.isArray(cj.oauthAccount)) ? cj.oauthAccount : {};
              if (typeof blob.subscriptionType === "string" && blob.subscriptionType && ("subscriptionType" in oa)) {
                oa.subscriptionType = blob.subscriptionType;
              }
              cj.oauthAccount = oa;     // 保留 oauthAccount 其它身份字段 + cj 所有其它顶层键。
              atomicWrite(claudeJson, cj);
              process.stderr.write("stores: ② ~/.claude.json 无 registry identity → 降级只同步 subscriptionType（登录显示可能仍是上一号·建议 --add 补 identity）。\n");
            }
          } else {
            process.stderr.write("stores: ② ~/.claude.json 非对象/损坏——跳过（不整文件重写·绝不丢配置）。\n");
          }
        } else {
          process.stderr.write("stores: ② ~/.claude.json 不存在——跳过（不新建·身份由 credentials.json token 主导）。\n");
        }
      } catch (e) {
        // 到这的是**非身份切换路**的 ② 失败（无 identity 降级写 / 读文件异常）——非致命（身份显示层·不 split-identity）：
        //   surface 但不整体 fail（①是凭证主存、已成；身份切换路的真写失败已在内层 exit 2 单独处理·会回滚）。
        process.stderr.write("stores: ② ~/.claude.json 写失败（非致命·身份显示层·非身份切换路）：" + (e && e.code || e) + "\n");
      }
    });
  ' "$cred_path" "$claude_json" "$identity_json"
  # ${PIPESTATUS[1]} = node 的退出码（[0] 是左侧 printf）。set -o pipefail 下 `if !` 取的是整管道码、丢了
  #   1 vs 2 的区分（codex round#1 Finding 1 要按 ② 是否已写新号决定回不回滚 ①）——故显式取 node 自身码。
  node_rc="${PIPESTATUS[1]}"
  if [ "$node_rc" -eq 1 ]; then
    # ① credentials.json 写失败（node 在 ② 之前 process.exit(1)）：② 未写、① 原子写本身未落 → 无需回滚，仅清 snapshot。
    OVERWRITE_IN_PROGRESS=0   # 窗口关闭（① 未提交·无残留新号态）。
    cleanup_overwrite_snapshots; SNAP_CRED_TMP=""; SNAP_CJ_TMP=""
    err "overwrite-stores: ① credentials.json 覆写失败——未完成换号（凭证主存未更新）。"
    return 1
  elif [ "$node_rc" -eq 2 ]; then
    # **身份切换路的 ② 写真失败（① 已写新号·codex round#1 Finding 1）**：① 是新号 token、② oauthAccount 仍旧号
    #   = split-identity。把 ① 回滚到旧号（全或无），三存储全留旧号、换号未发生·可重试（不再 split）。③ keychain 尚未写。
    if rollback_official_stores_12 "$cred_path" "$claude_json"; then
      err "overwrite-stores: ② 身份写失败 → 已回滚 ①，三存储全留旧号，换号未发生，可重试（避免 split-identity）。"
    else
      err "overwrite-stores: ② 身份写失败、且 ① 回滚失败——可能 split-identity（① 已是新号 token·② 仍旧号）·需手动对账！"
    fi
    OVERWRITE_IN_PROGRESS=0   # 窗口关闭（已回滚到旧号）。
    cleanup_overwrite_snapshots; SNAP_CRED_TMP=""; SNAP_CJ_TMP=""
    return 1
  elif [ "$node_rc" -ne 0 ]; then
    # 其它非 0（不该发生·防御）：保守按未完成换号处理、回滚 ①（① 可能已写）、不翻 registry。
    rollback_official_stores_12 "$cred_path" "$claude_json" >/dev/null 2>&1 || true
    OVERWRITE_IN_PROGRESS=0   # 窗口关闭（已尝试回滚）。
    cleanup_overwrite_snapshots; SNAP_CRED_TMP=""; SNAP_CJ_TMP=""
    err "overwrite-stores: 覆写 ①② 的 node 以未知码 ${node_rc} 退出——保守按换号未完成处理（已尝试回滚 ①）。"
    return 1
  fi

  # ③ macOS keychain "Claude Code-credentials" / account=$USER（官方条目名·非 cc-master-oauth+email）。
  #    Linux 无 keychain → 跳过（只写①②）。$wrapped 经 `security -w "$wrapped"`（值作 argv 参数）写入。
  #    **必须用 argv `-w "$wrapped"` 而非 stdin 喂**：stdin 喂的 `security -w`（末位不带值）走 readpassphrase 有
  #    硬上限 128 字节——`{"claudeAiOauth":...}` 包裹对象远超 128 字节，stdin 写会把官方登录凭证写成 128 残片
  #    （非法 JSON）→ brick 掉官方登录态。值作 argv 则存完整合法 JSON。
  #    **官方格式（codex P1·已坐实）**：真实「Claude Code-credentials」keychain 条目是 `{"claudeAiOauth":{...}}`
  #    包裹对象（与 credentials.json ① 写一致·account-add 的 keychain 读也读 `.claudeAiOauth`）——写扁平 $blob 会让
  #    claude 读不到 `.claudeAiOauth` → 当 corrupt/drift → 无重启换号不生效。故 ③ 写前先把 $blob 包成 claude 格式。
  #    **TOKEN-BLIND**（用户拍板抉择 A）：$wrapped 含 token，只作 `security` 的 argv 参数、绝不 echo/printf/log，
  #    接受写 keychain 时经 argv 的 sub-second 本机局部暴露（可读 argv 的同用户本就能直接读 keychain）。
  if command -v security >/dev/null 2>&1; then
    local wrapped="{\"claudeAiOauth\":${blob}}"   # $blob 是合法单行 JSON 对象 → 拼出 {"claudeAiOauth":{...}}（claude 官方格式）。
    # **在 security 调用之前就切到 post-commit 档（codex round#18·消除「keychain 已提交但 flag 未设」的中断盲窗）**：
    #   security 返回成功 → 设 STORES_COMMITTED=1 之间有一个**纯 bash 不可对信号原子化**的窗口——若此刻被 SIGINT/TERM，
    #   旧码的 trap 看 STORES_COMMITTED=0 会**回滚 ①②**，而 keychain 可能已提交成新号 → keychain 新、①②+registry 旧 = split-brain。
    #   修：**在 security 之前**就置 STORES_COMMITTED=1 + 记切入号·武装 trap 的**前向对齐**分支。语义：从「即将写 keychain」
    #   起，①② 都已是新号·凭证主存 ① credentials.json（claude 主认证源）已新——此后任何中断的**最小伤害恢复是前向**
    #   （把 registry / keychain 都对齐到新号），绝非回滚 ①②（回滚本身也是可被中断的 mutation·且若 keychain 已提交就回不去）。
    #   若 security **显式失败**（确知 keychain 是旧号）→ 在 else 分支**撤回** post-commit（STORES_COMMITTED=0）+ 回滚 ①② 到旧号（安全·确定性）。
    STORES_COMMITTED=1
    COMMIT_SWITCHIN_EMAIL="$EMAIL"
    COMMIT_WRAPPED_BLOB="$wrapped"   # 供 trap 前向恢复**补写 keychain ③**（codex round#19·消除 keychain-lag·idempotent `-U`·token-blind argv）。
    if security add-generic-password -U -s "Claude Code-credentials" -a "$USER" -w "$wrapped" >/dev/null 2>&1; then
      # keychain 提交成功·三存储全新号·换号已落地。关回滚分支（OVERWRITE_IN_PROGRESS=0）·trap 后续只会前向对齐（不回滚）。
      OVERWRITE_IN_PROGRESS=0
      err "stores: ③ keychain \"Claude Code-credentials\" account=$USER 已覆写（argv -w·完整 blob·避 128 截断）。"
    else
      # ③ keychain **显式失败**——确知 keychain 仍是旧号（没提交）→ **撤回 post-commit**（STORES_COMMITTED=0·让 trap/此处回滚 ①②
      #   安全·因 keychain 确定是旧号）。①② 已写新号 → 回滚到旧号（全或无·三存储全留旧号）。
      STORES_COMMITTED=0; COMMIT_SWITCHIN_EMAIL=""; COMMIT_WRAPPED_BLOB=""   # 撤回·清掉 trap 的前向补写 keychain 物料（token 清理）。
      if rollback_official_stores_12 "$cred_path" "$claude_json"; then
        err "stores: ③ keychain 失败 → 已回滚 ①②，三存储全留旧号，换号未发生，可重试。"
      else
        err "stores: ③ keychain 失败、且 ①② 回滚失败——可能 split-brain（部分官方凭证态已在新号上）·需手动对账！"
      fi
      OVERWRITE_IN_PROGRESS=0   # 窗口关闭（已回滚到旧号）。
      cleanup_overwrite_snapshots; SNAP_CRED_TMP=""; SNAP_CJ_TMP=""
      return 1   # 换号确实没成（已回滚到旧号·不再 split-brain）；caller 不翻 registry active。
    fi
  else
    # Linux 无 keychain → ② 是最终存储·①② 都已写新号·换号已落地。**post-commit 切档**（同 mac·先武装前向对齐·再关回滚）。
    STORES_COMMITTED=1
    COMMIT_SWITCHIN_EMAIL="$EMAIL"
    OVERWRITE_IN_PROGRESS=0
    err "stores: ③ 无 security（非 mac）——跳过 keychain，只覆写了①② 两个文件（Linux 正常路径）。"
  fi
  # 到这里 OVERWRITE_IN_PROGRESS 已在「最终存储提交成功」处被清（mac=③ 成功后 / Linux=② 后）·此处只清 snapshot。
  cleanup_overwrite_snapshots; SNAP_CRED_TMP=""; SNAP_CJ_TMP=""
  return 0
}

# ───────────────────────── DRY-RUN（不真 refresh、不真覆写、不真写 registry）─────────────────────────
if [ "$DRY_RUN" -eq 1 ]; then
  plan "── switch-account.sh DRY-RUN (无重启换号·不真 refresh、不真覆写三存储、不真写 registry) ──"
  if [ "$EMAIL_EXPLICIT" -eq 1 ]; then
    plan "select         : (skipped — 用户显式 --email)"
  else
    plan "select         : 自动选号 select-account.js → $EMAIL"
  fi
  plan "switch-in email: $EMAIL"
  plan "registry       : $REGISTRY_PATH"
  plan "vault kind     : $VAULT_KIND$([ "$VAULT_KIND_EXPLICIT" -eq 1 ] && echo " (--vault-kind override)" || [ -n "$REG_VAULT_KIND" ] && echo " (from registry)")"
  case "$VAULT_KIND" in
    keychain) plan "vault source   : keychain service=$KEYCHAIN_SERVICE account=$EMAIL";;
    file)     plan "vault source   : file=$VAULT_FILE key=${EMAIL}_TOKEN (awk index==1 行首锚定·§A.4+P2-5 email 元字符/重叠标识安全)";;
    env)      plan "vault source   : env \$${EMAIL}_TOKEN";;
  esac
  if [ "$TOKEN_OK" -eq 1 ]; then
    plan "blob           : <redacted> (已从 vault 读入，长度=${#VAULT_BLOB}，绝不打印明文)"
  else
    plan "blob           : <UNAVAILABLE> (--skip-token-check：仅打印计划)"
  fi
  plan "would refresh  : node https POST ${REFRESH_TOKEN_URL}（refresh token 放 POST body·不进 argv·绝不 curl）→ 新鲜 8h access token"
  plan "would writeback: 回写 cc-master vault（${VAULT_KIND}·保 refresh token 新鲜，下次换回仍有效）"
  plan "would overwrite: 官方三存储（\$USER=$USER 视角·原子写）："
  plan "                 ① ~/.claude/.credentials.json .claudeAiOauth（凭证主存·tmp+rename·0600）"
  plan "                 ② ~/.claude.json oauthAccount（用 registry identity 完整替换·非密身份字段·保留其它 75+ 键·绝不整文件重写；无 identity 时降级只同步 subscriptionType）"
  plan "                 ③ keychain \"Claude Code-credentials\" account=\$USER（mac·security -w \"\$wrapped\" argv 写避 128 截断；Linux 跳过）"
  # snapshot + setActive（解耦·P2-2），时机：覆写三存储成功之后才翻 active。
  if [ "$NO_SNAPSHOT" -eq 1 ]; then
    plan "snapshot       : (skipped: --no-snapshot)"
  else
    dr_active="$(node -e '
      "use strict";
      try {
        const lib = require(process.argv[1]);
        const reg = lib.loadRegistry(process.argv[2]);
        const accts = reg.accounts || {};
        for (const [email, e] of Object.entries(accts)) { if (e && e.active === true) { process.stdout.write(email); break; } }
      } catch (_e) {}
    ' "$LIB_JS" "$REGISTRY_PATH" 2>/dev/null || true)"
    if [ -z "$dr_active" ]; then
      plan "snapshot       : (no current active in registry — 无切出快照可写)"
    elif [ "$dr_active" = "$EMAIL" ]; then
      plan "snapshot       : (current active == $EMAIL — 已是该号，无需切出快照)"
    else
      plan "snapshot       : WOULD recordSwitchOut for $dr_active (cc-usage 5h/7d used_pct+resets_at+source; best-effort·可降级)"
    fi
  fi
  plan "set-active     : WOULD setActive=$EMAIL (覆写三存储成功后才翻 active·与 snapshot 解耦)"
  if [ -n "$BOARD_SEL" ]; then
    plan "board (deprecated): $BOARD_SEL  (无重启换号不再 resume 板·--board 保留为 no-op)"
  fi
  plan "note           : 无重启换号——claude 进程不重启；access token 临近过期时官方 CLI 惰性 refresh 重读被覆写的存储 → 新号被接管。"
  plan "note           : refresh 失败 → 不覆写任何存储、registry 原封不动、surface 退非 0（非变更性 preflight）。"
  plan "note           : 凭证全程脚本子进程 / vault / refresh POST body / 三存储写，绝不进 agent / registry / argv。"
  plan "── end DRY-RUN（未 refresh、未覆写、未写 registry、未泄凭证）──"
  exit 0
fi

# ═══════════════════════════ 真切（无重启换号·不 exec·token-blind 全程）═══════════════════════════
# 到这里 TOKEN_OK 必为 1（非 dry-run 路径取不到 blob 已在上面 exit 1）。下半身（全 token-blind）：
#   1) 主动 refresh（非变更性 preflight）→ 失败则不覆写任何存储、registry 原封不动、surface 退非 0。
#   2) 回写 cc-master vault（保 refresh token 新鲜）。
#   3) 覆写官方三存储（先非权威后权威）。
#   4) snapshot + setActive（覆写成功后才翻 registry active·P2-2 解耦）。

# 1) 主动 refresh（非变更性 preflight·失败不动任何存储）。新鲜 blob 进 NEW_BLOB（绝不打印）。
#    refresh_blob 退出码（来自内嵌 node·语义化）：0=成功；2=blob 非法 JSON / URL 非法；3=blob 缺 refresh token；
#    4=oauth 端点返回非 2xx（**refresh token 失效**·设计稿 step 6：硬失败·不覆写）；5=网络错误（端点不通·设计稿
#    step 10：可退 force-refresh 兜底——refresh token 多半仍有效、只是端点momentarily 不通，让 claude 自己重试）。
NEW_BLOB="$(refresh_blob "$VAULT_BLOB" 2>/tmp/.ccm-refresh-err.$$)"; refresh_rc=$?
refresh_err="$(cat "/tmp/.ccm-refresh-err.$$" 2>/dev/null || true)"; rm -f "/tmp/.ccm-refresh-err.$$" 2>/dev/null || true
FORCE_REFRESH_FALLBACK=0
# **refresh token 是否被轮转（codex round#15 Finding A·非密标记）**：node 在轮转时 stderr 打 "refresh: ROTATED"
#   （非密·无 token 值）。轮转时 NEW_BLOB 是新 refresh token 唯一副本 → 下面把 vault 回写当**硬前提**（回写失败即
#   硬失败·绝不继续到可能丢弃 NEW_BLOB 的覆写/回滚路·避免该号 brick 成只剩可能已吊销的旧 token）。
REFRESH_ROTATED=0
case "$refresh_err" in *"refresh: ROTATED"*) REFRESH_ROTATED=1;; esac
if [ "$refresh_rc" -ne 0 ] || [ -z "$NEW_BLOB" ]; then
  [ -n "$refresh_err" ] && err "$refresh_err"
  # ── 失败分流（设计稿 step 6 vs step 10）──
  #   · rc=3（缺 refresh token·残缺旧式 blob）→ **硬失败**：无 refresh 能力、force-refresh 也无意义 → exit 非 0。
  #   · rc=4（oauth 非 2xx·refresh token 失效）→ **硬失败**（设计稿 step 6）：refresh token 已失效，force-refresh
  #     用同一失效 token 也会失败、还会留下临近过期的坏存储 → **不覆写任何存储、registry 原封不动**、surface 退非 0。
  #   · rc=5（网络错误·端点不通）→ **force-refresh 兜底**（设计稿 step 10）：refresh token 多半仍有效，只是端点
  #     momentarily 不通；退回「覆写 vault 原 blob + expiresAt 临近过期，逼官方 CLI 自己 refresh」，有 vault-stale 风险但是安全网。
  #   · rc=2 / 其它 → 硬失败（输入/逻辑错·不该 force-refresh）。
  if [ "$refresh_rc" -eq 5 ]; then
    # 网络不通 → force-refresh 兜底。仅当 vault blob 本身有 refresh token（rc=5 已说明能解析出 refresh token）。
    err "switch-account: 主动 refresh 网络不通——退化到 force-refresh 兜底（覆写原 blob + expiresAt 临近过期，逼官方 CLI 自己 refresh）。"
    err "  ⚠ vault-stale 风险：claude 自己 refresh 后的新 token 不会回写 cc-master vault——下次换回该号可能需先 --refresh。"
    NEW_BLOB="$(printf '%s' "$VAULT_BLOB" | node -e '"use strict";let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let o;try{o=JSON.parse(s)}catch(_e){process.exit(1)}o.expiresAt=Date.now()+60*1000;process.stdout.write(JSON.stringify(o))})' 2>/dev/null)" || NEW_BLOB=""
    if [ -z "$NEW_BLOB" ]; then
      err "error: force-refresh 兜底也失败（blob 处理出错）——未覆写任何存储、registry 原封不动。"
      exit 1
    fi
    FORCE_REFRESH_FALLBACK=1
  elif [ "$refresh_rc" -eq 4 ]; then
    err "error: refresh token 可能已失效（oauth 端点拒绝）——**未覆写任何存储**、registry 原封不动（设计稿 step 6）。"
    err "  请用 /cc-master:accounts --refresh ${EMAIL} 重录该号完整 blob 后重试。"
    exit 1
  elif [ "$refresh_rc" -eq 3 ]; then
    err "error: 该号 vault blob 缺 refresh token（多半旧式残缺 blob）——无法 refresh、无法 force-refresh 兜底。"
    err "  请用 /cc-master:accounts --refresh ${EMAIL} 重录完整 blob 后重试。未覆写任何存储、registry 原封不动。"
    exit 1
  elif [ "$refresh_rc" -eq 6 ]; then
    # **未授权 refresh 端点（codex round#7 Finding A）**：REFRESH_TOKEN_URL 指向非 Claude/Anthropic 主机 / 明文 http
    #   → node 在发 token **之前**已拒绝（token 未上网）。硬失败·绝不 force-refresh（force-refresh 会用同一坏 URL）。
    err "error: REFRESH_TOKEN_URL 指向**未授权**的 refresh 端点（见上 host/proto）——为防 refresh token 被发到非 Claude 主机/明文 http，已**拒绝发送 token、未覆写任何存储**、registry 原封不动。"
    err "  请检查环境变量 REFRESH_TOKEN_URL（多半被污染 / 误抄了测试值）：生产应留默认 https://platform.claude.com/v1/oauth/token。token 安全（从未上网）。"
    exit 1
  else
    err "error: refresh 失败（rc=${refresh_rc}·blob/URL 输入或逻辑错）——未覆写任何存储、registry 原封不动。"
    exit 1
  fi
fi

# 2) 回写 cc-master vault（保 refresh token 新鲜）。force-refresh 兜底下不回写（原 blob 没变·避免覆写成临近过期）。
if [ "${FORCE_REFRESH_FALLBACK:-0}" -ne 1 ]; then
  if writeback_vault "$NEW_BLOB"; then
    err "switch-account: 已回写 cc-master vault（${EMAIL}·refresh token 保新鲜）。"
  else
    # **回写失败的两种严重度（codex round#15 Finding A）**：
    #   · refresh token **未轮转**（REFRESH_ROTATED=0）→ vault 里的旧 refresh token 仍有效·回写失败非致命：三存储仍覆写
    #     （换号现实仍发生），只是 vault 的 access token 没更新到最新（下次换回可能需 --refresh）。继续。
    #   · refresh token **已轮转**（=1）→ NEW_BLOB 是新 refresh token 唯一副本·而 vault 里的旧 refresh token 多半已被
    #     服务端**吊销**。若继续到覆写、而覆写又失败回滚 → NEW_BLOB 被丢弃 → 该号 vault 只剩已吊销旧 token = brick（再也
    #     切不进·需手动重 login）。故**硬失败**：未覆写任何官方存储、registry 原封不动、exit 非 0·明确提示重 login/refresh。
    if [ "${REFRESH_ROTATED:-0}" -eq 1 ]; then
      # **轮转后回写失败 → 先把 NEW_BLOB 抢救到 0600 recovery 文件再退（codex round#16 Finding A·绝不丢轮转的唯一 token）**：
      #   仅硬失败不够——NEW_BLOB 是新 refresh token 唯一副本，进程一退就丢、该号 brick。故在 exit 前把它落到用户级安全区
      #   （$CC_MASTER_HOME / ~/.claude/cc-master）的一个 0600 recovery 文件（与 file vault 同安全 floor·明文 0600）：token
      #   经 stdin 喂 node 原子写（不进 argv·token-blind·绝不 echo）。再把**路径**（非密）告诉用户怎么手动装回 vault。
      #   recovery 文件本身写不进（连这都失败）才真无可挽回——此时如实告知该号需重 login。
      RECOVERY_DIR="${CC_MASTER_HOME:-${HOME}/.claude/cc-master}"
      RECOVERY_FILE="${RECOVERY_DIR}/rotated-blob-recovery.${EMAIL}.$$.json"
      recovery_ok=0
      if ( umask 077; mkdir -p "$RECOVERY_DIR" 2>/dev/null ); then
        if printf '%s' "$NEW_BLOB" | node -e '"use strict";const fs=require("fs");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{fs.writeFileSync(process.argv[1],s,{mode:0o600});fs.chmodSync(process.argv[1],0o600);process.exit(0)}catch(e){process.exit(1)}})' "$RECOVERY_FILE" 2>/dev/null; then
          recovery_ok=1
        fi
      fi
      err "error: refresh token 已被服务端**轮转**、但回写 cc-master vault 失败（权限 / 磁盘满 / keychain 错）——新 refresh token 是唯一副本。"
      if [ "$recovery_ok" -eq 1 ]; then
        err "  ✓ 已把轮转后的完整 blob 抢救到 0600 recovery 文件（绝不丢该 token）：${RECOVERY_FILE}"
        err "    恢复：修好 vault 写入问题后，把该文件内容装回 ${EMAIL} 的 vault（file vault：写成 ${EMAIL}_TOKEN=<该文件内容> 一行；keychain：security add-generic-password -U -s <service> -a ${EMAIL} -l \"cc-master OAuth\" -w \"\$(cat 该文件)\"），然后 rm 该 recovery 文件。"
      else
        err "  ✗ 连 recovery 文件也写不进（${RECOVERY_DIR} 不可写？）——轮转后的新 token 无法保存：该号 vault 只剩已吊销旧 token，"
        err "    需**重新登录** ${EMAIL}（Orca / claude login）后跑 /cc-master:accounts --refresh ${EMAIL} 重录完整 blob。"
      fi
      err "  **未覆写任何官方存储、registry 原封不动**（不冒险继续到会丢弃 NEW_BLOB 的覆写路）。"
      exit 1
    fi
    err "switch-account: ⚠ vault 回写失败（refresh token 未轮转·旧 token 仍有效）——三存储仍会覆写（换号继续），但 cc-master vault 里 $EMAIL 的 access token 未更新到最新（下次换回可能需 --refresh）。"
  fi
fi

# **跨进程换号锁（codex round#14 Finding A/B·串行化整个「覆写三存储 → setActive」临界段）**：registry 锁 / vault 锁
#   只各自保护自己那个文件，挡不住两个并发 switch 的**官方三存储覆写交错**（A 写文件、B 写全三存储+翻 active B、A 再
#   写 keychain+翻 active A → 文件 B、keychain/registry A·split-brain）。修：用一把**换号级锁**（键在官方 credentials.json
#   路径上·所有 switcher 共同争用）罩住 step 3（覆写）+ step 4（setActive）整段——同一时刻只一个 switch 跑这段·消除交错。
#   锁也覆盖「覆写提交完成 → setActive 落盘」那个窗口（codex round#14 Finding B）：持锁到 setActive 完成才释放，期间
#   被中断由 overwrite 的 INT/TERM trap 兜（窗口内回滚 ①②）。token-blind：锁文件零 token；锁键是非密路径。
# SWITCH_LOCK_TARGET / SWITCH_LOCK_OWNER / release_switch_lock 已在脚本上半身声明（供 EXIT/INT/TERM trap 统一释放·
#   绝不在此另设 trap 覆盖掉 on_exit_or_interrupt·codex round#14 实现纪律）。这里只设 target + 取锁。
SWITCH_LOCK_TARGET="${CRED_PATH:-${HOME}/.claude/.credentials.json}"
SWITCH_LOCK_OWNER="$(node -e 'try{const l=require(process.argv[1]);const h=l.acquireFileLock(process.argv[2],{livePid:Number(process.argv[3])});process.stdout.write(h.owner||"")}catch(e){process.exit(1)}' "$LIB_JS" "$SWITCH_LOCK_TARGET" "$$" 2>/dev/null)" || SWITCH_LOCK_OWNER=""
if [ -z "$SWITCH_LOCK_OWNER" ]; then
  err "error: 无法取得换号锁（${SWITCH_LOCK_TARGET}.lock·另有 switch 在跑 / node 不可用）——**拒绝无锁覆写官方存储**（防并发交错三存储损坏），未换号、registry 原封不动。"
  exit 1
fi

# 3) 覆写官方三存储（先非权威后权威）。① credentials.json 失败 = 致命（凭证主存未更新）→ 退非 0、不翻 registry。
if ! overwrite_official_stores "$NEW_BLOB" "$REG_IDENTITY_JSON"; then
  err "error: 覆写官方凭证存储失败（见上面 stores: 标到哪步）——换号未完成。registry 不翻 active（避免「registry 标新号、存储仍旧号」损坏态）。"
  # ③ keychain 失败时 overwrite_official_stores 已回滚 ①②到旧号（全或无·P2-C），三存储与 registry 全留旧号·不再 split-brain；
  #   surface 让用户对账（仅当回滚自身也失败才可能 split-brain·已在 stores: 强告警）；registry 不翻（active 仍指旧号·保守）。
  release_switch_lock
  exit 1
fi
# 新号已被官方三存储接管；NEW_BLOB 用完即弃（绝不进 registry）。
unset NEW_BLOB VAULT_BLOB 2>/dev/null || true

# 4) setActive + snapshot（覆写三存储成功之后才翻 registry active·P2-2 解耦）。
#    **顺序：先 (B) setActive 再 (A) snapshot（codex round#1 Finding 2·split-brain 窗口收口）**。
#    病根：旧顺序是先跑 best-effort 快照（内含可慢/可挂的 cc-usage，timeout 默认已调到 60s）再 setActive——
#    三存储**已**覆写成新号、但 registry 的 active 要等快照那一长段（最坏 60s 挂等）之后才翻。这段窗口里若
#    用户中断 / shell 被 kill / session 死掉，机器实际在新号、accounts.json 仍标旧号 active = 正是 timeout
#    想最小化的 split-brain。修：把**关键态 setActive 提到 best-effort 快照之前**——三存储一覆写成功就立刻、
#    可靠地翻 active（独立落盘·与快照解耦·P2-2），registry 与现实瞬间一致；之后慢/挂的快照再久也只影响一条
#    可选观测、绝不再留 split-brain 窗口。切出号身份在翻 active **之前**先钉进 CURRENT_ACTIVE（见 record_switch_out
#    注释·翻转后 active 已是切入号，不先钉会把切入号误当切出号跳过快照）。
if [ "$NO_SNAPSHOT" -ne 1 ]; then
  detect_current_active  # 翻 active 前钉切出号身份（setActive 后 registry active 已是切入号·不先钉会丢切出号）。
fi
set_active_in            # (B) 翻 active 到切入号——关键态·三存储已覆写就立刻可靠落盘（与快照解耦·不等 best-effort 快照）。
ACTIVE_ALIGNED=1         # **active 已对齐（codex round#17）**：set_active_in 跑完（成功翻 / 或已如实标 misalign）→ trap 不再前向 setActive（幂等·避免重复）。
COMMIT_WRAPPED_BLOB=""   # 收尾完成·清掉 trap 前向补写 keychain 的 token 物料（token 清理·此后 trap 不再需要它）。
if [ "$NO_SNAPSHOT" -ne 1 ]; then
  record_switch_out      # (A) 写切出快照——慢/挂只影响这一条可选观测，绝不阻断、绝不再留 split-brain 窗口（active 已先翻）。
fi
# **释放换号锁（codex round#14）**：到这里覆写三存储 + setActive 整段临界已完成（registry active 已对齐或已如实标 misalign），
#   其它并发 switch 可以进了。snapshot 是 best-effort 后置观测·不在临界保护内（它若失败也只少一条·不影响 active 正确性）。
release_switch_lock

# **最终消息按 active 是否落盘成功分两路（codex round#2 Finding B·不谎报干净成功）**：
#   · active 落盘成功（ACTIVE_WRITE_FAILED=0）→ 干净的「✓ 换号完成」+ exit 0。
#   · active 落盘失败（=1）→ 换号本身已生效（三存储已是切入号·claude 会接管新号），但 registry active 与现实脱节——
#     **不打印干净成功**：标注「换号已生效·但 registry 需手动对账」+ exit 4（区别于干净成功的 0），让调用方/编排者
#     知道要对账（不回滚已成功的 token 切换·回滚一个已生效的换号风险更大；registry 滞后是可对账偏差、非 token 泄漏）。
if [ "${ACTIVE_WRITE_FAILED:-0}" -eq 1 ]; then
  err "⚠ 无重启换号已生效但 registry 未对齐：官方共享凭证三存储已覆写为 ${EMAIL}（\$USER=${USER} 视角·claude 会接管新号），"
  err "  但 registry 的 active 标记落盘失败、仍与现实脱节——**这不是干净成功**：请 /cc-master:accounts --list 对账、修好 accounts.json 后重跑换号让 active 归位（三存储已是新号·重跑幂等）。"
  if [ "${FORCE_REFRESH_FALLBACK:-0}" -eq 1 ]; then
    err "  （本次走 force-refresh 兜底：覆写原 blob + 临近过期逼 claude 自己 refresh·有 vault-stale 风险，见上。）"
  fi
  exit 4
fi
err "✓ 无重启换号完成：官方共享凭证三存储已覆写为 ${EMAIL}（\$USER=${USER} 视角）。"
err "  运行中的 claude 在 access token 临近过期时会惰性 refresh、重读被覆写的存储 → 新号接管（无需重启进程）。"
if [ "${FORCE_REFRESH_FALLBACK:-0}" -eq 1 ]; then
  err "  （本次走 force-refresh 兜底：覆写原 blob + 临近过期逼 claude 自己 refresh·有 vault-stale 风险，见上。）"
fi
exit 0
