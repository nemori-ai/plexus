---
title: 扩展规范
description: 规范性的 Plexus 标准扩展规范（v0.1）——编写一个扩展的公开契约，其 manifest schema、transport、grants、secret、校验规则与安全边界。
---

# Plexus 标准扩展规范 —— v0.1

::: tip 状态
**M4 公开规范（v0.1）** · 协议：**plexus-extension/0.1** · 网关契约：**PLEXUS_PROTOCOL_VERSION 0.1.3** · 日期：2026-06-23

这是**编写一个 Plexus 扩展**的公开、有据可查的契约——任何人把一个本地 app、CLI、脚本或 HTTP 服务连接到 Plexus，好让任何 AI agent 都能 DISCOVER → UNDERSTAND → be GRANTED → CALL 它的方式。它把**已经在发布的东西**（`ExtensionManifest`、`materializeExtension`、`CapabilityRegistry.registerExtension`、`ExtensionSource`/`ExtensionBridge`）**形式化**为一个稳定的编写界面。它不发明新线路。当一个字段的规范性来源是一个冻结类型时，本文指向它；以那个类型为权威。
:::

- 冻结类型：[`src/protocol/types.ts`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1、§1b、§6。
- 运行时：[`packages/runtime/src/sources/extension.ts`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/sources/extension.ts)、
  [`packages/runtime/src/core/capability-registry.ts`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/core/capability-registry.ts)。
- 完整示例源：[`packages/runtime/src/sources/obsidian/`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/sources/obsidian/)、
  [`packages/runtime/src/sources/cc-master/`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/sources/cc-master/)。
- ADR：[决策记录](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/DECISIONS.md) ADR-003/004/005/009/012/013。

## 1. 什么是一个扩展

一个**扩展**是一个用户可安装的捆绑包，它声明一个 **capability 源**及它贡献的**条目**，打包为一份
[`ExtensionManifest`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts)。当注册时，网关把该 manifest **物化**成一个运行时 `CapabilitySource`——*在形状上与一个编译期 first-party 源相同*——因此网关把它完全当作任何其他源对待：它的条目可被发现（`.well-known` / handshake manifest / `GET /manifest`）、可被授权（`PUT /grants`）、可被调用（`POST /invoke`）。**一个 agent 分辨不出一个用户扩展与一个 first-party 适配器或一个被摄取的 MCP 工具——三者都只是 `CapabilityEntry` 对象。**

**同构条目模型**（ADR-004）是核心：每一个 capability、skill、workflow 都是一个以 `kind` 判别的 `CapabilityEntry`。一个扩展经 `ExtensionCapabilityDecl` 声明条目，网关把每一个投影成一个完整的 `CapabilityEntry`（`id`、`source` 与技能反向链接由网关派生）。

```
ExtensionManifest  ──register──►  materializeExtension()  ──►  SourceModule
                                                                 │
                              ┌──────────────────────────────────┼─────────────────────┐
                              ▼ scan()                            ▼ createBridge()
                        ExtensionSource                     ExtensionBridge
                  (lifecycle: scan→CapabilityEntry[])   (per-session: invoke→transport|handler)
```

有**两条注册通道**（都以相同方式物化；见 §9）：

1. **由 transport 背书** —— HTTP `POST /extensions` 端点。该 manifest 的条目经一个线路 transport（`local-rest` / `cli` / `stdio` / `ipc`）或一个哨兵（`skill` / `workflow`）触达。这是任何外部作者所用的路径。**无进程内代码运行。**
2. **进程内 handler** —— 从网关拥有的代码调用 `capabilities.registerExtension(manifest, { handlers })`（如 Obsidian vault 读、cc-master board 操作）。保留给 first-party / 网关捆绑的源，它们发布定制的、经网关测试的执行。**不可经线路触达**（你无法上传一个函数）；一个第三方扩展无法注入进程内代码。

## 2. 扩展 manifest schema

规范性类型：[`ExtensionManifest`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1b。线路 JSON 是一个扁平的、可 JSON 序列化的对象。

| 字段 | 必需 | 类型 | 含义 |
|---|---|---|---|
| `manifest` | **是** | `"plexus-extension/0.1"` 字面量 | Manifest schema 版本。网关**拒绝**任何其他值。 |
| `source` | **是** | `SourceId` | 此扩展注册的源 id。它的 id-slug（`:`→`.`）为每个条目 id 播种（ID 派生规则）。小写 kebab/点，如 `obsidian`、`linear`、`mcp:github`（slug `mcp.github`）。 |
| `label` | **是** | `string` | 人类可读的源标签，如 `"Obsidian (Local REST API)"`。 |
| `transport` | **是** | `Exclude<TransportKind,"mcp">` | 不覆盖时 capability 的默认 transport。为 `local-rest \| stdio \| ipc \| cli \| skill \| workflow` 之一。 |
| `capabilities` | **是** | `ExtensionCapabilityDecl[]` | 此扩展贡献的条目（capability/skill/workflow）。要有用地注册就必须非空。 |
| `secrets` | 否 | `ExtensionSecretRef[]` | transport 所需的 secret 引用（经平台缝按名解析；见 §7）。 |
| `serviceHint` | 否 | `LocalServiceHint` | 如何定位一个 `local-rest`/`ipc` 服务（`{ app, defaultPort?, socketName? }`）。 |

### 2.1 `ExtensionCapabilityDecl` —— 一个被贡献的条目

规范性类型：[`ExtensionCapabilityDecl`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1b。

| 字段 | 必需 | 类型 | 含义 |
|---|---|---|---|
| `name` | **是** | `string` | `<noun>.<verb>` 后缀。完整 id 变为 `<sourceSlug>.<name>`（如源 `obsidian` + name `vault.read` ⇒ id `obsidian.vault.read`）。 |
| `kind` | **是** | `"capability" \| "skill" \| "workflow"` | 条目种类（ADR-004）。 |
| `label` | **是** | `string` | 简短的人类/agent 标签。 |
| `describe` | **是** | `string` | **核心。** 面向 agent 的"什么 / 何时 / 如何"，为一个决定是否调用它的 AI 而写。遵循 claude-plugin 约定：*"Action outcome. Use when X."*（见 §3。） |
| `grants` | **是** | `GrantVerb[]` | 此条目所**需**的动词（`read`/`write`/`execute`）。`[]` = 无需授权（skill）。默认拒绝 + 默认只读（ADR-005）。 |
| `transport` | 否 | `Exclude<TransportKind,"mcp">` | 为此条目覆盖 manifest 默认值。 |
| `io` | 否 | `IoSchema` | `{ input?, output? }` JSON Schema（Draft 2020-12）。输入在 invoke 时被**强制**。skill 省略。 |
| `members` | 对 `kind:"workflow"` | `WorkflowMember[]` | 有序的成员 id + workflow 可对每个成员行使的动词。每个 id 必须解析到一个在场的注册表条目（§8）。 |
| `body` | 对 `kind:"skill"` | `SkillBody` | 内联使用 markdown（`{ format:"markdown", markdown }`）或一个内容引用。 |
| `route` | 否 | `Record<string, unknown>` | Transport 路由配置——**只被拥有它的 transport 读，绝不被核心读**。见 §5 + §6。 |

### 2.2 `route` 可识别的键（按 transport）

`route` 是一个开放的袋子。网关核心从不读它；只有拥有它的 transport（或技能反向链接接线）读它。可识别的键：

| 键 | 由谁读 | 含义 |
|---|---|---|
| `attachSkills: string[]` | `manifestEntries()` | 要反向链接到此 capability 的 `kind:"skill"` 条目的声明 `name`（成为 `entry.skills[]`）。见 §6。 |
| `method`、`pathTemplate`、`secret` | `local-rest` transport | HTTP 方法、URL 路径模板（可插值输入字段）、以及要附上的 secret。`secret` 是一个**对象** `{ name, attach?, as? }`——transport 读 `route.secret?.name`（要解析的 `ExtensionSecretRef` 名）、`route.secret?.attach`（`bearer` 默认 / `header` / `query`）、以及 `route.secret?.as`（`header`/`query` 时的头/查询键）。运行时 `LocalRestTransport` 读 `pathTemplate`（规范名），接受 `path` 作为一个遗留别名。 |
| `bin`、`args`、`secret` | `cli` transport | 二进制名（经平台缝解析）、argv 模板、secret 环境变量。 |
| `op` | `ipc`/进程内 bridge | 进程内操作选择器（如 cc-master `board.create`）。 |
| `handler` | 仅进程内 bridge | 由 `registerExtension(..., { handlers })` 绑定——**一个函数，绝不可序列化，绝不在一份线路 manifest 里在场**（§9）。 |

## 3. 写一个好的 `describe`（那个 agent 相关性信号）

`describe` 是 MCP 没有的那一层——它是*如何用好我*，而不只是*我是什么*。claude-plugin SKILL.md 的 `description` 约定就是范本：

> **Action outcome. Use when X.** 然后是调用形状 + 那个关键约束。

范例（来自已发布的 Obsidian 扩展）：

> "Read notes from the Obsidian vault \"Research\" READ-ONLY. Use when you need
> the text of the user's notes to answer, summarize, or cite. Pass `{ path }`
> relative to the vault root to read a note; omit path to list notes.
> Path-confined to the vault; never writes."

清单：
- 以**结果**（agent 得到什么）打头，而非实现。
- 陈述**何时选它**而非替代方案。
- 用一行陈述**调用形状**（`io.input` 是那个形式契约）。
- 陈述**边界**（只读、路径受限、有副作用、需要 execute）——这正是让 agent 能对授权代价进行推理的东西。

`.well-known` 摘要预告就是 `describe` 的**第一行**（见 capability-registry 里的 `toSummary`）。把第一行写成一个完整的句子。

## 4. Transport 选择

规范性：[`TransportKind`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1 + ADR-003。一个扩展可以使用**除 `mcp` 之外**的任何 transport（MCP 是网关那个享有特权的摄取路径；你不*编写* MCP 条目，你*摄取*它们）。

| Transport | 用它做什么 | `route` 配置 |
|---|---|---|
| `local-rest` | 一个暴露 localhost HTTP(S) API 的 app（Obsidian Local REST、一个本地 web 服务）。Plexus 是那个 HTTP 客户端。 | `{ method, pathTemplate, secret? }` + `serviceHint`/`secrets`。 |
| `cli` | 一个用 argv 调用、捕获 stdout（可选 `--format json`）的二进制。二进制经平台 path-resolver 定位。 | `{ bin, args, secret? }`。 |
| `stdio` | 一个在 stdin/stdout 上说行/JSON（NDJSON）协议的长命子进程。 | 经 `serviceHint`/`route` 的 spawn 规格。 |
| `ipc` | OS IPC —— unix socket / 命名管道 / AppleScript 桥——**或**一个网关拥有的进程内 handler（Obsidian + cc-master 模式把它们的进程内 bridge 标记为 `ipc`）。 | `{ op }` 或 socket 提示。 |
| `skill` | `kind:"skill"` 条目。不是线路；`body` 作为上下文交付。 | ——（携带 `body`）。 |
| `workflow` | `kind:"workflow"` 条目。不是线路；`WorkflowTransport` 对每个成员重入 invoke 管线（ADR-013）。 | ——（携带 `members`）。 |

**作者的决策规则：** 若该 app 已经说 localhost HTTP → `local-rest`。若它是一个二进制 → `cli`。若它是一个持久协议进程 → `stdio`。若它是一个 OS socket/AppleScript → `ipc`。纯使用知识 → `skill`。已有条目的组合 → `workflow`。进程内网关拥有的代码对第三方而言**不是**一个编写选择（§1、§9）。

## 5. 按 capability 的 grants 与访问粒度

规范性：[`GrantVerb`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1 + ADR-005。

- **默认拒绝：** 一个条目在其 `grants` 动词被授予前不可调用。
- **默认只读：** 一个裸 `"allow"` 授予 `["read"]`；更宽的动词必须被显式请求并向用户浮现。
- 动词：
  - `read` —— 非变更的查询 / 数据读取。
  - `write` —— 变更用户机器上的状态 / app 数据。
  - `execute` —— 运行一个进程 / 一个既非纯读也非简单写的有副作用动作（启动一次编排、运行一次构建）。
- 一次调用被允许，**当且仅当该条目所需的每一个动词都在场于**该 id 的令牌作用域里。按 capability + 按动词是 MCP 的整服务器受众 auth 表达不出的粒度。

**编写纪律——声明**最小**动词集。** 一个只读 capability 必须声明 `grants:["read"]` 且绝不静默写入。过度声明动词让扩展看起来更危险、侵蚀用户信任；声明不足则让调用在作用域检查时失败。资源实例作用域限定（"只 vault A，只路径 B"）**不是**一个动词——在 `io.input` 校验里和在 transport/handler 里执行它（Obsidian 的路径受限就是范本），按 ADR-005 对实例级约束的推迟。

## 6. 附着的使用技能

一个 capability 可以携带**附着的使用技能**，好让"如何用好我"既可从该 capability 被发现，也作为一个独立的 `kind:"skill"` 条目被发现。编写它的方式：

1. 在 `capabilities[]` 里声明一个 `kind:"skill"` 条目，带一个 `body`（`{ format:"markdown", markdown }`）和 `grants:[]`、`transport:"skill"`。
2. 在它所教的那个 capability 上，设置 `route.attachSkills: ["<skill decl name>"]`。

网关的 `manifestEntries()` 接上反向链接：该 capability 得到 `skills: [{ id, label }]`，指向那个被物化的技能条目。技能是一个读作上下文的条目——**可被发现但不可调用**（bridge 会用 `transport_error` 拒绝一次对 `kind:"skill"` 条目的 invoke）。这恰是 Obsidian 的 `vault.read` ↔ `vault.how-to-cite` 配对。

## 7. secret / 凭据处理（`secretRef`）

规范性：[`ExtensionSecretRef`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1b +
`PlatformServices.resolveSecret` §6 + ADR-009(c)。

一个扩展**从不携带 secret 值**。它声明一个*引用*：

```json
"secrets": [ { "name": "obsidian-rest-api-key", "attach": "bearer" } ]
```

| `ExtensionSecretRef` 字段 | 含义 |
|---|---|
| `name` | 逻辑 secret 名。值住在 `~/.plexus/secrets/` 之下（可用时用 OS keychain），在派发时由 `PlatformServices.resolveSecret(name)` 解析。 |
| `attach` | 拥有它的 transport 如何呈现它：`bearer` / `header` / `query` / `env`。 |
| `as` | 当 `attach` 为 `header`/`query`/`env` 时的头/查询/环境键名。 |

**契约（硬性保证）：** secret 值**绝不**出现在 manifest、`.well-known` 文档、handshake manifest 快照或任何审计 `detail` 里（审计脱敏是一个契约——`AuditRedactionPolicy`）。它**只**在派发时被交给拥有它的 transport，经 `route.secret`/`LocalServiceLocation.secretRef` 按 `name` 引用。一个需要凭据的作者声明那个引用 + attach 模式；用户带外把值预置进 `~/.plexus/secrets/`。预置该值是一个**管理客户端 / 操作者动作**，**不是** manifest 的一部分。

## 8. 校验规则 —— 什么让一份 manifest 有效/无效

网关强制这些（有些在注册时，有些在 invoke 时）。一个编写工具（M4 元技能）**应当**预先校验它们全部。

**注册时拒绝（`registerExtension` / `POST /extensions`）：**
1. `manifest !== "plexus-extension/0.1"` → 拒绝（那道实时守卫：`"invalid extension manifest …"`）。
2. 缺失/空的 `source` → 拒绝。
3. （编写工具也必须抓住，网关将其视为"未贡献条目"：）空的 `capabilities[]` → 响应是 `ok:false`，原因为 *"extension materialized but contributed no entries."*

**结构有效性（编写工具 / 规范级——一份良构 manifest 必须满足）：**
4. 每个 `capabilities[].name` 在该 manifest 内是一个唯一、非空的 `<noun>.<verb>` slug（id 必须唯一；重复的 name 会在同一个 id 上冲突）。
5. `transport`（manifest + 按声明）∈ `{local-rest, stdio, ipc, cli, skill, workflow}` —— **绝不 `mcp`**（类型将其 `Exclude`）。
6. `kind:"skill"` ⇒ 有 `body`、`grants:[]`、`transport:"skill"`，无 `io`/`members`。
7. `kind:"workflow"` ⇒ 有 `members[]`；每个 `members[].id` 在注册时解析到一个**在场**的注册表条目；每个 `members[].verbs` ⊆ 那个成员条目所需的 `grants`（ADR-012）。一个带悬空成员 id 的 workflow 没有传递性授权目标——无效。
8. `kind:"capability"` ⇒ `grants` 是最小动词集；`io.input`（若在场）是有效的 JSON Schema Draft 2020-12。
9. 任何 `route.secret` / 带 `attach` 的 `ExtensionSecretRef` 都点名一个列在 manifest `secrets[]` 里的 secret。
10. `route.attachSkills[]` 条目点名同一 manifest 里在场的 `kind:"skill"` 声明。

**跨源冲突（网关，在 refresh 时）：** 若一个被贡献的 id 与一个已被另一个源认领的 id 冲突，则**第一个认领它的源胜出**，重复者被跳过（ID 派生规则让一次跨源冲突成为一个源命名 bug——选一个不同的 `source`）。

**在 invoke 时强制（非注册时）：** `io.input` schema 校验（`schema_validation_failed`）、授权/动词作用域检查（`grant_required`）、会话存活 + jti 吊销。一个作者无法绕过这些。

## 9. 注册流程

### 9.1 由 transport 背书 —— `POST /extensions`

规范性：[`ExtensionRegisterRequest`/`Response`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1b、
[`handlers.extensions`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/core/handlers.ts)。

```
POST /extensions
{ "sessionId": "sess_…", "manifest": { … ExtensionManifest … } }
```

- 需要一个**活跃的 handshake 会话**（`sessionId` 必须存活——注册是一个用户授权的动作）。Host/Origin 守卫先跑（ADR-016）。
- 网关发出一个 `source.install` 审计事件，调用 `capabilities.registerExtension(manifest)`，随后发布一个 `manifest_changed` 事件，好让连接的 agent 重新取回（`GET /manifest`）。
- 响应：

```json
{ "ok": true, "source": "obsidian", "registered": ["obsidian.vault.read"],
  "revision": 7 }
```

`registered` 列出真正进入了注册表的 id。被拒绝/空的 manifest 上是 `ok:false` + `reason`。**无进程内 handler 能经此线路提供**——HTTP 路径只用 manifest 调用 `registerExtension(manifest)`。

### 9.2 进程内 —— `registerExtension(manifest, { handlers })`

网关拥有的代码（first-party 源、网关捆绑包）直接调用注册表，并可按声明 `name` 绑定进程内 `ExtensionHandler`。该 handler 被烘焙到 `entry.extras.route.handler`（一个核心从不读的字段）上，而 `ExtensionBridge` 直接运行它，而非经一个线路派发。这就是 Obsidian vault 读和 cc-master board 操作模式。**保留给网关测试的、定制执行的 capability**——它不是一个外部编写通道。

### 9.3 注册做什么（两条通道）

`registerExtension`（capability-registry）：把 manifest 物化成一个 `SourceModule`，把它**叠加**在共享的 `SourceRegistry` 上（好让 invoke 管线能解析它的 bridge），启动生命周期源，重新扫描（其条目进入注册表），推进单调的 `revision`，并把变更发给 `/events` 订阅者。**加性且可逆**——无编译期 `MODULES` 编辑，无核心分支。

## 10. 生命周期

| 阶段 | 机制 |
|---|---|
| **register** | `POST /extensions` 或 `registerExtension()` —— 物化 + 扫描 + revision 推进 + `manifest_changed`。一个**管理员安装**的扩展（`POST /admin/api/extensions`）作为安装的副作用**也**被持久化到持久存储 `~/.plexus/extensions.json`。 |
| **refresh** | `CapabilityRegistry.refresh()` 重新扫描所有源（含扩展）；对条目集做差异；仅在变化时推进 revision。一个源的 `onEntriesChanged` 触发一次 refresh。 |
| **list_changed** | 一次 revision 推进在 `GET /events`（SSE）上触发一个 `ManifestChangedEvent`。agent 比较 `Manifest.revision` 并重新拉取 `GET /manifest`。 |
| **re-register** | 再次注册同一个 `source` 会替换该模块（陈旧的生命周期源被丢弃，新模块被重新扫描）。对幂等友好。 |
| **availability** | `ExtensionSource.checkRequirements()` 报告可达性（一个 `local-rest` 扩展可报告它的服务离线 → `source_status` 事件 / 可用性徽章）。 |
| **persistence** | 管理员安装的扩展是**持久的**：manifest 在安装时被持久化到 `~/.plexus/extensions.json` 并**在启动时重放**，因此一次网关重启**不会**丢掉它们——它们自动重新注册（commit 654dcfa）。（一个由 agent 发起的、纯会话作用域的 `POST /extensions` 注册是那个瞬态情形；管理员安装路径才是那个持久的。） |
| **unregister** | `DELETE /extensions/:source`（已发布）—— `server.ts` 接上 `app.delete("/extensions/:source", …)`。它移除运行时注册的源，**清除该源的授权**，并把它从持久存储里丢掉（这样它不会在下次启动时回来）。这是教程用来拆掉一个扩展的路径。 |

## 11. 安全边界 —— 一个扩展能做什么、不能做什么

一个注册的扩展被**与其他每个源相同的网关管线所收容**。它得不到任何享有特权的路径。

**一个（由 transport 背书的）扩展可以：**
- 贡献可被发现的条目（capability/skill/workflow）。
- 经 `local-rest`/`cli`/`stdio`/`ipc` 对着本地服务/二进制被触达。
- 声明它所需的动词和它需要的 secret 引用。
- 把已有条目组合成一个 workflow（传递性授权被强制）。

**一个扩展不能（这就是一个恶意 manifest 如何被收容）：**
- **在网关里运行任意进程内代码。** HTTP 路径只物化一个 manifest；你无法上传一个 `handler` 函数。进程内 handler 是一个网关拥有、编译期绑定的能力。
- **绕过授权。** 每一个条目都默认拒绝；一次没有覆盖性受限令牌的 invoke 被拒绝 `grant_required`。声明 `grants:["read"]` 不让该条目写入——动词集是用户所见并授予的东西。
- **经一个 workflow 升级。** 一个 workflow 的成员在一个从 `members[]` 派生的*合成传递性作用域*下运行，在授权确认时向用户浮现，并按成员通过同一管线做作用域检查（ADR-012/013）。无静默升级；一次扇出中途的吊销会中止其余成员。
- **从 manifest 界面读取 secret 值。** secret 是只被解析进拥有它的 transport（在派发时）的引用；值从不进入 manifest、`.well-known`、manifest 快照或审计。
- **伪造身份或被跨主机触达。** Host/Origin 校验（ADR-016）在每个端点上于 auth 之前运行；仅环回绑定。
- **逃逸实例收容**——在 transport/handler 执行它之处（Obsidian 的路径受限用 `transport_error` 拒绝 `..`/绝对/符号链接逃逸）。实例级收容是 transport 的活儿——刻意地编写它。
- **规避审计。** 每一次 invoke（以及每一次派发前拒绝）都以脱敏安全的 detail 被审计。

**用户通过注册一个 transport 背书扩展所授予的残余信任：** 该扩展可以让网关在用户所授的动词下，去发起它所点名的本地 HTTP 调用 / 生成它所点名的二进制。用户的防御是授权提示（动词可见）、审计日志、以及吊销的能力。一个点名了用户不信任的 `cli` 二进制的扩展不应被授予 `execute`。

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

> 成员必须已经是在场的注册表条目（此处是同一 manifest 也声明的两个 capability，或来自另一个源的既存 id）。

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

授予 `notes.daily.log`（write）会合成传递性成员作用域 `notes.vault.read`/read + `notes.vault.append`/write，在授权确认时向用户浮现并戳入令牌（`synthesizedFor`）；`WorkflowTransport` 通过统一的 invoke 管线扇出（§9、ADR-013）。

## 13. 合规清单（供一个编写工具用）

一份 manifest **合规**，当且仅当：`manifest === "plexus-extension/0.1"`；`source` + `label` 在场；`transport` ≠ `mcp`；≥1 个 capability；每个声明都有 `name`/`kind`/`label`/`describe`/`grants`；skill 声明携带 `body` + `grants:[]`；workflow 声明携带 `members[]`，其 id 解析到在场且其 `verbs` ⊆ 成员的 grants；每个 `route.secret` 点名一个已声明的 secret；每个 `route.attachSkills[]` 点名一个已声明的 skill；`io.input`（若在场）是有效的 JSON Schema 2020-12。网关强制的完整规则集见 §8。
