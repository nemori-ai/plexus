---
title: "核心概念"
description: "Plexus 的心智模型：Connector → Source → Capability 的关系、来源、三个时钟，以及自描述的 Floor 和它的编译投影。"
---
# Plexus 核心概念——心智模型 {#plexus-核心概念——心智模型}

Plexus 是一个本地能力网关。它把你已经在用的软件接进来，为任何 AI agent 提供一套统一的、面向 AI 使用的协议。笔记、日历、提醒和工具有哪些 capability、该怎么用，agent 都可以通过这套协议了解；真正调用时，还需要取得相应授权。它可以在你的 Mac 上运行，也有经过验证的 Linux 网关运行路径；macOS 专属应用的 source 不能因此在 Linux 上使用。

网关默认只绑定回环地址。要让其他设备访问，需要拥有者确认：可以通过 `network.json` 绑定局域网，也可以通过 `publicHostnames` / `PLEXUS_PUBLIC_HOSTNAME`，把网关发布到由隧道接入的公网域名。无论采用哪种暴露方式，信任边界始终是拥有者用于管理的 `connection-key`。具体配置见 [home-gateway 示例](https://github.com/nemori-ai/plexus/tree/main/examples/home-gateway)。

这里要分清两种凭据。`connection-key` 供拥有者管理网关；agent 使用自己的 PAT，由一次性 enrollment code 换取。agent 用 PAT 握手，绑定真实身份，拿到 session 和面向它的 manifest。这份清单中的 capability 必须已启用暴露，并且属于拥有者为它选定的子集，或已有拥有者创建的有效常驻授权。常驻授权是否有效，还要检查有效期和当前 `connection-key` 的 epoch。出现在清单中，并不直接授予调用权限。调用前还要单独取得相应的 scoped token；已有符合条件的常驻授权时，不必再次请求拥有者批准。

多主机连接也已有实现。目前交付的是单 primary、配合 proxy 的 mesh，支持网关登记、双向认证隧道、目录挂载、调用转发和撤销。更深的嵌套拓扑、企业归属等扩展仍是后续方向。已实现的流程和延期部分见[联邦 mesh](/zh/architecture/mesh)。

这篇文档是理解 Plexus 的基础。[上手指南](/zh/guide/)、[安全模型](/zh/architecture/security-model)和各篇教程，都会用到下面这几层关系。

---

## 1. Connector → Source → Capability {#_1-connector-→-source-→-capability}

拿 Obsidian 来说，选择通过什么方式连接、配置某个具体的 vault、读取其中一篇笔记，是三件不同的事。Plexus 用三个词分别表示它们：

| 层 | 中文 | 问题 | 例子 |
| --- | --- | --- | --- |
| Connector（连接器） | 怎么接 | Plexus 怎么连接这一类东西？ | “Obsidian Local REST API”、“Obsidian vault（文件系统）”、“Claude Code（沙箱）” |
| Source（源） | 接了什么 | 你实际接入了什么？ | 你在 `~/Documents/MyVault` 的那个 vault；正在运行的 REST plugin |
| Capability（能力） | 能干什么 | agent 能用它做什么？ | `obsidian.vault.read`、`apple-calendar.events.list` |

![Connector → Source → Capability](/diagrams/source-capability-spine.png)

Connector 是 Plexus 认识的一种连接类型，本质上是纯目录数据。它声明“添加…”表单需要哪些配置字段、配置后会产生什么 transport，再用一句话说明它暴露什么。它不携带密钥，自身也不注册任何东西。要查看这些类型，可以访问 `GET /admin/api/connectors`。

选定 connector，填好配置，实际添加进来的那个东西才是 source。比如，Obsidian Local REST API 是连接类型，接到某个 vault 上的已配置实例是 source。

Source 由网关管理。网关运行时，你就可以添加、移除、启用、禁用或重新配置它，不需要重启。配置持久化在 `~/.plexus/sources.json`，变更会热重载进正在运行的注册表。已接入的 source 列表在 `GET /admin/api/sources`。

Capability 则是 source 提供的一项可调用操作。每项操作都有稳定的点分 id，例如 `obsidian.vault.read` 或 `apple-calendar.events.list`。它还声明输入和输出 schema、所需的动词（`read` / `write` / `execute`），并提供一段供人阅读的 `describe`。需要补充用法时，可以附带 skill，也就是 markdown 格式的使用指引，供 agent 阅读，了解怎样用好这项 capability。

同一个 Obsidian connector，也就是 Local REST API 那种，可以支撑多个 source，分别连接不同的 vault。每个 source 都暴露同样的 capability：`obsidian-rest.vault.{list,read,write}`。

### 第一方 capability 开箱即带 {#第一方-capability-开箱即带}

有些操作已经随 Plexus 一起提供。它们来自第一方 source：这些 source 是保留的，在进程内运行，除了底层应用自身的权限，无需其他设置。`workspace` 和沙箱运行的 source 还有一个前提：拥有者要先授权一个目录。

| Source | Capability 与使用指引 | 动词 |
| --- | --- | --- |
| `apple-calendar` | `apple-calendar.calendars.list`、`apple-calendar.events.list` | read |
| `apple-reminders` | `apple-reminders.lists.list`、`apple-reminders.reminders.list` | read |
| `apple-reminders` | `apple-reminders.reminders.create`、`apple-reminders.reminders.complete` | write |
| `workspace` | `workspace.list`、`workspace.read`（`workspace.how-to-use` skill） | read |
| `workspace` | `workspace.write` | write |
| `claudecode` | `claudecode.run`（`claudecode.how-to-use` skill） | execute |
| `codex` | `codex.run`（`codex.how-to-use` skill） | execute |
| `browser-control` | `browser-control.tabs.list`、`.page.read`、`.page.elements`、`.page.screenshot` | read |
| `browser-control` | `browser-control.page.navigate`、`.page.click`、`.page.type`、`.page.evaluate` | execute |

Apple source 的 list 操作在实现上就是只读的。底层 provider 用来读取日历和提醒事项列表的代码，根本没有写入路径。这一点由实现保证，不需要靠 agent 遵守“只读”的约定。

Reminders 的创建和完成操作则单独列为两项 write capability。读取提醒事项时取得的权限，不能用来创建或完成提醒事项；要做这些事，必须有相应的写入授权。agent 无法自行授予自己这两项权限。表中的 skill 也只是使用指引，读过它不会增加调用权限。

---

## 2. 信任模型——默认拒绝、有范围、有时限 {#_2-信任模型——默认拒绝、有范围、有时限}

拥有者为 agent 选定一组 capability，和 agent 取得这些操作的调用权限，是两件事。前面的表说明网关提供哪些操作；即使其中某项已经选给了 agent，也不能仅凭这次选择直接调用。

Plexus 默认拒绝未经授权的调用。agent 能触达网关，本身不会得到任何权限。权限由人授予，限定范围、限定时限，也随时可以撤销。

握手解决的是身份和清单的问题。agent 用自己的 PAT 通过认证，网关把 session 绑定到它的真实身份，并返回面向它的子集 manifest。这一步让 agent 知道自己可以看到、可以申请使用哪些 capability；握手成功本身不授予调用权限。

这里的清单也不一定止于拥有者最初勾选的集合。拥有者后来另行创建的有效常驻授权，可以让相应 capability 进入这个 agent 的授权视图，使它能够看到并申请使用。这个例外仍来自拥有者，agent 不能替自己创建。超出拥有者有效授权范围的请求，依然会被拒绝。

调用前，agent 还要单独取得限定范围的 scoped token。取得 token 时，若已有符合条件的常驻授权，就可以依据那份授权继续，不必再请拥有者批准。默认拒绝未经授权的调用，并不意味着每次连接、每次调用都要重新弹出一次人工审批；已有批准能否用于当前请求，要看它是否满足相应条件。

::: tip 一段专注的阅读
本节有独立成篇的页面：[信任模型](/zh/concepts/trust-model)。这里先作简要说明。
:::

### 三个时钟，各自计时 {#三个时钟-而非一个}

Plexus 把三件事分开计时：你的批准能保留多久，agent 的一段工作能持续多久，单个 token 又能用多久。批准还有效，不代表上次工作的会话还在；会话还在，也不代表手里的 token 尚未过期。三者分别到期，各管一层。

![信任窗口之上的短时受限 token](/diagrams/two-clocks.png)

批准授权时，你可以选择 `once`、`1h`、`1d`、`7d`、`until-revoked`，也可以通过 `custom` 自定义时长。这是信任窗口（trust-window），记录的是你这次决定的有效期。除 `once` 这个特例外，常驻授权让 agent 在窗口结束或你撤销这份授权之前，依据仍符合条件的批准继续工作，不必再次询问你。但窗口再长，也不会把一段会话或一个 token 的寿命一起拉长。

每次 handshake 都会打开一个会话（session），把接下来的一段工作算作一个片段（episode）。会话保存在内存里，寿命为 60 分钟；网关一旦重启，它就失效。`POST /invoke` 和 `POST /grants/refresh` 都要求所出示 token 所属的会话仍然存活。因此，会话到期或随重启消失后，即使拥有者的批准还没到期，原会话里的调用和静默换发也不能继续。这只时钟限定了权限能在同一工作片段里静默流动多久。

实际调用携带的是受限 token（scoped token），一种短寿命的 bearer token。它把权限限定在具体范围内，也限定了这一个凭据的使用时间。默认寿命为 15 分钟，由 `DEFAULT_TOKEN_LIFETIME_MS` 定义，配置值会被钳制在 `[1m, 60m]`，也就是 1 到 60 分钟之间。这里的 15 分钟是单个 token 的默认有效期，不能拿来代替会话的 60 分钟，更不能拿来解释拥有者选定的信任窗口。

token 过期后，agent 可以通过 `POST /grants/refresh` 静默换发，但有两个条件要同时成立：原会话仍然存活，而且存在符合条件、仍在信任窗口内的常驻授权。满足这些条件，换发不需要 `connection-key`，也不会再次提示拥有者批准。只剩一个尚未结束的信任窗口，并不足以继续换发；只有活会话，没有符合条件的常驻授权，同样不行。

这也决定了该怎样理解 token 泄漏的后果。短寿命限制的是单个 token 的有效时间，不能据此保证所有滥用都会在几分钟后结束。同一会话里，如果仍有窗口内符合条件的常驻授权，换发链就可能继续。会话结束时，这条链才失去继续静默换发所需的会话条件；信任窗口尚有余量，也不能替它续上。

三者构成一条收容阶梯：PAT（身份，持久）→ 会话（片段，≤ 1 小时）→ token（爆炸半径，约 15 分钟）。持久身份之下，是有期限的工作片段，再往下是范围更窄、默认寿命更短的调用凭据。偷到 scoped token，不能反过来创建 PAT，也不能打开新会话。要开始下一个片段，必须用 agent 的 PAT 重新完成一次握手。完整论证见[信任模型](/zh/concepts/trust-model)。

`once` 不走这条换发路径。它只为一次使用而立，记录为 `expiresAt = grantedAt`，不能刷新。会话仍然存活，也不会把它变成可反复沿用的批准；未来该问的批准，一次也不会少。至于其余授权，窗口内究竟哪些常驻授权符合沿用条件，还要接着看。

### 常驻授权要看操作，也要看拥有者的决定（ADR-5） {#常驻资格随敏感度而定-而非随出身-adr-5}

信任窗口不是对每项 capability 都任意开放的。操作要做什么，来源和 transport 怎样影响风险，拥有者又批准了什么，这几件事要一起看。只知道它来自第一方或扩展，还不能判断它能否获得常驻授权。

连接时，拥有者选定的 `read` capability 会获得常驻授权。此后，只要请求在批准范围内、授权仍符合条件，就不必再请人批准，直到窗口结束或拥有者撤销这份授权。`read` 的信任窗口选择器可以提供持续有效的窗口。

`write` 和 `execute` 则默认逐次批准；其他高敏感度 capability 也默认如此。拥有者可以明确为特定的 agent + capability 组合开启常驻授权。对于 `write`，还有两条途径：批准待处理请求时给它一个真实信任窗口，或由拥有者直接授予常驻授权。第一方／受管 `read` 的适用窗口默认是 `7d`，`write` 的适用窗口默认是 `1d`。这些是窗口时长的默认值，不能代替拥有者的授权决定。

`execute` 多一道限制。没有拥有者专门开启常驻授权时，它的上限就是 `once`。agent 请求再长的窗口，也不能自行解除这个限制。因此，`claudecode.run`、`codex.run` 这类运行代码的操作，默认每次都需要人作出一次新的决定。

拥有者可以在连接时，为特定的 agent + capability 组合开启常驻 `execute` 授权（默认关闭，需双重确认）。只有拥有者能开启这一例外，agent 的请求不能替代它。开启后，这份授权才可以像其他常驻授权一样，采用真实窗口或 `until-revoked`；已有符合条件的授权时，也就不必每次重新询问。

### 来源（provenance）——三类 source-class，记录接入方式 {#来源-provenance-——三类-source-class-组织轴}

来源说明一项 capability 从哪来、接入时经过谁的审查。Plexus 用它划分 source 的组织类别，并据此设置默认审批姿态。它参与风险判断，但风险还要结合动词和 transport 来看。

| 来源 | 含义 | 默认姿态 |
| --- | --- | --- |
| `first-party` | 保留的进程内 source，包括 Apple Calendar/Reminders/Notes/Mail/Contacts/Photos、Claude Code、Codex、Shortcuts、browser、browser-control、workspace、sysinfo。 | 已选 `read` 可沿用连接时授予的常驻授权；`write` / `execute` 默认仍需人批准。 |
| `managed` | 拥有者通过可信的 `/admin` UI 添加的 source，例如通过 REST 或文件系统接入的 Obsidian vault；添加时已经过人的审查。 | `read` 的审批姿态与第一方相同；`write` / `execute` 默认挂起，等待人批准。 |
| `extension` | agent 通过 `POST /extensions` 在协议上注册的 source，默认审查最严格。 | 没有适用授权时，任何动词都挂起，等待人批准。 |

表中说的是默认姿态，不表示已有批准也要重问。连接时选定的读取操作、拥有者明确授予的其他常驻权限，都要按前面的规则判断能否沿用。

第一方日历的读取操作，与 agent 注册的 shell 包装器，接入时经过的审查不同，能做的事也不同。来源记录保留了这层区别。来源印记由网关盖在 source 上；第一方 id 是保留的，扩展不能冒充。

### 敏感度（sensitivity）——把来源、动词和 transport 一起看 {#敏感度-sensitivity-——推导出的风险层级}

知道从哪来，还要知道它准备做什么、通过什么方式做。网关从来源、动词和 transport 共同推导敏感度，让 UI 和每个 agent 对同一项操作描述同一种风险。

`low` 对应第一方或受管 source 上的 `read`。

`elevated` 对应第一方或受管 source 上的 `write` / `exec`，也包括扩展上的 `read`。不过，涉及写入或执行时，还要继续检查 transport。

`high` 包括扩展上的 `write` / `exec`，以及任何通过 `cli` / `local-rest` transport 提供的 `write` / `exec`。后一条也适用于第一方和受管 source：来源不会抵消 transport 带来的敏感度上调。

Workflow 的敏感度取所有成员中的最大值。成员中只要有一项属于 `high`，整个 Workflow 就按 `high` 描述。

### 授权账本与撤销 {#授权账本与撤销}

批准以后，授权记录仍可查看。常驻授权是一等公民，两侧都看得见，只是各自能看的范围不同。你在 `/admin` 的 Grants 标签页查看全部授权；agent 通过会话认证调用 `GET /grants`，只能看到自己的。每条记录都列出 agent、capability、动词、来源、敏感度、信任窗口和到期时间，方便你核对先前批准了什么，现在还剩哪些权限。

撤销随时可做。你可以在 Grants 标签页操作，也可以持管理 `connection-key` 调用 `POST /grants/revoke`：按 `jti` 撤销某个 token，按 `(agentId, capabilityId)` 撤销这个 agent 对这项 capability 的授权，或按 `bundleId` 一并撤销整个任务 bundle 的成员授权。这里撤销的对象各有范围，不能混作撤销 agent 身份。agent 也能向同一端点出示某个 token 及其 `jti`，但只能放弃它自己的 token，不能借此撤销其他 agent 的授权。

### 暴露门控——拥有者的外层开关 {#暴露门控——拥有者的外层开关}

账本记录了你给过什么权限，你还可以另行决定某项 capability 是否对外开放。这就是暴露：由拥有者独立控制，放在授权检查之前。禁用暴露后，这项 capability 在 discovery 中不可见，也不能再被授权；即使 agent 带着原本有效的授权来 invoke，仍会先收到 `capability_unexposed`，不会进入后面的授权检查。这道门控已经交付，实现在 `packages/runtime/src/core/exposure.ts`，拒绝逻辑接在 `pipeline.ts` 中。

所以有效访问 = 已授权 ∧ 已暴露：撤掉暴露就切断了这项 capability，不管还有什么常驻授权。

### 两种批准方式 {#双模授权-ux}

Plexus 支持两种互补的批准方式。第一种是临时、逐操作批准：agent 在需要时申请授权。对于授权子集内的 capability，若已有符合当前请求的常驻授权，比如连接时勾选的 `read`，授权请求就可以直接通过，不必再问你。没有适用授权的请求则挂起，返回 `grant_pending_user`，等待你决定。

这里的范围按前面说的有效授权视图判断，不只看最初勾选的集合。子集之外，如果已有拥有者创建的常驻授权，且它尚未过期、通过当前 `connection-key` epoch 校验，相应 capability 也可以进入授权视图。agent 不能自行创建这个例外。既不在选定子集内、又没有这种有效授权的请求，会被直接拒绝，不出批准卡片。进入授权视图只解决能否看到和申请的问题；取得 scoped token、实际调用时，仍须满足范围、动词、会话有效性等限制，也不能绕过暴露门控。

请求挂起后，你会看到网关撰写的批准卡片。卡片写明哪个 agent 想做什么、要做多久，并提醒你随时可以撤销。你可以批准并选择一个信任窗口，也可以拒绝；窗口仍受前述常驻授权资格约束，agent 不能靠申请更长时间解除 `execute` 的限制。

第二种是有范围的任务 bundle。你可以把一项任务所需的授权放进一个具名 bundle，连同各项范围约束和附着的范围内上下文，一次预授给某个 agent。bundle 只是把常驻授权归在同一个 `bundleId` 下，不会增加成员授权以外的任何权限。这样，你可以按整个任务检查这些授权，也可以一起撤销。agent 则通过 `GET /grants/context?bundle=<id>`，一次取回该 bundle 附着的上下文。

任务 bundle 的后端机制仍然保留，但 1.0 管理控制台暂不提供 bundle 创建或管理界面。目前，各成员在账本中显示为普通的常驻授权。这套机制作为 ADR-020 的 proto-ticket，保留在[授权扩展路线图](/zh/architecture/extensibility)中。

两种方式都遵守同一个要求：人读到的授权叙述由网关撰写，而非 agent。agent 可以附一段自由文本，解释“为什么是现在”；网关会先净化、截断，再明确标注为“the agent says：（agent 说：）”。这段话只代表 agent 的说法，不影响任何授权决定，也不能替代或伪造网关写出的风险摘要。

完整的威胁模型和信任边界，见[安全模型](/zh/architecture/security-model)。

---

## 3. MCP 与 Plexus——工具接口与机器的使用规则 {#_3-mcp-vs-plexus——-有哪些函数-vs-如何使用我}

Plexus 不是 [MCP](https://modelcontextprotocol.io) 的竞争者；它回答的是另一个问题。

MCP 让 server 用带 schema 的工具列表，说明自己暴露哪些函数，供 agent 调用。它提供工具调用的传输方式，也有自己的授权框架：当前的 [MCP 授权规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)基于 OAuth，包含授权服务器发现、scope 和访问令牌校验。工具怎样连接、请求怎样获得授权，都有协议上的规定。

[`2026-07-28` 修订](https://blog.modelcontextprotocol.io/posts/2026-07-28/)移除了协议层的初始化握手和 session header。这是传输协议的无状态化，不意味着应用不能保留跨请求状态，也不能据此说 MCP 没有身份、授权或安全机制。协议是否维持会话，与一项操作是否允许执行，是不同的问题。

Plexus 要说明的是：这台机器该怎么使用，哪些操作需要拥有者作出什么决定。前面讲过的授权规则，就是它对此的具体回答。拥有者可以按 agent 和 capability 批准权限，限定范围与时限；网关按每项 capability 的策略检查请求，默认拒绝未经授权的调用。已有符合条件的常驻授权时，agent 可以继续使用，不必每次重新请人批准。

这也影响了 agent 能发现什么。Plexus 的目录由当前有效授权和暴露设置共同决定，既可能包含拥有者选定的 capability，也可能包含拥有者另行创建有效常驻授权的 capability。目录不是整台机器的工具清单；出现在其中，也不等于已经取得 scoped token 或通过实际调用的检查。

因此，发现层还要回答“我如何获得授权”。一个 URL 描述接入所需的生命周期：`enroll`、`handshake`、`grant`、`invoke`。agent 可以先了解怎样接入，再沿着这些步骤取得面向自己的清单和调用权限。

知道接口以后，还要知道怎样用。Plexus 保留来源信息，结合来源、动词和 transport 描述敏感度，让风险可以读懂。附着的 skill 提供使用指引，不增加权限。常驻授权则留在账本里，供拥有者核对、审计和撤销。这些都是 Plexus 提供的具体行为，不能拿来反推 MCP 缺少授权能力。

::: warning 当前交付状态
MCP 传输／客户端层已经存在，并经过测试。但面向用户的“把 MCP server 包装成 source”路径尚未交付，生产注册表里还没有 MCP source 模块。目前要么经第一方 source 暴露 capability，要么写一个扩展。见 [已知限制](https://github.com/nemori-ai/plexus/blob/main/docs/KNOWN-LIMITATIONS.md)。下面描述的是接下来的设计方向。
:::

按这个方向，MCP server 可以被接入 Plexus，成为 `transport:"mcp"` 的 source，其中的工具成为 Plexus 的 capability。原有的 MCP 来源信息会无损保留，Plexus 也能沿原路把调用交回原始 server。

在这个设计里，MCP 是 Plexus 会使用的多种传输之一。Plexus 在其上提供信任、发现和 capability 层，让接入的工具也遵守这台机器的使用规则，并通过同一个发现入口向 agent 说明。

---

## 4. 自描述协议——分两层发现 {#_4-自描述协议——两个层级}

Plexus 的发现是分层的：agent 每走一步，只收到当下需要的信息。会话前，先知道网关是谁、怎样接入；握手后，再拿到面向自己的 capability 清单和使用细节。

### 层级 1——`.well-known` 入口（会话前、免认证） {#层级-1——-well-known-入口-会话前、免认证}

```
GET /.well-known/plexus
```

这个入口免认证。它返回网关身份，并在 `auth` 中公示各会话端点的 URL，包括 `handshakeUrl`、`grantsUrl`、`invokeUrl` 等。agent 从这里读取端点地址，不把路径硬编码在客户端里。

公示还说明请求格式和 enrollment 方法。`auth.enrollment` 告诉 agent 怎样用一次性码兑换 PAT；`capabilitiesVia` 则指明下一步：完成 enroll 和 handshake，才能收到面向自己的 capability 清单。这里说明的是接入方法，不提供凭据，也不发布完整的 manifest。`connection-key` 仅供管理员使用，绝不会出现在这份公开响应中。

这个公开、自描述的入口就是 Floor。客户端可以直接通过 HTTP 使用它，无需 plugin；后面的[§5](#compile-model)会接着说明它与编译模型的关系。

### 层级 2——握手 manifest（会话后、完整细节） {#层级-2——握手-manifest-会话后、完整细节}

第一次握手前，agent 先用管理员连接它时签发的一次性 enroll 码兑换 PAT，只需兑换一次（见[§5](#compile-model)）。得到的 PAT 专属于这个 agent，按 `0600` 权限保存在本地，供以后开会话使用。

agent 用它自己的专属 PAT 开会话，绝不用 `connection-key`：

```
POST /link/handshake     Authorization: Bearer plx_agent_…
```

网关从 PAT 解析出真实的 `agentId`，客户端不能自称是另一个 agent。`connection-key` 是拥有者的管理凭据，握手的管理员路径使用它；agent 走的是上面这条 PAT 路径。

握手返回一个会话和面向该 agent 的 manifest。清单内每项 capability 都带完整的 `describe`、输入／输出 schema、所需动词、transport、默认信任窗口，以及附着的 skill 正文。manifest 还包含会话句柄、到期时间和单调递增的 `revision`。这里的“完整”指条目的使用细节齐全，清单范围仍由拥有者控制；skill 也只是指引，不增加调用权限。

具体范围沿用前面的有效授权视图：capability 必须已暴露，并且属于拥有者选定的子集，或已有拥有者创建的有效常驻授权。后一种授权要尚未过期，并通过当前 `connection-key` epoch 校验。因此，清单可以包含最初勾选集合之外、后来由拥有者授权的 capability；agent 不能自行创建这个例外。

看到清单以后，agent 才知道可以申请使用什么。握手本身不授予调用权限，仍须单独取得 scoped token。已有符合当前请求的常驻授权时，可以据此取得 token，不必再次请拥有者批准；需要新批准时，请求则挂起等待人处理。既不在选定子集内、又没有上述有效常驻授权的请求，会被直接拒绝。实际调用仍须通过前述的暴露、范围、动词和会话有效性检查。

把这些步骤连起来，就是完整的客户端流程：

```
0. DISCOVER    GET  /.well-known/plexus           (gateway identity + endpoint URLs + enrollment self-description)
1. ENROLL      POST /agents/enroll                (one-time code → durable per-agent PAT, stored 0600)
2. HANDSHAKE   POST /link/handshake               (Bearer PAT → real agentId → session + subset manifest)
3. GRANT       PUT  /grants                        (request scoped access → token, or pend for a human)
4. INVOKE      POST /invoke                        (Bearer scoped token → result → audit event)
```

第 0 步免认证；第 1 步每个 agent 只跑一次；第 2–4 步重复。调用时携带 scoped token，网关返回结果，并留下审计事件。

agent 侧完整、依赖极少的参考实现见 [`examples/min-agent/client.ts`](https://github.com/nemori-ai/plexus/blob/main/examples/min-agent/client.ts)。要实际走一遍流程，可以运行自包含的端到端演示：`bun run examples/min-agent/run.ts`。

---

## 5. 编译模型——Floor 与它的投影 {#compile-model}

::: tip 单独阅读本节
本节也有独立页面：[编译模型](/zh/concepts/compile-model)。
:::

前面的 `.well-known`、`requestShapes`，加上每项 capability 的 how-to-use 和输入／输出 schema，共同组成 Floor。它是网关始终提供的资源暴露面，既说明有什么，也说明怎样接入、怎样使用。任何 agent 都可以通过纯 HTTP 发现 `enroll`、`handshake`、`grant`、`invoke` 所需的信息，无需安装 plugin。接入所需的东西，没有哪一样藏在定制工具后面。

这不表示所有信息都公开。公开入口说明网关身份和接入方法，不发布凭据或完整的 per-agent manifest；面向 agent 的能力清单，要在身份认证后，按它当前的有效授权与暴露设置提供。

![自描述的 Floor，以及为每个 agent 编译的插件投影](/diagrams/floor-projection.png)

在这套 HTTP 接口之上，Plexus 为每个 agent 单独编译一件产物，让同样的 capability 在那个 agent 手里用起来像原生能力。v1 的产物是一个 Claude Code plugin。它把 Floor 的说明带进 agent 熟悉的使用方式里，省去每次从头理解协议的工作。

这件产物是 Floor 的投影：提供缓存和快捷方式，绝不是 Floor 的替代品。

每份产物都随附专属 launcher，名称是 `plexus-<agentId>`。它自带捆绑引擎，内部写死这个 agent 的 `PLEXUS_AGENT_ID`，并锁定自己的引擎版本。因此，同一台主机上的两个 agent 各用各的 launcher 和引擎版本，互不冲突。这里用的不是一个不带 agent 标识的全局 `plexus` 命令。

launcher 提供三种命令形式：

- `plexus-<agentId> enroll <code>`：首次运行时兑换一次性码，取得这个 agent 的 PAT，并自行保存。
- `plexus-<agentId> list`：发现可用操作，枚举面向这个 agent 的 capability，分为 `callable-now` 和 `needs-approval`。前者已有符合条件的常驻授权，后者还需要批准。
- `plexus-<agentId> <capabilityId> [args]`：调用指定的 capability。

其中，`list` 让 agent 能看到编译之后发生的变化。拥有者后来才授权给它的 capability，也可以通过这个命令发现，不必把编译时的清单当成此后全部的能力范围。当然，新授权仍须符合有效授权视图和暴露规则。Floor 随网关当前状态变化，plugin 保存的只是编译时的投影。

对于使用这份编译集成的 agent，launcher 是完整且唯一的接口。编译好的 skill 会明确要求：每次交互都走 `plexus-<agentId> …`，不得自行向网关拼 HTTP 请求，也不得猜测认证路径。这条规则约束的是编译集成中的使用方式；独立 HTTP 客户端仍然可以直接使用 Floor。

launcher 内部封装了规定的凭据生命周期：一次性码换取 PAT，PAT 用于认证和打开会话，调用前再取得相应的 scoped token。已有符合条件的常驻授权时，沿用已有批准；需要新批准时，等待拥有者决定。agent 不需要自己重写这套流程。

这部分认证／invoke 内核从 Floor 按模板确定性地生成，并对照 Floor 校验，不是由 LLM 编写的。分发的产物里绝不写死任何持久密钥；随安装交付的，只有那个短寿命、一次性的码。PAT 是兑换后才取得并保存在本地的凭据。

skill 终究只是使用指引，授权由网关实时强制执行。缓存里的说明即使陈旧，甚至生成有误，也不能增加权限，更不能越过 Floor 的权限限制。最坏不过是 skill 仍引用一项已经撤销的 capability；agent 照着发起 invoke，请求会在网关处直接失败。

## 继续阅读 {#接下来去哪}

[安装并连接第一个 agent](/zh/guide/)：从安装 Plexus 开始，按快速上手指南，在 macOS 上走完端到端的连接流程。

[信任模型](/zh/concepts/trust-model)：继续了解默认拒绝、三个时钟、来源与敏感度，以及它们怎样影响授权。`execute` 默认逐次批准，只有拥有者显式开启，才可以获得常驻授权。

[编译模型](/zh/concepts/compile-model)：了解自描述的 Floor，以及为每个 agent 单独编译的专属 plugin。这里解释两者的关系：plugin 是 Floor 的投影。

[凭据与安全模型](/zh/architecture/security-model)：需要对照代码核实安全边界时，查阅这份权威说明。它区分拥有者用于管理的 `connection-key` 与 agent 自己的专属 PAT，也说明 `execute→once` 的默认上限，以及只有拥有者的常驻 `execute` 开关才能解除的限制。

[项目 README 与仓库地图](https://github.com/nemori-ai/plexus/blob/main/README.md)：用一段话了解项目全貌，再沿仓库地图找到需要阅读的部分。
