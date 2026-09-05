---
title: "扩展规范"
description: "Plexus 标准扩展规范（v0.1）：编写扩展的公开契约，涵盖 manifest schema、transport、grants、secret、校验规则与安全边界。"
---
# Plexus 标准扩展规范 —— v0.1 {#plexus-标准扩展规范-——-v0-1}

::: tip 状态
M4 公开规范（v0.1） · 协议：`plexus-extension/0.1` · 网关契约：`PLEXUS_PROTOCOL_VERSION 0.1.3` · 日期：2026-06-23

要把本地 app、CLI、脚本或 HTTP 服务接入 Plexus，让任意 AI agent 能发现、理解、获准后调用它，即 DISCOVER → UNDERSTAND → be GRANTED → CALL，扩展作者遵循的就是这份公开契约。

本规范把已发布的 `ExtensionManifest`、`materializeExtension`、`CapabilityRegistry.registerExtension`、`ExtensionSource`/`ExtensionBridge` 实现整理为稳定的编写接口，不另造 wire 协议。字段若由冻结类型定义，就以该类型为权威。
:::

- 冻结类型：[`packages/protocol/src/types.ts`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1、§1b、§6。
- 运行时：[`packages/runtime/src/sources/extension.ts`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/sources/extension.ts)、[`packages/runtime/src/core/capability-registry.ts`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/core/capability-registry.ts)。
- 完整示例源码：[`packages/runtime/src/sources/obsidian/`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/sources/obsidian/)、[`packages/runtime/src/sources/claudecode/`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/sources/claudecode/)。
- ADR：[决策记录](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/DECISIONS.md) ADR-003/004/005/009/012/013。

## 1. 扩展是什么 {#_1-什么是扩展}

用户安装一个 bundle，它声明自己提供哪些条目、这些条目属于哪个 capability source。这就是扩展，声明集中写在一份 [`ExtensionManifest`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) 中。

注册时，网关把 manifest 物化为运行时 `CapabilitySource`，其形状与编译期 first-party source 相同。条目进入 agent 的 handshake manifest 或 `GET /manifest` 返回结果时，会按该 agent 的授权与暴露子集过滤；授权通过 `PUT /grants` 管理，调用走 `POST /invoke`。**能发现条目或完成 handshake，不等于已有调用权限；调用仍需相应的 scoped 授权。**

核心是同构条目模型（ADR-004）：每个 capability、skill、workflow 都是 `CapabilityEntry`，由 `kind` 区分。扩展用 `ExtensionCapabilityDecl` 声明条目，网关再将每条声明投影成完整的 `CapabilityEntry`，其中 `id`、`source` 和 skill 反向链接由网关派生。

从这个模型看，用户扩展、first-party 适配器与导入的 MCP 工具都可表示为 `CapabilityEntry`，agent 不需要三套条目结构。不过，这不是说 MCP 导入入口已经交付：当前已有 MCP transport/client，面向用户的 MCP server 到 source 接入路径尚未发布。

```
ExtensionManifest  ──register──►  materializeExtension()  ──►  SourceModule
                                                                 │
                              ┌──────────────────────────────────┼─────────────────────┐
                              ▼ scan()                            ▼ createBridge()
                        ExtensionSource                     ExtensionBridge
                  (lifecycle: scan→CapabilityEntry[])   (per-session: invoke→transport|handler)
```

注册有两条通道，物化方式相同，详见 §9。

1. 通过 transport 注册。外部作者一律使用 HTTP `POST /extensions`。manifest 中的条目通过 wire transport（`local-rest` / `cli` / `stdio` / `ipc`）或哨兵值（`skill` / `workflow`）接入。外部作者不能向网关注入进程内 handler；这不妨碍 transport 启动外部进程。
2. 通过进程内 handler 注册。网关自有代码调用 `capabilities.registerExtension(manifest, { handlers })`，Obsidian vault 读取采用的就是这一方式。它只留给 first-party 或随网关捆绑的 source，用来提供定制、经网关测试的执行逻辑。函数不能经 wire 上传，第三方扩展也就不能借此注入进程内代码。

`claudecode` 则不属于这两条通道。它是编译期的 first-party `SourceModule`，自带 bridge，是另一种集成形态。


## 2. 扩展 manifest schema {#_2-扩展-manifest-schema}

manifest 级字段配置整个 source；各条目另在 `capabilities` 中声明。规范性类型见 [`ExtensionManifest`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1b。wire 上的 JSON 是一个扁平、可 JSON 序列化的对象。

| 字段 | 必需 | 类型 | 含义 |
|---|---|---|---|
| `manifest` | **是** | `"plexus-extension/0.1"` 字面量 | manifest schema 版本。网关拒绝任何其他值。 |
| `source` | **是** | `SourceId` | 扩展注册的 source id，使用小写 kebab/点形式，如 `my-vault`、`linear`、`mcp:github`。将 `:` 替换为 `.` 后得到 id-slug，如 `mcp.github`，网关据此派生每个条目的 id（ID 派生规则）。wire 注册不接受保留的 first-party id，见 §8。 |
| `label` | **是** | `string` | 供人阅读的 source 标签，如 `"Obsidian (Local REST API)"`。 |
| `transport` | **是** | `Exclude<TransportKind,"mcp">` | capability 未覆盖时使用的默认 transport。可取 `local-rest \| stdio \| ipc \| cli \| skill \| workflow`。 |
| `capabilities` | **是** | `ExtensionCapabilityDecl[]` | 扩展提供的 capability、skill、workflow 条目声明。有效注册要求此数组非空。 |
| `secrets` | 否 | `ExtensionSecretRef[]` | transport 所需的 secret 引用，由平台接缝按名称解析，见 §7。 |
| `serviceHint` | 否 | `LocalServiceHint` | 定位 `local-rest`/`ipc` 服务的提示，结构为 `{ app, defaultPort?, socketName? }`。 |

### 2.1 `ExtensionCapabilityDecl` —— 单个条目的声明 {#_2-1-extensioncapabilitydecl-——-一条被贡献的条目}

每条声明说明条目做什么、需要哪些动词，以及怎样调用。规范性类型见 [`ExtensionCapabilityDecl`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1b。

| 字段 | 必需 | 类型 | 含义 |
|---|---|---|---|
| `name` | **是** | `string` | `<noun>.<verb>` 形式的后缀。网关派生的完整 id 为 `<sourceSlug>.<name>`，如 source `obsidian` + name `vault.read` ⇒ id `obsidian.vault.read`。 |
| `kind` | **是** | `"capability" \| "skill" \| "workflow"` | 条目种类，见 ADR-004。 |
| `label` | **是** | `string` | 供人和 agent 阅读的简短标签。 |
| `describe` | **是** | `string` | 核心字段，向决定是否调用的 AI 说明“做什么、何时用、怎样用”。遵循 claude-plugin 约定：`"Action outcome. Use when X."`，见 §3。 |
| `grants` | **是** | `GrantVerb[]` | 条目所需的动词：`read`/`write`/`execute`。`[]` 表示无需授权（skill）。遵循默认拒绝、默认只读原则，见 ADR-005；声明所需动词不等于取得授权。 |
| `transport` | **是** | `Exclude<TransportKind,"mcp">` | 此条目使用的 transport。冻结类型将它列为必需，编写时须显式填写以满足类型；运行时若省略，则回退到 manifest 级的 `transport` 默认值。 |
| `io` | 否 | `IoSchema` | `{ input?, output? }`，声明格式为 JSON Schema Draft 2020-12。invoke 时强制执行输入校验，但当前实现是轻量校验，不代表完整支持该标准。skill 省略此字段。 |
| `members` | `kind:"workflow"` 时必需 | `WorkflowMember[]` | 按顺序列出成员 id，以及 workflow 可对每个成员行使的动词。每个 id 都必须能解析到注册表中在场的条目，见 §8。 |
| `body` | `kind:"skill"` 时必需 | `SkillBody` | 使用说明，可以是内联 Markdown（`{ format:"markdown", markdown }`），也可以是内容引用。 |
| `route` | 否 | `Record<string, unknown>` | transport 路由配置，只由所属 transport 读取，核心从不读取。见 §5 + §6。 |


### 2.2 各 transport 读取哪些 `route` 键 {#_2-2-route-可识别的键-按-transport}

`route` 是一个开放的键值袋。网关核心从不读它；只有所属 transport，或负责 skill 反向链接的接线会读。因此，写入哪些键，要看条目交给谁执行；`attachSkills` 则是接线用途，不是执行参数。

| 键 | 由谁读 | 含义 |
|---|---|---|
| `attachSkills: string[]` | `manifestEntries()` | 填入要反向链接到此 capability 的 `kind:"skill"` 条目的声明 `name`，物化后成为 `entry.skills[]`。见 §6。 |
| `method`、`pathTemplate`、`secret` | `local-rest` transport | 分别指定 HTTP 方法、可插值输入字段的 URL 路径模板，以及要附上的 secret。`secret` 必须是对象 `{ name, attach?, as? }`：transport 读取 `route.secret?.name` 来解析同名 `ExtensionSecretRef`；`route.secret?.attach` 指定附加方式，可用 `bearer`、`header`、`query`，默认 `bearer`；采用 `header` 或 `query` 时，`route.secret?.as` 指定头名或查询键名。运行时 `LocalRestTransport` 读取规范键 `pathTemplate`，也仍接受遗留别名 `path`。 |
| `bin`、`args`、`secret` | `cli` transport | 分别指定经平台接缝解析的二进制名、argv 模板和 secret 环境变量。 |
| `op` | `ipc`/进程内 bridge | 选择进程内操作，例如 claudecode 的 `run`。 |
| `handler` | 仅进程内 bridge | 通过 `registerExtension(..., { handlers })` 绑定。它是函数，不可序列化，绝不出现在 wire manifest 中。见 §9。 |

## 3. 用 `describe` 说明何时选用、怎样调用 {#_3-写好-describe-agent-的相关性信号}

路由告诉 transport 怎样执行，`describe` 则帮助 agent 判断这项能力是否适合眼前的任务。在 Plexus 中，它不只介绍“我是什么”，还要说明“用我能得到什么、什么时候该选我、该怎么调用”。可以遵循 claude-plugin `SKILL.md` 的 `description` 约定：先写结果和适用情境，即 `Action outcome. Use when X.`，再交代调用形状与关键约束。

已发布的 Obsidian 扩展给出了这样的描述：

> 以只读方式读取 Obsidian 笔记库 “Research” 中的笔记。当你需要用户笔记的正文来回答问题、总结或引用时，使用此能力。传入 `{ path }` 可读取一篇笔记，路径相对于笔记库根目录；省略 `path` 则列出笔记。路径限于该笔记库内，绝不写入。

这段话先说明 agent 能拿到笔记内容，没有先讲实现。接着给出选择情境：需要用用户笔记回答、总结或引用时才选它。调用形状也很短，但包含了传入和省略 `path` 的不同结果。这里的自然语言是使用指引，`io.input` 才是形式输入契约。

最后的边界不能省。只读、路径受限，或其他能力是否有副作用、是否需要 `execute`，都应明确写出；agent 要靠这些信息权衡授权代价，而不只是看功能是否合用。

管理面与能力清单视图的一行摘要预览，取的就是 `describe` 的第一行，见 capability-registry 的 `toSummary`；完整文本随 handshake manifest 交付。因此，第一行要写成完整的句子，让只看到摘要的读者也知道能得到什么。把用途、调用方式和边界写清楚，再为执行选择合适的 transport。


## 4. 按应用接口选择 transport {#_4-transport-选择}

先看 app 已经提供什么接口，再选 transport，不必为接入另造一层协议。规范性依据是 [`TransportKind`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1 与 ADR-003。扩展 manifest 可用除 `mcp` 外的 transport：MCP 留给网关的特权导入路径，条目应由导入产生，而不是手写。当前已有 MCP transport/client，但面向用户的 MCP server 到 source 导入入口尚未发布。

下表保留各类调用的配置形状；具体 `route` 键的读取方式见 §2.2。

| Transport | 适用接口或条目 | `route` 配置 |
|---|---|---|
| `local-rest` | app 暴露 localhost HTTP(S) API，如 Obsidian Local REST、本地 web 服务。Plexus 作为 HTTP 客户端调用。 | `{ method, pathTemplate, secret? }`，配合 `serviceHint`/`secrets`。 |
| `cli` | 通过 argv 调用二进制并捕获 stdout，可选 `--format json`。二进制由平台 path-resolver 定位。 | `{ bin, args, secret? }`。 |
| `stdio` | 长驻子进程通过 stdin/stdout 交换行协议或 JSON（NDJSON）消息。 | 通过 `serviceHint`/`route` 给出 spawn 规格。 |
| `ipc` | OS IPC：unix socket、命名管道或 AppleScript 桥；也用于标记网关自有的进程内 handler，Obsidian 与 claudecode 的进程内 bridge 就标为 `ipc`。 | `{ op }` 或 socket 提示。 |
| `skill` | `kind:"skill"` 条目，不走 wire，直接把 `body` 作为上下文交付。 | 无，携带 `body`。 |
| `workflow` | `kind:"workflow"` 条目，不走 wire；`WorkflowTransport` 对每个成员重入 invoke 管线，见 ADR-013。 | 无，携带 `members`。 |

前四项是执行用的 transport，后两项是 skill/workflow 哨兵值，不能当作连接应用的协议。`ipc` 虽有两种含义，第三方能选择的仍是 OS IPC；网关自有的进程内代码不是第三方编写选项，见 §1、§9。

实际选择时，app 已在 localhost 上提供 HTTP，就用 `local-rest`；调用二进制，用 `cli`；连接长驻协议进程，用 `stdio`；走 OS socket 或 AppleScript，用 `ipc`；只提供使用知识，用 `skill`；组合已有条目，用 `workflow`。


## 5. 按 capability 授权与声明动词 {#_5-按-capability-的-grants-与访问粒度}

选定 transport 后，要声明这项 capability 需要哪些操作权限。规范性依据是 [`GrantVerb`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1 与 ADR-005。

`read` 只查询、读取数据，不做变更。`write` 会变更用户机器上的状态或 app 数据。`execute` 则用于运行进程，或执行既非纯读、也非简单写入的副作用动作，例如发起一次编排、跑一次构建。

编写时应声明最小动词集。只读 capability 必须写 `grants:["read"]`，也必须做到不静默写入。声明过宽，会让扩展显得更危险，侵蚀用户信任；token 未覆盖声明所需的动词，调用会在作用域检查时失败。但检查针对的是声明，不是对实际行为的自动验证。少报动词不能使副作用合法，`read` 标签也不会自动把外部代码关进只读沙箱。

默认拒绝：条目所需的 `grants` 动词未获授予，就不可调用。默认只读：简写 `"allow"` 只授予 `["read"]`；更宽的动词必须显式请求，并明确展示给用户。

调用时，该 `id` 的 token 作用域必须覆盖条目声明的每个动词。这是授权条件，不是放行的全部条件：capability 仍须处于暴露状态，session 也必须存活。Plexus 按 capability、按动词落实拥有者的授权策略，而不是把连接成功当作整套能力的使用许可。已有符合条件的 standing grant 时，可以据此取得 scoped token，不必每次重新询问拥有者。

这个粒度还不是资源实例级隔离。“只允许 vault A、只允许路径 B”不是动词，必须在 `io.input` 校验和 transport/handler 中落实；Obsidian 的路径限制就是范本。这也与 ADR-005 将实例级约束推迟的决定一致，不能指望动词授权本身守住路径边界。

## 6. 给 capability 附着使用 skill {#_6-附着的使用技能}

权限说明能不能用，附着的使用 skill 则说明怎样用好。它既能从 capability 侧被发现，也作为独立的 `kind:"skill"` 条目存在。声明分两步：

1. 在 `capabilities[]` 中声明一个 `kind:"skill"` 条目，提供 `body`，形状为 `{ format:"markdown", markdown }`，并设置 `grants:[]`、`transport:"skill"`。
2. 在它所讲解的 capability 上设置 `route.attachSkills: ["<skill decl name>"]`，引用 skill 的声明名称。

网关的 `manifestEntries()` 会生成反向链接，让 capability 获得 `skills: [{ id, label }]`，指向物化后的 skill 条目。作者不必手工填写派生的链接。

skill 作为上下文读取，可发现、不可调用。对 `kind:"skill"` 条目发起 invoke，bridge 会以 `transport_error` 拒绝。阅读这些指引不会授予它所讲解的 capability 任何权限；后者仍按自己的授权条件调用。Obsidian 的 `vault.read` ↔ `vault.how-to-cite` 就是这样一对：读取能力附着引用指引，指引本身仍是独立条目。


## 7. secret 与凭据引用（`secretRef`） {#_7-secret-凭据处理-secretref}

目标 transport 需要凭据时，扩展只声明引用，从不携带 secret 值。这里的凭据用于访问目标服务，不是拥有者管理连接所用的 connection-key，也不是 agent 的 PAT。

规范性依据是 [`ExtensionSecretRef`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1b、`PlatformServices.resolveSecret` §6 与 ADR-009(c)。作者在 manifest 中声明凭据的逻辑名称和附加方式，例如：

```json
"secrets": [ { "name": "obsidian-rest-api-key", "attach": "bearer" } ]
```

| `ExtensionSecretRef` 字段 | 含义 |
|---|---|
| `name` | secret 的逻辑名称。值存放在 `~/.plexus/secrets/`，OS keychain 可用时使用它；派发时由 `PlatformServices.resolveSecret(name)` 解析。 |
| `attach` | 拥有该凭据的 transport 如何附加它：`bearer` / `header` / `query` / `env`。 |
| `as` | `attach` 为 `header` / `query` / `env` 时，指定头名、查询参数名或环境变量名。 |

声明名称不会预置凭据。用户须在带外把实际值预置进 `~/.plexus/secrets/`；这是管理客户端 / 操作者的动作，不属于 manifest。扩展作者负责声明引用和 `attach` 方式，不负责把值写进扩展。

前面的路由表给出了配置形状。这里要分清引用与值：`route.secret` / `LocalServiceLocation.secretRef` 按 `name` 引用凭据，只有到了派发时，才通过 `PlatformServices.resolveSecret(name)` 解析实际值，并且只交给拥有它的 transport。路由中的引用不是存放 secret 值的位置。

这是硬性契约：secret 值绝不出现在 manifest、`.well-known` 文档、handshake manifest 快照或任何审计 `detail` 中。审计脱敏本身也是契约，由 `AuditRedactionPolicy` 规定。


## 8. 校验规则：声明有效不等于调用获准 {#_8-校验规则-——-manifest-何时有效、何时无效}

网关不会在注册时一次查完所有问题。有些声明会被注册入口直接拒绝，有些要求属于结构契约，还有些检查只能在 invoke 时执行。编写工具（M4 元技能）应当预先校验以下全部规则；不能把“注册入口没有报错”当作 manifest 已完全符合规范。

### 注册入口的拒绝与无贡献结果

`registerExtension` / `POST /extensions` 在注册阶段处理以下情况。其中第 3 条是物化后未贡献条目的结果，不要与入口守卫拒绝混为一谈。

1. `manifest !== "plexus-extension/0.1"` 时拒绝。运行时守卫的报错为 `"invalid extension manifest …"`。
2. `source` 缺失或为空时拒绝。
3. `capabilities[]` 为空时，网关视为“未贡献条目”，响应 `ok:false`，原因为 `"extension materialized but contributed no entries."`。编写工具也必须提前发现这个问题。
4. `source` 认领保留的 first-party id 时，wire 注册被拒绝。保留集合 `RESERVED_SOURCE_IDS` 包括编译期模块 id，以及 `obsidian` 与 `mock`。扩展须使用自己的 `source` id，不能冒充 first-party。
5. skill/workflow 向另一个 source 的条目声明跨源附着时，默认拒绝。这会形成提示注入通道；只有显式开启并经用户确认，才可例外允许。

### 结构契约与编写工具预检

良构的 manifest 还必须满足第 6—12 条。这些是规范层和编写工具的校验责任，不能据此声称当前注册入口已对每项要求实现完整的运行时校验。

6. 每个 `capabilities[].name` 必须非空，在同一 manifest 内唯一，并采用 `<noun>.<verb>` 形式的 slug。派生的 id 必须唯一；重复的 name 会产生同一个 id。
7. manifest 级和声明级 `transport` 只能取 `local-rest`、`stdio`、`ipc`、`cli`、`skill`、`workflow`。绝不允许 `mcp`，类型已用 `Exclude` 将它排除。
8. `kind:"skill"` 必须有 `body`，设置 `grants:[]` 和 `transport:"skill"`，且不得有 `io` 或 `members`。
9. `kind:"workflow"` 必须有 `members[]`。每个 `members[].id` 在注册时都须解析到注册表中在场的条目，每个 `members[].verbs` 都须是该成员条目所需 `grants` 的子集（ADR-012）。成员 id 悬空，就没有传递性授权目标，这样的 workflow 无效。
10. `kind:"capability"` 的 `grants` 必须是最小动词集；若有 `io.input`，它必须是有效的 JSON Schema Draft 2020-12。这是声明格式要求；当前运行时只做轻量输入校验，不等于完整支持该标准。
11. 任何 `route.secret`，以及带 `attach` 的 `ExtensionSecretRef`，都必须点名 manifest `secrets[]` 中列出的 secret。
12. `route.attachSkills[]` 必须点名同一 manifest 内在场的 `kind:"skill"` 声明。

### refresh 时的跨源冲突

网关在 refresh 时处理跨源 id 冲突：若贡献的 id 已被另一个 source 认领，先认领者胜出，重复者被跳过。按 ID 派生规则，这类跨源冲突是 source 命名 bug，应换一个 `source`，而不是期待后来注册的条目覆盖先前条目。

### invoke 时的强制检查

实际调用仍要经过 `io.input` schema 校验，失败返回 `schema_validation_failed`；还要经过授权与动词作用域检查，失败返回 `grant_required`。网关同时检查会话是否存活，以及 jti 是否已撤销。这些检查在 invoke 时强制执行，不是注册时做过便可省去，扩展作者也绕不过。

因此，声明有效只说明它符合扩展契约，不说明某次调用已获许可。带着这一区分，再进入实际注册过程。


## 9. 注册流程 {#_9-注册流程}

### 9.1 由 transport 背书 —— `POST /extensions` {#_9-1-由-transport-背书-——-post-extensions}

外部作者通过 HTTP 提交 manifest。规范性依据见 [`ExtensionRegisterRequest`/`Response`](https://github.com/nemori-ai/plexus/blob/main/packages/protocol/src/types.ts) §1b、[`handlers.extensions`](https://github.com/nemori-ai/plexus/blob/main/packages/runtime/src/core/handlers.ts)。

```
POST /extensions
{ "sessionId": "sess_…", "manifest": { … ExtensionManifest … } }
```

请求先经过 Host/Origin 守卫（ADR-016），再检查 `sessionId` 是否属于仍存活的 handshake 会话。agent 使用自己的 PAT 认证，不使用 owner 的管理凭据 connection-key。活跃会话只建立请求上下文，不代表 owner 已批准安装，也不授予调用权限。

网关先调用 `validateRegistration`，只校验，不提交。这里按 §8 的注册入口规则处理，不能把结构契约都视为已实现的运行时检查。wire 注册不受信任，保留 id 门与跨源附着门都生效；校验失败时，以 `outcome:"rejected"` 记录 `source.install` 审计，返回 `ok:false` 和 `reason`。

校验通过后，是否需要人工确认，要看 manifest 是否由外部 transport 背书。使用 `cli` / `local-rest` / `stdio` / `ipc` 的 manifest 进入 PENDING：agent 可以请求注册，但不能自行激活。网关以 `outcome:"pending"` 记审计，返回 pending 记录，向 owner 展示待批准的 cli 二进制、rest 主机、跨源附着和动词。只有 owner 批准后，才运行 `registerExtension` 并发出 `manifest_changed` 事件。

纯 skill/workflow manifest 没有外部 transport，不经过这一等待阶段，而是直接提交：以 `outcome:"committed"` 记审计，随后运行 `registerExtension` 并发出 `manifest_changed`，提示已连接的 agent 通过 `GET /manifest` 重新拉取清单。

由 transport 背书时，pending 响应为：

```json
{ "status": "grant_pending_user", "pendingId": "pend_…",
  "pending": ["my-obsidian"], "statusUrl": "…", "approvalUrl": "…" }
```

提交后的响应如下。由 transport 背书的 manifest 要等 owner 批准，纯 skill/workflow manifest 则立即返回：

```json
{ "ok": true, "source": "my-obsidian", "registered": ["my-obsidian.vault.read"],
  "revision": 7 }
```

`registered` 列出真正进入注册表的 id，不是原样回显声明。manifest 被拒或为空时，返回 `ok:false` 和 `reason`。

这条 wire 路径不能提供进程内 handler。HTTP 入口只传 manifest，调用的是 `registerExtension(manifest)`。

### 9.2 进程内 —— `registerExtension(manifest, { handlers })` {#_9-2-进程内-——-registerextension-manifest-handlers}

网关自有代码，包括 first-party source 和随网关捆绑的包，可以直接调用注册表，按声明的 `name` 绑定进程内 `ExtensionHandler`。handler 写入 `entry.extras.route.handler`；核心从不读取这个字段，由 `ExtensionBridge` 直接运行函数，不经 wire 派发。Obsidian vault 读取采用的就是这一方式。

这条通道保留给经网关测试、需要定制执行的 capability，不是外部编写通道。

Claude Code 的 `claudecode` 又不同：它是编译期的 first-party `SourceModule`，自带 bridge，见 `sources/claudecode/`，不通过 `registerExtension` 注册。

### 9.3 两条通道提交后做什么 {#_9-3-注册做什么-两条通道}

两条通道最终都由 capability-registry 的 `registerExtension` 把 manifest 物化为 `SourceModule`，叠加到共享的 `SourceRegistry` 上。invoke 管线从这里解析它的 bridge，不需要另加核心分支。

随后启动生命周期 source，重新扫描，让条目进入注册表；`revision` 单调推进，变更推送给 `/events` 订阅者。这是加性且可逆的叠加，不改编译期 `MODULES`。


## 10. 生命周期 {#_10-生命周期}

注册让 source 进入运行时，安装路径决定 manifest 是否落盘。两者要分开看：移除运行时 source，不一定删除安装记录；管理员安装可跨重启恢复，也不表示 session 会持久保存。

| 阶段 | 机制 |
|---|---|
| `register` | 通过 `POST /extensions` 或进程内 `registerExtension()` 注册。前者先校验：由 transport 背书的 manifest 进入 PENDING，等 owner 批准后才提交并发出 `manifest_changed`；纯 skill/workflow manifest 直接提交，见 §9.1。提交涉及物化、扫描、revision 推进及 `manifest_changed`。管理员通过 `POST /admin/api/extensions` 安装时，还会把 manifest 写入 `~/.plexus/extensions.json`。 |
| `refresh` | `CapabilityRegistry.refresh()` 重新扫描所有 source，包括扩展，并比较条目集；只有条目发生变化，才推进 revision。source 的 `onEntriesChanged` 会触发一次 refresh。 |
| `list_changed` | revision 推进后，`GET /events`（SSE）会推送 `ManifestChangedEvent`。agent 比较 `Manifest.revision`，再通过 `GET /manifest` 重新拉取清单。 |
| `re-register` | 再次注册同一个 `source`，会替换已有模块：丢弃陈旧的生命周期 source，重新扫描新模块。这种行为对幂等操作友好；它是同一 source 的替换，不是前节所说的对编译期模块的加性叠加。 |
| `availability` | `ExtensionSource.checkRequirements()` 报告可达性。例如，`local-rest` 扩展可以报告其服务离线，通过 `source_status` 事件和可用性徽章呈现。 |
| `persistence` | 管理员安装的扩展会持久保留。manifest 在安装时写入 `~/.plexus/extensions.json`，启动时重放并自动重新注册，所以网关重启不会丢掉这些扩展（commit 654dcfa）。agent 发起的、纯会话作用域的 `POST /extensions` 注册才是瞬态的；持久化来自管理员安装路径，不是会话本身。 |
| `unregister` | `DELETE /extensions/:source` 已发布，`server.ts` 中接有 `app.delete("/extensions/:source", …)`。它移除运行时注册的 source，并清除该 source 的授权，但不改持久存储；若扩展由管理员安装，下次启动仍会重放。要一并清除安装记录，使用 `DELETE /admin/api/extensions/:source`：它同样移除运行时 source、清除该 source 的授权，还会从 `~/.plexus/extensions.json` 删除该 source 持久化的 manifest。教程使用这条管理路径拆掉扩展。 |


## 11. 安全边界：扩展能做什么，不能做什么 {#_11-安全边界-——-扩展能做什么、不能做什么}

注册后的扩展与所有 source 一样，受同一条网关管线约束，没有特权路径。注册让条目进入系统，不会让扩展跳过调用时的检查。

由 transport 背书的扩展可以贡献可发现的 capability、skill、workflow，经 `local-rest`、`cli`、`stdio`、`ipc` 触达本地服务或二进制，声明所需动词和 secret 引用，也可以把已有条目组合成 workflow。但组合不免除授权，传递性授权仍受强制检查。

它不能把任意代码放进网关进程。HTTP 注册路径只物化 manifest，不能上传 `handler` 函数；进程内 handler 是网关自有、编译期绑定的能力。启动外部二进制和注入网关进程，是两回事。

它也不能绕过作用域授权。条目默认拒绝；所需动词没有被受限 token 完整覆盖，invoke 就返回 `grant_required`。用户看到并授予的是声明中的动词，`grants:["read"]` 不会在网关内变成写入权限。不过，网关检查的是声明与授权是否相符，并不能靠 `read` 标签阻止恶意外部服务或二进制写入。作者必须如实声明副作用，并在执行端守住只读承诺。已有符合条件的 standing grant 时，不必每次重新请求人工确认。

workflow 也不能借组合提权。成员在由 `members[]` 派生的合成传递作用域下运行，这组作用域在授权确认时展示给用户。执行时，每个成员都重入同一管线，逐一检查作用域（ADR-012/013），不能静默扩大权限；扇出中途发生撤销，会中止其余成员。

manifest 界面不能用来读取 secret 值。扩展只声明引用，值只在派发时解析，并只交给拥有它的 transport；manifest、`.well-known`、manifest 快照和审计中都不会出现这些值。

扩展不能靠声明伪造身份，也不能自行把本地入口开放给其他主机。每个端点都先做 Host/Origin 校验，再做 auth（ADR-016），本地入口只绑定回环；wire 注册也不能认领保留的 first-party 身份。这是本地入口的边界，不否定已经交付的 mesh primary/proxy 经相互认证隧道转发的拓扑。

实例收容则有一个不能省略的前提：transport/handler 必须真正执行限制。Obsidian 的路径检查会以 `transport_error` 拒绝 `..`、绝对路径和符号链接逃逸。实例级收容是执行端的职责，要刻意写好，不能仅凭注册或动词授权就声称扩展无法逃逸。

审计同样不能绕过。每次 invoke 都会记录审计，派发前被拒绝的请求也不例外；记录中的 `detail` 必须经过安全脱敏。

注册一个由 transport 背书的扩展，用户仍然交出了一份残余信任：它可以让网关在用户授予的动词下，发起它点名的本地 HTTP 调用、启动它点名的二进制。网关守住作用域，不等于替这些外部程序担保行为。用户的防线是动词可见的授权提示、审计日志和撤销能力。扩展若点名了用户不信任的 `cli` 二进制，就不该被授予 `execute`。


## 12. 完整 manifest 示例 {#_12-完整-manifest-示例}

### 12.1 用 `local-rest` 只读访问 Obsidian，附带一个 secret 和一个使用 skill {#_12-1-local-rest-只读-带一个-secret-一个附着技能-obsidian}

下面把读取能力、服务定位、凭据引用和使用指引放进同一份 manifest。`vault.read` 声明读取所需的输入与路由，`route.attachSkills` 按声明名称指向 `vault.how-to-cite`；后者单独提供引用笔记的 Markdown 指引。

> `obsidian` 本身是保留的 first-party source id（§8 规则 4），wire 注册必须选用自己的 id，这里用 `my-obsidian`。

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


### 12.2 用 `cli` 原地格式化文件：本地 Prettier {#_12-2-cli-可写的二进制-一个本地格式化器}

这里调用本地 `prettier`，按项目风格格式化 agent 刚写入或编辑的文件。输入是文件的绝对路径；`--write` 会直接修改磁盘上的文件，所以声明 `grants:["write"]`。这个动词对应的是原地修改，不是说所有 `cli` 操作都需要同一种权限。

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

### 12.3 用 `workflow` 组合两个已有 capability {#_12-3-workflow-组合两个已有-capability}

成员必须能解析到注册表中在场的条目。这里组合的是同一 manifest 声明的两个 capability；也可以引用其他 source 的既有 id，但跨源引用仍受 §8 的显式门控：默认拒绝，只有显式开启并经用户确认才允许。id 已存在，只满足解析条件，不代表已有使用权限。

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

授予 `notes.daily.log` 的 `write` 时，会合成传递性的成员作用域：`notes.vault.read` 的 `read` 与 `notes.vault.append` 的 `write`。授权确认会把它们展示给用户，token 中也会写入这些作用域，并以 `synthesizedFor` 标明归属。`WorkflowTransport` 经统一的 invoke 管线扇出，每个成员仍走同一套检查（§9、ADR-013）。`members` 按顺序列出成员，不意味着自动传递输出，也不承诺事务或其他执行保证。

## 13. 编写工具的合规清单 {#_13-合规清单-供编写工具使用}

manifest 合规，当且仅当以下条件全部满足；这些是编写时的检查条件，不能据此认定注册入口已完整执行每项校验。

- `manifest === "plexus-extension/0.1"`。
- `source` 与 `label` 均在场。
- `transport` 不得为 `mcp`。
- 至少声明一个 capability。
- 每条声明都有 `name`、`kind`、`label`、`describe`、`grants`。
- skill 声明携带 `body`，并设置 `grants:[]`。
- workflow 声明携带 `members[]`；其中每个 id 都解析到在场条目，且 `verbs` 是成员 `grants` 的子集。跨源引用仍须通过 §8 的显式门控。
- 每个 `route.secret` 都点名已声明的 secret。
- 每个 `route.attachSkills[]` 都点名已声明的 skill。
- 若有 `io.input`，它必须是有效的 JSON Schema Draft 2020-12。这是 schema 声明格式要求；当前运行时只做轻量输入校验，不代表完整支持该标准。

完整校验规则及网关在哪个阶段强制执行哪些检查，见 §8。
