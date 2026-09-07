---
title: 连接一个 agent
description: 将真实的编程智能体接入运行中的 Plexus：管理员建立连接，一条命令完成安装，智能体列出可用能力并调用。
---

# 接入真实的编程智能体 {#把一个真实的编码-agent-端到端连接起来}

本教程带你把真实的编程智能体接入运行中的 Plexus：**管理员先建立连接，再用一条命令安装，智能体随后列出可用能力并调用。** 接入所需的配置相同，**交付形式有三种**：

- **第 1 部分——Claude Code（编译好的 plugin）。** 在控制台连接 agent（或一次 API 调用），复制那**一条**
  安装命令，agent 就得到一个 plugin：一个 `plexus-<agentId>` launcher 加一个编译好的 skill。它运行
  `plexus-<agentId> list`，然后 invoke。
- **第 2 部分——其他能使用 shell 的智能体（generic：可移植的 CLI 配置）。** 选择 **Generic CLI setup**，就会得到一条不含注册码的
  `curl … /setup.sh | bash` 安装命令。它会为该智能体安装专用的 `plexus` 启动器，并把指令块写入运行命令时所在的项目。一次性注册码会**单独显示**，另有可复制的完整指令文本。这里用 Codex 演示。
- **第 3 部分——没有文件系统的轻量 / 云端 agent（in-context：纯 HTTP）。** 形态选
  **In-context / HTTP（无需安装）**。什么都不装：你拿到一段**讲纯 HTTP 协议的 in-context 指令**，直接粘进
  agent 的上下文，再加一枚一次性 enroll 码。agent 用它自己的 `fetch`/`curl` 接入——discover、enroll、
  handshake、grant、invoke。

三种形式的**接入配置完全相同**：一个一次性注册码，加上常驻授权。agentType 只决定**交付形式**，按智能体的*类型*来选：Claude Code 使用专用插件，能使用 shell 和文件系统的智能体使用 generic CLI，只能通过 HTTP 通信的轻量或云端智能体使用 in-context。三者的注册和授权机制相同：CLI 形式调用 `plexus` 命令的 `enroll <code>`，in-context 形式直接发送 `POST /agents/enroll`。

底层协议流程（enroll → handshake → grant → invoke）放在文末的**附录**。使用 CLI 时，命令会在内部完成这些步骤，你无需手动处理；使用 in-context 时，智能体则**按指令执行这套协议**。

还没启动过网关？先走一遍[快速上手](/zh/guide/)（装 Bun，`bun run start`）。

::: tip 两种凭据，一套信任模型
- **Connection-key**（`plx_live_…`）——你的**管理员**凭据，管控控制台和 `/admin/api/*`。**agent 永远看不到
  它。**
- **每个智能体的 PAT**——这是**智能体自己的**长期凭证，用一次性注册码（`plx_enroll_…`）兑换，每个注册码**只能兑换一次**。
  凭证由智能体调用的命令在内部处理，智能体不读取、构造或提交凭证，也不手写 HTTP 请求。你在连接时选中的**读取（read）** 能力会获得
  **常驻授权**，*选中就表示你已批准*。会产生副作用的能力（**write**／**execute**）也会进入智能体的可用范围，但仍须**逐次批准**：每次调用都会等待你审批。例外是你在连接时明确为该智能体的这项能力开启常驻授权（默认关闭，需在对话框中确认），或稍后审批请求时设置有效的信任时段；但 execute 仍限于 once，除非你明确为该智能体与该能力的组合开启常驻授权。请求超出你明确选定的范围，又没有你创建的有效常驻授权，就会被拒绝。完整模型见：[安全模型](/zh/architecture/security-model)。
:::

---

## 开始之前

启动网关。在仓库根目录运行：

```sh
# Terminal 1 — keep the gateway running (loopback only, 127.0.0.1:7077).
bun run start --vault ~/Documents/MyVault     # an Obsidian vault is handy for reads
```

在本地用 connection-key 访问 `http://127.0.0.1:7077/admin` 控制台的你，就是**管理员**和**审批人**。
下文操作都在这个控制台完成，也可以通过管理员 API 完成；调用管理员 API 同样需要 connection-key。

::: warning `Host` 头是必需的
网关的 **Host/Origin 检查**以绑定的主机和端口为准，对所有端点都*先检查，再认证*，以防止 DNS 重绑定。请求的 `Host` 必须是 `127.0.0.1:7077`，否则会返回 `host_forbidden`（403）。下文每条 `curl` 命令都带有 `-H "Host: 127.0.0.1:7077"`。
:::

---

## 第 1 部分——Claude Code：connect → install → list → invoke

### 1. 连接这个 agent（管理员）

在控制台打开 **Connect an agent**。agent 类型选 **Claude Code**，给它一个 id（例如 `my-cc`），选一个
**初始 cap 集合**——比如 `obsidian.vault.read`。连接这个动作同时做三件事：

- 签发**一次性 enroll 码**（`plx_enroll_…`，单次使用，约 15 分钟有效）；
- 将所选 cap-set 声明为该代理的**授权子集**。实际可见、可申请的能力须有对应条目且已暴露，并满足以下任一条件：属于该子集，
  或该代理持有所有者为该能力创建的有效长期授权；
- 把其中的 **read** 作为**常驻**授权**授予**这个 agent——*人类批准就发生在这里，只做一次*，此后这些
  read 无需再提示即可调用。选中的 **write** / **execute** 保持逐次（每次调用挂起等你批准），除非你在
  这里为那一项勾选 **Standing** opt-in。

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

一次性代码通过命令中的环境变量传入，不会嵌入安装产物。安装器将它暂存到权限为 0600 的临时文件，兑换该代理的 PAT 后删除临时文件。安装的是**专为这个代理编译的** Claude Code 插件：包括 `plexus-my-cc` 启动器（自带锁定版本的引擎，不直接使用全局 `plexus`）和编译好的 `use-plexus` 技能。

请**在使用 Claude Code 的项目目录里**粘贴命令。插件通过 `--scope local` 注册到该项目，配置写入个人设置文件 `.claude/settings.local.json`，该文件不进仓库。如果已在该项目的 `claude` 会话中，运行 `/reload-plugins` 即可生效，无须重启。也可在任意目录运行 `claude --plugin-dir ~/.plexus/plugins/plexus@<agentId>`，只为当前会话加载插件，不持久保存项目注册。

### 3. 先运行 list，再调用能力 {#_3-agent-先-list-再-invoke}

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
不要自行编写 HTTP 请求，也不要猜测认证方式。编译好的技能根据网关 Floor 的实时自描述信息提供操作指引；enroll→PAT→handshake→token→invoke 这条凭证与调用链由引擎按内置模板处理，不会进入代理上下文。技能即使过时，也不能超出 Floor 当下的授权范围；最坏的情况是引用了已撤销的能力，调用失败。
:::

### 4. 当一次调用需要批准时

条目不存在、未暴露，或既不属于代理的授权子集、又没有所有者为该代理创建的有效长期授权的能力，都不会出现在 `plexus-my-cc list` 中。申请这类能力的授权会直接被拒绝，不生成审批卡片，也不进入等待。会等待审批的是这一可见范围内**有副作用**的能力：**write** 或 **execute** 默认逐次审批，除非你在连接时已为该能力明确选择长期授权。
此时命令会报告 `grant_pending_user`，转述网关撰写的说明，并请你到控制台的 **Approvals** 标签页批准。写入会采用你在审批时选择的信任时段：选 `Once`，每次都问；选具体时段，如 `7 days`，则让*这一项写入*在该时段内获得长期授权，以你对单项能力的明确选择为准。未明确允许长期授权的 execute，无论选什么时段，都只按 `Once` 批准：

```
http://127.0.0.1:7077/admin
```

![在 /admin 的 Approvals 标签页批准挂起的授权](/diagrams/grant-approval.png)

要扩大已连接代理的可用范围，可在控制台授予更多能力，或重新运行 **Connect an agent**，选择更大的 cap-set。`plexus-my-cc list` 会列出新增能力，其中有有效长期授权的才显示为 callable-now；execute 还须由所有者为该代理与该能力明确开启长期授权。

---

## 第 2 部分——接入通用智能体（Codex）并**实际调用** Plexus {#第-2-部分——驱动一个真实的-generic-agent-codex-对接-plexus}

对于已有 shell 的智能体，除 Claude Code 外，都按**通用方式**接入：在项目的 `AGENTS.md` 中加入指令块，让智能体按其中写明的**绝对路径运行自己的 `plexus` 启动器**。Plexus **不是 MCP 服务器**，也没有 `/mcp` 端点，所以不用在智能体的 `config.toml` 里添加配置；直接通过 shell 运行它自己的 `plexus` 命令即可。下文以 Codex 为例。

### B0. 控制台的 generic 交付给你什么

在控制台连接这个 agent（流程与第 1 部分相同），类型选 **Generic / other agent**。第 3 步给你三样东西：

1. 一条 **setup 命令**——`curl -fsSL http://127.0.0.1:7077/integration/<agentId>/setup.sh | bash`，
   **在运行智能体的项目中执行**。提供的 `setup.sh` 已内嵌获准使用的引擎，无需准备仓库；脚本**不含注册码**，也**不含密钥**。它会将此智能体的启动器安装到 `~/.plexus/agents/<agentId>/bin/plexus`，固定网关，并把填好的指令块写入项目根目录的 `./AGENTS.md`，指导智能体按上述绝对路径调用启动器。
2. **enroll 码**，**单独**展示——一枚单次使用的 `plx_enroll_…` 凭据。这枚码只在这条 connection-key 门控的
   响应里交付，**绝不**写进 `setup.sh` 或引导文件。让你的 agent 运行一次
   `~/.plexus/agents/<agentId>/bin/plexus enroll <code>`。
3. 可复制的**指令文本**——与安装命令写入项目的 `AGENTS.plexus.md` 指令块相同。你也可以选择直接把这段指令粘贴给智能体。

### B1. 把 Codex 接好 + enroll

在你运行 Codex 的那个项目里，跑上面那条 generic **setup 命令**即可。或者，从仓库检出直接用 Codex 集成：

```sh
# From the project you run Codex in — lands the AGENTS.md block at ./AGENTS.md,
# teaching the absolute path of the repo shim (<repo>/integrations/codex/bin/plexus).
bash <repo>/integrations/codex/setup.sh
```

无论哪种方式，都用控制台展示的那枚一次性码，让 agent **enroll** 一次——用 launcher 的绝对路径，
正是引导块教给 agent 的那条命令：

```sh
~/.plexus/agents/<agentId>/bin/plexus enroll plx_enroll_…   # once — 用这枚码兑换出 agent 自己的 PAT
~/.plexus/agents/<agentId>/bin/plexus list                  # sanity-check: the caps you granted show callable-now
```

（上面用的是控制台安装的启动器；使用仓库中的包装脚本时，命令路径是 `<repo>/integrations/codex/bin/plexus`，支持的子命令相同。）

这枚码兑换出 agent 自己的持久 `plx_agent_…` token——之后 agent 都用它认证，从不碰你的管理员 connection-key。

（完整 Codex 设置——自动 vs 手动、项目根（默认）vs 全局 AGENTS.md——见
[`integrations/codex/setup.md`](https://github.com/nemori-ai/plexus/blob/main/integrations/codex/setup.md)；
可移植的 generic 文件在
[`integrations/generic/`](https://github.com/nemori-ai/plexus/tree/main/integrations/generic)。）

### B2. 为什么要 `--dangerously-bypass-approvals-and-sandbox`

**Codex 会在沙箱中运行命令。** `plexus` 命令通过**本机回环 HTTP**（`127.0.0.1`）连接网关。`codex exec` 默认使用 `read-only` 沙箱，**会阻止这个回环请求**，因此 Codex 无法连接 Plexus。要在当前会话中调用 Plexus，就得允许 Codex 发出这个请求。直接解除限制的办法是加上下面的选项：

```
codex exec --dangerously-bypass-approvals-and-sandbox "<task>"
```

这个选项会移除沙箱，让智能体可以访问本地服务。**请只在自己的机器上，用它运行你信任的自动化任务。** 范围更小、也更安全的办法，是在 Codex 沙箱配置中允许网络访问，而非移除整个沙箱。这是 Codex CLI 的选项，不是 Plexus 的选项；Plexus 自身的授权规则，包括常设授权和等待批准的流程，仍然适用于每次调用。

### B3. 一个跑通的任务——*读我的日历 / 创建一条提醒*

网关运行的前提下（用 `PLEXUS_FAKE_APPLE=1 bun run start` 启动，得到确定性的 Apple 夹具、没有 macOS TCC
提示——见[暴露一个 source](/zh/guide/first-party-sources)），且连接这个 Codex agent 时 cap 集合里同时
选了 `apple-calendar.events.list` **和** `apple-reminders.reminders.create`——create 是 **write**，
记得在连接时为它勾选按项的 **Standing** opt-in（这个刻意的勾选就是人类批准；不勾则每次 create 都
挂起等你）：

```sh
codex exec --dangerously-bypass-approvals-and-sandbox \
  "Use the plexus command: run 'plexus list' to see what's available, read today's
   events with apple-calendar.events.list, then create a follow-up reminder for the
   first event with apple-reminders.reminders.create. Use --json."
```

Codex 遵循 AGENTS.md 教它的纪律——**先 list，再 invoke**——比如会运行：

```text
exec   ~/.plexus/agents/<agentId>/bin/plexus list --json               succeeded
         → apple-calendar.events.list (read, callable-now),
           apple-reminders.reminders.create (write, callable-now) …
exec   ~/.plexus/agents/<agentId>/bin/plexus apple-calendar.events.list --input '{"start":"2026-06-25","end":"2026-06-26"}' --json
         → { "ok": true, "output": { "events": [ { "title": "Team sync", … } ] } }
exec   ~/.plexus/agents/<agentId>/bin/plexus apple-reminders.reminders.create --input '{"list":"Reminders","title":"Follow up on Team sync"}' --json
         → { "ok": true, … }
```

**两次调用都能直接执行，因为你在连接时已批准。** 选中的读取能力获得了常驻授权，写入能力则因你*明确勾选*而获得常驻授权。两者都经过你的主动批准，所以调用时不会再次请求审批。没勾选写入能力的常驻授权，也能完成上述任务：创建操作会等待审批，你在 `/admin` 的 Approvals 标签页批准后，命令便会继续。授权子集内的 `execute` 能力（如 `claudecode.run`）逐次审批时也是如此：命令会显示 `grant_pending_user`，提示你批准，并持续**轮询**。已开放且条目仍存在的能力，只要属于所有者明确指定的子集，或有所有者创建的有效常驻授权，就会出现在 `plexus list` 中；不满足这些条件时不会显示，请求也会被拒绝。

### 故障排查 {#一些坑——老实说}

- **macOS TCC（*第一次*实时 Apple 调用会提示你）。** 在真实的 Mac 上、`PLEXUS_FAKE_APPLE` **未设置**时，
  在真实 Mac 上未设置 `PLEXUS_FAKE_APPLE` 时，Apple 数据源会通过 shell 调用 `osascript`/JXA，各数据源的**首次**真实调用都会弹出 macOS 的 **TCC** 授权对话框。如果拒绝授权，调用会失败，并明确提示你到系统设置中启用权限。要使用固定测试数据进行不触发 TCC 的隔离运行，请设置环境变量 `PLEXUS_FAKE_APPLE`：`PLEXUS_FAKE_APPLE=1`。
- **`osascript` 在超大列表上的性能**——Calendar/Reminders 存储的数据非常多时，通过 `osascript` 查询会很慢。
  请限定查询范围，例如一天或一周的时间窗口，或某个具体列表。
- **Codex 的沙箱默认拦回环**——如果 `plexus list` 在 Codex 里报网络错误、同一条命令在你自己的 shell 里
  却能跑，重读 B2。

---

## 第 3 部分——一个 **in-context / HTTP** agent（无需安装）

有些 agent **没有文件系统、没有 shell**——浏览器里的轻量 agent、serverless 函数、云端 worker。它们跑不了
`setup.sh`，也用不了 `plexus` CLI。但它们**能发 HTTP 请求**。**in-context** 形态正是为它们准备的：**什么都
不装**；agent 拿到一段**讲纯 HTTP 协议的指令**，粘进自己的上下文，再用它自己的 `fetch`/`curl` 照着走。

与第 1–2 部分一样，agent 用一次性代码注册，并使用长期授权。变化只在提供方式：**没有编译后的插件，也没有 CLI**，因此也**没有公开的引导入口**；对 in-context agent，`install.sh` 和 `setup.sh` 都返回 404。**操作说明和一次性代码**只通过需要 connection-key 才能获取的 `GET /integration/:agentId` JSON 响应提供。

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

### C1. agent 按协议自行接入：纯 HTTP {#c1-agent-照协议自引导——纯-http}

贴入上下文的说明让 agent **按网关自身公布的协议接入**，全程只用 HTTP，不猜测端点或认证方式：

1. **DISCOVER**——`GET /.well-known/plexus`（免认证）→ 网关身份，外加 `auth.requestShapes`
   （每个端点怎么调）、`auth.enrollment`（怎么兑换码），以及一条 `capabilitiesVia` 指引：enroll 加
   handshake 之后，就能收到 Plexus 授权给这个 agent 的 capability 列表。以实时文档为准，agent 照它走。
2. **ENROLL**——`POST /agents/enroll { "code": "plx_enroll_…" }` → agent 自己的持久 **PAT**
   （`plx_agent_…`），**仅返回一次**。agent **自己存好**（它自己的内存 / 上下文 / 密钥库）——磁盘上没有文件
   来落它。
3. **HANDSHAKE**——`POST /link/handshake`，带 `Authorization: Bearer <PAT>`（无 body）→ 一个 `sessionId`
   + **所有者授权该 agent 访问的能力 manifest**，每项都有完整信息（describe、
   schemas、verbs），仅含存在且可向该 agent 暴露、属于所有者明确授权子集或由其为该 agent 授予有效 standing grant 的条目。
4. **GRANT** — `PUT /grants { "sessionId": …, "grants": { "<capabilityId>": "allow" } }` → 申请限定范围的 JWT
   （已有仍有效的长期授权时，可直接获得 JWT，包括所有者在连接时选中的读取能力，或明确设为长期授权的能力；其他处于有效授权范围内的请求须等待所有者批准，范围外的请求会被拒绝）。
5. **INVOKE**——`POST /invoke`，带 `Authorization: Bearer <scoped-jwt>` 和
   `{ "id": "<capabilityId>", "input": { … } }` → 真实结果。

::: tip 每次调用的 input 形状从 manifest 读，而不是从散文
构造调用的 `input` 时，agent 读取握手响应中 `manifest.entries[].io.input` 的**结构化 JSON Schema**，不根据能力的文字摘要拼参数。这份 schema 是**任何能力**的输入权威依据，包括 vault 读取、Apple 提醒事项，以及说明写成时尚不存在的能力。操作说明已明确写出这一要求。
:::

下面整个附录，就是 CLI 两种形态藏在 `plexus` 引擎里的东西——对 in-context agent 而言它**就是**集成，粘进去
的指令逐步走的正是它。留意 agent **从来没有**被要求做的事：持有或出示管理员 connection-key（`plx_live_…`）。
它唯一的凭据，是它在 enroll 时铸出的 PAT；connection-key 始终是拥有者的，走带外通道。

---

## 附录——PAT 接入协议 {#附录——底层揭秘-pat-wire}

采用 CLI 形式连接 agent 时，`plexus` 命令会完成下面的全部步骤，无须手动操作。这里列出它实际使用的通信协议；权威依据见 [安全模型](/zh/architecture/security-model) §2 引用的 `file:line`。

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
   连接时所有者选中的 read，或所有者明确设为 standing 的能力，只要对应的 standing grant 仍有效，就直接取得限定作用域的 token；有效授权视图内的其他请求**等待所有者批准**（返回 `grant_pending_user` 和 `pendingId`；带上同一 session 请求头轮询 `GET /grants/status?pendingId=…`）；视图外的请求直接拒绝，不生成所有者审批卡，也不进入待批准状态。
5. **INVOKE**——`POST /invoke`，带 `Authorization: Bearer <scoped-jwt>` 和 `{ "id": "<capabilityId>", "input": { … } }`。
   `{ id, ok, output?, error?, auditId }`；请求被拒绝时，返回 `ok:false`，`error.code`
   只能取 ADR-017 定义的错误码之一。

这套流程的参考实现见 [`examples/min-agent/`](https://github.com/nemori-ai/plexus/tree/main/examples/min-agent)。内置引擎（`tools/plexus-cli/plexus`）是该实现经认可、通过 Floor 验证的版本，随每个编译后的插件一起提供。流程中**绝不会要求 agent** 读取磁盘上的密钥、在握手时提交 connection-key，或自行签发 token。公布的接入路径只有经过审计、由所有者批准的这一条。

---

## 接下来去哪

- [编写一个扩展](/zh/guide/create-an-extension)——给 agent 一项网关未随附的 capability（例如 vault
  *write*），并让编码 agent 从一段描述里写出 manifest。
- [暴露一个 source](/zh/guide/first-party-sources)——随附的 source（Obsidian、Apple Calendar/Reminders、
  Notes/Mail/Contacts/Photos、Shortcuts、browser、browser control、Claude Code）：capability id、授权、前置条件。
- [协议](/zh/protocol/)——冻结的 wire 契约与相关 ADR（ADR-016 端点公示、ADR-017 `/invoke`、ADR-018 统一
  信任模型）。
