---
title: "连接 agent"
description: "把真实的编码 agent 接到运行中的 Plexus，走完接入和调用流程：从管理员连接开始，用一条命令安装集成，再让 agent 用 list 查看能力、取得调用所需的授权，并用 invoke 发起调用。"
---
# 把一个真实的编码 agent 端到端连接起来 {#把一个真实的编码-agent-端到端连接起来}

本教程把真实的编码 agent 接到运行中的 Plexus：你以管理员身份连接 agent，交付安装命令或 HTTP 指令，agent 再列出能力、取得授权并调用。先按 agent 本身的运行条件选交付形态。

第 1 部分用 Claude Code，交付编译好的 plugin。在控制台连接 agent，或发起一次管理 API 调用，再复制那一条安装命令。装好后，agent 得到一个 `plexus-<agentId>` launcher 和一个编译好的 skill，先运行 `plexus-<agentId> list`，再调用能力。

第 2 部分适合任何带 shell 和文件系统的 agent，Codex 是这里的实例。选择 Generic CLI setup，会得到一条不含 enroll 码的 `curl … /setup.sh | bash` 命令。它安装这个 agent 专属的 `plexus` launcher，并把引导块写进运行命令的那个项目。一次性 enroll 码单独展示，另外还提供可整段复制的引导全文。

第 3 部分适合没有文件系统、只通过 HTTP 接入的轻量或云端 agent。选择 In-context / HTTP（无需安装），把交付的纯 HTTP 协议指令粘进 agent 的上下文，再交给它一枚一次性 enroll 码。不必安装任何东西，agent 用自己的 `fetch`/`curl` 依次完成 discover、enroll、handshake、grant、invoke。

三种形态共用同一套 provisioning：一枚一次性码，加上一组常驻授权。`agentType` 只决定交付方式，不改变 enroll 与授权规则。两种 CLI 形态通过 `plexus` 命令的 `enroll <code>` 兑换，in-context 则直接调用 `POST /agents/enroll`。

底层协议 enroll → handshake → grant → invoke 放在文末附录。两种 CLI 形态由 launcher 处理它，你不必手写；对 in-context 形态，它就是交付内容，那段指令讲的正是这些步骤。

还没启动过网关？先走一遍[快速上手](/zh/guide/)（装 Bun，`bun run start`）。

::: tip 两种凭据，共用一套信任规则
Connection-key（`plx_live_…`）是你的管理员凭据，用于控制台和 `/admin/api/*`。agent 永远看不到它。

专属 PAT 是 agent 的持久凭据，由一次性 enroll 码（`plx_enroll_…`）兑换一次得来。使用 launcher 的集成由命令内部处理凭据，agent 不读取、构造或出示凭据，也不自行拼 HTTP。直接接入 HTTP 的 agent 则自己管理 PAT 和 scoped token。

连接时选中的 read capability 会获得常驻授权；连接时的选择就是这次人类批准。选中的 write / execute capability 也会进入 agent 的能力子集，但默认逐次批准，每次调用都挂起等你决定。你可以在连接时为某一项显式开启常驻选项，默认关闭且需弹窗确认；之后审批请求时，也可在规则允许的范围内选择真实信任窗口。execute 默认仍受 once 上限约束，不能靠请求更长窗口绕过，须由拥有者显式开启相应的常驻例外。未选入子集的 capability，也可能因拥有者另行建立的有效常驻授权而变得可见、可请求；超出拥有者当前授权范围的请求会被直接拒绝。完整规则见[安全模型](/zh/architecture/security-model)。
:::

---

## 先让网关保持运行 {#开始之前}

在仓库根目录运行：

```sh
# Terminal 1 — keep the gateway running (loopback only, 127.0.0.1:7077).
bun run start --vault ~/Documents/MyVault     # an Obsidian vault is handy for reads
```

在本地打开 `http://127.0.0.1:7077/admin`，用 connection-key 认证。登录的人就是管理员，也是批准者——这里就是你。下面的管理操作都在控制台完成，也可以使用需要 connection-key 的管理 API。

::: warning 此回环配置要求正确的 `Host` 头
Host/Origin 守卫按网关绑定的端口检查请求。每个端点都先过守卫，再做认证，以防 DNS 重绑定。在本教程的回环配置下，`Host` 不是 `127.0.0.1:7077` 的请求会被拒绝，返回 `host_forbidden`（403）。所以下面每条 `curl` 都带 `-H "Host: 127.0.0.1:7077"`；这不是对所有部署地址的统一要求。
:::

---

## 第 1 部分——Claude Code：connect → install → list → invoke {#第-1-部分——claude-code-connect-→-install-→-list-→-invoke}

### 1. 连接这个 agent（管理员） {#_1-连接这个-agent-管理员}

在控制台打开 **Connect an agent**，agent 类型选 **Claude Code**，给它一个 id，例如 `my-cc`，再选初始 cap 集合，例如 `obsidian.vault.read`。这次连接会同时完成三件事，但三件事的用途不同。

首先，签发一枚 `plx_enroll_…` 一次性 enroll 码。它只能用一次，约 15 分钟有效，供安装器兑换这个 agent 自己的 PAT，而不是把管理员凭据交给 agent。

其次，把选中的 capability 声明为这个 agent 的授权子集。这个集合是它能看见、能请求能力的一项依据。拥有者还可以另行建立常驻授权：只要授权未过期，并通过当前 connection-key epoch 的校验，相应 capability 即使没有选入子集，也能进入 agent 当前的授权视图。agent 不能自行取得这项例外。能力还须保持开放：拥有者关闭某项 capability 的暴露后，它就不能再被发现或授权。

最后，为选中的 read 建立常驻授权。人类批准发生在连接这一步，只需做一次；之后只要授权仍然有效，这些 read 就不必每次提示。选中的 **write / execute 默认仍是逐次批准，每次调用挂起等你决定；只有你在这里为那一项显式勾选 Standing opt-in，才改为常驻。**

**选入子集，不等于授予常驻权限。** 子集记录你选了哪些能力，常驻授权则决定请求时能否沿用已有批准。后续 write 也可以通过带真实信任窗口的审批或显式直接授予变为常驻；execute 则必须由拥有者显式开启常驻例外，agent 不能靠请求更长窗口自行突破限制。

不用控制台，也可以调用等价的管理 API。它需要 connection-key，因为连接是管理员动作，不是 agent 动作：

```sh
export KEY=$(cat ~/.plexus/connection-key)     # ADMIN credential — never given to the agent
curl -s -H "Host: 127.0.0.1:7077" -H "content-type: application/json" \
  -H "X-Plexus-Connection-Key: $KEY" \
  -X POST "http://127.0.0.1:7077/admin/api/agents/connect" \
  -d '{"agentId":"my-cc","agentType":"claude-code","capabilities":["obsidian.vault.read"]}'
```

### 2. 复制那条安装命令 {#_2-复制那条安装命令}

连接完成后，控制台会显示一条可复制的安装命令。这份集成信息由 `GET /integration/:agentId` 提供，受管理员凭据管控。命令如下：

```sh
curl -fsSL http://127.0.0.1:7077/integration/my-cc/install.sh | PLEXUS_ENROLL_CODE="plx_enroll_…" bash
```

一次性码先通过环境变量传给安装器。安装器会短暂把它写入权限为 `0600` 的临时文件，用来兑换 agent 的 PAT，随后删除临时文件。因此，这里并不是“一次性码绝不进入文件”，而是只在兑换期间写入受限的临时文件。

装上的是为这一个 agent 编译的 Claude Code plugin。其中有专属的 `plexus-my-cc` launcher，自带版本锁定的引擎；它不是不带 agent 标识的全局 `plexus`。plugin 还带有编译好的 `use-plexus` skill。

这条命令要**在你使用 Claude Code 的那个项目里**粘贴执行。plugin 以 `--scope local` 注册到该项目，配置写入 `.claude/settings.local.json`；这是留在本机、不进仓库的个人文件，不是给所有项目做全局安装。

如果已经打开了该项目的 `claude` 会话，运行 `/reload-plugins` 就能立即生效，无需重启。若想在任意位置只为一次会话加载这个 plugin，可以运行 `claude --plugin-dir ~/.plexus/plugins/plexus@<agentId>`；这种加载只对当次会话有效，不写入持久的 plugin 注册配置。

### 3. agent 先 list，再 invoke {#_3-agent-先-list-再-invoke}

装好后，先让 agent 看看现在能调用什么，哪些还要等你批准。在这份集成里，它通过 `plexus-my-cc` launcher 完成这些事：

```sh
plexus-my-cc list                                   # what can I call NOW vs what needs approval
plexus-my-cc obsidian.vault.read path=Projects/Plexus.md
plexus-my-cc obsidian.vault.read --input '{"path":"Projects/Plexus.md"}' --json
```

`enroll` 已在安装时运行，把一次性码兑换成持久 PAT，存到本地。如果后来换了机器、重置了凭据，agent 需要重新 enroll，命令会提示运行 `plexus-my-cc enroll <code>`。只有 enroll 这一步需要用码。

`list` 把列出的 capability 标为 `callable-now` 或 `needs-approval`。前者有当前可用的常驻授权，后者还需批准。能看见一项能力，不等于已经获准调用它。这里的 `obsidian.vault.read` 可以直接调，是因为你在连接时已经授予了它。

调用用 `<capabilityId> [args]`。位置参数依次绑定到输入 schema，也可以写成 `key=value`，或用 `--input '<json>'` 传入。加 `--json` 解析 `InvokeResponse`；如果调用可能挂起，加上 `--purpose "<one sentence>"`，告诉拥有者为什么需要这次调用。

在装好 plugin 的 Claude Code 会话里，问它：“通过 Plexus 读一下我的 Obsidian 笔记 `Projects/Plexus.md`”。编译好的 skill 就会运行上面的命令，返回真实的笔记。

::: tip 在这份集成里，launcher 是 agent 完整且唯一的接口
不要自己拼 HTTP，也不要猜认证。编译好的 skill 是网关实时、自描述的 Floor 的一层投影；enroll→PAT→handshake→token→invoke 这条链由引擎内部的模板生成，不进入 agent 的上下文。这是使用编译集成时的规则，不限制直接接入 HTTP 的客户端。

陈旧的 skill 越不过 Floor 的实时授权。即使它仍引用一项已撤销的 cap，invoke 也会直接失败；网关执行当前规则，不会照旧指令放行。
:::

### 4. 当一次调用需要批准时 {#_4-当一次调用需要批准时}

先分清拒绝和等待批准。如果一项 capability 既不在拥有者选定的子集内，也没有拥有者另行建立的有效常驻授权，它就不在这个 agent 当前的授权范围内：它不会出现在 `plexus-my-cc list` 里，对它的授权请求会被直接拒绝，没有审批卡，也不会挂起。

子集内的 write 或 execute 带有副作用，默认逐次批准；如果你已为那一项开启常驻，而且授权仍符合条件，就不必再问。需要批准时，命令报 `grant_pending_user`，转达网关撰写的说明，请你到控制台的 **Approvals** 标签页处理：

```
http://127.0.0.1:7077/admin
```

![在 /admin 的 Approvals 标签页批准挂起的授权](/diagrams/grant-approval.png)

对 write，系统会按你批准时选的信任窗口执行。选 `Once`，以后每次仍要问；选真实窗口，比如 `7 days`，就是让那一项 write 在窗口内常驻。你也可以显式直接授予常驻权限。这些都是按项作出的决定，不会顺带批准其他能力。

execute 多一道限制：必须由拥有者为这个 agent 的那一项 capability 显式开启 standing opt-in，才允许常驻。没有这个选择，无论请求哪个信任窗口，最终都落定为 `Once`；agent 自己选更长窗口不能解除上限。

想扩大已连接 agent 的能力范围，可以在控制台通过追加 capability 的选择器授予权限，也可以在审批挂起请求时重新指定 capability 并批准，或用更大的 cap 集合重新运行 **Connect an agent**。新的 cap 会按当前状态出现在 `plexus-my-cc list` 中，但新选中的 write 或 execute 不会仅因进入子集就变成 `callable-now`，还要有符合条件的常驻授权。暴露开关也独立生效：关闭后不能发现、不能授权，即使已有有效授权，invoke 仍会拒绝。拥有者另行建立的常驻授权也不能绕过 scope、verb、会话有效性及其他 invoke 检查。

---

## 第 2 部分——给 Codex 装上专属命令 {#第-2-部分——驱动一个真实的-generic-agent-codex-对接-plexus}

对于 Claude Code 之外、带 shell 和文件系统的 agent，可以走 generic 这条安装路径。装好后，项目的 `AGENTS.md` 里会多一段引导，告诉 agent 用哪条绝对路径运行它专属的 `plexus` launcher。这里用 Codex 演示；只有 HTTP、没有文件系统的 agent 留到第 3 部分。

Plexus 不是 MCP server，不存在 `/mcp` wire。这份集成不需要配置 MCP server，也不需要在 agent 的 `config.toml` 里添加 MCP server 条目。agent 通过已有的 shell 运行 launcher，由 launcher 处理 Plexus 的凭据和调用流程。

### B0. 控制台交付的三样东西 {#b0-控制台的-generic-交付给你什么}

按第 1 部分的流程在控制台连接 agent，类型选 Generic / other agent。第 3 步会给你安装命令、一次性 enroll 码和引导全文。它们分开交付，不要把凭据塞回安装脚本或项目指令。

安装命令是 `curl -fsSL http://127.0.0.1:7077/integration/<agentId>/setup.sh | bash`，要在你运行 agent 的那个项目里执行。服务端生成的 `setup.sh` 自包含，内联了 sanctioned engine，不需要检出仓库；脚本既不含 enroll 码，也不含 key。它把专属 launcher 安装到 `~/.plexus/agents/<agentId>/bin/plexus`，固定网关地址，再把填好的引导块写入项目根的 `./AGENTS.md`。引导里教给 agent 的，就是这个已安装 launcher 的绝对路径。

enroll 码单独展示，是只能用一次的 `plx_enroll_…` 凭据。它只在受 connection-key 门控的这条响应中交付，绝不写进 `setup.sh` 或引导文件。安装之后，让 agent 运行一次 `~/.plexus/agents/<agentId>/bin/plexus enroll <code>`，再兑换自己的身份凭据。

第三样是可整段复制的引导全文，也就是 setup 会落地的那份 `AGENTS.plexus.md` 内容。想直接把指令交给 agent 的人，可以复制全文，不必靠运行 setup 命令来取得它。

### B1. 安装 Codex 集成并 enroll {#b1-把-codex-接好-enroll}

通常，在运行 Codex 的项目里执行控制台给出的 generic setup 命令即可。如果已经检出了仓库，也可以改用仓库里的 Codex 集成：

```sh
# From the project you run Codex in — lands the AGENTS.md block at ./AGENTS.md,
# teaching the absolute path of the repo shim (<repo>/integrations/codex/bin/plexus).
bash <repo>/integrations/codex/setup.sh
```

这两条安装路径不要混用指令。控制台 setup 教的是 `~/.plexus/agents/<agentId>/bin/plexus`；仓库 setup 同样默认把引导写进当前项目根的 `./AGENTS.md`，但教的是仓库 shim 的绝对路径 `<repo>/integrations/codex/bin/plexus`。

使用控制台安装的 launcher 时，让 agent 用控制台展示的一次性码执行：

```sh
~/.plexus/agents/<agentId>/bin/plexus enroll plx_enroll_…   # once — 用这枚码兑换出 agent 自己的 PAT
~/.plexus/agents/<agentId>/bin/plexus list                  # sanity-check: the caps you granted show callable-now
```

使用仓库 shim 时，则用 `<repo>/integrations/codex/bin/plexus` 运行相同的 `enroll` 和 `list` 动词，路径以引导块为准。`list` 用来检查接入结果；只有当前具备可用授权的能力才显示为 `callable-now`，需要批准的仍按上一部分的规则处理。

一次性码兑换出 agent 自己的持久 `plx_agent_…` token，也就是 PAT。之后 agent 用它认证身份，从不接触你的管理员 connection-key。PAT 不是每项能力的调用许可；launcher 会在内部另行取得 scoped invocation token，再完成调用。

自动与手动安装、默认项目根与全局 `AGENTS.md` 的完整设置，见 [Codex 设置文档](https://github.com/nemori-ai/plexus/blob/main/integrations/codex/setup.md)；可移植的 generic 文件见 [`integrations/generic/`](https://github.com/nemori-ai/plexus/tree/main/integrations/generic)。

### B2. 为什么要 `--dangerously-bypass-approvals-and-sandbox` {#b2-为什么要-dangerously-bypass-approvals-and-sandbox}

装好 launcher，还要确认 Codex 能连到网关。`plexus` 通过回环 HTTP（`127.0.0.1`）通信，而 `codex exec` 默认使用的 `read-only` 沙箱会拦下这次回环调用。命令虽然装在本机，Codex 仍可能够不到 Plexus。

要在驱动 Plexus 的那个会话里放行回环通信。最直接的办法是：

```
codex exec --dangerously-bypass-approvals-and-sandbox "<task>"
```

更窄、更安全的做法，是在 Codex 沙箱配置里授予网络权限，而不是移除整个沙箱。上面的 flag 会移除沙箱，让 agent 能与本地服务通信；只在你自己的机器上、对你信任的自动化使用它。

这是 Codex CLI 的 flag，不是 Plexus 的。它不会关闭 Plexus 授权：每次调用仍要经过常驻授权或挂起批准的检查。

### B3. 跑一遍：读日历，再创建提醒 {#b3-一个跑通的任务——读我的日历-创建一条提醒}

先用 `PLEXUS_FAKE_APPLE=1 bun run start` 启动网关。这次用的是确定性的 Apple 夹具，不会弹出 macOS TCC 提示，也不代表访问了真实的 Apple 数据。相关设置见[暴露一个 source](/zh/guide/first-party-sources)。

连接这个 Codex agent 时，cap 集合里要同时选中 `apple-calendar.events.list` 和 `apple-reminders.reminders.create`。后者是 write；若想让下面的任务不中断，还要为它按项勾选 Standing opt-in。这个显式选择就是人类批准，不勾选则 create 默认逐次挂起等你。

```sh
codex exec --dangerously-bypass-approvals-and-sandbox \
  "Use the plexus command: run 'plexus list' to see what's available, read today's
   events with apple-calendar.events.list, then create a follow-up reminder for the
   first event with apple-reminders.reminders.create. Use --json."
```

Codex 按 `AGENTS.md` 的指引先 list，再 invoke。夹具模式下，例如会得到这样的执行记录：

```text
exec   ~/.plexus/agents/<agentId>/bin/plexus list --json               succeeded
         → apple-calendar.events.list (read, callable-now),
           apple-reminders.reminders.create (write, callable-now) …
exec   ~/.plexus/agents/<agentId>/bin/plexus apple-calendar.events.list --input '{"start":"2026-06-25","end":"2026-06-26"}' --json
         → { "ok": true, "output": { "events": [ { "title": "Team sync", … } ] } }
exec   ~/.plexus/agents/<agentId>/bin/plexus apple-reminders.reminders.create --input '{"list":"Reminders","title":"Follow up on Team sync"}' --json
         → { "ok": true, … }
```

两次调用都能直接完成，是因为你在连接时已经批准过：选中的 read 获得常驻授权，write 则因你显式为它 opt-in 才常驻。每一步都有刻意的人类批准，所以运行时不再提示。

没有勾选 write 的 opt-in，也能走完这个任务，只是 create 会挂起。命令打印 `grant_pending_user`，请你去 `/admin` 的 Approvals 标签页批准，并持续轮询；批准后自动继续。后续 write 也可通过真实信任窗口的审批或显式直接授予变为常驻。

子集内的 execute，例如 `claudecode.run`，默认同样逐次挂起、通知并轮询；只有拥有者显式开启该项常驻例外，才不受这个默认限制。既未选入子集、也没有拥有者另行建立的有效常驻授权的 capability 则不同：它不出现在 `plexus list` 里，请求会被拒绝，不会进入等待批准的流程。

### 实际运行时容易遇到的问题 {#一些坑——老实说}

在真实 Mac 上，不设置 `PLEXUS_FAKE_APPLE` 时，Apple source 会通过 shell 调用 `osascript`/JXA，各自首次实时使用会弹出 macOS TCC 授权对话框。拒绝后调用会失败，并给出到系统设置里启用权限的具体提示；按提示恢复权限后再试。若只想做一次不碰 TCC 的封闭运行，就设 `PLEXUS_FAKE_APPLE=1`，但别把夹具结果当作实时 Apple 调用的验证。

经 `osascript` 访问 Calendar/Reminders，在极大的存储上会很慢。查询尽量收窄到一天、一周的窗口，或某个具体列表。

如果 `plexus list` 在 Codex 里报网络错误，先在自己的 shell 里运行同一条命令。shell 能跑、Codex 不能跑时，回到 B2，检查当前 `read-only` 沙箱下的回环网络权限。

---

## 第 3 部分——只用 HTTP 接入 {#第-3-部分——一个-in-context-http-agent-无需安装}

有些 agent 能发 HTTP 请求，却没有文件系统、没有 shell，装不了 launcher，也跑不了 `setup.sh`。浏览器里的轻量 agent、serverless 函数、云端 worker 都可能遇到这种情况。给它们的不是安装命令，而是一段放进上下文的纯 HTTP 协议指令。这就是 in-context 形态：什么都不装，agent 用自己可用的 `fetch`/`curl` 按指令请求网关。

这和第 1、2 部分是同一套 provisioning——一枚一次性码，加上一组常驻授权。选定的 capability 子集、哪些授权可以常驻、哪些调用还要批准，都沿用前面的规则；不是换成 HTTP 就放宽权限。agent 仍用自己的身份凭据，connection-key 留在管理员手里。

变的是交付方式。这里没有编译 plugin，也不安装 CLI，因此不提供这个 agent 的公开 bootstrap 路由：对 in-context agent，`install.sh` 和 `setup.sh` 都返回 404。指令文本和一次性码只通过 connection-key 门控的 `GET /integration/:agentId` JSON 响应交付。

### C0. 控制台交付的两样东西 {#c0-控制台的-in-context-交付给你什么}

按第 1 部分的流程在控制台连接 agent，形态选 In-context / HTTP（无需安装）。install 步骤会分别展示协议指令和一次性 enroll 码。

协议指令可以整段复制，直接粘进 agent 的上下文或 system prompt。它是自包含的文本，网关 URL 已填好，讲清整套纯 HTTP 流程，但不含 enroll 码，也不含 key。

另一份是单独展示的 `plx_enroll_…` 凭据，只能使用一次。它只在这条受 connection-key 门控的响应里交付，绝不进入指令文本。把这枚码另行交给 agent，供它自行完成 enroll。

也可以用下面的 API 连接并取回这两份内容。这是管理员动作，需要 connection-key；不要把管理员凭据交给 agent。示例使用本机回环地址，管理员能访问 `http://127.0.0.1:7077`，并不表示远端云 agent 也能访问这个网关。

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

### C1. agent 按网关自描述接入——纯 HTTP {#c1-agent-照协议自引导——纯-http}

粘进去的指令让 agent 从网关自己的自描述里自引导：端点怎么找、认证怎么带，都不靠猜。它依次完成五步。

1. DISCOVER——免认证请求 `GET /.well-known/plexus`。这份公开文档说明网关身份，并提供 `auth.requestShapes`（各端点的请求格式）、`auth.enrollment`（兑换码的方法）和 `capabilitiesVia` 指引。它不公开凭据，也不提供完整的 per-agent manifest；后者要等 enroll 和经 PAT 认证的 handshake 完成后才返回。agent 始终以网关实时文档为准。

2. ENROLL——向 `POST /agents/enroll` 提交 `{ "code": "plx_enroll_…" }`，兑换自己的持久 PAT（`plx_agent_…`）。PAT 仅返回一次，必须由 HTTP agent 自己保存到可用的内存、上下文或密钥库中。这里没有安装器替它写入磁盘文件，保存凭据是它自己的责任。

3. HANDSHAKE——请求 `POST /link/handshake`，带 `Authorization: Bearer <PAT>`，不带 body。网关据此确认 agent 的真实身份，返回 `sessionId` 和 manifest。manifest 只包含这个 agent 当前授权范围内、且仍保持暴露的 capability：既包括拥有者选入子集的项，也包括拥有者另行建立了有效常驻授权的项，每项都有完整的 describe、schema、verbs。拿到这份清单只是知道能请求什么，不等于已经取得调用权限。

4. GRANT——请求 `PUT /grants`，此处示例的 body 为 `{ "sessionId": …, "grants": { "<capabilityId>": "allow" } }`。这与附录通过 `X-Plexus-Session: <sessionId>` 头传递会话标识、body 只含 `grants` 的写法不一致；实际请求格式以运行时 `auth.requestShapes` 为准。符合条件的已有常驻授权，例如连接时勾选的 read，或拥有者显式设为常驻的项，可以直接取得受限 token，不再询问。当前授权范围内的其余请求会挂起，等拥有者批准；超出这个范围的请求直接拒绝，不进入审批。关闭暴露的能力也不能获得授权。

5. INVOKE——请求 `POST /invoke`，带 `Authorization: Bearer <scoped-jwt>`，提交 `{ "id": "<capabilityId>", "input": { … } }`，取得真实结果。这里使用的是上一步取得的 scoped token，不是 PAT。

::: tip 调用的 input 形状从 manifest 读，不从散文猜
要拼一次调用的 `input`，agent 从 handshake 返回的 `manifest.entries[].io.input` 读取结构化 JSON Schema，而不是 capability 的人类摘要。它是确定参数形状的权威依据：vault read、Apple 提醒，乃至编写指令时还不存在的 capability，都照这条规则处理。指令里已说明这一点；这不表示运行时实现了完整的 JSON Schema 校验，目前输入校验仍是轻量的。
:::

下面的附录展开两种 CLI 形态藏在 `plexus` 引擎里的协议；对 in-context agent，它本身就是集成，粘进去的指令逐步走的正是它。PAT 是 agent 的持久身份凭据，调用另用 scoped token；两者都不是管理员 connection-key（`plx_live_…`）。agent 从不需要持有或出示 connection-key，它始终属于拥有者，走带外通道。

---

## 附录——底层协议参考（PAT wire） {#附录——底层揭秘-pat-wire}

使用 launcher 时，通常不必自己处理这些请求，`plexus` 命令会代办；直接接入 HTTP 的客户端则要逐步完成。下面列出 wire 上的请求与返回，代码依据见[安全模型](/zh/architecture/security-model) §2 中的 `file:line` 引用。

1. **DISCOVER**——`GET /.well-known/plexus`，免认证。返回网关身份、`auth` 公示的 enroll / handshake URL，以及 `capabilitiesVia` 指引。这里没有 capability 清单；清单在 enroll 和 handshake 之后返回，只包含这个 agent 当前授权范围内、且仍保持暴露的 capability。

2. **ENROLL**——`POST /agents/enroll`，body 为 `{ "code": "plx_enroll_…" }`。这一步以一次性码作为凭据，不接受 connection-key。成功时明文返回持久 PAT，**仅此一次**，之后无法再次取回。launcher 会存到本地；直接接入的 HTTP 客户端须自行保存。
   ```sh
   curl -s -H "Host: 127.0.0.1:7077" -H "content-type: application/json" \
     -X POST "http://127.0.0.1:7077/agents/enroll" \
     -d '{"code":"plx_enroll_…"}'          # → { "pat": "plx_agent_…", "agentId": "my-cc" }
   ```

3. **HANDSHAKE**——`POST /link/handshake`，带 `Authorization: Bearer plx_agent_…`，不带 body。网关校验 PAT，把会话绑定到它解析出的真实 `agentId`；客户端不能自称是另一个 agent。返回 `sessionId` 和该 agent 的 manifest：当前授权范围内、仍保持暴露的每项 capability 都有完整细节，但不是整个目录。这个范围包括拥有者选定的子集，以及拥有者另行建立了有效常驻授权的能力；后者须未过期，并通过当前 connection-key epoch 的校验。握手确认身份、交付清单，不授予笼统的调用许可。

4. **GRANT**——`PUT /grants`，带 `X-Plexus-Session: <sessionId>` 头，body 为 `{ "grants": { "<capabilityId>": "allow" } }`。已有常驻授权的 capability，例如拥有者连接时勾选的 read，或显式设为常驻的项，只要授权仍符合条件且有效，就直接取得受限 token，不再询问。当前授权范围内的其余请求会挂起等待拥有者批准，返回 `grant_pending_user` 和 `pendingId`；用同一个会话头轮询 `GET /grants/status?pendingId=…`。超出这个范围的请求直接拒绝，没有审批卡，也不挂起。关闭暴露的 capability 同样不能获得授权。

5. **INVOKE**——`POST /invoke`，带 `Authorization: Bearer <scoped-jwt>`，body 为 `{ "id": "<capabilityId>", "input": { … } }`。调用凭据是上一步取得的 scoped token，不是 PAT。统一结果契约见 ADR-017：`{ id, ok, output?, error?, auditId }`。拒绝时返回 `ok:false`，`error.code` 取自闭合联合，不是任意字符串。

这条链的精确参考实现是 [`examples/min-agent/`](https://github.com/nemori-ai/plexus/tree/main/examples/min-agent)。捆绑引擎 `tools/plexus-cli/plexus` 是它经过认可、经 Floor 校验的版本，随每个编译好的 plugin 交付。

指引不会让 agent 从磁盘取得拥有者的管理密钥，不会让它在 handshake 时出示 connection-key，也不会让它自铸 token。这里禁止的是获取拥有者的管理凭据，不是禁止 launcher 读取自己存储的 PAT。公示的接入路径始终经过审计，并受拥有者批准约束。

---

## 接下来去哪 {#接下来去哪}

- [编写一个扩展](/zh/guide/create-an-extension)——添加网关未随附的 capability，例如 vault *write*，并让编码 agent 根据一段描述写出 manifest。
- [暴露一个 source](/zh/guide/first-party-sources)——查阅随附 source 的 capability id、授权和前置条件：Obsidian、Apple Calendar/Reminders、Notes/Mail/Contacts/Photos、Shortcuts、browser、browser control、Claude Code。
- [协议](/zh/protocol/)——查阅冻结的 wire 契约与相关 ADR：ADR-016 端点公示、ADR-017 `/invoke`、ADR-018 统一信任模型。
