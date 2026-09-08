---
title: 扩展规范
description: Plexus 标准扩展规范（v0.1）：编写扩展的公开契约，涵盖 manifest schema、transport、grants、secret、校验规则与安全边界。
---

# Plexus 标准扩展规范 —— v0.1

::: tip 状态
**M4 公开规范（v0.1）** · 协议：**plexus-extension/0.1** · 网关契约：**PLEXUS_PROTOCOL_VERSION 0.1.3** · 日期：2026-06-23

本文是**编写 Plexus 扩展**的公开规范：任何人都可以把本地应用、CLI、脚本或 HTTP 服务接入 Plexus，让任何 AI agent 都能发现 → 理解 → 获得授权 → 调用。它将**已经交付的实现**（`ExtensionManifest`、`materializeExtension`、`CapabilityRegistry.registerExtension`、`ExtensionSource`／`ExtensionBridge`）明确为稳定的扩展开发接口，不引入新的通信协议。字段的规范定义若来自冻结类型，本文会给出引用，并**以该类型为准**。
:::

- 冻结类型：[`packages/protocol/src/types.ts`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1、§1b、§6。
- 运行时：[`packages/runtime/src/sources/extension.ts`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/sources/extension.ts)、
  [`packages/runtime/src/core/capability-registry.ts`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/core/capability-registry.ts)。
- 实现示例：[`packages/runtime/src/sources/obsidian/`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/sources/obsidian/)，
  [`packages/runtime/src/sources/claudecode/`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/sources/claudecode/)。
- ADR：[决策记录](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/DECISIONS.md) ADR-003/004/005/009/012/013。

## 1. 什么是扩展

**扩展**是用户可以安装的包，以一份 [`ExtensionManifest`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) 声明一个**能力来源**及其提供的**条目**。注册时，网关将清单**实例化**为运行时的 `CapabilitySource`，*结构与编译时纳入的第一方来源完全相同*，因此网关会像处理其他来源一样处理它：agent 可以在自己的清单中发现条目（握手清单／`GET /manifest`；对已绑定的 agent，条目须属于所有者明确指定的子集，或拥有所有者创建且仍有效的常驻授权，同时仍须满足暴露条件且条目确实存在），获得授权（`PUT /grants`），并发起调用（`POST /invoke`）。**agent 无法区分用户扩展、第一方适配器和接入的 MCP 工具——三者都是 `CapabilityEntry` 对象。**

核心是**同构条目模型**（ADR-004）：每个 capability、skill、workflow 都是以 `kind` 区分的 `CapabilityEntry`。扩展通过 `ExtensionCapabilityDecl` 声明条目，网关把每条声明投影成完整的 `CapabilityEntry`（`id`、`source` 与 skill 反向链接由网关派生）。

```
ExtensionManifest  ──register──►  materializeExtension()  ──►  SourceModule
                                                                 │
                              ┌──────────────────────────────────┼─────────────────────┐
                              ▼ scan()                            ▼ createBridge()
                        ExtensionSource                     ExtensionBridge
                  (lifecycle: scan→CapabilityEntry[])   (per-session: invoke→transport|handler)
```

注册有**两条通道**（物化方式相同；见 §9）：

1. **传输接入**——通过 HTTP `POST /extensions` 端点注册。清单中的条目通过通信传输（`local-rest`／`cli`／`stdio`／`ipc`）或哨兵值（`skill`／`workflow`）访问。外部作者都使用这一通道。**不会运行进程内代码。**
2. **进程内处理函数**——由网关自身的代码调用 `capabilities.registerExtension(manifest, { handlers })` 注册，Obsidian 的笔记库读取就采用这种方式。仅供第一方或网关随附的来源使用；这些来源自带专门编写、经过网关测试的管控逻辑。**无法通过通信接口注册**（不能上传函数），第三方扩展不能注入进程内代码。（claudecode 属于另一种实现：它是编译时纳入的第一方 `SourceModule`，有自己的桥接器，从不通过上述任一通道注册。）

## 2. 扩展清单的格式 {#_2-扩展-manifest-schema}

类型以 [`ExtensionManifest`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1b 为准。接口上传输的 JSON 是扁平对象，可进行 JSON 序列化。

| 字段 | 必需 | 类型 | 含义 |
|---|---|---|---|
| `manifest` | **是** | `"plexus-extension/0.1"` 字面量 | Manifest schema 版本。任何其他值网关一律**拒绝**。 |
| `source` | **是** | `SourceId` | 此扩展注册的来源 ID。将来源 ID 中的 `:` 替换为 `.` 得到 id-slug，用于派生每个条目的 ID（ID-DERIVATION RULE）。采用小写连字符或点分命名，例如 `my-vault`、`linear`、`mcp:github`（slug 为 `mcp.github`）。通过通信接口注册时，不接受保留的第一方 ID（见 §8）。 |
| `label` | **是** | `string` | 人类可读的 source 标签，如 `"Obsidian (Local REST API)"`。 |
| `transport` | **是** | `Exclude<TransportKind,"mcp">` | capability 未覆盖时的默认 transport。取 `local-rest \| stdio \| ipc \| cli \| skill \| workflow` 之一。 |
| `capabilities` | **是** | `ExtensionCapabilityDecl[]` | 此扩展贡献的条目（capability/skill/workflow）。要有效注册就必须非空。 |
| `secrets` | 否 | `ExtensionSecretRef[]` | 传输模块所需的密钥引用，通过平台接口按名称解析（见 §7）。 |
| `serviceHint` | 否 | `LocalServiceHint` | 如何定位 `local-rest`/`ipc` 服务（`{ app, defaultPort?, socketName? }`）。 |

### 2.1 `ExtensionCapabilityDecl` —— 扩展提供的单个条目 {#_2-1-extensioncapabilitydecl-——-一条被贡献的条目}

规范性类型：[`ExtensionCapabilityDecl`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1b。

| 字段 | 必需 | 类型 | 含义 |
|---|---|---|---|
| `name` | **是** | `string` | `<noun>.<verb>` 后缀。完整 id 为 `<sourceSlug>.<name>`（如 source `obsidian` + name `vault.read` ⇒ id `obsidian.vault.read`）。 |
| `kind` | **是** | `"capability" \| "skill" \| "workflow"` | 条目种类（ADR-004）。 |
| `label` | **是** | `string` | 简短的人类/agent 标签。 |
| `describe` | **是** | `string` | **核心字段。** 面向 agent 的"什么 / 何时 / 如何"，写给决定是否调用它的 AI 看。遵循 claude-plugin 约定：*"Action outcome. Use when X."*（见 §3。） |
| `grants` | **是** | `GrantVerb[]` | 此条目所**需**的动词（`read`/`write`/`execute`）。`[]` = 无需授权（skill）。默认拒绝 + 默认只读（ADR-005）。 |
| `transport` | **是** | `Exclude<TransportKind,"mcp">` | 此条目的 transport。冻结类型将其标为必需——显式写上以满足类型；运行时若省略，则回退到 manifest 级的 `transport` 默认值。 |
| `io` | 否 | `IoSchema` | `{ input?, output? }` JSON Schema（Draft 2020-12）。输入在 invoke 时被**强制校验**。skill 省略。 |
| `members` | `kind:"workflow"` 时必填 | `WorkflowMember[]` | 按顺序排列的成员 ID，以及工作流对每个成员可使用的操作动词。每个 ID 都必须对应注册表中已有的条目（§8）。 |
| `body` | `kind:"skill"` 时必填 | `SkillBody` | 内联的 Markdown 使用说明（`{ format:"markdown", markdown }`），或内容引用。 |
| `route` | 否 | `Record<string, unknown>` | Transport 路由配置——**只由拥有它的 transport 读取，核心从不读**。见 §5 + §6。 |

### 2.2 `route` 可识别的键（按 transport）

`route` 不限定配置项。网关核心从不读取它；只有对应的传输模块或建立技能反向链接的逻辑会读取。可识别的键如下：

| 键 | 由谁读 | 含义 |
|---|---|---|
| `attachSkills: string[]` | `manifestEntries()` | 要反向链接到此 capability 的 `kind:"skill"` 条目的声明 `name`（成为 `entry.skills[]`）。见 §6。 |
| `method`、`pathTemplate`、`secret` | `local-rest` 传输 | HTTP 方法、URL 路径模板（可插入输入字段的值），以及要附加的密钥。`secret` 是一个 **对象** `{ name, attach?, as? }`。传输模块读取 `route.secret?.name`（待解析的 `ExtensionSecretRef` 名称）、`route.secret?.attach`（默认为 `bearer`，也可选 `header` 或 `query`）和 `route.secret?.as`（使用 `header` 或 `query` 时，对应的请求头名称或查询参数名）。运行时的 `LocalRestTransport` 读取规范字段 `pathTemplate`，也接受旧版别名 `path`。 |
| `bin`、`args`、`secret` | `cli` 传输 | 可执行文件名（通过平台接口查找对应程序）、argv 模板，以及用于传递密钥的环境变量。 |
| `op` | `ipc`/进程内 bridge | 进程内操作选择器（如 claudecode `run`）。 |
| `handler` | 仅进程内 bridge | 由 `registerExtension(..., { handlers })` 绑定——**是函数，不可序列化，绝不出现在 wire manifest 里**（§9）。 |

## 3. 写好 `describe`（agent 的相关性信号）

`describe` 是 MCP 缺失的那一层——它讲的是*怎么用好我*，不只是*我是什么*。范本就是 claude-plugin SKILL.md 的 `description` 约定：

> **Action outcome. Use when X.** 接着说明调用形式和关键约束。

范例（来自已发布的 Obsidian 扩展）：

> "Read notes from the Obsidian vault \"Research\" READ-ONLY. Use when you need
> the text of the user's notes to answer, summarize, or cite. Pass `{ path }`
> relative to the vault root to read a note; omit path to list notes.
> Path-confined to the vault; never writes."

清单：
- 开头写**结果**（agent 能得到什么），不写实现。
- 说明**何时该选它**而非其他选择。
- 用一行说明**调用形式**（正式的输入契约由 `io.input` 定义）。
- 写明**边界**（只读、路径受限、有副作用、需要 execute）——agent 正是靠这些权衡授权代价。

条目管理页和能力列表页显示的单行摘要，取自 `describe` 的**第一行**（参见 capability-registry 中的 `toSummary`）。完整文本随握手清单传递。第一行应写成完整的句子。

## 4. Transport 选择

规范性：[`TransportKind`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1 + ADR-003。扩展可以使用**除 `mcp` 外**的任何 transport（MCP 是网关享有特权的导入路径；MCP 条目是*导入*的，不是*手写*的）。

| Transport | 用它做什么 | `route` 配置 |
|---|---|---|
| `local-rest` | 暴露 localhost HTTP(S) API 的 app（Obsidian Local REST、本地 web 服务）。Plexus 充当 HTTP 客户端。 | `{ method, pathTemplate, secret? }` + `serviceHint`/`secrets`。 |
| `cli` | 用 argv 调用、捕获 stdout（可选 `--format json`）的二进制。二进制经平台 path-resolver 定位。 | `{ bin, args, secret? }`。 |
| `stdio` | 长期运行的子进程，通过 stdin/stdout 以逐行 JSON（NDJSON）协议通信。 | 通过 `serviceHint`/`route` 指定启动配置。 |
| `ipc` | OS IPC —— unix socket / 命名管道 / AppleScript 桥——**或**网关自有的进程内 handler（Obsidian 与 claudecode 模式把它们的进程内 bridge 标记为 `ipc`）。 | `{ op }` 或 socket 提示。 |
| `skill` | `kind:"skill"` 条目。不走 wire；`body` 作为上下文交付。 | ——（携带 `body`）。 |
| `workflow` | `kind:"workflow"` 条目。不走 wire；`WorkflowTransport` 对每个成员重入 invoke 管线（ADR-013）。 | ——（携带 `members`）。 |

**作者的选择规则：** 应用已有 localhost HTTP 接口 → `local-rest`。二进制程序 → `cli`。进程持续运行并通过协议通信 → `stdio`。操作系统套接字／AppleScript → `ipc`。纯使用知识 → `skill`。组合现有条目 → `workflow`。网关自有的进程内代码**不是**第三方作者可选的实现方式（§1、§9）。

## 5. 按能力授权的访问粒度 {#_5-按-capability-的-grants-与访问粒度}

规范性：[`GrantVerb`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1 + ADR-005。

- **默认拒绝：** 条目在其 `grants` 动词被授予之前不可调用。
- **默认只读：** 简写 `"allow"` 只授予 `["read"]`；更宽的动词必须显式请求，并明确展示给用户。
- 动词：
  - `read` —— 只查询、读数据，不变更。
  - `write` —— 变更用户机器上的状态或 app 数据。
  - `execute` —— 运行进程，或执行既非纯读也非简单写的副作用动作（发起一次编排、跑一次构建）。
- **只有令牌作用域内针对该 id 的授权涵盖条目要求的全部动词**，才允许调用。这种授权细化到每项能力、每个动词；MCP 以整个服务器为受众的授权无法表达这种粒度。

**编写要求：只声明必需的最少动词。** 只读能力**必须**声明 `grants:["read"]`，且不得静默写入。多报动词会让扩展显得更危险，削弱用户信任；少报则会导致调用在作用域检查时失败。资源实例范围限制（“only vault A, only path B”）**不是**动词。ADR-005 将实例级约束留待后续处理；这些限制须在 `io.input` 校验以及传输层／处理器中落实，可参照 Obsidian 的路径限制。

## 6. 为能力附上使用指导技能 {#_6-附着的使用技能}

能力可以附带**使用指导技能**，说明怎样用好这项能力。从能力条目能找到这些指导，从独立的 `kind:"skill"` 条目也能找到。编写方法如下：

1. 在 `capabilities[]` 里声明一个 `kind:"skill"` 条目，带 `body`（`{ format:"markdown", markdown }`），以及 `grants:[]`、`transport:"skill"`。
2. 在它所讲解的 capability 上设置 `route.attachSkills: ["<skill decl name>"]`。

网关的 `manifestEntries()` 会在能力条目上生成 `skills: [{ id, label }]` 引用，指向已生成的技能条目。技能内容作为上下文提供，**可发现，但不可调用**；桥接层会拒绝对 `kind:"skill"` 条目的调用，并返回 `transport_error`。Obsidian 的 `vault.read` ↔ `vault.how-to-cite` 就是这样的配对。

## 7. secret / 凭据处理（`secretRef`）

规范性：[`ExtensionSecretRef`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1b +
`PlatformServices.resolveSecret` §6 + ADR-009(c)。

扩展**从不携带 secret 值**，只声明*引用*：

```json
"secrets": [ { "name": "obsidian-rest-api-key", "attach": "bearer" } ]
```

| `ExtensionSecretRef` 字段 | 含义 |
|---|---|
| `name` | 逻辑 secret 名。值存放在 `~/.plexus/secrets/`（可用时走 OS keychain），派发时由 `PlatformServices.resolveSecret(name)` 解析。 |
| `attach` | 所属传输通过哪种方式提供凭据：`bearer` / `header` / `query` / `env`。 |
| `as` | `attach` 为 `header`/`query`/`env` 时的头/查询/环境变量键名。 |

**契约（硬性保证）：** secret 值**绝不**出现在 manifest、`.well-known` 文档、handshake manifest 快照或任何审计 `detail` 里（审计脱敏本身就是契约——`AuditRedactionPolicy`）。值**只**在派发时交给拥有它的 transport，经 `route.secret`/`LocalServiceLocation.secretRef` 按 `name` 引用。需要凭据的作者声明引用和 attach 方式；用户在带外把值预置进 `~/.plexus/secrets/`。预置值是**管理客户端 / 操作者的动作**，**不属于** manifest。

## 8. 校验规则 —— manifest 何时有效、何时无效

网关会执行这些规则，其中一部分在注册时检查，另一部分在调用时检查。编写工具（M4 meta-skill）**应（SHOULD）** 提前校验全部规则。

**注册时拒绝（`registerExtension` / `POST /extensions`）：**
1. `manifest !== "plexus-extension/0.1"` → 拒绝（实时守卫：`"invalid extension manifest …"`）。
2. `source` 缺失或为空 → 拒绝。
3. 若 `capabilities[]` 为空，响应会返回 `ok:false`，原因为 *"extension materialized but contributed no entries."*。编写工具必须（MUST）在提交前检查出这种情况。
4. `source` 认领了**保留的 first-party id**（`RESERVED_SOURCE_IDS`——编译期模块 id 加上 `obsidian` 与 `mock`）→ wire 注册被拒绝（杜绝 first-party 冒名）。请选用自己的 `source` id。
5. 技能或工作流声明**跨来源附加**，即附加到*其他来源*的条目时，默认拒绝，因为这可能成为提示注入通道。若要允许，需设置明确的准入控制，并取得用户确认。

**结构有效性（编写工具 / 规范层——良构的 manifest 必须满足）：**
6. 每个 `capabilities[].name` 都必须是非空的 `<noun>.<verb>` slug，且在同一清单内唯一。名称重复会生成相同的 ID，而 ID 必须唯一。
7. `transport`（manifest 级 + 声明级）∈ `{local-rest, stdio, ipc, cli, skill, workflow}` —— **绝不允许 `mcp`**（类型已将其 `Exclude`）。
8. `kind:"skill"` ⇒ 有 `body`、`grants:[]`、`transport:"skill"`，无 `io`/`members`。
9. `kind:"workflow"` 必须有 `members[]`。注册时，每个 `members[].id` 都必须能解析到注册表中**已存在的条目**；每个 `members[].verbs` 都必须是对应成员条目所需 `grants` 的子集（ADR-012）。成员 ID 若未指向任何条目，传递授权就没有目标，工作流因此无效。
10. `kind:"capability"` ⇒ `grants` 是最小动词集；`io.input`（若有）是有效的 JSON Schema Draft 2020-12。
11. 任何 `route.secret` 及带 `attach` 的 `ExtensionSecretRef`，都必须点名 manifest `secrets[]` 里列出的 secret。
12. `route.attachSkills[]` 的每个值都必须是同一清单中某个 `kind:"skill"` 声明的名称。

**跨源冲突（网关，refresh 时）：** 若贡献的 id 与另一个 source 已认领的 id 冲突，**先认领者胜出**，重复者被跳过（按 ID 派生规则，跨源冲突就是 source 命名 bug——换一个 `source`）。

**invoke 时强制（而非注册时）：** `io.input` schema 校验（`schema_validation_failed`）、授权/动词作用域检查（`grant_required`）、会话存活 + jti 撤销。作者绕不过这些。

## 9. 注册流程

### 9.1 通过传输通道接入：`POST /extensions` {#_9-1-由-transport-背书-——-post-extensions}

规范性：[`ExtensionRegisterRequest`/`Response`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1b、
[`handlers.extensions`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/core/handlers.ts)。

```
POST /extensions
{ "sessionId": "sess_…", "manifest": { … ExtensionManifest … } }
```

- 需要**活跃的 handshake 会话**（`sessionId` 必须存活——注册是用户授权的动作）。Host/Origin 守卫先行（ADR-016）。
- 注册要经过**用户确认流程**：代理可以*请求*注册，但不能自行*激活*扩展。
  1. **校验**（`validateRegistration`，不提交）——执行 §8 的校验规则。网络注册请求按不可信输入处理，须检查是否使用保留 ID，以及是否声明跨来源附加。校验失败时，以 `outcome:"rejected"` 记录 `source.install` 审计事件，并返回 `ok:false` + `reason`。
  2. **通过传输接入的清单**（`cli` / `local-rest` / `stdio` / `ipc`）进入 PENDING 状态：网关在审计中记录 `outcome:"pending"`，并返回待批准记录，列出所有者将批准的 cli 可执行文件、rest 主机、跨来源附加关系和操作动词。`registerExtension` 和 `manifest_changed` 事件**只有在所有者批准后才会执行**。
  3. 纯 **skill/workflow** manifest（无外部 transport）直接提交：以 `outcome:"committed"` 记审计，随后 `registerExtension` + `manifest_changed`，提示已连接的 agent 重新拉取（`GET /manifest`）。
- 待批准响应（通过传输接入的清单）：

```json
{ "status": "grant_pending_user", "pendingId": "pend_…",
  "pending": ["my-obsidian"], "statusUrl": "…", "approvalUrl": "…" }
```

- 提交后的响应（owner 批准之后；纯 skill/workflow manifest 则立即返回）：

```json
{ "ok": true, "source": "my-obsidian", "registered": ["my-obsidian.vault.read"],
  "revision": 7 }
```

`registered` 列出真正进入注册表的 id。manifest 被拒或为空时返回 `ok:false` + `reason`。**这条 wire 提供不了进程内 handler**——HTTP 路径只以 manifest 调用 `registerExtension(manifest)`。

### 9.2 进程内 —— `registerExtension(manifest, { handlers })`

网关自有代码（第一方来源、网关捆绑模块）直接调用注册表，可按声明的 `name` 绑定进程内 `ExtensionHandler`。处理器写入 `entry.extras.route.handler`（核心从不读取该字段），由 `ExtensionBridge` 直接执行，不经外部传输分发。Obsidian 的 vault-read 就采用这种方式。（claudecode 又有所不同：它是编译期内置的第一方 `SourceModule`，有自己的桥接器，见 `sources/claudecode/`，并不调用 `registerExtension`。）**仅限经过网关测试、由专用逻辑强制执行约束的能力**，外部作者不能通过这条路径接入。

### 9.3 注册做什么（两条通道）

`registerExtension`（capability-registry）将清单转为一个 `SourceModule`，把它**叠加到**共享的 `SourceRegistry` 上，让调用流程能解析到它的桥接器；随后启动生命周期源，重新扫描，使条目进入注册表，让 `revision` 单调递增，并向 `/events` 订阅者发送变更通知。**可在现有系统中添加扩展，也可撤销注册**，无需修改编译时的 `MODULES`，也无需在核心代码中增加分支。

## 10. 生命周期

| 阶段 | 机制 |
|---|---|
| **注册** | `POST /extensions`（校验 → 通过传输接入的清单进入 PENDING，等待所有者批准；批准后才提交并触发 `manifest_changed`；纯 skill/workflow 清单直接提交，见 §9.1），或在进程内调用 `registerExtension()`：生成模块 + 扫描 + 递增 revision + 触发 `manifest_changed`。**管理员安装**的扩展（`POST /admin/api/extensions`）在安装时**还会**持久化到 `~/.plexus/extensions.json`。 |
| **刷新** | `CapabilityRegistry.refresh()` 会重新扫描所有来源（包括扩展），比较扫描前后的条目集合；只有条目发生变化才递增修订号。来源的 `onEntriesChanged` 会触发刷新。 |
| **list_changed** | revision 推进会在 `GET /events`（SSE）上触发 `ManifestChangedEvent`。agent 比较 `Manifest.revision` 后重新拉取 `GET /manifest`。 |
| **重新注册** | 再次注册同一个 `source` 会替换其模块，释放旧的生命周期源，再重新扫描新模块。这种处理方式便于实现幂等性。 |
| **availability** | `ExtensionSource.checkRequirements()` 报告可达性（`local-rest` 扩展可报告其服务离线 → `source_status` 事件 / 可用性徽章）。 |
| **persistence** | 管理员安装的扩展是**持久的**：manifest 在安装时持久化到 `~/.plexus/extensions.json`，并**在启动时重放**，网关重启**不会**丢掉它们——它们自动重新注册（commit 654dcfa）。（agent 发起的、纯会话作用域的 `POST /extensions` 注册才是瞬态的；持久的是管理员安装路径。） |
| **注销** | `DELETE /extensions/:source` 已实现，`server.ts` 通过 `app.delete("/extensions/:source", …)` 注册该路由。它会移除运行时注册的来源，并**清除该来源的授权**，但不改动持久化存储，因此管理员安装的扩展会在下次启动时重新注册。若还要删除持久化记录，使用 `DELETE /admin/api/extensions/:source`，它会额外从 `~/.plexus/extensions.json` 删除已保存的清单。教程通过这个接口移除扩展。 |

## 11. 安全边界 —— 扩展能做什么、不能做什么

注册后的扩展与其他来源一样，**都受同一套网关处理流程约束**。扩展没有任何特权通道。

**（通过传输层接入的）扩展可以：**
- 贡献可发现的条目（capability/skill/workflow）。
- 经 `local-rest`/`cli`/`stdio`/`ipc` 触达本地服务或二进制。
- 声明它所需的动词和 secret 引用。
- 把已有条目组合成 workflow（传递性授权受强制检查）。

**扩展不能做以下事情（这些限制同样约束恶意 manifest）：**
- **在网关里运行任意进程内代码。** HTTP 路径只物化 manifest；`handler` 函数上传不了。进程内 handler 是网关自有、编译期绑定的能力。
- **绕过授权。** 所有条目都默认拒绝调用；如果没有作用域覆盖本次调用的令牌，调用会被拒绝，并返回 `grant_required`。声明 `grants:["read"]` 并不允许条目写入；声明的操作动词集合，就是用户看到并授予的权限。
- **借 workflow 提权。** workflow 的成员在由 `members[]` 派生的*合成传递作用域*下运行，在授权确认时展示给用户，并逐成员走同一管线做作用域检查（ADR-012/013）。没有静默提权；扇出中途的撤销会中止其余成员。
- **从 manifest 公开的数据中读取机密值。** 机密信息以引用形式声明，只有在分派时才会解析为值，并交给其所属的传输。值不会出现在 manifest、`.well-known`、manifest 快照或审计记录中。
- **伪造身份，或接受来自其他主机的访问。** 每个端点都会在身份认证前执行 Host/Origin 校验（ADR-016）；仅绑定回环地址。
- 扩展无法**越出实例的资源访问边界**，前提是传输层或处理器实施了相应限制（Obsidian 的路径限制会以 `transport_error` 拒绝通过 `..`、绝对路径或符号链接越界的访问）。实例级限制由传输层负责，传输层作者应明确设计并落实。
- **逃避审计。** 每次调用和每次分派前的拒绝都会写入审计记录，详情中的敏感信息会经过脱敏处理。

**用户注册通过传输层接入的扩展时，仍给予了以下信任：** 扩展可以让网关发起本地 HTTP 调用，或启动它指定的二进制程序，但仅限于用户授予的动词。用户可以靠授权提示（其中会显示动词）、审计日志和撤销授权的能力来保护自己。如果扩展指定了用户不信任的 `cli` 二进制程序，就不应向该扩展授予 `execute`。

## 12. 完整 manifest 示例

### 12.1 `local-rest`，只读，带一个 secret + 一个附着技能（Obsidian）

> `obsidian` 本身是保留的 first-party source id（§8 规则 4），wire 注册要选用自己的 id——这里用 `my-obsidian`。

```json
{
  "manifest": "plexus-extension/0.1",
  "source": "my-obsidian",
  "label": "Obsidian (Local REST API)",
  "transport": "local-rest",
  "secrets": [ { "name": "obsidian-rest-api-key", "attach": "bearer" } ],
  "serviceHint": { "app": "obsidian", "defaultPort": 27123 },
  "capabilities": [
    {
      "name": "vault.read",
      "kind": "capability",
      "label": "Read Obsidian notes",
      "describe": "Read Markdown from a local Obsidian vault by path or full-text search, so the agent can cite the user's personal knowledge base. Use when the task references the user's notes or prior decisions. Read-only: never mutates the vault.",
      "io": {
        "input": {
          "type": "object",
          "properties": {
            "query": { "type": "string", "description": "Full-text query." },
            "path": { "type": "string", "description": "Vault-relative note path." }
          },
          "anyOf": [ { "required": ["query"] }, { "required": ["path"] } ]
        }
      },
      "grants": ["read"],
      "transport": "local-rest",
      "route": { "method": "GET", "pathTemplate": "/search/simple", "secret": { "name": "obsidian-rest-api-key", "attach": "bearer" }, "attachSkills": ["vault.how-to-cite"] }
    },
    {
      "name": "vault.how-to-cite",
      "kind": "skill",
      "label": "How to cite an Obsidian vault",
      "describe": "Usage guidance for my-obsidian.vault.read: read by vault-relative path, cite by relative path, read-only + path-confined.",
      "grants": [],
      "transport": "skill",
      "body": { "format": "markdown", "markdown": "# How to cite an Obsidian vault\nRead notes by their vault-relative path; cite by relative path; read-only." }
    }
  ]
}
```

### 12.2 `cli`：能执行写入操作的二进制程序（本地格式化工具） {#_12-2-cli-可写的二进制-一个本地格式化器}

```json
{
  "manifest": "plexus-extension/0.1",
  "source": "prettier",
  "label": "Prettier (local code formatter)",
  "transport": "cli",
  "capabilities": [
    {
      "name": "code.format",
      "kind": "capability",
      "label": "Format a file with Prettier",
      "describe": "Format a source file in place using the local `prettier` binary. Use when the agent has written or edited a file and wants it formatted to the project's style. Mutates the file on disk ⇒ requires write.",
      "io": {
        "input": {
          "type": "object",
          "properties": { "path": { "type": "string", "description": "Absolute path of the file to format." } },
          "required": ["path"]
        }
      },
      "grants": ["write"],
      "transport": "cli",
      "route": { "bin": "prettier", "args": ["--write", "{path}"] }
    }
  ]
}
```

### 12.3 `workflow`，组合两个已有 capability

> 成员必须是注册表中已有的条目（可以是本例中由同一份 manifest 声明的两个能力，也可以用其他来源中已有条目的 ID 来指定）。

```json
{
  "manifest": "plexus-extension/0.1",
  "source": "notes",
  "label": "Notes helpers",
  "transport": "cli",
  "capabilities": [
    {
      "name": "vault.read", "kind": "capability", "label": "Read a note",
      "describe": "Read a note by path. Read-only.",
      "io": { "input": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } },
      "grants": ["read"], "transport": "cli", "route": { "bin": "notescli", "args": ["read", "{path}"] }
    },
    {
      "name": "vault.append", "kind": "capability", "label": "Append to a note",
      "describe": "Append text to a note. Mutates the note ⇒ write.",
      "io": { "input": { "type": "object", "properties": { "path": { "type": "string" }, "text": { "type": "string" } }, "required": ["path", "text"] } },
      "grants": ["write"], "transport": "cli", "route": { "bin": "notescli", "args": ["append", "{path}", "{text}"] }
    },
    {
      "name": "daily.log", "kind": "workflow", "label": "Read then append to today's daily note",
      "describe": "Read today's daily note and append a timestamped line. Use to journal an event. Composes a read then a write ⇒ granting this implies its members' read+write.",
      "grants": ["write"], "transport": "workflow",
      "members": [
        { "id": "notes.vault.read", "verbs": ["read"] },
        { "id": "notes.vault.append", "verbs": ["write"] }
      ]
    }
  ]
}
```

授予 `notes.daily.log`（write）会合成传递性的成员作用域 `notes.vault.read`/read + `notes.vault.append`/write，在授权确认时展示给用户，并写入 token（`synthesizedFor`）；`WorkflowTransport` 经统一的 invoke 管线扇出（§9、ADR-013）。

## 13. 合规清单（供编写工具使用）

一份 manifest **符合本规范**，当且仅当：`manifest === "plexus-extension/0.1"`；提供 `source` 和 `label`；`transport` 不为 `mcp`；至少有 1 个能力条目；每个声明都有 `name`、`kind`、`label`、`describe` 和 `grants`；技能声明包含 `body` + `grants:[]`；工作流声明包含 `members[]`，其中每个 ID 都能在注册表中找到对应条目，且 `verbs` 是对应成员所声明的授权动词集合的子集；每个 `route.secret` 都引用已声明的机密信息；`route.attachSkills[]` 中的每个引用都指向已声明的技能；`io.input`（若提供）是有效的 JSON Schema 2020-12。网关执行的完整规则见 §8。
