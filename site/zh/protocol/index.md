---
title: Plexus 协议
description: M0 线路契约（v0.1.3）——那个稳定、AI 原生的 DISCOVER → ENROLL → HANDSHAKE → GRANT → INVOKE 界面、它的端点、受限令牌模型，以及统一信任模型。
---

# Plexus 协议 —— M0 契约规范

::: tip 状态
**M0 契约 `v0.1.3`** · 协议**族** `0.1`（`config.ts` 导出的 major.minor——加性、补丁兼容）· 确切**版本** `0.1.3` · 规范常量：`PLEXUS_PROTOCOL_VERSION = "0.1.3"`（见
[`VERSION`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/VERSION)）。线路广告的是族 `"0.1"`（一个 `0.1.x` 客户端跨补丁 bump 互操作）；`0.1.3` 是确切的契约修订。

**两凭据 + execute 永不常驻（ADR-4 / ADR-5 —— 已发布的 auth 模型）：** 一个 agent 用**自己那份持久的、按 agent 独立的 PAT**（`plx_agent_…`）认证，该 PAT 从一次性**登记码**（`plx_enroll_…`）兑换一次得来；**connection-key**（`plx_live_…`）**仅**是**管理/管理员**凭据，agent 永不看见它。agent 循环增加了一个 **ENROLL** 步骤（`POST /agents/enroll`），且 handshake 对 agent 是 **PAT 门控**的。**ADR-5：** 一个 `execute`（高敏感度）capability **永远不能**常驻——它逐次批准（`once` 天花板），即便在一个管理员信任窗口下也不行。权威模型是[安全模型](/zh/architecture/security-model)；本文是那个符合它的线路契约。

这是**核心资产**，也是一切据以打字的契约。整个 Plexus 代码库都据以
[`types.ts`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/types.ts)
里的规范定义打字。本文档是那个人类可读的契约；`types.ts` 是机器的真相来源。ADR 见[决策记录](/zh/protocol/decisions)。
:::

Plexus 是一个用户安装、开源的**本地 capability 网关**。它暴露一个稳定、AI 原生的自描述端点，好让任何 AI agent 都能 **DISCOVER → ENROLL → HANDSHAKE → be GRANTED → INVOKE** 用户机器上软件的各项 capability。一个 agent 登记一次（用一个一次性码兑换它自己那份持久的 PAT），此后每个会话都在那个 PAT 下 handshake——它从不持有所有者的 connection-key。

**框定（已锁定）：** *"MCP = 我有哪些函数；Plexus = 你该如何使用我。"* MCP 是那个一等的、**享有特权的摄取 transport**（`transport: "mcp"`）；MCP 工具/资源/提示的 JSON Schema **逐字**通过。那个附加层——预会话的 `.well-known` 自描述、捆绑的**使用 Skill**、用户定义的**扩展**、**按 capability 的受限 grants/令牌**——住在 MCP 线路**之上**。

::: warning 状态（MCP 摄取）
MCP transport/客户端层已实现并测试，但那个面向用户的"把一个 MCP 服务器包成一个源"路径**尚未发布**——生产注册表（`MODULES`）里没有 MCP 源模块。今天你经 first-party 源或通过编写一个扩展来暴露 capability。本规范中通篇的 MCP 设计是那个已锁定的方向和传输契约，而非一条可用的终端用户路径（见
[`KNOWN-LIMITATIONS.md`](https://github.com/nemori-ai/plexus/blob/main/docs/KNOWN-LIMITATIONS.md)）。
:::

## §7（先读）—— 四项 Plexus 工作与数据流

Plexus 做四件事；本规范里的一切都服务于其中之一。

1. **Scan** —— 探测机器上已安装的、可适配的 capability 源（first-party 适配器、MCP 服务器、用户扩展）。二进制/端点发现走平台缝（登录 shell 的 PATH 捕获 + 回退候选目录，复用自 pneuma `path-resolver`）。
2. **Adapt** —— 每个源前面挡着一个适配器（`CapabilitySource` + `CapabilityBridge`），它把源的原生协议翻译进那个统一条目模型。适配器类型对核心是一个**黑盒**。
3. **Describe** —— 每一个 capability、skill 和 workflow 都注册为一个**同构自描述条目**（`CapabilityEntry`），以 `kind` 判别。这是核心：agent 读"卡片"就知道是什么/怎么用。
4. **Expose** —— 一个环回端点界面（`.well-known` → handshake → grants → invoke）。它背后是谁被隐藏了。

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

**关键不变量：** 客户端永远只与一个稳定的端点界面对话。Scan / adapt / 协议翻译全都密封在 Plexus 进程内部——既是工程解耦，也是合规边界。（图示展示了五步 agent 循环；ENROLL 每个 agent 只跑**一次**——之后每个会话都用存好的 PAT 从 HANDSHAKE 开始。完整端点集合再加上生命周期端点 `/grants/refresh`、`/grants/revoke`、`/grants/status`、`/manifest`、`/events`、`/extensions`——全都在 `.well-known` 里广告，见 §2。）

## §1 —— 统一自描述条目模型

`capability` / `skill` / `workflow` 是以一个 `kind` 字段判别的**同构**条目，因此一个 agent 用一个循环发现全部三者、在一个界面上授权它们、并（对 capability/workflow）经一条路径调用它们。

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
| `skills` | 附着的使用 Skill 引用（那个加性的"如何使用"层）。 |
| `members` | （仅 workflow）有序的 `WorkflowMember[]`（`{id, verbs}`）；每个 id 必须是一个在场的注册表条目。驱动传递性授权（§4）。 |
| `body` | （仅 skill）内联或按引用的 markdown 使用指引。 |
| `mcp` | （仅 mcp）逐字的 MCP 来源——`serverId`、`protocolVersion`、`primitive`、`originName`、以及 `raw`（那个未改动的原始 MCP 对象）。 |
| `version`、`extras` | 元数据；`extras` 从不被核心路由读取。 |

### 三个种类

- **`capability`** —— 一个可直接调用的函数或数据访问。叶子单元。一个被摄取的 **MCP 工具**恰好投影成这个。
- **`skill`** —— 面向 agent 的**使用知识**（"如何用好我"：可用范例、坑、约定）。**这是 MCP 没有的那一层。** 可被发现，但读作上下文（它的 `transport` 是 `"skill"`，不被调用）。
- **`workflow`** —— 一个用户/first-party 对多个 capability 的编排，暴露为一个更高层的 capability。像 capability 一样被调用；内部沿 `members` 扇出。

### 一个被摄取的 MCP 工具如何映射到一个条目

::: warning 状态
Transport/客户端层存在并已测试；那个面向用户的"把一个 MCP 服务器包成一个源"路径**尚未发布**（生产注册表里无 MCP 源模块）。下面的投影是这个 transport 将使用的契约（见
[`KNOWN-LIMITATIONS.md`](https://github.com/nemori-ai/plexus/blob/main/docs/KNOWN-LIMITATIONS.md)）。
:::

MCP 发现是**仅会话内**的——不存在未认证的 MCP manifest。Plexus 在 `scan()` 期间对每个 MCP 源运行一个 **MCP 客户端**（`initialize → tools/list → resources/list → prompts/list`），并把每个原语**投影**成一个 `CapabilityEntry`：

| MCP | → Plexus 条目字段 |
|---|---|
| Tool `name` | `mcp.originName`（并为 `id` 播种为 `mcp.<server>.<name>`） |
| Tool `description` | 为 `describe` 播种（可被一个附着技能丰富） |
| Tool `inputSchema` | `io.input` **逐字** |
| Tool `outputSchema` | `io.output` **逐字** |
| Tool 注解（`readOnlyHint` 等） | 影响 `grants`（read 对 write） |
| 整个 Tool JSON | `mcp.raw`（未改动，用于重投影 + façade） |
| Resource | `kind:"capability"`、`mcp.primitive:"resource"`、只读；`mcp.originName` = 资源 **URI** |
| Prompt | `kind:"skill"` 或 capability 种子、`mcp.primitive:"prompt"`；`mcp.originName` = 提示 **name** |

**资源与提示是一等的（评审 #1/#2）。** 它们并非只有工具：`mcp` transport **在 `mcp.primitive` 上分支**——一个工具经 `tools/call` 派发，一个资源经 `resources/read`（参数 `uri`），一个提示经 `prompts/get`（参数 name + args）。每一个都把它的原生形状返回进响应上那个**逐字 `McpResult`** 槽——工具用 `content[]`+`structuredContent`（+`isError`），资源用 `contents[]`，提示用 `messages[]`——因此每个原语都无损往返（这取代了旧的仅工具 `mcpContent`）。`*/list` 分页到穷尽，好让大服务器不被截断。

Plexus **只做包装**；它从不重写一个被摄取的 schema。见可用范例
[`mcp-tool-passthrough.github.create_issue.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/mcp-tool-passthrough.github.create_issue.json)。

::: info Schema 校验注记（评审 #10）
"逐字直通"意味着 JSON Schema 原封不动地骑到 manifest/agent——它**不**意味着 `/invoke` 完全强制它。运行时 invoke 只做**轻量校验**：必需键在场 + 每个顶层属性的原语类型 + 可选启用的 `additionalProperties` 拒绝。嵌套对象、`$ref`、`format` 和联合 schema 在 invoke 时**不被**强制；逐字 schema 是 agent/manifest 的指引，而非一道完整的 JSON-Schema invoke 门。
:::

### 一个用户扩展如何产出**相同**的形状

一个用户扩展声明一个 `ExtensionManifest`（`types.ts §1b`），列出它贡献的 capability；网关物化出一个 `CapabilitySource`，其 `scan()` 把每个声明投影进那个完全相同的 `CapabilityEntry` 形状（"一句话打开一个 Obsidian vault"流程会生成一个）。它经 `POST /extensions`（§2）注册——让 **Flow B 端到端可演示**。agent 分辨不出——也不必分辨——一个 first-party 适配器、一个被摄取的 MCP 工具、一个用户扩展：三者都只是条目。**定制即扩展；扩展被自动发现。** 本地服务凭据（如 Obsidian Local REST API 的 bearer 密钥）被声明为一个 `ExtensionSecretRef`，在派发时经平台缝（`PlatformServices.resolveSecret`）从 `~/.plexus/secrets/` 解析——从不携带在条目、manifest、`.well-known` 或审计里。见
[`extension-manifest.obsidian.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/extension-manifest.obsidian.json)。

可用范例：
[`obsidian.vault.read.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/obsidian.vault.read.json)
（一个用户扩展，`kind:"capability"`、`transport:"local-rest"`、只读）和
[`cc-master.orchestration.run.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/cc-master.orchestration.run.json)
（一个 first-party 编排，`kind:"workflow"`、`transport:"workflow"`、`grants:["execute"]`，带 `members`）。

## §2 —— 端点契约

所有端点默认服务在环回绑定上（默认 `http://127.0.0.1:7077`）；经 `~/.plexus/network.json` 绑定一个选定的 NIC 或 `0.0.0.0` 是可选启用的，以 connection-key 作为 LAN 信任边界（见 §5）。错误使用统一的 `ErrorResponse` 信封。

### `GET /.well-known/plexus` → 发现（未认证、预会话）

那个 **MCP 刻意缺失**的、预会话、未认证的广告。返回一个 `WellKnownDocument`：网关身份、一个**摘要** capability 列表（足以橱窗浏览，不足以调用——无完整 schema，无技能主体）、以及 auth 形状。

**响应（示例）：**
```json
{
  "gateway": {
    "name": "plexus", "version": "0.1.0", "protocol": "0.1",
    "baseUrl": "http://127.0.0.1:7077", "instance": "ez-macbook"
  },
  "capabilities": [
    { "id": "obsidian.vault.read", "source": "obsidian", "kind": "capability",
      "label": "Read Obsidian notes",
      "summary": "Read Markdown from a local Obsidian vault by path or search.",
      "grants": ["read"], "transport": "local-rest",
      "provenance": "first-party", "sensitivity": "low",
      "recommendedTrustWindow": { "kind": "7d" } },
    { "id": "cc-master.orchestration.run", "source": "cc-master", "kind": "workflow",
      "label": "Run a long-horizon orchestration",
      "summary": "Build a task DAG and dispatch parallel agents toward a goal.",
      "grants": ["execute"], "transport": "workflow" },
    { "id": "mcp.github.create_issue", "source": "mcp:github", "kind": "capability",
      "label": "Create a GitHub issue",
      "summary": "Create a new issue in a GitHub repository.",
      "grants": ["write"], "transport": "mcp" }
  ],
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
    "tokenScheme": "plexus-scoped-jwt"
  }
}
```

`auth` 块是自描述的：一个已兑换其码并存好其 PAT 的冷启动 agent 直接从这里读 `handshakeUrl`（呈现一个 `Bearer plx_agent_…`）、`grantRequestUrl` + `grantRequestMethod`、以及 `sessionHeader`——它从不硬编码路径或猜测 auth 方案。`enrollment` 描述那个一次性码 → PAT 兑换（见下）。这里**没有** `connectionKey` 字段，也没有 `connectionKeyDelivery`：connection-key 是所有者的管理员凭据，从不向 agent 广告或被 agent 持有（§5）。

::: info 端点命名空间约定（ADR-016）
agent 从这个 `auth` 广告里读每一个端点 URL，而非硬编码路径。agent 平面的端点住在扁平命名空间 `/agents/enroll`（预会话、码门控）、`/link/handshake`（PAT 门控）、`/grants`、`/grants/refresh`、`/grants/revoke`、`/grants/status`、`/invoke`、`/manifest`、`/events`、`/extensions` 之下。所有者的管理平面住在一个单独的 `/admin/api/*` 命名空间之下，由 connection-key 门控——一个 agent 永远够不到它（§5）。
:::

### `POST /agents/enroll` → 用一个一次性码兑换一份持久 PAT（码门控）

在第一次 handshake 之前每个 agent 跑**一次**。agent 呈现它的**一次性登记码**（`plx_enroll_…`，单次使用，~15 分钟）——由所有者交给它的安装命令带外交付（§5）。网关兑换该码并把 agent 那份**持久的、按 agent 独立的 PAT**（`plx_agent_…`）以明文返回**恰好一次**；它以静态哈希存储。`agentId` 由该码在服务端绑定——它**不**被自我断言。

**请求：**
```json
{ "code": "plx_enroll_2b7d…c90" }
```
**响应：**
```json
{ "pat": "plx_agent_9f1a…44e", "agentId": "agent-ez-1" }
```
agent 自己存放 PAT（它自己的范式，`0600`），此后在每次 handshake 呈现它。该码在成功时被消费（一次重放失败为 `code_consumed`）。失败即关闭的原因：`malformed` / `unknown_code` / `code_expired` / `code_consumed` / `persist_failed`（一次持久写入失败把码留作未消费以供重试）。connection-key 在这里**绝不**被接受。

### `POST /link/handshake` → 完整 manifest（对 agent 是 PAT 门控）

agent 把它的**按 agent 独立的 PAT** 作为 `Authorization: Bearer plx_agent_…` 呈现——**body 里没有 `connectionKey`**。网关核验 PAT，从中解析出**真实的 `agentId`**（任何 `client.agentId` 只是元数据，被强制改写为那个已核验的 id——见 §4d），开启一个绑定到那个 id 的会话，并返回**完整 manifest**：每个条目连同完整的 `describe`、`io` schema、`grants`、`transport`、附着的技能主体、以及 MCP 直通。

::: info 管理员路径（不是 agent 路径）
同一个端点也接受一个在 JSON **body** 里呈现 `{ "connectionKey": "plx_live_…" }`（无 Bearer）的**所有者**——这是控制台的权威，可以合法地点名一个 `agentId`。两条路径靠凭据是否在场来选择，绝不互相穿透；一个 agent 没有 connection-key 可用来够到管理员路径。
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
此刻 agent 持有**没有受限令牌**——它有只读的知识，零调用权威。（默认拒绝。）`manifest.revision` 是一个单调计数器，agent 拿它对着 `manifest_changed` 事件比较来检测一个陈旧视图（§2，manifest 刷新）。

### `PUT /grants` → 受限令牌（按 capability）

agent（或**经管理客户端的用户**）选择允许哪些条目、在什么动词下。每一个被请求的授权都被跑过配置的 **`Authorizer`**（那条可插拔的授权缝，ADR-007 已修订）。返回要么一个覆盖被批准条目的**受限令牌**，要么对任何策略推迟的授权返回一个 **`grant_pending_user`** 通知。

::: info 权威注记（ADR-007 已修订）
授权裁决是一个**可插拔抽象**（`Authorizer`：输入 = 授权请求 + 上下文 → `allow | deny | pending`）。**已发布的默认是 `confirm-risky` 模式下的 `UserConfirmAuthorizer`：** first-party / managed 源上的只读授权自动批准，但任何 **`write` / `execute`** 授权（以及任何在 `extension` 来源源上的授权）**为所有者挂起**——返回 `grant_pending_user`。一个完全宽松的 `AutoApproveAuthorizer` 也存在（被某些内部 / 测试流程使用）且是可直接替换的，但它**不是**那个面向 agent 的默认值。两种策略是同一条线路——`grant_pending_user` + `GET /grants/status` 轮询通道对变更授权默认就在被行使，交换时**无线路改动**。
:::

**请求：**
```json
{
  "sessionId": "sess_01J…",
  "grants": {
    "obsidian.vault.read": "allow",
    "mcp.github.create_issue": { "decision": "allow", "verbs": ["write"] },
    "cc-master.orchestration.run": { "decision": "allow", "verbs": ["execute"] }
  }
}
```
`"allow"` 简写归一化为只读默认值。github 条目显式请求 `write`。cc-master **workflow** 请求 `execute`。

**响应（已批准——注意被合成的传递性成员作用域）：**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWI…",
  "jti": "tok_01J…",
  "expiresAt": "2026-06-23T11:15:00.000Z",
  "scopes": [
    { "id": "obsidian.vault.read", "verbs": ["read"] },
    { "id": "mcp.github.create_issue", "verbs": ["write"] },
    { "id": "cc-master.orchestration.run", "verbs": ["execute"] },
    { "id": "cc-master.board.create", "verbs": ["write"], "synthesizedFor": "cc-master.orchestration.run" },
    { "id": "cc-master.agent.dispatch", "verbs": ["execute"], "synthesizedFor": "cc-master.orchestration.run" },
    { "id": "cc-master.board.status", "verbs": ["read"], "synthesizedFor": "cc-master.orchestration.run" }
  ],
  "transitive": [
    {
      "workflowId": "cc-master.orchestration.run",
      "memberScopes": [
        { "id": "cc-master.board.create", "verbs": ["write"] },
        { "id": "cc-master.agent.dispatch", "verbs": ["execute"] },
        { "id": "cc-master.board.status", "verbs": ["read"] }
      ]
    }
  ]
}
```
**传递性授权（评审 #5，ADR-012）：** 授予该 workflow 会合成成员作用域（标记 `synthesizedFor`）并把它们戳入令牌，因此成员派发通过同一管线做作用域检查——无静默升级。`transitive` 块正是管理客户端在授权确认时向用户**浮现**的东西（"……它也会运行 board.create / agent.dispatch / board.status"）。每个成员 id 必须是一个在场的注册表条目。

**响应（挂起——一个更严格的 `Authorizer` 推迟了裁决）：**
```json
{
  "status": "grant_pending_user",
  "pendingId": "pend_01J…",
  "pending": ["cc-master.orchestration.run"],
  "statusUrl": "http://127.0.0.1:7077/grants/status?pendingId=pend_01J…"
}
```
agent 随后轮询 `GET /grants/status`（见下）或等待一个 `grant_resolved` 事件。（默认的 `confirm-risky` 授权器对任何携带一个变更 `write` / `execute` 动词的授权发出这个——每一个非读 capability 的正常路径。）

### `GET /grants/status?pendingId=…` → 解析一个待批授权（评审 #9）

那个解析通道，好让一个 `grant_pending_user` 永不死路一条。agent 轮询直到 `state` 终局；在 `"approved"` 时铸造出的令牌被包含在内。

**响应：**
```json
{
  "pendingId": "pend_01J…",
  "state": "approved",
  "capabilities": ["cc-master.orchestration.run"],
  "token": {
    "token": "eyJ…",
    "jti": "tok_02K…",
    "expiresAt": "2026-06-23T11:30:00.000Z",
    "scopes": [ { "id": "cc-master.orchestration.run", "verbs": ["execute"] } ]
  }
}
```

### `POST /grants/refresh` → 授权背书的令牌重铸（评审 #4）

令牌生命期是**15 分钟，锁定**——但 cc-master workflow 运行**超过 24 小时**。Refresh 直接从**持久授权**用**相同作用域**重铸一个新鲜的 15 分钟令牌——**无 connection-key，无重新提示**——受该授权自身有效期约束。agent 只保留那个短令牌 + 一个 refresh 句柄，从不保留 connection-key。（见 §5 的长运行流程。）

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
  "scopes": [ { "id": "cc-master.orchestration.run", "verbs": ["execute"] } ],
  "grantExpiresAt": "2026-06-25T10:00:00.000Z"
}
```
旧 `jti` 被吊销；一旦 `grantExpiresAt` 过去，refresh 就停止工作（届时 agent 必须重新 `PUT /grants`）。前置条件：会话存活（§5）、授权在场 + 未吊销、在授权有效期内。

### `POST /grants/revoke` → 吊销一个令牌或授权（评审 #3）

由管理客户端的"立即吊销"动作驱动，或由一个 agent 交回它自己的令牌驱动。两种选择器形态。

**请求（按 jti）：**
```json
{ "jti": "tok_01J…", "reason": "user revoked from management client" }
```
**请求（按 scope——同时移除持久授权，这样 refresh 无法再铸造）：**
```json
{ "agentId": "agent-ez-1", "capabilityId": "cc-master.orchestration.run" }
```
**响应：**
```json
{ "ok": true, "revokedJtis": ["tok_01J…", "tok_03L…"], "grantRemoved": true, "auditId": "evt_09Z…" }
```
**在飞 workflow 规则（评审 #3）：** 编排器在**每次成员派发之前**重新检查发起 `jti` 的吊销状态，因此扇出中途的吊销会中止其余成员（已完成的派发被审计，不被撤销）。

### `POST /invoke` → 调用一个已授权的 capability

agent 调用一个 capability/workflow，把受限令牌作为 `Authorization: Bearer <token>` 呈现。网关：
1. 在任何东西之前强制 **Host/Origin** 守卫（§5）；
2. 核验 JWT 签名 + 过期，检查 `jti` 未被吊销**且会话仍存活**（评审 #8）；
3. 确认某个作用域用条目所**需**的每一个动词覆盖 `id`——且当该作用域携带一个 `constraint`（`ScopeConstraint`）时，确认此次调用的 `input` 满足它（`constraintSatisfied`）；否则该作用域是惰性的，调用被默认拒绝（`grant_required`）——见 §4 内容感知授权；
4. 对着 `io.input` 校验 `input`（**轻量**：必需键 + 顶层原语类型 + 可选启用的 `additionalProperties`——非完整 JSON Schema；见 §1 的 schema 校验注记）；
5. 路由到拥有它的 `CapabilityBridge` → `Transport.dispatch()`（无 `if (id===…)`——路由由注册表/transport 驱动）；
6. 写一个脱敏的审计事件；
7. 返回一个归一化的 `InvokeResponse`（对 MCP 摄取的条目保留逐字 `mcpResult`——工具/资源/提示一视同仁）。

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
一个返回 `isError:true` 的 MCP 服务器映射为 `ok:false`、`error.code:"mcp_tool_error"`，服务器的 `content[]` 保留在 `mcpResult.content` 里。一次资源读取填充 `mcpResult.contents[]`；一次提示获取填充 `mcpResult.messages[]`。

#### `/invoke` 上的单一结果契约（v0.1.1 —— tp2 / ADR-017）

`/invoke` **总是**返回一个 **`InvokeResponse` 形状的 body**——对成功**以及每一次拒绝**，包括 auth/派发前的那些（无令牌、`grant_required`、`token_revoked`/`token_expired`、`session_expired`、`unknown_capability`、`schema_validation_failed`）。一个拒绝 body 是：

```json
{
  "id": "cc-master.orchestration.run",
  "ok": false,
  "error": { "code": "grant_required", "message": "No grant for cc-master.orchestration.run (execute).",
             "capabilityId": "cc-master.orchestration.run" },
  "auditId": "evt_03L…"
}
```

因此一个把每个 `/invoke` 回复都反序列化为 `InvokeResponse` 的天真 agent 在拒绝时总是读到 `ok:false`——从不读到 `ok === undefined`。`error.code` 取自**封闭的 `ErrorCode` 联合类型**（§7），因此 agent 仍然确定性地分支（refresh 对 re-grant 对 re-handshake 对放弃）。`auditId` 对被审计的拒绝是那个审计事件 id（每一次管线派发前拒绝都被审计），对在管线审计之前就失败的 EDGE 拒绝（无令牌 / 畸形令牌 / 不可解析 body）是空字符串 `""`。

对着它分支的 agent，**HTTP 状态**仍然分类失败：

| 拒绝 `error.code` | HTTP 状态 |
|---|---|
| `grant_required`、`token_expired`、`token_revoked`、`session_expired`、`grant_pending_user` | `401` |
| `host_forbidden` | `403` |
| `unknown_capability` | `404` |
| `schema_validation_failed` | `422` |
| `rate_limited` | `429` |
| `source_unavailable` | `503` |
| `mcp_tool_error`、`transport_error`（带内派发失败） | `200` |
| `internal_error`（以及任何未映射的码） | `400` |

::: info 单一形状的范围
这条 `InvokeResponse` 唯一规则**仅限 `/invoke`**。其余每个端点在失败时保持统一的 `ErrorResponse` 信封（`{ error:{…} }`）（§7）。`/invoke` 特殊，因为它的成功 body 本就是一个 `InvokeResponse`，所以把它的拒绝路径塌缩成同一个形状，就给了 agent 在它最常命中的调用路径上一个契约。
:::

::: info 路由注记（workflow 与 MCP）
一个 `kind:"workflow"` 的 invoke 路由到 `WorkflowTransport`，它经 `invokeById` 对每个成员**重入统一的 invoke 管线**——核心从不在 `kind:"workflow"` 上分支（评审 #6，§6）。每一次成员调用本身都被作用域检查（对着合成作用域）+ 审计。一个 `transport:"mcp"` 的 invoke 路由到 `McpTransport`，它在 `mcp.primitive` 上分支（`tools/call` / `resources/read` / `prompts/get`）并把服务器的原生结果逐字保留在 `mcpResult` 里。
:::

### `GET /manifest` → 刷新 manifest 快照（评审 #9）

handshake manifest 是一份一次性快照。当条目集在会话中途变化时（MCP `list_changed`、一个源上线、一个扩展注册），agent 无需重新 handshake 就重新取回当前的完整 manifest。会话认证（如 `X-Plexus-Session: <sessionId>`）。返回 `{ manifest }`，带一个被推进的 `manifest.revision`。

### `GET /grants` → 常驻授权账本（ADR-018，v0.1.2，会话认证）

agent 对用户 Grants 屏的对称视图——调用方的**常驻授权**（那份持久的、经人类批准的信任，有别于 15 分钟令牌）。会话认证，与 `GET /manifest` 完全一样；对一个管理会话它返回所有常驻授权。经 `AuthAdvertisement.grantsListUrl` 广告。返回 `GrantsListResponse { grants: StandingGrant[] }`——形状与信任模型见 §4d。（管理 UI 用那个管理密钥门控的 `GET /admin/api/grants`。）

### `GET /events` → 实时事件流（SSE）（评审 #9）

一个 `PlexusEvent` 的 Server-Sent Events 流，好让 agent 无需轮询就得知变化：
- `manifest_changed` —— 重新取回 `GET /manifest`（携带新的 `revision`）。
- `grant_resolved` —— 一个待批授权被裁决（若批准则携带令牌）。
- `token_revoked` —— 一个持有的令牌被吊销；立即停止使用它。
- `source_status` —— 一个源的可用性变化（诊断）。

### `POST /extensions` → 注册一个用户扩展（评审 #次要，Flow B）

注册一个 `ExtensionManifest`；网关物化它的 `CapabilitySource`，其投影条目进入注册表，并触发一个 `manifest_changed` 事件。会话认证（注册是一个用户授权的动作）。

**请求：**
```json
{ "sessionId": "sess_01J…", "manifest": { "manifest": "plexus-extension/0.1", "source": "obsidian", "...": "see examples/extension-manifest.obsidian.json" } }
```
**响应：**
```json
{ "ok": true, "source": "obsidian", "registered": ["obsidian.vault.read"], "revision": 8 }
```

## §3 —— Transport 抽象

第一批（已锁定，ADR-003）：`local-rest | stdio | ipc | mcp | cli`，外加两个非线路哨兵 `skill` 和 `workflow`。适配器层按种类实现 `Transport` 接口；bridge 调用 `dispatch()`。**加一个 transport = 实现 + 注册；绝不编辑调用方。**

```ts
interface Transport {
  readonly kind: TransportKind;
  dispatch(entry, input, ctx?): Promise<TransportResult>;   // ctx present only for re-entrant transports
}
```

| kind | 线路 | 注记 |
|---|---|---|
| `local-rest` | 到 app 暴露的一个 localhost 服务的 HTTP | 如 Obsidian Local REST API。端点 + bearer 凭据经平台缝。 |
| `stdio` | 生成子进程，在 stdin/stdout 上走 NDJSON | 通用的非 MCP stdio 适配器。 |
| `ipc` | unix socket / 命名管道 / osascript 桥 | OS 专属部分在平台缝后。 |
| `mcp` | **享有特权**——Plexus 运行一个 MCP 客户端 | 在 `mcp.primitive` 上分支；见下。 |
| `cli` | 用 argv 调用二进制，捕获 stdout（可选 `--format json`） | 二进制由 path-resolver 解析。 |
| `skill` | （无） | 哨兵——主体作为上下文交付。 |
| `workflow` | （无） | **对每个成员重入 invoke 管线**；见下。 |

### `mcp` transport，具体说（评审 #1/#2）

::: warning 状态
下面的 transport/客户端层已实现并测试，但生产（`MODULES`）里没有 MCP 源被注册，也还没有一条把一个 MCP 服务器包成一个源的已发布路径（见
[`KNOWN-LIMITATIONS.md`](https://github.com/nemori-ai/plexus/blob/main/docs/KNOWN-LIMITATIONS.md)）。
:::

`McpTransport extends Transport`。Plexus 是那个 **MCP 客户端**，且派发**在 `entry.mcp.primitive` 上分支**：

```
scan():   initialize(serverId)              // clientInfo+caps → server caps; then notifications/initialized
          list(serverId)                    // tools/list + resources/list + prompts/list — PAGED TO EXHAUSTION
          → re-project each primitive to a CapabilityEntry (schemas VERBATIM, mcp.raw kept)
invoke(): primitive "tool"     → call(serverId, originName=tool-name, args)  // tools/call
          primitive "resource" → readResource(serverId, uri=originName)      // resources/read
          primitive "prompt"   → getPrompt(serverId, name=originName, args)  // prompts/get
          → TransportResult { ok, mcpResult: { content?|contents?|messages?, structuredContent?, isError? } }  // VERBATIM
```

`isError:true` ⇒ `ok:false` + `error.code:"mcp_tool_error"`，`content[]` 保留。一个**持久 MCP 客户端**（由 `CapabilitySource.start()` 拥有）跨请求作用域的 invoke 复用，并在会话丢失时重新初始化。MCP transport 走 **stdio** 或 **Streamable HTTP**（`/mcp`，`Mcp-Session-Id` 头），归实现内部所有。`notifications/.../list_changed` 经 `CapabilitySource.onEntriesChanged` 浮现 → 一个 `manifest_changed` 事件发给 agent。

### `workflow` transport，具体说 —— 编排器"只是一个 transport"（评审 #6）

**没有外部线路。** `WorkflowTransport.dispatch` 接收一个 `TransportDispatchContext`，并经 `invokeById` 对每个 `entry.members[]` **重入统一的 invoke 管线**。后果：

- 网关核心**从不**有一个 `if (kind === "workflow")` 分支——扇出是普通的、受作用域检查、被审计的调用，走与任何调用相同的路径。
- 每一次成员派发都对着同一令牌上携带的**合成传递性作用域**（§2 grants）被检查——无静默升级。
- 在**每次成员派发之前**，管线**重新检查**发起 `jti` 的吊销状态（评审 #3），因此一次扇出中途的吊销会中止其余。

（相对于把编排器建模为一个 first-party `CapabilitySource` 而选；ADR-013 记录了为什么——transport 重入让成员留在完全相同的执行路径上。）

## §4 —— 受限令牌模型

**格式（ADR-006）：已签名 JWT（HS256，网关持有的秘密）+ 服务端吊销注册表。** 自包含以验证（无状态签名检查），但每个 `jti` 都被追踪，因此一个授权可在过期前被吊销。对 agent 不透明——它只呈现那个紧凑的 Bearer 字符串。

- **作用域形状：** `scopes: { id, verbs[], synthesizedFor?, constraint? }[]`。令牌权威 = 恰是这个并集。一次调用被允许，仅当某个作用域用条目所需的**每一个**动词覆盖条目的 `id`。默认最小 + **只读**（一个裸 `"allow"` 授予 `["read"]`）。一个 `synthesizedFor` 作用域是一个 workflow 的传递性成员作用域（§2）。
- **内容感知授权（AUTHZ-UX §3.1）：** 授权是内容感知的，不仅仅是按 capability + 按动词：一个作用域/授权可携带一个可选 `constraint`（`ScopeConstraint`），它只会**收窄**覆盖——一个作用域只在此次调用的 `input` 满足该约束时才覆盖此次调用（`constraintSatisfied`）；在它之外，作用域是惰性的，调用被默认拒绝（`grant_required`）。被强制的约束骑在已签名 JWT 的 `scopes` 里，并在每次调用都已经经过的**同一个** `POST /invoke` 咽喉点被检查（下面第 3 步）——它来自那个已核验的令牌，绝非请求 body，且对一个缺失/畸形的输入字段或一个不被支持的操作**失败即关闭**。缺席 ⇒ 今天的整-capability 作用域（不变）。
- **生命周期：15 分钟，锁定（ADR-006，用户决策）。** 授权持久在授权存储里，以 `(agentId, capabilityId)` 为键；令牌是廉价的、被再生的视图。agent 经 **`POST /grants/refresh`**（ADR-011）让长任务保持存活，它从持久授权重铸而无 connection-key、无重新提示，受该授权自身有效期约束。（这就是为什么一个 15 分钟令牌对一个 >24h workflow 是可行的——见 §5 长运行流程。）
- **吊销（ADR-010）：** `POST /grants/revoke` 按 `jti`（单个令牌）或按 `(agentId, capabilityId)`（所有携带该作用域的令牌 + 移除持久授权，这样 refresh 无法再铸造）。被吊销的 `jti` 即便在 `exp` 之前也在 invoke 时被拒；一个 workflow 在每次成员派发之前重新检查吊销（评审 #3）。
- **会话存活（评审 #8）：** invoke 还要求令牌的 `sessionId` **存活**。一个 **agent** 会话在其 **PAT** 之下引导，因此它与 connection-key 轮换解耦，只在那个 agent 的 PAT 被吊销时才死去（`POST /admin/api/agents/revoke`，§5）。connection-key **轮换**使**管理员/密钥引导**的会话失效并把它们令牌的 jti 排队等吊销。存活失败 ⇒ `session_expired`。
- **审计关联：** `sub`（agent id）、`jti`（令牌 id）、以及 `sessionId` 穿过每一个 `AuditEvent`，因此每次调用都可追溯到一个令牌和一个 agent。

### 错误码（封闭联合——评审 #10）

`ErrorResponse.error.code` 和 `InvokeResponse.error.code` 取自一个**封闭的 `ErrorCode` 联合类型**，好让 agent 确定性地分支恢复。每个端点在失败时都以统一的 `ErrorResponse` 信封（`{ error:{…} }`）返回——**除了 `POST /invoke`**，它自 v0.1.1（tp2 / ADR-017）起对所有拒绝返回 `InvokeResponse` 形状（`{ id, ok:false, error:{…}, auditId }`），好让它有一个结果契约（见 §2 `POST /invoke`）。`error.code` 与 HTTP 状态在两种框定间完全相同；只有外围 body 不同。

| 码 | agent 应当 |
|---|---|
| `token_expired` | `POST /grants/refresh`（或 re-grant），重试 |
| `token_revoked` | 经 `PUT /grants` 重新请求 |
| `grant_required` | 为该 id/动词请求一个授权 |
| `grant_pending_user` | 轮询 `GET /grants/status` / 等待 `grant_resolved` |
| `session_expired` | 重新 handshake |
| `unknown_capability` | manifest 很可能陈旧 → `GET /manifest` |
| `schema_validation_failed` | 对着条目的 `io.input` 修正 `input` |
| `source_unavailable` | 源/app 不可达；退避 / 浮现给用户 |
| `mcp_tool_error` | MCP 带内错误；检视保留的 `mcpResult.content` |
| `transport_error` | transport 级失败；重试 / 浮现 |
| `host_forbidden` | Host/Origin 检查失败（§5） |
| `rate_limited` | 退避 |
| `internal_error` | 意外的网关故障 |

## §4d —— 统一信任模型（ADR-018，v0.1.2，加性）

授权机制一直是正确的；v0.1.2 **命名**它并把它**浮上台面**，好让 UI 里的一个人类、读协议的一个 agent、以及读 API 的一个开发者，都读到**相同的**事实。这里的一切在冻结的线路下都是加性的：新的可选字段和一个新端点。一个 `v0.1.1` 客户端忽略它全部。

### 词汇表（每个概念一个词，处处逐字使用）

| 术语 | 含义 |
|---|---|
| **agent** | 一个授权被**限定作用域**到的身份（`agentId`），在 handshake 时由该 agent 的 **PAT** 在服务端绑定——**不**被自我断言（见下文"信任边界与 agentId"）。一个稳定的、PAT 核验的 `agentId` 让 Plexus 跨会话记住常驻授权。一个没有已核验 PAT（`anon:*`）的会话得到**无常驻信任**，每会话重新询问。 |
| **capability** | 那个可调用的条目（`CapabilityId`）。 |
| **scope** | 一个令牌所携带的一条 `(capability × verbs)`（`TokenScope`）。 |
| **grant** | 那个常驻、**经人类批准**的许可 `(agentId, capabilityId, verbs)`：此 agent 可以在这些动词下使用此 capability，直到信任窗口结束（`StandingGrant`）。 |
| **trust-window** | 一个授权在需要重新批准前**常驻**多久——那个人类*裁决*的生命期（`TrustWindow`）。 |
| **token** | 一个授权的短命（≈15 分钟）自动刷新**视图**；在 `/invoke` 上呈现的那个东西（`ScopedToken`）。 |
| **provenance / source-class** | 该 capability 从何而来：`first-party` / `managed` / `extension`（`Provenance`）。 |
| **sensitivity** | 用于叙述的派生风险层级：`low` / `elevated` / `high`（`Sensitivity`）。 |

### 两个时钟

两个不同的生命期，终于被一起命名：

| 时钟 | 它约束什么 | 值 | 谁在意 |
|---|---|---|---|
| **token-lifetime** | 一份泄露凭据的影响面 | ~15 分钟，自动刷新（`ScopedToken.expiresAt`） | 安全不变量——刻意设短；钳制到 `[1min, 60min]`，绝不按批准、绝不由 agent 选 |
| **trust-window** | 人类的批准在 Plexus 重新询问前常驻多久 | 按 source-class × 动词（见下）；`StandingGrant.expiresAt` / `ScopedToken.grantExpiresAt` | 那个用户可读的真相；由 agent 叙述 |

两者都在 `~/.plexus/auth-config.json` 里可配置（`tokenLifetimeMs` 钳制到 `[60000, 3600000]`；`maxTrustWindowMs` 把 **`custom`** 时长封顶于 30 天——`until-revoked` 哨兵不受它钳制）。

### 信任边界与 agentId

Plexus 有**两**条信任边界，由两个不同的当事方持有：

- **connection-key**（`plx_live_…`）是**管理/管理员**边界。所有者作为管理员持有它；它认证 `/admin` 控制台和 handshake 的管理员路径。轮换它会吊销一切密钥引导的东西。**agent 永不看见它。**
- 每个 **agent** 用**自己那份按 agent 独立的 PAT**（`plx_agent_…`）认证。PAT 是 agent 的会话引导秘密及其身份：在 handshake 时网关从 PAT 解析出**真实的 `agentId`** 并把会话绑定到它，覆盖任何 `client.agentId`（仅元数据）。因此一个客户端**无法自我断言**成另一个 agent 的身份——不带 PAT 而点名一个 agent 只会拿到一个 401，没有会话。按 agent 身份是**已发布**的，非推迟。

因为 `agentId` 是 PAT 核验的，常驻授权被安全地按 agent 限定作用域：一份泄露的 PAT 只搭乘那一个 agent 的授权，而吊销一个 agent（`POST /admin/api/agents/revoke`）让其他每个 agent 都不受触碰——不像一个共享密钥，其轮换会切断所有人。**管理员路径仍可点名一个 `agentId`**（控制台的"连接一个 agent"正是这么做的）：那不是伪冒，因为持有 connection-key *就是*管理员权威。剩下的推迟加固是一个**密钥对（持有证明）PAT**——v1 用一个 bearer PAT；身份本身并未推迟。

### 3 类来源 + 姿态表

是否具备常驻资格由**敏感度（provenance × verb），而非来源**决定（ADR-5）。下面的默认信任窗口是每类 read/write/**execute** 的天花板：

| provenance | 含义 | read 姿态 | write 姿态 | execute 姿态 | 默认窗口（read / write / execute） |
|---|---|---|---|---|---|
| **first-party** | 保留/进程内源（cc-master、obsidian(fs)、mock） | **自动放行** | 挂起 | 挂起 | 7d / 1d / **once** |
| **managed** | 用户经受信管理 UI 添加的源（添加时经人类审核） | **自动放行**（共享 first-party 读姿态） | 挂起 | 挂起 | 7d / 1d / **once** |
| **extension** | 由一个 agent 经 `POST /extensions` 线路注册（最严格） | **挂起** | 挂起 | 挂起 | 1d / 1d / **once** |

- **`execute` 永不能常驻（ADR-5 —— 硬天花板）。** 任何 `execute` capability——first-party、managed 或 extension——都**逐次**批准（`once`），绝不无摩擦。`chooseTrustWindow` 把 `execute` 钳制到 `once`，**无论请求的窗口是什么，也无论这次选择是否具管理员权威**：一个管理员即便给出一个更长的信任窗口也无法让一个 `execute` cap 常驻。绝不描绘一个 `execute` 授权搭乘一个常驻窗口。
- 自动放行的读**绝不静默**：它们仍带其信任窗口出现在常驻授权账本里。
- 一个针对 `(agentId, capabilityId)` 的**常驻、未过期**授权，对它覆盖的任何动词短路重新询问。一个 `once` 授权（`standing:false`、`expiresAt = grantedAt`）是单次使用的，**绝不**短路。
- `until-revoked` 存在（远期哨兵；只有一次显式吊销才结束它），但**绝不是默认值**；自定义时长封顶于 30 天。
- `anon:*` 会话（无已核验 PAT）是仅限会话的：绝不在一个匿名 id 下持久化一个常驻（> 会话）授权（上限锁在 `once`）。

### 新端点 —— `GET /grants`（会话认证）

返回调用方的常驻授权账本——agent 对用户 Grants 屏的对称视图。会话认证，与 `GET /manifest` 完全一样；对一个管理会话它返回所有常驻授权。经 `AuthAdvertisement.grantsListUrl` 广告。（管理 UI 用那个管理密钥门控的 `GET /admin/api/grants`。）

```
GET /grants                       → GrantsListResponse { grants: StandingGrant[] }
```

`StandingGrant = { agentId, capabilityId, verbs[], provenance, sensitivity?, grantedAt, expiresAt, trustWindow, standing, synthesizedFor?, constraint?, bundleId?, topLevelDisabled? }`——其中 `expiresAt` 是信任窗口的结束（那个用户可读的真相），`standing:false` 标记一个不可续的 `once` 授权。那个持久 `constraint`（`ScopeConstraint`）是该授权被批准所在的内容感知收窄（因此 refresh 重铸一个携带**相同**被强制约束的令牌；缺席 ⇒ 一个无约束的整-capability 授权）；`bundleId` 标记一个命名 Mode-2 任务捆绑的成员（一个不赋予其成员之外任何权威的分组）；`topLevelDisabled:true` 标记一个其 capability 当前在"我暴露什么"顶层被禁用的授权（记录仍在，但该 capability 在被重新启用前不可见 + 不可调用——有效访问 = 已授权 ∧ 已暴露）。

### 加性可选字段（每个改动都非破坏性）

| 类型 | 新增的可选字段 | 目的 |
|---|---|---|
| `CapabilityEntry`、`CapabilitySummary` | `provenance`、`sensitivity`、`recommendedTrustWindow` | 好让一个 agent 能在请求*之前*叙述代价（省略 ⇒ 当作 `extension`） |
| `GrantDecision` | `trustWindow`、`purpose`、`constraint` | 请求方提议的窗口——在 agent 路径上**仅供建议**（可被缩短，绝不能超过按类别天花板去延长），在管理员批准路径上**权威**；`purpose` 是 agent 自由文本的 WHY（仅**透明**——不影响任何裁决；单独渲染为"agent 说："，封顶 280 字符）；`constraint`（`ScopeConstraint`）是要附上的内容感知收窄（**仅收窄**；铸造到 `TokenScope.constraint` 上） |
| `GrantPendingResponse`、`GrantStatusResponse` | `pendingNarration[]` | 网关撰写的 `{ id, verbs, provenance, sensitivity, defaultTrustWindow, summary, notificationLine? }`，好让每个 agent 转达**相同**的真实一行文案；`notificationLine` 是那个 ~120 字符、网关撰写的托盘/通知形式（web 忽略它） |
| `GrantRequest` | `bundle` | Mode-2 任务捆绑信封 `{ name, agentId?, context? }`——那个多-capability（+约束）请求被当作一个命名捆绑（成员共享一个 `bundleId`，有风险的成员作为一个 Approve 组挂起）；一个捆绑不增加新权威 |
| `StandingGrant` | `constraint`、`bundleId`、`topLevelDisabled` | 那个持久的被批准约束（在 refresh 时重铸）；那个任务捆绑标记；那个"已授予但被禁用（不可见）"的暴露标志 |
| `TokenScope` | `constraint` | 那个骑在已签名 JWT scopes 里、并在 invoke 时被检查（`constraintSatisfied`）的被强制作用域约束 |
| `BundleView`、`GrantContextRef` | （新类型） | 管理 Grants 视图的捆绑投影（`GET /admin/api/bundles`），以及一个对一片作用域内任务上下文的引用（复用 `kind:"skill"` 机制——`skill` 引用或封顶的 `inline` markdown；无新 transport） |
| `CapabilityEntry`、`CapabilitySummary` | `health` | 那个继承的按源健康**快照**（HEALTH；见下） |
| `ScopedToken` | `grantExpiresAt`、`trustWindow` | 那个紧挨 15 分钟 `expiresAt` 的信任窗口天花板 |
| `ScopedTokenClaims` | `gexp` | 授权/信任窗口过期纪元（诊断） |
| `AuthAdvertisement` | `grantsListUrl` | 到哪里 `GET /grants` |
| `AuthorizationDecision` | `provenance`、`sensitivity`、`recommendedTrustWindow` | 结构化的原因，好让服务无需重新派生就构建 `pendingNarration` |

**Health（HEALTH）。** capability 携带健康（`CapabilityHealth` / `HealthStatus`：`ok` | `degraded` | `unavailable` | `unknown`），好让 agent 能读可用性并优雅降级。快照是按源的（派生自一个源的可选 `health()` 方法，或在其缺席时派生自它的 `checkRequirements()`——只有 `health()` 能报告 `degraded`），继承到该源的每一个 `CapabilityEntry.health` / `CapabilitySummary.health` 上，并在序列化时从网关的短 TTL 健康缓存打戳。仅供参考。

**敏感度派生**（网关计算，好让所有界面一致）：`low` = first-party/managed 上的读；`elevated` = first-party/managed 上的 write/exec，或 extension 上的读；`high` = extension 上的 write/exec，或任何带 write/exec 的 cli/local-rest transport。Workflow 上卷其成员的敏感度（取最大）。

## §5 —— 安全模型

- **绑定：** **默认**环回（`127.0.0.1`）。经 `~/.plexus/network.json` 绑定一个选定的 NIC 或 `0.0.0.0` 是**可选启用**的；启用时，**每一条** `/admin/api/*` 路由都被 **connection-key 门控**——connection-key 成为那个 LAN 信任边界。（下面的 Host/Origin 守卫无论绑定如何，仍在每个端点上于 auth 之前运行。）
- **Host/Origin 守卫（评审 #7，ADR-016）：** 仅环回绑定既拦不住其他本地进程，也拦不住一个 **DNS 重绑定浏览器攻击**（一个恶意页面把一个主机名解析到 127.0.0.1 并向 `/invoke` POST）。每一个端点在 auth **之前**强制 `HostOriginPolicy`：`Host` 头**必须**等于绑定的环回权威（`127.0.0.1:<port>` / `localhost:<port>`），而 `Origin`——在场时（浏览器情境）——**必须**在 `allowedOrigins` 里（默认：只有管理客户端的来源；agent CLI 不发 Origin）。失败 ⇒ `host_forbidden`。
- **`.well-known` 指纹（已接受）：** 那份未认证的发现文档对任何本地调用方暴露网关版本 + 一份 capability-摘要清单。这是预会话发现（MCP 缺失的那个东西）的代价；它被限定到摘要（ADR-008）——完整 schema / 技能主体 / `mcp.raw` 仍需那个 PAT 门控的 handshake（一个已登记 agent 的 `Bearer plx_agent_…`）。
- **两凭据，绝不混淆：**
  - **connection-key**（`plx_live_…`）—— 那个**管理/管理员**凭据和信任边界。由网关生成，仅在本地管理客户端里展示，带外获得；它门控 `/admin/api/*` 和 handshake 的管理员路径。**agent 永不看见或呈现它。** 可按需轮换 / 自动轮换；轮换使管理员/密钥引导的会话失效**并把它们令牌的 jti 排队等吊销**（评审 #8）。
  - **按 agent 独立的 PAT**（`plx_agent_…`）—— **agent** 自己那份持久凭据和会话引导秘密（**非**调用权威）。在 `POST /agents/enroll` 从一个一次性登记码（`plx_enroll_…`，~15 分钟，单次使用）兑换**一次**得来，由 agent 以 `0600` 存放，静态哈希，可按 agent 独立吊销（`POST /admin/api/agents/revoke`）。它认证每一次 handshake；一份泄露的 PAT 只搭乘那一个 agent 的授权。
- **默认拒绝、默认只读：** 没有条目在无一个显式授权时可调用；一个裸 allow 只授予 read；`write`/`execute` 必须被点名。
- **可插拔的授权权威（ADR-007 已修订）：** 授权裁决是那条可插拔的 `Authorizer` 缝（`allow | deny | pending`）。**已发布的默认是 `UserConfirmAuthorizer`（`confirm-risky`）：** 读自动批准，`write` / `execute` 经 `grant_pending_user` 为所有者挂起。一个宽松的 `AutoApproveAuthorizer` 也存在（内部 / 测试）且是可直接替换的，无线路改动。那条缝——而非某一具体 UX——才是契约。
- **按 capability + 会话执行：** 每一次 `/invoke` 都对着条目所需的动词重新检查作用域覆盖，以及会话存活，以及 `jti` 未吊销——按调用，非按会话。
- **审计日志 + 脱敏契约（评审 #次要，ADR-009 修订）：** `~/.plexus/audit/` 之下的追加式 JSONL（按日轮换）。每个 `AuditEvent` 记录类型、`agentId`/`sub`、`jti`、`sessionId`、`capabilityId`、`verbs`、`outcome`、以及 `detail`。脱敏是一个**契约**（`AuditRedactionPolicy`）：那个单一写入者在持久化前从 `detail` 里擦掉原始调用 `input`、令牌字符串、connection-key、以及已解析的秘密——`forbidRawInput` 被强制，而非仅仅是愿景。保留默认 90 天。单一写入路径防止漂移。
- **本地优先状态：** 所有网关状态在 `~/.plexus/` 之下（授权存储、审计、源注册表、connection-key、**`~/.plexus/secrets/` 之下的秘密**经平台缝解析）；用户 cwd 里无指针文件。

### 连接一个 agent —— 已发布的界面（管理员 → agent → 调用）

那个两凭据模型由三个已发布界面外加一个编译出的 agent 界面实现。管理员行动一次；agent 运行一条命令；然后它调用 capability。

1. **管理员连接一个 agent** —— 控制台向导，或 `POST /admin/api/agents/connect`（connection-key 门控）。它**命名**该 agent，把一组起始 cap 集作为**常驻**授权授予它（那个人类批准，做一次），并铸造一个**一次性登记码**（`plx_enroll_…`）。
2. **agent 运行那条一键安装** —— `GET /integration/:agentId` 提供那条可复制的安装命令（管理门控）；它所调用的那个自包含、无秘密的 **`install.sh`** 是公开的。运行它会在 `POST /agents/enroll` 兑换该码 → 以 `0600` 存放 PAT → 删除该码，并落地那个编译出的 Claude Code plugin。
3. **agent 调用 capability** —— 经它捆绑的 launcher（见下）。

**agent 界面 —— 那个编译出的 plugin + 按 agent 的 launcher。** 该 plugin 发布一个**按版本隔离的 launcher `plexus-<agentId>`**，它 exec 它**自己**捆绑的引擎（同级的 `bin/plexus`）并绑定 `PLEXUS_AGENT_ID`——绝不是一个全局 `plexus`，因此两个 agent 的 plugin 不会冲突或认证成错误的 agent。子命令：

```
plexus-<agentId> enroll <code>       # once, at install: redeem code → store PAT
plexus-<agentId> list                # discover: callable-now vs needs-approval
plexus-<agentId> <capabilityId> …    # invoke a granted capability
```

那个**捆绑的技能**是那个始终在场、自描述的 Floor（`.well-known` + `requestShapes` + 如何使用）上的一层投影；一个陈旧的技能永远无法超出 Floor 的实时授权。**承重规则：** launcher 命令是 agent **完整而唯一**的界面——绝不手搓 HTTP，绝不手动调用 enroll/handshake/manifest，绝不猜测 auth。执行那条 enroll → handshake → grant → invoke 链路的引擎（`bin/plexus`）在构建时对着已提交的受认可引擎做逐字节校验；没有 auth 路径是 LLM 撰写的。（agent 一侧的视图见[面向 Agent](/zh/agents/)。）

**持久性。** 一个注册的扩展及其投影条目**在网关重启后存续**——重启时 Plexus 信任那份已持久化的配置并无需重新提示地引导它（一次全新注册仍会为一个人类挂起；§4d 的暴露/授权记录也存活）。

### 完整流程 —— 一个 >24h 的 cc-master 编排，跑在一个 15 分钟令牌上

1. agent handshake，对 `cc-master.orchestration.run`（`execute`）`PUT /grants`。该令牌也携带那些**合成成员作用域**（board.create / agent.dispatch / board.status），经 `transitive` 块向用户浮现。
2. agent 对该 workflow `POST /invoke` → `WorkflowTransport` 经 `invokeById` 向成员扇出，每个都被作用域检查 + 审计，吊销按成员重新检查。
3. 那个 15 分钟令牌逼近 `exp`。agent 用它的 `jti` + 会话调用 `POST /grants/refresh` → 一个新鲜的 15 分钟令牌，**无 connection-key，无重新提示**，受 `grantExpiresAt` 约束。在那 >24h 运行里重复。
4. 运行中途，一个源添加了 capability → `manifest_changed` SSE 事件 → agent `GET /manifest` 来刷新。若用户从管理客户端吊销 → `token_revoked` 事件 + 该 workflow 在它下一次成员派发前中止。

::: warning ADR-5 告诫
`cc-master.orchestration.run` 是一个 `execute` capability，因此它的授权是逐次的（`once`）——它**绝不**是一个多天常驻授权，且上面那个 refresh 循环绝不能被读成一个 `execute` cap 搭乘一个常驻窗口。为长寿而 refresh 是那些**具备常驻资格**的作用域（在其信任窗口内的 `read`/`write`，如那个 `board.status` 读成员）的模式；那个 `execute` 批准覆盖它单次受认可的调用，而重新调用该 workflow 会重新提示所有者。见 §4d 与[安全模型](/zh/architecture/security-model) §3。
:::

## §6 —— 适配器层架构

两层，镜像 pneuma-skills。适配器类型被**隐藏**在这些接口之后；核心从不在源/transport 类型上分支。

- **生命周期层 —— `CapabilitySource`**（≈ pneuma `AgentBackend` + `BackendModule`）：`checkRequirements()`（经平台缝的廉价可用性探测）、`scan()`（枚举/投影条目——对 MCP 这会跑客户端 handshake + list **分页到穷尽** + 重投影；对一个像 cc-master 这样的 first-party 编排，`scan()` 返回 workflow 及其成员条目，好让传递性授权有真实目标——评审 #次要，Flow A）、`start()`（在源生命期内拥有那个**持久 MCP 客户端**）、`stop()`、可选的 `onEntriesChanged()`（MCP `list_changed`）、以及一个可选的 **`install()`**——一个一等的、**经用户确认 + 被审计**（`source.install`）的动作，它取代了旧的、核心从不读的 `extras.autoInstall` blob（评审 #次要，Flow A）。
- **按会话的协议翻译层 —— `CapabilityBridge`**（≈ pneuma `BridgeBackend`）：每（会话 × 源）一个实例，闭包在它的适配器上，好让适配器类型保持私有。`getCapabilities()`、`invoke(req, ctx)`、`route() → "handled" | "unsupported" | "passthrough"`、`disconnect()`。网关在调用 `invoke()` **之前**强制授权；bridge 翻译到 transport 并归一化结果，且**必须**发出一个审计事件。`BridgeDeps` 现在携带 **`audit`**（折叠那个适配器-deps 的不对称——源可以审计 `source_unavailable`，评审 #次要）和 **`invokeById`**（`workflow` transport 借以扇出的那个重入管线——评审 #6）。

### 中央注册表（无分散的分支）

每个源从 `sources/<id>/manifest.ts` 发布一个 `SourceModule`。`SourceRegistry` 是模块被聚合的**唯一**地方（≈ pneuma `backends/index.ts: MODULES`）。每个调用方都走 `registry.get(id)` / `registry.getTransport(kind)` / `registry.all()`——**没有 `if (id === ...)` 住在一个源模块之外。** 加一个源 = 写一个 manifest，把它加进注册表映射。完成：发现、可用性、扫描、invoke 路由全都自动流动。

### 平台抽象缝

一切 OS 专属之物——二进制发现、进程生成、本地服务定位、**秘密解析**——都住在 `PlatformServices`（`resolveBinary`、`getEnrichedPath`、`locateLocalService`、`spawnProcess`、**`resolveSecret`**）之后。v1 发布一个 **macOS** 实现；Windows/Linux 日后实现同一条缝。复用 pneuma `path-resolver`（带回退候选目录的登录 shell PATH 捕获）。核心 + 适配器**只**依赖这个接口——没有 `process.platform` 检查漏进核心。`resolveSecret` 是那条给需要 auth 的本地服务（如 Obsidian Local REST API 的 bearer 密钥，评审 #次要）用的凭据路径：秘密住在 `~/.plexus/secrets/` 之下，从一个 `ExtensionSecretRef` 按名引用，只在派发时交给拥有它的 transport，绝不给核心 / manifest / 审计。

### 可选的日后输出：MCP-服务器 façade

这个契约被塑造成让一个未来的 **MCP-服务器 façade 输出适配器**能把 Plexus 子集重新发射为一个正常的 MCP 服务器，供纯 MCP 客户端使用。`mcp.raw` 字段逐字保留每一个被摄取的工具以供精确重投影；用户扩展/workflow 条目向下投影为 MCP 工具（只丢掉 MCP 承载不了的那个加性技能/授权层）。**为其设计，但在 M0 中未内建。**

## 附录 —— 文件地图

- [`VERSION`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/VERSION) —— 契约版本标签（`0.1.3`）。
- [`types.ts`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/types.ts) —— 规范 TypeScript 类型（真相来源）。
- [`examples/obsidian.vault.read.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/obsidian.vault.read.json) —— 用户扩展，只读。
- [`examples/cc-master.orchestration.run.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/cc-master.orchestration.run.json) —— first-party workflow，execute，`WorkflowMember[]` 成员。
- [`examples/mcp-tool-passthrough.github.create_issue.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/mcp-tool-passthrough.github.create_issue.json) —— 被摄取的 MCP 工具，逐字直通。
- [`examples/extension-manifest.obsidian.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/extension-manifest.obsidian.json) —— 极简用户扩展 manifest（Flow B 注册路径）。
- [决策记录](/zh/protocol/decisions) —— ADR（M0 v0.1.3）。
