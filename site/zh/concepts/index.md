---
title: 读一遍就通
description: Plexus 的心智模型——Connector → Source → Capability、来源、两个时钟、自描述的 Floor 及其编译投影。
---

# Plexus 核心概念——心智模型

Plexus 是一个**本地能力网关**。它运行在你的 Mac 上，**默认回环**——一次非回环绑定是可选项且需用户确认（经由
`network.json` 做局域网绑定，以 connection-key 作为信任边界）——并给任何 AI agent 一套单一的、AI 原生的协议，
去**发现 → 理解 → 被授权 → 调用**你已经在用的软件的各项 capability——你的笔记、你的日历、你的提醒、你的工具。
一个联邦式多主机拓扑是一个有文档记载的设计方向（草案）——见[联邦 mesh](/zh/architecture/mesh)。

这是那份基石文档。读它一遍，Plexus 的其余部分（[上手指南](/zh/guide/)、[安全模型](/zh/architecture/security-model)、
以及那些教程）都会各就各位。

---

## 1. Connector → Source → Capability

Plexus 里的一切都沿着一条主轴来组织。三个中文词，命名了它回答的三个问题：

| 层 | 中文 | 问题 | 例子 |
| --- | --- | --- | --- |
| **Connector**（连接器） | 怎么接 | Plexus *如何*连接这一类东西？ | "Obsidian Local REST API"、"Obsidian vault（文件系统）"、"cc-master" |
| **Source**（源） | 接了什么 | 你实际*接了什么*？ | 你位于 `~/Documents/MyVault` 的那个具体 vault；你运行中的 REST plugin |
| **Capability**（能力） | 能干什么 | 一个 agent *能用它做什么*？ | `obsidian.vault.read`、`apple-calendar.events.list` |

![Connector → Source → Capability](/diagrams/source-capability-spine.png)

- 一个 **Connector** 是 Plexus 知道如何对话的一个*类型*。它是纯粹的目录数据——它声明驱动"添加…"表单的那些
  配置字段、由此产生的 transport、以及一句话说明它暴露什么。它不携带任何密钥，自身也不注册任何东西。到
  `GET /admin/api/connectors` 浏览这份目录。

- 一个 **Source** 是一个 connector 的*已配置实例*——你添加的那个真实的东西。Source 是**受管的**：你在运行时
  添加 / 移除 / 启用 / 禁用 / 重新配置它们，它们**持久化**到 `~/.plexus/sources.json`，并且无需重启网关就
  **热重载**进鲜活的注册表。到 `GET /admin/api/sources` 列出它们。

- 一个 **Capability** 是一个 source 贡献的一项可调用操作——由一个稳定的点分 id 标识，如 `obsidian.vault.read`
  或 `apple-calendar.events.list`。每项 capability 都声明它的输入/输出 schema、它需要的**动词**
  （`read` / `write` / `execute`）、一段人类可读的 `describe`，以及——可选地——附着的 **skill**（markdown 用法
  指引，agent 可读它来学会如何用好这项 capability）。

同一个 Obsidian *connector*（Local REST API 那一种）可以支撑许多 *source*（不同的 vault），每一个都暴露同样的
*capability*（`obsidian-rest.vault.{list,read,write}`）。

### 第一方 capability 开箱即带

有些 source 是**第一方**的——保留的、进程内的，除了底层应用自己的权限授予之外无需任何设置即可存在（workspace
和沙箱化运行的那些 source 需要拥有者先授权一个目录）：

| Source | Capabilities | 动词 |
| --- | --- | --- |
| `apple-calendar` | `apple-calendar.calendars.list`、`apple-calendar.events.list` | read |
| `apple-reminders` | `apple-reminders.lists.list`、`apple-reminders.reminders.list` | read |
| `apple-reminders` | `apple-reminders.reminders.create`、`apple-reminders.reminders.complete` | **write** |
| `workspace` | `workspace.list`、`workspace.read`（`workspace.how-to-use` skill） | read |
| `workspace` | `workspace.write` | **write** |
| `claudecode` | `claudecode.run`（`claudecode.how-to-use` skill） | **execute** |
| `codex` | `codex.run`（`codex.how-to-use` skill） | **execute** |
| `cc-master` | `cc-master.orchestration.run`、`cc-master.board.*`、… | execute |

Apple source 对它们的 list 操作是**构造上只读**的（底层 provider 对日历/列表读取根本没有写入路径）。Reminders
额外加了两项 **write** capability，agent 永远无法自行授予——见下面的信任模型。

---

## 2. 信任模型——默认拒绝、有范围、有时限

Plexus 的核心承诺：**一个能触达网关的 agent，默认仍然没有任何权限。** 触达网关，哪怕成功握手，也只换来一个
agent 对"存在什么"的*知识*——而绝不换来调用任何东西的权利。权限是由人来授予的，有范围、有时限，且随时可撤销。

::: tip 一段专注的阅读
本节的材料有它自己自成一体的页面：[信任模型](/zh/concepts/trust-model)。这里是行内摘要。
:::

### 两个时钟，而非一个

Plexus 刻意把**你的批准能常驻多久**与**单个 token 存活多久**分开：

![两个时钟 — 信任窗口之上的短时受限 token](/diagrams/two-clocks.png)

- **信任窗口（trust-window）**——*你这个决定*的存活期。当你批准一次授权时，你选一个窗口：`once`、`1h`、`1d`、
  `7d`、`until-revoked`，或一个 `custom` 时长。在那个窗口结束（或你撤销）之前，agent 不必再问。这就是"常驻
  授权"。

- **受限 token（scoped token）**——**爆炸半径**。每一次实际调用都携带一个短寿命的 bearer token，默认 **15 分钟**
  （`DEFAULT_TOKEN_LIFETIME_MS`，钳制在 `[1m, 60m]`）。它过期时，只要信任窗口还立着，agent 就通过
  `POST /grants/refresh` 从常驻授权那里悄无声息地重铸一个新的——**无需 connection-key，无需再提示**。因此一个
  泄漏的 token 在几分钟内就一文不值。

一个 `once` 授权是特殊的：它恰好为一次使用而立（`expiresAt = grantedAt`），无法刷新，也永远不会短路掉一次未来的
批准。

### 常驻资格随敏感度而定，而非随出身（ADR-5）

不是每个窗口都对每项 capability 可供选择。**一次授权究竟能不能*常驻*，是由该 capability 自身的敏感度决定的**
——由 `provenance × verb` 推导而来——而绝不由它从哪来决定：

- 一项 **`read`** capability 可以常驻：一旦批准它就取一个真实窗口（第一方/受管默认 `7d`；`write` 默认 `1d`），
  于是后续在范围内的 read 直到窗口结束或你撤销之前都毫无摩擦。
- 一项 **`execute`**（或另有**高敏感度**）capability **永远不能**常驻。它是**每次使用**都批准，上限为 `once`
  ——*即便一个管理员提供了一个更长的信任窗口*。运行代码（`claudecode.run`、`codex.run`）正是那种其敏感度确实
  要求每次都做一个新鲜人类决定的情形，所以它永远不搭 `7d`/`until-revoked` 窗口。这个上限是结构性的：一个管理员
  无法把一项 `execute` capability 变成常驻。

所以信任窗口选择器为一次 read 提供一个持久窗口，但一次 `execute` 授权按构造就是 `once`——常驻这回事是*capability*
的一个属性，而不是 agent（甚至管理员）能为一项危险的 cap 覆盖掉的选择。

### 来源（provenance）——三类 source-class（组织轴）

驱动 Plexus 对一项 capability 有多谨慎的那个唯一事实，是它的**来源**——这项 capability 从哪来：

| 来源 | 含义 | 默认姿态 |
| --- | --- | --- |
| **first-party** | 一个保留的、进程内的 source（Apple Calendar/Reminders、Obsidian 文件系统、cc-master）。 | read 顺畅流过；write/execute 仍然要问人。 |
| **managed** | 一个*你*通过可信的 `/admin` UI 添加的 source（例如一个 Obsidian REST vault）。在添加时经人类审查。 | 共享第一方的 **read** 姿态；write/exec 仍挂起等一个人。 |
| **extension** | 由一个 *agent* 经 `POST /extensions` 在 wire 上注册。最严格的一类。 | **任何**动词都挂起等一个人。 |

来源是组织轴，因为信任应当随出身而定。一次第一方日历 read 和一个 agent 注册的 shell 包装器不是同一种风险，
Plexus 从不假装它们是。网关从 source 处*盖上*来源印记——一个扩展无法冒充一个第一方 id（那些 id 是保留的）。

### 敏感度（sensitivity）——推导出的风险层级

从来源 + 动词 + transport，网关算出一个**敏感度**层级，纯粹是为了诚实的叙述（好让 UI 和每个 agent 描述同一种
风险）：

- **low**——第一方 / 受管上的 read。
- **elevated**——第一方 / 受管上的 write/exec，*或*一个扩展上的 read。
- **high**——一个扩展上的 write/exec，*或*任何带 write/exec 的 `cli` / `local-rest` transport。

Workflow 会把其成员的敏感度上卷（取最大值）。

### 授权账本与撤销

常驻授权是一等公民，且**从两侧都可见**：

- 用户在 `/admin` 的 **Grants** 标签页里看到它们。
- agent 在 `GET /grants`（会话认证）看到*它自己*的常驻授权。

每一行都携带 agent、capability、动词、来源、敏感度、信任窗口、以及到期时间。随时撤销：

- 一个人从 **Grants** 标签页撤销，或用管理 connection-key 经 `POST /grants/revoke` 撤销（按 `jti`、按
  `(agentId, capabilityId)`、或按 `bundleId` 撤销一整个任务 bundle）。
- 一个 agent 可以通过出示某个 token 及其 `jti` 给同一个端点，来放弃**它自己的** token。

### 暴露门控——拥有者的外层开关

授权决定一个 agent *可以*调用什么；**暴露（我暴露什么）是拥有者摆在它们前面的外层门控**。一项被拥有者禁用的
capability 在 discovery 里不可见、不可授权，并在 invoke 时以 `capability_unexposed` 被拒绝——这在授权检查
**之前**强制执行。所以有效访问 = **已授权 ∧ 已暴露**：撤销暴露会切断一项 capability，无论存在什么常驻授权。
（已交付：`packages/runtime/src/core/exposure.ts`，拒绝逻辑接在 `pipeline.ts` 里。）

### 双模授权 UX

Plexus 支持两种互补的、让一个人批准工作的方式：

1. **临时（逐操作）批准。** agent 在需要时请求一次授权；网关要么自动批准（例如一次第一方 read），要么替你
   **挂起**（`grant_pending_user`）。你看到一张网关撰写的卡片——*不是* agent 的措辞——它精确告诉你谁想做什么、
   做多久，并附一句"随时可撤销"的提醒。你批准并挑一个信任窗口，或者拒绝。

2. **有范围的任务 bundle。** 与其一次批准一个操作，不如预先把一个*具名 bundle* 的授权（外加它们的范围约束和
   任何附着的范围内上下文）一次性授权给某个 agent。这个 bundle 纯粹是常驻授权在一个共享 `bundleId` 之下的一个
   *分组*——它不赋予超出其成员的任何权限，但它让你能够把一整个任务作为一个整体来推理和撤销。agent 可以经
   `GET /grants/context?bundle=<id>` 在一次调用里拉取该 bundle 附着的上下文。

一条至关重要的诚实性属性贯穿两种模式：**人类读到的叙述是由网关撰写的，而非 agent。** agent 可以附一段自由文本
的"为什么是现在"目的，但它会被清楚地标注为"the agent says：（agent 说：）"来展示，并且不影响任何授权决定——
网关会对它做净化和截断。agent 永远无法伪造那份风险摘要。

完整的威胁模型和信任边界，读[安全模型](/zh/architecture/security-model)。

---

## 3. MCP vs Plexus——"有哪些函数" vs "如何使用我"

Plexus 不是 [MCP](https://modelcontextprotocol.io) 的竞争者；它回答一个不同的问题。

- **MCP 描述一个 server *暴露哪些函数***——一个带 schema、agent 可调用的工具列表。它是一个工具调用传输。
- **Plexus 描述*如何使用用户的机器*——并对它做门控。** 它加上了单凭一个工具列表所不携带的那些东西：一个
  会话前的**发现**层，好让一个 agent 在认证之前先橱窗浏览；**来源 / 敏感度**，好让风险清晰可读；**有范围、有
  时限、经人类批准的授权**，好让权限默认拒绝；**附着的 skill**，好让一个 agent 学会*如何用好*一项 capability，
  而不只是它的签名；以及一份常驻授权**账本**，好让信任可审计、可撤销。

::: warning 状态
MCP 传输/客户端层存在且经过测试，但面向用户的"把一个 MCP server 包装成一个 source"路径尚未交付（生产注册表里
没有 MCP source 模块）——如今你要么经由第一方 source 暴露 capability，要么编写一个扩展。见
[KNOWN-LIMITATIONS](https://github.com/nemori-ai/plexus/blob/main/docs/KNOWN-LIMITATIONS.md)。下面的设计方向
描述了这将走向何方。
:::

具体来说：MCP server 可以被*摄入* Plexus 成为一个 `transport:"mcp"` 的 source，它们的工具成为 Plexus 的
capability（并无损保留 MCP 来源，好让 Plexus 能往返回到原始 server）。MCP 是 Plexus 说的诸多传输之一；Plexus
是叠在其上的信任 + 发现 + capability 层。

---

## 4. 自描述协议——两个层级

Plexus 的发现是**分层的**，好让一个 agent 恰好揭示当下所需的那么多：

### 层级 1——`.well-known` 摘要（会话前、免认证）

```
GET /.well-known/plexus
```

返回网关身份、一份**摘要** capability 列表（id + label + 来源——足以*橱窗浏览*，不足以*调用*）、**auth 公示**
（每个会话端点的 URL——`handshakeUrl`、`grantsUrl`、`invokeUrl`、…），以及 **enrollment 自描述**
（`auth.enrollment`：如何用一个一次性码兑换一个 PAT）。一个 agent **从这份公示里读取端点 URL**，而不是硬编码
路径。无需任何凭据，也不提供任何凭据——**connection-key 绝不出现在这里**（它仅限管理员）。这个公开的、自描述的
暴露面就是 **Floor**（见[§5](#_5-编译模型-floor-及其投影)）。

### 层级 2——握手 manifest（会话后、完整细节）

一个 agent 用**它自己的专属 PAT** 开一个会话——绝不用 connection-key：

```
POST /link/handshake     Authorization: Bearer plx_agent_…
```

网关把 PAT 解析到该 agent 的**真实** `agentId`（一个客户端无法自称是别的 agent 的身份），并返回一个**会话**加上
**完整 manifest**——每一个条目连同它完整的 `describe`、输入/输出 schema、需要的动词、transport、默认信任窗口、
以及附着的 skill 正文。握手之后，agent *知道一切*却*什么都调用不了*：在它请求一次授权之前默认拒绝。

PAT 从哪来？agent 在它第一次握手之前**兑换它一次**，用管理员在连接它时签发的一个**一次性 enroll 码**（见
[§5](#_5-编译模型-floor-及其投影)）。connection-key 是管理员/管理凭据，管控握手的*管理员*路径——它不是一个 agent
出示的东西。

完整的 agent 循环，端到端：

```
0. DISCOVER    GET  /.well-known/plexus           (summaries + endpoint URLs + enrollment self-description)
1. ENROLL      POST /agents/enroll                (one-time code → durable per-agent PAT, stored 0600)
2. HANDSHAKE   POST /link/handshake               (Bearer PAT → real agentId → session + full manifest)
3. GRANT       PUT  /grants                        (request scoped access → token, or pend for a human)
4. INVOKE      POST /invoke                        (Bearer scoped token → result → audit event)
```

第 0 步免认证；第 1 步每个 agent **只跑一次**；第 2–4 步重复。agent 侧一份完整、依赖极少的参考实现在
[`examples/min-agent/client.ts`](https://github.com/nemori-ai/plexus/blob/main/examples/min-agent/client.ts)；
一个可运行、自成一体的端到端演示是 `bun run examples/min-agent/run.ts`。

---

## 5. 编译模型——Floor 及其投影

::: tip 一段专注的阅读
本节有它自己自成一体的页面：[编译模型](/zh/concepts/compile-model)。
:::

上面的一切（`.well-known` + `requestShapes` + 每项 capability 的 *how-to-use* + I/O schema）就是 **Floor**：那个
始终在场、自描述的资源暴露面。Floor 对**任何** agent 都在纯 HTTP 上起作用，**无需**安装任何 plugin——enroll、
handshake、grant、invoke 全都可从它那里发现。一个 agent 需要的任何东西都不藏在定制工具之后。

![自描述 Floor 与投影在其上的 per-agent 编译插件](/diagrams/floor-projection.png)

在 Floor 之上，Plexus **为每个 agent 编译一件产物**（v1：一个 Claude Code plugin），让同样的 capability 对那个
特定 agent 感觉起来是原生的。这件产物是**对 Floor 的一层投影——一个缓存/快捷方式，绝不是替代品。** 它随附一个
**版本隔离的专属 launcher `plexus-<agentId>`**（它自己捆绑的引擎 + 一个烧进去的 `PLEXUS_AGENT_ID`，因此一台
主机上的两个 agent 永不冲突，且各自钉定自己的引擎版本——绝不是一个裸的/全局的 `plexus`）。它的子命令：

- **`plexus-<agentId> enroll <code>`**——兑换一次性码 → PAT → 自存（仅首次运行）。
- **`plexus-<agentId> list`**——**发现动词**：枚举这个 agent 的 capability，分成 **callable-now**（已常驻授权）
  vs **needs-approval**。这是一个 agent 认清方向的方式——包括任何在 plugin 被编译*之后*才暴露的 capability
  （Floor 是鲜活的；投影只是缓存它）。
- **`plexus-<agentId> <capabilityId> [args]`**——invoke 一项 capability。

**launcher 是 agent 完整且唯一的接口。** 那个编译好的 skill 把这条作为一条硬规则陈述：把每一次交互都经由
`plexus-<agentId> …` 来驱动；**绝不**对着网关自己拼 HTTP，**绝不**去猜一条认证路径。launcher 内部的认证/invoke
内核是从 Floor 确定性地模板化生成、并对着它校验过的——绝非 LLM 撰写，而且**绝无任何持久密钥被烧进被分发的
产物**（只有那个短寿命、单次使用的码随安装而行）。因为一个 skill 是一层投影、而网关**实时**强制授权，一个陈旧
或误生成的 skill 永远无法超出 Floor 的权限——最坏情况也不过是它引用了一项已撤销的 capability，于是 invoke 直接
在网关处失败。

---

## 接下来去哪

- **[快速上手](/zh/guide/)**——安装 Plexus 并在 macOS 上端到端连接你的第一个 agent。
- **[信任模型](/zh/concepts/trust-model)**——默认拒绝、两个时钟、来源、敏感度、以及 execute 永不常驻规则。
- **[编译模型](/zh/concepts/compile-model)**——自描述的 Floor，以及作为其上一层投影的专属编译 plugin。
- **[安全模型](/zh/architecture/security-model)**——那份权威的、引用代码的凭据模型：connection-key（管理员）
  对比专属 PAT，以及那道 `execute→once` 上限。
- **[项目 README](https://github.com/nemori-ai/plexus/blob/main/README.md)**——一段话的总览与仓库地图。
