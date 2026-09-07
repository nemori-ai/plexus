---
title: 读一遍就通
description: Plexus 的心智模型——Connector → Source → Capability、来源、三个时钟、自描述的 Floor 及其编译投影。
---

# Plexus 核心概念——心智模型

Plexus 是一个**本地能力网关**。它运行在你的 Mac 上，**默认只绑定回环地址**；要开放给更大范围，须由用户主动选择并确认：通过 `network.json` 绑定局域网，或通过 `publicHostnames` / `PLEXUS_PUBLIC_HOSTNAME`，经隧道以主机名对外提供访问（具体做法见 [home-gateway 示例](https://github.com/nemori-ai/plexus/tree/main/examples/home-gateway)）。connection-key 是管理凭证，agent 建立会话时使用各自专属的 PAT，不使用 connection-key。Plexus 给任何 AI agent 提供一套面向 AI 的统一协议，让它们**发现 → 理解 → 获准 → 调用**你已经在用的软件的能力：笔记、日历、提醒事项和工具。多主机联邦拓扑已经实现（P1–P5），由一个主网关汇集多个代理网关的能力，详见 [联邦 mesh](/zh/architecture/mesh)。

本文是 Plexus 的核心文档。先读一遍，再看 [上手指南](/zh/guide/)、[安全模型](/zh/architecture/security-model) 和各篇教程，会更容易理解。

---

## 1. Connector → Source → Capability

Plexus 的各个部分都按下面三个层次组织，每一层回答一个问题：

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

### 内置的第一方能力 {#第一方-capability-开箱即带}

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
| `browser-control` | `browser-control.tabs.list`、`.page.read`、`.page.elements`、`.page.screenshot` | read |
| `browser-control` | `browser-control.page.navigate`、`.page.click`、`.page.type`、`.page.evaluate` | **execute** |

Apple 来源的列表操作**只实现了读取**，底层提供程序在读取日历或列表时没有任何写入路径。Reminders 另有两项**写入**能力，agent 绝不能自行授予自己使用这些能力的权限，详见下文的信任模型。

---

## 2. 信任模型——默认拒绝、有范围、有时限

Plexus 的核心承诺是：**agent 即使能连上网关，默认也没有任何权限。** 即便握手成功，也只是让 agent 知道所有者为它授权的能力有哪些，并不赋予调用权。调用权限由人授予，有明确的范围和期限，也可以随时撤销。

::: tip 一段专注的阅读
本节是信任模型的摘要，完整说明见独立页面：[信任模型](/zh/concepts/trust-model)。
:::

### 三个时钟，而非一个

Plexus 将**一次批准有效多久**、**智能体一轮工作持续多久**和**单个令牌有效多久**分开计时：

![信任窗口之上的短时受限 token](/diagrams/two-clocks.png)

- **信任窗口（trust-window）**——*你这个决定*的存活期。批准授权时你选一个窗口：`once`、`1h`、`1d`、
  `7d`、`until-revoked`，或自定义（`custom`）时长。窗口结束（或你撤销）之前，agent 不必再问。
  这就是**常驻授权**。

- **Session**——**单轮工作时限**：限定智能体能在多长时间内*无需人工介入*继续使用已有授权。
  （内存态，**60 分钟**，网关重启即失效），而 `POST /invoke` 和 `POST /grants/refresh` 都要求所出示
  token 的会话仍然存活。片段结束，静默换发链也随之终止——只有 agent 的 **PAT**，在一次全新的、留有
  审计记录的 handshake 里，才能打开下一个片段。

- **Scoped token**——**限制令牌泄露的后果**。每次实际调用都携带一个短期 bearer token，默认有效期为 **15 分钟**
  （`DEFAULT_TOKEN_LIFETIME_MS`，可在 `[1m, 60m]` 内配置）。令牌过期后，只要信任窗口仍有效、会话仍存活，agent 就能凭持续授权，通过 `POST /grants/refresh` 静默换发令牌，**无需 connection-key，也不用再次提示用户批准**。泄露的令牌也只有在尚未过期且会话仍存活时才有效。

三者构成**凭据层级**：PAT（身份，长期有效）→ 会话（工作时段，≤ 1 小时）→ 令牌（影响范围，约 15 分钟）。每往下一级，有效期更短，权限范围更小；窃取下级凭据也无法获得上级权限。完整说明见[信任模型](/zh/concepts/trust-model)。

`once` 授权仅供使用一次（`expiresAt = grantedAt`），不能刷新，也不能据此跳过以后的批准。

### 能否持续授权，取决于敏感程度而非来源（ADR-5） {#常驻资格随敏感度而定-而非随出身-adr-5}

不是每个窗口对每项 capability 都可选。**一次授权能不能*常驻*，由该 capability 自身的敏感度决定**
——从 `provenance × verb` 推导——而绝不由它从哪来决定：

- **`read`** 能力可以获得持续授权：批准后，授权在选定的信任窗口内有效（第一方和托管的读取能力默认 `7d`；`write` 默认 `1d`），
  后续在授权范围内的读取无需再次批准，直到窗口到期或你撤销授权。
- **`execute`** 或其他**高敏感性**能力默认要求**逐次批准**，授权上限为 `once`；不管请求哪种窗口，智能体都不能自行提高这个上限。
  运行代码（`claudecode.run`、`codex.run`）默认每次都要由人决定是否批准。只有**所有者**能在连接时，为特定 agent 与能力的组合启用**持续执行授权**（默认关闭，需两次确认）；启用后，该授权与其他持续授权一样，可设定有效期或选用 `until-revoked`。

所以信任窗口选择器会给 read 提供持久窗口，而 `execute` 授权默认就是 `once`——常驻是 *capability*
的属性加上拥有者的刻意开启，永远不是 agent 能替自己做的选择。

### Provenance：三类来源 {#来源-provenance-——三类-source-class-组织轴}

Plexus 判断该对一项能力有多谨慎，关键依据是它的 **provenance**，也就是这项能力来自哪里。

| 来源 | 含义 | 默认姿态 |
| --- | --- | --- |
| **first-party** | 保留的进程内 source（Apple Calendar/Reminders/Notes/Mail/Contacts/Photos、Claude Code、Codex、Shortcuts、browser、browser-control、workspace、sysinfo）。 | read 顺畅放行；write/execute 仍要问人。 |
| **managed** | *你*通过可信的 `/admin` UI 添加的 source（如 Obsidian vault——REST 或文件系统），添加时经过人的审查。 | read 姿态与第一方相同；write/exec 仍挂起等人批准。 |
| **extension** | *agent* 经 `POST /extensions` 在 wire 上注册，最严格的一类。 | **任何**动词都挂起等人批准。 |

来源之所以是组织轴，是因为信任应当随出身而定。第一方日历 read 和 agent 注册的 shell 包装器不是同一种风险，
Plexus 从不假装它们是。来源印记由网关盖在 source 上——扩展无法冒充第一方 id（那些 id 是保留的）。

### 敏感度（sensitivity）——推导出的风险层级

网关从来源 + 动词 + transport 推导出一个**敏感度**层级，目的只有一个：让 UI 和每个 agent 描述同一种风险：

- **low**——第一方 / 受管上的 read。
- **elevated**——第一方 / 受管上的 write/exec，*或*扩展上的 read。
- **high**——扩展上的 write/exec，*或*任何带 write/exec 的 `cli` / `local-rest` transport。

工作流的敏感度取各成员中的最高值。

### 授权账本与撤销

长期授权**对用户和智能体双方都可见**：

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

### 两种审批方式 {#双模授权-ux}

Plexus 支持两种互补的批准方式：

1. **按需（单次操作）审批。** 智能体需要授权时，就发起申请。
   对授权子集内的能力，若已有持续授权（如连接时选定的读取授权），请求就直接通过；否则，请求会**等待你审批**（`grant_pending_user`）。超出子集的请求直接拒绝，不会出现审批卡片。请求待审批时，你会看到卡片，说明谁要做什么、做多久，并提醒你“可随时撤销”。这些说明由网关撰写，*不是 agent 写的*。你可以批准并选择信任窗口，也可以拒绝。

2. **有范围的任务 bundle** *（机制保留；1.0 控制台暂不呈现）*。除临时批准外，Plexus 保留一套*任务 bundle*
   将一组授权连同各自的范围限制、附带的范围内上下文组成*有名称的授权包*，预先授予一个智能体。授权包只是用同一个 `bundleId` 将长期授权*分组*，不会赋予成员授权之外的权限。你可以一起查看一个任务涉及的授权，也可以一次撤销整个任务的授权；智能体则可调用一次 `GET /grants/context?bundle=<id>`，取得授权包附带的上下文。1.0 管理控制台**尚不支持**创建授权包；这一机制仍保留，作为[授权可扩展性 roadmap](/zh/architecture/extensibility)（ADR-020）中票据机制的雏形（proto-ticket）。目前，授权包中的成员显示为普通的长期授权。

一条关键的诚实性属性贯穿两种模式：**人读到的叙述由网关撰写，而非 agent。** agent 可以附一段自由文本，
说明"为什么是现在"，但展示时会明确标注为"the agent says：（agent 说：）"，且不影响任何授权决定——
网关会对它做净化和截断。agent 永远伪造不了那份风险摘要。

完整的威胁模型和信任边界，读[安全模型](/zh/architecture/security-model)。

---

## 3. MCP vs Plexus——"有哪些函数" vs "如何使用我"

Plexus 不是 [MCP](https://modelcontextprotocol.io) 的竞争者；它回答的是另一个问题。

- **MCP 描述一个 server *暴露哪些函数***——一份带 schema、可供 agent 调用的工具列表。它是工具调用的
  传输层，而且（自 MCP `2026-07-28` 起）是刻意无状态的传输层：身份、授权与跨请求状态都活在协议*之外*。
- **Plexus 描述*怎么使用这台机器*——并对使用设门。** 它的发现层回答的问题和 MCP 的不同：不是「这里有
  哪些功能”，而是 **“我怎样才能获得授权？”**——一个 URL 就能说明完整流程（注册、握手、授权、调用），能力目录本身也是授权的*结果*：只展示该智能体授权范围内的能力。在此基础上，**provenance / sensitivity** 让风险清楚可见；**限定范围和有效期、经人工批准的授权**确保未获授权的调用默认被拒绝；**附带的技能**帮助智能体学会*怎样用好*一项能力，而不只是知道它的调用签名；长期授权**台账**则让人能够核查和撤销授权。这些构成了 MCP 协议交由外部处理的身份、授权和状态层。

::: warning 状态
MCP 传输/客户端层已存在并经过测试，但面向用户的"把 MCP server 包装成 source"路径尚未交付（生产注册表里
没有 MCP source 模块）——目前要么经第一方 source 暴露 capability，要么写一个扩展。见
[KNOWN-LIMITATIONS](https://github.com/nemori-ai/plexus/blob/main/docs/KNOWN-LIMITATIONS.md)。下面的设计方向
描述了它将走向何处。
:::

具体来说，MCP 服务器可以*接入* Plexus，成为 `transport:"mcp"` 来源，其工具随之成为 Plexus 能力。MCP 来源信息会无损保留，以便 Plexus 能将调用发回原服务器。MCP 是 Plexus 支持的一种传输方式；Plexus 在其上提供信任、发现和能力层。

---

## 4. 自描述协议——两个层级

Plexus 的发现过程**分层**进行，每层只向智能体提供当下所需的信息。

### 层级 1——`.well-known` 入口（会话前、免认证）

```
GET /.well-known/plexus
```

返回网关身份、**认证接口说明**（所有会话端点的 URL，包括 `handshakeUrl`、`grantsUrl`、`invokeUrl` 等）、**注册说明**（`auth.enrollment`：如何用一次性代码换取 PAT），以及 `capabilitiesVia` 指针：*先注册并握手，再获取 Plexus 已授权你访问的能力列表*。智能体**从这份说明中读取端点 URL**，不把路径写死；能力列表随握手清单（Tier 2）返回。这个入口位于会话建立之前，无需凭据，也不提供凭据；**connection-key 绝不会出现在这里**，它仅供管理员使用。这套公开、自带用法说明的接口就是 **Floor**（见 [§5](#compile-model)）。

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

上文的 `.well-known` + `requestShapes` + 各项能力的*使用说明* + 输入／输出结构定义，构成 **Floor**：一组始终可用、自带用法说明的接口。**任何**智能体都能通过普通 HTTP 使用它，**无需**安装插件；注册、握手、申请授权和调用的方式都能从这里找到。智能体所需的信息不会藏在专用工具里。

![自描述 Floor 与投影在其上的 per-agent 编译插件](/diagrams/floor-projection.png)

在 Floor 之上，Plexus **为每个智能体编译一份专用集成包**（v1 是 Claude Code 插件），让智能体能按自己惯常的方式使用同一组能力。它是 **Floor 的投影，是缓存和快捷方式，绝不替代 Floor。** 包中附带**按版本隔离的智能体专属启动器 `plexus-<agentId>`**，包含自己的引擎和内置的 `PLEXUS_AGENT_ID`，因此同一主机上的两个智能体不会冲突，各自固定自己的引擎版本；绝不使用不带智能体标识或全局共用的 `plexus`。子命令如下：

- **`plexus-<agentId> enroll <code>`**——兑换一次性码 → PAT → 自行保存（仅首次运行）。
- **`plexus-<agentId> list`**——用于**发现能力**：列出该智能体的能力，分为 **callable-now**
  （已有持续授权，即 standing-granted）和 **needs-approval**（仍需审批）。智能体用它查看当前有哪些能力，包括所有者*在插件编译后*才授权给它的能力；Floor 反映当前状态，投影只缓存这些信息。
- **`plexus-<agentId> <capabilityId> [args]`**——invoke 一项 capability。

**在编译生成的集成中，启动器提供智能体所需的全部接口，所有交互也必须经过它。** 编译出的 skill 将此写成硬性规则：所有交互都通过 `plexus-<agentId> …` 完成；**不得自行编写 HTTP 请求访问网关**，**不得猜测认证路径**。启动器的认证和调用核心依据 Floor 按固定模板确定性生成，并对照 Floor 验证，绝不由 LLM 编写；**分发的产物中绝不内置长期有效的秘密凭据**（安装时只附带短期有效、单次使用的代码）。
skill 只是投影，网关会**实时**执行授权检查，因此过时或生成有误的 skill 都无法越过 Floor 的授权范围；最坏的情况是引用了已撤销的能力，调用会在网关处失败。

---

## 接下来去哪

- **[快速上手](/zh/guide/)**——安装 Plexus，在 macOS 上端到端连接你的第一个 agent。
- **[信任模型](/zh/concepts/trust-model)**——默认拒绝、三个时钟、来源、敏感度，以及 execute 默认授权仅限一次调用、再次调用需重新申请授权的规则（只有所有者明确选择启用持续授权，才能解除这一限制）
  （需拥有者显式开启才可常驻）。
- **[编译模型](/zh/concepts/compile-model)**——自描述的 Floor，以及作为其投影的专属编译 plugin。
- **[安全模型](/zh/architecture/security-model)**——权威的、引用代码的凭据模型：connection-key（管理员）
  对比专属 PAT，以及那道 `execute→once` 默认上限（只有拥有者的常驻 execute 开关能解除）。
- **[项目 README](https://github.com/nemori-ai/plexus/blob/main/README.md)**——一段话总览与仓库地图。
