---
title: 安全模型
description: Plexus 信任与授权模型的权威说明：管理员与代理使用两类凭据，每个代理各有自己的 PAT；持续授权受能力敏感度限制，execute 默认须逐次批准。每项说明均附代码出处。
---

# 安全与信任模型

::: tip 读者
本文写给正在决定是否把实际资源交给 Plexus、需要**确切了解**每种凭据能做什么、泄露后有何代价，以及授权如何完成的人。每项关键说明都以 `file:line` 标出已提交代码中的出处，供你自行核对。权威设计记录见 [`agent-skill-compile-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/agent-skill-compile-domain-model.md)（Inv III = 每个代理独立的 PAT / connection-key 仅供管理员使用；Inv IV = 经主节点访问的等价性；Inv VI = 模板化鉴权核心）。本文描述的是**代码实际强制执行的规则**。下文路径除非另有说明，均相对于 `packages/runtime/src/`。
:::

## 五句话说明白信任模型

1. 管理员信任边界只有一个：`connection-key` 及其认证所覆盖的整个管理面。代理**绝不能持有这把密钥**；在代理只能通过 HTTP 与网关交互的前提下，它无法访问管理面。
2. 每个 agent 用**自己的持久 PAT** 认证，PAT 由一次性 enroll 码兑换一次得来。因此一份 agent 凭据泄露，爆炸半径恰好是**该 agent 预先获授的 capability**，且可以单独撤销。
3. **常驻**授权可反复使用，但须由能力自身的**敏感度**允许；运行代码（`execute`）默认逐次批准（`once`），只有所有者在连接时为这一智能体与能力组合明确开启常驻授权，才可常驻复用；该选项默认关闭，须经两次确认，智能体不能自行开启。
4. PAT 证明真实的 `agentId`，客户端无法自称是另一个 agent；管理员路径可以点名 `agentId`，只因为持有 connection-key 本身*就是*管理员权威。
5. 所有凭据都**静态哈希、失败即关闭、单一用途**；agent 能看到的界面（"Floor"）只披露受认可的所有者批准路径，绝不暗示磁盘上有密钥、或 token 可以伪造。

## 1. 凭据分类与信任边界

Plexus 有两条信任边界，两侧各有一小组凭据。最重要的一条规则：**connection-key 仅限管理员；agent 用按 agent 独立的 PAT 认证。**

![两个永不交叉的凭据 — admin connection-key 与各 agent 自己的 PAT](/diagrams/two-trust-boundaries.png)

| 凭据 | 谁持有 | 授权范围 | 生命期 | 静态存储 | 泄露后的爆炸半径 |
|---|---|---|---|---|---|
| **管理员 connection-key** | 本地的人 / 桌面 app / `plexus` CLI——**带外**获得，绝不走 HTTP | 完整管理平面：`/admin/api/*`（连接/撤销 agent、授权、暴露、源、mesh join token），以及 `handshake` 的管理员路径 | 长生命期；可轮换（轮换会使旧密钥引导的会话失效） | 经 `state.connectionKey.verify()` 验证；没有任何路由返回它 | **全部。** 对本网关的完整管理员权威。要保护的就是它。 |
| **管理密钥** | 同上 | 同上——"管理密钥"和"connection-key"是**同一个秘密**，在 `/admin/api/*` 及特权 agent 平面操作上以 `X-Plexus-Connection-Key` 呈现 | 同 | 同 | 同 connection-key。 |
| **按 agent 独立的 enroll 码** | 特定 agent，带外交付（随安装命令下发） | **一次性**兑换成该 agent 的 PAT | **15 分钟**，单次使用（`DEFAULT_CODE_TTL_MS`） | 仅存 sha256 哈希（`codeHash`） | 只波及该 agent 的*引导*，且仅限 15 分钟内、未兑换时。兑换之后即失去效力。 |
| **按 agent 独立的 PAT**（`plx_agent_…`） | 特定 agent，按它自己的方式存放（如 `.env`） | 在 `handshake` 处**以该 agentId 的身份**开启会话；此后可用该 agent 预先获授的（常驻）capability | 持久，直到撤销/重签发（无 TTL） | 仅存 sha256 哈希（`patHash`） | **该 agent 预先获授的 capability**，可单独撤销。够不到管理平面。 |
| **限定范围令牌**（签名 JWT，`tokenScheme: "plexus-scoped-jwt"`） | 获得授权的智能体 | 仅可调用 `scopes` 中的能力和操作，且会话须仍有效、jti 未被撤销 | 短期：默认 15 分钟，可在 `[1m, 60m]` 内配置（`config.ts:36-40`） | 无状态签名 JWT；跟踪 jti 以支持撤销 | 仅能访问指定能力，最长 60 分钟，可按 jti 撤销。 |
| **mesh join token** | 远端 proxy 操作者，带外 | 把**一个** proxy workload enroll 进 mesh（固定登记它的 Ed25519 密钥） | 可选 TTL，单次使用 | 仅存 sha256 哈希 | 准入一个 workload——但按 §7，加入所得的 capability 可见性/访问权为**零**，直到所有者主动暴露 + 授权。 |

### 为什么 connection-key 仅限管理员（可自行核验）

- **没有路由返回它，也没有 payload 暗示它存在。** `GET /admin/api/connection-key` 是刻意**不存在**的（`admin.ts:409-416`）。理由写在代码里：不受信任的 agent 只会说 HTTP，任何返回或暗示该密钥的 HTTP 路由都等于给 agent 一条升级到管理权限的路。
- **整个管理面统一要求密钥验证。** `admin.use("/api/*", requireManagementKey)`（`admin.ts:407`）要求**所有** `/admin/api/*` 数据路由的请求，无论读写，都携带通过验证的 `X-Plexus-Connection-Key` 请求头（`requireManagementKey`，`admin.ts:383-399`）。仅靠回环地址的 Host/Origin 检查*并不足够*：任何本地进程都能发送 `Host: 127.0.0.1`，网关也可能绑定到局域网接口。
- **代理提交 PAT，管理员提交 connection-key，位置也不同。** 在 `handshake` 中，代理在请求头中提交 `Bearer plx_agent_…`，管理员则在 JSON **请求体**中提交 `{ "connectionKey": … }`（`handlers.ts:184-248`）。系统根据请求中是否存在相应凭据选择认证路径；选定后不会再改用另一条路径尝试认证。

## 2. 授权流，端到端

![五步 agent 循环 — discover、enroll、handshake、grant、invoke](/diagrams/protocol-loop.png)

```
                         ┌─────────────────────────────────────────────────────────────┐
                         │  ADMIN (config-time, holds the connection-key, out-of-band)  │
                         │  POST /admin/api/agents/connect                              │
                         │   ├─ mint one-time enrollment code (plx_enroll_…, 15 min)    │
                         │   └─ declare selected cap-set as the authorized subset:      │
                         │      READ caps → STANDING grants (that IS the human approval)│
                         │      write/execute → per-use unless opted standing per cap   │
                         └───────────────┬──────────────────────────┬──────────────────┘
                                         │ install command          │ standing read grants
                                         │ carries the code          │ persisted for agentId
                                         ▼                          ▼
   AGENT                                                        GATEWAY (primary authority)
   ─────                                                        ─────────────────────────────
   (0) DISCOVER   GET /.well-known/plexus            ──►  unauth; returns gateway identity
                  (no credential)                          + auth advertisement + enrollment
                                                           self-description + capabilitiesVia
                                                           pointer               (well-known.ts)

   (1) ENROLL     POST /agents/enroll { code }       ──►  redeemEnrollmentCode(code):
                                                           shape→known→PENDING→fresh→mint PAT→
                                                           fsync→CONSUME code (single-use)
                  ◄── { pat: plx_agent_…, agentId }        (agent-enrollment.ts:391)
                  store PAT (own paradigm)                 PAT returned in plaintext ONCE

   (2) HANDSHAKE  POST /link/handshake               ──►  verifyPat(pat) → REAL agentId
                  Authorization: Bearer plx_agent_…        session bound to THAT id (not client-
                  ◄── { sessionId, manifest, … }           supplied)      (handlers.ts:195-231)

   (3) GRANT      PUT /grants { grants:{ id:"allow"}} ──►  per cap: in the agent's authorized
                  X-Plexus-Session: <sess>                 subset? ── no ─► DENIED (audited)
                                                           hasPriorApproval? (standing +
                                                           unexpired) ─ yes ─► short-circuit → token
                                                                              ─ no ──► authorizer:
                                                             low-risk 1P read → allow (auto)
                                                             write/exec / extension → PENDING
                  ◄── ScopedToken  OR  grant_pending_user   (grant-service.ts:542-733)

   (3b) APPROVE   (owner, in console)  POST /admin/api/pending/:id { action:"approve", trustWindow }
                                                       ──►  persist standing grant + mint token
                  agent polls GET /grants/status?pendingId=…  (originator- or mgmt-key-gated)
                  ◄── { state:"approved", token }        (handlers.ts:417-444)

   (4) INVOKE     POST /invoke { id, input }          ──►  verifyToken → jti/session liveness →
                  Authorization: Bearer <scoped-jwt>       exposure gate → constraint check →
                  ◄── { id, ok:true, output }              dispatch      (handlers.ts:561-626)
```

**每一步检查什么：**

- **（0）发现**——不做认证检查。`.well-known` 按设计公开，无需认证；它提供网关身份、认证与生命周期端点的 URL、注册机制的自述，以及 `capabilitiesVia` 指针：完成注册和握手后，即可获取所有者为你授权的能力。能力发现只在握手后进行，manifest 的范围限于所有者明确声明的授权子集，或所有者创建且仍有效的常驻授权所涵盖的能力，从而阻止身份确认前的枚举。它绝不泄露 connection-key 或任何秘密（`buildPublicWellKnown`，`well-known.ts:168-177`）。
- **（1）注册**——这里**注册码本身就是凭据**（`handlers.ts:279-324`），不接受 connection-key。请求体格式错误时返回 400；注册码无效、已使用或已过期时返回 401，并附带类型明确的原因；持久化写入失败时返回 500，注册码仍保留为未使用状态，可重试兑换。这些失败都会拒绝请求。兑换过程按顺序执行五项检查，全部通过才生成 PAT（`redeemEnrollmentCode`，`agent-enrollment.ts:391`）。
- **（2）握手**——请求携带 `Bearer` 令牌，就按 PAT 认证处理，且**必须验证通过**。若令牌是伪造的、已撤销、已过期，或并非 PAT，认证均失败：返回 401，不创建会话，**也不会改用 connection-key 认证**。会话绑定的是 PAT 验证所得的 `agentId`；客户端提交的任何 `client.agentId` 都会被替换为这个值（`handlers.ts:197-215`，`sessions.ts:74-93`）。
- **（3）授权**——见 §3。对权限受限的代理，请求的能力若**不在所有者授权的子集中，就直接拒绝并记录审计，不进入待批准状态**；但该能力若已有所有者签发且仍有效的持续授权，则不受此限。**权威管理员路径也不受这一限制**，它正是在连接时定义该子集的流程（`grant-service.ts:613-646`）。在子集内，已有授权若属于持续授权且尚未过期，就沿用这份批准，无须再调用授权器；否则由 `UserConfirmAuthorizer` 决定自动允许还是等待用户批准（`authorizer.ts:218-280`）。未知的能力 ID 会在调用授权服务前以 400 拒绝，不会静默跳过，也不会生成权限范围为空的令牌（`handlers.ts:380-387`）。
- **(4) Invoke** —— token 签名、jti 撤销、会话存活在管线内全部强制执行，拒绝会被**审计**而非静默丢弃（`handlers.ts:585-626`）。顶层被禁用（"未暴露"）的 capability，即便持有效 token 也会被拒。

## 3. 常驻授权、信任窗口与敏感度

**持续授权**是一条持久记录，让代理后续在授权范围内的请求沿用已有的人工批准。能否使用持续授权，取决于**能力敏感度**；敏感度由 `provenance × verb` 决定，**不取决于**能力在本地还是远程（ADR-5 / Inv IV）。

### 敏感度 → 信任窗口

`recommendedTrustWindowFor(provenance, verbs, table)`（`capability-registry.ts:163-173`）的映射：

- **`execute`（任何来源）→ `once`。** 只有这个动作的敏感度默认逐次批准。它以**动词**为键，动词在 mesh 挂载后不会变，因此 mesh 的 `execute` cap 和本地的 `execute` cap 同样得到 `once`——没有任何东西仅仅因为远端就得到 `once`（`capability-registry.ts:168-169`）。
- **`read` / `write` → 可常驻的按类别默认值**，取自 `DEFAULT_TRUST_WINDOWS`（`config.ts:67-74`）：

  | 类别 | read | write |
  |---|---|---|
  | first-party | 7d | 1d |
  | managed | 7d | 1d |
  | extension | 1d | 1d |

  注意 `extension:write` 是 `1d`（真实的常驻窗口），**不是** `once`。早期"mesh/extension cap 硬编码为 `once`"的行为把*远端*和*仅限逐次*混为一谈，已被移除（`config.ts:56-66`）。

### `execute → once` 的默认上限（请核验） {#execute-→-once-的默认天花板-可自行核验}

`chooseTrustWindow`（`grant-service.ts:461-506`）统一决定实际采用的信任期限，以下两处检查落实单次授权的限制：

```ts
// grant-service.ts (chooseTrustWindow)
if (this.isAnon(opts.agentId)) return { kind: "once" };     // ~476  anon:* capped
if (def.kind === "once") {                                  // ~484  execute: per-use DEFAULT
  if (!optedStanding) return { kind: "once" };              //       no owner opt-in → hard floor
  // opted in: honor the admin window; absent → until-revoked (or 7d when disallowed)
  …
}
```

`def.kind === "once"` 分支规定：能力敏感度给出的默认值若是 `once`（也就是 `execute`），就返回 `once`，**无论请求什么期限，也无论是否由管理员决定期限**。只有所有者在连接时为**这一特定的（代理，能力）组合**启用持续执行授权，才有例外（ADR-023：默认关闭、须两次确认、可独立撤销）。`agentSubsets.isStanding` 读取这一选项：它是 `core/admin.ts` 中 `POST /admin/api/agents/connect` 的逐能力 `standing` 字段，只能由所有者的连接流程持久化；旧键 `standingExecute` 仍可作为兼容别名，代理不能自行设置。启用后，执行授权采用管理员指定的期限；未指定则为 `until-revoked`，若策略不允许 `until-revoked`，就限制为 `7d`。`read`／`write` 的默认值都不是 `once`，不会进入这个分支，合法的管理员期限会被保留。限制对管理员决定期限和代理建议期限这**两条路径都生效**，所有令牌签发处都经由 `chooseTrustWindow`（`grant-service.ts:666, 1119, 1476`）。

### 其他常驻授权规则

- **扩展能力首次授权须等待批准，后续请求可沿用批准。** `hasPriorApproval` **仅对尚未过期的持续授权**返回 true（`grant-service.ts:394-402`，`isStandingAndUnexpired`）；`once` 或已过期的授权都不能省去审批。因此，写入或扩展能力的首次请求须等待所有者批准，后续在授权范围内且满足上述条件的请求，无需再次审批。
- **`anon:*` → `once`。** 没有已核验 agentId 的会话（`anon:<sessionId>`）绝不会获得持久的常驻授权——`chooseTrustWindow`（`grant-service.ts:~476`）和授权器的窗口选择（`authorizer.ts:213-215`）都把它锁在 `once`。
- **agent 窗口是建议，管理员窗口是权威。** agent 可以在 `PUT /grants` 上提议窗口，但只能**缩短**，不能越过按类别的天花板去延长（`shorterWindow`，`grant-service.ts:88-90`，应用于 `:505`）。管理员/人类的批准选择是权威的（仍受未开启时的 `execute→once` 与 `until-revoked` 策略钳制）。
- **约束只能收紧。** 有约束的持续授权允许未指定约束、或约束深度相等的请求沿用已有批准；约束更宽或不同的请求不能通过这条途径免去审批。签发的令牌始终携带**持续授权中的约束**，不会改用更宽的约束（`effectiveConstraint`，`grant-service.ts:428-434`）。

## 4. 身份验证与防冒用 {#_4-身份与防伪}

`feat/agent-skill-compile` 之前的弱点是自我断言的 `agentId`：客户端可以声称自己*是*任何 agent。PAT 堵住了这个口子。

- **PAT 绑定真实 agentId。** 在 `handshake` 处，`Bearer` token 经 enroll 账本解析：`verifyPat(pat)` 返回 `patHash` 匹配的那条**活跃**记录的 `agentId`，否则返回 `null`（`verifyPat`，`agent-enrollment.ts:438`）。会话随即绑定到这个 id，客户端提供的 `agentId` 被核验值覆盖（`handlers.ts:214-215`）。
- **会话存储信任显式传入的身份参数，不信任客户端自报的身份。** `open(bootstrapKey, client, agentId)` 收到显式传入、已经验证的 `agentId` 时，会用它覆盖任何 `client.agentId` 值。自由填写的 `client.agentId` 只作审计元数据，**绝不能单独作为公共接口调用者的可信身份依据**（`sessions.ts:33-46, 74-93`）。
- **偷到 agentId 字符串一无所获。** 防重放/防伪来自 PAT 校验器（静态哈希、按 agent、可撤销）——不带 PAT 点名一个 agent，得到的只有 401，没有会话（`handlers.ts:197-209`）。
- **管理员路径为什么可以点名 agentId。** connection-key 的 body 路径*可以*合法点名它代表行动的 `agentId`（控制台的"连接一个 agent"正是这样做的）。这不是伪冒：持有 connection-key **就是**管理员权威，而 agent 没有 connection-key，够不到这条路径（`handlers.ts:174-182`，`admin.ts:668`）。

## 5. 撤销与爆炸半径

撤销一个代理，就是**立即终止该代理的全部访问权限，其他代理不受影响。** 管理路由 `POST /admin/api/agents/revoke`（`admin.ts:838`）只针对该代理执行以下三项操作：

1. **enroll / PAT** —— `agentEnrollment.revoke(agentId)` 把记录翻成 `revoked`，并把它的 `patHash` 从活跃索引剔除；PAT 立即失效，之后用它 handshake 一律失败即关闭（`agent-enrollment.ts:457`）。
2. **活跃会话** —— `sessions.invalidateByAgentId(agentId)` 使绑定到该 agentId 的所有活跃会话失效并返回它们的 jti，这些 jti 随即被撤销。撤销因此**立即**生效，而不是延迟约一个会话生命期；且是按*身份*触达会话——管理员知道 agentId，不必知道原始 PAT（`sessions.ts:126-139`，`admin.ts:871-877`）。
3. **持续授权与有效令牌**——`grants.revokeAllForAgent(agentId)` 移除该代理的持久授权，阻止刷新时重新签发令牌，并**按代理与能力的组合记录这次撤销**。这样，仍在运行的代理若不带约束重新请求，也须取得人工确认，低风险读取不会悄悄恢复自动放行。随后撤销其余仍在跟踪的 jtis（`revokeAllForAgent`，`grant-service.ts:1396`）。

**按 agent 隔离。** 每一步都以 `agentId` 为键；第二个 agent 的 enroll、会话、授权分毫不动。这正是按 agent 独立 PAT 的具体回报：撤销的作用域就是一个 agent，不像共享凭据，一轮换就切断所有人。

**撤销标记。** 刚被撤销的 `(agentId, cap)` 组合，即使对应通常会自动放行的低风险读取，也会**挂起，等待人工批准**（`authorizer.ts:266-271`，`ctx.revokedTombstone`）；新一次人工批准会清除这条标记。撤销后，访问就会停止，不能靠重新请求自行恢复。

**其他撤销方式：** 连接密钥**轮换**会使旧密钥建立的会话失效（`sessions.invalidateByKey`，`sessions.ts:115-124`）。通过 PAT 建立的代理会话不依赖连接密钥，因此不受密钥轮换影响，但仍会到期，也可被撤销。代理可出示并交还**自己的**令牌（`revoke` 路径 b，`handlers.ts:512-533`）；按 jti 撤销他人的令牌，或按 bundle 撤销，都需要管理密钥（`handlers.ts:536-539`）。

**撤销会删除授权记录，审计日志保留授权历史。** 删除持久授权后，刷新便无法重新签发令牌；*可回溯*的授权记录因此保存在审计日志中，而非授权存储中。每条授权生命周期审计事件都带有成员的 `bundleId`，这个标识在删除授权记录前写入。记录删除后，在审计保留期内仍可查到任务包的完整历史：pend → allow → re-mint → revoke。这一保证，以及授权模型为任务级和企业用途保留的其他扩展接口，均由 [授权可扩展性](/zh/architecture/extensibility)（ADR-020）规定。

### 有时候，爆炸半径是配置时的选择，不是运行时的

`browser-control` 最能说明这一点。三种模式提供**相同的能力**，但所有者选择让 Plexus 用空配置文件启动浏览器，还是使用自己已经登录的浏览器，会在请求任何授权之前决定影响范围。Chrome 自身的权限对话框无法把范围缩小到站点：它授权的是**整个浏览器**，不是一组站点。因此，这里的域名限制会在每次操作前，针对实际目标 URL 重新检查；所有者未指定任何域名时，一律拒绝操作。参见 [暴露一个 source](/zh/guide/first-party-sources#browser-control)。


## 6. 自集成技能的编译模型安全 {#_6-编译模型安全-会自我集成的技能}

编译模型把资源作为原生制品交付给 agent，v1 中采用 Claude Code 插件。Inv VI 规定了核心安全要求：**任何生成制品的 auth/invoke 核心都必须由确定性模板生成，并可由 Floor 验证，绝不能由 LLM 编写**；**分发的制品中不得内置长期有效的秘密凭据**。

- **不内置秘密；一次性 enroll 码随安装下发。** 分发产物不含持久 PAT，也不含管理员密钥。enroll **码**（短命、单次使用）可以随安装*命令*下发，兑换成 agent 自己存放的 PAT——PAT 在兑换时返回恰好一次，绝不持久化进已发布文件（`well-known.ts:119-129` 描述了"兑换→存放"契约；`agent-enrollment.ts:122-128`）。
- **以加固后的 `.well-known` 为核验依据。** 构建时验证器（`integration/verify-plugin.ts`）将渲染后的插件与 Floor 对照，进行以下五项独立检查，并返回结构化的通过或失败结果：
  1. **核准的 auth 核心**——`bin/plexus` 必须与仓库中已提交的核准引擎（`tools/plexus-cli/plexus`）逐字节一致，以 sha-256 校验；制品中的这部分代码不得经人工或 LLM 改动。
  2. **不内置秘密** —— 任何分发文件都不含 `plx_agent_…` PAT、写死的 `plx_enroll_…` 码，或调用方提供的持久凭据（包括管理员 connection-key，可作为 `forbiddenSecrets` 传入检查）。
  3. **只引用目录及指定授权范围内的能力**——技能引用的每项能力都必须出现在 Floor 提供的能力目录中；若还提供了插件编译所用的 cap-set，每项能力也必须属于该集合。技能不能引用 Floor 未列出的能力。
  4. **受认可的流程** —— plugin *指示*的 enroll/handshake/invoke 必须与 Floor 的 `auth.enrollment` / `requestShapes` 相符；任何指令文件都不得即兴发挥出一条 auth 路径（读磁盘上的管理员密钥、伪造 token）。
  5. **正文完整性**——手写的技能正文通过 `SKILL_BODY_SHA256_PIN` 固定哈希。检查分两步：源正文的哈希必须与固定值一致，渲染后的 `SKILL.md` 必须逐字包含这份正文。因此，指导使用的说明文字只要有改动，就必须重新审阅并重新固定哈希，才能发布。
- **过时不影响授权安全（Inv V）。** 技能根据 Floor 的信息生成，网关则会**实时**执行授权检查。过时或生成有误的技能都无法超出 Floor 的授权范围；最坏只是技能内容有误，例如引用了已撤销的能力，invoke 就会在网关失败。自动更新用于保持内容及时、改善使用体验，并非安全机制；**v1-partial：** 自动更新推迟到 v2。

## 7. mesh 信任

Mesh 访问遵循**经 primary 统一授权**的原则（Inv IV / ADR-5）。从 mesh 节点路由过来的能力与本地能力**按完全相同的规则授权**，使用同一个 PAT、同一个 authorizer，遵循相同的 trust-windows 规则。来源只是路由细节，不进入 agent 的授权路径。

两道 mesh 专属防御兜底：

- **不采信远端自行声明的信任信息。** 挂载远端 workload 的能力时，primary 会**移除** proxy 声明的 `provenance`、`sensitivity`、`recommendedTrustWindow` 和 `health`，再在本地**重新推导**这些字段。挂载能力的来源会被判为最严格的 `extension` 类别，因此挂载的远端读取会**进入待批准状态**，不会自动放行。恶意 proxy 即使声称 `provenance:"first-party"`，也无法欺骗 authorizer（`capability-registry.ts:956-973`）。
- **隧道两端使用固定的 Ed25519 公钥双向认证，失败即断开。** proxy↔primary 与 agent↔primary 是两条独立的认证边界。加入时，join token（即 nonce）只能使用一次，存储时只保留 sha256 哈希。它用于准入一个 workload，并**固定该 proxy 的 Ed25519 公钥**（`mesh/enrollment.ts` 文件头及 `admit`）。之后每个 socket 都要进行双向质询：primary 用已固定的公钥验证 proxy，proxy 用固定在 `upstream.primaryPubKey` 中的公钥验证 primary。此项配置必填，不允许仅靠 TOFU 建立信任。未注册或未通过认证的 socket，会在传输任何数据帧之前断开（`mesh/handshake.ts:399-454`）。
- **传输加密策略。** `requireEncryption`（`PLEXUS_MESH_REQUIRE_ENCRYPTION`）让 primary 以类型化的 `encryption_required` 原因拒绝明文 `ws` 的 proxy 隧道，只接受 `wss`（`mesh/handshake.ts:399-403`）。身份 ⟂ 加密：它门控的是*信道*，不是 Ed25519 身份——已固定的有效密钥走明文 ws 照样被拒。启用了它却没有 TLS 材料，启动时快速失败（`config.ts:645-650`）。

完整的 mesh 开发者模型见[联邦 mesh](/zh/architecture/mesh)。

## 8. 错误措辞也是安全属性

一次盲测发现，认证报错含糊不清，连谨慎的 agent 也会*想去*“从磁盘上找签名密钥，自己签发 token”。已提交代码中的错误响应因此把**说清楚规定的授权流程，让调用方知道该怎样申请授权**当作一项安全控制：

- 带活跃会话但无授权的 `/invoke` 返回**结构化的** `approval_required`，附 `pendingId` + `approvalUrl` + `grantStatusUrl`，并明说*"所有者必须在 Plexus 控制台里批准此授权；agent 无法铸造自己的 token"*（`handlers.ts:692-712`）。
- 没有会话时，`/invoke` 返回 `grant_required`，提示调用方先完成 handshake，再调用 `PUT /grants`，并明确说明：低风险的第一方读取会自动获批，**“agent 不能自行签发 token”**（`handlers.ts:634-652`）。
- `.well-known` 公布**授权申请**入口（`grantRequestUrl` + 请求方法）及 enrollment 兑换步骤，给出的后续操作只指向经过审计、由所有者批准的流程（`well-known.ts:60-129`）。任何响应、报错或操作说明，都不得暗示磁盘上有可用的密钥，或 token 可以伪造。
- `GET /grants/status` 只允许创建该待审批请求的会话，或通过管理密钥认证的调用方，领取已签发的 token。仅持有泄露的 `pendingId` 会收到 403，拿不到 token（`handlers.ts:417-444`）。

原则是：**只让调用方找到获准的路径，错误消息绝不能引导调用方伪造凭证或读取密钥文件。**

## 9. 威胁模型 —— 范围内、范围外与红队结果

### 范围内（代码防御这些）

- 仅限网络/HTTP 的对手（agent，或启用 LAN 绑定后的 LAN 对端）试图够到管理平面：被所有 `/admin/api/*` 上的 connection-key 门与"HTTP 上不给密钥"规则挡住（`admin.ts:383-416`）。
- agent 试图自称另一个 agent：被 PAT→agentId 绑定挡住（§4）。
- agent 试图不经人类自授 write/execute，或给 extension cap 授权：被默认的 `UserConfirmAuthorizer` 挡住（`authorizer.ts:180-280`）。
- agent 试图**靠自己**让运行代码（`execute`）免摩擦/常驻：结构上不可能——只有拥有者能在连接时为特定 (agent, capability) 开启常驻 execute（`chooseTrustWindow`，`grant-service.ts:461-506`）。
- agent 凭据泄露：限定在该 agent 预先获授的 cap 内，可单独撤销（§5）。
- 恶意 mesh proxy 断言有利的信任姿态，或明文/MITM 隧道：被本地重新派生、密钥固定的双向 auth 与加密策略挡住（§7）。
- 静态秘密：enroll 码、PAT、mesh join token 在磁盘上只存 sha256 哈希（`0600` 账本文件）；PAT/码的明文只返回一次，永不可恢复（`agent-enrollment.ts:36-39, 225-236`）。

### 范围外（有据可查的假设——依赖 OS/部署，而非 Plexus 代码）

::: warning 同 UID 主机隔离
按 agent 分配 PAT 的隔离机制有一个前提：agent 进程**无法读取管理员的 connection-key 文件。** 在主机上与所有者使用同一 UID 的 agent 可以执行 `cat ~/.plexus/connection-key`，取得完整的管理员权限。对于能读取所有者主目录的进程，Plexus 的进程内边界无力阻止。缓解办法是**操作系统沙箱／容器隔离方案**（mesh/appliance 开发项目；参见 [`capability-appliance.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/capability-appliance.md)、[`linux-confinement.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/linux-confinement.md)），把 agent 限制在无法读取密钥文件的环境中。在这些措施部署到位之前，只要 agent 与 `~/.plexus` 的所有者以同一用户身份运行，就应视为**完全信任该 agent 拥有管理员权限。**
:::

- 主机失陷或攻击者取得 root 权限、运行中进程的内存抓取，以及侧信道攻击，均不在应用层的防护范围内。
- **v1 部分加固，明确推迟：**
  - **密钥对 PAT。** v1 使用 **bearer** PAT，是为了符合运维人员熟悉的 `.env` 凭据使用方式，并保持方案简单（ADR-4）。密钥对 PAT 要求提供私钥持有证明（proof-of-possession）：存储中的凭据即使泄露，没有私钥也无法使用。文档将其列为 **v2** 对 bearer PAT 的加固计划。
  - **技能自动更新**（不变量 V）——推迟；安全不依赖它（§6）。
  - **LLM 撰写的教学外壳** —— 即便到 v2，LLM 也只能撰写任务说明/示例，绝不撰写 auth/invoke 机制（不变量 VI）。

### 红队结果

针对已提交的认证核心流程及管理／撤销路径，共做了两次红队对抗审查。报告结论是：**修复后的认证核心流程没有遗留问题。** 唯一确认的 **HIGH** 问题是：`execute` 能力曾可按管理员提供的窗口获得持续授权，全程没有所有者作出批准决定。这个问题**已修复**：在 `chooseTrustWindow` 中通过 `def.kind === "once"` 将窗口限制为单次（`grant-service.ts:484`），最终决定授权窗口的路径和仅提供建议的路径都适用。ADR-023 保留这一默认限制，只允许一个例外：所有者在连接时，针对特定（agent，capability）组合明确选择允许持续执行授权，并经过两次确认。

## 10. 开发者绝对不能做的事

- **不要把 connection-key（或任何持久秘密）写死进任何面向 agent 的东西**——技能、plugin、agent 能读的配置、HTTP 响应，一概不行。connection-key 仅限管理员；返回它的路由刻意不存在。
- **不要让技能的 auth/invoke 内核出自 LLM 或手工编辑。** 它必须是逐字节相同的受认可引擎，对着 Floor 这份基准核验（不变量 VI，`verify-plugin.ts`）。让 LLM 撰写 auth 路径，可能发布出一份越权教程。
- **不要分发持久 PAT。** 发布一次性码（短命、单次使用），让 agent 自己兑换并存放 PAT。
- **不要把 loopback Host/Origin 检查当作管理操作的身份认证。** 它只能确认请求地址（authority）在允许范围内，不能证明调用方是可信的管理客户端。管理路由必须要求经过验证的 connection-key。
- **不得通过 agent 侧接口提供 agent 可调用的管理操作。** agent 侧的操作必须交由 authorizer 处理，挂起等待所有者批准，且绝不能授予管理权限。
- **不要让任何 `execute` capability 在缺少拥有者按 (agent, capability) 逐项显式开启（默认关闭、连接时双重确认）的情况下常驻。** 保持 `chooseTrustWindow` 里未开启时的 `once` 下限完好，agent 路径始终只是建议（只能缩短）。
- **不得采信 mesh 代理自行声明的来源、敏感性或健康状态**（provenance/sensitivity/health）；这些元数据必须在本地重新推导。
- **不要在认证错误消息中暗示 token 可以伪造，或磁盘上有密钥可读。** 引导调用方走规定的所有者审批路径。

### 附录 —— 关键文件

| 关注点 | 文件 |
|---|---|
| enroll 账本（码→PAT，静态哈希，单次使用，撤销） | `core/agent-enrollment.ts` |
| 两凭据 handshake（PAT=agent，connection-key=管理员） | `core/handlers.ts`（`handshake`、`enrollAgent`） |
| 会话绑定、`invalidateByAgentId`/`invalidateByKey` | `core/sessions.ts` |
| 授权、常驻、`hasPriorApproval`、`chooseTrustWindow`、`revokeAllForAgent` | `core/grant-service.ts` |
| 敏感度→窗口、`recommendedTrustWindowFor`、mesh 挂载重新派生 | `core/capability-registry.ts` |
| `DEFAULT_TRUST_WINDOWS`、钳制、`requireEncryption` 快速失败 | `config.ts` |
| 管理密钥门、连接/撤销 agent | `core/admin.ts` |
| 公开 Floor + enroll 自描述 | `core/well-known.ts` |
| 挂起 / 自动批准 / 墓碑策略 | `auth/authorizer.ts` |
| 构建时的技能↔Floor 校验器（不变量 VI） | `integration/verify-plugin.ts` |
| mesh enroll（Ed25519 密钥固定）、双向隧道 auth + 加密策略 | `mesh/enrollment.ts`、`mesh/handshake.ts` |
