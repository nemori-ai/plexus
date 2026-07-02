---
title: 扩展规范
description: Plexus 标准扩展规范（v0.1）：编写扩展的公开契约，涵盖 manifest schema、transport、grants、secret、校验规则与安全边界。
---

# Plexus 标准扩展规范 —— v0.1

::: tip 状态
**M4 公开规范（v0.1）** · 协议：**plexus-extension/0.1** · 网关契约：**PLEXUS_PROTOCOL_VERSION 0.1.3** · 日期：2026-06-23

这是**编写 Plexus 扩展**的公开契约——任何人要把本地 app、CLI、脚本或 HTTP 服务接入 Plexus，让任意 AI agent 能 DISCOVER → UNDERSTAND → be GRANTED → CALL 它，走的就是这份契约。它把**已在发布的实现**（`ExtensionManifest`、`materializeExtension`、`CapabilityRegistry.registerExtension`、`ExtensionSource`/`ExtensionBridge`）**形式化**为稳定的编写接口，不发明新的 wire。当某个字段的规范性来源是冻结类型时，本文直接指向该类型，以类型为权威。
:::

- 冻结类型：[`src/protocol/types.ts`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1、§1b、§6。
- 运行时：[`packages/runtime/src/sources/extension.ts`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/sources/extension.ts)、
  [`packages/runtime/src/core/capability-registry.ts`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/core/capability-registry.ts)。
- 完整示例源：[`packages/runtime/src/sources/obsidian/`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/sources/obsidian/)、
  [`packages/runtime/src/sources/cc-master/`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/sources/cc-master/)。
- ADR：[决策记录](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/DECISIONS.md) ADR-003/004/005/009/012/013。

## 1. 什么是扩展

**扩展**是用户可安装的 bundle：声明一个 **capability source** 及其贡献的**条目**，打包成一份
[`ExtensionManifest`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts)。注册时，网关把 manifest **物化**为运行时 `CapabilitySource`——*形状上与编译期 first-party source 完全相同*——因此网关对它一视同仁：条目可被发现（`.well-known` / handshake manifest / `GET /manifest`）、可被授权（`PUT /grants`）、可被调用（`POST /invoke`）。**agent 分辨不出用户扩展、first-party 适配器和被摄取的 MCP 工具——三者都只是 `CapabilityEntry` 对象。**

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

1. **由 transport 背书** —— HTTP `POST /extensions` 端点。manifest 的条目经 wire transport（`local-rest` / `cli` / `stdio` / `ipc`）或哨兵值（`skill` / `workflow`）触达。外部作者一律走这条路。**不运行任何进程内代码。**
2. **进程内 handler** —— 由网关自有代码调用 `capabilities.registerExtension(manifest, { handlers })`（如 Obsidian vault 读取、cc-master board 操作）。保留给 first-party / 随网关捆绑的 source，用于交付定制的、经网关测试的执行逻辑。**无法经 wire 触达**（函数上传不了）；第三方扩展注入不了进程内代码。

## 2. 扩展 manifest schema

规范性类型：[`ExtensionManifest`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1b。wire 上的 JSON 是一个扁平、可 JSON 序列化的对象。

| 字段 | 必需 | 类型 | 含义 |
|---|---|---|---|
| `manifest` | **是** | `"plexus-extension/0.1"` 字面量 | Manifest schema 版本。任何其他值网关一律**拒绝**。 |
| `source` | **是** | `SourceId` | 此扩展注册的 source id。其 id-slug（`:`→`.`）为每个条目 id 播种（ID 派生规则）。小写 kebab/点，如 `obsidian`、`linear`、`mcp:github`（slug `mcp.github`）。 |
| `label` | **是** | `string` | 人类可读的 source 标签，如 `"Obsidian (Local REST API)"`。 |
| `transport` | **是** | `Exclude<TransportKind,"mcp">` | capability 未覆盖时的默认 transport。取 `local-rest \| stdio \| ipc \| cli \| skill \| workflow` 之一。 |
| `capabilities` | **是** | `ExtensionCapabilityDecl[]` | 此扩展贡献的条目（capability/skill/workflow）。要有效注册就必须非空。 |
| `secrets` | 否 | `ExtensionSecretRef[]` | transport 所需的 secret 引用（经平台缝按名解析；见 §7）。 |
| `serviceHint` | 否 | `LocalServiceHint` | 如何定位 `local-rest`/`ipc` 服务（`{ app, defaultPort?, socketName? }`）。 |

### 2.1 `ExtensionCapabilityDecl` —— 一条被贡献的条目

规范性类型：[`ExtensionCapabilityDecl`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1b。

| 字段 | 必需 | 类型 | 含义 |
|---|---|---|---|
| `name` | **是** | `string` | `<noun>.<verb>` 后缀。完整 id 为 `<sourceSlug>.<name>`（如 source `obsidian` + name `vault.read` ⇒ id `obsidian.vault.read`）。 |
| `kind` | **是** | `"capability" \| "skill" \| "workflow"` | 条目种类（ADR-004）。 |
| `label` | **是** | `string` | 简短的人类/agent 标签。 |
| `describe` | **是** | `string` | **核心字段。** 面向 agent 的"什么 / 何时 / 如何"，写给决定是否调用它的 AI 看。遵循 claude-plugin 约定：*"Action outcome. Use when X."*（见 §3。） |
| `grants` | **是** | `GrantVerb[]` | 此条目所**需**的动词（`read`/`write`/`execute`）。`[]` = 无需授权（skill）。默认拒绝 + 默认只读（ADR-005）。 |
| `transport` | 否 | `Exclude<TransportKind,"mcp">` | 为此条目覆盖 manifest 默认值。 |
| `io` | 否 | `IoSchema` | `{ input?, output? }` JSON Schema（Draft 2020-12）。输入在 invoke 时被**强制校验**。skill 省略。 |
| `members` | `kind:"workflow"` 时必需 | `WorkflowMember[]` | 有序的成员 id + workflow 可对每个成员行使的动词。每个 id 必须解析到在场的注册表条目（§8）。 |
| `body` | `kind:"skill"` 时必需 | `SkillBody` | 内联的使用 markdown（`{ format:"markdown", markdown }`）或一个内容引用。 |
| `route` | 否 | `Record<string, unknown>` | Transport 路由配置——**只由拥有它的 transport 读取，核心从不读**。见 §5 + §6。 |

### 2.2 `route` 可识别的键（按 transport）

`route` 是一个开放的键值袋。网关核心从不读它；只有拥有它的 transport（或 skill 反向链接的接线）会读。可识别的键：

| 键 | 由谁读 | 含义 |
|---|---|---|
| `attachSkills: string[]` | `manifestEntries()` | 要反向链接到此 capability 的 `kind:"skill"` 条目的声明 `name`（成为 `entry.skills[]`）。见 §6。 |
| `method`、`pathTemplate`、`secret` | `local-rest` transport | HTTP 方法、URL 路径模板（可插值输入字段）、要附上的 secret。`secret` 是一个**对象** `{ name, attach?, as? }`——transport 读 `route.secret?.name`（要解析的 `ExtensionSecretRef` 名）、`route.secret?.attach`（默认 `bearer` / `header` / `query`）、`route.secret?.as`（`header`/`query` 时的头/查询键名）。运行时 `LocalRestTransport` 读 `pathTemplate`（规范名），`path` 作为遗留别名仍被接受。 |
| `bin`、`args`、`secret` | `cli` transport | 二进制名（经平台缝解析）、argv 模板、secret 环境变量。 |
| `op` | `ipc`/进程内 bridge | 进程内操作选择器（如 cc-master `board.create`）。 |
| `handler` | 仅进程内 bridge | 由 `registerExtension(..., { handlers })` 绑定——**是函数，不可序列化，绝不出现在 wire manifest 里**（§9）。 |

## 3. 写好 `describe`（agent 的相关性信号）

`describe` 是 MCP 缺失的那一层——它讲的是*怎么用好我*，不只是*我是什么*。范本就是 claude-plugin SKILL.md 的 `description` 约定：

> **Action outcome. Use when X.** 之后给出调用形状和关键约束。

范例（来自已发布的 Obsidian 扩展）：

> "Read notes from the Obsidian vault \"Research\" READ-ONLY. Use when you need
> the text of the user's notes to answer, summarize, or cite. Pass `{ path }`
> relative to the vault root to read a note; omit path to list notes.
> Path-confined to the vault; never writes."

清单：
- 开头写**结果**（agent 能得到什么），不写实现。
- 说明**何时该选它**而非其他选择。
- 用一行写清**调用形状**（`io.input` 才是形式契约）。
- 写明**边界**（只读、路径受限、有副作用、需要 execute）——agent 正是靠这些权衡授权代价。

`.well-known` 里的摘要预览就是 `describe` 的**第一行**（见 capability-registry 的 `toSummary`）。把第一行写成完整的句子。

## 4. Transport 选择

规范性：[`TransportKind`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1 + ADR-003。扩展可以使用**除 `mcp` 外**的任何 transport（MCP 是网关享有特权的摄取路径；MCP 条目不是*编写*出来的，而是被*摄取*的）。

| Transport | 用它做什么 | `route` 配置 |
|---|---|---|
| `local-rest` | 暴露 localhost HTTP(S) API 的 app（Obsidian Local REST、本地 web 服务）。Plexus 充当 HTTP 客户端。 | `{ method, pathTemplate, secret? }` + `serviceHint`/`secrets`。 |
| `cli` | 用 argv 调用、捕获 stdout（可选 `--format json`）的二进制。二进制经平台 path-resolver 定位。 | `{ bin, args, secret? }`。 |
| `stdio` | 在 stdin/stdout 上说行/JSON（NDJSON）协议的长驻子进程。 | 经 `serviceHint`/`route` 给出 spawn 规格。 |
| `ipc` | OS IPC —— unix socket / 命名管道 / AppleScript 桥——**或**网关自有的进程内 handler（Obsidian 与 cc-master 模式把它们的进程内 bridge 标记为 `ipc`）。 | `{ op }` 或 socket 提示。 |
| `skill` | `kind:"skill"` 条目。不走 wire；`body` 作为上下文交付。 | ——（携带 `body`）。 |
| `workflow` | `kind:"workflow"` 条目。不走 wire；`WorkflowTransport` 对每个成员重入 invoke 管线（ADR-013）。 | ——（携带 `members`）。 |

**作者的决策规则：** app 已经在 localhost 上说 HTTP → `local-rest`。是二进制 → `cli`。是长驻的协议进程 → `stdio`。是 OS socket / AppleScript → `ipc`。纯使用知识 → `skill`。组合已有条目 → `workflow`。网关自有的进程内代码对第三方**不是**编写选项（§1、§9）。

## 5. 按 capability 的 grants 与访问粒度

规范性：[`GrantVerb`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1 + ADR-005。

- **默认拒绝：** 条目在其 `grants` 动词被授予之前不可调用。
- **默认只读：** 裸 `"allow"` 只授予 `["read"]`；更宽的动词必须显式请求，并向用户浮现。
- 动词：
  - `read` —— 只查询、读数据，不变更。
  - `write` —— 变更用户机器上的状态或 app 数据。
  - `execute` —— 运行进程，或执行既非纯读也非简单写的副作用动作（发起一次编排、跑一次构建）。
- 一次调用被放行，**当且仅当条目所需的每个动词都在**该 id 的 token 作用域里。按 capability + 按动词的粒度，是 MCP 整服务器一刀切的 auth 表达不出来的。

**编写纪律：声明**最小**动词集。** 只读 capability 必须声明 `grants:["read"]`，且绝不静默写入。动词声明过宽，扩展显得更危险，侵蚀用户信任；声明不足，调用会在作用域检查时失败。资源实例级的限定（"只允许 vault A、只允许路径 B"）**不是**动词——在 `io.input` 校验和 transport/handler 里执行它（Obsidian 的路径受限就是范本），这与 ADR-005 将实例级约束推迟的决定一致。

## 6. 附着的使用技能

capability 可以携带**附着的使用 skill**，让"怎么用好我"既能从 capability 侧被发现，也作为独立的 `kind:"skill"` 条目存在。写法：

1. 在 `capabilities[]` 里声明一个 `kind:"skill"` 条目，带 `body`（`{ format:"markdown", markdown }`），以及 `grants:[]`、`transport:"skill"`。
2. 在它所讲解的 capability 上设置 `route.attachSkills: ["<skill decl name>"]`。

网关的 `manifestEntries()` 会接好反向链接：capability 获得 `skills: [{ id, label }]`，指向物化后的 skill 条目。skill 是作为上下文来读的条目——**可发现、不可调用**（对 `kind:"skill"` 条目发起 invoke，bridge 会以 `transport_error` 拒绝）。Obsidian 的 `vault.read` ↔ `vault.how-to-cite` 就是这样一对。

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
| `attach` | 拥有它的 transport 如何呈递：`bearer` / `header` / `query` / `env`。 |
| `as` | `attach` 为 `header`/`query`/`env` 时的头/查询/环境变量键名。 |

**契约（硬性保证）：** secret 值**绝不**出现在 manifest、`.well-known` 文档、handshake manifest 快照或任何审计 `detail` 里（审计脱敏本身就是契约——`AuditRedactionPolicy`）。值**只**在派发时交给拥有它的 transport，经 `route.secret`/`LocalServiceLocation.secretRef` 按 `name` 引用。需要凭据的作者声明引用和 attach 方式；用户在带外把值预置进 `~/.plexus/secrets/`。预置值是**管理客户端 / 操作者的动作**，**不属于** manifest。

## 8. 校验规则 —— manifest 何时有效、何时无效

网关强制以下规则（部分在注册时，部分在 invoke 时）。编写工具（M4 元技能）**应当**把它们全部预先校验。

**注册时拒绝（`registerExtension` / `POST /extensions`）：**
1. `manifest !== "plexus-extension/0.1"` → 拒绝（实时守卫：`"invalid extension manifest …"`）。
2. `source` 缺失或为空 → 拒绝。
3. （编写工具也必须抓住；网关视之为"未贡献条目"：）`capabilities[]` 为空 → 响应 `ok:false`，原因为 *"extension materialized but contributed no entries."*

**结构有效性（编写工具 / 规范层——良构的 manifest 必须满足）：**
4. 每个 `capabilities[].name` 在 manifest 内唯一、非空，形如 `<noun>.<verb>` slug（id 必须唯一；name 重复会撞出同一个 id）。
5. `transport`（manifest 级 + 声明级）∈ `{local-rest, stdio, ipc, cli, skill, workflow}` —— **绝不允许 `mcp`**（类型已将其 `Exclude`）。
6. `kind:"skill"` ⇒ 有 `body`、`grants:[]`、`transport:"skill"`，无 `io`/`members`。
7. `kind:"workflow"` ⇒ 有 `members[]`；每个 `members[].id` 在注册时解析到**在场**的注册表条目；每个 `members[].verbs` ⊆ 该成员条目所需的 `grants`（ADR-012）。成员 id 悬空的 workflow 没有传递性授权目标——无效。
8. `kind:"capability"` ⇒ `grants` 是最小动词集；`io.input`（若有）是有效的 JSON Schema Draft 2020-12。
9. 任何 `route.secret` 及带 `attach` 的 `ExtensionSecretRef`，都必须点名 manifest `secrets[]` 里列出的 secret。
10. `route.attachSkills[]` 必须点名同一 manifest 里在场的 `kind:"skill"` 声明。

**跨源冲突（网关，refresh 时）：** 若贡献的 id 与另一个 source 已认领的 id 冲突，**先认领者胜出**，重复者被跳过（按 ID 派生规则，跨源冲突就是 source 命名 bug——换一个 `source`）。

**invoke 时强制（而非注册时）：** `io.input` schema 校验（`schema_validation_failed`）、授权/动词作用域检查（`grant_required`）、会话存活 + jti 撤销。作者绕不过这些。

## 9. 注册流程

### 9.1 由 transport 背书 —— `POST /extensions`

规范性：[`ExtensionRegisterRequest`/`Response`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1b、
[`handlers.extensions`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/core/handlers.ts)。

```
POST /extensions
{ "sessionId": "sess_…", "manifest": { … ExtensionManifest … } }
```

- 需要**活跃的 handshake 会话**（`sessionId` 必须存活——注册是用户授权的动作）。Host/Origin 守卫先行（ADR-016）。
- 网关发出 `source.install` 审计事件，调用 `capabilities.registerExtension(manifest)`，再发布 `manifest_changed` 事件，提示已连接的 agent 重新拉取（`GET /manifest`）。
- 响应：

```json
{ "ok": true, "source": "obsidian", "registered": ["obsidian.vault.read"],
  "revision": 7 }
```

`registered` 列出真正进入注册表的 id。manifest 被拒或为空时返回 `ok:false` + `reason`。**这条 wire 提供不了进程内 handler**——HTTP 路径只以 manifest 调用 `registerExtension(manifest)`。

### 9.2 进程内 —— `registerExtension(manifest, { handlers })`

网关自有代码（first-party source、随网关捆绑的包）直接调用注册表，可按声明的 `name` 绑定进程内 `ExtensionHandler`。handler 被烘焙到 `entry.extras.route.handler`（核心从不读的字段），由 `ExtensionBridge` 直接运行，而不经 wire 派发。Obsidian vault 读取和 cc-master board 操作就是这个模式。**保留给经网关测试、定制执行的 capability**——它不是外部编写通道。

### 9.3 注册做什么（两条通道）

`registerExtension`（capability-registry）：把 manifest 物化成 `SourceModule`，**叠加**到共享的 `SourceRegistry` 上（invoke 管线由此解析它的 bridge），启动生命周期 source，重新扫描（条目进入注册表），单调推进 `revision`，并把变更推给 `/events` 订阅者。**加性且可逆**——不改编译期 `MODULES`，不加核心分支。

## 10. 生命周期

| 阶段 | 机制 |
|---|---|
| **register** | `POST /extensions` 或 `registerExtension()` —— 物化 + 扫描 + revision 推进 + `manifest_changed`。**管理员安装**的扩展（`POST /admin/api/extensions`）在安装时**还会**持久化到 `~/.plexus/extensions.json`。 |
| **refresh** | `CapabilityRegistry.refresh()` 重新扫描所有 source（含扩展），对条目集做差异，仅在有变化时推进 revision。source 的 `onEntriesChanged` 会触发一次 refresh。 |
| **list_changed** | revision 推进会在 `GET /events`（SSE）上触发 `ManifestChangedEvent`。agent 比较 `Manifest.revision` 后重新拉取 `GET /manifest`。 |
| **re-register** | 对同一个 `source` 再次注册会替换该模块（陈旧的生命周期 source 被丢弃，新模块被重新扫描）。幂等友好。 |
| **availability** | `ExtensionSource.checkRequirements()` 报告可达性（`local-rest` 扩展可报告其服务离线 → `source_status` 事件 / 可用性徽章）。 |
| **persistence** | 管理员安装的扩展是**持久的**：manifest 在安装时持久化到 `~/.plexus/extensions.json`，并**在启动时重放**，网关重启**不会**丢掉它们——它们自动重新注册（commit 654dcfa）。（agent 发起的、纯会话作用域的 `POST /extensions` 注册才是瞬态的；持久的是管理员安装路径。） |
| **unregister** | `DELETE /extensions/:source`（已发布）—— `server.ts` 接有 `app.delete("/extensions/:source", …)`。它移除运行时注册的 source，**清除该 source 的授权**，并把它从持久存储里清掉（下次启动不会回来）。教程就用这条路径拆掉扩展。 |

## 11. 安全边界 —— 扩展能做什么、不能做什么

注册后的扩展被**与所有 source 相同的网关管线收容**，拿不到任何特权路径。

**（由 transport 背书的）扩展可以：**
- 贡献可发现的条目（capability/skill/workflow）。
- 经 `local-rest`/`cli`/`stdio`/`ipc` 触达本地服务或二进制。
- 声明它所需的动词和 secret 引用。
- 把已有条目组合成 workflow（传递性授权受强制检查）。

**扩展不能（恶意 manifest 就是这样被收容的）：**
- **在网关里运行任意进程内代码。** HTTP 路径只物化 manifest；`handler` 函数上传不了。进程内 handler 是网关自有、编译期绑定的能力。
- **绕过授权。** 每个条目默认拒绝；没有覆盖到位的受限 token，invoke 就被以 `grant_required` 拒绝。声明 `grants:["read"]` 不会让条目获得写入——用户看到并授予的就是这组动词。
- **借 workflow 提权。** workflow 的成员在由 `members[]` 派生的*合成传递作用域*下运行，在授权确认时向用户浮现，并逐成员走同一管线做作用域检查（ADR-012/013）。没有静默提权；扇出中途的撤销会中止其余成员。
- **从 manifest 界面读到 secret 值。** secret 只是引用，只在派发时解析给拥有它的 transport；值从不进入 manifest、`.well-known`、manifest 快照或审计。
- **伪造身份或被跨主机触达。** Host/Origin 校验（ADR-016）在每个端点上先于 auth 运行；只绑定回环。
- **逃逸实例收容**——前提是 transport/handler 执行了它（Obsidian 的路径受限用 `transport_error` 拒绝 `..`、绝对路径和符号链接逃逸）。实例级收容是 transport 的职责——要刻意写好。
- **规避审计。** 每次 invoke（以及每次派发前的拒绝）都带着脱敏安全的 detail 被审计。

**注册一个 transport 背书扩展，用户交出的残余信任是：** 该扩展可以让网关在用户授予的动词下，发起它点名的本地 HTTP 调用、生成它点名的二进制。用户的防线是授权提示（动词可见）、审计日志和撤销能力。点名了用户不信任的 `cli` 二进制的扩展，就不该被授予 `execute`。

## 12. 完整 manifest 示例

### 12.1 `local-rest`，只读，带一个 secret + 一个附着技能（Obsidian）

```json
{
  "manifest": "plexus-extension/0.1",
  "source": "obsidian",
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
      "describe": "Usage guidance for obsidian.vault.read: read by vault-relative path, cite by relative path, read-only + path-confined.",
      "grants": [],
      "transport": "skill",
      "body": { "format": "markdown", "markdown": "# How to cite an Obsidian vault\nRead notes by their vault-relative path; cite by relative path; read-only." }
    }
  ]
}
```

### 12.2 `cli`，可写的二进制（一个本地格式化器）

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

> 成员必须已是在场的注册表条目——这里是同一 manifest 声明的两个 capability，也可以引用来自其他 source 的既有 id。

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

授予 `notes.daily.log`（write）会合成传递性的成员作用域 `notes.vault.read`/read + `notes.vault.append`/write，在授权确认时向用户浮现，并写入 token（`synthesizedFor`）；`WorkflowTransport` 经统一的 invoke 管线扇出（§9、ADR-013）。

## 13. 合规清单（供编写工具使用）

manifest **合规**，当且仅当：`manifest === "plexus-extension/0.1"`；`source` 与 `label` 在场；`transport` ≠ `mcp`；至少一个 capability；每条声明都有 `name`/`kind`/`label`/`describe`/`grants`；skill 声明携带 `body` + `grants:[]`；workflow 声明携带 `members[]`，其 id 解析到在场条目且 `verbs` ⊆ 成员的 grants；每个 `route.secret` 点名已声明的 secret；每个 `route.attachSkills[]` 点名已声明的 skill；`io.input`（若有）是有效的 JSON Schema 2020-12。网关强制的完整规则见 §8。
