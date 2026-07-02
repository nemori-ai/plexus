---
title: 决策记录 (ADR)
description: Plexus 协议契约（v0.1.3）的 M0 架构决策日志——每条 ADR 记录一个决策、其理由，以及它排除了什么。
---

# M0 —— 设计决策 (ADR)

::: tip 状态
日期：2026-06-24 · **M0 契约 v0.1.3**（v0.1.0 + ADR-017 `/invoke` 单一形状精修 + ADR-018 统一信任模型 + ADR-019 登记/PAT 自描述对齐）· 范围：M0 协议与架构契约。每条 ADR 记录一个决策、理由，以及它**排除**了什么。本次修订应用了对抗性评审的修复（发现 #1–#10 + 次要项）和两个已锁定的用户决策（Authorizer 缝、15 分钟令牌 + refresh）。此前悬而未决的分叉现已决定（见 **已在冻结中解决**）；**待定 / 推迟到 v1 之后** 一节只保留真正属于 v1 之后的条目，无一阻塞冻结。
:::

上游已锁定（不再重议）：**ADR-001 MCP = 超集/收集器，以 Option-C 方式建成的 Option A**（MCP 是那个享有特权的 `mcp` 摄取 transport，schema 逐字通过，附加层在线路之上，façade 作为一个后来的可选输出）；**ADR-002 名字贯穿 v1 保持 "Plexus"**；**技术栈** = Bun + TS + Hono，macOS 优先，复用 pneuma `path-resolver`。

## ADR-003 —— Transport 集合：`local-rest | stdio | ipc | mcp | cli`（+2 个哨兵）

**决策。** 第一批完全按启动会 §9.3，`mcp` 享有特权。加两个非线路哨兵 `skill` 和 `workflow`，让 `transport` 字段对所有条目种类都是全函数（一个 skill/workflow 仍然会被"触达"，只是不经线路）。Transport 实现单一的 `Transport.dispatch()` 接口；注册表把 `kind → impl` 做映射。加一个 transport = 实现 + 注册。

**理由。** 覆盖现实的本地界面：HTTP localhost API（local-rest）、通用子进程协议（stdio）、OS IPC（ipc）、MCP 服务器（mcp）、以及普通二进制（cli）。哨兵让类型保持全函数，避免一个 `Option<transport>`。

**排除。** WebSocket 作为自己独立的 transport（暂折叠进 local-rest/ipc）；一个运行时可插拔的第三方 transport 注册表（M0 中 transport 是编译期注册的）。

## ADR-004 —— 统一自描述模型：一个 `CapabilityEntry`，以 `kind` 判别

**决策。** capability / skill / workflow 是一个以 `kind` 判别的类型，而非三套平行 schema。种类专属字段是可选的（workflow 的 `members`、skill 的 `body`、mcp-transport 的 `mcp`）。`CapabilityEntry` 是规范名；`SelfDescribeEntry` 是别名。

**理由。** agent 得到一个发现循环、一个授权界面、一条调用路径。同构才是全部要点——"定制即扩展，扩展被自动发现"。一个 first-party 适配器、一个被摄取的 MCP 工具、一个用户扩展，在形状上必须无从分辨。

**排除。** 按种类的端点 / 按种类的令牌类型。一个高度多态的条目在 OO 意义上会更"正确"，但会破坏统一发现的承诺。

## ADR-005 —— 按 capability 的受限授权（MCP 表达不出的东西）

**决策。** 授权单元 = `(agentId, capabilityId, verbs)`。动词 = `read | write | execute`。默认拒绝、默认只读（裸 `"allow"` → `["read"]`）。这恰是相对 MCP 的整服务器受众 auth 的那道缺口。

**理由。** 用户的核心旋钮是"agent X 可以在作用域 Z 下调用工具 Y"。按 capability + 按动词是交付它的最小粒度。`execute` 从 `write` 中拆出来，因为启动一次编排（cc-master）与一次数据写入是不同的风险类别。

**排除。** M0 中资源实例级的作用域限定（如"只 vault A，只路径 B"）——那住在 `input` 校验 / 扩展配置里，而非授权动词集里。日后可作为一个 `constraints` 字段加入而不破坏动词模型。

## ADR-006 —— 受限令牌 = 已签名 JWT（HS256）+ 服务端吊销注册表

**决策。** 混合式：**已签名 JWT** 主体（无状态验证，自包含 `scopes`）**加上**一个服务端 `jti` 吊销注册表（可在 `exp` 之前吊销）。短默认生命期（15 分钟）；授权持久在授权存储里，令牌是廉价的、可再生的视图。

**理由。** 对一个本地单进程网关而言，纯不透明 + DB 查询会给每次 invoke 增加一次往返和一次存储读取——不必要。纯无状态 JWT 无法在过期前被吊销——对一个"立即吊销"是首要用户操作的本地 agent 网关而言不可接受。混合式同时得到无状态验证与即时吊销；注册表是一个持久到 `~/.plexus/` 的小型内存集合。

**排除。** 长命 bearer 令牌（生命期刻意设短）。非对称（RS256）签名——对单个本地签发-验证方而言是杀鸡用牛刀；用一个按安装的秘密做 HS256 更简单。只有当 MCP-服务器 façade 有朝一日签发被一个独立验证方消费的令牌时，才重新考虑 RS256。

## ADR-007（已修订）—— 授权裁决是一条可插拔的缝；v1 发布一个桩

**决策。** 授权裁决是一个**可插拔抽象**，即 `Authorizer` 接口（`types.ts` §4a）：输入 = 授权请求 + `AuthorizationContext`，输出 = `allow | deny | pending`。网关对每一个被请求的授权调用它，并据此驱动 `PUT /grants`（铸造令牌 / `grant_pending_user` / 拒绝）。**v1 发布一个简单的桩** —— `AutoApproveAuthorizer`（宽松：对条目请求的动词返回 `allow`）。`grant_pending_user` 路径 + `GET /grants/status` 轮询通道完整保留在类型界面里，因此一个更严格的策略（如一个在用户于管理客户端确认前返回 `pending` 的 `UserConfirmAuthorizer`）是一个**无线路改动的直接替换**。

**理由（按已锁定用户决策修订）。** 一个完整的"每次授权都确认"UI 并非 v1 需求；过度设计它会阻塞演示。要紧的是那条缝：权威模型必须可被替换而无需触碰协议。一个平凡的自动批准默认值对 v1 是可接受的；架构保留了日后加固的空间。这取代了此前"默认由用户确认每次授权"的立场。

**排除。** 把某一具体的授权 UX 烘焙进线路。任何策略——宽松、每次授权确认、带预批准作用域的受信 agent——都插在 `Authorizer` 之后。

## ADR-010 —— 吊销端点 + 在飞 workflow 吊销（评审 #3）

**决策。** 新增 `POST /grants/revoke`，带 `RevokeRequest`/`RevokeResponse`。两种选择器形态：按 `jti`（一个令牌）或按 `(agentId, capabilityId)`（所有携带该作用域的令牌 + 移除持久授权，这样 refresh 无法再铸造）。**Workflow 规则：** 编排器在**每次成员派发之前**重新检查发起 `jti` 的吊销状态，因此一次扇出中途的吊销会中止其余成员。

**理由。** 规范一直承诺按 jti / 按作用域吊销，审计模型里也有 `grant.revoke`/`token.revoke`，但没有端点/类型存在——一个冻结阻塞项。每成员重新检查堵住了"一次几秒长的扇出该检查哪个令牌？"的缺口。

**排除。** 吊销一个已完成的成员调用（吊销是只向前的；已完成的派发被审计，不被撤销）。

## ADR-011 —— 授权背书的令牌 refresh（评审 #4；由 15 分钟生命期所必需）

**决策。** 新增 `POST /grants/refresh`（`RefreshRequest`/`RefreshResponse`）。它从**持久授权**用**相同作用域**重新铸造一个新的 15 分钟令牌——**无 connection-key，无重新提示**——受该授权自身有效期（`grantExpiresAt`）约束。agent 呈现将过期的令牌 + 会话；网关核验会话存活 + 授权有效 + 未吊销，随后签发一个新鲜的 jti（旧 jti 被吊销）。

**理由。** 令牌生命期**锁定在 15 分钟**（ADR-006，用户确认），但旗舰 cc-master workflow 运行**超过 24 小时**。没有 refresh，它的令牌 15 分钟就死，且只能经由一次需要一个 agent 不应保留的 connection-key 的完整 handshake 来重新铸造。refresh 让令牌保持短命，同时让长任务保持存活。

**排除。** 无限的令牌寿命（refresh 被授权有效期硬性封顶）。agent 保留 connection-key。

## ADR-012 —— Workflow 传递性授权（评审 #5）

**决策。** `members` 现在是 `WorkflowMember[]`（`{id, verbs}`）；每个 id 必须是一个在场的注册表条目。授予一个 workflow 会合成一个内部**传递性作用域**（`TransitiveGrant`）——成员作用域被戳入签发的令牌（标记 `synthesizedFor`），并**在授权确认时向用户浮现**。成员派发通过同一管线做作用域检查（无静默升级）。

**理由。** 一个仅按 workflow id 限定作用域的令牌，要么让成员不受检查（静默升级，破坏 ADR-005/007），要么需要一次无类型的隐式展开。把传递性作用域做成显式 + 用户可见，端到端地保住了按 capability 的权威模型。

**排除。** 成员不是真实注册表条目的 workflow（cc-master 的 `scan()` 必须产出 workflow 及其成员——见 ADR-009 修订）。

## ADR-013 —— Workflow = 一个重入 invoke 管线的 transport（评审 #6）

**决策。** 新增一个 `WorkflowTransport`，其 `dispatch` 通过 `BridgeDeps.invokeById` / `TransportDispatchContext` 对每个成员**重入统一的 invoke 管线**。网关核心从不在 `kind:"workflow"` 上分支；编排器"只是又一个 transport"。（相对于把编排器建模为一个 first-party `CapabilitySource` 而选——transport 重入这个选项让成员流经与任何 invoke 完全相同的作用域检查 + 审计路径，这正是我们最需要的属性。）

**理由。** 草案曾逼出 `if (kind === "workflow") runOrchestrator else bridge.invoke`——正是黑盒架构所禁止的那个分支。重入让扇出统一：每个成员都是一次普通的、受作用域检查、被审计的 invoke。

**排除。** 核心里一条定制的编排器代码路径。绕过授权执行的扇出。

## ADR-014 —— Manifest 刷新 + 事件流 + 待批授权通道（评审 #9）

**决策。** 新增 `GET /manifest`（拉取一份新鲜快照，不重新 handshake）、一个 `GET /events` SSE 流（`PlexusEvent`：`manifest_changed` / `grant_resolved` / `token_revoked` / `source_status`），以及 `GET /grants/status`（轮询一个 `grant_pending_user` 裁决）。`Manifest.revision` 是一个单调计数器，agent 用它来检测陈旧。

**理由。** handshake manifest 曾是一份没有推送通道的一次性快照，因此一个 MCP `list_changed`（或 handshake 后才上线的 Obsidian）会让 agent 陈旧；而 `grant_pending_user` 曾死路一条、无解析通道。这些堵住了两个生命周期缺口——合起来是两个流程的一个阻塞项。

**排除。** 把完整重新 handshake 作为刷新视图的唯一方式。

## ADR-015 —— 封闭的 `ErrorCode` 联合类型（评审 #10）

**决策。** `ErrorResponse.code` / `InvokeResponse.error.code` 使用一个**封闭的** `ErrorCode` 联合类型（`token_expired`、`token_revoked`、`grant_required`、`grant_pending_user`、`session_expired`、`unknown_capability`、`schema_validation_failed`、`source_unavailable`、`mcp_tool_error`、`transport_error`、`host_forbidden`、`rate_limited`、`internal_error`）。冻结于 v0.1.0。

**理由。** 一个开放的 `string` 码无法被可靠地分支——agent 分不清"refresh"、"re-grant"和"放弃"。一个封闭联合让恢复确定性。MCP 带内的 `isError:true` 映射为 `ok:false` + `mcp_tool_error`，且 `content[]` 逐字保留。

**排除。** 临时的按端点码。新码需要一次契约 bump。

## ADR-016 —— Host/Origin 防御 + 已广告的端点命名空间（评审 #7、#nit）

**决策。** 每个端点都在 auth **之前**强制 `Host` == 绑定的环回权威（`127.0.0.1:<port>`）并校验 `Origin`（`HostOriginPolicy`）——标准的 MCP-本地 DNS 重绑定缓解；失败返回 `host_forbidden`。`.well-known` 只暴露摘要（ADR-008），把一个版本/清单指纹当作预会话发现的代价接受。所有端点 URL（invoke、revoke、refresh、grant-status、manifest、events）都在 `AuthAdvertisement` 里被**广告**；agent 读 URL 而非硬编码路径（`/grants/*` 命名空间约定）。

**理由。** 仅环回绑定既拦不住其他本地进程，也拦不住一个向 `/invoke` POST 的 DNS 重绑定浏览器。Host/Origin 校验是那个便宜的、标准的防御。广告 URL 移除了硬编码的 `/invoke` 假设。

**排除。** 绑定到 `0.0.0.0`；不做主机检查就信任任何 localhost 调用方。

## ADR-017 —— `/invoke` 对所有结局返回同一个结果形状（tp2，v0.1.1）

**决策。** `POST /invoke` **总是**返回一个 **`InvokeResponse` 形状的** body——成功时是 `{ id, ok, … }`，而**每一次**拒绝（包括 auth/派发前的那些：无令牌、`grant_required`、`token_revoked`/`token_expired`、`session_expired`、`unknown_capability`、`schema_validation_failed`）时是 `{ id, ok:false, error:{code,message,capabilityId?}, auditId }`。封闭的 `ErrorCode` 与按拒绝的 **HTTP 状态**（401 auth · 404 unknown · 422 schema · 403 host · 429 rate · 503 source · 200 带内派发错误 · 400 其余）不变；只有外围 body 改变。`auditId` 是被审计拒绝的事件 id（每一次管线派发前拒绝都被审计），或对一个在管线审计之前就失败的 EDGE 拒绝取空字符串哨兵 `""`。**范围：仅 `/invoke`** —— 其余每个端点保持统一的 `ErrorResponse` 信封。

**理由。** v0.1.0 在 `/invoke` 上返回两种形状：一个传输/capability 失败作为一个 HTTP 200 上的带内 `InvokeResponse{ok:false}`，但一个 auth/派发前拒绝作为 `ErrorResponse` 信封（`{error:{…}}`，4xx），没有 `id`/`ok`/`auditId`。一个把每个 `/invoke` 回复都反序列化为 `InvokeResponse` 的天真 agent 在拒绝时得到 `ok === undefined`（agent-harness 消费者，t12）。把拒绝路径塌缩成 `/invoke` 已经用于成功的同一个形状，给了 agent 在它最热的端点上一个结果契约，且无损失——HTTP 状态仍分类失败，`error.code` 仍是那个封闭联合。

**非破坏性。** 无新 `ErrorCode`；状态不变；`error` 已存在于 `InvokeResponse`，`auditId` 保持一个必需的 `string`（`""` 哨兵为 edge 拒绝保住字段的在场）。版本化 `0.1.0 → 0.1.1`。

**排除。** `/invoke` 上的第二种结果框定；客户端把一个 `ErrorResponse` 信封归一化回 `{ok,error}`（min-agent 客户端的旧 hack，现已移除）。

## ADR-018 —— 统一信任模型：命名原语、两个时钟、3 类来源（v0.1.2）

**决策。** 授权机制一直是正确的，但*不可见*且*未命名*，因此它在每个界面上读起来都不一样。v0.1.2 **命名**这些原语并把它们**浮上台面**，好让一个人类（UI）、一个 agent（协议）、一个开发者（API）读到**相同的**事实。所有改动在冻结的线路下都是加性的——新的可选字段和一个新端点；一个 `v0.1.1` 客户端忽略它们。

- **命名原语（各一个词，处处逐字使用）：** **agent**（一个授权被*限定作用域*到的自我断言标签，`agentId` = handshake 的 `client.agentId`——见下文"信任边界与 agentId"：它不是一条认证边界）、**capability**、**scope**（一条 `capability × verbs` 令牌行）、**grant**（那个常驻、经人类批准的 `(agentId, capabilityId, verbs)`）、**trust-window**（授权在重新询问前常驻多久）、**token**（授权的一个 ~15 分钟自动刷新的视图）、**provenance / source-class**、**sensitivity**。

- **两个时钟（都在 `~/.plexus/auth-config.json` 里可配置）：** **token-lifetime**（~15 分钟——一份泄露凭据的影响面；钳制到 `[1min, 60min]`，绝不按批准、绝不由 agent 选——一条安全不变量）对 **trust-window**（人类的*裁决*在 Plexus 重新询问前常驻多久）。把两者并排命名正是那个可读性收益：refresh 会重新铸造直到 trust-window 天花板而不需重新批准，而现在这个天花板被展示出来了。

- **3 类来源 + 姿态：** `first-party`（保留/进程内）、`managed`（用户经受信管理 UI **添加**的源，添加时经人类审核——**共享 first-party 的读姿态**；write/exec 仍挂起）、`extension`（由 agent 经线路注册——最严格，任何动词都挂起）。first-party + managed 的**读自动放行**；所有 **write/exec 挂起**；**extension 的读也挂起**。一个常驻、未过期的授权会短路重新询问。

- **"once" 单次使用语义：** 一个 `once` 授权以 `standing:false` 和 `expiresAt = grantedAt` 持久化，因此 refresh 无法重新铸造它，而 `hasPriorApproval` 绝**不**能对它短路。"Once"就是一次。

- **anon = 仅限会话，无常驻信任：** 绝不在一个 `anon:*` id 下持久化一个常驻（> 会话）授权（上限锁在 `once`）；把它呈现为"Anonymous（每会话重新询问）"。一个稳定的 `agentId` 才是给一个回访 agent 一个可依凭之物的东西（Plexus 记住它的常驻授权）——没有它，每个会话都重新询问。这是一个作用域限定的便利，**不是**安全边界（下一段）。

- **信任边界与 agentId（诚实的模型）。** 在 Plexus 环回、单用户的设计上，**connection-key 就是那条信任边界**。`agentId` 是一个自我断言、按设计不可伪造的标签，在 handshake 时从 `client.agentId` 逐字复制、无核验。它的唯一职责是**限定作用域**，决定哪些常驻授权适用（一个 UX 便利，好让一个回访 agent 不被重新提示）——它**不是认证，且在相互不信任的本地进程间不赋予任何隔离**。任何持有 connection-key 的进程都能以任何 `agentId` handshake 并搭乘那个 id 的常驻授权；在此模型下这是预期内的。**轮换 connection-key 是你进行大范围吊销的方式**（它使旧密钥引导的每一个会话失效）。真正的按 agent **密码学**身份（一个只有其签发主体才能声称的 agentId）明确属于 **v1 之后**。因此操作者应把一个按 agent 的常驻授权当作"任何本地密钥持有者都可使用它"，而非"只有这个 agent 可以"。

- **管理员的"授予访问"针对一个真实的 `agentId`**（退役 `plexus-admin` 作为授权*主体*）：管理员批准/授权路径持久化在意图中的真实 agent 下（选择器默认 `plexus-cli`），这样 agent 的下一次请求就会命中 `hasPriorApproval`。`plexus-admin` 只保留给管理会话自身的机械调用。（修复了那个预授权不了任何真实 agent 的"诱饵授权"。）

- **agent 的信任窗口仅供建议：** agent 路径（`PUT /grants`）上的 `GrantDecision.trustWindow` 可被授权器/人类**缩短**，绝不能超过按类别天花板去延长；管理员批准路径上它是权威的。一个 agent 永远无法自延它的常驻信任。

- **网关撰写的叙述：** 网关为每个待批 capability 撰写那句单行 `PendingNarration.summary`，好让叙述无法在 agent 之间漂移；技能**要求** agent 陈述 capability + 动词 + 信任窗口 + 可吊销性，且除非窗口确实是 `once` 否则绝不说"一次性"。

- **新端点 `GET /grants`**（会话认证，像 `/manifest`）→ `GrantsListResponse` —— agent 对用户 Grants 屏的对称视图；经 `AuthAdvertisement.grantsListUrl` 广告。管理员用 `GET /admin/api/grants`。

- **加性字段：** `CapabilityEntry` + `CapabilitySummary` 上的 `provenance` / `sensitivity` / `recommendedTrustWindow`；`GrantDecision` 上的 `trustWindow`；`GrantPendingResponse` + `GrantStatusResponse` 上的 `pendingNarration[]`；`ScopedToken` 上的 `grantExpiresAt` / `trustWindow`；`ScopedTokenClaims` 上的 `gexp`；`AuthAdvertisement` 上的 `grantsListUrl`。

**四个用户批准的默认值。**
1. **情境化的、3 类默认信任窗口：** first-party/managed 读 **7d**，write/exec **1d**；extension 读 **1d**，write/exec **once**。
2. **继续自动放行 first-party + managed 读**（低摩擦）——但它们必须带其信任窗口出现在 Grants 账本里；无一是静默的。
3. **3 类来源**（`first-party` / `managed` / `extension`）。
4. **提供 `until-revoked` 但绝不默认它；** 自定义时长封顶于 `maxTrustWindowMs` = **30 天**。

**敏感度派生**（网关计算，好让所有界面一致）：`low` = first-party/managed 上的读；`elevated` = first-party/managed 上的 write/exec，或 extension 上的读；`high` = extension 上的 write/exec，或任何带 write/exec 的 cli/local-rest transport。Workflow 上卷其成员的敏感度（取最大）。

**非破坏性。** 每一个改动都是一个新可选字段或一个新端点；没有冻结的线路类型被改变；没有新 `ErrorCode`；15 分钟令牌契约不变。版本化 `0.1.1 → 0.1.2`。

**排除。** 一个静默（未列出）的常驻授权；一个自延其信任窗口的 agent；`plexus-admin` 作为授权主体；把一个多天授权叫作"一次性"的叙述；按批准的令牌生命期。

## ADR-019 —— 登记/PAT 是 AGENT 的 handshake；connection-key 仅限管理员（v0.1.3）

**决策。** 运行时早已发布了那个两凭据 auth 模型——一个 agent 用**自己那份持久的、按 agent 独立的 PAT**（`plx_agent_…`）认证，该 PAT 从一次性**登记码**（`plx_enroll_…`）兑换一次得来；**connection-key** 是**管理/管理员**凭据，agent 永不持有它（agent-skill-compile **ADR-4** bearer PAT、**ADR-9** 登记自描述）。但那份机器可读的 Floor 自描述（`GET /.well-known/plexus`）仍在告诉一个冷启动 agent 用旧的 **connection-key-在-body** 形状去 handshake——那是**管理员**路径——而 `requestShapes` 是一个无技能的冷启动 agent 所依赖的**唯一**界面（不变量 II）。本 ADR 把自描述对齐到代码：`requestShapes.handshake` 现在通过一个新的可选 `RequestShapeHint.headers` 描述 AGENT 路径（`Authorization: Bearer <PAT>`，无 body），而 `connectionKeyDelivery` 被记录为管理员/所有者的 connection-key 交付，绝非一个 agent 的可用手段。它也重申 **ADR-5**：一个 `execute` capability **永远不能**常驻（`once` 天花板），即便在一个管理员信任窗口下也不行——不变。

**非破坏性。** 加性的（`RequestShapeHint` 上一个新可选 `headers` 字段）加上一处对一个现已失真的、面向 agent 的提示的纠正性文档/形状修复。没有冻结的线路类型被移除或改型；connection-key-在-body 的 handshake 保持为有据可查的**管理员**路径（端点代码本就同时接受二者——Bearer PAT ⇒ agent，`connectionKey` body ⇒ 管理员——这只是把**描述**对齐到那个行为）。版本化 `0.1.2 → 0.1.3`（当登记/PAT 界面发布时版本从未移动过；这次 bump 也承载那次对齐）。ADR 日志的家从 `docs/archive/protocol/DECISIONS.md` 迁至 `docs/protocol/DECISIONS.md`。

**取代。** **ADR-008** 和 **ADR-018** 中那个把 `.well-known` 呈现为把 connection-key-在-body 的 handshake 当作 agent 路径的两层披露之面向 agent 的解读——那个提示现在仅限管理员。ADR-008/ADR-018 中其余一切照旧。

**排除。** 把 connection-key（或任何仅限管理员的凭据）广告为一个 agent handshake 的可用手段；把一个无技能的冷启动 agent 引上管理员路径。

## ADR-009（修订）—— 一等的、被审计的 install + 脱敏契约

**对 ADR-009 的修订。**（a）源 install 是一个**一等、经用户确认、被审计**的操作（`CapabilitySource.install()`，`source.install` 审计事件），而非一个核心从不读的 `extras` blob（评审 #次要，Flow A）；cc-master 的 `scan()` 产出 workflow 及其成员。（b）审计**脱敏是一个契约**（`AuditRedactionPolicy`）：那个单一写入者在持久化前从 `detail` 中擦掉原始调用输入、令牌/connection-key、以及已解析的秘密材料（评审 #次要）。（c）本地服务凭据（如 Obsidian Local REST API 的 bearer 密钥）经 `PlatformServices.resolveSecret` 从 `~/.plexus/secrets/` 解析，按名引用——绝不携带在一个条目、manifest、`.well-known` 或审计里。

## ADR-008 —— `.well-known` 摘要 对 handshake manifest（两层披露）

**决策。** `.well-known/plexus` 未认证，只返回摘要（id/kind/label/一行/grants/transport）。完整的 `describe`、`io` schema、技能主体、以及 `mcp.raw` 只在 handshake 的 `Manifest` 里披露（在 connection-key 之后）。

**理由。** 这是 MCP 缺失的那个预会话广告（启动会的存在理由），但把完整 schema + 使用技能 + MCP 内部暴露给任何未认证的 localhost 调用方是无谓的泄漏。摘要足以决定"我该不该 handshake"；细节要花一次 handshake。

**排除。** agent 无会话就直接从 `.well-known` 调用。日后可在一个用户开关后加一个"公开完整 manifest"模式。

## ADR-009 —— 状态布局与单一写入路径

**决策。** 所有状态在 `~/.plexus/` 之下（授权存储、审计 JSONL、源注册表/capabilities、connection-key、令牌吊销集）。授权 + 审计的单一写入路径（一个写入者），原子写入。用户 cwd 里无指针文件；从主目录注册表反查。镜像 claude-plugin 的本地优先作用域限定。

**理由。** 防止 schema 漂移 / 并发损坏；把合规叙事保持干净（网关知道的一切都住在一个用户拥有、可检视/删除的目录里）。

**排除。** 按项目的本地配置文件；多写入者并发（M0 中一个单一网关进程是唯一写入者）。

## 已在冻结中解决（曾是待定分叉；现已决定）

先前草案所列的方向性分叉现已决定并折叠进上面的 ADR——它们不再悬而未决：

- **授权权威流** → ADR-007 已修订：可插拔的 `Authorizer` 缝，v1 桩 = 自动批准。（已锁定用户决策。）
- **令牌生命期** → ADR-006 + **ADR-011**：**15 分钟，锁定**，由授权背书的 refresh 端点使之可行。（已锁定用户决策。）
- **`execute` 动词** → 保留（ADR-005）。三个动词。
- **`.well-known` 披露层级** → 保持仅摘要（ADR-008），指纹暴露在 ADR-016 里被明确接受。
- **MCP 资源/提示投影** → 资源 → 只读 capability 条目，提示 → skill/capability 种子；现在经 ADR 的 `readResource`/`getPrompt` transport 分支（评审 #1）和逐字 `McpResult` 槽（评审 #2）完全可建。
- **connection-key 交付** → v1 仅用户粘贴（回调保留）。

## 待定 / 推迟到 v1 之后（明确不在冻结的 M0 契约内）

真正推迟的；无一阻塞 v0.1.0 冻结。每一项都按意图属于 v1 之后。

1. **MCP-服务器 façade 输出适配器。** 已为其设计（`mcp.raw` 逐字槽、`McpResult` 逐字槽、向下投影规则）但在 M0 中**未建**。v1 之后。

2. **资源实例级授权约束**（如"只 vault A / 路径 B"）。动词模型保留；一个 `constraints` 字段日后可加而不破坏线路（ADR-005）。v1 之后。

3. **localhost OAuth 式 connection-key 回调。** 比用户粘贴更顺滑的 UX，但增加一个浏览器重定向界面。`connectionKeyDelivery:"callback"` 在类型界面里被保留；v1 未实现。

4. **多平台（Windows/Linux）平台缝实现。** 接口从第一天起就是多平台的（`PlatformServices`）；v1 只发布 macOS 实现。

5. **运行时可插拔的第三方 transport。** M0 中 transport 是编译期注册的（ADR-003）。一个运行时 transport 注册表属于 v1 之后。

6. **命名。** "Plexus"与一个已有仓库撞名；在 M5 开源发布前解决。无协议影响。
