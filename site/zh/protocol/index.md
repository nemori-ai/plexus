---
title: Plexus 协议
description: M0 wire 契约（v0.1.3）——稳定、AI 原生的 DISCOVER → ENROLL → HANDSHAKE → GRANT → INVOKE 界面，及其端点、受限 token 模型与统一信任模型。
---

# Plexus 协议 —— M0 契约规范

::: tip 状态
**M0 契约 `v0.1.3`** · 协议**族** `0.1`（`config.ts` 导出的 major.minor——加性、补丁兼容）· 确切**版本** `0.1.3` · 规范常量：`PLEXUS_PROTOCOL_VERSION = "0.1.3"`（见
[`VERSION`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/VERSION)）。wire 上广告的是族 `"0.1"`（`0.1.x` 客户端跨补丁版本互操作）；`0.1.3` 是确切的契约修订。

**两凭据 + execute 默认逐次（ADR-4 / ADR-5 / ADR-023——已发布的 auth 模型）：** agent 用**自己持久的、按 agent 独立的 PAT**（`plx_agent_…`）认证；PAT 由一次性 **enroll 码**（`plx_enroll_…`）兑换一次得来。**connection-key**（`plx_live_…`）**只**是**管理员**凭据，agent 永远见不到。agent 循环因此多出一步 **ENROLL**（`POST /agents/enroll`），handshake 对 agent 做 **PAT 门控**。**ADR-5 / ADR-023：** `execute`（高敏感度）capability 默认**逐次**批准（`once`）——agent 自己永远无法解除，任何请求窗口或管理员信任窗口下都成立；**所有者**可在连接时为特定 (agent, capability) 开启常驻 execute 授权（默认关闭、双重确认），开启后才走真实的信任窗口 / until-revoked。权威模型见[安全模型](/zh/architecture/security-model)；本文是与之相符的 wire 契约。

这是**核心资产**：整个 Plexus 代码库的类型都以
[`types.ts`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/types.ts)
里的规范定义为准。本文档是给人读的契约；`types.ts` 是机器侧的事实源。ADR 见[决策记录](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/DECISIONS.md)。
:::

Plexus 是用户自装的开源**本地 capability 网关**。它暴露一个稳定、AI 原生的自描述端点，任何 AI agent 都能循 **DISCOVER → ENROLL → HANDSHAKE → be GRANTED → INVOKE** 使用用户机器上软件的 capability。agent 只 enroll 一次（用一次性码兑换自己的持久 PAT），此后每个会话都凭这份 PAT handshake——它从不持有所有者的 connection-key。

**定位（已锁定）：** *“MCP = 我有哪些函数；Plexus = 你该如何使用我。”* MCP 是一等的、**享有特权的导入 transport**（`transport: "mcp"`）；MCP 工具/资源/提示的 JSON Schema **逐字**通过。其余各层——预会话的 `.well-known` 自描述、捆绑的**使用 Skill**、用户自定义的**扩展**、**按 capability 的受限授权与 token**——都叠在 MCP wire **之上**。

::: warning 状态（MCP 导入）
MCP transport/客户端层已实现并测试，但面向用户的“把 MCP 服务器包成源”路径**尚未发布**——生产注册表（`MODULES`）里没有 MCP 源模块。现阶段要暴露 capability，走 first-party 源，或自己写扩展。本规范通篇的 MCP 设计是已锁定的方向和传输契约，还不是可用的终端用户路径（见
[`KNOWN-LIMITATIONS.md`](https://github.com/nemori-ai/plexus/blob/main/docs/KNOWN-LIMITATIONS.md)）。
:::

## §7（先读）—— Plexus 的四件事与数据流

Plexus 做四件事；本规范里的一切都服务于其中之一。

1. **Scan** —— 探测机器上已安装、可适配的 capability 源（first-party 适配器、MCP 服务器、用户扩展）。二进制/端点发现走平台接缝（登录 shell 的 PATH 捕获 + 回退候选目录，复用自 pneuma `path-resolver`）。
2. **Adapt** —— 每个源前面都有一个适配器（`CapabilitySource` + `CapabilityBridge`），把源的原生协议翻译成统一的条目模型。适配器类型对核心是**黑盒**。
3. **Describe** —— 每个 capability、skill、workflow 都注册为**同构的自描述条目**（`CapabilityEntry`），以 `kind` 区分。这是核心：agent 读一张“卡片”就知道它是什么、怎么用。
4. **Expose** —— 一个回环端点界面（`.well-known` → handshake → grants → invoke）。界面背后是谁，对外不可见。

![五步 agent 循环 — discover、enroll、handshake、grant、invoke](/diagrams/protocol-loop.png)

```
 Your desktop                Plexus (local 127.0.0.1 process)              AI agent client
 ┌──────────────┐     ┌───────────────────────────────────────────┐     ┌──────────────────┐
 │ Desktop app  │     │  ADAPTER LAYER            CORE             │     │ Any agent that   │
 │ (local-rest) │──┐  │ ┌─────────────────┐   ┌────────────────┐  │     │ speaks the       │
 │ MCP server   │──┼─▶│ │ CapabilitySource │   │  Registry       │  │  GET │ Plexus protocol  │
 │ (transport:  │  │  │ │  · checkReqs     │──▶│  (entries by id)│◀─┼──────│ 1 DISCOVER       │
 │   mcp)       │  │  │ │  · scan()        │   │                │  │ POST │ /.well-known     │
 │ CLI agent    │──┤  │ └─────────────────┘   │  Enroll ledger  │◀─┼──────│ 2 ENROLL  (code) │
 │ (cli/stdio)  │  │  │ ┌─────────────────┐   │  Grants + Token │  │ POST │ /agents/enroll   │
 │ User ext     │──┘  │ │ CapabilityBridge │   │  store          │◀─┼──────│ 3 HANDSHAKE(PAT) │
 │ (any wire)   │     │ │  · invoke()/route│   │  Audit log      │  │  PUT │ /link/handshake  │
 └──────────────┘     │ │                 │◀──│  (per-session)  │◀─┼──────│ 4 GRANTED        │
   ▲ Transport seam   │ └────────┬────────┘   └────────┬───────┘  │ POST │ /grants          │
   │ Platform seam    │          │ Transport.dispatch() │ Expose  │◀─────│ 5 INVOKE         │
   │                  │          ▼                      ▼          │      │ /invoke          │
   └──────────────────│   local-rest│stdio│ipc│mcp│cli  one URL   │     └──────────────────┘
                      └───────────────────────────────────────────┘
                         Platform seam (macOS first): binary discovery,
                         process spawn, local-service location — all OS-specific
                         parts isolated behind PlatformServices.
```

**关键不变量：** 客户端永远只与一个稳定的端点界面对话。Scan / adapt / 协议翻译全部密封在 Plexus 进程内部——既是工程解耦，也是合规边界。（图示为五步 agent 循环；ENROLL 每个 agent 只跑**一次**，之后每个会话都用存好的 PAT 从 HANDSHAKE 开始。完整端点集合，连同生命周期端点 `/grants/refresh`、`/grants/revoke`、`/grants/status`、`/manifest`、`/events`、`/extensions`，全部在 `.well-known` 里广告，见 §2。）

## §1 —— 统一自描述条目模型

`capability` / `skill` / `workflow` 是靠 `kind` 字段区分的**同构**条目：agent 用同一个循环发现三者，在同一个界面上授权，（capability/workflow）经同一条路径调用。

规范类型：`types.ts` 里的 `CapabilityEntry`（别名 `SelfDescribeEntry`）。

| 字段 | 含义 |
|---|---|
| `id` | 全局唯一、稳定的 id。grant/scope/audit/invocation 的单元。约定 `<source>.<noun>.<verb>`。 |
| `source` | 产出它的源/适配器。 |
| `kind` | `capability` \| `skill` \| `workflow`。 |
| `label` | 简短的人类标签。 |
| `describe` | **核心。** 语义化、面向 agent 的"什么 / 何时 / 如何用好我"。约定：*"Action outcome. Use when X."* |
| `io` | `{ input?, output? }` JSON Schema。**MCP 工具 schema 逐字落入。** |
| `grants` | 所需动词：`read` \| `write` \| `execute`。 |
| `transport` | 适配器如何触达软件（见 §3）。 |
| `skills` | 附着的使用 Skill 引用（加性的“如何使用”层）。 |
| `members` | （仅 workflow）有序的 `WorkflowMember[]`（`{id, verbs}`）；每个 id 必须是注册表里实际存在的条目。驱动传递性授权（§4）。 |
| `body` | （仅 skill）内联或按引用的 markdown 使用指引。 |
| `mcp` | （仅 mcp）逐字的 MCP 来源——`serverId`、`protocolVersion`、`primitive`、`originName`，以及 `raw`（未改动的原始 MCP 对象）。 |
| `version`、`extras` | 元数据；`extras` 从不被核心路由读取。 |

### 三个种类

- **`capability`** —— 可直接调用的函数或数据访问，最小的调用单元。导入的 **MCP 工具**正好投影成这一种。
- **`skill`** —— 面向 agent 的**使用知识**（“如何用好我”：可用范例、坑、约定）。**这一层 MCP 没有。** 可被发现，但只作为上下文来读（`transport` 为 `"skill"`，不被调用）。
- **`workflow`** —— 用户或 first-party 把多个 capability 编排成一个更高层的 capability。调用方式与 capability 相同；内部沿 `members` 扇出。

### 导入的 MCP 工具如何映射为条目

::: warning 状态
Transport/客户端层已实现并测试；面向用户的“把 MCP 服务器包成源”路径**尚未发布**（生产注册表里没有 MCP 源模块）。下面的投影是该 transport 将来遵循的契约（见
[`KNOWN-LIMITATIONS.md`](https://github.com/nemori-ai/plexus/blob/main/docs/KNOWN-LIMITATIONS.md)）。
:::

MCP 发现**只在会话内**发生——不存在未认证的 MCP manifest。`scan()` 期间，Plexus 对每个 MCP 源运行一个 **MCP 客户端**（`initialize → tools/list → resources/list → prompts/list`），把每种原语**投影**成 `CapabilityEntry`：

| MCP | → Plexus 条目字段 |
|---|---|
| Tool `name` | `mcp.originName`（并播种 `id` 为 `mcp.<server>.<name>`） |
| Tool `description` | 播种 `describe`（附着的 skill 可再丰富它） |
| Tool `inputSchema` | `io.input` **逐字** |
| Tool `outputSchema` | `io.output` **逐字** |
| Tool 注解（`readOnlyHint` 等） | 影响 `grants`（read 对 write） |
| 整个 Tool JSON | `mcp.raw`（未改动，用于重投影 + façade） |
| Resource | `kind:"capability"`、`mcp.primitive:"resource"`、只读；`mcp.originName` = 资源 **URI** |
| Prompt | `kind:"skill"` 或 capability 种子、`mcp.primitive:"prompt"`；`mcp.originName` = 提示 **name** |

**资源与提示是一等公民（评审 #1/#2）。** 不止工具：`mcp` transport **按 `mcp.primitive` 分支**——工具走 `tools/call`，资源走 `resources/read`（参数 `uri`），提示走 `prompts/get`（参数 name + args）。每种原语的原生形状都放回响应里的**逐字 `McpResult`** 槽——工具用 `content[]`+`structuredContent`（+`isError`），资源用 `contents[]`，提示用 `messages[]`——因此都能无损往返（取代旧的仅工具 `mcpContent`）。`*/list` 分页拉取直到取完，大服务器也不会被截断。

Plexus **只做包装**，从不重写导入的 schema。范例见
[`mcp-tool-passthrough.github.create_issue.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/mcp-tool-passthrough.github.create_issue.json)。

::: info Schema 校验注记（评审 #10）
"逐字直通"意味着 JSON Schema 原封不动地一路带到 manifest/agent——但这**不**意味着 `/invoke` 完全强制它。运行时 invoke 只做**轻量校验**：必需键在场 + 每个顶层属性的原语类型 + 可选启用的 `additionalProperties` 拒绝。嵌套对象、`$ref`、`format` 和联合 schema 在 invoke 时**不做**强制；逐字 schema 是给 agent/manifest 的指引，不是一道完整的 JSON-Schema invoke 门。
:::

### 用户扩展如何产出**相同**的形状

用户扩展声明一个 `ExtensionManifest`（`types.ts §1b`），列出它贡献的 capability；网关据此物化出一个 `CapabilitySource`，其 `scan()` 把每条声明投影成完全相同的 `CapabilityEntry` 形状（"一句话打开一个 Obsidian vault"的流程就会生成一个）。扩展经 `POST /extensions`（§2）注册——**Flow B** 因此端到端可演示。agent 分辨不出——也不必分辨——first-party 适配器、导入的 MCP 工具、用户扩展：三者都只是条目。**定制即扩展；扩展被自动发现。** 本地服务凭据（如 Obsidian Local REST API 的 bearer 密钥）声明为 `ExtensionSecretRef`，派发时经平台接缝（`PlatformServices.resolveSecret`）从 `~/.plexus/secrets/` 解析，从不出现在条目、manifest、`.well-known` 或审计里。见
[`extension-manifest.obsidian.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/extension-manifest.obsidian.json)。

可用范例：
[`obsidian.vault.read.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/obsidian.vault.read.json)
（用户扩展，`kind:"capability"`、`transport:"local-rest"`、只读）和
[`orchestrator.pipeline.run.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/orchestrator.pipeline.run.json)
（first-party 编排，`kind:"workflow"`、`transport:"workflow"`、`grants:["execute"]`，带 `members`）。

## §2 —— 端点契约

所有端点默认服务在回环绑定上（默认 `http://127.0.0.1:7077`）；经 `~/.plexus/network.json` 绑定选定的 NIC 或 `0.0.0.0` 属可选启用，此时 connection-key 是 LAN 的信任边界（见 §5）。错误统一使用 `ErrorResponse` 信封。

### `GET /.well-known/plexus` → 发现（未认证、预会话）

这正是 **MCP 刻意不给**的东西：预会话、未认证的广告。返回一个 `WellKnownDocument`：网关身份、**auth 公示**（每个生命周期/auth 端点的 URL + enrollment 自描述），以及一个 **`capabilitiesVia` 指引**——enroll + handshake 之后即可收到 Plexus 授权给你访问的 capability 列表。按 agent 的 capability 列表（所有者授权的子集，含完整 schema 与 skill 主体）随 handshake 的 manifest 到达。

**响应（示例）：**
```json
{
  "gateway": {
    "name": "plexus", "version": "0.1.0", "protocol": "0.1",
    "baseUrl": "http://127.0.0.1:7077", "instance": "ez-macbook"
  },
  "capabilitiesVia": "Enroll and handshake to receive the list of capabilities Plexus has authorized you to access.",
  "auth": {
    "enrollmentUrl": "http://127.0.0.1:7077/agents/enroll",
    "enrollment": {
      "url": "http://127.0.0.1:7077/agents/enroll",
      "method": "POST",
      "auth": "body.code",
      "body": { "code": "<one-time enrollment code (plx_enroll_…, delivered out of band)>" },
      "success": { "pat": "<durable bearer PAT (plx_agent_…) — store it yourself>", "agentId": "<your agentId>" },
      "patStorage": "Store the returned PAT yourself (it is returned exactly ONCE), then present it as Authorization: Bearer plx_agent_… at handshake. Enrollment happens once; the stored PAT authenticates every later session."
    },
    "handshakeUrl": "http://127.0.0.1:7077/link/handshake",
    "grantsUrl": "http://127.0.0.1:7077/grants",
    "grantRequestUrl": "http://127.0.0.1:7077/grants",
    "grantRequestMethod": "PUT",
    "sessionHeader": "X-Plexus-Session",
    "refreshUrl": "http://127.0.0.1:7077/grants/refresh",
    "revokeUrl": "http://127.0.0.1:7077/grants/revoke",
    "grantStatusUrl": "http://127.0.0.1:7077/grants/status",
    "invokeUrl": "http://127.0.0.1:7077/invoke",
    "manifestUrl": "http://127.0.0.1:7077/manifest",
    "eventsUrl": "http://127.0.0.1:7077/events",
    "grantsListUrl": "http://127.0.0.1:7077/grants",
    "connectionKeyDelivery": "user-paste",
    "tokenScheme": "plexus-scoped-jwt"
  }
}
```

`auth` 块是自描述的：已兑换 enroll 码、存好 PAT 的冷启动 agent 直接从这里读 `handshakeUrl`（出示 `Bearer plx_agent_…`）、`grantRequestUrl` + `grantRequestMethod` 和 `sessionHeader`——不硬编码路径，也不猜 auth 方案。`enrollment` 描述一次性码 → PAT 的兑换（见下）。这里**没有** `connectionKey` 字段；`connectionKeyDelivery` 描述的是**所有者**如何带外收到 connection-key（仅管理员路径，不是 agent 的可用界面）：connection-key 是所有者的管理员凭据，从不向 agent 广告，agent 也从不持有（§5）。

::: info 端点命名空间约定（ADR-016）
agent 的每一个端点 URL 都从这个 `auth` 广告里读，而非硬编码。agent 平面的端点住在扁平命名空间之下：`/agents/enroll`（预会话、码门控）、`/link/handshake`（PAT 门控）、`/grants`、`/grants/refresh`、`/grants/revoke`、`/grants/status`、`/invoke`、`/manifest`、`/events`、`/extensions`。所有者的管理平面单独住在 `/admin/api/*` 之下，由 connection-key 门控——agent 永远够不到它（§5）。
:::

### `POST /agents/enroll` → 用一次性码兑换持久 PAT（码门控）

每个 agent 在第一次 handshake 之前跑**一次**。agent 出示它的**一次性 enroll 码**（`plx_enroll_…`，单次使用，约 15 分钟有效）——由所有者交给它的安装命令带外送达（§5）。网关兑换该码，把这个 agent **持久的、按 agent 独立的 PAT**（`plx_agent_…`）以明文返回**恰好一次**；存储的只有静态哈希。`agentId` 由该码在服务端绑定——**不是**自我断言的。

**请求：**
```json
{ "code": "plx_enroll_2b7d…c90" }
```
**响应：**
```json
{ "pat": "plx_agent_9f1a…44e", "agentId": "agent-ez-1" }
```
PAT 由 agent 自己保管（用它自己的方式，`0600`），此后每次 handshake 出示。码在兑换成功时被消费（重放一次即失败，返回 `code_consumed`）。失败即关闭，原因：`malformed` / `unknown_code` / `code_expired` / `code_consumed` / `persist_failed`（持久写入失败会把码留作未消费，可重试）。connection-key 在这里**绝不**被接受。

### `POST /link/handshake` → 授权子集 manifest（对 agent 是 PAT 门控）

agent 把自己的 PAT 作为 `Authorization: Bearer plx_agent_…` 出示——**body 里没有 `connectionKey`**。网关核验 PAT，从中解析出**真实的 `agentId`**（`client.agentId` 只是元数据，会被强制改写成已核验的 id——见 §4d），开启一个绑定到该 id 的会话，并返回该 agent 的**授权子集 manifest**：所有者授权给这个 agent 的 capability（授权子集 ∩ 当前已暴露，加上所有者签发的常驻授权所覆盖的条目），每个条目连同完整的 `describe`、`io` schema、`grants`、`transport`、附着的 skill 主体和 MCP 直通——条目细节完整，目录范围限定在子集。

::: info 管理员路径（不是 agent 路径）
同一端点也接受**所有者**在 JSON **body** 里出示 `{ "connectionKey": "plx_live_…" }`（无 Bearer）——这是控制台的权威路径，可以合法点名一个 `agentId`。两条路径靠出示的凭据区分，绝不互相穿透；agent 手里没有 connection-key，够不到管理员路径。
:::

**请求**（`Authorization: Bearer plx_agent_9f1a…44e`）：
```json
{
  "client": { "name": "claude-code", "version": "2.x" }
}
```
**响应（节略）：**
```json
{
  "sessionId": "sess_01J…",
  "expiresAt": "2026-06-23T11:00:00.000Z",
  "grantsUrl": "http://127.0.0.1:7077/grants",
  "manifest": {
    "gateway": { "name": "plexus", "version": "0.1.0", "protocol": "0.1", "baseUrl": "http://127.0.0.1:7077" },
    "sessionId": "sess_01J…",
    "expiresAt": "2026-06-23T11:00:00.000Z",
    "revision": 7,
    "entries": [ /* full CapabilityEntry objects — see examples/*.json */ ]
  }
}
```
此刻 agent 手里**没有任何受限 token**——只有只读的知识，零调用权威。（默认拒绝。）`manifest.revision` 是单调计数器，agent 拿它与 `manifest_changed` 事件对比，检测视图是否已过期（§2，manifest 刷新）。

### `PUT /grants` → 受限 token（按 capability）

agent（或**经管理客户端的用户**）选择允许哪些条目、在哪些动词下。每条被请求的授权都会跑一遍配置的 **`Authorizer`**（可插拔的授权接缝，ADR-007 已修订）。返回要么是覆盖已批准条目的**受限 token**，要么对被策略推迟的授权返回 **`grant_pending_user`** 通知。

::: info 权威注记（ADR-007 已修订）
授权裁决是**可插拔抽象**（`Authorizer`：输入 = 授权请求 + 上下文 → `allow | deny | pending`）。它只对该 agent **授权子集之内**的请求运行：受限（scoped）agent 请求所有者声明的子集之外的 capability，会在 Authorizer 运行之前被**直接拒绝**（记入审计轨迹，绝不挂起——不出所有者卡片），除非所有者签发的常驻授权已覆盖它；管理员权威路径（在连接时定义子集的那条流程）不受此门限制。在子集之内：**已发布的默认是 `confirm-risky` 模式的 `UserConfirmAuthorizer`：** first-party / managed 源上的只读授权自动批准，任何 **`write` / `execute`** 授权（以及 `extension` 来源上的任何授权）**挂起等所有者**——返回 `grant_pending_user`。完全宽松的 `AutoApproveAuthorizer` 也存在（部分内部 / 测试流程在用），可直接替换，但它**不是**面向 agent 的默认值。两种策略走同一条 wire——`grant_pending_user` + `GET /grants/status` 轮询通道对变更类授权默认就在生效，替换 Authorizer **无需改 wire**。
:::

**请求：**
```json
{
  "sessionId": "sess_01J…",
  "grants": {
    "obsidian.vault.read": "allow",
    "mcp.github.create_issue": { "decision": "allow", "verbs": ["write"] },
    "orchestrator.pipeline.run": { "decision": "allow", "verbs": ["execute"] }
  }
}
```
`"allow"` 简写归一化为只读默认。github 条目显式请求 `write`；orchestrator **workflow** 请求 `execute`。

**响应（已批准——注意合成出的传递性成员作用域）：**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWI…",
  "jti": "tok_01J…",
  "expiresAt": "2026-06-23T11:15:00.000Z",
  "scopes": [
    { "id": "obsidian.vault.read", "verbs": ["read"] },
    { "id": "mcp.github.create_issue", "verbs": ["write"] },
    { "id": "orchestrator.pipeline.run", "verbs": ["execute"] },
    { "id": "orchestrator.plan.create", "verbs": ["write"], "synthesizedFor": "orchestrator.pipeline.run" },
    { "id": "orchestrator.task.dispatch", "verbs": ["execute"], "synthesizedFor": "orchestrator.pipeline.run" },
    { "id": "orchestrator.plan.status", "verbs": ["read"], "synthesizedFor": "orchestrator.pipeline.run" }
  ],
  "transitive": [
    {
      "workflowId": "orchestrator.pipeline.run",
      "memberScopes": [
        { "id": "orchestrator.plan.create", "verbs": ["write"] },
        { "id": "orchestrator.task.dispatch", "verbs": ["execute"] },
        { "id": "orchestrator.plan.status", "verbs": ["read"] }
      ]
    }
  ]
}
```
**传递性授权（评审 #5，ADR-012）：** 授予 workflow 会合成成员作用域（标记 `synthesizedFor`）并写进 token，成员派发因此走同一管线做作用域检查——没有静默升级。`transitive` 块正是管理客户端在确认授权时向用户**展示**的内容（"……它也会运行 board.create / agent.dispatch / board.status"）。每个成员 id 必须是注册表里实际存在的条目。

**响应（挂起——更严格的 `Authorizer` 推迟了裁决）：**
```json
{
  "status": "grant_pending_user",
  "pendingId": "pend_01J…",
  "pending": ["orchestrator.pipeline.run"],
  "statusUrl": "http://127.0.0.1:7077/grants/status?pendingId=pend_01J…"
}
```
agent 随后轮询 `GET /grants/status`（见下）或等待 `grant_resolved` 事件。（默认的 `confirm-risky` 授权器对任何带变更动词 `write` / `execute` 的授权都会这么回——这是每个非只读 capability 的正常路径。）

### `GET /grants/status?pendingId=…` → 解析待批授权（评审 #9）

这条解析通道保证 `grant_pending_user` 不会成为死胡同。agent 轮询到 `state` 终局为止；`"approved"` 时铸出的 token 就在响应里。

**响应：**
```json
{
  "pendingId": "pend_01J…",
  "state": "approved",
  "capabilities": ["orchestrator.pipeline.run"],
  "token": {
    "token": "eyJ…",
    "jti": "tok_02K…",
    "expiresAt": "2026-06-23T11:30:00.000Z",
    "scopes": [ { "id": "orchestrator.pipeline.run", "verbs": ["execute"] } ]
  }
}
```

### `POST /grants/refresh` → 授权背书的 token 重铸（评审 #4）

token 生命期**锁定为 15 分钟**，可长时运行的多步 workflow 一跑就**超过 24 小时**。Refresh 直接从**持久授权**以**相同作用域**重铸一个新鲜的 15 分钟 token：**不要 connection-key，不重新提示**，只受该授权自身有效期约束。agent 只保留短 token + 一个 refresh 句柄，从不保留 connection-key。（长时运行流程见 §5。）

**请求**（`Authorization: Bearer <expiring-token>`）：
```json
{ "sessionId": "sess_01J…", "jti": "tok_01J…" }
```
**响应：**
```json
{
  "token": "eyJ…newtoken…",
  "jti": "tok_03L…",
  "expiresAt": "2026-06-23T11:30:00.000Z",
  "scopes": [ { "id": "orchestrator.pipeline.run", "verbs": ["execute"] } ],
  "grantExpiresAt": "2026-06-25T10:00:00.000Z"
}
```
旧 `jti` 随即被撤销；`grantExpiresAt` 一过，refresh 即失效（此时 agent 必须重新 `PUT /grants`）。前置条件：会话存活（§5）、授权在场且未撤销、在授权有效期内。

### `POST /grants/revoke` → 撤销 token 或授权（评审 #3）

由管理客户端的"立即撤销"动作触发，或由 agent 交回自己的 token。选择器有两种形态。

**请求（按 jti）：**
```json
{ "jti": "tok_01J…", "reason": "user revoked from management client" }
```
**请求（按 scope——同时移除持久授权，refresh 再也铸不出新 token）：**
```json
{ "agentId": "agent-ez-1", "capabilityId": "orchestrator.pipeline.run" }
```
**响应：**
```json
{ "ok": true, "revokedJtis": ["tok_01J…", "tok_03L…"], "grantRemoved": true, "auditId": "evt_09Z…" }
```
**执行中 workflow 的规则（评审 #3）：** 编排器在**每次成员派发之前**重新检查发起 `jti` 的撤销状态，因此扇出中途的撤销会中止其余成员（已完成的派发留在审计里，不回滚）。

### `POST /invoke` → 调用一个已授权的 capability

agent 调用一个 capability/workflow，把受限 token 作为 `Authorization: Bearer <token>` 出示。网关依次：
1. 先于一切强制 **Host/Origin** 守卫（§5）；
2. 核验 JWT 签名与过期，检查 `jti` 未被撤销**且会话仍存活**（评审 #8）；
3. 确认有作用域以条目所**需**的每一个动词覆盖该 `id`——若该作用域带 `constraint`（`ScopeConstraint`），还要确认本次调用的 `input` 满足它（`constraintSatisfied`）；否则该作用域不生效，调用被默认拒绝（`grant_required`）——见 §4 内容感知授权；
4. 对照 `io.input` 校验 `input`（**轻量**：必需键 + 顶层原语类型 + 可选启用的 `additionalProperties`——不是完整 JSON Schema；见 §1 的 schema 校验注记）；
5. 路由到拥有它的 `CapabilityBridge` → `Transport.dispatch()`（没有 `if (id===…)`——路由由注册表/transport 驱动）；
6. 写一条脱敏的审计事件；
7. 返回归一化的 `InvokeResponse`（MCP 导入的条目保留逐字 `mcpResult`——工具/资源/提示一视同仁）。

**请求**（`Authorization: Bearer eyJ…`）：
```json
{ "id": "obsidian.vault.read", "input": { "query": "Plexus protocol decisions", "limit": 5 } }
```
**响应：**
```json
{
  "id": "obsidian.vault.read",
  "ok": true,
  "output": { "notes": [ { "path": "Projects/Plexus.md", "title": "Plexus", "content": "…" } ] },
  "auditId": "evt_01J…"
}
```
**MCP 工具响应**（`transport:"mcp"`，逐字 `mcpResult`）：
```json
{
  "id": "mcp.github.create_issue",
  "ok": true,
  "mcpResult": {
    "content": [ { "type": "text", "text": "Created issue #42" } ],
    "structuredContent": { "number": 42, "url": "https://github.com/…/issues/42" }
  },
  "auditId": "evt_02K…"
}
```
MCP 服务器返回 `isError:true` 时映射为 `ok:false`、`error.code:"mcp_tool_error"`，服务器的 `content[]` 保留在 `mcpResult.content` 里。资源读取填充 `mcpResult.contents[]`；提示获取填充 `mcpResult.messages[]`。

#### `/invoke` 上的单一结果契约（v0.1.1 —— tp2 / ADR-017）

`/invoke` **总是**返回 **`InvokeResponse` 形状的 body**——成功如此，**每一次拒绝**也如此，包括 auth/派发之前的那些（无 token、`grant_required`、`token_revoked`/`token_expired`、`session_expired`、`unknown_capability`、`schema_validation_failed`）。拒绝 body 形如：

```json
{
  "id": "orchestrator.pipeline.run",
  "ok": false,
  "error": { "code": "grant_required", "message": "No grant for orchestrator.pipeline.run (execute).",
             "capabilityId": "orchestrator.pipeline.run" },
  "auditId": "evt_03L…"
}
```

因此，把每个 `/invoke` 回复都反序列化成 `InvokeResponse` 的朴素 agent，在拒绝时读到的总是 `ok:false`——绝不会是 `ok === undefined`。`error.code` 取自**封闭的 `ErrorCode` 联合类型**（§7），agent 因此能确定性地分支（refresh、re-grant、re-handshake 还是放弃）。`auditId`：被审计的拒绝给审计事件 id（每一次管线内的派发前拒绝都被审计）；在进入管线审计之前就失败的边缘拒绝（无 token / 畸形 token / body 不可解析）给空字符串 `""`。

对按状态码分支的 agent，**HTTP 状态**仍然对失败分类：

| 拒绝 `error.code` | HTTP 状态 |
|---|---|
| `grant_required`、`token_expired`、`token_revoked`、`session_expired`、`grant_pending_user`、`approval_required` | `401` |
| `host_forbidden`、`capability_unexposed` | `403` |
| `unknown_capability` | `404` |
| `schema_validation_failed` | `422` |
| `rate_limited` | `429` |
| `source_unavailable`、`capability_unavailable` | `503` |
| `mcp_tool_error`、`transport_error`（带内派发失败） | `200` |
| `internal_error`（以及任何未映射的码） | `400` |

::: info 单一形状的范围
这条"`InvokeResponse` 唯一"规则**仅限 `/invoke`**。其余端点失败时保持统一的 `ErrorResponse` 信封（`{ error:{…} }`）（§7）。`/invoke` 特殊，是因为它的成功 body 本来就是 `InvokeResponse`——把拒绝路径也塌缩成同一形状，agent 在它最常走的调用路径上就有了一个稳定契约。
:::

::: info 路由注记（workflow 与 MCP）
`kind:"workflow"` 的 invoke 路由到 `WorkflowTransport`，它经 `invokeById` 对每个成员**重入统一的 invoke 管线**——核心从不在 `kind:"workflow"` 上分支（评审 #6，§6）。每次成员调用本身都被作用域检查（对照合成作用域）+ 审计。`transport:"mcp"` 的 invoke 路由到 `McpTransport`，它按 `mcp.primitive` 分支（`tools/call` / `resources/read` / `prompts/get`），服务器的原生结果逐字保留在 `mcpResult` 里。
:::

### `GET /manifest` → 刷新 manifest 快照（评审 #9）

handshake 的 manifest 是一次性快照。条目集在会话中途变化时（MCP `list_changed`、源上线、扩展注册），agent 无需重新 handshake 就能重新取回它当前的授权子集 manifest。会话认证（如 `X-Plexus-Session: <sessionId>`）。返回 `{ manifest }`，`manifest.revision` 已推进。

### `GET /grants` → 常驻授权账本（ADR-018，v0.1.2，会话认证）

agent 侧与用户 Grants 屏对称的视图——调用方的**常驻授权**（持久的、经人批准的信任，有别于 15 分钟 token）。会话认证，与 `GET /manifest` 完全一样；管理会话会拿到全部常驻授权。经 `AuthAdvertisement.grantsListUrl` 广告。返回 `GrantsListResponse { grants: StandingGrant[] }`——形状与信任模型见 §4d。（管理 UI 走管理密钥门控的 `GET /admin/api/grants`。）

### `GET /events` → 实时事件流（SSE）（评审 #9）

一条 `PlexusEvent` 的 Server-Sent Events 流，agent 不用轮询就能得知变化：
- `manifest_changed` —— 重新取回 `GET /manifest`（携带新的 `revision`）。
- `grant_resolved` —— 某条待批授权已裁决（批准则附 token）。
- `token_revoked` —— 手上的某个 token 被撤销；立即停用。
- `source_status` —— 某个源的可用性变化（诊断）。

### `POST /extensions` → 注册一个用户扩展（评审 #次要，Flow B）

注册一个 `ExtensionManifest`；网关物化其 `CapabilitySource`，投影条目进入注册表，并触发 `manifest_changed` 事件。会话认证（注册是用户授权的动作）。

**请求：**
```json
{ "sessionId": "sess_01J…", "manifest": { "manifest": "plexus-extension/0.1", "source": "obsidian", "...": "see examples/extension-manifest.obsidian.json" } }
```
**响应：**
```json
{ "ok": true, "source": "obsidian", "registered": ["obsidian.vault.read"], "revision": 8 }
```

## §3 —— Transport 抽象

第一批（已锁定，ADR-003）：`local-rest | stdio | ipc | mcp | cli`，外加两个非 wire 哨兵 `skill` 和 `workflow`。适配器层按种类实现 `Transport` 接口；bridge 调用 `dispatch()`。**加一个 transport = 实现 + 注册；绝不改调用方。**

```ts
interface Transport {
  readonly kind: TransportKind;
  dispatch(entry, input, ctx?): Promise<TransportResult>;   // ctx present only for re-entrant transports
}
```

| kind | wire | 注记 |
|---|---|---|
| `local-rest` | HTTP，通向 app 暴露的 localhost 服务 | 如 Obsidian Local REST API。端点 + bearer 凭据经平台接缝。 |
| `stdio` | 生成子进程，stdin/stdout 上走 NDJSON | 通用的非 MCP stdio 适配器。 |
| `ipc` | unix socket / 命名管道 / osascript 桥 | OS 专属部分在平台接缝后。 |
| `mcp` | **享有特权**——Plexus 自己跑一个 MCP 客户端 | 按 `mcp.primitive` 分支；见下。 |
| `cli` | 用 argv 调用二进制，捕获 stdout（可选 `--format json`） | 二进制由 path-resolver 解析。 |
| `skill` | （无） | 哨兵——主体作为上下文交付。 |
| `workflow` | （无） | **对每个成员重入 invoke 管线**；见下。 |

### `mcp` transport，具体说（评审 #1/#2）

::: warning 状态
下面的 transport/客户端层已实现并测试，但生产（`MODULES`）里没有 MCP 源被注册，也还没有一条把一个 MCP 服务器包成一个源的已发布路径（见
[`KNOWN-LIMITATIONS.md`](https://github.com/nemori-ai/plexus/blob/main/docs/KNOWN-LIMITATIONS.md)）。
:::

`McpTransport extends Transport`。Plexus 是 **MCP 客户端**，派发**按 `entry.mcp.primitive` 分支**：

```
scan():   initialize(serverId)              // clientInfo+caps → server caps; then notifications/initialized
          list(serverId)                    // tools/list + resources/list + prompts/list — PAGED TO EXHAUSTION
          → re-project each primitive to a CapabilityEntry (schemas VERBATIM, mcp.raw kept)
invoke(): primitive "tool"     → call(serverId, originName=tool-name, args)  // tools/call
          primitive "resource" → readResource(serverId, uri=originName)      // resources/read
          primitive "prompt"   → getPrompt(serverId, name=originName, args)  // prompts/get
          → TransportResult { ok, mcpResult: { content?|contents?|messages?, structuredContent?, isError? } }  // VERBATIM
```

`isError:true` ⇒ `ok:false` + `error.code:"mcp_tool_error"`，`content[]` 保留。**持久 MCP 客户端**（由 `CapabilitySource.start()` 拥有）在请求作用域的 invoke 之间复用，会话丢失时重新初始化。MCP transport 走 **stdio** 或 **Streamable HTTP**（`/mcp`，`Mcp-Session-Id` 头），细节归实现内部。`notifications/.../list_changed` 经 `CapabilitySource.onEntriesChanged` 上报 → 向 agent 发一个 `manifest_changed` 事件。

### `workflow` transport，具体说 —— 编排器"只是一个 transport"（评审 #6）

**没有对外 wire。** `WorkflowTransport.dispatch` 接收 `TransportDispatchContext`，经 `invokeById` 对每个 `entry.members[]` **重入统一的 invoke 管线**。后果：

- 网关核心**从不**出现 `if (kind === "workflow")` 分支——扇出就是普通调用：作用域检查、审计，与任何调用同一条路。
- 每次成员派发都对照同一个 token 上携带的**合成传递性作用域**（§2 grants）检查——没有静默升级。
- **每次成员派发之前**，管线**重新检查**发起 `jti` 的撤销状态（评审 #3），扇出中途的撤销会中止其余成员。

（备选方案是把编排器建模为 first-party `CapabilitySource`；ADR-013 记录了取舍——transport 重入让成员留在完全相同的执行路径上。）

## §4 —— 受限 token 模型

**格式（ADR-006）：已签名 JWT（HS256，秘密由网关持有）+ 服务端撤销注册表。** 验证自包含（无状态签名检查），但每个 `jti` 都被追踪，授权因此可在过期前撤销。对 agent 不透明——它只出示那串紧凑的 Bearer 字符串。

- **作用域形状：** `scopes: { id, verbs[], synthesizedFor?, constraint? }[]`。token 的权威恰好等于这个并集。一次调用被允许，当且仅当有作用域以条目所需的**每一个**动词覆盖其 `id`。默认最小 + **只读**（简写 `"allow"` 授予 `["read"]`）。带 `synthesizedFor` 的作用域是 workflow 的传递性成员作用域（§2）。
- **内容感知授权（AUTHZ-UX §3.1）：** 授权不止按 capability + 动词，还感知内容：作用域/授权可携带可选的 `constraint`（`ScopeConstraint`），它只会**收窄**覆盖——本次调用的 `input` 满足约束（`constraintSatisfied`），该作用域才覆盖本次调用；之外该作用域不生效，调用被默认拒绝（`grant_required`）。被强制的约束随已签名 JWT 的 `scopes` 一起下发，在每次调用都要经过的**同一个** `POST /invoke` 收口处检查（上面第 3 步）——约束来自已核验的 token，绝不来自请求 body；输入字段缺失/畸形或操作不受支持时**失败即关闭**。不带约束 ⇒ 与今天一样的整 capability 作用域（不变）。
- **生命周期：15 分钟，锁定（ADR-006，用户决策）。** 授权持久存在授权存储里，以 `(agentId, capabilityId)` 为键；token 是廉价、可再生的视图。长任务靠 **`POST /grants/refresh`**（ADR-011）保活——从持久授权重铸，不要 connection-key、不重新提示，受授权自身有效期约束。（15 分钟 token 之所以撑得起 >24h workflow，原因就在这里——见 §5 长时运行流程。）
- **撤销（ADR-010）：** `POST /grants/revoke` 按 `jti`（单个 token）或按 `(agentId, capabilityId)`（所有携带该作用域的 token + 移除持久授权，refresh 再也铸不出新 token）。被撤销的 `jti` 即便未到 `exp`，invoke 时也被拒；workflow 在每次成员派发之前重新检查撤销（评审 #3）。
- **会话存活（评审 #8）：** invoke 还要求 token 的 `sessionId` **存活**。**agent** 会话在其 **PAT** 之下引导，与 connection-key 轮换解耦，只在该 agent 的 PAT 被撤销时才失效（`POST /admin/api/agents/revoke`，§5）。connection-key **轮换**会使**管理员/密钥引导**的会话失效，并把这些会话 token 的 jti 排队等撤销。存活检查失败 ⇒ `session_expired`。
- **审计关联：** `sub`（agent id）、`jti`（token id）、`sessionId` 贯穿每一条 `AuditEvent`，每次调用都能追溯到一个 token 和一个 agent。

### 错误码（封闭联合——评审 #10）

`ErrorResponse.error.code` 和 `InvokeResponse.error.code` 取自**封闭的 `ErrorCode` 联合类型**，agent 可以确定性地分支恢复。每个端点失败时都返回统一的 `ErrorResponse` 信封（`{ error:{…} }`）——**`POST /invoke` 除外**：自 v0.1.1（tp2 / ADR-017）起，它对所有拒绝返回 `InvokeResponse` 形状（`{ id, ok:false, error:{…}, auditId }`），让最常走的调用路径有一个结果契约（见 §2 `POST /invoke`）。两种形状下 `error.code` 与 HTTP 状态完全相同；不同的只有外层 body。

| 码 | agent 应当 |
|---|---|
| `token_expired` | `POST /grants/refresh`（或重新授权），然后重试 |
| `token_revoked` | 经 `PUT /grants` 重新请求 |
| `grant_required` | 为该 id/动词请求授权 |
| `grant_pending_user` | 轮询 `GET /grants/status` / 等待 `grant_resolved` |
| `approval_required` | `grant_pending_user` 的 invoke 时对应物——需所有者批准；带返回的 `pendingId` 轮询 `GET /grants/status` |
| `session_expired` | 重新 handshake |
| `unknown_capability` | manifest 多半已过期 → `GET /manifest` |
| `capability_unexposed` | 所有者在顶层禁用了该 capability；重新启用前不可调用 |
| `schema_validation_failed` | 对照条目的 `io.input` 修正 `input` |
| `source_unavailable` | 源/app 不可达；退避 / 上报给用户 |
| `capability_unavailable` | 该 capability 的归属方（如某个 mesh workload）当前不可用；退避后重试 |
| `mcp_tool_error` | MCP 带内错误；检视保留的 `mcpResult.content` |
| `transport_error` | transport 级失败；重试 / 上报给用户 |
| `host_forbidden` | Host/Origin 检查失败（§5） |
| `rate_limited` | 退避 |
| `internal_error` | 意外的网关故障 |

## §4d —— 统一信任模型（ADR-018，v0.1.2，加性）

授权机制一直是对的；v0.1.2 给它**命名**并把它**摆上台面**，让 UI 里的人、读协议的 agent、读 API 的开发者读到**同一套**事实。这里的一切都是冻结 wire 之上的加性改动：新的可选字段和一个新端点。`v0.1.1` 客户端可以全部忽略。

### 词汇表（每个概念一个词，处处逐字使用）

| 术语 | 含义 |
|---|---|
| **agent** | 授权**作用域**所绑定的身份（`agentId`），handshake 时由该 agent 的 **PAT** 在服务端绑定——**不是**自我断言的（见下文"信任边界与 agentId"）。稳定、经 PAT 核验的 `agentId` 让 Plexus 能跨会话记住常驻授权。没有已核验 PAT 的会话（`anon:*`）得不到**任何常驻信任**，每个会话重新询问。 |
| **capability** | 可调用的条目（`CapabilityId`）。 |
| **scope** | token 携带的一条 `(capability × verbs)`（`TokenScope`）。 |
| **grant** | 常驻的、**经人批准**的授权 `(agentId, capabilityId, verbs)`：此 agent 可以在这些动词下使用此 capability，直到信任窗口结束（`StandingGrant`）。 |
| **trust-window** | 一条授权在需要重新批准前**常驻**多久——由人*裁决*的生命期（`TrustWindow`）。 |
| **token** | 授权的短命（约 15 分钟）自动刷新**视图**；`/invoke` 上出示的就是它（`ScopedToken`）。 |
| **provenance / source-class** | capability 从何而来：`first-party` / `managed` / `extension`（`Provenance`）。 |
| **sensitivity** | 用于叙述的派生风险层级：`low` / `elevated` / `high`（`Sensitivity`）。 |

### 两个时钟

两个不同的生命期，终于放在一起命名：

| 时钟 | 它约束什么 | 值 | 谁在意 |
|---|---|---|---|
| **token-lifetime** | 泄露凭据的爆炸半径 | 约 15 分钟，自动刷新（`ScopedToken.expiresAt`） | 安全不变量——刻意设短；钳制在 `[1min, 60min]`，绝不随批准变化、绝不由 agent 选 |
| **trust-window** | 人的批准在 Plexus 重新询问前常驻多久 | 按 source-class × 动词（见下）；`StandingGrant.expiresAt` / `ScopedToken.grantExpiresAt` | 用户可读的真相；由 agent 转述 |

两者都可在 `~/.plexus/auth-config.json` 里配置（`tokenLifetimeMs` 钳制在 `[60000, 3600000]`；`maxTrustWindowMs` 把 **`custom`** 时长封顶在 30 天——`until-revoked` 哨兵不受它钳制）。

### 信任边界与 agentId

Plexus 有**两条**信任边界，分别由两方持有：

- **connection-key**（`plx_live_…`）是**管理员**边界。所有者以管理员身份持有它；它认证 `/admin` 控制台和 handshake 的管理员路径。轮换它会撤销一切由密钥引导的东西。**agent 永不见到它。**
- 每个 **agent** 用**自己那份按 agent 独立的 PAT**（`plx_agent_…`）认证。PAT 是 agent 的会话引导秘密，也是它的身份：handshake 时网关从 PAT 解析出**真实的 `agentId`** 并把会话绑定到它，覆盖任何 `client.agentId`（仅元数据）。客户端因此**无法把自己断言成**另一个 agent——不带 PAT 而点名一个 agent，只会拿到 401，没有会话。按 agent 身份是**已发布**的能力，不是推迟项。

`agentId` 经 PAT 核验，常驻授权因此能安全地按 agent 限定作用域：一份泄露的 PAT 只连带那一个 agent 的授权，撤销一个 agent（`POST /admin/api/agents/revoke`）不触碰其余任何 agent——不像共享密钥，一轮换就切断所有人。**管理员路径仍可点名一个 `agentId`**（控制台的"连接一个 agent"正是如此）：那不算伪冒，持有 connection-key *就是*管理员权威。剩下的推迟加固是**密钥对（持有证明）PAT**——v1 用 bearer PAT；身份本身没有推迟。

### 3 类来源 + 姿态表

是否具备常驻资格由**敏感度（provenance × verb）**决定，而非来源本身（ADR-5）。下表的默认信任窗口是每类 read/write/**execute** 的天花板：

| provenance | 含义 | read 姿态 | write 姿态 | execute 姿态 | 默认窗口（read / write / execute） |
|---|---|---|---|---|---|
| **first-party** | 保留/进程内源（claudecode、obsidian(fs)、mock） | **自动放行** | 挂起 | 挂起 | 7d / 1d / **once** |
| **managed** | 用户经受信管理 UI 添加的源（添加时经人审核） | **自动放行**（与 first-party 同读姿态） | 挂起 | 挂起 | 7d / 1d / **once** |
| **extension** | 由 agent 经 `POST /extensions` 在 wire 上注册（最严格的一类） | **挂起** | 挂起 | 挂起 | 1d / 1d / **once** |

- **`execute` 默认逐次（ADR-5，经 ADR-023 放宽为所有者可解除）。** 任何 `execute` capability——无论 first-party、managed 还是 extension——默认**逐次**批准（`once`），agent 自己永远无法解除：未经所有者开启时，`chooseTrustWindow` 守住 `once` 下限，**不论请求什么窗口、不论这次选择有没有管理员权威**。**所有者**可在连接时为特定 (agent, capability) 开启**常驻 execute 授权**（默认关闭、双重确认）；开启之后，该授权遵循管理员的权威窗口，或常驻到撤销为止（`until-revoked` 被策略禁用时钳到 `7d`）。
- 自动放行的读**绝不静默**：它们照样带着信任窗口出现在常驻授权账本里。
- 针对 `(agentId, capabilityId)` 的**常驻、未过期**授权，对它覆盖的动词短路重新询问。`once` 授权（`standing:false`、`expiresAt = grantedAt`）单次使用，**绝不**短路。
- `until-revoked` 存在（远期哨兵；只有显式撤销能结束它），但**绝不是默认值**；自定义时长封顶 30 天。
- `anon:*` 会话（无已核验 PAT）仅限当次会话：绝不在匿名 id 下持久化常驻（跨会话）授权（上限锁在 `once`）。

### 新端点 —— `GET /grants`（会话认证）

返回调用方的常驻授权账本——agent 侧与用户 Grants 屏对称的视图。会话认证，与 `GET /manifest` 完全一样；管理会话会拿到全部常驻授权。经 `AuthAdvertisement.grantsListUrl` 广告。（管理 UI 走管理密钥门控的 `GET /admin/api/grants`。）

```
GET /grants                       → GrantsListResponse { grants: StandingGrant[] }
```

`StandingGrant = { agentId, capabilityId, verbs[], provenance, sensitivity?, grantedAt, expiresAt, trustWindow, standing, synthesizedFor?, constraint?, bundleId?, topLevelDisabled? }`——其中 `expiresAt` 是信任窗口的结束（用户可读的真相），`standing:false` 标记不可续的 `once` 授权。持久化的 `constraint`（`ScopeConstraint`）是该授权获批时所附的内容感知收窄（refresh 重铸出的 token 携带**相同**的被强制约束；不带 ⇒ 无约束的整 capability 授权）；`bundleId` 标记命名 Mode-2 任务捆绑的成员（捆绑只是分组，不赋予成员之外的任何权威）；`topLevelDisabled:true` 标记其 capability 当前在"我暴露什么"顶层被禁用的授权（记录仍在，但该 capability 在重新启用前不可见、不可调用——有效访问 = 已授权 ∧ 已暴露）。

### 加性可选字段（每个改动都非破坏性）

| 类型 | 新增的可选字段 | 目的 |
|---|---|---|
| `CapabilityEntry`、`CapabilitySummary` | `provenance`、`sensitivity`、`recommendedTrustWindow` | agent 能在请求*之前*说清代价（省略 ⇒ 按 `extension` 处理） |
| `GrantDecision` | `trustWindow`、`purpose`、`constraint` | 请求方提议的窗口——agent 路径上**仅供建议**（可被缩短，绝不能超出按类别天花板去延长），管理员批准路径上**权威**；`purpose` 是 agent 自由文本的 WHY（仅为**透明**——不影响任何裁决；单独渲染为"agent 说："，封顶 280 字符）；`constraint`（`ScopeConstraint`）是要附加的内容感知收窄（**只收窄**；铸造到 `TokenScope.constraint` 上） |
| `GrantPendingResponse`、`GrantStatusResponse` | `pendingNarration[]` | 网关撰写的 `{ id, verbs, provenance, sensitivity, defaultTrustWindow, summary, notificationLine? }`，每个 agent 转述的都是**同一行**真实文案；`notificationLine` 是约 120 字符、网关撰写的托盘/通知形式（web 忽略它） |
| `GrantRequest` | `bundle` | Mode-2 任务捆绑信封 `{ name, agentId?, context? }`——多 capability（+约束）请求被当作一个命名捆绑（成员共享 `bundleId`，有风险的成员作为一组 Approve 挂起）；捆绑不增加新权威 |
| `StandingGrant` | `constraint`、`bundleId`、`topLevelDisabled` | 持久化的已批准约束（refresh 时重铸）；任务捆绑标记；"已授予但被禁用（不可见）"的暴露标志 |
| `TokenScope` | `constraint` | 随已签名 JWT scopes 下发、invoke 时检查（`constraintSatisfied`）的被强制作用域约束 |
| `BundleView`、`GrantContextRef` | （新类型） | 管理 Grants 视图的捆绑投影（`GET /admin/api/bundles`），以及对一段限定作用域任务上下文的引用（复用 `kind:"skill"` 机制——`skill` 引用或封顶的 `inline` markdown；没有新 transport） |
| `CapabilityEntry`、`CapabilitySummary` | `health` | 继承的按源健康**快照**（HEALTH；见下） |
| `ScopedToken` | `grantExpiresAt`、`trustWindow` | 紧挨 15 分钟 `expiresAt` 的信任窗口天花板 |
| `ScopedTokenClaims` | `gexp` | 授权/信任窗口过期纪元（诊断） |
| `AuthAdvertisement` | `grantsListUrl` | `GET /grants` 的地址 |
| `AuthorizationDecision` | `provenance`、`sensitivity`、`recommendedTrustWindow` | 结构化原因，服务无需重新派生即可构建 `pendingNarration` |

**Health（HEALTH）。** capability 携带健康状态（`CapabilityHealth` / `HealthStatus`：`ok` | `degraded` | `unavailable` | `unknown`），agent 读到可用性即可优雅降级。快照按源计算（来自源的可选 `health()` 方法，缺席时退回它的 `checkRequirements()`——只有 `health()` 能报 `degraded`），继承到该源的每个 `CapabilityEntry.health` / `CapabilitySummary.health` 上，序列化时从网关的短 TTL 健康缓存打戳。仅供参考。

**敏感度派生**（由网关计算，所有界面一致）：`low` = first-party/managed 上的读；`elevated` = first-party/managed 上的 write/exec，或 extension 上的读；`high` = extension 上的 write/exec，或任何带 write/exec 的 cli/local-rest transport。workflow 上卷成员的敏感度（取最大）。

## §5 —— 安全模型

- **绑定：** **默认**回环（`127.0.0.1`）。经 `~/.plexus/network.json` 绑定选定的 NIC 或 `0.0.0.0` 属**可选启用**；一旦启用，**每一条** `/admin/api/*` 路由都由 **connection-key 门控**——connection-key 就是 LAN 的信任边界。（下面的 Host/Origin 守卫不论绑定如何，都在每个端点上先于 auth 运行。）
- **Host/Origin 守卫（评审 #7，ADR-016）：** 仅回环绑定既拦不住其他本地进程，也拦不住 **DNS 重绑定浏览器攻击**（恶意页面把某个主机名解析到 127.0.0.1，再向 `/invoke` POST）。每个端点都在 auth **之前**强制 `HostOriginPolicy`：`Host` 头**必须**等于绑定的回环权威（`127.0.0.1:<port>` / `localhost:<port>`）；`Origin` 在场时（浏览器情境）**必须**在 `allowedOrigins` 里（默认只有管理客户端的来源；agent CLI 不发 Origin）。失败 ⇒ `host_forbidden`。
- **`.well-known` 指纹暴露（已接受的风险）：** 这份未认证的发现文档向任何本地调用方暴露网关身份/版本 + 生命周期/auth 端点公示。这是预会话发现（MCP 缺的那块）的代价，且暴露面恰好止于此：capability 列表——哪怕是摘要——在验明身份之前不可枚举（授权子集模型取代了旧的 ADR-008 摘要边界）；capability 只经 PAT 门控的 handshake（已 enroll agent 的 `Bearer plx_agent_…`）交付，且限定在该 agent 的所有者授权子集内。
- **两份凭据，绝不混淆：**
  - **connection-key**（`plx_live_…`）——**管理员**凭据与信任边界。由网关生成，只在本地管理客户端展示，带外获得；门控 `/admin/api/*` 和 handshake 的管理员路径。**agent 永不见到、永不出示它。** 可按需或自动轮换；轮换使管理员/密钥引导的会话失效，**并把这些会话 token 的 jti 排队等撤销**（评审 #8）。
  - **按 agent 独立的 PAT**（`plx_agent_…`）——**agent** 自己的持久凭据和会话引导秘密（**不是**调用权威）。在 `POST /agents/enroll` 用一次性 enroll 码（`plx_enroll_…`，约 15 分钟，单次使用）兑换**一次**得来，由 agent 以 `0600` 存放，静态哈希，可按 agent 单独撤销（`POST /admin/api/agents/revoke`）。它认证每一次 handshake；泄露的 PAT 只连带那一个 agent 的授权。
- **默认拒绝、默认只读：** 没有显式授权，任何条目都不可调用；简写 allow 只授予 read；`write`/`execute` 必须点名。
- **可插拔的授权权威（ADR-007 已修订）：** 授权裁决走可插拔的 `Authorizer` 接缝（`allow | deny | pending`）。**已发布的默认是 `UserConfirmAuthorizer`（`confirm-risky`）：** 读自动批准，`write` / `execute` 经 `grant_pending_user` 挂起等所有者。宽松的 `AutoApproveAuthorizer` 也存在（内部 / 测试），可直接替换，wire 不变。契约是这条接缝本身，而不是某一种具体 UX。
- **按 capability + 按会话执行：** 每一次 `/invoke` 都对照条目所需动词重新检查作用域覆盖、会话存活、`jti` 未撤销——按调用检查，不是按会话。
- **审计日志 + 脱敏契约（评审 #次要，ADR-009 修订）：** `~/.plexus/audit/` 之下的追加式 JSONL（按日轮换）。每条 `AuditEvent` 记录类型、`agentId`/`sub`、`jti`、`sessionId`、`capabilityId`、`verbs`、`outcome` 和 `detail`。脱敏是**契约**（`AuditRedactionPolicy`）：唯一的写入者在持久化前从 `detail` 里擦掉原始调用 `input`、token 字符串、connection-key 和已解析的秘密——`forbidRawInput` 是被强制的，不只是愿景。默认保留 90 天。单一写入路径防止漂移。
- **本地优先状态：** 所有网关状态都在 `~/.plexus/` 之下（授权存储、审计、源注册表、connection-key，**`~/.plexus/secrets/` 之下的秘密**经平台接缝解析）；用户 cwd 里没有指针文件。

### 连接一个 agent —— 已发布的界面（管理员 → agent → 调用）

两凭据模型由三个已发布界面加一个编译出的 agent 界面落地。管理员操作一次，agent 跑一条命令，然后就能调用 capability。

1. **管理员连接 agent** —— 控制台向导，或 `POST /admin/api/agents/connect`（connection-key 门控）。这一步**命名**该 agent，把选中的 cap 集合声明为它的**授权子集**，把其中的 **read** 作为**常驻**授权授予它（人的批准，做一次；选中的 **write** / **execute** 保持逐次——每次调用挂起——除非为那一项设置按 capability 的 `standing` opt-in），并铸出一枚**一次性 enroll 码**（`plx_enroll_…`）。
2. **agent 跑一键安装** —— `GET /integration/:agentId` 提供可复制的安装命令（管理门控）；命令调用的自包含、无秘密 **`install.sh`** 是公开的。运行后它在 `POST /agents/enroll` 兑换该码 → 以 `0600` 存放 PAT → 删除该码，并落地编译出的 Claude Code plugin。
3. **agent 调用 capability** —— 经它捆绑的 launcher（见下）。

**agent 界面——编译出的 plugin + 按 agent 的 launcher。** plugin 发布一个**按版本隔离的 launcher `plexus-<agentId>`**，它 exec **自己**捆绑的引擎（同级的 `bin/plexus`）并绑定 `PLEXUS_AGENT_ID`——不是全局 `plexus`，两个 agent 的 plugin 因此不会冲突，也不会认证成错误的 agent。子命令：

```
plexus-<agentId> enroll <code>       # once, at install: redeem code → store PAT
plexus-<agentId> list                # discover: callable-now vs needs-approval
plexus-<agentId> <capabilityId> …    # invoke a granted capability
```

**捆绑的 skill** 是对那个始终在场、自描述的 Floor（`.well-known` + `requestShapes` + 如何使用）的一层投影；过期的 skill 永远越不过 Floor 的实时授权。**承重规则：** launcher 命令是 agent **完整且唯一**的界面——绝不手搓 HTTP，绝不手动调 enroll/handshake/manifest，绝不猜 auth。执行 enroll → handshake → grant → invoke 链路的引擎（`bin/plexus`）在构建时对照已提交的受认可引擎做逐字节校验；没有任何 auth 路径出自 LLM 之手。（agent 侧视图见[面向 Agent](/zh/agents/)。）

**持久性。** 已注册的扩展及其投影条目**在网关重启后仍在**——重启时 Plexus 信任已持久化的配置，直接引导，不重新提示（全新注册仍会挂起等人批准；§4d 的暴露/授权记录同样存活）。

### 完整流程 —— >24h 的 workflow 编排，跑在 15 分钟 token 上

1. agent handshake，对 `orchestrator.pipeline.run`（`execute`）`PUT /grants`。token 同时携带**合成成员作用域**（board.create / agent.dispatch / board.status），经 `transitive` 块展示给用户。
2. agent 对该 workflow `POST /invoke` → `WorkflowTransport` 经 `invokeById` 向成员扇出，每个成员都被作用域检查 + 审计，撤销按成员重查。
3. 15 分钟 token 逼近 `exp`。agent 带 `jti` + 会话调用 `POST /grants/refresh` → 一个新鲜的 15 分钟 token，**不要 connection-key，不重新提示**，受 `grantExpiresAt` 约束。>24h 的运行里如此循环。
4. 运行中途某个源新增 capability → `manifest_changed` SSE 事件 → agent `GET /manifest` 刷新。用户从管理客户端撤销 → `token_revoked` 事件 + workflow 在下一次成员派发前中止。

::: warning ADR-5 / ADR-023 告诫
`orchestrator.pipeline.run` 是 `execute` capability，授权因此默认逐次（`once`）——上面的 refresh 循环本身不能读成 `execute` cap 搭着常驻窗口。靠 refresh 续命是**具备常驻资格**的作用域（信任窗口内的 `read`/`write`，如 `board.status` 这个读成员）的模式；默认情况下 `execute` 批准只覆盖它单次获准的调用，重新调用 workflow 会重新提示所有者。**所有者**可在连接时为特定 agent + capability 开启常驻 execute 授权（ADR-023：默认关闭、双重确认）——只有那时 `execute` 授权才搭上真实的信任窗口。见 §4d 与[安全模型](/zh/architecture/security-model) §3。
:::

## §6 —— 适配器层架构

两层，镜像 pneuma-skills。适配器类型**藏在**这些接口之后；核心从不在源/transport 类型上分支。

- **生命周期层 —— `CapabilitySource`**（≈ pneuma `AgentBackend` + `BackendModule`）：`checkRequirements()`（经平台接缝的廉价可用性探测）、`scan()`（枚举/投影条目——对 MCP 是跑客户端 handshake + list **分页取完为止** + 重投影；对暴露 `kind:"workflow"` 条目的源，`scan()` 返回 workflow 及其成员条目，传递性授权才有真实目标——评审 #次要，Flow A）、`start()`（在源的生命期内拥有**持久 MCP 客户端**）、`stop()`、可选的 `onEntriesChanged()`（MCP `list_changed`），以及可选的 **`install()`**——一等的、**经用户确认 + 被审计**（`source.install`）的动作，取代旧的、核心从不读的 `extras.autoInstall` blob（评审 #次要，Flow A）。
- **按会话的协议翻译层 —— `CapabilityBridge`**（≈ pneuma `BridgeBackend`）：每（会话 × 源）一个实例，闭包在自己的适配器上，适配器类型因此保持私有。`getCapabilities()`、`invoke(req, ctx)`、`route() → "handled" | "unsupported" | "passthrough"`、`disconnect()`。网关在调用 `invoke()` **之前**强制授权；bridge 翻译到 transport、归一化结果，且**必须**发出审计事件。`BridgeDeps` 现在携带 **`audit`**（抹平适配器 deps 的不对称——源也能审计 `source_unavailable`，评审 #次要）和 **`invokeById`**（`workflow` transport 借以扇出的重入管线——评审 #6）。

### 中央注册表（无分散的分支）

每个源从 `sources/<id>/manifest.ts` 发布一个 `SourceModule`。`SourceRegistry` 是聚合模块的**唯一**地方（≈ pneuma `backends/index.ts: MODULES`）。所有调用方都走 `registry.get(id)` / `registry.getTransport(kind)` / `registry.all()`——**源模块之外没有任何 `if (id === ...)`。** 加一个源 = 写一个 manifest，加进注册表映射。之后发现、可用性、扫描、invoke 路由全部自动打通。

### 平台抽象接缝

一切 OS 专属的东西——二进制发现、进程生成、本地服务定位、**秘密解析**——都住在 `PlatformServices`（`resolveBinary`、`getEnrichedPath`、`locateLocalService`、`spawnProcess`、**`resolveSecret`**）之后。**macOS** 是首要、经端到端验证的实现；**Windows 与 Linux** 对同一条接缝的实现今天已随发行版发布，按运行时平台自动选择（Linux 带一份可移植 first-party 源白名单），真实 OS 上的端到端验证仍待补齐。复用 pneuma `path-resolver`（登录 shell PATH 捕获 + 回退候选目录）。核心 + 适配器**只**依赖这个接口——没有 `process.platform` 检查漏进核心。`resolveSecret` 是给需要 auth 的本地服务（如 Obsidian Local REST API 的 bearer 密钥，评审 #次要）用的凭据路径：秘密住在 `~/.plexus/secrets/` 之下，经 `ExtensionSecretRef` 按名引用，只在派发时交给拥有它的 transport，绝不进核心 / manifest / 审计。

### 可选的日后输出：MCP-服务器 façade

这份契约的形状允许未来加一个 **MCP-服务器 façade 输出适配器**，把 Plexus 的子集重新发射成一个正常的 MCP 服务器，供纯 MCP 客户端使用。`mcp.raw` 字段逐字保留每个导入的工具，可精确重投影；用户扩展/workflow 条目向下投影为 MCP 工具（只丢掉 MCP 承载不了的加性 skill/授权层）。**为其设计，但 M0 未内建。**

## 附录 —— 文件地图

- [`VERSION`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/VERSION) —— 契约版本标签（`0.1.3`）。
- [`types.ts`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/types.ts) —— 规范 TypeScript 类型（事实源）。
- [`examples/obsidian.vault.read.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/obsidian.vault.read.json) —— 用户扩展，只读。
- [`examples/orchestrator.pipeline.run.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/orchestrator.pipeline.run.json) —— first-party workflow 条目，execute，`WorkflowMember[]` 成员。
- [`examples/mcp-tool-passthrough.github.create_issue.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/mcp-tool-passthrough.github.create_issue.json) —— 导入的 MCP 工具，逐字直通。
- [`examples/extension-manifest.obsidian.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/extension-manifest.obsidian.json) —— 极简用户扩展 manifest（Flow B 注册路径）。
- [决策记录](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/DECISIONS.md) —— ADR（M0 v0.1.3）。
