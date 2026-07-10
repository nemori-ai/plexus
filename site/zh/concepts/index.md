---
title: 读一遍就通
description: Plexus 的心智模型——Connector → Source → Capability、来源、两个时钟、自描述的 Floor 及其编译投影。
---

# Plexus 核心概念——心智模型

Plexus 是一个**本地能力网关**。它跑在你的 Mac 上，**默认只绑定回环地址**——任何更大的暴露面都是可选项，需要用户确认：
通过 `network.json` 绑定局域网，或经 `publicHostnames` / `PLEXUS_PUBLIC_HOSTNAME` 发布到一个隧道前置的公网域名
（配方见 [home-gateway 示例](https://github.com/nemori-ai/plexus/tree/main/examples/home-gateway)）——信任边界始终是 connection-key。它给任何 AI agent 一套统一的 AI 原生协议，
用来**发现 → 理解 → 获得授权 → 调用**你已经在用的软件的各项 capability——你的笔记、日历、提醒、工具。
联邦式多主机拓扑是有文档记载的设计方向（草案），见[联邦 mesh](/zh/architecture/mesh)。

这是全站的基石文档。读完这一篇，Plexus 的其余部分（[上手指南](/zh/guide/)、[安全模型](/zh/architecture/security-model)、
以及各篇教程）自然各就各位。

---

## 1. Connector → Source → Capability

Plexus 里的一切都沿一条主轴组织。三个中文词，对应它回答的三个问题：

| 层 | 中文 | 问题 | 例子 |
| --- | --- | --- | --- |
| **Connector**（连接器） | 怎么接 | Plexus *怎么*连接这一类东西？ | "Obsidian Local REST API"、"Obsidian vault（文件系统）"、"Claude Code（沙箱）" |
| **Source**（源） | 接了什么 | 你实际*接入了什么*？ | 你在 `~/Documents/MyVault` 的那个 vault；正在运行的 REST plugin |
| **Capability**（能力） | 能干什么 | agent *能用它做什么*？ | `obsidian.vault.read`、`apple-calendar.events.list` |

![Connector → Source → Capability](/diagrams/source-capability-spine.png)

- **Connector** 是 Plexus 认识的一种*类型*，本质是纯目录数据：它声明"添加…"表单需要哪些配置字段、
  由此产生什么 transport，外加一句话说明它暴露什么。它不携带密钥，自身也不注册任何东西。
  目录在 `GET /admin/api/connectors`。

- **Source** 是 connector 的*已配置实例*——你实际添加的那个东西。Source 是**受管的**：运行时即可
  添加、移除、启用、禁用、重新配置，**持久化**在 `~/.plexus/sources.json`，并**热重载**进运行中的注册表，
  无需重启网关。列表在 `GET /admin/api/sources`。

- **Capability** 是 source 贡献的一项可调用操作，由稳定的点分 id 标识，如 `obsidian.vault.read`
  或 `apple-calendar.events.list`。每项 capability 声明输入/输出 schema、所需**动词**
  （`read` / `write` / `execute`）、一段人类可读的 `describe`，还可以附带 **skill**（markdown 用法指引，
  agent 读它学会怎么用好这项 capability）。

同一个 Obsidian *connector*（Local REST API 那种）可以支撑多个 *source*（不同的 vault），每个都暴露同样的
*capability*（`obsidian-rest.vault.{list,read,write}`）。

### 第一方 capability 开箱即带

有些 source 是**第一方**的——保留的、进程内的，除了底层应用自身的权限之外无需任何设置（workspace
和沙箱运行的 source 需要拥有者先授权一个目录）：

| Source | Capabilities | 动词 |
| --- | --- | --- |
| `apple-calendar` | `apple-calendar.calendars.list`、`apple-calendar.events.list` | read |
| `apple-reminders` | `apple-reminders.lists.list`、`apple-reminders.reminders.list` | read |
| `apple-reminders` | `apple-reminders.reminders.create`、`apple-reminders.reminders.complete` | **write** |
| `workspace` | `workspace.list`、`workspace.read`（`workspace.how-to-use` skill） | read |
| `workspace` | `workspace.write` | **write** |
| `claudecode` | `claudecode.run`（`claudecode.how-to-use` skill） | **execute** |
| `codex` | `codex.run`（`codex.how-to-use` skill） | **execute** |

Apple source 的 list 操作**在构造上只读**（底层 provider 对日历/列表读取根本没有写入路径）。Reminders
另有两项 **write** capability，agent 永远无法自行授予——见下面的信任模型。

---

## 2. 信任模型——默认拒绝、有范围、有时限

Plexus 的核心承诺：**能触达网关的 agent，默认依然没有任何权限。** 触达网关，哪怕握手成功，换来的只是
agent 知道"拥有者授权给它的有哪些"，绝不是调用任何东西的权利。权限由人授予：限定范围、限定时限、随时可撤销。

::: tip 一段专注的阅读
本节有独立成篇的页面：[信任模型](/zh/concepts/trust-model)。这里是行内摘要。
:::

### 两个时钟，而非一个

Plexus 刻意把**你的批准能常驻多久**和**单个 token 存活多久**分开：

![两个时钟 — 信任窗口之上的短时受限 token](/diagrams/two-clocks.png)

- **信任窗口（trust-window）**——*你这个决定*的存活期。批准授权时你选一个窗口：`once`、`1h`、`1d`、
  `7d`、`until-revoked`，或自定义（`custom`）时长。窗口结束（或你撤销）之前，agent 不必再问。
  这就是**常驻授权**。

- **受限 token（scoped token）**——**爆炸半径**。每次实际调用都携带一个短寿命的 bearer token，默认 **15 分钟**
  （`DEFAULT_TOKEN_LIFETIME_MS`，钳制在 `[1m, 60m]`）。token 过期后，只要信任窗口还在，agent 就通过
  `POST /grants/refresh` 从常驻授权静默换发一个新的——**不需要 connection-key，也不再提示**。所以泄漏的
  token 几分钟内就一文不值。

`once` 授权是特例：只为一次使用而立（`expiresAt = grantedAt`），不能刷新；未来该问的批准，一次也不会少。

### 常驻资格随敏感度而定，而非随出身（ADR-5）

不是每个窗口对每项 capability 都可选。**一次授权能不能*常驻*，由该 capability 自身的敏感度决定**
——从 `provenance × verb` 推导——而绝不由它从哪来决定：

- **`read`** capability 可以常驻：一经批准就取一个真实窗口（第一方/受管默认 `7d`；`write` 默认 `1d`），
  之后范围内的 read 在窗口结束或你撤销之前都零摩擦。
- **`execute`**（或其他**高敏感度**）capability 默认**逐次**批准，上限是 `once`——而且 agent 自己
  永远无法解除，不管它请求什么窗口。运行代码（`claudecode.run`、`codex.run`）默认每次都要一个新鲜的
  人类决定。**拥有者**可以在连接时为特定的 agent + capability 组合开启**常驻 execute** 授权
  （默认关闭、双重确认）；一经开启，该授权就像其他常驻授权一样，走真实窗口或 `until-revoked`。

所以信任窗口选择器会给 read 提供持久窗口，而 `execute` 授权默认就是 `once`——常驻是 *capability*
的属性加上拥有者的刻意开启，永远不是 agent 能替自己做的选择。

### 来源（provenance）——三类 source-class（组织轴）

决定 Plexus 对一项 capability 有多谨慎的唯一事实，是它的**来源**——这项 capability 从哪来：

| 来源 | 含义 | 默认姿态 |
| --- | --- | --- |
| **first-party** | 保留的进程内 source（Apple Calendar/Reminders、Obsidian 文件系统、Claude Code）。 | read 顺畅放行；write/execute 仍要问人。 |
| **managed** | *你*通过可信的 `/admin` UI 添加的 source（如 Obsidian REST vault），添加时经过人的审查。 | read 姿态与第一方相同；write/exec 仍挂起等人批准。 |
| **extension** | *agent* 经 `POST /extensions` 在 wire 上注册，最严格的一类。 | **任何**动词都挂起等人批准。 |

来源之所以是组织轴，是因为信任应当随出身而定。第一方日历 read 和 agent 注册的 shell 包装器不是同一种风险，
Plexus 从不假装它们是。来源印记由网关盖在 source 上——扩展无法冒充第一方 id（那些 id 是保留的）。

### 敏感度（sensitivity）——推导出的风险层级

网关从来源 + 动词 + transport 推导出一个**敏感度**层级，目的只有一个：让 UI 和每个 agent 描述同一种风险：

- **low**——第一方 / 受管上的 read。
- **elevated**——第一方 / 受管上的 write/exec，*或*扩展上的 read。
- **high**——扩展上的 write/exec，*或*任何带 write/exec 的 `cli` / `local-rest` transport。

Workflow 的敏感度按成员上卷（取最大值）。

### 授权账本与撤销

常驻授权是一等公民，**两侧都看得见**：

- 用户在 `/admin` 的 **Grants** 标签页看到全部授权。
- agent 在 `GET /grants`（会话认证）只看到*它自己*的。

每一行都带着 agent、capability、动词、来源、敏感度、信任窗口和到期时间。撤销随时可做：

- 人从 **Grants** 标签页撤销，或持管理 connection-key 调 `POST /grants/revoke`——按 `jti`、按
  `(agentId, capabilityId)`，或按 `bundleId` 撤销一整个任务 bundle。
- agent 出示某个 token 及其 `jti` 给同一个端点，可以放弃**它自己的** token。

### 暴露门控——拥有者的外层开关

授权决定 agent *可以*调用什么；**暴露（我暴露什么）是拥有者摆在授权之前的外层门控**。被拥有者禁用的
capability 在 discovery 里不可见、不可授权，invoke 时以 `capability_unexposed` 被拒——这一步在授权检查
**之前**执行。所以有效访问 = **已授权 ∧ 已暴露**：撤掉暴露就切断了这项 capability，不管还有什么常驻授权。
（已交付：`packages/runtime/src/core/exposure.ts`，拒绝逻辑接在 `pipeline.ts` 里。）

### 双模授权 UX

Plexus 支持两种互补的批准方式：

1. **临时（逐操作）批准。** agent 在需要时请求授权；对授权子集之内的 capability，网关要么自动批准
   （比如第一方 read），要么替你**挂起**（`grant_pending_user`）——子集之外的请求会被直接拒绝，
   不出卡片。请求挂起时，你看到一张由网关撰写的卡片——*不是* agent 的措辞——写明谁想做什么、
   做多久，并提醒你随时可撤销。你批准并选一个信任窗口，或者拒绝。

2. **有范围的任务 bundle** *（机制保留；1.0 控制台暂不呈现）*。除临时批准外，Plexus 保留一套*任务 bundle*
   机制：把一个*具名 bundle* 的授权（连同范围约束和附着的范围内上下文）一次性预授给某个 agent。bundle 只是
   常驻授权在共享 `bundleId` 之下的*分组*——它不赋予超出成员之外的任何权限，但让你能把一整个任务当作整体来
   推理和撤销，agent 经 `GET /grants/context?bundle=<id>` 一次调用就拉取该 bundle 附着的上下文。1.0 管理
   控制台**暂不**呈现 bundle 创建界面；该机制作为
   [授权可扩展性 roadmap](/zh/architecture/extensibility)（ADR-020）的 proto-ticket 保留。在此之前，bundle
   成员就作为一条普通的常驻授权显示。

一条关键的诚实性属性贯穿两种模式：**人读到的叙述由网关撰写，而非 agent。** agent 可以附一段自由文本，
说明"为什么是现在"，但展示时会明确标注为"the agent says：（agent 说：）"，且不影响任何授权决定——
网关会对它做净化和截断。agent 永远伪造不了那份风险摘要。

完整的威胁模型和信任边界，读[安全模型](/zh/architecture/security-model)。

---

## 3. MCP vs Plexus——"有哪些函数" vs "如何使用我"

Plexus 不是 [MCP](https://modelcontextprotocol.io) 的竞争者；它回答的是另一个问题。

- **MCP 描述一个 server *暴露哪些函数***——一份带 schema、可供 agent 调用的工具列表。它是工具调用的传输层。
- **Plexus 描述*怎么使用这台机器*——并对使用设门。** 它补上了工具列表本身不携带的东西：会话前的**发现**层，
  从一个 URL 就能自描述整个生命周期——enroll、handshake、grant、invoke；**来源 / 敏感度**，让风险清晰可读；**有范围、有时限、经人批准的授权**，
  让权限默认拒绝；**附着的 skill**，让 agent 学会*怎么用好*一项 capability，而不只是它的签名；
  还有一份常驻授权**账本**，让信任可审计、可撤销。

::: warning 状态
MCP 传输/客户端层已存在并经过测试，但面向用户的"把 MCP server 包装成 source"路径尚未交付（生产注册表里
没有 MCP source 模块）——目前要么经第一方 source 暴露 capability，要么写一个扩展。见
[KNOWN-LIMITATIONS](https://github.com/nemori-ai/plexus/blob/main/docs/KNOWN-LIMITATIONS.md)。下面的设计方向
描述了它将走向何处。
:::

具体来说：MCP server 可以被*摄入* Plexus，成为 `transport:"mcp"` 的 source，它们的工具成为 Plexus 的
capability（MCP 来源无损保留，Plexus 可以原路回到原始 server）。MCP 是 Plexus 会说的诸多传输之一；Plexus
是叠在其上的信任 + 发现 + capability 层。

---

## 4. 自描述协议——两个层级

Plexus 的发现是**分层的**：agent 每一步只揭示当下需要的那么多。

### 层级 1——`.well-known` 入口（会话前、免认证）

```
GET /.well-known/plexus
```

返回网关身份、**auth 公示**（每个会话端点的 URL——`handshakeUrl`、`grantsUrl`、`invokeUrl`、…）、
**enrollment 自描述**（`auth.enrollment`：如何用一次性码兑换 PAT），以及一条 `capabilitiesVia` 指引：
*enroll 并 handshake，即可收到 Plexus 授权给你访问的 capability 列表*。agent **从这份公示里读端点 URL**，
而不是硬编码路径；它的 capability 列表随握手 manifest（层级 2）到达。这里不需要凭据，也不提供凭据——
**connection-key 绝不出现在这里**（它仅限管理员）。这个公开、
自描述的暴露面就是 **Floor**（见[§5](#compile-model)）。

### 层级 2——握手 manifest（会话后、完整细节）

agent 用**它自己的专属 PAT** 开会话——绝不用 connection-key：

```
POST /link/handshake     Authorization: Bearer plx_agent_…
```

网关把 PAT 解析成该 agent 的**真实** `agentId`（客户端没法自称是别的 agent），返回一个**会话**加
该 agent 的 **manifest**——它的**拥有者授权子集**，子集内每个条目带完整的 `describe`、输入/输出 schema、
所需动词、transport、默认信任窗口，以及附着的 skill 正文。握手之后，agent *知道它的子集*，却*什么都
调用不了*：请求授权之前一律默认拒绝——而对子集之外的 capability 请求授权，会被直接拒绝。

PAT 从哪来？agent 在第一次握手之前**兑换一次**：用管理员连接它时签发的**一次性 enroll 码**（见
[§5](#compile-model)）。connection-key 是管理员/管理凭据，管的是握手的*管理员*路径——
不是 agent 出示的东西。

完整的 agent 循环，端到端：

```
0. DISCOVER    GET  /.well-known/plexus           (gateway identity + endpoint URLs + enrollment self-description)
1. ENROLL      POST /agents/enroll                (one-time code → durable per-agent PAT, stored 0600)
2. HANDSHAKE   POST /link/handshake               (Bearer PAT → real agentId → session + subset manifest)
3. GRANT       PUT  /grants                        (request scoped access → token, or pend for a human)
4. INVOKE      POST /invoke                        (Bearer scoped token → result → audit event)
```

第 0 步免认证；第 1 步每个 agent **只跑一次**；第 2–4 步重复。agent 侧一份完整、依赖极少的参考实现在
[`examples/min-agent/client.ts`](https://github.com/nemori-ai/plexus/blob/main/examples/min-agent/client.ts)；
可运行的自包含端到端演示：`bun run examples/min-agent/run.ts`。

---

## 5. 编译模型——Floor 及其投影 {#compile-model}

::: tip 一段专注的阅读
本节有独立成篇的页面：[编译模型](/zh/concepts/compile-model)。
:::

上面这一切（`.well-known` + `requestShapes` + 每项 capability 的 *how-to-use* + I/O schema）合起来就是
**Floor**：始终在场、自描述的资源暴露面。Floor 在纯 HTTP 上对**任何** agent 生效，**不需要**安装任何
plugin——enroll、handshake、grant、invoke 全都能从它那里发现。agent 需要的东西没有一样藏在定制工具后面。

![自描述 Floor 与投影在其上的 per-agent 编译插件](/diagrams/floor-projection.png)

在 Floor 之上，Plexus **为每个 agent 编译一件产物**（v1：一个 Claude Code plugin），让同样的 capability
在那个特定 agent 手里像原生的一样。这件产物是 **Floor 的投影——缓存和快捷方式，绝不是替代品。** 它随附
一个**版本隔离的专属 launcher `plexus-<agentId>`**（自带捆绑引擎 + 写死的 `PLEXUS_AGENT_ID`，所以同一台
主机上的两个 agent 永不冲突，各自锁定自己的引擎版本——绝不是不带 agent 标识的全局 `plexus`）。它的子命令：

- **`plexus-<agentId> enroll <code>`**——兑换一次性码 → PAT → 自行保存（仅首次运行）。
- **`plexus-<agentId> list`**——**发现动词**：枚举这个 agent 的 capability，分为 **callable-now**
  （已有常驻授权）和 **needs-approval**。agent 靠它认清方向——包括 plugin 编译*之后*拥有者才授权给
  这个 agent 的 capability（Floor 是活的；投影只是它的缓存）。
- **`plexus-<agentId> <capabilityId> [args]`**——invoke 一项 capability。

**launcher 是 agent 完整且唯一的接口。** 编译好的 skill 把这一条写成硬规则：每次交互都走
`plexus-<agentId> …`；**绝不**自己对网关拼 HTTP，**绝不**去猜认证路径。launcher 内部的认证/invoke 内核
从 Floor 确定性地模板化生成、并对着 Floor 校验过——不是 LLM 写的，而且**分发的产物里绝不写死任何持久密钥**
（随安装走的只有那个短寿命、一次性的码）。skill 只是投影，授权由网关**实时**强制，所以陈旧或误生成的
skill 永远越不过 Floor 的权限——最坏不过是引用了一项已撤销的 capability，invoke 在网关处直接失败。

---

## 接下来去哪

- **[快速上手](/zh/guide/)**——安装 Plexus，在 macOS 上端到端连接你的第一个 agent。
- **[信任模型](/zh/concepts/trust-model)**——默认拒绝、两个时钟、来源、敏感度，以及 execute 默认逐次规则
  （需拥有者显式开启才可常驻）。
- **[编译模型](/zh/concepts/compile-model)**——自描述的 Floor，以及作为其投影的专属编译 plugin。
- **[安全模型](/zh/architecture/security-model)**——权威的、引用代码的凭据模型：connection-key（管理员）
  对比专属 PAT，以及那道 `execute→once` 默认上限（只有拥有者的常驻 execute 开关能解除）。
- **[项目 README](https://github.com/nemori-ai/plexus/blob/main/README.md)**——一段话总览与仓库地图。
