# vault 安全纪律 —— canonical 机制 SSOT

> 这是 cc-master 换号 token 安全的**单一真相源**。SKILL.md 立四条命门纪律（HARD），本文是它们的机制全貌——`account-add.sh` / `account-delete.sh` / `account-list.sh` / `switch-account.sh` 的安全开头逐字落地这套；orchestrating-to-completion 的 pacing 段**引用本文**（不复述机制）。token = bearer secret（possession-equals-access），下面每条都是逐条不可破的 HARD 约束。

## Contents

- [vault 两形态](#vault-两形态)
- [keychain 写：argv -w "$blob"（完整 blob 不被 128 截断）](#keychain-写argv--w-blob完整-blob-不被-128-截断)
- [file vault 写 / 读：email 元字符 awk index 行首锚定安全](#file-vault-写--读email-元字符-awk-index-行首锚定安全)
- [token no-leak 保证（脚本子进程隔离边界）](#token-no-leak-保证脚本子进程隔离边界)
- [registry 零凭证](#registry-零凭证)
- [file vault 明文 floor 的诚实局限](#file-vault-明文-floor-的诚实局限)
- [agentic 录号的安全闭环](#agentic-录号的安全闭环)

## vault 两形态

token 的唯一合法落点，逐字对齐所有脚本的读写形态：

- **形态 1 —— mac keychain（首选）**：`{kind: keychain, service: "cc-master-oauth", account: <email>}`。token 在 OS keychain，**agent `cat` 不到**——这是 floor 之上的真防护。
- **形态 2 —— 0600 file（ship-anywhere floor）**：`{kind: file, path: ~/.claude/cc-master/accounts.env, key: <email>}`。行格式 `<email>_TOKEN=<value>`（+ 可选 `<email>_EXPIRES=YYYY-MM-DD` 非密旁存）。非 mac 没有 keychain 时的底线。

vault 路径必须在 gitignored 用户级区（`~/.claude/cc-master/` 或 `${CC_MASTER_HOME}`），**绝不在 repo 树内**；`umask 077` 建、`0600` 权限。

## keychain 写：argv -w "$blob"（完整 blob 不被 128 截断）

写完整 OAuth blob 进 keychain 的**唯一正确姿势是把 blob 作 `-w` 的 argv 值**：

```
security add-generic-password -U -s <service> -a <email> -l "cc-master OAuth: <email>" -w "$blob"
```

- **`-U`**：项已存在则原地更新（refresh 复用同一条，不删建）。
- blob 作 `-w "$blob"` 的 argv 参数一次性整条写入，命令完即 unset。

### 为什么不能用 stdin（128 字节硬截·实测坐实的 bug）

`security add-generic-password -w`（末位不带值）会从 **stdin** 读密码——而 `security` 走 `readpassphrase` 读 stdin，**硬上限 128 字节**：超过 128 字节的输入被**静默截断**成残片。完整 OAuth blob 约 **471 字节**（含 accessToken + **refreshToken** + expiresAt 的单行 JSON），经 stdin 喂会被截成头 128 字节、**丢掉 refreshToken**——而无重启换号死依赖 refreshToken 续期。截断后的残片仍能写进 keychain、读出来却 `JSON.parse` 失败或缺 refreshToken，是一类**写时不报错、换号时才炸**的隐性损坏。故 keychain 写 **绝不走 stdin**。

### 为什么 argv 可接受（决策 A·token-blind 细化）

官方「Claude Code-credentials」keychain 条目必须是**单条完整 blob**——claude 用 Keychain API 把它当**一条**读、**不可 chunk** / 不可分多条拼。`security` CLI 要写一条完整 **>128 字节**的值，**唯一**办法就是把值作 `-w` 的 **argv 参数**（stdin 这条路被 128 上限堵死）。

token-blind 铁律据此**细化为「token 绝不进 agent context / transcript / log / registry」**，并**接受**写 keychain 时 blob 经 `security` 子进程 argv 的 **sub-second 本机局部暴露**：能读你进程 argv（`ps` / process snapshot）的攻击者必是**同用户**——而同用户本就能直接 `security find-generic-password -w` 读出 keychain 里的 token，**argv 不引入新暴露面**。这一窗口仅存在于 `security` 进程存活的亚秒级、且永不进任何会被打印/留存/同步的渠道（agent context / transcript / log / registry 仍零 token），故按决策 A 可接受。

## file vault 写 / 读：email 元字符 awk index 行首锚定安全

> **§A.4 必修 bug（A2 放大）+ P2-5**：email 含 `.`/`@` 是正则元字符。`grep -E "^${email}_TOKEN="` 让 `alice@x.com` 误匹配 `alicexxxcom`——**静默取错号 token / 删错行**。A2 用 email 当标识，让 `.`/`@` 必然出现，放大了这个 bug。**P2-5 进一步**：连 `grep -F`（定字符串）也不够——`grep -F` 是**子串**匹配、**非行首锚定**，重叠标识（`xalice@x.com_TOKEN=` 排在 `alice@x.com_TOKEN=` 之前）下会先命中 `xalice` 那行，随后参数展开切前缀因前缀不在行首而**不剥离 → 整行（畸形）当 token 注入**。

修复：**绝不在 bash 手拼正则匹配 email 行，读 token 行也绝不 `grep -F`（子串匹配会取错行）**。`accounts-lib.fileVaultLineMatch(email)` 返回安全前缀（`<email>_TOKEN=` / `<email>_EXPIRES=`），调用方一律用 **`awk index($0,p)==1`（行首锚定·定字符串·对 `.`/`@` 元字符天然免疫）**：

- **读**（switch-account.sh `read_token_file` / 到期巡检）：`awk -v p="<prefix>" 'index($0,p)==1' "$VAULT_FILE" | head -1` —— `index($0,p)==1` 只取「以该前缀**起头**」的行（行首锚定），既对 `.`/`@` 元字符免疫、又不会被重叠标识的子串误匹配（P2-5：`grep -F` 子串匹配会取错行→整行畸形当 token）。取到行后**参数展开切前缀**取值，绝不 `echo` 整行。
- **删 / 重写**（account-add.sh 续期删旧行 / account-delete.sh 删号 / switch-account.sh writeback）：用 `awk` 保留「**既不以 `<email>_TOKEN=` 也不以 `<email>_EXPIRES=` 起头**」的行——**必须用这两个精确前缀（`fileVaultLineMatch` 的 `tokenLine`/`expiresLine`），绝不用宽 `<email>_` 前缀**（重叠标识 bug·codex round#3/#5）：宽 `<email>_` 会把 sibling 号 `<email>_bar_TOKEN=` / `<email>_bar_EXPIRES=` 也删掉、误毁另一个号使其 unswitchable（脚本接受任意非空 email、file-vault key 是纯字符串，`foo` 与 `foo_bar` 这类前缀重叠真实存在）。删本号全部记录 = 同时筛掉这两个**精确**前缀的行：`awk -v t="<email>_TOKEN=" -v x="<email>_EXPIRES=" 'index($0,t)!=1 && index($0,x)!=1'`（writeback 只删 `_TOKEN=` 保 `_EXPIRES=`，则只筛 `tokenLine` 一个）。同一族行首锚定、定字符串前缀、对元字符免疫。
- **绝不 `. "$VAULT_FILE"`**（source 会把所有备号 token 灌进当前 env，扩大泄漏面 / 污染子进程）——逐行只切本号那行的值。

> **为什么读 token 行从 `grep -F` 升到 `awk index($0,p)==1`（P2-5）**：`grep -F` 解决了「`.`/`@` 元字符误匹配」，但它仍是**子串**匹配——重叠标识下取错行，且取错行后参数展开切前缀失败 → 整行畸形当 token。`awk index($0,p)==1` 同时拿下两道（行首锚定 + 定字符串），与删/写行的 `index!=1` 同一族范式。读 token 行**绝不用 `grep -F`**。

## token no-leak 保证（脚本子进程隔离边界）

token 读进 shell 变量后：**绝不 echo / 绝不 print / 绝不写任何日志 / 绝不进 board / 绝不进 registry / 绝不 commit / 绝不拼进任何会被打印的字符串。** 两道结构性防护：

1. **关 xtrace（第一条可执行语句）**：`set -x`（xtrace）会把变量赋值与一切碰 token 的命令行回显明文 token 到 stderr。故脚本**无条件** `set +x`（关本 shell xtrace）+ `unset SHELLOPTS 2>/dev/null`（堵 env 继承的 `SHELLOPTS=xtrace` 在子 shell 复活 set -x），**先于任何碰 token 的代码**。两条来源都堵：① 有人 `bash -x` 显式调试；② env 继承的 xtrace。
2. **token 绝不进 agent context / transcript / log / registry（token-blind 铁律·决策 A 细化）。** 换号现在是**无重启凭证覆写**（不再 `exec claude`）：① 用 keychain 里的 refreshToken 经 **node https POST body** 主动续期出新 access token（**绝不**用 `curl` 把 token 放命令行）；② 把续期后的完整 blob 经 **stdin 喂 node** 原子写官方凭证文件（`~/.claude/.credentials.json` `.claudeAiOauth` + `~/.claude.json` `oauthAccount`）；③ 经 **argv `-w "$blob"`** 写 keychain（**唯一例外**·见上「keychain 写」节：完整 >128 字节 blob 只能作 argv，stdin 被 `readpassphrase` 128 截断会丢 refreshToken；这道 sub-second 本机 argv 暴露按决策 A 可接受——可读 argv 者本就能读 keychain）。运行中 claude 进程在 access token 临近过期时**惰性 re-read 这三个被覆写的存储、接管新号**（进程不重启、board 不动）。
   - **网络 / 文件写仍绝不把 token 放 argv（P2-6 反模式·绝不退回）**：任何 `cmd … <token> …`（含 `env NAME=<token> cmd` 把 `NAME=<token>` 当 `env` 自己的 argv 元素、`curl -H "Authorization: Bearer <token>"` 把 token 放 curl argv）在命令执行那一刻 `ps`/process snapshot 都能看到 token——而续期 / 原子写官方文件这两条都有 stdin / POST body 这条不经 argv 的正路，故它们**绝不退回 argv**。正解一律是**经 stdin / POST body 喂**（node https 把 refreshToken 放 POST body、node 原子写经 stdin 读 blob），命令行上永远只有非密路径 / 形态参数、没有 token。**唯一例外是 keychain `security -w "$blob"`**——它没有能写完整 >128 字节的非-argv 路径（stdin 被 128 截断），故按决策 A 走 argv（窗口仅 sub-second 本机、不引入新暴露面）；这是**经审定的单点例外，不可外推**到任何有 stdin 正路的写。
   - **refresh 端点白名单（refresh token 不进非授权端点）**：refresh token 经 POST body 续期时，**POST 到哪个 URL** 也是泄漏面——`REFRESH_TOKEN_URL` 若被污染的 env / 误抄的测试值指到非 Claude 主机或明文 http，refresh token 就被发到攻击者端（虽满足「不进 argv/log」却实质泄漏）。故 `switch-account.sh` 在**构造含 token 的 POST body 之前**先校验 host：只放行 **https 的授权 Claude/Anthropic 主机**（`*.claude.com` / `*.anthropic.com` / `claude.ai`），或**显式 opt-in（`CCM_ALLOW_LOOPBACK_REFRESH=1`）的 loopback**（测试 stub 用）；其它一律拒绝退出、**token 从未进 body、从未上网**。

**诊断纪律**：排查换号失败时只打印**非密派生事实**——取没取到（`non-empty: yes/no`）、长度、首尾空白 / 嵌入换行（经典 `$(...)` 尾换行 bug）、哪条 vault 源匹配。**token 原值零诊断信号、纯负债**：泄一次（哪怕只进终端 scrollback / agent transcript）就要重新 vault 每个号。dry-run 打印一律 `token: <redacted> (长度=N)`。

## registry 零凭证

accounts.json **只写 vault 非密指针 + 用量快照**，**绝不写 token 值**。这不是「方便起见」的取舍——`accounts-lib.js` 的校验器**主动断言无疑似 token**：发现任何 `sk-ant-` 前缀串或 `token`/`oauth`/`secret`/`credential`/`password`/`bearer` 字段名 → 报硬错（防误写）。理由：registry 是会被 `cat` / 贴 bug 报告 / 截图 / 同步 / 备份 / 误 commit / 交给队友调试的台账——token 进去就把每个日常操作变成凭证泄漏。**「指针 vs 值」的分离让 registry 永远可安全读**：任何人读到 vault 引用，仍要过 OS keychain 解锁 / 文件 0600 权限才拿得到 token。

> **`base64` / 标 `# sensitive` 不算缓解**：base64 是 `atob()` 一下就解、不是加密；JSON 不支持注释（得用 `_comment` 键），标「敏感」只让人**感觉**处理了却 ship 同一个泄漏——这是把坏版本洗过判断的最危险路径。token 进 vault，registry 进指针，没有第三条路。

## 轮转后回写失败的 token 抢救（rotated-blob recovery·绝不丢唯一副本）

换号 refresh 时若服务端**轮转**了 refresh token（响应给了新 refresh token），那份新 blob（`NEW_BLOB`）就是新 refresh token 的**唯一副本**——而服务端多半已**吊销**旧 refresh token。此时若回写 cc-master vault 失败（vault 目录不可写 / 磁盘满 / keychain 错），继续到覆写官方存储、而覆写又回滚 → `NEW_BLOB` 被丢弃 → vault 只剩已吊销旧 token = 该号 **brick**（再也切不进·需手动重 login）。

故 `switch-account.sh` 在「轮转 + 回写失败」时：① **硬失败**（未覆写任何官方存储、registry 原封不动·不冒险继续到会丢 `NEW_BLOB` 的路）；② 但在 exit 前先把 `NEW_BLOB` **抢救到一个 0600 recovery 文件**（`${CC_MASTER_HOME:-~/.claude/cc-master}/rotated-blob-recovery.<email>.<pid>.json`·token 经 stdin 喂 node 原子写·绝不进 argv / 绝不 echo·与 file vault 同明文 0600 floor）；③ 把该 recovery 文件**路径**（非密）告诉用户怎么手动装回 vault。这样轮转后的唯一 token **绝不因回写失败而永久丢失**——最坏也只是一次手动恢复，而非 brick。连 recovery 文件都写不进（home 不可写）才真无可挽回，此时如实提示重 login。

## file vault 明文 floor 的诚实局限

**file vault（非 mac 的 `accounts.env`）里是明文 token，对同用户进程不设防**——任何能跑 shell 的进程都能读 0600 文件。这是 ship-anywhere floor 的**固有代价**，不是 A2 引入的（现状 `accounts.env` 也是明文 floor）。**hook 拦不住**：hook 是事件钩子不是文件系统 ACL，看不到 agent 要读什么文件直到 PostToolUse 已读完（红线 4：hook 感知不阻断）。真防护是纵深的：

1. **keychain 优先**（mac）——token 在 OS keychain，`cat` 不到，是真防护。
2. **file vault 是 floor**——其明文局限**结构性存在**，诚实披露：高敏感环境建议用 mac keychain 或外部 secret manager。
3. **prose 纪律**——agent **绝不主动 `cat accounts.env` / 绝不读 token**；这是行为纪律（脚本是隔离边界），不是机制拦截。

**accounts.json 本身非密，不拦 agent 读**——它本就是给 hook/agent 感知号池用的。A2 不新增明文暴露面、不退化安全。

## agentic 录号的安全闭环（keychain 直读）

agent 用 Bash **直接跑** account-add.sh（**捕获源 = macOS keychain「Claude Code-credentials」`account=$USER`**，直读当前登录号的完整 `claudeAiOauth` blob——含非空 refreshToken；不是 `setup-token`、不是 `credentials.json` 文件——spike 实证文件里 refreshToken 值为空），凭证全程在脚本子进程 / 管道内、绝不进 agent：

```
前提：用户当前正登录在 <email>（Orca / claude login）
agent 跑 account-add.sh --email <email>
  → node 读 ~/.claude.json .oauthAccount → 身份 guard：当前登录 email 须 == --email（否则 FAIL·防 B 的 blob 错标成 A）
  → security find-generic-password -w -s "Claude Code-credentials" -a "$USER"  ← 直读 keychain 完整 blob
      | node …  ← blob 经管道喂 node（token-blind：blob 全程在管道、绝不落 bash 变量、绝不 echo）
  → node JSON.parse → 取 .claudeAiOauth → 校验三必需（accessToken sk-ant-oat / refreshToken sk-ant-ort·非空 / expiresAt num）
  → 规整成单行 blob → 存 vault（keychain argv `-w "$blob"`·决策 A / file awk 删旧行 + printf >> 文件，blob 不回显 / 不进 agent context）
  → 写 registry entry（email→vault 引用 + 时间戳 + 非密 subscription_type + identity + active:true，非密）
  → 回 agent：「✓ 已存入（blob <redacted>）」+ registry 非密元信息
  → unset blob
```

**命门**：脚本是凭证的隔离边界——agent 跑脚本但**不见 token**。这正是「最大化 agentic」与「token no-leak」并存的关键：keychain 直读 + vault 写都从 agent 的 Bash 上下文跑通（无浏览器、无 TTY 需求），唯一前提是用户登录在目标号。**取不到含非空 refreshToken 的完整 blob 时绝不存错值**：account-add.sh **FAIL + 提示「多半没真 `/login`（setup-token 不给 refreshToken）→ 请 Orca / claude login 登录后重跑」**，并打印手动录入骨架（引导从 keychain 直读完整 blob），绝不静默写一个残缺 / 坏 blob 进 vault。

### 身份不匹配时的手动恢复路径（vault 自身 blob 旁路）

身份 guard「当前登录 email 须 == `--email`，否则 FAIL」在两种场景下会挡住合法录号：**非 mac 机器**（读不到 keychain 捕获源）、或**官方登录在的不是目标号**（切不过去 / 不想切）。此时有一条**不依赖当前登录**的手动恢复闭环：

1. 把目标 email 的**完整有效 blob**（含非空 refreshToken）手动存进 cc-master vault（keychain `cc-master-oauth` 条目 / file vault 那行——形态见上「vault 两形态」）。
2. 重跑 `account-add.sh --email <email>`。

此时脚本走身份 guard 的**两条旁路**之一（读不出当前登录 email / 当前登录 ≠ `--email`）：在 FAIL 前先调 `try_mark_switchable_from_vault` **token-blind 探测 cc-master vault 自身是否已有该 email 的有效 blob**——有 → 标 `switchable:true`、登记 registry entry（非密）、`exit 0`（**纯恢复标记，不因身份不匹配 FAIL**）；无 → 维持身份 guard 失败的现有行为。

**关键安全性质**：旁路探的是 **cc-master vault 自身**那坨你手动存进去的 blob、**绝不捕获官方 keychain「Claude Code-credentials」**——所以**没有把登录号 B 错标成 A 的 mislabel 风险**（mislabel 风险只存在于「从官方 keychain 直读当前登录号」的捕获路；旁路不碰官方 keychain，故对当前登录身份免疫）。这让残缺号 / 非 mac 号在身份不匹配下仍可被合法恢复成 `switchable:true`，而不破身份 guard 防 mislabel 的本意。
