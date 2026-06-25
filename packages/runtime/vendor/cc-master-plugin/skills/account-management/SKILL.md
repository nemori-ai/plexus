---
name: account-management
description: '管理 cc-master 换号号池（accounts.json registry）+ vault token 的录入 / 选号调度 / 切换机制——号池怎么建（add/delete/refresh/list）、怎么按配额恢复推算选最优切入号、怎么把 token 安全切入、token 怎么只进 keychain/file vault（account / token / 备号 / 号池 / 换号 / vault / 选号 / 配额轮换）。Use when 要录入或删除备号、要换号切配额、要让 agent 跑账号脚本、要懂选号算法或 vault 安全纪律。Do NOT use when 你要的是「该不该换号」这个编排 pacing 决策（那归 orchestrating-to-completion）或 workflow 脚本怎么写（那归 authoring-workflows）。'
---

# account-management — cc-master 换号号池的机制层

> **红线 3 边界（一句话）**：换号**决策**的认知——何时换、值不值得换、谁拍板——归 `orchestrating-to-completion`（它在 pacing 决策点引用本 skill）；本 skill 只管**机制**：怎么选号、怎么切、怎么管 vault。三个分发 skill 关注面正交、单向引用、不复述彼此：
> - **orchestrating-to-completion** = 编排者做什么（含「逼顶该不该换号」的 pacing 决策 + 决策程序）。
> - **authoring-workflows** = workflow 脚本怎么写。
> - **account-management（本 skill）** = 号池怎么管 + 怎么选号切号 + token 怎么安全存取（账号基础设施的机制层）。

## Contents

- [号池模型（accounts.json registry）](#号池模型accountsjson-registry)
- [四件事 + 对应脚本](#四件事--对应脚本)
  - [录号机制：keychain 直读当前登录号的完整 blob](#录号机制keychain-直读当前登录号的完整-blob)
- [token 安全纪律（HARD·机制命门）](#token-安全纪律hard机制命门)
- [无 registry = 天然单账号](#无-registry--天然单账号)
- [Rationalization Table](#rationalization-table)
- [Red Flags](#red-flags)
- [Pointers](#pointers)

---

## 号池模型（accounts.json registry）

一个用户级、跨编排、跨 repo 的号池台账：`${CC_MASTER_HOME:-$HOME/.claude/cc-master}/accounts.json`（schema `cc-master/accounts/v1`，`0600`，**绝不落 repo 树**）。它把每个 **email**（账号唯一标识）映射到：

- **`vault` 引用**——token 在哪取的**非密指针**（`{kind: keychain, service, account}` 或 `{kind: file, path, key}`），**不是 token 值**。
- **三个时间戳**——`token_added_at` / `token_refreshed_at` / `token_expires_at`（严格 ISO-8601-UTC `YYYY-MM-DDTHH:MM:SSZ`，定宽 Z 后缀使字典序==时间序）。
- **`active`**——是否当前在用号（全 registry 至多一个 true·active 唯一性，由 switch 维护）。
- **`switchable`**——该号能否无重启换号切入：`false` = 残缺号（只含 access token、无 refresh token，切不进，选号硬排除、不计 effective-N）；缺省 / 未设 = 视作可切（不破既有完整号）。
- **`identity`**——`~/.claude.json` 的 `oauthAccount` 原样副本（**全非密**·`accountUuid`/`emailAddress`/org…），换号 ②段用它整体替换官方 `oauthAccount`、让换号真切**身份**而不只切 token。
- **`subscription_type`**——非密订阅枚举（`pro`/`max`/`team`/`enterprise`…），录号那刻从 blob 抄下的非密元信息。
- **`last_observed_quota`**——录号那刻 `cc-usage.sh` 的配额快照（`{5h,7d}.{used_pct,…}`），选号的**弱信号**（比 `last_switch_out` 弱、仅供从没切出过的新号参考）。
- **`last_switch_out`**——最近一次从该号切出时的 `{5h,7d}.{used_pct, resets_at, source}` 配额快照（选号算法的核心输入；null = 从没切出过的新号）。

**关键不变式**：registry **零凭证**——读到它的任何 agent / 程序都无害（vault 是指针，仍要过 OS keychain 解锁 / 文件 0600 才拿得到 token）。schema 字段 / 校验 / 读写 helper 的机制 SSOT 是 `${CLAUDE_SKILL_DIR}/scripts/accounts-lib.js`（node 纯函数库，零 token，校验器主动断言「无疑似 token 值」防误写）。**并发安全**：所有「读-改-写」registry 的操作（录号 / 换号翻 active / 写快照 / 删号）都经 `mutateRegistry`（accounts-lib.js）在一把咨询文件锁（`accounts.json.lock`·O_EXCL + stale 回收）内串行执行——防并发进程各自 load 旧态、后写覆盖先写的 lost-update。完整字段表 + 示例见 `${CLAUDE_SKILL_DIR}/assets/accounts.example.json`。

## 四件事 + 对应脚本

号池机制是四件正交的事，各有一个带外脚本（**全不进 hooks/**·红线 1/5；agent 用 Bash 直接跑——唯一前提是 add/refresh 时**用户当前正登录在目标号**）：

| 事 | 脚本（`${CLAUDE_SKILL_DIR}/scripts/`） | 做什么 |
|---|---|---|
| **录号 / 续期** | `account-add.sh`（续期 = 对同一 email **重跑**，幂等 upsert·**无** `--refresh` flag） | 从 macOS keychain「Claude Code-credentials」(`account=$USER`) **直读当前登录号的完整 `claudeAiOauth` blob**（含 refreshToken·只读不写官方凭证、不扰动登录）→ 校验三必需字段 → 存 vault → 写 registry entry（email→vault 引用 + 时间元信息 + 非密身份 + `active:true`，全非密）。续期就是对已录的同一 email 重跑本脚本：keychain `-U` 原地更新 / file 删旧行再 append / registry 刷 `token_refreshed_at`（首次 `token_added_at` 保留）。 |
| **删号** | `account-delete.sh` | 删 vault 项/行（按前缀，不读值）+ 删 registry entry（删 active 号要清 active）。 |
| **对账** | `account-list.sh` | 只读列 email + vault 形态 + 到期日 + active + 距各窗口 reset 推算——**绝不取 token 值**（keychain 不带 `-w`）。 |
| **选号 + 换号** | `select-account.js`（选）+ `switch-account.sh`（切） | 选号：按切出快照 + reset 推算选最优切入号。换号 = **无重启凭证覆写**（不再 exec 重启 / 不再 `--resume` 续板）：切前选号 → 对切出号写配额快照 → 从 vault 取完整 blob → 用 refreshToken 主动续期新号 → **覆写官方共享凭证三存储**（① `~/.claude/.credentials.json` `.claudeAiOauth` ② `~/.claude.json` `oauthAccount` ③ keychain「Claude Code-credentials」·原子写·全或无回滚）→ 翻 registry `active`。运行中 claude 进程在 access token 临近过期时**惰性 re-read 被覆写的存储、接管新号**——进程不重启、board 不动、session 不换（`--board` 选择器已 deprecated no-op）。凭证全程经 vault 读 / refresh POST body / 三存储写，绝不进 agent / argv / registry。 |

**选号算法**（W5/W7 加权恢复度 + 7d 硬总闸 + source 信任分级 + 临到期降权）的方法论见 [`references/account-scheduling.md`](references/account-scheduling.md)——`select-account.js` 是它的落地，权重/阈值是脚本顶部可 env 覆写的常量。**选号是机械选择，切不切仍由编排者/用户拍**——尤其全员逼顶（`select-account.js` exit 3 = NONE_ALL_EXHAUSTED）必须 surface 给用户（对齐 7d 总闸纪律，是 `blocked_on:"user"` 决策），绝不盲目切进一个一样满的号。

### 录号机制：keychain 直读当前登录号的完整 blob

agent 用 Bash **直接跑** `account-add.sh` 就能录号跑通——**全 agentic**：keychain 读 + vault 写 + registry 写都从 agent 的 Bash 上下文跑通（无浏览器、无 TTY 需求），唯一前提是**用户当前正登录在目标号**。地基机制（**机制知识**，不靠纪律闸守、记录是为了让读 SKILL 而没开脚本的人也拿到这条 why）：

- **捕获源 = macOS keychain「Claude Code-credentials」(`account=$USER`)，不是 `setup-token`、不是 `credentials.json` 文件。** 脚本 `security find-generic-password -w -s "Claude Code-credentials" -a "$USER"` **直读当前机器登录号的完整 `claudeAiOauth` blob**（`{accessToken,refreshToken,expiresAt,scopes,subscriptionType,…}`），经 `security … | node …` 管道喂 node 校验三必需字段（`accessToken` 前缀 `sk-ant-oat` / **`refreshToken` 前缀 `sk-ant-ort`·非空** / `expiresAt` 数字）后存进 vault。**只读、不写**官方凭证 → **不扰动用户的登录**（旧 `setup-token` 流会重认证、把用户登出的整套副作用 moot 了）。非 mac / 无 keychain → 降级读 `~/.claude/.credentials.json` 的 `.claudeAiOauth`。
- **refreshToken 是硬要求——无重启换号死依赖它。** vault 必须存**含非空 refreshToken 的完整 blob**：cc-master 的换号是**无重启凭证覆写**（switch 覆写官方共享凭证、运行中 claude 惰性 re-read·见 §四件事「选号 + 换号」行），它靠 refreshToken 续期——keychain blob 里的 access token 仅 ~8h 有效，无 refreshToken 续不上、切进去很快认证失败。**只有真 `/login` 走完整 OAuth 才在 keychain 写下非空 refreshToken**；`claude setup-token`（旧弃用路径）铸长寿命 headless token、**结构上不产生 refreshToken**，且 spike 实测 `~/.claude/.credentials.json` 文件里 refreshToken 值为空（残缺副本）。取不到非空 refreshToken → 脚本 **FAIL + 提示「你多半没真 `/login`（setup-token 不给 refreshToken）→ 请用 Orca / `claude login` 登录后重跑」**，绝不存残缺 blob。
- **身份匹配 guard——「要录号 X，你必须当前正登录在 X」。** keychain 里永远是机器**当前登录号**的 blob（与 `--email` 无绑定）。脚本读 blob 前先读 `~/.claude.json` 的 `oauthAccount.emailAddress`（当前登录身份）、要求 == `--email`，否则 FAIL——否则会把当前登录号 B 的 blob 错标成 `--email` A（A 的 entry 实指 B 的凭证 = 选号/换号灾难）。这是脚本自身固化的护栏，不是靠 orchestrator 每次拿纪律扛。**建池流程**：登录 A → `--add A`；用 Orca / `claude login` 切到 B → `--add B`（每次录的就是当前登录号）。
- **fallback 诚实兜底**：`script` 缺失 / 提取失败时，脚本退回手动录入骨架（token 由 OS 工具在用户终端原生收，绝不静默存错）。

## token 安全纪律（HARD·机制命门）

> bearer token = possession-equals-access。这是本 skill 全部脚本的命门，**逐条不可破**——它不是新发明的纪律，是 `switch-account.sh` / `account-add.sh` 安全开头已逐字落地、并经实战换号验证的 HARD 契约的 SSOT 复述。canonical 机制（vault 两形态、argv 写 keychain（128 字节例外）、email 元字符 `awk index($0,p)==1` 行首锚定安全、no-leak 保证、file vault 明文 floor 的诚实披露）见 [`references/vault-security.md`](references/vault-security.md)。

四条不可破：

1. **token 只进 vault，绝不进 agent context / transcript / log / registry / board / commit（写 keychain 的 sub-second 本机 `security` argv 是单一例外·决策 A）。** token 唯一的合法落点是 keychain（mac 首选）或 0600 file vault（ship-anywhere floor）。换号（无重启凭证覆写）时凭证的合法去向是：从 keychain refresh-token 经 **node https POST body** 续期（**绝不**用 curl 把 token 放命令行）、再把新 blob 经 **stdin 喂 node 原子写官方凭证文件**（**refresh POST body / 文件 stdin 仍绝不进 argv**，`ps` 看不到 token）+ 经 **argv `-w "$blob"` 写 keychain**（**单一审计过的例外**：stdin 的 `-w` 走 readpassphrase 有 128 字节硬上限，会把 ~471 字节 blob 截成残片丢 refreshToken·完整 >128 字节 blob 只能作 argv·见 [`references/vault-security.md`](references/vault-security.md)）。**网络续期 / 文件原子写绝不把 token 放 argv**（如 `env NAME=VAL cmd` 会把 `NAME=VAL` 当进程 argv 元素、ps 可见·P2-6 反模式）——这两条都有 stdin / POST body 的非-argv 正路，绝不退回命令行；keychain 写是唯一没有非-argv 正路的写（按决策 A 走 argv，窗口仅 sub-second 本机、不引入新暴露面，**经审定不可外推**到任何有 stdin 正路的写）。**accounts.json 只写 vault 非密指针 + 用量快照**——「0600 一样安全所以放 registry 省事」是错的：registry 是会被 cat / 贴 bug 报告 / 截图 / 同步 / 误 commit 的台账，token 进去就把每个日常操作变成泄漏面（这正是「指针 vs 值」分离的意义）。
2. **token 经预设脚本读写，agent 绝不手改 vault / 绝不手 cat token。** 录号/换号/续期都跑既有脚本——脚本是 token 的隔离边界，agent 跑脚本但**不见 token**（录号时完整 blob 经 `security … | node …` 管道直读 keychain→校验→进 vault 全程在管道/子进程，绝不落 agent 可见变量；stdout 只回非密的「✓ 已存入（blob <redacted>）」+ registry 非密元信息）。agent 绝不自己拼 `security … -w` 取值、绝不 `cat accounts.env`。
3. **诊断只打印非密派生事实，绝不打印 token 值 / 绝不 `set -x`。** 排查换号失败时打印「取没取到 / 长度 / 哪条 vault 路径匹配 / non-empty:yes/no」即可定位——**token 原值零诊断信号、纯负债**。`set -x`（xtrace）会把变量赋值与 `exec` 行回显明文 token，故脚本第一条可执行语句无条件 `set +x` + `unset SHELLOPTS`（堵 env 继承的 xtrace），先于任何碰 token 的代码。
4. **file vault email 行匹配用 `awk index($0,p)==1`（行首锚定·定字符串），绝不裸正则、读 token 行也绝不 `grep -F`。** email 含 `.`/`@` 是正则元字符——`grep -E "^${email}_TOKEN="` 会让 `alice@x.com` 误匹配 `alicexxxcom`、静默取错号 token；而 `grep -F` 虽免疫元字符却是**子串**匹配（非行首锚定），重叠标识（`xalice@x.com_TOKEN=` 在前）下取错行 → 整行畸形当 token（P2-5）。`accounts-lib.fileVaultLineMatch` 给安全前缀，读/删/写一律 `awk -v p="<prefix>" 'index($0,p)==1'`（读）/ `index($0,p)!=1`（删）取行。

> **违背字面就是违背精神。** 「就这一次、就调试一下、反正 0600 一样、反正只进我终端不 commit」是攻破上面每一条的那句合理化——日志/transcript/scrollback 都是持久痕迹，token 一旦落进去就要重新 vault 每个号。没有哪次换号特殊到命门失效。

## 无 registry = 天然单账号

accounts.json **不存在** = 用户从没用过号池 → 优雅降级单账号（switch 的选号返回 NONE「先录号」、hook 注入 effective-N=1）。存在但 `accounts:{}` = 号池空（同单账号，但语义可区分）。≥2 个号 = 真号池，选号可选最优切入。**缺失/坏 JSON 一律 fail-safe 降级单账号，绝不崩**——对齐所有脚本/hook 的「缺失即优雅降级」纪律。

## Rationalization Table

| 借口 | 现实 |
|---|---|
| 「token 进 accounts.json 吧，0600 一样安全、switch 脚本能省 40 行。」 | registry 是会被 cat / 贴报告 / 截图 / 同步 / 误 commit 的非密台账——token 进去把每个日常操作变成泄漏面。指针 vs 值的分离不是官僚，是让 registry 永远可安全读。token 只进 vault。 |
| 「base64 一下 / 加个 `# sensitive` 标记再放 registry，又简洁又标了密。」 | base64 是 `atob()` 一下就解、不是加密；标「敏感」只让你**感觉**处理了却 ship 同一个泄漏——这是把坏版本洗过自己判断的最危险选项。 |
| 「就 `echo $TOKEN` / `set -x` 跑一次调试，只进我终端不 commit，看完就删。」 | transcript / scrollback 都是持久痕迹，`set -x` 由构造在 exec 行泄 token。换号失败靠长度 / non-empty / 哪条 vault 匹配就能定位——token 原值零诊断信号、纯负债（泄一次要重 vault 每个号）。 |
| 「agent 直接 `cat accounts.env` 把 token 读出来注入更快。」 | 脚本是 token 的隔离边界——agent 跑脚本但不见 token。手 cat / 手拼 `security -w` 取值绕过了这道边界，token 落进 agent context。永远经预设脚本。 |
| 「全员都逼顶了，随便选个号切进去先续上。」 | 切进一个一样满的号马上又被 7d 卡、白切一次（白白 refresh + 覆写三存储一轮）。全员逼顶（select exit 3）是 `blocked_on:"user"` 决策——surface 用户拍「等 reset 还是别的」，绝不盲切。 |

## Red Flags — STOP，你在破命门

- 「token 进 registry 省事 / 0600 一样安全」——你在把凭证写进非密台账。
- 「base64 / 标个 sensitive 再放 registry」——你在洗一个泄漏过自己的判断。
- 「`echo $TOKEN` / `set -x` 调一次就删」——你在往持久痕迹里印明文 token。
- 「我 `cat accounts.env` / 手拼 `security -w` 自己取 token」——你在绕过脚本这道隔离边界。
- 「`grep -E "^${email}_TOKEN="` 取行」——email 元字符会静默取错号；用 `awk index($0,p)==1` 行首锚定（连 `grep -F` 都不够——子串匹配，重叠标识下取错行→整行畸形当 token·P2-5）。
- 「全员逼顶了随便选一个切」——该 surface 用户的决策被你私吞了。

## Pointers

- **[`references/account-scheduling.md`](references/account-scheduling.md)** — 选号算法方法论：W5/W7 加权恢复度、5h/7d reset 恢复推算（二值 + resets_at tiebreak）、7d 硬总闸、source 信任分级、临到期降权、边界处理。
- **[`references/vault-security.md`](references/vault-security.md)** — token 安全纪律 canonical 机制 SSOT：keychain/file vault 两形态、argv `-w "$blob"` 写 keychain（128 字节例外）、email 元字符 `awk index($0,p)==1` 行首锚定安全、no-leak 保证、file vault 明文 floor 的诚实局限。
- **`${CLAUDE_SKILL_DIR}/scripts/accounts-lib.js`** — accounts.json 读写校验库（node 纯函数，零 token，疑似 token 硬错断言）。
- **`${CLAUDE_SKILL_DIR}/assets/accounts.example.json`** — schema v1 示例（vault 引用 + 三时间戳 + active + last_switch_out，零 token）。
- **`orchestrating-to-completion`** — 换号**决策**（何时换、谁拍板）+ pacing 走廊；它在 pacing 决策点引用本 skill 的机制。本 skill 不复述编排决策程序。
