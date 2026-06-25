---
description: '管理 cc-master 换号号池里的备号 OAuth token（add / delete / refresh / list，email 当标识）——你直接 Bash 跑预设脚本，token 全程活在脚本子进程、绝不进你的 context。'
argument-hint: '--add <email> | --delete <email> | --refresh <email> | --list'
---

管理 cc-master **换号号池**——switch-account.sh 在配额逼顶换号时从这个号池**读** token，本命令是它的**写**侧（add / delete / refresh / list）。号池由两层组成：① 非密 registry `${CC_MASTER_HOME:-$HOME/.claude/cc-master}/accounts.json`（email→vault 引用 + 到期日等元信息，零 token）；② token 本体（macOS keychain service `cc-master-oauth` / 非 mac 走 0600 文件 `${CC_MASTER_HOME:-$HOME/.claude/cc-master}/accounts.env`）。**email 是账号唯一标识。**

你**直接用 Bash 跑** `${CLAUDE_PLUGIN_ROOT}/skills/account-management/scripts/` 下的预设脚本完成每个操作——不要打印命令骨架让用户手抄。脚本封装了全部安全逻辑（token 提取、no-leak、vault 读写、registry 读写、云后端自检、fallback），你只负责把 `$ARGUMENTS` 解析成对的脚本调用、把脚本的非密输出转述给用户。

> **命门——token 永不进你的 context（铁律，违背字面就是违背精神）。** OAuth token 是 bearer secret（持有即可访问）。你跑 account-add.sh 时，完整 OAuth blob 从 keychain「Claude Code-credentials」直读 → 经管道喂 node 校验 → 进 vault 的**全程都活在脚本子进程 / 管道里**——脚本绝不把 blob echo 到 stdout（它有 `set +x` / blob 全程在 `security … | node …` 管道不落变量 / 写回 keychain 时把 blob 作 `security … -w "$blob"` 的 argv 参数、本机 sub-second 局部暴露按决策 A 可接受·见 account-management `references/vault-security.md`），所以凭证 **绝不 echo / 绝不 log / 绝不流回你的 Bash 工具输出 / context / transcript / registry**。你只会看到脚本的非密结果：`✓ 已从 keychain 直读完整 blob 并存入 vault（blob <redacted>）` + 写进 accounts.json 的非密元信息（email→vault 引用 + 到期日 + 身份）。**正因为脚本是凭证的隔离边界，你直接跑它不破 token-no-leak**——凭证在管道 / 子进程里、不经你的任何变量、不被回显。
>
> **registry 只经脚本读写。** 你**绝不**直接 `Read` / `cat` / `Edit` accounts.json（用 account-list.sh 读），更**绝不** `cat` 那个 file vault（`accounts.env`，非 mac floor 上是明文 token）——registry 虽非密、纪律仍是「号池状态只经预设脚本读写」，明文 vault 则绝不主动去读。

按下面做：

## 1. 先做云后端自检（红线 5）

若运行在云后端（`CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY` 任一为真），订阅口径的换号概念不适用——云后端没有订阅 5h/7d 配额窗口、没有可管的订阅 OAuth token。**直接告诉用户「本命令不适用于云后端（Bedrock/Vertex/Foundry 无订阅 OAuth token 可管）」，收尾退出。** 用一条 Bash 读这三个环境变量判断（每个脚本内部也各有这道自检会 no-op 退出，但你在最前面挡一道，省一次空跑）。

## 2. 解析 `$ARGUMENTS`，路由到一个操作

`$ARGUMENTS` 形如 `--add <email>` / `--delete <email>` / `--refresh <email>` / `--list`。解析出操作与 email：

- **`--add <email>`** —— 新增一个备号 token 进号池。
- **`--delete <email>`** —— 把一个备号从号池删干净（registry entry + vault token）。
- **`--refresh <email>`** —— 某备号 token 到期/泄漏后换新（**复用 add 的安全路**——见 §4）。
- **`--list`** —— 只读对账：列号池现有 email + vault 形态 + 到期日 + active + 是否过期。

边界：

- **没给操作 flag**（`$ARGUMENTS` 空 / 只有杂字）→ 别瞎猜。默认先跑一次 **list**（§5）给用户看当前号池，再用一句话告诉他可用的四个操作（`--add/--delete/--refresh <email>` 与 `--list`）。
- **add/delete/refresh 缺 email** → 问用户要 email，别拿空串去跑脚本。

## 3. delete —— 直接 Bash 跑 account-delete.sh

delete 不涉密（删 vault 项/行按 email 前缀、token-blind；删 registry entry 是非密），你全程亲跑：

```sh
bash "${CLAUDE_PLUGIN_ROOT}/skills/account-management/scripts/account-delete.sh" --email <email>
```

脚本会从 registry entry 自动推断 vault 形态（keychain / file）删对地方，先删 vault token 再删 registry entry。把脚本的 `✓ 删号完成` / `· vault 里没找到` 等非密输出转述给用户。**非 mac 上若该号是 file 形态而脚本推断不出**，补 `--vault-kind file`（脚本默认推不出时按 keychain 删）。

## 4. add / refresh —— 直接 Bash 跑 account-add.sh（keychain 直读·唯一前提是用户登录在目标号）

add 与 refresh 走**完全相同**的脚本——`account-add.sh` 是幂等 upsert：keychain 用 `-U` 原地更新该 email 的项、file 形态先删旧行再 append、registry 保留首次 `token_added_at` 只刷新 `token_refreshed_at`/`token_expires_at`。所以 **refresh 就是对同一个 email 再跑一次 account-add.sh**，无需另一条命令。

**机制——keychain 直读（不弹浏览器、不 setup-token、不动用户登录）**：脚本从 macOS keychain「Claude Code-credentials」(`account=$USER`) **直读当前登录号的完整 `claudeAiOauth` blob**（含 **refreshToken**）存进 vault。它只读、不写官方凭证 → **不扰动用户的登录**。所以录号的**唯一前提**是：**用户当前正登录在目标号**——先用 Orca / `claude login` 登录目标号 X，再 `--add X` 即把 X 的 blob 录进号池。

> **身份匹配 guard——「要录号 X，你必须当前正登录在 X」。** keychain 里永远是机器**当前登录号**的 blob（与 `--email` 无绑定）。`account-add.sh` 在读 blob 前**硬 guard**：读 `~/.claude.json` 的 `oauthAccount.emailAddress`（当前登录身份）须 == `--email`，否则**立刻 FAIL**——防止把当前登录号 B 的 blob 错标成 A（A 的 entry 实指 B 的凭证 = 选号/换号灾难）。脚本会提示「你当前登录的是 B、不是 A，请先登录 A 再重跑」。

**全 agentic——你直接 Bash 跑即可**（keychain 读 + vault 写都从你的 Bash 上下文跑通，无浏览器、无 TTY 需求）。把 `<email>` 换成解析到的 email：

- **keychain 形态**（mac 默认）：
  ```sh
  bash "${CLAUDE_PLUGIN_ROOT}/skills/account-management/scripts/account-add.sh" --email <email>
  ```
- **file 形态**（非 mac floor / 用户显式要 file）：
  ```sh
  bash "${CLAUDE_PLUGIN_ROOT}/skills/account-management/scripts/account-add.sh" \
    --email <email> --vault-kind file
  ```
  （file vault 路径默认 `${CC_MASTER_HOME:-$HOME/.claude/cc-master}/accounts.env`，与 registry 同目录；用户另指就加 `--vault-file <path>`。到期日默认 now+365d，用户给了准确到期日就加 `--expires <YYYY-MM-DDTHH:MM:SSZ>`。非 mac 无 keychain → 脚本降级读 `~/.claude/.credentials.json` 的 `.claudeAiOauth`。）

**这条跑起来的样子**：脚本读 `~/.claude.json` 取当前登录身份 → 身份 guard（须 == `--email`）→ 直读 keychain「Claude Code-credentials」的完整 blob（经 `security … | node …` 管道、blob 全程不落变量）→ 校验三必需字段（`accessToken`/**`refreshToken` 非空**/`expiresAt`）→ 存进 vault + 写 registry entry（含非密身份 + `active:true`，录的是当前登录号）。**告诉用户「请先用 Orca / `claude login` 登录目标号，我直接读 keychain 录入、无需任何浏览器或复制粘贴」**，确认用户登录在目标号后让脚本跑完。它跑完只会回给你非密的 `✓ 已从 keychain 直读完整 blob 并存入 vault（blob <redacted>）` + `✓ 已写 accounts.json registry entry`——把这些转述给用户即可。

> **refreshToken 硬要求——为什么必须是真 `/login` 而非 setup-token。** blob 必须含**非空 refreshToken**（前缀 `sk-ant-ort`），脚本取不到就 **FAIL**、绝不存残缺 blob。理由：cc-master 的换号是**无重启凭证覆写**（switch 覆写官方共享凭证、运行中 claude 惰性 re-read），它**死依赖 refreshToken** 续期——keychain blob 里的 access token 仅 ~8h 有效，无 refreshToken 续不上、切进去很快就认证失败。**只有真 `/login` 走完整 OAuth 才在 keychain 写下非空 refreshToken**；`claude setup-token`（旧路径，已弃用）铸的是长寿命 headless token、**结构上不产生 refreshToken**，且 `~/.claude/.credentials.json` 文件里的 refreshToken 值实测为空（残缺副本）。若脚本打印 `✗ 未能取到含非空 refreshToken 的完整 blob`，**如实转述它的提示给用户**：「你多半没真正 `/login`（setup-token 不给 refreshToken）→ 请用 Orca / `claude login` 走完整登录后重跑」。脚本**绝不静默存错**，提取失败时打印手动录入骨架（引导用户从 keychain 直读完整 blob、凭证仍不经过你）。

**多账号建池流程**（用 Orca / `claude login` 在号间切，每次录的就是当前登录号）：
1. 登录 A（Orca / `claude login`）→ `--add A`。
2. 切登录到 B → `--add B`。
3. 依此类推——每个 `--add <X>` 前确认「当前登录的就是 X」（身份 guard 会兜底拦截不匹配）。

## 5. list —— 直接 Bash 跑 account-list.sh（只读对账）

```sh
bash "${CLAUDE_PLUGIN_ROOT}/skills/account-management/scripts/account-list.sh"
```

脚本只读 registry 的非密字段，列每个 email 的 vault 形态 / 到期日 / active / 是否过期——**绝不取、绝不打印任何 token 值**（keychain 探活也只用 `find`（不带 `-w`）确认项在不在）。想顺带核对 keychain 项是否真在，加 `--probe-keychain`。把脚本的对账表转述给用户；号池为空 / registry 不存在时它会提示「天然单账号空池」，照实转述。

## 6. 收尾——转述非密结果

无论哪个操作，收尾把脚本的非密结果转述给用户：操作了哪个 email、vault 形态、到期日、registry 写没写成。**绝不含任何 token 值**（你本就拿不到）。需要时提醒：switch-account.sh 在换号时读的就是这个号池，registry 与 vault 必须由这些预设脚本维护以保持格式一致。

> 这个命令完全不碰 board（号池与 board 正交，红线 2），不武装任何 hook、不新增后台派发机制。所有 token 写入只在 account-add.sh 子进程内经 OS 工具（`security` / 文件 0600 写）发生——你跑脚本，但 token 从不流回你这里。
