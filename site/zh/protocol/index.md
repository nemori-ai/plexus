---
title: "Plexus 协议"
description: "M0 wire 契约（v0.1.4）：稳定、AI 原生的 DISCOVER → ENROLL → HANDSHAKE → GRANT → INVOKE 接口，涵盖端点、受限 token 模型与统一信任模型。handshake 返回 session 和所有者为该 agent 选中且已暴露的子集 manifest；调用授权另行取得。"
---
# Plexus 协议 —— M0 契约规范 {#plexus-协议-——-m0-契约规范}

Plexus 是用户自装的开源本地 capability 网关。它提供稳定、AI 原生的自描述端点，让任何 AI agent 按 DISCOVER → ENROLL → HANDSHAKE → be GRANTED → INVOKE 的顺序，使用用户机器上软件的 capability。

agent 只 enroll 一次，用一次性码兑换自己的持久 PAT，此后每个会话都凭这份 PAT handshake，从不持有所有者的 connection-key。handshake 返回会话和所有者选定的 capability 子集，不等于允许调用；取得限定范围的 grant/token 是另一步。

::: tip 契约状态
M0 契约修订为 `v0.1.4`，确切版本为 `0.1.4`，规范常量是 `PLEXUS_PROTOCOL_VERSION = "0.1.4"`，见 [`VERSION`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/VERSION)。wire 上通告的协议族则是 `"0.1"`，由 `config.ts` 导出 major.minor；加性变更和补丁保持兼容，`0.1.x` 客户端可跨补丁版本互操作。

整个代码库的类型以 [`types.ts`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/types.ts) 的规范定义为准。这是核心资产：本文供人阅读，`types.ts` 是机器侧的事实源。ADR 见[决策记录](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/DECISIONS.md)。

已发布的认证模型采用两类凭据（ADR-4 / ADR-5 / ADR-023）。agent 通过 `POST /agents/enroll`，将一次性 enroll 码（`plx_enroll_…`）兑换为按 agent 独立的持久 PAT（`plx_agent_…`）；handshake 必须通过 PAT 认证。connection-key（`plx_live_…`）只供管理员使用，agent 永远见不到。

按 ADR-5 / ADR-023，高敏感度的 `execute` capability 默认逐次批准（`once`）。agent 不能靠请求窗口或管理员信任窗口自行解除这一限制。只有所有者在连接时，为特定 (agent, capability) 开启常驻 execute 授权后，才适用真正的信任窗口或 until-revoked；这一选项默认关闭，须双重确认。权威规则见[安全模型](/zh/architecture/security-model)，本文规定与之相符的 wire 契约。
:::

产品定位已经确定：“MCP = 我有哪些函数；Plexus = 你该如何使用我。”这是定位上的比较，并不是说 MCP 没有授权框架。MCP 在 Plexus 中是一等、享有特权的导入 transport（`transport: "mcp"`），工具、资源和提示的 JSON Schema 逐字透传。在 MCP wire 之上，Plexus 再提供会话前的 `.well-known` 自描述、捆绑的使用 Skill、用户自定义扩展，以及按 capability 限定的授权与 token。

::: warning MCP 导入尚未向用户开放
MCP transport/客户端层已经实现并测试，但“把 MCP 服务器包成源”的用户路径尚未发布：生产注册表 `MODULES` 中没有 MCP 源模块。现在要暴露 capability，请使用 first-party 源，或自行编写扩展。本文各处的 MCP 设计说明的是已确定的方向和传输契约，不是已经可用的终端用户路径，见 [`KNOWN-LIMITATIONS.md`](https://github.com/nemori-ai/plexus/blob/main/docs/KNOWN-LIMITATIONS.md)。
:::


## §7（先读）—— Plexus 的四件事与数据流 {#§7-先读-——-plexus-的四件事与数据流}

Plexus 做四件事；本规范里的一切都服务于其中之一。先从位置上看：机器上的软件和工具在一侧，agent 在另一侧。Plexus 在中间找到源、翻译协议，把能力整理成条目，再从一个回环端点界面交给客户端。

1. **Scan —— 找到源。** 探测机器上已安装、可以适配的 capability 源，包括 first-party 适配器和用户扩展；MCP 服务器也在设计范围内，用户导入路径仍以前述状态为准。二进制和端点发现通过平台接缝完成：捕获登录 shell 的 PATH，再用候选目录回退，复用 pneuma `path-resolver`。

2. **Adapt —— 翻译源的协议。** 每个源前面都有适配器，由 `CapabilitySource` 和 `CapabilityBridge` 接入，将原生协议翻译成统一条目模型。核心把适配器类型当作黑盒，不需要理解每种软件的接法。

3. **Describe —— 让条目说明自己。** capability、skill、workflow 都注册为同构的自描述条目 `CapabilityEntry`，通过 `kind` 区分。agent 读一张“卡片”，就能知道它是什么、怎么用，不必先认识背后的软件协议。

4. **Expose —— 提供统一界面。** 客户端沿 `.well-known` → handshake → grants → invoke 使用这个回环端点界面。界面背后由哪个源承接，对外不可见。

![agent 的五步循环：discover、enroll、handshake、grant、invoke](/diagrams/protocol-loop.png)

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

图中的平台接缝以 macOS 为先：二进制发现、进程启动、本地服务定位这些与操作系统有关的工作，都隔离在 `PlatformServices` 后面，不交给客户端处理。图列的是分层关系，并不表示其中每种源都已开放接入。

**关键不变量：** 客户端永远只与一个稳定的端点界面对话。Scan、Adapt 和协议翻译全部留在 Plexus 进程内部。这既是工程上的解耦，也是合规边界。

五步循环不表示每次都要重新注册：ENROLL 每个 agent 只跑一次；之后每个会话用存好的 PAT，从 HANDSHAKE 开始。`.well-known` 广告完整端点集合，也包括生命周期端点 `/grants/refresh`、`/grants/revoke`、`/grants/status`、`/manifest`、`/events`、`/extensions`，见 §2。发现入口并不等于取得 manifest；握手后收到的条目，才是该 agent 获准可见且已暴露的子集。


## §1 —— 统一自描述条目模型 {#§1-——-统一自描述条目模型}

agent 用同一个循环发现 `capability`、`skill` 和 `workflow`，在同一个界面上授权；其中 `capability` 和 `workflow` 经同一条路径调用，`skill` 则作为上下文来读。三者是同构条目，由 `kind` 字段区分，不是三套独立的接口。

规范类型是 `types.ts` 中的 `CapabilityEntry`，别名为 `SelfDescribeEntry`。共同字段说明条目的身份、用途和接入方式；专用字段承载使用知识、编排成员或 MCP 来源。

| 字段 | 含义 |
|---|---|
| `id` | 全局唯一且稳定的标识，是 grant/scope/audit/invocation 的单元。命名约定为 `<source>.<noun>.<verb>`。 |
| `source` | 产出该条目的源或适配器。 |
| `kind` | 条目种类：`capability` \| `skill` \| `workflow`。 |
| `label` | 供人阅读的简短标签。 |
| `describe` | 自描述的核心。用面向 agent 的语义说明“是什么、何时用、怎样用好”，约定写法为 “Action outcome. Use when X.”。 |
| `io` | `{ input?, output? }` JSON Schema，输入和输出均可省略。MCP 工具 schema 逐字保留在这里。 |
| `grants` | 所需的授权动词：`read` \| `write` \| `execute`。 |
| `transport` | 适配器触达软件的方式，见 §3。 |
| `skills` | 附着的使用 Skill 引用，在条目上叠加“如何使用”的知识。 |
| `members` | 仅用于 `workflow`：有序的 `WorkflowMember[]`，成员形状为 `{id, verbs}`。每个 `id` 都必须指向注册表中实际存在的条目；传递性授权据此展开，见 §4。 |
| `body` | 仅用于 `skill`：内联或按引用提供的 Markdown 使用指引。 |
| `mcp` | 仅用于 MCP：逐字保留的 MCP 来源信息，包括 `serverId`、`protocolVersion`、`primitive`、`originName`，以及未经改动的原始 MCP 对象 `raw`。 |
| `version`、`extras` | 元数据。核心路由从不读取 `extras`，它不参与路由判断。 |

### 三个种类 {#三个种类}

`capability` 是可以直接调用的函数或数据访问，也是最小调用单元。契约中，导入的 MCP 工具对应这一种条目；这不改变前述用户导入路径尚未开放的状态。

`skill` 提供面向 agent 的使用知识：可用范例、容易踩的坑，以及使用约定。它可以被发现，但 `transport` 为 `"skill"`，不接受调用；agent 读取它的 `body`，把指引放进上下文。Plexus 通过 `skills` 引用把这些知识附在条目上，补充“如何用好我”。MCP 没有把这类使用知识单独定义为一种 `skill` 条目。

`workflow` 由用户或 first-party 将多个 capability 编排成一个更高层的 capability。对外调用方式与 `capability` 相同，内部则沿有序的 `members` 向各成员展开；成员必须点名已注册的条目，不能只写一段待解释的任务描述。


### 导入的 MCP 工具如何映射为条目 {#导入的-mcp-工具如何映射为条目}

::: warning 实现状态
Transport/客户端层已经实现并测试，但面向用户的“把 MCP 服务器包成源”路径尚未发布，生产注册表里没有 MCP 源模块。下面说明的是这条路径将来采用的投影契约，不是已经开放的导入功能。见 [`KNOWN-LIMITATIONS.md`](https://github.com/nemori-ai/plexus/blob/main/docs/KNOWN-LIMITATIONS.md)。
:::

按这份契约，`scan()` 期间，Plexus 会为每个 MCP 源运行一个 MCP 客户端，把工具、资源和提示分别整理成 `CapabilityEntry`。这一步称为投影：沿用源提供的内容，只把它放进共同的条目形状。

已交付的客户端仍采用 legacy 有状态流程：`initialize → tools/list → resources/list → prompts/list`。MCP `2026-07-28`+ 则取消了协议层的初始化握手和会话头，改用自包含请求，并提供可选的 `server/discover` RPC；应用状态仍可跨请求保留。下表的字段映射适用于两个版本，但这不表示当前客户端已经实现了对新版服务器的兼容。

| MCP 内容 | 对应的 Plexus 条目字段 |
|---|---|
| Tool `name` | 写入 `mcp.originName`，并以 `mcp.<server>.<name>` 初始化 `id` |
| Tool `description` | 初始化 `describe`，附着的 skill 可以继续补充说明 |
| Tool `inputSchema` | 逐字保留在 `io.input` |
| Tool `outputSchema` | 逐字保留在 `io.output` |
| Tool 注解（`readOnlyHint` 等） | 影响 `grants` 的 `read` / `write` 判断 |
| 整个 Tool JSON | 原样保留在 `mcp.raw`，供重投影和 façade 使用 |
| Resource | `kind:"capability"`、`mcp.primitive:"resource"`，只读；`mcp.originName` 使用资源的 URI |
| Prompt | `kind:"skill"` 或 capability 种子、`mcp.primitive:"prompt"`；`mcp.originName` 使用提示的 `name` |

资源与提示也是一等公民（评审 #1/#2），并非工具之外的附带数据。`mcp` transport 按 `mcp.primitive` 选择调用：工具走 `tools/call`；资源走 `resources/read`，参数为 `uri`；提示走 `prompts/get`，参数为 `name` + `args`。

返回时也不把三种结果压成一种。响应的 `McpResult` 槽逐字保留各自的原生形状：工具是 `content[]` + `structuredContent`（以及 `isError`），资源是 `contents[]`，提示是 `messages[]`。这取代了旧版仅适用于工具的 `mcpContent`，让三种原语都能无损往返。所有 `*/list` 都会逐页拉取，直到取完，不会因服务器条目多而截断。

Plexus 只做包装，从不重写导入的 schema。完整范例见 [`mcp-tool-passthrough.github.create_issue.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/mcp-tool-passthrough.github.create_issue.json)。

::: info Schema 校验注记（评审 #10）
schema 原样交付与调用时的校验，是两件事。“逐字直通”保证 JSON Schema 原封不动地到达 manifest/agent，并不保证 `/invoke` 完整执行其中的约束。

运行时 invoke 只做轻量校验：检查必需键是否在场、每个顶层属性的原语类型，以及可选启用的 `additionalProperties` 拒绝。嵌套对象、`$ref`、`format` 和联合 schema 在 invoke 时不做强制；逐字 schema 是给 agent/manifest 的指引，不是一道完整的 JSON-Schema invoke 门。
:::

因此，共同的条目形状不要求源抹去自己的协议细节。MCP 的原生内容留在条目里，核心仍围绕 `CapabilityEntry` 工作；看其他扩展时，也可以从这个共同形状接着读。


### 用户扩展如何产出相同的形状 {#用户扩展如何产出相同的形状}

用户扩展先列出自己提供哪些 capability。这份声明就是 `ExtensionManifest`（`types.ts §1b`）。网关据此物化出一个 `CapabilitySource`，再由它的 `scan()` 把每条声明投影成相同的 `CapabilityEntry`。“一句话打开一个 Obsidian vault”的流程就会生成这样的条目。扩展经 `POST /extensions`（§2）注册，因而 Flow B 可以端到端演示：定制写成扩展，扩展被自动发现。

在条目消费这一层，agent 分辨不出——也不必分辨——first-party 适配器、导入的 MCP 工具和用户扩展：三者都只是条目。这里的 MCP 条目仍指前述设计契约，不表示用户导入路径已经发布。

形状相同，不等于来源和授权相同。条目仍保留来源信息；敏感度由来源、授权动词和 transport 共同决定。注册扩展不能自行声明保留的 first-party 身份，也不会因为进入共同模型就获得 first-party 信任。自动发现同样不等于获准调用。

本地服务凭据则留在条目之外。例如 Obsidian Local REST API 的 bearer 密钥，声明时使用 `ExtensionSecretRef`，到派发时才经平台接缝 `PlatformServices.resolveSecret` 从 `~/.plexus/secrets/` 解析。凭据本身从不出现在条目、manifest、`.well-known` 或审计里。声明范例见 [`extension-manifest.obsidian.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/extension-manifest.obsidian.json)。

条目范例可以对照着看：[`obsidian.vault.read.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/obsidian.vault.read.json) 来自用户扩展，采用 `kind:"capability"`、`transport:"local-rest"`，只读；[`orchestrator.pipeline.run.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/orchestrator.pipeline.run.json) 则是 first-party 编排，采用 `kind:"workflow"`、`transport:"workflow"`、`grants:["execute"]`，并带有 `members`。


## §2 —— 端点契约 {#§2-——-端点契约}

所有端点默认绑定回环地址，默认 URL 为 `http://127.0.0.1:7077`。也可以通过 `~/.plexus/network.json` 选择绑定某个 NIC 或 `0.0.0.0`，但须主动启用；开放到 LAN 后，connection-key 是管理访问的信任边界，agent 仍使用自己的 PAT（见 §5）。所有错误统一放在 `ErrorResponse` 信封中。

### `GET /.well-known/plexus` → 发现（未认证、预会话） {#get-well-known-plexus-→-发现-未认证、预会话}

这个入口不要求认证，也不要求已有会话。它回答“我如何获得授权”，不回答“这里有什么”：响应给出网关身份、各生命周期与 auth 端点的 URL、enrollment 请求和返回值的形状，再用 `capabilitiesVia` 指向 enroll + handshake。它公布的是接入办法，不是凭据或 capability 目录。

目录是授权的产物。handshake 返回的 manifest 按 agent 过滤，只包含所有者授权且仍然暴露的 capability 子集，并带上完整 schema 与 skill 主体；agent 不会从中得知 Plexus 还有更多条目。这里的“授权”说的是获准看见哪些条目，不是已经持有调用 token。取得 scoped grant/token、实际 invoke，是后面的步骤；所有者关闭某项 capability 的暴露后，它也不能再被发现或授权。

这与 MCP 的比较，应落在发现入口的职责上。MCP 的 `server/discover`，以及自 `2026-07-28` 起的 `.well-known/mcp.json` server card，面向 server 的能力描述；Plexus 在这里说明 agent 怎样取得自己的授权视图，刻意不广播目录。这不意味着 MCP 没有安全机制：它已有基于 OAuth 的授权框架、授权服务器发现、scopes 和 access-token 校验。Plexus 的具体区别是所有者批准、按 capability 执行的策略与账本，而不是“只有 Plexus 才有授权”。

响应示例如下；其中的版本、地址和字段值仅用于说明：

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

`auth` 块让客户端不必猜路径或认证方案。已经兑换 enroll 码并保存 PAT 的冷启动 agent，从中读取 `handshakeUrl`，出示 `Bearer plx_agent_…`，再读取 `grantRequestUrl`、`grantRequestMethod` 和 `sessionHeader`。`enrollment` 则说明一次性码如何兑换 PAT（见下）：PAT 只返回一次，由 agent 自行保存，后续会话继续用它认证。

这里没有 `connectionKey` 字段。`connectionKeyDelivery` 只描述所有者如何带外收到 connection-key；示例中的 `user-paste` 是所有者侧的交付说明，不是 agent 凭据字段，也不是让 agent 索取密钥的接口。connection-key 只用于管理员路径，从不作为 agent 凭据广告，agent 也不持有它（§5）。

::: info 端点命名空间约定（ADR-016）
agent 的每一个端点 URL 都从这个 `auth` 广告里读取，不得硬编码。agent 平面使用扁平命名空间：`/agents/enroll` 是预会话、码门控入口，`/link/handshake` 对 agent 使用 PAT 门控，其余包括 `/grants`、`/grants/refresh`、`/grants/revoke`、`/grants/status`、`/invoke`、`/manifest`、`/events`、`/extensions`。

所有者的管理 API 单独放在 `/admin/api/*` 下，由 connection-key 门控，agent 无权访问（§5）。这一命名空间约定不取消另行说明的管理员 handshake 路径；管理员握手仍属于所有者凭据流程，不能当作 agent 使用 PAT 的替代办法。
:::


### `POST /agents/enroll` → 用一次性码兑换持久 PAT {#post-agents-enroll-→-用一次性码兑换持久-pat-码门控}

第一次 handshake 之前，agent 先完成一次 enroll。它出示的不是自己选择的身份，而是所有者通过安装命令带外交给它的一次性码（§5）。码以 `plx_enroll_…` 开头，约 15 分钟有效，只能使用一次；对应的 `agentId` 已在服务端绑定，不能由 agent 自行声明。

请求：

```json
{ "code": "plx_enroll_2b7d…c90" }
```

响应：

```json
{ "pat": "plx_agent_9f1a…44e", "agentId": "agent-ez-1" }
```

兑换成功后，网关返回这个 agent 独有的持久 PAT（`plx_agent_…`）。明文恰好返回一次，服务端只存静态哈希。PAT 由 agent 按自己的方式保管，权限设为 `0600`，此后每次 handshake 都要出示。

码在兑换成功时才被消费，再次提交会返回 `code_consumed`。任何失败都不会放行，失败原因包括 `malformed`、`unknown_code`、`code_expired`、`code_consumed` 和 `persist_failed`。其中 `persist_failed` 是可重试的例外：持久写入失败时，码仍保持未消费状态。

这个端点绝不接受 connection-key。

### `POST /link/handshake` → 凭 PAT 建立会话，取得授权子集 manifest {#post-link-handshake-→-授权子集-manifest-对-agent-是-pat-门控}

enroll 把持久凭据交给 agent，handshake 则用这份凭据确认本次会话的身份。agent 在请求头中出示 `Authorization: Bearer plx_agent_…`，body 里没有 `connectionKey`。网关核验 PAT，从中解析真实的 `agentId`，再创建绑定到该 id 的会话。即使请求带了 `client.agentId`，它也只是元数据，会被强制改写为已核验的 id（§4d）。

返回的 manifest 只列出这个 agent 的授权子集：所有者选定的 capability，以及所有者签发的常驻授权所覆盖的条目，都必须仍处于暴露状态。过滤的是目录范围，不是条目细节。每项仍带有完整的 `describe`、`io` schema、`grants`、`transport`、附着的 skill 主体和 MCP 直通内容。

::: info 管理员路径（不是 agent 路径）
同一端点也接受所有者在 JSON body 中提交 `{ "connectionKey": "plx_live_…" }`，不带 Bearer。这是控制台使用的权威路径，可以合法点名一个 `agentId`。

两条路径按出示的凭据区分，不能互相穿透。agent 没有 connection-key，不能通过改写 body 进入管理员路径。
:::

请求，请求头为 `Authorization: Bearer plx_agent_9f1a…44e`：

```json
{
  "client": { "name": "claude-code", "version": "2.x" }
}
```

响应（节略）：

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

到这里，agent 已经知道有哪些条目、该怎样使用，但手里还没有任何受限 token。handshake 交付的是只读知识，带来的调用权威为零；调用仍然默认拒绝。知道怎么调用，不等于获准调用。

取得限定范围的 grant/token 是下一步。已有且符合条件的常驻授权可以支持这一步，不必再问所有者一次；这不表示 handshake 本身签发了不受限制的调用许可。

`manifest.revision` 是单调计数器。agent 将它与 `manifest_changed` 事件对比，判断当前视图是否已经过期；刷新办法见 §2 的 manifest 刷新说明。


### `PUT /grants` → 按 capability 取得受限 token {#put-grants-→-受限-token-按-capability}

agent 或通过管理客户端操作的用户，在这里指定要授权的条目和动词。网关先检查请求是否在允许的范围内，再交给配置的 `Authorizer` 裁决。获准的条目由受限 token 覆盖；需要等待所有者决定的授权，则返回 `grant_pending_user`。

::: info 授权规则（ADR-007 已修订）
子集检查在 `Authorizer` 之前。受限（scoped）agent 请求所有者声明的子集之外的 capability，除非已有所有者签发的常驻授权覆盖，否则直接拒绝，并记入审计轨迹。这样的请求绝不挂起，也不会向所有者弹出确认卡片。连接时定义子集的管理员权威路径不受这道门限制。

通过范围检查后，授权裁决由可插拔的 `Authorizer` 完成：输入是授权请求和上下文，输出为 `allow | deny | pending`。已发布的默认实现是采用 `confirm-risky` 模式的 `UserConfirmAuthorizer`。所有者连接时勾选的 `read` 会获得常驻授权，符合条件时直接放行，不必重复确认。其他符合条件的所有者常驻授权也可免去再次询问。

没有常驻授权覆盖时，`write` / `execute` 等有副作用的请求，以及 `extension` 来源上的任何授权，都要挂起等待所有者批准。这是默认的逐次确认，并不等于所有写入和执行永远都要弹卡。

所有者可以为特定 agent/capability 显式设置常驻授权。`write` 也可在批准挂起请求时通过真正的信任窗口成为常驻授权，或由所有者直接授予。`execute` 的条件不同：必须由所有者专门开启常驻选项，agent 不能自行解除这一限制。

完全宽松的 `AutoApproveAuthorizer` 也已存在，部分内部和测试流程在用，可以直接替换，但它不是面向 agent 的默认值。两种策略使用同一套 wire；`grant_pending_user` 和 `GET /grants/status` 轮询通道已用于默认策略下需要确认的变更类授权，替换 `Authorizer` 无需修改 wire。
:::

请求：

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

`"allow"` 是只读简写，归一化后采用默认的 `read`，并不表示允许条目的所有动词。示例中，github 条目显式请求 `write`，orchestrator 的 workflow 显式请求 `execute`。

批准后的响应如下。除了请求中的三个条目，还包含为 workflow 合成的传递性成员作用域：

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

传递性授权（评审 #5，ADR-012）的机制是：授予 workflow 时，网关合成成员作用域，标记 `synthesizedFor`，一并写入 token。派发到成员时，仍沿同一管线检查作用域，不会静默升级。每个成员 id 都必须是注册表里实际存在的条目。

`transitive` 块也是管理客户端确认授权时向所有者展示的内容。用户需要知道自己批准的不只是一个 workflow 名称，还包括它将调用的成员及各自的动词，例如“……它也会运行 board.create / agent.dispatch / board.status”。上例展示的则是 `orchestrator.plan.create`、`orchestrator.task.dispatch` 和 `orchestrator.plan.status`。

需要所有者确认、`Authorizer` 暂缓裁决时，响应为：

```json
{
  "status": "grant_pending_user",
  "pendingId": "pend_01J…",
  "pending": ["orchestrator.pipeline.run"],
  "statusUrl": "http://127.0.0.1:7077/grants/status?pendingId=pend_01J…"
}
```

这不只是更严格的自定义策略才会返回的结果。默认 `confirm-risky` 下，未被符合条件的常驻授权覆盖的变更类请求，正常就会走到这里。agent 随后轮询 `GET /grants/status`（见下），或等待 `grant_resolved` 事件。


### `GET /grants/status?pendingId=…` → 查询待批授权的结果（评审 #9） {#get-grants-status-pendingid-→-解析待批授权-评审-9}

这条查询通道让 `grant_pending_user` 不会成为死胡同。agent 用 `pendingId` 轮询，直到 `state` 进入终局；若结果为 `"approved"`，响应中就带有批准后铸出的 token，不必另找领取入口。

每次查询都要验证读取权限。agent 必须通过 `X-Plexus-Session` 出示创建这条待批请求的原会话；所有者则可通过 `X-Plexus-Connection-Key` 出示有效的管理 connection-key。其他调用方，包括使用不同会话或只持有 `pendingId` 的人，都会收到 `403`，不会拿到 token。

响应：

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

### `POST /grants/refresh` → 凭常驻授权重铸 token（评审 #4） {#post-grants-refresh-→-授权背书的-token-重铸-评审-4}

受限 token 的生命期默认为 15 分钟，可在 1 至 60 分钟内配置，并非固定值。多步 workflow 却可能运行超过 24 小时。agent 不需要为此持有一个同样长寿的调用 token：在符合条件的常驻授权支持下，refresh 可以重铸短期 token，保留原来获准的作用域和约束，不扩大权限，也不重新提示所有者。

refresh 不需要 connection-key。调用侧保留短 token 和 refresh 句柄；agent 另行保管自己的 PAT，用于后续握手，从不保留所有者的 connection-key。

请求，请求头为 `Authorization: Bearer <expiring-token>`：

```json
{ "sessionId": "sess_01J…", "jti": "tok_01J…" }
```

响应：

```json
{
  "token": "eyJ…newtoken…",
  "jti": "tok_03L…",
  "expiresAt": "2026-06-23T11:30:00.000Z",
  "scopes": [ { "id": "orchestrator.pipeline.run", "verbs": ["execute"] } ],
  "grantExpiresAt": "2026-06-25T10:00:00.000Z"
}
```

响应给出新 `token`、新 `jti`、token 到期时间 `expiresAt`、作用域 `scopes`，以及授权到期时间 `grantExpiresAt`。重铸成功后，旧 `jti` 随即被撤销。`grantExpiresAt` 一过，refresh 就失效，agent 必须重新 `PUT /grants`。

前置条件缺一不可：会话仍存活（§5），符合刷新条件的常驻授权仍在、未被撤销，而且仍处于授权有效窗口内。`once` 授权不能 refresh。授权尚未到期，也不能救活已经结束的会话。

长流程跨越会话边界时，要用 PAT 重新 handshake，取得新会话，再取得该会话可用的受限 token；不能靠不断 refresh 延长旧会话。已有且符合条件的常驻授权仍可支持取 token，不必再次询问所有者。长时运行流程见 §5。

### `POST /grants/revoke` → 撤销 token 或移除授权（评审 #3） {#post-grants-revoke-→-撤销-token-或授权-评审-3}

管理客户端可以触发“立即撤销”，agent 也可以主动交回自己的 token。两者的权力不同：交回自己的 token 不等于有权删除常驻授权；移除授权必须经过所有者授权。选择器有以下两种形态。

按 `jti` 撤销 token：

```json
{ "jti": "tok_01J…", "reason": "user revoked from management client" }
```

按 scope 选择 agent/capability 对，同时移除对应的常驻授权。移除后，refresh 不能再凭这份授权铸出新 token：

```json
{ "agentId": "agent-ez-1", "capabilityId": "orchestrator.pipeline.run" }
```

这两个选择器分别针对 token 和指定范围的授权，都不等于撤销 agent 身份。不能把交回一个 token、移除一份授权和撤销整个 agent 当成同一项操作。

响应：

```json
{ "ok": true, "revokedJtis": ["tok_01J…", "tok_03L…"], "grantRemoved": true, "auditId": "evt_09Z…" }
```

执行中 workflow 的规则（评审 #3）：编排器在每次成员派发之前，重新检查发起 `jti` 的撤销状态。因此，扇出中途发生撤销，会中止其余成员的派发；已经完成的派发留在审计里，不回滚。
### `POST /invoke` → 调用已授权的 capability {#post-invoke-→-调用一个已授权的-capability}

agent 调用一个 capability/workflow 时，把受限 token 作为 `Authorization: Bearer <token>` 出示。持有 token 并不意味着请求可以直接派发；网关按下面的顺序检查，前一道未通过，就不能进入后面的调用路径。

1. 先执行 Host/Origin 守卫（§5），在认证和其他检查之前拦住不符合要求的请求。
2. 核验 JWT 签名与过期时间，确认 `jti` 未被撤销，而且会话仍然存活（评审 #8）。token 尚未过期，不能替代存活的会话。
3. 检查所有者是否仍允许暴露这项 capability。关闭暴露是一道独立的否决：即使已有有效 grant，也不能绕过它。这一步先于 grant 覆盖检查。
4. 确认作用域覆盖该 `id`，并包含条目所需的每一个动词，而不只是其中一个。若作用域带有签入 token 的 `constraint`（`ScopeConstraint`），还须用 `constraintSatisfied` 确认本次 `input` 满足约束。不满足时，该作用域不生效；没有有效作用域覆盖的调用默认拒绝，返回 `grant_required`。见 §4 内容感知授权。
5. 授权通过后，再对照 `io.input` 轻量校验 `input`：检查必需键、顶层原语类型，以及可选启用的 `additionalProperties` 限制。这不是完整 JSON Schema 校验，边界见 §1 的 schema 校验注记。
6. 路由到拥有该条目的 `CapabilityBridge`，再进入 `Transport.dispatch()`。路由由注册表和 transport 驱动，不靠 `if (id===…)` 逐项分支。
7. 写入一条脱敏审计事件，再返回归一化的 `InvokeResponse`。MCP 条目的工具、资源和提示结果都逐字保留在 `mcpResult` 中，不因归一化丢掉原生字段。

普通请求，请求头为 `Authorization: Bearer eyJ…`：

```json
{ "id": "obsidian.vault.read", "input": { "query": "Plexus protocol decisions", "limit": 5 } }
```

响应用 `output` 承载结果，`auditId` 指向本次审计事件：

```json
{
  "id": "obsidian.vault.read",
  "ok": true,
  "output": { "notes": [ { "path": "Projects/Plexus.md", "title": "Plexus", "content": "…" } ] },
  "auditId": "evt_01J…"
}
```

MCP 工具响应（`transport:"mcp"`）保留逐字 `mcpResult`，其中可同时包含 `content` 和 `structuredContent`：

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

这里说明的是 MCP 传输契约，仍受前述导入限制约束：transport/客户端层已实现，面向用户的 MCP 服务器导入路径尚未发布。

MCP 服务器返回 `isError:true` 时，映射为 `ok:false`、`error.code:"mcp_tool_error"`；服务器的 `content[]` 仍保留在 `mcpResult.content` 里，不会被错误映射替换。资源读取填充 `mcpResult.contents[]`，提示获取填充 `mcpResult.messages[]`，各自保留原生结果形状。


#### `/invoke` 的单一结果契约（v0.1.1 —— tp2 / ADR-017） {#invoke-上的单一结果契约-v0-1-1-——-tp2-adr-017}

`/invoke` 总是返回 `InvokeResponse` 形状的 body。成功如此，每一次拒绝也如此，包括 auth 或派发之前的失败：无 token、`grant_required`、`token_revoked` / `token_expired`、`session_expired`、`unknown_capability`、`schema_validation_failed`。这项保证只适用于 `/invoke`，其余端点仍使用 `ErrorResponse`。

拒绝响应示例：

```json
{
  "id": "orchestrator.pipeline.run",
  "ok": false,
  "error": { "code": "grant_required", "message": "No grant for orchestrator.pipeline.run (execute).",
             "capabilityId": "orchestrator.pipeline.run" },
  "auditId": "evt_03L…"
}
```

`auditId` 是否为空，取决于拒绝发生在哪里。已经审计的拒绝会返回审计事件 id；管线内每一次派发前拒绝都会被审计。若请求在进入管线审计之前就失败，例如没有 token、token 畸形，或 body 无法解析，`auditId` 则为 `""`。空字符串与审计事件 id 必须分开处理。

body 形状一致，不表示 HTTP 状态也一致。按状态码处理回复的 agent，仍可用下表区分失败：

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

其中，`mcp_tool_error` 和 `transport_error` 是带内派发失败，HTTP 状态仍为 `200`，不能改按常见的服务器错误状态处理。调用是否成功，要读取 body 中的 `ok`。

::: info 单一形状适用的范围
“只返回 `InvokeResponse`”这条规则仅限 `/invoke`。其余端点失败时，仍返回统一的 `ErrorResponse` 信封，即 `{ error:{…} }`（§7）。

`/invoke` 的成功 body 本来就是 `InvokeResponse`。让拒绝也使用这个形状，是为了让 agent 最常走的调用路径不必按成功或拒绝切换解析类型，并非更换所有端点的错误信封。
:::

::: info 路由注记（workflow 与 MCP）
`kind:"workflow"` 的 invoke 路由到 `WorkflowTransport`。它通过 `invokeById`，让每个成员重入统一的 invoke 管线；核心从不按 `kind:"workflow"` 分支（评审 #6，§6）。每次成员调用都要对照合成作用域检查范围，并单独审计。

`transport:"mcp"` 的 invoke 路由到 `McpTransport`，再按 `mcp.primitive` 选择 `tools/call`、`resources/read` 或 `prompts/get`。服务器的原生结果逐字保留在 `mcpResult` 中。
:::

实现解析器时，agent 可以把每个 `/invoke` 回复都反序列化为 `InvokeResponse`：拒绝时读到的一定是 `ok:false`，不会是 `ok === undefined`。`error.code` 来自封闭的 `ErrorCode` 联合类型（§7），agent 据此确定性地选择 refresh、re-grant、re-handshake 或放弃。


### 异步 invoke —— 先取得执行句柄（v0.1.4 —— ADR-029） {#async-invoke}

一次 `codex.run` / `claudecode.run` 任务可能要跑几分钟，连接却未必等得了那么久。隧道、代理，或 agent 自己的 HTTP 超时，只要其中一跳先到时限，agent 收到的就是那一跳的回复。网关仍可能把任务做完、记完账，却已经无处投递结果。这时重新调用，会启动第二次真实执行。

同步等待把调用方的连接当成了结果的容器。异步 invoke 把等待结果从这条连接上分开，但不改变原有调用的默认方式：这是 opt-in 的加性扩展。请求带上 `async:true`，并通过全部派发前检查后，网关先返回 HTTP `202`，表示受理：

```json
{
  "id": "codex.run",
  "ok": true,
  "auditId": "",
  "run": {
    "runId": "run_9f1a…44e",
    "status": "running",
    "statusUrl": "http://127.0.0.1:7077/invoke/status?runId=run_9f1a…44e",
    "startedAt": "2026-08-14T00:41:00.000Z",
    "expiresAt": "2026-08-14T01:41:00.000Z"
  }
}
```

这里的 `ok:true` 是已受理，不是已完成。判据是响应中有 `run`，而没有 `output`。`runId` 标识这次执行，`status` 给出当前状态，`statusUrl` 指向查询地址，`startedAt` 和 `expiresAt` 分别给出开始与到期时间。此时不能把空的 `auditId` 当成完成凭据。

运行时间较长、适合走这条路径的条目，会在 manifest 中带上 `longRunning: true`；编译出的 launcher 应当据此替 agent 自动加上 `async`，不必让 agent 每次自行判断。

::: tip discovery 也要说明异步用法
`auth.requestShapes.invoke.body` 会公布 `async` 字段，同时说明触发条件（`longRunning`）、返回什么，以及去哪里取结果；`auth.requestShapes.invokeStatus` 则描述取结果的请求。

这些说明必须出现在机器可读的 discovery 中。冷启动 agent 按 request shape 构造请求，只写在正文里的调用方式，它可能根本不会使用。同样，每个 `longRunning` capability 的 `describe` 都把“怎么调”放在“等审批”之前。
:::

::: tip 异步不改变授权检查
异步路径执行同一批派发前检查，顺序也完全相同。拒绝立即原地返回，按同步路径的规则照常审计；拒绝响应与同步路径逐字节一致，HTTP 状态不变，也不会创建任何 run。进入管线审计之前的失败，仍适用前述空 `auditId` 的规则。

从请求等待中分离出去的只有派发本身。执行完成时，审计与同步调用完全一样。
:::

连接不再被长任务占住，也不能因此放开无限并发。一个 agent 最多同时持有 8 个运行中的 invoke，超出即返回 `rate_limited`。这保留了必要的背压，而不是把原先“每次调用占一条连接”的限制直接拿掉。

run 记录与 session 一样保存在内存中，随进程存亡。持久留下的是审计记录，不是结果缓存。这条通道要求用受限 token 调用；grant-assist，也就是只有会话、没有 token 的调用，仍保持同步。

异步也不等于免疫所有网络故障，更不提供尚未实现的 idempotency-key 去重。拿到受理响应后，agent 下一步要做的不是重发 invoke，而是沿返回的 `statusUrl` 查询：执行句柄已经在手，结果还需要另一次请求来取。


### `GET /invoke/status?runId=…` → 取回异步 invoke 的结果（v0.1.4 —— ADR-029） {#get-invoke-status-runid-→-取回异步-invoke-的结果-v0-1-4-——-adr-029}

查询返回执行句柄；run 一旦落定，还会返回同步调用本会给出的完整 `InvokeResponse`。这包括派发失败时的 `ok:false` 和 `error`，`auditId` 也与同步调用相同。客户端取到的不是另一份结果摘要，而是原来的调用结果。异步改变的是交付方式，没有另建一套结果契约。

句柄是定位符，不是凭据。只有 `runId`，不能取得任何读取权限。每次查询都重新认证，只接受所有者的管理 connection-key，或者这次 run 绑定的同一个 agent 的凭据：它的受限 token，或仍然存活的 `X-Plexus-Session`。先前成功读过一次，不会免去下一次读取的身份检查。

这里绑定的是 `agentId`，不是受理请求时的那个 session。一次 run 可以合法地跨过一个最长 60 分钟的会话片段，见 [ADR-028](/zh/architecture/security-model)。若把结果绑死在旧 session 上，agent 按要求重新 handshake 后，反而无法取回自己发起的任务结果。按 `agentId` 绑定，新会话仍能证明它是原来的 agent。

同时接受 token 和存活会话，也是为了跨越凭据更新的边界。受限 token 默认 15 分钟到期，可配置为 1 至 60 分钟；session 的生命期则是 60 分钟。取结果不应要求受理时的 token 和 session 一直活到工作完成，但读取时出示的凭据必须仍然有效。

::: warning 不泄露 run 是否存在
换成另一个 agent、只拿到一个 `runId`、出示已撤销的 token，或使用已失效的 session，返回的都与未知 `runId` 完全相同：`403`。调用方不能靠这些回复探测某次执行是否存在。

撤销某个 token 后，凭该 token 发起的下一次调用不会再被受理，也不能再凭它取走已完成的结果；这不等于同时撤销该 agent 的其他凭据或其他 agent 的权限。撤销对应授权，也只影响该授权覆盖的范围。撤销不会中止已经派发出去的工作，正如它不会中止一次正在执行的同步调用。
:::

在 `expiresAt` 之前，读取是幂等且可重复的，前提是每次都通过认证。结果不会因为被读过就消失。若只能领取一次，读取回复一旦丢失，客户端就再也拿不到结果，异步通道原本要解决的“回包丢失即工作丢失”便又回来了。

`expiresAt` 限制的是结果保留时间，不是执行时长。运行中的记录永不回收，不能因受理时给出的时间已到就删除；run 落定后，保留窗口按真实完成时间重新计算。因此，任务运行多久与完成后还能读取多久，是两个不同的期限。

已持有 `GET /events` 流的 agent 可以不轮询，等 run 落定时收到 `invoke_resolved`，再去取结果。通知不带 `output`：它会向所有打开的流扇出，而在 agent 侧，结果只有发起调用的那个 agent 能读到；所有者仍可凭管理 connection-key 读取。


### `GET /manifest` → 刷新 manifest 快照（评审 #9） {#get-manifest-→-刷新-manifest-快照-评审-9}

handshake 的 manifest 是一次性快照。会话还在继续，条目集却可能变化：源上线、扩展注册，或设计中的 MCP `list_changed`，都需要更新视图；MCP 用户导入路径仍未发布。agent 无需重新 handshake，只要通过会话认证，例如 `X-Plexus-Session: <sessionId>`，就能取回当前获准可见且仍暴露的子集。响应为 `{ manifest }`；条目集变化后，`manifest.revision` 随之推进。

确定序与新鲜度是追加式约定，各管一件事。`entries` 始终按 `id` 排序，使相同内容的序列化不受重启、重扫或源启动顺序影响，保持字节稳定。“重取但无变化”时，agent 的 prompt cache 因而仍然有效。`revision` 则用于辨认视图是否有变化，不是排序依据。

`Manifest.ttlMs` 给纯拉取消费方提示重取时间：没有事件流的 in-context agent，超过该时长就重新拉取。推送消费方仍优先使用 `manifest_changed` + `revision`。

这个时长仅供参考。授权在 grant/invoke 时由网关实时强制执行，过期的 manifest 从来不是安全问题，也不能让已经失效的权限重新生效。

### `GET /grants` → 常驻授权账本（ADR-018，v0.1.2，会话认证） {#get-grants-→-常驻授权账本-adr-018-v0-1-2-会话认证}

manifest 回答能看见什么，这个端点回答调用方有哪些常驻授权。常驻授权是持久的、经人批准的信任，不是默认 15 分钟有效的 token。它与用户 Grants 屏相对应，但普通 agent 看到的是自己的授权；管理会话才拿到全部常驻授权。

认证方式与 `GET /manifest` 完全相同。端点经 `AuthAdvertisement.grantsListUrl` 广告，返回 `GrantsListResponse { grants: StandingGrant[] }`，具体形状与信任模型见 §4d。管理 UI 另走管理密钥门控的 `GET /admin/api/grants`，不要把这个所有者账本入口与 agent 视图混用。

### `GET /events` → 实时事件流（SSE）（评审 #9） {#get-events-→-实时事件流-sse-评审-9}

这是承载 `PlexusEvent` 的 Server-Sent Events 流。agent 可以等待通知，不必轮询这些变化：

- `manifest_changed`：携带新的 `revision`，收到后重新请求 `GET /manifest`。
- `grant_resolved`：某条待批授权已有裁决；批准时附上 token。
- `token_revoked`：手中的某个 token 已被撤销，必须立即停用。
- `source_status`：某个源的可用性发生变化，供诊断使用。

### `POST /extensions` → 注册一个用户扩展（评审 #次要，Flow B） {#post-extensions-→-注册一个用户扩展-评审-次要-flow-b}

此端点接受一个 `ExtensionManifest`。网关据此物化 `CapabilitySource`，将条目投影进注册表，并触发 `manifest_changed`，让会话中的客户端更新视图。

请求使用会话认证；会话本身就是这次注册所需的用户授权。

请求：

```json
{ "sessionId": "sess_01J…", "manifest": { "manifest": "plexus-extension/0.1", "source": "obsidian", "...": "see examples/extension-manifest.obsidian.json" } }
```

响应：

```json
{ "ok": true, "source": "obsidian", "registered": ["obsidian.vault.read"], "revision": 8 }
```

注册成功只表示条目进入注册表。扩展不能自行声明保留的 first-party 来源身份，也不会因为被列出就得到调用许可。真正调用时，仍要经过授权检查，再由条目所属的 `CapabilityBridge` 接到 `Transport.dispatch()`；注册表中的共同形状，就在这里连向具体派发。


## §3 —— Transport 抽象 {#§3-——-transport-抽象}

bridge 只调用 `dispatch()`，实际怎样触达软件，由适配器层按种类实现 `Transport` 接口。新增一个 transport，只需实现并注册，绝不修改调用方。`ctx` 仅在可重入的 transport 中传入。

```ts
interface Transport {
  readonly kind: TransportKind;
  dispatch(entry, input, ctx?): Promise<TransportResult>;   // ctx present only for re-entrant transports
}
```

第一批种类已由 ADR-003 锁定：`local-rest | stdio | ipc | mcp | cli`。另有 `skill`、`workflow` 两个非 wire 哨兵；它们不代表新的通信协议。

| kind | wire | 说明 |
|---|---|---|
| `local-rest` | HTTP，连接 app 暴露的 localhost 服务 | 例如 Obsidian Local REST API。端点和 bearer 凭据都经平台接缝取得。 |
| `stdio` | 生成子进程，在 stdin/stdout 上传输 NDJSON | 通用的非 MCP stdio 适配器。 |
| `ipc` | unix socket / 命名管道 / osascript 桥 | OS 专属实现留在平台接缝后面。 |
| `mcp` | 享有特权：Plexus 自己运行一个 MCP 客户端 | 按 `mcp.primitive` 派发，见下。 |
| `cli` | 用 argv 调用二进制，捕获 stdout（可选 `--format json`） | 二进制由 path-resolver 解析。 |
| `skill` | （无） | 哨兵：将主体作为上下文交付。 |
| `workflow` | （无） | 对每个成员重入 invoke 管线，见下。 |

### `mcp` transport 的执行方式（评审 #1/#2） {#mcp-transport-具体说-评审-1-2}

::: warning 实现状态
下面的 transport/客户端层已经实现并测试，但生产注册表 `MODULES` 中没有注册 MCP 源，也尚未发布把一个 MCP 服务器包成一个源的接入路径。见 [`KNOWN-LIMITATIONS.md`](https://github.com/nemori-ai/plexus/blob/main/docs/KNOWN-LIMITATIONS.md)。
:::

`McpTransport extends Transport`。这里 Plexus 是 MCP 客户端，收到条目后，按 `entry.mcp.primitive` 决定执行哪一种原语，而不是把所有请求都当成工具调用。

下面完整列出 scan 与 invoke 的对应关系。初始化部分描述的是已交付的 legacy 客户端：先交换 `clientInfo` 和 capabilities，取得服务器 capabilities，再发 `notifications/initialized`。这不是当前 MCP 协议的普遍要求。

```
scan():   initialize(serverId)              // clientInfo+caps → server caps; then notifications/initialized
          list(serverId)                    // tools/list + resources/list + prompts/list — PAGED TO EXHAUSTION
          → re-project each primitive to a CapabilityEntry (schemas VERBATIM, mcp.raw kept)
invoke(): primitive "tool"     → call(serverId, originName=tool-name, args)  // tools/call
          primitive "resource" → readResource(serverId, uri=originName)      // resources/read
          primitive "prompt"   → getPrompt(serverId, name=originName, args)  // prompts/get
          → TransportResult { ok, mcpResult: { content?|contents?|messages?, structuredContent?, isError? } }  // VERBATIM
```

scan 会把三类列表逐页取尽，再按前述映射投影为 `CapabilityEntry`，schema 逐字保留，`mcp.raw` 也留下。invoke 则使用各自的原生入口和参数：工具名、资源 URI、提示名都从 `originName` 取得，工具和提示另带 `args`。

返回值仍保留原生形状：工具的 `content[]`、`structuredContent` 和 `isError`，资源的 `contents[]`，提示的 `messages[]`，都原样放入 `mcpResult`。若服务器返回 `isError:true`，Plexus 映射为 `ok:false` 和 `error.code:"mcp_tool_error"`，但不丢掉 `content[]`。

客户端的生命周期由源拥有，不属于某一次请求。持久 MCP 客户端由 `CapabilitySource.start()` 拥有，在请求作用域的 invoke 之间复用；会话丢失时重新初始化。

MCP transport 内部使用 stdio 或 Streamable HTTP，具体连接细节不交给 bridge。已交付的 legacy 客户端在 Streamable HTTP 下使用 `/mcp` 和 `Mcp-Session-Id` 头；MCP `2026-07-28` 修订已移除协议层初始化握手和会话头，不能把这里的实现流程当成新版要求。应用状态仍可跨请求保留。

收到 `notifications/.../list_changed` 后，变化经 `CapabilitySource.onEntriesChanged` 上报，再向 agent 发出 `manifest_changed` 事件。


### `workflow` transport：编排器只是一个 transport（评审 #6） {#workflow-transport-具体说-——-编排器-只是一个-transport-评审-6}

没有对外 wire。`WorkflowTransport.dispatch` 接收 `TransportDispatchContext`，通过 `invokeById` 调用 `entry.members[]` 中的每个成员。这里的“重入”，就是把成员调用送回统一的 invoke 管线，而不是由编排器直接触达成员背后的软件。

因此，网关核心从不出现 `if (kind === "workflow")` 分支。扇出虽然由编排器组织，展开后的每一次调用却仍是普通调用：作用域检查、撤销检查和审计，都走与其他调用完全相同的路径。编排器负责组织成员，不获得绕过这些检查的特权。

成员所用的权限也不在派发时临时扩大。每次成员派发，都要对照同一个 token 上携带的合成传递性作用域检查。这些作用域就是 §2 grants 中已经说明的、授予 workflow 时合成并写入 token 的成员作用域；重入只是使用它们，不会因为某个成员属于 workflow，就静默升级权限。

检查还必须发生在每个成员真正派发之前。管线每次都重新检查发起 `jti` 的撤销状态（评审 #3），不能把 workflow 开始时的一次检查当成整个扇出的通行证。若扇出中途撤销了这个 `jti`，其余尚未派发的成员便停止派发。这里中止的是后续派发，不是取消已经运行的成员，也不是回滚已经完成的工作。

另一种方案，是把编排器建模为 first-party `CapabilitySource`。ADR-013 记录了两种方案的取舍；采用 transport 重入，理由就在于让成员始终留在完全相同的执行路径上。编排改变了调用的组织方式，成员调用所依据的作用域和撤销状态，仍由同一条管线核验。


## §4 —— 受限 token 模型 {#§4-——-受限-token-模型}

受限 token 采用已签名 JWT（HS256，秘密由网关持有），配合服务端撤销注册表（ADR-006）。签名检查自包含、无状态，但服务端仍追踪每个 `jti`，因此不必等 token 到期才能撤销。对 agent 而言，token 是不透明的；它只需出示那串紧凑的 Bearer 字符串。

作用域形状为 `scopes: { id, verbs[], synthesizedFor?, constraint? }[]`，token 的权限恰好是这些作用域的并集。在作用域覆盖这一关，必须有作用域覆盖目标 `id`，并包含条目所需的每一个动词，不能只满足其中一个。默认授予最小、只读权限，简写 `"allow"` 只授予 `["read"]`。带 `synthesizedFor` 的则是为 workflow 合成的传递性成员作用域，见 §2。

覆盖还可以限定到调用内容（AUTHZ-UX §3.1）。作用域或授权可带可选的 `constraint`（`ScopeConstraint`），它只能收窄权限，不能扩大权限。网关用 `constraintSatisfied` 检查本次调用的 `input`；只有满足约束，这个作用域才对本次调用生效。否则它不提供覆盖，没有其他有效作用域时，调用默认拒绝，返回 `grant_required`。输入字段缺失、畸形，或约束操作不受支持，都按失败即关闭处理，不会略过检查。

强制执行的约束随 JWT 的 `scopes` 一起签名下发。每次调用都在同一个 `POST /invoke` 入口检查，即上文调用管线的第 4 步；约束只能取自已核验的 token，绝不取自请求 body。不带约束时，仍是原来的整 capability 作用域，这一点不变。

token 的生命期默认为 15 分钟，可在 1 至 60 分钟内配置，并非 ADR-006 旧文所说的锁定值。授权以 `(agentId, capabilityId)` 为键持久保存在授权存储中，token 只是成本很低、可以重铸的视图。长任务通过 `POST /grants/refresh`（ADR-011）取得新 token，不需要 connection-key，也不重新提示所有者，但必须同时有存活会话，以及仍在有效窗口内、符合刷新条件的常驻授权；`once` 不能刷新。超过 24 小时的 workflow 不能只靠 refresh 维持旧会话，跨会话还须凭 PAT 重新 handshake，见 §5 长时运行流程。

撤销要分清对象（ADR-010）。`POST /grants/revoke` 按 `jti` 只撤销单个 token；按 `(agentId, capabilityId)` 则撤销所有携带该作用域的 token，并移除持久授权，refresh 此后不能再凭这份授权铸出新 token。被撤销的 `jti` 即使未到 `exp`，invoke 也会拒绝；workflow 在每次成员派发前重新检查撤销状态（评审 #3）。

invoke 还要求 token 的 `sessionId` 存活（评审 #8）。agent 会话由自己的 PAT 引导，与 connection-key 轮换解耦，但并非只有撤销 PAT 才会结束：会话在 60 分钟后到期，网关重启也会清除内存中的会话。`POST /admin/api/agents/revoke` 撤销该 agent 的 PAT 时，其会话同样失效（§5）。connection-key 轮换只使管理员／密钥引导的会话失效，并将这些会话 token 的 `jti` 排队待撤销，不牵连 PAT 引导的 agent 会话。存活检查失败，返回 `session_expired`。

审计用 `sub`（agent id）、`jti`（token id）和 `sessionId` 贯穿每一条 `AuditEvent`，让每次调用都能追溯到具体的 token 和 agent。


### 错误码（封闭联合——评审 #10） {#错误码-封闭联合——评审-10}

`ErrorResponse.error.code` 和 `InvokeResponse.error.code` 取自封闭的 `ErrorCode` 联合类型，agent 可以据此确定性地选择恢复分支。除 `POST /invoke` 外，每个端点失败时都返回统一的 `ErrorResponse` 信封：`{ error:{…} }`。自 v0.1.1（tp2 / ADR-017）起，`POST /invoke` 的所有拒绝都返回 `InvokeResponse` 形状：`{ id, ok:false, error:{…}, auditId }`，让最常走的调用路径使用同一个结果契约（见 §2 `POST /invoke`）。两种形状下，同一错误的 `error.code` 与 HTTP 状态完全相同；不同的只有外层 body。

确定性指的是下一步明确，不是每次失败都能靠重试变成成功。下表给出各分支的处理办法；恢复端点一律从 `.well-known` 的 auth 公示读取，不得把表中的路径硬编码。需要请求级状态时，body 会携带 `pendingId`／`approvalUrl`／`grantStatusUrl`、`unavailableSince`、`discovery`。

终态拒绝也会明确说明并给出指引，但前置条件不变，就仍然拒绝。grant 请求点名 agent 授权视图之外的 capability 时，无论未知、未暴露，还是在子集之外，都统一返回 `declined: [{id, reason}]`，三种情况的 `reason` 逐字节相同。调用方只能得到允许的下一步，不能借此探测 capability 是否存在。

| 码 | agent 的下一步 |
|---|---|
| `token_expired` | 会话仍存活，且有未撤销、仍在有效窗口内的合格常驻授权时，调用 `POST /grants/refresh`；`once` 不能刷新。不符合条件则重新授权，取得有效 token 后再重试。 |
| `token_revoked` | 经 `PUT /grants` 重新请求授权，不再使用已撤销的 token。 |
| `grant_required` | 为该 id 和所需动词请求授权。 |
| `grant_pending_user` | 轮询 `GET /grants/status`，或等待 `grant_resolved`。 |
| `approval_required` | 这是 invoke 时对应的 `grant_pending_user`：需要所有者批准，带返回的 `pendingId` 轮询 `GET /grants/status`。 |
| `session_expired` | 用存好的、仍有效的 PAT 重新 handshake，再取得新会话可用的受限 token。原有常驻授权若仍符合条件，可静默恢复，无需再次询问所有者；握手本身不授予调用权。 |
| `unknown_capability` | manifest 可能已过期；请求 `GET /manifest` 更新视图。 |
| `capability_unexposed` | 所有者在顶层禁用了该 capability；重新启用前不可调用。 |
| `schema_validation_failed` | 对照条目的 `io.input` 修正 `input`。 |
| `source_unavailable` | 源／app 不可达；退避，或向用户报告。 |
| `capability_unavailable` | 该 capability 的归属方（如某个 mesh workload）当前不可用；退避后重试。 |
| `mcp_tool_error` | MCP 带内错误；检查保留的 `mcpResult.content`。 |
| `transport_error` | transport 级失败；重试，或向用户报告。 |
| `host_forbidden` | Host/Origin 检查失败；按 §5 检查请求。 |
| `rate_limited` | 退避。 |
| `internal_error` | 意外的网关故障。 |


## §4d —— 统一信任模型（ADR-018，v0.1.2，加性） {#§4d-——-统一信任模型-adr-018-v0-1-2-加性}

Plexus 把人的批准留下来，再据此签发短命 token；批准与凭据不必同时到期。v0.1.2 没有重做授权机制，只是为已有机制统一命名，让 UI 用户、读协议的 agent 和读 API 的开发者看到同一套事实。改动都加在冻结的 wire 之上：新的可选字段和一个新端点，`v0.1.1` 客户端可以全部忽略。

### 词汇表：一个概念只用一个词 {#词汇表-每个概念一个词-处处逐字使用}

| 术语 | 含义 |
|---|---|
| agent | 授权作用域绑定的身份（`agentId`）。handshake 时，服务端凭该 agent 的 PAT 绑定身份，不接受自我断言，见下文“信任边界与 agentId”。稳定且经 PAT 核验的 `agentId` 使常驻授权可以跨会话保留。没有已核验 PAT 的会话（`anon:*`）得不到任何常驻信任，每个会话都要重新询问。 |
| capability | 可以调用的条目（`CapabilityId`）。 |
| scope | token 携带的一条 `(capability × verbs)`（`TokenScope`）。 |
| grant | 经人批准、常驻保存的授权 `(agentId, capabilityId, verbs)`（`StandingGrant`）：允许这个 agent 按这些动词使用此 capability，直到信任窗口结束。 |
| trust-window | 授权在需要重新批准前常驻多久，由人裁决（`TrustWindow`）。 |
| token | 授权的短命视图（`ScopedToken`），在 `/invoke` 上出示；默认 15 分钟，符合条件时可自动刷新。 |
| provenance / source-class | capability 的来源：`first-party` / `managed` / `extension`（`Provenance`）。 |
| sensitivity | 用于说明风险的派生层级：`low` / `elevated` / `high`（`Sensitivity`）。由来源、动词和 transport 共同决定。 |

### 三个时钟 {#三个时钟}

人的批准能留多久、一次会话能持续多久、手里这一枚 token 何时过期，是三个问题。批准仍有效，不表示会话还活着；会话还活着，也不表示旧 token 仍可调用。

| 时钟 | 它约束什么 | 值 | 谁在意 |
|---|---|---|---|
| token-lifetime | 单枚泄露凭据的可用时长，不是整个刷新链的时长 | 默认 15 分钟，可配置，符合条件时自动刷新（`ScopedToken.expiresAt`） | 安全不变量：刻意设短，钳制在 `[1min, 60min]`；不随批准变化，也不由 agent 选择。 |
| session-lifetime | 权限可以静默流动的片段（episode），之后必须再次出示 PAT | 固定 60 分钟，内存态；网关重启即失效（`SESSION_LIFETIME_MS`） | 收容不变量：`/invoke` 和 `/grants/refresh` 都要求 token 所属会话存活，否则返回 `session_expired`。静默换发链不能越过这个片段；只有 PAT 经一次新的、留有审计记录的 handshake 才能打开下一片段。 |
| trust-window | Plexus 重新询问之前，人的批准常驻多久 | 按 source-class × 动词确定，见下；`StandingGrant.expiresAt` / `ScopedToken.grantExpiresAt` | 用户可读、由 agent 转述的批准期限。 |

token-lifetime 与 trust-window 可在 `~/.plexus/auth-config.json` 配置。`tokenLifetimeMs` 钳制在 `[60000, 3600000]`；`maxTrustWindowMs` 将 `custom` 时长封顶在 30 天，但 `until-revoked` 哨兵不受它钳制。session-lifetime 固定，不随配置变化。

这三层凭据形成收容阶梯：PAT（持久身份）→ 会话（片段，最多 1 小时）→ token（短期调用凭据，默认 15 分钟）。逐级收窄的是凭据的期限与权限边界，下级不能反推出上级；token 即使配置为 60 分钟，也不能延长所属会话，更不能创建 PAT 或新会话。

信任窗口可以很长，`until-revoked` 也合法，因为刷新始终被片段封顶。在存活会话内，只要常驻授权未撤销、仍在窗口内且符合刷新条件，换发就不需要 connection-key，也不再提示所有者；跨片段则必须重新出示 PAT，handshake 留下审计记录。`once` 不进入这条刷新链。

因此，不能用 `min(token-lifetime, 它的片段, trust-window)` 断言被窃 token 的全部滥用何时结束。原 token 到期会结束它自身的调用效力，但符合条件的刷新可能已经换出新 token，滥用仍可在存活会话和有效授权窗口内继续。偷到 scoped token，可能得到片段内的换发机会，却得不到打开下一个片段的凭据。


### 信任边界与 agentId {#信任边界与-agentid}

期限之外，还要分清谁持有凭据。Plexus 有两条信任边界：所有者持有管理凭据，每个 agent 持有自己的身份凭据。两者不是权限大小不同的同一把钥匙，也不能互相替代。

connection-key（`plx_live_…`）属于管理员。所有者凭它认证 `/admin` 控制台，也凭它走 handshake 的管理员路径。agent 永远见不到它。轮换 connection-key，会使管理员／密钥引导的会话失效，并将这些会话 token 的 `jti` 排队待撤销；范围止于密钥引导的这一侧，不牵连 PAT 引导的 agent 会话。

agent 用的是各自独立的 PAT（`plx_agent_…`）。它既是会话引导秘密，也是网关核验身份的依据。handshake 时，网关从 PAT 解析真实的 `agentId`，把会话绑定到这个身份，并覆盖请求里的 `client.agentId`。后者只是元数据，不是客户端选择身份的入口。

因此，普通客户端不能把自己声明成另一个 agent。不带 PAT、只点名一个 `agentId`，得到的是 401，不会得到会话。管理员路径仍可合法点名一个 `agentId`，控制台的“连接一个 agent”正是这样工作。这不算伪冒：持有 connection-key，本来就代表管理员权威，而不是某个普通 agent 的身份。

常驻授权能按 agent 隔离，靠的就是这一步核验。`agentId` 不是客户端随手填写的名字，授权才能安全地限定在它名下。一份 PAT 泄露，只连带那一个 agent 的授权；通过 `POST /admin/api/agents/revoke` 撤销该 agent，不会触碰其余任何 agent。若所有 agent 共用一把密钥，就做不到这样单独撤销，一次轮换会切断所有人。

按 agent 核验身份已经发布。推迟的是密钥对（持有证明）PAT 这层加固；v1 用 bearer PAT，身份本身没有推迟。

但核验“你是谁”仍不是批准“你可以调用什么”。PAT 支持 handshake，取得绑定身份的会话和所有者选定的子集 manifest；限定范围的 grant/token 要另行取得，实际 invoke 仍须通过检查。已有且符合条件的常驻授权可以免去再次询问所有者，却不会把 PAT 变成直接调用许可。凭据边界清楚后，才谈得上这个身份下不同 capability 的授权策略。


### 三类来源的授权姿态 {#_3-类来源-姿态表}

连接时，所有者勾选的 first-party、managed 读取项会得到明确的常驻授权；有副作用的 `write` / `execute` 默认逐次批准。能否常驻，要看敏感度：它由 provenance、verb 和 transport 共同决定，来源本身不能决定所有结果（ADR-5）。

下表列出三类来源的默认批准姿态，以及各动词的默认信任窗口上限。上限不是已经授予的期限；所有者明确批准的例外，另按下面的条件处理。

| provenance | 含义 | read 姿态 | write 姿态 | execute 姿态 | 默认窗口（read / write / execute） |
|---|---|---|---|---|---|
| `first-party` | 保留／进程内源（`MODULES` 名册：`apple-*`、`workspace`、`claudecode`、`codex`、`sysinfo`、`shortcuts`、`browser`、`browser-control`） | 所有者在连接时勾选，即授予常驻授权 | 挂起待批 | 挂起待批 | `7d` / `1d` / `once` |
| `managed` | 用户通过受信管理 UI 添加的源，添加时已经人审核 | 与 first-party 相同：所有者在连接时勾选，即授予常驻授权 | 挂起待批 | 挂起待批 | `7d` / `1d` / `once` |
| `extension` | agent 经 `POST /extensions` 在 wire 上注册的源，默认要求最严格 | 挂起待批 | 挂起待批 | 挂起待批 | `1d` / `1d` / `once` |

表中的“挂起”适用于通过范围检查、又没有合格常驻授权覆盖的请求。`extension` 连 `read` 也要等所有者批准，但这不表示扩展读取不能常驻。first-party 和 managed 的读取则在连接时由所有者勾选批准；这些授权照样带着信任窗口出现在常驻授权账本里，不会静默授予、无处可查。

`write` 默认逐次，也可以经所有者批准成为常驻授权：批准挂起请求时选择真正的信任窗口，或由所有者显式直接授予，都可以做到。表中的 `1d` 是默认窗口天花板，不能把它读成每次批准都会留下 1 天授权，也不能用它否定所有者明确授权的例外。

`execute` 的限制更严。任何 `execute` capability，无论来自 first-party、managed 还是 extension，默认都要逐次批准（`once`）。未经所有者开启常驻选项，`chooseTrustWindow` 始终把窗口锁在 `once`：不论请求什么窗口，也不论这次窗口选择有没有管理员权威。agent 自己永远不能解除这个限制。

ADR-5 的这条默认规则，经 ADR-023 增加了只由所有者开启的例外。所有者可以在连接时，为特定 `(agent, capability)` 开启常驻 execute 授权；选项默认关闭，要求双重确认。开启后，才遵循管理员的权威窗口，或常驻到撤销为止；若策略禁用了 `until-revoked`，则钳制到 `7d`。一次 agent 请求不能代替这项开启操作，管理员窗口也不能绕过它。

已有授权是否免去再次询问，还要看它具体覆盖什么。针对 `(agentId, capabilityId)` 的授权，只有常驻且未过期，才对其覆盖的动词跳过重新询问；同一 capability 上未覆盖的动词不在此列。`once` 授权的记录为 `standing:false`、`expiresAt = grantedAt`，只能使用一次，绝不用于跳过重新询问。

`until-revoked` 是可用选项，但绝不是默认值。它以远期哨兵表示持续有效，只有显式撤销才能结束；自定义时长则封顶 30 天，不能把两者当成同一种期限。

`anon:*` 会话没有已核验的 PAT，授权只能用于当次会话，上限锁在 `once`。即使选择了更长窗口，也绝不在匿名 id 下持久化可跨会话使用的常驻授权。

### 查看常驻授权：`GET /grants`（会话认证） {#新端点-——-get-grants-会话认证}

这个端点返回调用方的常驻授权账本，与用户 Grants 屏相对应。agent 看到自己的授权，管理会话拿到全部常驻授权。认证方式与 `GET /manifest` 完全相同，地址通过 `AuthAdvertisement.grantsListUrl` 广告。管理 UI 则走管理密钥门控的 `GET /admin/api/grants`。

```
GET /grants                       → GrantsListResponse { grants: StandingGrant[] }
```

每条记录的完整形状为：

`StandingGrant = { agentId, capabilityId, verbs[], provenance, sensitivity?, grantedAt, expiresAt, trustWindow, standing, synthesizedFor?, constraint?, bundleId?, topLevelDisabled? }`

这里的 `expiresAt` 是信任窗口的结束时间，也就是向用户说明的授权期限。`standing:false` 则标记不可续的 `once` 授权。

批准时附带的内容感知约束，保存在 `constraint`（`ScopeConstraint`）中。refresh 重铸 token 时，必须携带相同的约束，并继续强制执行。换了一枚 token，获准使用的范围不会因此变宽；没有 `constraint`，才表示该授权没有这层内容限制，覆盖整个 capability。

`bundleId` 表示这条授权属于某个命名的 Mode-2 任务捆绑。捆绑只是把成员放在一起，不增加成员授权之外的任何权威。任务捆绑后端仍然保留，但 1.0 控制台没有捆绑管理界面，成员按普通常驻授权显示。

账本里也可能留着暂时不能使用的授权。`topLevelDisabled:true` 表示所有者已在“我暴露什么”中顶层禁用了对应的 capability。授权记录仍在，但重新启用之前，该 capability 不可见，也不可调用。有效访问要求两者同时成立：已授权 ∧ 已暴露。

### 新增的可选字段：均为非破坏性改动 {#加性可选字段-每个改动都非破坏性}

这些字段补充了请求前的说明、批准时的选择，以及批准后可查看的记录。它们都是加性扩展。

| 类型 | 新增的可选字段 | 用途 |
|---|---|---|
| `CapabilityEntry`、`CapabilitySummary` | `provenance`、`sensitivity`、`recommendedTrustWindow` | 让 agent 在请求之前说明代价；省略来源时，按 `extension` 处理。 |
| `GrantDecision` | `trustWindow`、`purpose`、`constraint` | `trustWindow` 是请求方提议的窗口：agent 路径上仅供建议，可以缩短，不能借它突破类别上限；管理员批准路径上的窗口具有权威性，但仍受前述所有者常驻 execute 开启条件约束。`purpose` 是 agent 自由填写的理由，属于不可信的说明文字，只为透明展示，不影响任何裁决；单独显示为“agent 说：”，最多 280 字符。`constraint`（`ScopeConstraint`）附加内容感知限制，只能收窄权限，并写入 `TokenScope.constraint`。 |
| `GrantPendingResponse`、`GrantStatusResponse` | `pendingNarration[]` | 由网关撰写，形状为 `{ id, verbs, provenance, sensitivity, defaultTrustWindow, summary, notificationLine? }`。每个 agent 转述的都是同一行真实文案。可选的 `notificationLine` 同样由网关撰写，约 120 字符，供托盘／通知使用；web 忽略它。 |
| `GrantRequest` | `bundle` | Mode-2 任务捆绑信封，形状为 `{ name, agentId?, context? }`。把多个 capability 及其约束作为一个命名捆绑请求；成员共享 `bundleId`，有风险的成员作为一组挂起，等待 Approve。捆绑本身不增加权威。 |
| `StandingGrant` | `constraint`、`bundleId`、`topLevelDisabled` | 分别保存已批准的约束，供 refresh 重铸时沿用；标记任务捆绑成员；标记已授予、但因顶层禁用而不可见的 capability。 |
| `TokenScope` | `constraint` | 随已签名 JWT 的 scopes 下发，在 invoke 时通过 `constraintSatisfied` 强制检查。 |
| `BundleView`、`GrantContextRef` | （新类型） | 前者是管理 Grants 视图的捆绑投影，由 `GET /admin/api/bundles` 提供；后者引用一段限定作用域的任务上下文，复用 `kind:"skill"` 机制，采用 `skill` 引用或有长度上限的 `inline` markdown，不引入新 transport。 |
| `CapabilityEntry`、`CapabilitySummary` | `health` | 从所属源继承的健康快照，见下文 HEALTH。 |
| `ScopedToken` | `grantExpiresAt`、`trustWindow` | 在 token 的 `expiresAt`（默认 15 分钟）旁，另行给出授权的信任窗口上限。 |
| `ScopedTokenClaims` | `gexp` | 授权／信任窗口的过期纪元值，用于诊断。 |
| `AuthAdvertisement` | `grantsListUrl` | 公布 `GET /grants` 的地址。 |
| `AuthorizationDecision` | `provenance`、`sensitivity`、`recommendedTrustWindow` | 提供结构化原因，服务可直接据此构建 `pendingNarration`，不必重新派生。 |

健康状态（HEALTH）让 agent 读到可用性，再据此降级处理。capability 使用 `CapabilityHealth` / `HealthStatus` 表示状态，可取 `ok`、`degraded`、`unavailable`、`unknown`。

快照按源计算。源若提供可选的 `health()`，就用它；没有这个方法，才退回 `checkRequirements()`。只有 `health()` 能报告 `degraded`。同一个源的结果继承到它的每个 `CapabilityEntry.health` / `CapabilitySummary.health`，序列化时从网关的短 TTL 健康缓存取出并打上时间戳。这是一份短期快照，仅供参考。

敏感度也由网关统一计算，各界面使用同一结果。first-party/managed 上的读为 `low`；first-party/managed 上的 write/exec，或 extension 上的读，为 `elevated`；extension 上的 write/exec 为 `high`。此外，任何使用 cli/local-rest transport、且带 write/exec 的条目，都归为 `high`。workflow 则向上汇总成员的敏感度，取其中最大值。

## §5 —— 安全模型 {#§5-——-安全模型}

网关默认绑定回环地址 `127.0.0.1`。要绑定选定的 NIC 或 `0.0.0.0`，须通过 `~/.plexus/network.json` 主动启用。开放到网络后，每一条 `/admin/api/*` 路由都由 connection-key 门控；connection-key 是 LAN 上管理访问的信任边界。无论怎样绑定，每个端点都先执行 Host/Origin 守卫，再进入 auth。

回环绑定不能让请求自动可信。其他本地进程仍能访问，浏览器也可能遭遇 DNS 重绑定攻击：恶意页面把某个主机名解析到 `127.0.0.1`，再向 `/invoke` 发起 POST。为此，每个端点强制执行 `HostOriginPolicy`（评审 #7，ADR-016）。`Host` 按绑定配置核验；回环绑定时，必须匹配回环权威 `127.0.0.1:<port>` 或 `localhost:<port>`，这两种形式仅用于回环绑定。浏览器请求带有 `Origin` 时，它必须在 `allowedOrigins` 中；默认只允许管理客户端的来源，agent CLI 不发送 `Origin`。检查失败，返回 `host_forbidden`。

未认证的 `.well-known` 会向本地调用方透露网关身份、版本，以及生命周期和 auth 端点的接入说明。这是自描述入口已接受的指纹暴露风险：调用方能识别“这里跑着 Plexus”，但不能据此枚举 capability，连摘要也拿不到。授权子集模型已取代旧 ADR-008 的摘要边界。agent 首次取得 capability 清单，必须先 enroll，再凭 `Bearer plx_agent_…` 通过 PAT 门控的 handshake；清单只包含所有者授权且仍暴露的子集。handshake 确认身份、建立会话，并返回所有者选定的 capability 子集 manifest；限定范围的 grant/token 仍须另行取得。

管理员与 agent 各持一份凭据。connection-key（`plx_live_…`）由网关生成，只在本地管理客户端展示，由所有者带外取得，用于 `/admin/api/*` 和 handshake 的管理员路径。agent 永不见到，也永不出示它。密钥可以按需或自动轮换；轮换使管理员／密钥引导的会话失效，并将这些会话 token 的 `jti` 排队待撤销（评审 #8），不影响 PAT 引导的 agent 会话。

每个 agent 的 PAT（`plx_agent_…`）则是它自己的持久身份凭据和会话引导秘密，不是调用权威。agent 在 `POST /agents/enroll` 用一次性 enroll 码（`plx_enroll_…`）兑换；码约 15 分钟有效，只能使用一次，PAT 明文也只返回一次。agent 以 `0600` 权限保存，服务端只存静态哈希，之后每次 handshake 都核验这份 PAT。泄露只连带该 agent 的授权；通过 `POST /admin/api/agents/revoke` 可单独撤销它，并使其会话失效，不牵连其他 agent。

调用默认拒绝：没有显式授权，任何条目都不可调用。“默认只读”说的是简写 `allow` 只授予 `read`，并非所有读取自动获准；`write` / `execute` 必须点名。授权裁决由可插拔的 `Authorizer` 完成，返回 `allow | deny | pending`（ADR-007 已修订）。已发布的默认实现是 `UserConfirmAuthorizer`，采用 `confirm-risky`：所有者连接时勾选批准的 `read` 留作常驻授权，符合条件时无需再问；没有合格常驻授权覆盖的 `write` / `execute`，默认通过 `grant_pending_user` 挂起，等待所有者批准。

所有者可以为特定 agent/capability 显式开启常驻授权。`write` 也可在批准挂起请求时，通过真正的信任窗口成为常驻授权，或由所有者直接授予；`execute` 必须由所有者专门开启常驻选项，agent 请求不能自行解除这一限制。内部和测试还可使用宽松的 `AutoApproveAuthorizer`，直接替换而不改变 wire。契约规定的是授权接缝，不限定某一种具体 UX。

检查落实到每次调用。每一次 `/invoke` 都重新核验条目所需动词的作用域覆盖、会话存活，以及 `jti` 未被撤销，不能用会话建立时的一次检查代替。所有者关闭 capability 暴露后，即使 grant 仍有效，也会在授权覆盖检查之前被拒绝。

审计写入 `~/.plexus/audit/` 下的追加式 JSONL，按日轮换（评审 #次要，ADR-009 修订）。每条 `AuditEvent` 记录类型、`agentId`／`sub`、`jti`、`sessionId`、`capabilityId`、`verbs`、`outcome` 和 `detail`。脱敏是 `AuditRedactionPolicy` 规定的契约：唯一的写入者在持久化前，从 `detail` 中擦掉原始调用 `input`、token 字符串、connection-key 和已解析的秘密。`forbidRawInput` 是强制执行的要求，不是愿景；单一写入路径防止各处规则漂移。默认保留 90 天。

所有网关状态都放在 `~/.plexus/` 下，包括授权存储、审计、源注册表和 connection-key；`~/.plexus/secrets/` 下的秘密经平台接缝解析。用户 cwd 中不放指针文件。


### 连接一个 agent：从所有者配置到调用 {#连接一个-agent-——-已发布的界面-管理员-→-agent-→-调用}

所有者先连接 agent，agent 再运行一条安装命令，之后便能通过安装好的集成发现和调用 capability。两凭据模型由三个已发布界面，加上一个编译出的 agent 界面落地。

所有者可以使用控制台向导，也可以调用 `POST /admin/api/agents/connect`；这条管理路径由 connection-key 门控。连接时，所有者给 agent 命名，选择它的 capability 子集，网关随后生成一次性 enroll 码（`plx_enroll_…`）。

选择子集与授予常驻权限，是两件事。子集声明这个 agent 获准接触的范围，常驻授权则另行保存。连接时选中的 `read` 由所有者批准一次，留下常驻授权；选中的 `write` / `execute` 默认仍逐次挂起，等待批准。所有者可以为特定 agent/capability 设置 `standing`，显式开启常驻授权。`write` 也可以在挂起请求获批时，通过真正的信任窗口成为常驻授权，或由所有者直接授予。`execute` 必须由所有者专门开启常驻选项，agent 自己的请求不能解除这道限制。

接着，把安装命令交给 agent。`GET /integration/:agentId` 提供可复制的命令，这个入口受管理凭据保护；命令调用的 `install.sh` 则公开可取，自包含，也不带秘密。运行后，安装流程向 `POST /agents/enroll` 提交一次性码，兑换该 agent 的 PAT，以 `0600` 权限保存，再删除该码，并安装编译出的 Claude Code plugin。码只能兑换一次，后续会话用保存的 PAT 认证。

安装完成后，使用这套集成的 agent 经捆绑的 launcher 调用 capability。每个 plugin 都发布自己的 `plexus-<agentId>`，并按版本隔离。launcher 通过 exec 启动自己捆绑的引擎，也就是同级的 `bin/plexus`，同时绑定 `PLEXUS_AGENT_ID`。它不会去找全局 `plexus`，两个 agent 的 plugin 因而不会互相冲突，也不会认证成另一个 agent。

子命令如下：

```
plexus-<agentId> enroll <code>       # once, at install: redeem code → store PAT
plexus-<agentId> list                # discover: callable-now vs needs-approval
plexus-<agentId> <capabilityId> …    # invoke a granted capability
```

`enroll` 在安装时运行一次；`list` 用来发现条目，区分当前可调用与仍需批准的 capability；最后一条用于实际调用。发现条目之后，仍须取得限定范围的 grant/token，才能进入 invoke；已有且符合条件的常驻授权可以免去再次询问所有者。

对于使用编译集成的 agent，launcher 是完整且唯一的接口。每次交互都走 `plexus-<agentId>`，不自行拼 HTTP，不手动调用 enroll、handshake 或 manifest，也不猜认证办法。独立 HTTP 客户端仍可直接使用 Floor，无需安装 plugin；launcher 的限制只属于这套编译集成。

认证流程也不交给模型临场编写。执行 enroll → handshake → grant → invoke 链路的引擎 `bin/plexus`，在构建时会对照已提交、受认可的引擎逐字节校验，没有任何 auth 路径出自 LLM 之手。agent 侧的具体用法见[面向 Agent](/zh/agents/)。

捆绑的 skill 把始终在场、能够描述自己的 Floor 投影成使用指引，内容来自 `.well-known`、`requestShapes` 和使用说明。投影可能过期，调用仍由网关按实时授权检查。旧 skill 即使还写着某项 capability 可用，也不能让已经失效的权限重新生效；所有者关闭暴露后，有效 grant 同样不能放行。

已注册的扩展及其投影条目会在网关重启后保留。Plexus 信任已持久化的配置，启动时直接恢复，不再提示批准；全新注册仍会挂起等人批准。§4d 的暴露与授权记录也会留下。这里保留的是扩展配置和授权记录，会话与异步 run 仍在内存中，网关重启后不会保留。

### 完整流程：超过 24 小时的 workflow 如何使用 15 分钟 token {#完整流程-——-24h-的-workflow-编排-跑在-15-分钟-token-上}

超过 24 小时的编排，需要多次更新调用凭据。本例采用默认 15 分钟的 token，而会话固定在 60 分钟后结束。refresh 能换发 token，不能延长会话；长任务跨过会话边界时，还得重新 handshake。

agent 先凭自己的 PAT 完成 handshake，取得会话和所有者选定的子集 manifest，再通过 `PUT /grants` 为 `orchestrator.pipeline.run` 请求 `execute` 授权。握手交回目录，授权这一步才取得调用 token。获准后，token 同时携带合成的成员作用域，包括 `board.create`、`agent.dispatch` 和 `board.status`；管理客户端通过 `transitive` 块向所有者展示这些成员，让人知道这次批准会涉及哪些调用。

拿到 token 后，agent 对该 workflow 发起 `POST /invoke`。`WorkflowTransport` 经 `invokeById` 向成员扇出，每个成员都重新进入调用管线，接受作用域检查并单独留下审计记录。撤销状态也在每次成员派发之前重查，不能只在 workflow 开始时查一次。

token 接近 `exp` 时，只有会话仍存活、对应常驻授权未撤销且仍在有效窗口内，agent 才能出示将到期的 token，带上 `jti` 和会话，调用 `POST /grants/refresh`。符合条件就取得新的 15 分钟 token，不需要 connection-key，也不重新提示所有者。这一步受 `grantExpiresAt` 约束；授权窗口结束后，须重新 `PUT /grants`。`once` 授权不能刷新。

会话结束后，即使授权窗口还没到期，也不能继续 refresh。agent 必须重新出示 PAT 完成 handshake，建立新会话，再另行取得该会话可用的受限 token。已有且仍符合条件的常驻授权可以支持取 token，无需再次询问所有者。网关重启同样会清除内存中的会话，需要重新握手。

这些更新发生在客户端。新 token 不会自动替换已经派发的 workflow 内使用的凭据，因此不能把上述步骤当作一次 workflow 调用连续运行超过 24 小时的保证。重新发起 `POST /invoke` 是另一次调用，并不是让原调用继续运行；原调用的后续成员派发仍须通过各项检查。

运行途中，某个源新增 capability，会触发 `manifest_changed` SSE 事件。agent 随后请求 `GET /manifest`，更新自己的授权子集视图。所有者从管理客户端撤销本次 workflow 使用的 token 时，会发出 `token_revoked` 事件，agent 必须停用它。workflow 在下一次成员派发前查到撤销，就停止其余成员的派发；已经派发的成员不会因此取消，已经完成的工作也不回滚。

::: warning ADR-5 / ADR-023 授权边界
`orchestrator.pipeline.run` 是 `execute` capability，默认逐次批准（`once`）。批准只覆盖单次获准的调用，重新调用 workflow 会重新提示所有者。只有所有者可以在连接时，为特定 agent + capability 开启常驻 execute 授权；按 ADR-023，这个选项默认关闭，须双重确认。开启后，`execute` 授权才适用真正的信任窗口，agent 不能靠请求或 refresh 自行取得这个例外。

靠 refresh 延续调用凭据，适用于具备常驻资格、已有有效常驻授权覆盖的作用域，例如信任窗口内的 `read`／`write`，其中 `board.status` 就是读成员。成员可以刷新，不代表 workflow 的 `execute` 授权也能刷新；常驻 execute 也仍受存活会话和授权窗口限制。见 §4d 与[安全模型](/zh/architecture/security-model) §3。
:::

## §6 —— 适配器层架构 {#§6-——-适配器层架构}

探测源、扫描条目、维持连接，由源的生命周期层负责；把某个会话里的请求翻译成实际调用，由按会话建立的协议翻译层负责。这两层沿用 pneuma-skills 的划分。适配器类型藏在接口后面，核心从不按源或 transport 类型分支。

生命周期层的接口是 `CapabilitySource`，大致对应 pneuma 的 `AgentBackend` + `BackendModule`。`checkRequirements()` 经平台接缝做成本低的可用性探测，`scan()` 枚举并投影条目，`start()`、`stop()` 管理源的启动与停止。持久 MCP 客户端由 `start()` 在源的生命期内拥有，可以在多次调用之间复用；它的归属是源，不是某一次请求，也不是某个会话的 bridge。

`scan()` 必须把条目列全。对 MCP，契约沿用前文 legacy 客户端的 handshake，再运行 list，逐页取尽，随后重投影；不能取到第一页就结束。这仍是前述 MCP 接入契约，面向用户的服务器导入路径尚未发布。对暴露 `kind:"workflow"` 条目的源，`scan()` 必须同时返回 workflow 和它的成员条目，让成员真正进入注册表，传递性授权才有实际目标可查（评审 #次要，Flow A）。

条目变化可以通过可选的 `onEntriesChanged()` 上报，MCP 的 `list_changed` 就接到这里。源还可以提供可选的 `install()`。安装是一等动作，执行前须经用户确认，并留下 `source.install` 审计记录；它取代旧的 `extras.autoInstall` 数据块，核心从不读取后者（评审 #次要，Flow A）。可用性探测、扫描和安装各有接口，是否实现安装并不改变用户确认与审计的要求。

协议翻译层的接口是 `CapabilityBridge`，大致对应 pneuma 的 `BridgeBackend`。每个“会话 × 源”组合各有一个实例，通过闭包持有自己的适配器，让具体适配器类型保持私有。它提供 `getCapabilities()`、`invoke(req, ctx)`、`route()` 和 `disconnect()`；其中 `route()` 的返回值是 `"handled" | "unsupported" | "passthrough"`。bridge 按会话建立和断开，源及其持久 MCP 客户端则按源的生命期管理，两者不能混为一谈。

网关必须在调用 bridge 的 `invoke()` 之前强制执行授权检查。通过检查后，bridge 才把请求翻译到 transport，归一化返回结果，并且必须发出审计事件。协议翻译由适配器完成，进入这一步的授权前提仍由网关把守。

为支持这些职责，`BridgeDeps` 携带 `audit` 和 `invokeById`。`audit` 补齐了适配器之间审计依赖不对称的问题，源也能记录 `source_unavailable`（评审 #次要）。`invokeById` 则把重入管线交给 `workflow` transport：编排器借它向成员扇出，每次成员调用重新进入统一管线，接受授权检查并留下审计记录（评审 #6）。

### 中央注册表：统一查找源与 transport {#中央注册表-无分散的分支}

每个源都从 `sources/<id>/manifest.ts` 发布一个 `SourceModule`。这些模块只在 `SourceRegistry` 一处聚合，大致对应 pneuma 的 `backends/index.ts: MODULES`。调用方通过 `registry.get(id)` 查源，通过 `registry.getTransport(kind)` 查 transport，通过 `registry.all()` 遍历全部源；源模块之外没有任何 `if (id === ...)`。

因此，新增一个源的接入工作就是写一个 manifest，再加入注册表映射。完成这两步，发现、可用性检查、扫描和 invoke 路由便全部自动接通。各调用方继续使用同一组查找接口，不需要再为新源补分支。

### 平台抽象接缝 {#平台抽象接缝}

寻找二进制、取得可用的 PATH、定位本地服务、启动进程，以及解析秘密，都会碰到操作系统的差异。这些工作统一放在 `PlatformServices` 后面：`resolveBinary` 负责二进制发现，`getEnrichedPath` 提供补全后的 PATH，`locateLocalService` 定位本地服务，`spawnProcess` 启动进程，`resolveSecret` 解析所需的秘密。

PATH 解析复用 pneuma 的 `path-resolver`：捕获登录 shell 的 PATH，并以候选目录作为回退。核心和适配器只依赖这组接口，具体平台怎样找到程序、怎样启动进程，由接口背后的实现处理。核心中没有散落的 `process.platform` 检查。

macOS 是首要实现，已经过端到端验证。Windows 与 Linux 对同一接口的实现也已随发行版发布，运行时会按所在平台自动选择。

Linux 随附一份可移植的 first-party 源白名单，其网关的可移植运行路径已有验证，不能再笼统地说 Linux 尚待验证。这个验证有明确范围：仅适用于 macOS 的应用源，在 Linux 上仍不可用。平台接口可以跨系统实现，源能否使用还取决于它所依赖的软件。Windows 在真实操作系统上的端到端验证仍待补齐。

`resolveSecret` 为需要 auth 的本地服务提供凭据解析路径，例如 Obsidian Local REST API 的 bearer 密钥（评审 #次要）。秘密保存在 `~/.plexus/secrets/` 下，声明通过 `ExtensionSecretRef` 按名引用。直到实际派发时，解析出的秘密才交给拥有它的 transport；秘密本身绝不进入核心、manifest 或审计。按名引用与交付凭据发生在不同位置，声明里不需要放入密钥值。

### 日后可选的 MCP 服务器输出适配器 {#可选的日后输出-mcp-服务器-facade}

对于只使用 MCP 的客户端，这份契约允许未来增加一个 MCP 服务器 façade 输出适配器，把 Plexus 的一部分能力重新作为正常的 MCP 服务器提供出去。契约已为它设计，但 M0 未内建。

重投影所需的原始内容已经在条目形状中留了位置。按导入契约，`mcp.raw` 逐字保留每个导入工具的原始对象，未来的 façade 可以据此精确重投影，不必从 Plexus 的描述中重新拼出工具定义。这是为日后输出保留的依据，不表示 MCP 服务器输出现在已经可用。

用户扩展和 workflow 条目则向下投影为 MCP 工具。投影只丢掉 MCP 无法承载的加性 skill 与授权层：条目可以作为工具提供，但 Plexus 附加的这两层不能完整地随工具投影输出。

## 附录 —— 文件地图 {#附录-——-文件地图}

- [`VERSION`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/VERSION) —— M0 契约的版本标签（`0.1.3`）。
- [`types.ts`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/types.ts) —— 规范 TypeScript 类型，是类型定义的事实源。
- [`examples/obsidian.vault.read.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/obsidian.vault.read.json) —— 用户扩展的条目范例，`kind:"capability"`，只读（`read`）。
- [`examples/orchestrator.pipeline.run.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/orchestrator.pipeline.run.json) —— first-party 编排条目范例，`kind:"workflow"`，授权动词为 `execute`，成员采用 `WorkflowMember[]`。
- [`examples/mcp-tool-passthrough.github.create_issue.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/mcp-tool-passthrough.github.create_issue.json) —— 导入的 MCP 工具条目范例，展示原始工具内容如何逐字直通。
- [`examples/extension-manifest.obsidian.json`](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/examples/extension-manifest.obsidian.json) —— 极简用户扩展 manifest 范例，对应 Flow B 的注册路径。
- [决策记录](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/DECISIONS.md) —— M0 契约的架构决策记录（ADR）。
