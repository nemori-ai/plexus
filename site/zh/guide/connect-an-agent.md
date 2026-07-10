---
title: 连接一个 agent
description: 把一个真实的编码 agent 端到端连接到运行中的 Plexus——管理员连接、一条命令安装、agent list 并 invoke。
---

# 把一个真实的编码 agent 端到端连接起来

本教程按你实际会用的方式，把一个真实的编码 agent 连接到运行中的 Plexus——**管理员连接 agent，一条命令装好，
agent list 出能做什么并调用。** 同一套 provisioning，**三种交付形态**：

- **第 1 部分——Claude Code（编译好的 plugin）。** 在控制台连接 agent（或一次 API 调用），复制那**一条**
  安装命令，agent 就得到一个 plugin：一个 `plexus-<agentId>` launcher 加一个编译好的 skill。它运行
  `plexus-<agentId> list`，然后 invoke。
- **第 2 部分——任何带 shell 的 agent（generic：可移植的 CLI setup）。** 形态选 **Generic CLI setup**，
  拿到一条不含码的 `curl … /setup.sh | bash` 命令（装好 `plexus` CLI + 落地一份可粘贴的引导），一次性
  enroll 码**单独**展示，外加可整段复制的引导全文。Codex 是这里的实例。
- **第 3 部分——没有文件系统的轻量 / 云端 agent（in-context：纯 HTTP）。** 形态选
  **In-context / HTTP（无需安装）**。什么都不装：你拿到一段**讲纯 HTTP 协议的 in-context 指令**，直接粘进
  agent 的上下文，再加一枚一次性 enroll 码。agent 用它自己的 `fetch`/`curl` 接入——discover、enroll、
  handshake、grant、invoke。

三种形态是**同一套** provisioning——一枚一次性码加一组常驻授权。agentType 只决定**交付**：按 agent
*本身是什么*来选——Claude Code（专属 plugin）、任何带 shell / 文件系统的 agent（generic CLI）、或只会说
HTTP 的轻量 / 云端 agent（in-context）。enroll（CLI 两种形态用 `plexus enroll <code>`，in-context 则直接
`POST /agents/enroll`）与授权在三者之间完全一致。

底层的 wire（enroll → handshake → grant → invoke）放在文末**附录**——CLI 两种形态你从不会碰它；in-context
形态下它**就是**交付本身（那段指令逐步讲的正是它）。

还没启动过网关？先走一遍[快速上手](/zh/guide/)（装 Bun，`bun run start`）。

::: tip 两种凭据，一套信任模型
- **Connection-key**（`plx_live_…`）——你的**管理员**凭据，管控控制台和 `/admin/api/*`。**agent 永远看不到
  它。**
- **专属 PAT**——**agent 的**持久凭据，由一次性 enroll 码（`plx_enroll_…`）**兑换一次**得来。agent 的命令
  在内部处理它——agent 从不读取、构造或出示凭据，也从不自己拼 HTTP。你在连接时选中的任何 capability——
  read 或 write、任何来源——都成为**常驻授权**：那次选择*就是*人类批准。`execute` 保持逐次，除非你在
  连接时为那一项 capability 显式 opt-in 常驻（默认关闭、双重确认）；请求任何你没选中的 capability 会被
  直接拒绝。完整模型：[安全模型](/zh/architecture/security-model)。
:::

---

## 开始之前

启动网关。在仓库根目录运行：

```sh
# Terminal 1 — keep the gateway running (loopback only, 127.0.0.1:7077).
bun run start --vault ~/Documents/MyVault     # an Obsidian vault is handy for reads
```

谁在本地打开 `http://127.0.0.1:7077/admin`、用 connection-key 认证，谁就是**管理员**兼**批准者**
——也就是你。下面的一切都在控制台完成（或走需要 connection-key 的管理 API）。

::: warning `Host` 头是必需的
网关把 **Host/Origin 守卫**锁定在它绑定的端口上，每个端点都*先*跑守卫、再做认证（防 DNS 重绑定）。
`Host` 不是 `127.0.0.1:7077` 的请求一律拒绝，返回 `host_forbidden`（403）。下面每条 `curl` 都带
`-H "Host: 127.0.0.1:7077"`。
:::

---

## 第 1 部分——Claude Code：connect → install → list → invoke

### 1. 连接这个 agent（管理员）

在控制台打开 **Connect an agent**。agent 类型选 **Claude Code**，给它一个 id（例如 `my-cc`），选一个
**初始 cap 集合**——比如 `obsidian.vault.read`。连接这个动作同时做三件事：

- 签发**一次性 enroll 码**（`plx_enroll_…`，单次使用，约 15 分钟有效）；
- 把选中的 cap 集合声明为这个 agent 的**授权子集**——agent 能看见、能请求的 capability，恰好就是你
  选中的那些；
- 把这些 cap 作为**常驻**授权**授予**这个 agent——*人类批准就发生在这里，只做一次*，此后这些 cap 无需
  再提示即可调用。

等价的 API（需要 connection-key——这是管理员动作，不是 agent 动作）：

```sh
export KEY=$(cat ~/.plexus/connection-key)     # ADMIN credential — never given to the agent
curl -s -H "Host: 127.0.0.1:7077" -H "content-type: application/json" \
  -H "X-Plexus-Connection-Key: $KEY" \
  -X POST "http://127.0.0.1:7077/admin/api/agents/connect" \
  -d '{"agentId":"my-cc","agentType":"claude-code","capabilities":["obsidian.vault.read"]}'
```

### 2. 复制那条安装命令

控制台会为已连接的 agent 显示一条可复制的**单条安装命令**（由 `GET /integration/:agentId` 提供，
受管理员凭据管控）。它长这样：

```sh
curl -fsSL http://127.0.0.1:7077/integration/my-cc/install.sh | PLEXUS_ENROLL_CODE="plx_enroll_…" bash
```

一次性码通过环境变量随命令传递（绝不写进文件）；安装器把它落到一个 0600 的临时文件，兑换成 agent 的
PAT，然后删除。装上的是**为这一个 agent 编译**的 Claude Code plugin：一个 `plexus-my-cc` launcher
（自带版本锁定的引擎，绝不是不带 agent 标识的全局 `plexus`）加一个编译好的 `use-plexus` skill。

### 3. agent 先 list，再 invoke

装好之后，agent 的整个接口就是这个 launcher。它的子命令：

```sh
plexus-my-cc list                                   # what can I call NOW vs what needs approval
plexus-my-cc obsidian.vault.read path=Projects/Plexus.md
plexus-my-cc obsidian.vault.read --input '{"path":"Projects/Plexus.md"}' --json
```

- **`enroll`** 安装期间已替你运行（一次性码兑换成持久 PAT，本地存储）。如果 agent 哪天被取消 enroll
  （换了机器 / 重置了凭据），命令会提示它运行 `plexus-my-cc enroll <code>`——这是唯一会牵涉到码的地方。
- **`list`** 把每项 capability 标为 **callable-now**（有常驻授权）或 **needs-approval**。
  `obsidian.vault.read` 现在就能调，因为你在连接时授予了它。
- **`<capabilityId> [args]`** 用于 invoke——位置参数按顺序绑定到输入 schema，也可以用 `key=value` 或
  `--input '<json>'`。加 `--json` 解析 `InvokeResponse`；调用可能挂起时，加 `--purpose "<one sentence>"`
  告诉拥有者*为什么*。

在装好该 plugin 的 Claude Code 会话里，问它*“通过 Plexus 读一下我的 Obsidian 笔记 `Projects/Plexus.md`”*，
编译好的 skill 就会恰好运行上面这些命令，返回真实的笔记。

::: tip launcher 是 agent 完整且唯一的接口
永远不要自己拼 HTTP，永远不要猜认证。编译好的 skill 是网关那个实时、自描述的 Floor 的一层投影；
enroll→PAT→handshake→token→invoke 这条链由引擎内部的模板生成，从不进入 agent 的上下文。陈旧的 skill
永远越不过 Floor 的实时授权——最坏情况不过是引用了一项已撤销的 cap，invoke 直接失败。
:::

### 4. 当一次调用需要批准时

授权子集之外的 capability 根本不在场：它不会出现在 `plexus-my-cc list` 里，对它的授权请求会被直接
拒绝——没有审批卡，也不挂起。会挂起的是子集之内的 **`execute`** capability：execute 默认逐次批准
（除非你在连接时为那一项 capability opt-in 了常驻），于是命令报 `grant_pending_user`，转达网关撰写的
说明，请你在控制台批准（**Approvals** 标签页；对未 opt-in 的 execute，无论选哪个信任窗口都落定为
`Once`）：

```
http://127.0.0.1:7077/admin
```

![在 /admin 的 Approvals 标签页批准挂起的授权](/diagrams/grant-approval.png)

想拓宽已连接 agent 的能力面，直接在控制台多授予一些（或用更大的 cap 集合重新运行
**Connect an agent**）——`plexus-my-cc list` 随即把新的 cap 显示为 callable-now。

---

## 第 2 部分——驱动一个**真实**的 generic agent（Codex）对接 Plexus

除 Claude Code 之外的每个 agent，都走 **generic** 这条路：一份**引导块 + PATH 上的共享 `plexus` 命令**。
Plexus **不是** MCP server（不存在 `/mcp` wire），所以任何 agent 的 `config.toml` 里都没有东西要配——
agent 本来就有 shell，运行 `plexus` 命令即可。Codex 是这里的实例。

### B0. 控制台的 generic 交付给你什么

在控制台连接这个 agent（流程与第 1 部分相同），类型选 **Generic / other agent**。第 3 步给你三样东西：

1. 一条 **setup 命令**——`curl -fsSL http://127.0.0.1:7077/integration/<agentId>/setup.sh | bash`。
   服务端的 `setup.sh` 自包含（内联了那份 sanctioned engine——无需仓库）、**不含码**、**不含 key**：它把
   `plexus` CLI 装上 PATH、pin 好网关、落地一份填好的 `AGENTS.plexus.md`。
2. **enroll 码**，**单独**展示——一枚单次使用的 `plx_enroll_…` 凭据。这枚码只在这条 connection-key 门控的
   响应里交付，**绝不**写进 `setup.sh` 或引导文件。让你的 agent 运行一次 `plexus enroll <code>`。
3. **引导全文**，可复制——就是 setup 命令会落地的那份 `AGENTS.plexus.md`，想直接喂给 agent 的人不必跑命令。

### B1. 把 Codex 接好 + enroll

在控制台跑上面那条 generic **setup 命令**即可。或者，从仓库检出直接用 Codex 集成：

```sh
# From the repo root — symlinks bin/plexus onto PATH + appends the AGENTS.md block.
bash integrations/codex/setup.sh
#   (if it warns ~/.local/bin isn't on PATH, add it:  export PATH="$HOME/.local/bin:$PATH")
```

无论哪种方式，都用控制台展示的那枚一次性码，让 agent **enroll** 一次：

```sh
plexus enroll plx_enroll_…        # once — 用这枚码兑换出 agent 自己的 PAT
plexus list                       # sanity-check: the caps you granted show callable-now
```

这枚码兑换出 agent 自己的持久 `plx_agent_…` token——之后 agent 都用它认证，从不碰你的管理员 connection-key。

（完整 Codex 设置——自动 vs 手动、全局 vs 每项目 AGENTS.md——见
[`integrations/codex/setup.md`](https://github.com/nemori-ai/plexus/blob/main/integrations/codex/setup.md)；
可移植的 generic 文件在
[`integrations/generic/`](https://github.com/nemori-ai/plexus/tree/main/integrations/generic)。）

### B2. 为什么要 `--dangerously-bypass-approvals-and-sandbox`

**Codex 会给它运行的命令加沙箱。** `plexus` 命令通过**回环 HTTP**（`127.0.0.1`）与网关通信。`codex exec`
默认使用 `read-only` 沙箱，会**拦下这次回环调用**，Codex 因此够不到 Plexus。你得让 Codex 在驱动 Plexus
的那个会话里放行回环调用。最粗暴的办法就是这个 flag：

```
codex exec --dangerously-bypass-approvals-and-sandbox "<task>"
```

（更窄、更安全的做法：在 Codex 沙箱配置里授予网络权限，而不是整个移除沙箱。）这个 flag 移除沙箱，让
agent 能跟本地服务通信——**只在你自己的机器上、对你信任的自动化使用它。** 它是 Codex CLI 的 flag，不是
Plexus 的；Plexus 自己的授权（常驻授权 + 挂起批准）仍然作用于每一次调用。

### B3. 一个跑通的任务——*读我的日历 / 创建一条提醒*

网关运行的前提下（用 `PLEXUS_FAKE_APPLE=1 bun run start` 启动，得到确定性的 Apple 夹具、没有 macOS TCC
提示——见[暴露一个 source](/zh/guide/first-party-sources)），且连接这个 Codex agent 时 cap 集合里同时
选了 `apple-calendar.events.list` **和** `apple-reminders.reminders.create`：

```sh
codex exec --dangerously-bypass-approvals-and-sandbox \
  "Use the plexus command: run 'plexus list' to see what's available, read today's
   events with apple-calendar.events.list, then create a follow-up reminder for the
   first event with apple-reminders.reminders.create. Use --json."
```

Codex 遵循 AGENTS.md 教它的纪律——**先 list，再 invoke**——比如会运行：

```text
exec   plexus list --json                                              succeeded
         → apple-calendar.events.list (read, callable-now),
           apple-reminders.reminders.create (write, callable-now) …
exec   plexus apple-calendar.events.list --input '{"start":"2026-06-25","end":"2026-06-26"}' --json
         → { "ok": true, "output": { "events": [ { "title": "Team sync", … } ] } }
exec   plexus apple-reminders.reminders.create --input '{"list":"Reminders","title":"Follow up on Team sync"}' --json
         → { "ok": true, … }
```

**两次调用都直接跑通——因为你在连接时批准过。** 你在连接时选中的 cap（那个 read *和*那个 write）都是
常驻授权：那次选择就是人类批准，两次调用都不会再提示你。仍会逐次挂起的，是子集之内、你没有在连接时
opt-in 常驻的 `execute` capability（例如 `claudecode.run`）：那里命令会打印 `grant_pending_user` 通知并
**轮询**，同时叫你去 `/admin` 批准（Approvals 标签页）。而你连接时没选中的 capability 在这个 agent 的
授权子集之外——它压根不出现在 `plexus list` 里，对它的请求会被拒绝。

### 一些坑——老实说

- **macOS TCC（*第一次*实时 Apple 调用会提示你）。** 在真实的 Mac 上、`PLEXUS_FAKE_APPLE` **未设置**时，
  Apple source 会 shell 出 `osascript`/JXA，每个的**首次**实时使用都会弹 macOS 的 **TCC** 授权对话框。
  你若拒绝，调用会失败，并给出精确的“到系统设置里启用”的提示。想要一次不碰 TCC 的封闭运行，设
  `PLEXUS_FAKE_APPLE=1`。
- **`osascript` provider 在超大列表上的性能**——经 `osascript` 走的 Calendar/Reminders 在极大的存储上
  很慢。把查询限定范围（一天 / 一周的窗口、某个具体列表）。
- **Codex 的沙箱默认拦回环**——如果 `plexus list` 在 Codex 里报网络错误、同一条命令在你自己的 shell 里
  却能跑，重读 B2。

---

## 第 3 部分——一个 **in-context / HTTP** agent（无需安装）

有些 agent **没有文件系统、没有 shell**——浏览器里的轻量 agent、serverless 函数、云端 worker。它们跑不了
`setup.sh`，也用不了 `plexus` CLI。但它们**能发 HTTP 请求**。**in-context** 形态正是为它们准备的：**什么都
不装**；agent 拿到一段**讲纯 HTTP 协议的指令**，粘进自己的上下文，再用它自己的 `fetch`/`curl` 照着走。

这和第 1、2 部分是同一套 provisioning——一枚一次性码 + 一组常驻授权。只是交付变了：**没有编译 plugin、
没有 CLI**，因此也**没有公开的 bootstrap 路由**（对 in-context agent，`install.sh` / `setup.sh` 都返回
404）。指令文本**和**一次性码只走 connection-key 门控的 `GET /integration/:agentId` JSON。

### C0. 控制台的 in-context 交付给你什么

在控制台连接这个 agent（流程与第 1 部分相同），形态选 **In-context / HTTP（无需安装）**。install 步骤给你
两样东西：

1. **协议指令**，可复制——一段自包含、**不含码**且**不含 key** 的文本（网关 URL 已填好），把整套纯 HTTP
   流程讲清楚。直接粘进你 agent 的**上下文 / system prompt**。
2. **一次性 enroll 码**，**单独**展示——一枚单次使用的 `plx_enroll_…` 凭据，只在这条 connection-key 门控的
   响应里交付，**绝不**进入指令文本。把它交给 agent，让它自己完成 enroll。

等价的 API（管理员动作——需要 connection-key）：

```sh
export KEY=$(cat ~/.plexus/connection-key)     # ADMIN credential — never given to the agent
curl -s -H "Host: 127.0.0.1:7077" -H "content-type: application/json" \
  -H "X-Plexus-Connection-Key: $KEY" \
  -X POST "http://127.0.0.1:7077/admin/api/agents/connect" \
  -d '{"agentId":"cloud-bot","agentType":"in-context","capabilities":["obsidian.vault.read"]}'
# 再取指令 + 一次性码（connection-key 门控）：
curl -s -H "Host: 127.0.0.1:7077" -H "X-Plexus-Connection-Key: $KEY" \
  "http://127.0.0.1:7077/integration/cloud-bot"       # → { agentType:"in-context", instruction, enrollCode, enrollHint, … }
```

### C1. agent 照协议自引导——纯 HTTP

粘进去的指令让 agent **从网关自己的自描述里自引导**——它从不猜端点、不猜认证：

1. **DISCOVER**——`GET /.well-known/plexus`（免认证）→ 网关身份，外加 `auth.requestShapes`
   （每个端点怎么调）、`auth.enrollment`（怎么兑换码），以及一条 `capabilitiesVia` 指引：enroll 加
   handshake 之后，就能收到 Plexus 授权给这个 agent 的 capability 列表。以实时文档为准，agent 照它走。
2. **ENROLL**——`POST /agents/enroll { "code": "plx_enroll_…" }` → agent 自己的持久 **PAT**
   （`plx_agent_…`），**仅返回一次**。agent **自己存好**（它自己的内存 / 上下文 / 密钥库）——磁盘上没有文件
   来落它。
3. **HANDSHAKE**——`POST /link/handshake`，带 `Authorization: Bearer <PAT>`（无 body）→ 一个 `sessionId`
   + **拥有者授权给这个 agent 的 capability 的 manifest**——每个条目细节完整（describe、schema、
   verbs），范围限定在它的授权子集内。
4. **GRANT**——`PUT /grants { "sessionId": …, "grants": { "<capabilityId>": "allow" } }` → 一个受限
   token（管理员已设为常驻的 cap 会短路；子集之内、没有常驻授权的 cap 自动批准或替你挂起；子集之外的
   请求会被拒绝）。
5. **INVOKE**——`POST /invoke`，带 `Authorization: Bearer <scoped-jwt>` 和
   `{ "id": "<capabilityId>", "input": { … } }` → 真实结果。

::: tip 每次调用的 input 形状从 manifest 读，而不是从散文
要拼一次调用的 `input`，agent 从 handshake 返回里的 `manifest.entries[].io.input` 读**结构化 JSON
Schema**——而不是 capability 的人类摘要。这份 schema 对**任意** capability 都是权威的，所以同一套纪律对
vault read、Apple 提醒、乃至指令写就时还不存在的 capability 都成立。指令里把这点讲明了。
:::

下面整个附录，就是 CLI 两种形态藏在 `plexus` 引擎里的东西——对 in-context agent 而言它**就是**集成，粘进去
的指令逐步走的正是它。留意 agent **从来没有**被要求做的事：持有或出示管理员 connection-key（`plx_live_…`）。
它唯一的凭据，是它在 enroll 时铸出的 PAT；connection-key 始终是拥有者的，走带外通道。

---

## 附录——底层揭秘（PAT wire）

连接 agent 时你从不会碰这些——`plexus` 命令全包了。但它在 wire 上做的正是这些（权威依据：
[安全模型](/zh/architecture/security-model) §2 里引用了 `file:line`）。

1. **DISCOVER**——`GET /.well-known/plexus`（免认证）。网关身份 + `auth` 公示（enroll / handshake 的
   URL）+ 一条 `capabilitiesVia` 指引——capability 列表本身在 enroll + handshake 之后才到达，范围限定在
   拥有者授权给这个 agent 的那些。
2. **ENROLL**——`POST /agents/enroll { "code": "plx_enroll_…" }`。这一步**码就是凭据**；connection-key
   一概不收。成功时明文返回持久 **PAT**，**仅此一次**——命令把它存到本地，之后再也无法找回：
   ```sh
   curl -s -H "Host: 127.0.0.1:7077" -H "content-type: application/json" \
     -X POST "http://127.0.0.1:7077/agents/enroll" \
     -d '{"code":"plx_enroll_…"}'          # → { "pat": "plx_agent_…", "agentId": "my-cc" }
   ```
3. **HANDSHAKE**——`POST /link/handshake`，带 `Authorization: Bearer plx_agent_…`。PAT 经过校验，会话
   绑定到它解析出的**真实** `agentId`（客户端永远无法自称是别的 agent）。返回 `sessionId` + 这个 agent
   的 manifest——拥有者授权它触达的每个条目，细节完整；从来不是整个目录。
4. **GRANT**——`PUT /grants`，带 `X-Plexus-Session: <sessionId>` 头和 `{ "grants": { "<capabilityId>": "allow" } }`。
   管理员已设为常驻的 capability 会短路成一个受限 token；子集之内、没有常驻授权的 capability 才到达
   授权器——它要么自动放行一次低敏感度的第一方 read，要么替拥有者**挂起**（`grant_pending_user` +
   `pendingId`；用同一个会话头轮询 `GET /grants/status?pendingId=…`）；子集之外的请求会被拒绝——
   没有审批卡，也不挂起。
5. **INVOKE**——`POST /invoke`，带 `Authorization: Bearer <scoped-jwt>` 和 `{ "id": "<capabilityId>", "input": { … } }`。
   统一的结果契约（ADR-017）：`{ id, ok, output?, error?, auditId }`；拒绝返回 `ok:false`，`error.code`
   取自一个闭合联合。

这条链的精确参考实现是
[`examples/min-agent/`](https://github.com/nemori-ai/plexus/tree/main/examples/min-agent)——捆绑引擎
（`tools/plexus-cli/plexus`）就是它经过认可、经 Floor 校验的版本，随每个编译好的 plugin 一起交付。留意
那些指引里**从来没有**的动作：读磁盘上的密钥、在 handshake 时出示 connection-key、自铸 token。唯一公示的
前进路径，就是那条经审计、经拥有者批准的路径。

---

## 接下来去哪

- [编写一个扩展](/zh/guide/create-an-extension)——给 agent 一项网关未随附的 capability（例如 vault
  *write*），并让编码 agent 从一段描述里写出 manifest。
- [暴露一个 source](/zh/guide/first-party-sources)——随附的 source（Obsidian、Apple Calendar/Reminders、
  Notes/Mail/Contacts/Photos、Shortcuts、browser、Claude Code）：capability id、授权、前置条件。
- [协议](/zh/protocol/)——冻结的 wire 契约与相关 ADR（ADR-016 端点公示、ADR-017 `/invoke`、ADR-018 统一
  信任模型）。
