---
title: 安全模型
description: 权威的 Plexus 信任与授权模型——两种凭据、按 agent 独立的 PAT、由敏感度门控的常驻授权，以及 execute 永不常驻的天花板——每一条论断都引用到代码。
---

# 安全与信任模型

::: tip 读者
正在决定是否把真实资源托付给 Plexus 的人，需要**确切**知道每种凭据能做什么、每种泄露的代价、以及授权究竟如何流转。每一条承重的论断都对着已提交的代码引用 `file:line`，让你能自行核验。权威的设计账本是
[`agent-skill-compile-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/agent-skill-compile-domain-model.md)
（不变量 III = 按 agent 独立的 PAT / connection-key 仅限管理员；不变量 IV = 穿过 primary 的等价性；不变量 VI = 模板化的 auth 内核）。本文描述**代码**所执行的东西。下文路径除非另有说明，均相对于 `packages/runtime/src/`。
:::

## 五句话讲清信任模型

1. 恰好存在一条**管理员信任边界**——`connection-key`（外加它所认证的更宽的管理界面）——而 agent **永远**不持有它；一个只会说 HTTP 的 agent 永远够不到管理平面。
2. 每个 agent 用**自己那份持久的、按 agent 独立的 PAT** 认证，该 PAT 从一次性登记码兑换一次得来，因此一份泄露的 agent 凭据其影响面恰是**那一个 agent 预先获授的 capability**，且可独立吊销。
3. 一个授权是**常驻**的（可无摩擦复用）只在该 capability 自身的**敏感度**允许时才成立；运行代码（`execute`）**永远不能**搭乘一个常驻授权，即便在管理员给定的信任窗口之下也不行。
4. PAT 证明真实的 `agentId`，因此一个客户端永远无法自我断言成另一个 agent 的身份；管理员路径之所以能点名一个 `agentId`，仅仅因为持有 connection-key *就是*管理员权威本身。
5. 每一种凭据都是**静态哈希、失败即关闭、单一用途**的，而一个 agent 能看到的那些界面（"Floor"）刻意只披露受认可的所有者批准路径——绝不暗示一把磁盘上的密钥或一个可伪造的令牌存在。

## 1. 凭据分类学与信任边界

Plexus 有两条不同的信任边界，每一侧都有一小组凭据。最重要的单条规则：**connection-key 仅限管理员；agent 用一个按 agent 独立的 PAT 认证。**

![两个永不交叉的凭据 — admin connection-key 与各 agent 自己的 PAT](/diagrams/two-trust-boundaries.png)

| 凭据 | 谁持有 | 授权范围 | 生命期 | 静态存储 | 泄露时的影响面 |
|---|---|---|---|---|---|
| **管理员 connection-key** | 本地的人 / 桌面 app / `plexus` CLI——**带外**获得，绝不经 HTTP | 完整管理平面：`/admin/api/*`（连接/吊销 agent、授权、暴露、源、mesh 加入令牌），以及 `handshake` 的管理员路径 | 长生命期；可轮换（轮换会使旧密钥引导的会话失效） | 经 `state.connectionKey.verify()` 验证；任何路由都不返回它 | **全部。** 对本网关的完整管理员权威。这就是*那个*要保护的东西。 |
| **管理密钥** | 同上 | 同上——"管理密钥"与"connection-key"是**同一个秘密**，在 `/admin/api/*` 及享有特权的 agent 平面操作上以 `X-Plexus-Connection-Key` 呈现 | 同 | 同 | 同 connection-key。 |
| **按 agent 独立的登记码** | 一个特定 agent，带外交付（搭乘安装命令） | **一次性**兑换成该 agent 的 PAT | **15 分钟**，单次使用（`DEFAULT_CODE_TTL_MS`） | 仅 sha256 哈希（`codeHash`） | 一个 agent 的*引导*，且仅在 15 分钟内、仅在未兑换时。兑换之后即为惰性。 |
| **按 agent 独立的 PAT**（`plx_agent_…`） | 一个特定 agent，以它自己的范式存放（如 `.env`） | 在 `handshake` 处**作为那个 agentId** 开启一个会话；此后，该 agent 预先获授的（常驻）capability | 持久，直到被吊销 / 重签发（无 TTL） | 仅 sha256 哈希（`patHash`） | **一个 agent 预先获授的 capability**，可独立吊销。够不到管理平面。 |
| **受限令牌**（已签名 JWT，`tokenScheme: "plexus-scoped-jwt"`） | 被授予的那个 agent | 恰好调用其 `scopes` 中的 capability/动词，在其会话存活且其 jti 未被吊销期间 | 短：默认 15 分钟，钳制到 `[1m, 60m]`（`config.ts:36-40`） | 无状态已签名 JWT；jti 被追踪以供吊销 | 一个狭窄、短命、可吊销的切片：特定 cap，≤60 分钟，可按 jti 杀掉。 |
| **mesh 加入令牌** | 一个远端 proxy 操作者，带外 | 把**一个** proxy workload 登记进 mesh（钉入它的 Ed25519 密钥） | 可选 TTL，单次使用 | 仅 sha256 哈希 | 准入一个 workload——且据 §7，加入所授的 capability 可见性/访问权为**零**，直到所有者刻意暴露 + 授权。 |

### 为什么 connection-key 保持仅限管理员（请自行核验）

- **没有任何路由返回它，也没有任何 payload 暗示它存在。** 刻意**不存在** `GET /admin/api/connection-key`（`admin.ts:331-343`）。理由写在代码里：一个不受信任的 agent 只会说 HTTP，因此任何返回或暗示该密钥的 HTTP 路由都会让 agent 升级到管理权限。
- **管理平面被统一地密钥门控。** 一个总括中间件 `admin.use("/api/*", requireManagementKey)`（`admin.ts:329`）在**每一条** `/admin/api/*` 数据路由上都要求一个已核验的 `X-Plexus-Connection-Key`，读写一视同仁（`requireManagementKey`，`admin.ts:305-321`）。仅凭环回的 Host/Origin 守卫*不*被当作足够（任何本地进程都能发送 `Host: 127.0.0.1`，且网关可能被绑到一个 LAN 接口）。
- **agent 呈现 PAT，管理员呈现 connection-key——在不同的地方。** 在 `handshake` 处，一个 agent 呈现一个 `Bearer plx_agent_…` 头；一个管理员在 JSON **body** 里呈现 `{ "connectionKey": … }`（`handlers.ts:184-248`）。两条路径靠凭据是否在场来选择，绝不互相穿透。

## 2. 授权流，端到端

![五步 agent 循环 — discover、enroll、handshake、grant、invoke](/diagrams/protocol-loop.png)

```
                         ┌─────────────────────────────────────────────────────────────┐
                         │  ADMIN (config-time, holds the connection-key, out-of-band)  │
                         │  POST /admin/api/agents/connect                              │
                         │   ├─ mint one-time enrollment code (plx_enroll_…, 15 min)    │
                         │   └─ grant selected cap-set to agentId as STANDING grants    │
                         │      (this admin grant IS the human approval, done once)     │
                         └───────────────┬──────────────────────────┬──────────────────┘
                                         │ install command          │ standing grants
                                         │ carries the code          │ persisted for agentId
                                         ▼                          ▼
   AGENT                                                        GATEWAY (primary authority)
   ─────                                                        ─────────────────────────────
   (0) DISCOVER   GET /.well-known/plexus            ──►  unauth; returns capability summaries
                  (no credential)                          + auth advertisement + enrollment
                                                           self-description        (well-known.ts)

   (1) ENROLL     POST /agents/enroll { code }       ──►  redeemEnrollmentCode(code):
                                                           shape→known→PENDING→fresh→mint PAT→
                                                           fsync→CONSUME code (single-use)
                  ◄── { pat: plx_agent_…, agentId }        (agent-enrollment.ts:294-332)
                  store PAT (own paradigm)                 PAT returned in plaintext ONCE

   (2) HANDSHAKE  POST /link/handshake               ──►  verifyPat(pat) → REAL agentId
                  Authorization: Bearer plx_agent_…        session bound to THAT id (not client-
                  ◄── { sessionId, manifest, … }           supplied)      (handlers.ts:195-231)

   (3) GRANT      PUT /grants { grants:{ id:"allow"}} ──►  per cap: hasPriorApproval? (standing +
                  X-Plexus-Session: <sess>                 unexpired) ─ yes ─► short-circuit → token
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

**每一跳检查什么：**

- **(0) Discover** —— 什么都不检查。`.well-known` 按设计是公开且未认证的；它只是 SUMMARY 层级（身份 + capability 摘要 + 端点 URL + 登记自描述）。它从不披露 connection-key 或任何秘密（`well-known.ts`）。
- **(1) Enroll** —— **登记码就是凭据**（`handlers.ts:279-324`）；这里绝不接受 connection-key。失败即关闭：畸形 body → 400；坏的/已用的/过期的码 → 401 带一个有类型的原因；持久写入失败 → 500，把码留作未消费以供重试。兑换本身按顺序跑五项检查，且仅在成功时才铸造（`agent-enrollment.ts:294-332`）。
- **(2) Handshake** —— 一个 `Bearer` 令牌被当作一次 PAT auth 尝试，且**必须**通过验证；一个伪造/被吊销/过期/非 PAT 的 bearer 会失败即关闭（401，无会话）且**不**穿透到 connection-key。会话绑定到 PAT 已核验的 `agentId`；任何 `client.agentId` 都被强制改写为它（`handlers.ts:197-215`，`sessions.ts:74-93`）。
- **(3) Grant** —— 见 §3。一个常驻 + 未过期的先前授权会短路授权器；否则 `UserConfirmAuthorizer` 裁决自动放行还是挂起（`authorizer.ts:204-254`）。未知的 capability id 在授权服务被触及之前就被 400 拒绝（无静默跳过，无空壳令牌）（`handlers.ts:380-387`）。
- **(4) Invoke** —— 令牌签名、jti 吊销与会话存活全都被强制（且一次拒绝被**审计**，而非静默丢弃），发生在管线内部（`handlers.ts:585-626`）。一个顶层被禁用（"未暴露"）的 capability 即便带一个有效令牌也会被拒。

## 3. 常驻授权、信任窗口与敏感度

一个**常驻授权**是那条持久的记录，它让 agent 之后一次在作用域内的请求短路人类批准。是否具备常驻资格由 **capability 敏感度**决定，后者派生自 `provenance × verb`（来源 × 动词）——**而非**取决于该 capability 是本地还是远端（ADR-5 / 不变量 IV）。

### 敏感度 → 信任窗口

`recommendedTrustWindowFor(provenance, verbs, table)`（`capability-registry.ts:163-173`）做如下映射：

- **`execute`（任何 provenance/来源）→ `once`。** 这是唯一一个其敏感度确实要求逐次批准的动作。它以**动词**为键，而动词在一次 mesh 挂载后仍然存活，因此一个 mesh 的 `execute` cap 和一个本地的 `execute` cap 都得到 `once`——没有任何东西仅仅因为远端就得到 `once`（`capability-registry.ts:168-169`）。
- **`read` / `write` → 具备常驻资格的、按类别的默认值**，取自 `DEFAULT_TRUST_WINDOWS`（`config.ts:67-74`）：

  | 类别 | read | write |
  |---|---|---|
  | first-party | 7d | 1d |
  | managed | 7d | 1d |
  | extension | 1d | 1d |

  注意 `extension:write` 是 `1d`（一个真实的常驻窗口），**而非** `once`。较早的"mesh/extension cap 硬编码为 `once`"行为把*远端*与*仅限逐次*混为一谈，已被移除（`config.ts:56-66`）。

### 硬性的 `execute → once` 天花板（请自行核验）

`chooseTrustWindow`（`grant-service.ts:447-477`）是解析实际所应用窗口的单一咽喉点。两道守卫让"`execute` 永不能常驻"成为结构性的：

```ts
// grant-service.ts
if (this.isAnon(opts.agentId)) return { kind: "once" };          // 460  anon:* capped
if (def.kind === "once") return { kind: "once" };                // 466  execute HARD ceiling
```

第 466 行是那条承重规则：当 capability 自身的敏感度产出一个 `once` 默认值（恰是 `execute` 的情形）时，`once` 被返回，**无论请求的是什么，也无论这次选择是否具管理员权威**。一个管理员即便给出一个更长的窗口也无法让一个 `execute` cap 常驻。对 `read`/`write`，默认值绝不是 `once`，因此该子句是空操作，一个合法的管理员窗口得以存活。这道钳制在**两条**路径上都被应用——权威（管理员）与建议（agent）——并在管理员 `connect-an-agent`/bundle 路径里再次应用（`admin.ts:610-616`，`grant-service.ts:1380-1387`）。

### 其他常驻授权规则

- **第一次授权对 extension 挂起；复用则短路。** `hasPriorApproval` **仅**对一个常驻 + 未过期的授权返回 true（`grant-service.ts:381-404`，`isStandingAndUnexpired`）；一个 `once` 或已过期的授权绝不短路。因此对一个 write/extension cap 的第一次请求会为所有者挂起；后续在作用域内的请求则无摩擦。
- **`anon:*` → `once`。** 一个没有已核验 agentId 的会话（`anon:<sessionId>`）绝不会得到一个持久的常驻授权——在 `chooseTrustWindow`（`grant-service.ts:460`）和授权器的窗口选择（`authorizer.ts:199-202`）里都被上限锁在 `once`。
- **agent 窗口是建议性的，管理员窗口是权威性的。** 一个 agent 可以在 `PUT /grants` 上提议一个窗口，但它只能**缩短**，绝不能超过按类别的天花板去延长（`shorterWindow`，`grant-service.ts:88-90`，应用于 `475-476`）。管理员/人类的批准选择是权威的（仍受 `execute→once` 与 `until-revoked` 策略钳制的约束）。
- **约束只会收窄。** 一个带约束的常驻授权会短路一个裸的或深度相等的请求，但不短路一个更宽/不同的请求，而铸造出的令牌总是携带**该常驻授权的**约束，绝不是一个被拓宽的（`effectiveConstraint`，`grant-service.ts:415-431`）。

## 4. 身份与防伪

`feat/agent-skill-compile` 之前的弱点是一个自我断言的 `agentId`：一个客户端可以声称*自己是*任何 agent。PAT 堵住了这一点。

- **PAT 绑定真实的 agentId。** 在 `handshake` 处，一个 `Bearer` 令牌经登记账本解析：`verifyPat(pat)` 返回 `patHash` 匹配的那个**活跃**行的 `agentId`，否则返回 `null`（`agent-enrollment.ts:341-348`）。会话随后被开启并绑定到*那个* id，客户端提供的 `agentId` 被那个已核验的覆盖（`handlers.ts:214-215`）。
- **会话存储把显式 agentId 视为可信，把 client.agentId 视为不可信。** `open(bootstrapKey, client, agentId)` 在显式已核验 `agentId` 在场时使用它，并覆盖任何 `client.agentId`；自由形式的 `client.agentId` 仅是审计元数据，对一个公开调用方而言，它单凭自身**绝不**是一个可信的身份（`sessions.ts:33-46, 74-93`）。
- **一个被盗的 agentId 字符串什么也买不到。** 防重放/防伪来自 PAT 校验器（静态哈希、按 agent、可吊销）——不带 PAT 而点名一个 agent 只会拿到一个 401，没有会话（`handlers.ts:197-209`）。
- **为什么管理员路径仍可点名一个 agentId。** connection-key 的 body 路径*可以*合法地点名它代表其行动的那个 `agentId`（控制台的"连接一个 agent"正是这么做的）。那不是伪冒：持有 connection-key **就是**管理员权威，而一个 agent 没有 connection-key 可用来够到那条路径（`handlers.ts:174-182`，`admin.ts:552-627`）。

## 5. 吊销与影响面

"吊销一个 agent"意味着**该 agent 的所有访问权立即死去，而其他任何东西都不受触碰。** 管理员路由 `POST /admin/api/agents/revoke`（`admin.ts:670-711`）做三件按 agent 作用域限定的事：

1. **登记 / PAT** —— `agentEnrollment.revoke(agentId)` 把该行翻到 `revoked` 并把它的 `patHash` 从活跃索引中剔除，因此 PAT 立即停止通过验证；将来用它的 handshake 都失败即关闭（`agent-enrollment.ts:360-378`）。
2. **活跃会话** —— `sessions.invalidateByAgentId(agentId)` 使绑定到那个 agentId 的每一个活跃会话失效并返回它们的 jti，随后这些 jti 被吊销。这让吊销**立即**生效，而非被延迟 ~一个会话生命期，且是按*身份*触达会话（管理员知道 agentId，而非原始 PAT）（`sessions.ts:126-139`，`admin.ts:692-698`）。
3. **常驻授权 + 活跃令牌** —— `grants.revokeAllForAgent(agentId)` 移除该 agent 的持久授权（这样 refresh 无法再铸造）**并给每一对打墓碑**（这样一个仍在运行的 agent 的裸重请求会重新与人类确认，而不是静默地再自动放行一个低风险读），随后吊销任何剩余的被追踪 jti（`grant-service.ts:1304-1338`）。

**按 agent 隔离。** 每一步都以 `agentId` 为键；第二个 agent 的登记、会话与授权都不受触碰。这正是按 agent 独立 PAT 的具体回报：吊销被作用域限定到一个 agent，不像一个共享凭据，其轮换会切断所有人。

**吊销墓碑。** 一次吊销之后，一个刚被吊销的 `(agentId, cap)` 低风险读——本来通常会自动放行——转而为一个人类**挂起**（`authorizer.ts:236-246`，`ctx.revokedTombstone`）；一次新鲜的人类批准会解除墓碑。"吊销就是彻底的停止。"

**相关的吊销路径：** connection-key **轮换**会使旧密钥引导的会话失效（`sessions.invalidateByKey`，`sessions.ts:115-124`）——注意 PAT 引导的 agent 会话是在 PAT 之下引导的，而非 connection-key，因此它们刻意与密钥轮换解耦，只随它们自己的 PAT 一同死去。一个 agent 可以通过呈现自己的令牌来交回它**自己的**令牌（`revoke` 路径 b，`handlers.ts:512-533`）；替别人按 jti 吊销、以及按 bundle 吊销，都需要管理密钥（`handlers.ts:536-539`）。

## 6. 编译模型安全（会自我集成的技能）

编译模型把一个资源作为原生产物交付给一个 agent（v1：一个 Claude Code plugin）。不变量 VI 是安全脊柱：**任何生成产物的 auth/invoke 内核都是确定性模板化的、可对着 Floor 核验的——绝非 LLM 撰写**——且**没有任何长生命期的秘密被烘焙进一个被分发的产物。**

- **没有秘密被烘焙进去；一次性登记码搭乘安装。** 被分发的产物不含持久 PAT，也不含管理员密钥。登记**码**（短命、单次使用）可以搭乘安装*命令*，并被兑换成一个由 agent 自己存放的 PAT——PAT 在兑换时被返回恰好一次，绝不被持久化进一个已发布的文件（`well-known.ts:96-105` 描述了那条"兑换→存放"契约；`agent-enrollment.ts:122-128`）。
- **加固过的 `.well-known` 是那个神谕。** 一个构建时校验器（`integration/verify-plugin.ts`）沿四条独立的轴，对着 Floor 检查一个已渲染的 plugin，返回一个结构化的通过/失败：
  1. **受认可的 auth 内核** —— `bin/plexus` 与已提交的受认可引擎（`tools/plexus-cli/plexus`）逐字节相同（sha-256）；管道未被手工/LLM 改动。
  2. **无烘焙的秘密** —— 没有任何被分发的文件包含一个 `plx_agent_…` PAT、一个烘焙的 `plx_enroll_…` 码，或任何调用方提供的持久凭据（包括管理员 connection-key，可作为 `forbiddenSecrets` 传入）。
  3. **只有已广告/已获授的 cap** —— 技能引用的每一个 capability 都在场于 Floor 已广告的目录中（且在提供时，位于该 plugin 被编译所针对的 cap 集合内）。一个技能永远无法引用一个 Floor 未广告的 cap。
  4. **受认可的流程** —— 该 plugin 所*指示*的 enroll/handshake/invoke 与 Floor 的 `auth.enrollment` / `requestShapes` 相符；没有任何指令文件即兴发挥出一条 auth 路径（读一把磁盘上的管理员密钥，或伪造一个令牌）。
- **陈旧是安全的（不变量 V）。** 技能是 Floor 上的一层投影；网关**实时**执行授权。一个陈旧或误生成的技能永远无法超出 Floor 的授权——最坏情况只是外观上的（引用一个已吊销的 cap → invoke 只是在网关处失败）。自动更新是一个新鲜度/UX 特性，而非安全特性；**v1 部分实现：** 自动更新推迟到 v2。

## 7. mesh 信任

mesh 访问由**穿过 primary 的等价性**（不变量 IV / ADR-5）治理：一个从 mesh 节点路由而来的 capability，其授权与一个本地 capability **完全相同**——同一个 PAT、同一个授权器、同样的信任窗口。来源是一个对 agent 授权路径不可见的路由细节。

有两道 mesh 专属的防御为其兜底：

- **远端断言的信任姿态绝不被信任。** 当一个远端 workload 的 cap 被挂载时，primary **剥掉** proxy 所断言的任何 `provenance`/`sensitivity`/`recommendedTrustWindow`/`health`，并在本地**重新派生**它们。一个被挂载的 cap 会重新派生为 `extension` 来源（最严格的类别），因此一个被挂载的远端读会**挂起**，绝不自动放行；一个断言 `provenance:"first-party"` 的恶意 proxy 无法伪冒授权器（`capability-registry.ts:956-973`）。
- **隧道 auth 是双向、钉入的 Ed25519、失败即关闭。** proxy↔primary 边界与 agent↔primary 边界是分离的。加入时，一枚一次性加入令牌（那个 nonce，静态 sha256，单次使用）准入一个 workload 并**钉入**它的 Ed25519 公钥（`mesh/enrollment.ts` 头部 + `admit`）。此后每个套接字都跑一次双向挑战——primary 对着钉入的密钥核验 proxy，proxy 对着它钉入的 `upstream.primaryPubKey` 核验 primary（强制：没有裸 TOFU）——而一个未登记/未认证的套接字在任何数据帧之前就被断开（`mesh/handshake.ts:399-454`）。
- **传输加密策略。** `requireEncryption`（`PLEXUS_MESH_REQUIRE_ENCRYPTION`）让 primary 用一个有类型的 `encryption_required` 原因拒绝一条明文 `ws` 的 proxy 隧道，只接受 `wss`（`mesh/handshake.ts:399-403`）。身份 ⟂ 加密：这门控的是*信道*，而非 Ed25519 身份——一把有效的钉入密钥走明文 ws 仍会被拒。若启用却无 TLS 材料，它会在启动时快速失败（`config.ts:562-567`）。

完整的 mesh 开发者模型见[联邦 mesh](/zh/architecture/mesh)。

## 8. 错误卫生作为一种安全属性

一次盲测发现表明，含糊的 auth 错误会*诱使*一个谨慎的 agent 去"到磁盘上找一把签名密钥、铸造它自己的令牌"。已提交的错误界面把**朝向受认可路径的可读性当作一种安全控制**：

- 一次带活跃会话但无授权的 `/invoke` 返回一个**结构化的** `approval_required`，带 `pendingId` + `approvalUrl` + `grantStatusUrl` 和那句明确的话*"所有者必须在 Plexus 控制台里批准此授权；agent 无法铸造它自己的令牌"*（`handlers.ts:692-712`）。
- 一次无会话的 `/invoke` 返回诚实的 `grant_required` 指引，指向 handshake → `PUT /grants`，并直白地陈述低风险 first-party 读会被自动授予，且 **"agent 无法铸造它自己的令牌"**（`handlers.ts:634-652`）。
- `.well-known` 广告的是授权**请求**入口点（`grantRequestUrl` + 方法）和登记兑换步骤，因此唯一被广告的前进路径就是那条被审计、经所有者批准的路径（`well-known.ts:53-105`）。没有任何响应、错误或使用说明暗示一把磁盘上的密钥或一个可伪造的令牌存在。
- `GET /grants/status` 上的发起者/管理门确保一个铸造出的令牌只会被交给创建了那个 pending 的会话（或管理密钥）——一个泄露的 `pendingId` 单独只会拿到 403，绝不拿到令牌（`handlers.ts:417-444`）。

原则：**让受认可的路径成为唯一可被发现的路径，且绝不以一种把调用方引向伪造凭据或读取密钥文件的方式来措辞一个错误。**

## 9. 威胁模型 —— 范围内、范围外与红队结果

### 范围内（代码防御这些）

- 一个仅限网络/HTTP 的对手（一个 agent，或一旦启用了 LAN 绑定后的一个 LAN 对端）试图够到管理平面：被所有 `/admin/api/*` 上的 connection-key 门与"HTTP 上不给密钥"规则挡住（`admin.ts:305-343`）。
- 一个 agent 试图自我断言成另一个 agent 的身份：被 PAT→agentId 绑定挡住（§4）。
- 一个 agent 试图不经人类就自授 write/execute，或对一个 extension cap 授权：被默认的 `UserConfirmAuthorizer` 挡住（`authorizer.ts:119-254`）。
- 一个 agent 试图让运行代码（`execute`）变得无摩擦/常驻：结构上不可能（`grant-service.ts:466`）。
- 一份泄露的 agent 凭据：被限定到一个 agent 预先获授的 cap，可被孤立地吊销（§5）。
- 一个断言有利信任姿态的恶意 mesh proxy，或一条明文/MITM 隧道：被本地重新派生、钉入的双向 auth 与加密策略挡住（§7）。
- 静态秘密：登记码、PAT 与 mesh 加入令牌在磁盘上被 sha256 哈希（`0600` 账本文件）；PAT/码的明文被返回恰好一次且永不可恢复（`agent-enrollment.ts:36-39, 225-236`）。

### 范围外（有据可查的假设——依赖 OS/部署，而非 Plexus 代码）

::: warning 同 UID 主机隔离
按 agent 独立 PAT 的隔离假定 agent 进程**读不到管理员 connection-key 文件。** 在一个同 UID 的主机上，一个 agent 可以 `cat ~/.plexus/connection-key` 并获得完整的管理员权威——Plexus 的进程内边界无法阻止一个能读所有者主目录的进程。缓解手段是 **OS 沙箱 / 容器化装置**（mesh/装置史诗；见
[`capability-appliance.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/capability-appliance.md)、
[`linux-confinement.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/linux-confinement.md)），它把 agent 置于一个读不到密钥文件的隔离中。在那之前，把"agent 以拥有 `~/.plexus` 的同一个用户身份运行"当作**对那个 agent 的完整管理员信任。**
:::

- 主机被攻陷 / root、对活跃进程的内存抓取、以及旁路信道，对应用层而言均在范围外。
- **v1 部分加固，明确推迟：**
  - **密钥对 PAT。** v1 使用一个 **bearer** PAT（为操作者的 `.env` 心智模型 + 简洁而选，ADR-4）。一个密钥对 PAT（持有证明，因此一份静态泄露的凭据在没有私钥时毫无用处）是相对 bearer PAT 的一项有据可查的 **v2** 加固。
  - **技能自动更新**（不变量 V）—— 推迟；安全不需要它（§6）。
  - **LLM 撰写的教学外壳** —— 即便在 v2，LLM 也只可撰写任务框定/示例，绝不撰写 auth/invoke 机制（不变量 VI）。

### 红队结果

对已提交的 auth 脊柱 + 管理/吊销路径跑了两轮对抗性红队评审。结论：**脊柱是干净的。** 那个唯一被确认的 **HIGH**——一个 `execute` capability 被允许在一个管理员给定的窗口下搭乘一个常驻授权——**已被修复**；修复是 `grant-service.ts:466` 处的 `def.kind === "once"` 钳制，在权威路径与建议路径上都被应用，并在管理员 connect/bundle 流程里被重申。

## 10. 一个开发者绝对不能做什么

- **不要把 connection-key（或任何持久秘密）烘焙进任何面向 agent 的东西**——不进技能，不进 plugin，不进 agent 能读的配置，不进 HTTP 响应。connection-key 仅限管理员；刻意不存在任何返回它的路由。
- **不要让一个技能的 auth/invoke 内核被 LLM 撰写或手工编辑。** 它必须是那个逐字节相同的受认可引擎，对着 Floor 神谕核验（不变量 VI，`verify-plugin.ts`）。一个撰写 auth 路径的 LLM 可能发布出一份越权的教程。
- **不要分发一个持久 PAT。** 发布那个一次性码（短命、单次使用）；让 agent 兑换并存放它自己的 PAT。
- **不要把环回的 Host/Origin 守卫当作管理操作的认证**——它证明的是"一个被接受的权威"，而非"那个受信任的管理客户端"。把管理路由门控在已核验的 connection-key 上。
- **不要新增一个 agent 能经由 agent 平面够到的管理操作。** agent 平面的操作必须穿过授权器（为所有者挂起），且绝不授予管理权威。
- **不要让 `execute` 常驻，也不要新增一条让管理员窗口能覆盖 `once` 天花板的代码路径。** 保持 `chooseTrustWindow` 钳制完好无损。
- **不要信任来自一个 mesh proxy 的、远端断言的信任姿态**（provenance/sensitivity/health）——总是在本地重新派生。
- **不要以一种暗示可伪造令牌或磁盘上密钥的方式措辞一个 auth 错误。** 把调用方指向受认可的所有者批准路径。

### 附录 —— 关键文件

| 关注点 | 文件 |
|---|---|
| 登记账本（码→PAT，静态哈希，单次使用，吊销） | `core/agent-enrollment.ts` |
| 两凭据 handshake（PAT=agent，connection-key=管理员） | `core/handlers.ts`（`handshake`、`enrollAgent`） |
| 会话绑定、`invalidateByAgentId`/`invalidateByKey` | `core/sessions.ts` |
| 授权、常驻、`hasPriorApproval`、`chooseTrustWindow`、`revokeAllForAgent` | `core/grant-service.ts` |
| 敏感度→窗口、`recommendedTrustWindowFor`、mesh 挂载重新派生 | `core/capability-registry.ts` |
| `DEFAULT_TRUST_WINDOWS`、钳制、`requireEncryption` 快速失败 | `config.ts` |
| 管理密钥门、连接/吊销一个 agent | `core/admin.ts` |
| 公开 Floor + 登记自描述 | `core/well-known.ts` |
| 挂起 / 自动批准 / 墓碑策略 | `auth/authorizer.ts` |
| 构建时 技能↔Floor 校验器（不变量 VI） | `integration/verify-plugin.ts` |
| mesh 加入登记（Ed25519 钉入）、双向隧道 auth + 加密策略 | `mesh/enrollment.ts`、`mesh/handshake.ts` |
