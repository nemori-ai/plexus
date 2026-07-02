---
title: 安全模型
description: Plexus 信任与授权模型的权威描述：两种凭据、按 agent 独立的 PAT、由敏感度门控的常驻授权、execute 永不常驻的硬天花板，每条论断都落到代码引用。
---

# 安全与信任模型

::: tip 读者
本文写给正在决定要不要把真实资源托付给 Plexus 的人：每种凭据能做什么、泄露的代价是什么、授权究竟怎么流转，都需要**确切**答案。每一条承重论断都附带已提交代码的 `file:line` 引用，可以自行核验。权威设计账本是
[`agent-skill-compile-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/agent-skill-compile-domain-model.md)
（不变量 III = 按 agent 独立的 PAT / connection-key 仅限管理员；不变量 IV = 穿过 primary 的等价性；不变量 VI = 模板化 auth 内核）。本文描述的是**代码实际执行的规则**。下文路径除非另有说明，均相对于 `packages/runtime/src/`。
:::

## 五句话讲清信任模型

1. 管理员信任边界只有一条：`connection-key`（以及它所认证的整个管理界面）。agent **永远**不持有它——只会说 HTTP 的 agent 够不到管理平面。
2. 每个 agent 用**自己的持久 PAT** 认证，PAT 由一次性 enroll 码兑换一次得来。因此一份 agent 凭据泄露，爆炸半径恰好是**该 agent 预先获授的 capability**，且可以单独撤销。
3. 授权能否**常驻**（免摩擦复用），只取决于 capability 自身的**敏感度**；运行代码（`execute`）**永远**搭不上常驻授权，管理员给出信任窗口也不行。
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
| **受限 token**（scoped token，签名 JWT，`tokenScheme: "plexus-scoped-jwt"`） | 获授的 agent | 仅限调用其 `scopes` 内的 capability/动词，且要求会话存活、jti 未被撤销 | 短：默认 15 分钟，钳制到 `[1m, 60m]`（`config.ts:36-40`） | 无状态签名 JWT；jti 被追踪以供撤销 | 一个窄、短命、可撤销的切片：特定 cap，≤60 分钟，可按 jti 单独杀掉。 |
| **mesh join token** | 远端 proxy 操作者，带外 | 把**一个** proxy workload enroll 进 mesh（钉入它的 Ed25519 密钥） | 可选 TTL，单次使用 | 仅存 sha256 哈希 | 准入一个 workload——但按 §7，加入所得的 capability 可见性/访问权为**零**，直到所有者主动暴露 + 授权。 |

### 为什么 connection-key 仅限管理员（可自行核验）

- **没有路由返回它，也没有 payload 暗示它存在。** `GET /admin/api/connection-key` 是刻意**不存在**的（`admin.ts:331-343`）。理由写在代码里：不受信任的 agent 只会说 HTTP，任何返回或暗示该密钥的 HTTP 路由都等于给 agent 一条升级到管理权限的路。
- **管理平面统一由密钥门控。** 总括中间件 `admin.use("/api/*", requireManagementKey)`（`admin.ts:329`）对**每一条** `/admin/api/*` 数据路由都要求已核验的 `X-Plexus-Connection-Key`，读写一视同仁（`requireManagementKey`，`admin.ts:305-321`）。仅靠回环的 Host/Origin 守卫*不算*足够——任何本地进程都能发 `Host: 127.0.0.1`，网关也可能绑在 LAN 接口上。
- **agent 出示 PAT，管理员出示 connection-key，各走各的位置。** 在 `handshake` 处，agent 在 `Bearer plx_agent_…` 头里出示 PAT；管理员在 JSON **body** 里出示 `{ "connectionKey": … }`（`handlers.ts:184-248`）。两条路径按凭据是否在场选择，互不穿透。

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

- **(0) Discover** —— 什么都不检查。`.well-known` 按设计公开、免认证，只给 SUMMARY 层级（身份 + capability 摘要 + 端点 URL + enroll 自描述），从不披露 connection-key 或任何秘密（`well-known.ts`）。
- **(1) Enroll** —— **enroll 码本身就是凭据**（`handlers.ts:279-324`）；这一步绝不接受 connection-key。失败即关闭：body 畸形 → 400；码坏了/用过/过期 → 401 并附带类型化原因；持久写入失败 → 500，码保留未消费状态以供重试。兑换按顺序跑五项检查，全部通过才铸造 PAT（`agent-enrollment.ts:294-332`）。
- **(2) Handshake** —— `Bearer` token 被当作一次 PAT 认证尝试，**必须**通过验证；伪造/已撤销/过期/非 PAT 的 bearer 一律失败即关闭（401，无会话），**不会**穿透到 connection-key 路径。会话绑定到 PAT 核验出的 `agentId`，任何 `client.agentId` 都被强制改写（`handlers.ts:197-215`，`sessions.ts:74-93`）。
- **(3) Grant** —— 见 §3。存在常驻且未过期的既有授权时，直接短路授权器；否则由 `UserConfirmAuthorizer` 裁决自动放行还是挂起（`authorizer.ts:204-254`）。未知的 capability id 在触及授权服务之前就被 400 拒绝——没有静默跳过，也没有空 token（`handlers.ts:380-387`）。
- **(4) Invoke** —— token 签名、jti 撤销、会话存活在管线内全部强制执行，拒绝会被**审计**而非静默丢弃（`handlers.ts:585-626`）。顶层被禁用（"未暴露"）的 capability，即便持有效 token 也会被拒。

## 3. 常驻授权、信任窗口与敏感度

**常驻授权**是一条持久记录：agent 之后在作用域内的请求可以凭它短路人类批准。能否常驻由 **capability 敏感度**决定，敏感度派生自 `provenance × verb`（来源 × 动词）——与 capability 在本地还是远端**无关**（ADR-5 / 不变量 IV）。

### 敏感度 → 信任窗口

`recommendedTrustWindowFor(provenance, verbs, table)`（`capability-registry.ts:163-173`）的映射：

- **`execute`（任何来源）→ `once`。** 只有这个动作的敏感度要求逐次批准。它以**动词**为键，动词在 mesh 挂载后不会变，因此 mesh 的 `execute` cap 和本地的 `execute` cap 同样得到 `once`——没有任何东西仅仅因为远端就得到 `once`（`capability-registry.ts:168-169`）。
- **`read` / `write` → 可常驻的按类别默认值**，取自 `DEFAULT_TRUST_WINDOWS`（`config.ts:67-74`）：

  | 类别 | read | write |
  |---|---|---|
  | first-party | 7d | 1d |
  | managed | 7d | 1d |
  | extension | 1d | 1d |

  注意 `extension:write` 是 `1d`（真实的常驻窗口），**不是** `once`。早期"mesh/extension cap 硬编码为 `once`"的行为把*远端*和*仅限逐次*混为一谈，已被移除（`config.ts:56-66`）。

### 硬性的 `execute → once` 天花板（可自行核验）

`chooseTrustWindow`（`grant-service.ts:447-477`）是解析实际生效窗口的唯一咽喉。两道守卫让"`execute` 永不常驻"成为结构性事实：

```ts
// grant-service.ts
if (this.isAnon(opts.agentId)) return { kind: "once" };          // 460  anon:* capped
if (def.kind === "once") return { kind: "once" };                // 466  execute HARD ceiling
```

第 466 行是承重规则：capability 自身敏感度产出 `once` 默认值时（`execute` 正是如此），就返回 `once`——**不管请求什么，也不管这次选择有没有管理员权威**。管理员即便给出更长的窗口，也无法让 `execute` cap 常驻。对 `read`/`write`，默认值绝不是 `once`，该子句是空操作，合法的管理员窗口得以生效。这道钳制在权威（管理员）与建议（agent）**两条**路径上都生效，并在管理员 `connect-an-agent`/bundle 路径里再次应用（`admin.ts:610-616`，`grant-service.ts:1380-1387`）。

### 其他常驻授权规则

- **extension 的第一次授权挂起；复用短路。** `hasPriorApproval` **只**对常驻且未过期的授权返回 true（`grant-service.ts:381-404`，`isStandingAndUnexpired`）；`once` 或已过期的授权绝不短路。因此对 write/extension cap 的第一次请求会挂起等所有者批准，后续在作用域内的请求则无摩擦。
- **`anon:*` → `once`。** 没有已核验 agentId 的会话（`anon:<sessionId>`）绝不会获得持久的常驻授权——`chooseTrustWindow`（`grant-service.ts:460`）和授权器的窗口选择（`authorizer.ts:199-202`）都把它锁在 `once`。
- **agent 窗口是建议，管理员窗口是权威。** agent 可以在 `PUT /grants` 上提议窗口，但只能**缩短**，不能越过按类别的天花板去延长（`shorterWindow`，`grant-service.ts:88-90`，应用于 `475-476`）。管理员/人类的批准选择是权威的（仍受 `execute→once` 与 `until-revoked` 策略钳制）。
- **约束只收窄。** 带约束的常驻授权可以短路裸请求或深度相等的请求，不短路更宽/不同的请求；铸出的 token 总是携带**常驻授权本身的**约束，绝不携带被拓宽的约束（`effectiveConstraint`，`grant-service.ts:415-431`）。

## 4. 身份与防伪

`feat/agent-skill-compile` 之前的弱点是自我断言的 `agentId`：客户端可以声称自己*是*任何 agent。PAT 堵住了这个口子。

- **PAT 绑定真实 agentId。** 在 `handshake` 处，`Bearer` token 经 enroll 账本解析：`verifyPat(pat)` 返回 `patHash` 匹配的那条**活跃**记录的 `agentId`，否则返回 `null`（`agent-enrollment.ts:341-348`）。会话随即绑定到这个 id，客户端提供的 `agentId` 被核验值覆盖（`handlers.ts:214-215`）。
- **会话存储只信显式 agentId，不信 client.agentId。** `open(bootstrapKey, client, agentId)` 在显式核验的 `agentId` 在场时使用它并覆盖 `client.agentId`；自由填写的 `client.agentId` 只是审计元数据，对公开调用方**绝不**单独构成可信身份（`sessions.ts:33-46, 74-93`）。
- **偷到 agentId 字符串一无所获。** 防重放/防伪来自 PAT 校验器（静态哈希、按 agent、可撤销）——不带 PAT 点名一个 agent，得到的只有 401，没有会话（`handlers.ts:197-209`）。
- **管理员路径为什么可以点名 agentId。** connection-key 的 body 路径*可以*合法点名它代表行动的 `agentId`（控制台的"连接一个 agent"正是这样做的）。这不是伪冒：持有 connection-key **就是**管理员权威，而 agent 没有 connection-key，够不到这条路径（`handlers.ts:174-182`，`admin.ts:552-627`）。

## 5. 撤销与爆炸半径

"撤销一个 agent"意味着**它的所有访问立即死掉，其他一切原封不动。** 管理员路由 `POST /admin/api/agents/revoke`（`admin.ts:670-711`）做三件按 agent 作用域的事：

1. **enroll / PAT** —— `agentEnrollment.revoke(agentId)` 把记录翻成 `revoked`，并把它的 `patHash` 从活跃索引剔除；PAT 立即失效，之后用它 handshake 一律失败即关闭（`agent-enrollment.ts:360-378`）。
2. **活跃会话** —— `sessions.invalidateByAgentId(agentId)` 使绑定到该 agentId 的所有活跃会话失效并返回它们的 jti，这些 jti 随即被撤销。撤销因此**立即**生效，而不是延迟约一个会话生命期；且是按*身份*触达会话——管理员知道 agentId，不必知道原始 PAT（`sessions.ts:126-139`，`admin.ts:692-698`）。
3. **常驻授权 + 活跃 token** —— `grants.revokeAllForAgent(agentId)` 移除该 agent 的持久授权（refresh 无法再铸造），**并给每一对打上墓碑**（仍在运行的 agent 裸重请求时会重新找人类确认，而不是把低风险读再静默自动放行一次），最后撤销剩余的被追踪 jti（`grant-service.ts:1304-1338`）。

**按 agent 隔离。** 每一步都以 `agentId` 为键；第二个 agent 的 enroll、会话、授权分毫不动。这正是按 agent 独立 PAT 的具体回报：撤销的作用域就是一个 agent，不像共享凭据，一轮换就切断所有人。

**撤销墓碑。** 撤销之后，刚被撤销的 `(agentId, cap)` 上的低风险读——平时会自动放行——转为**挂起**等人类批准（`authorizer.ts:236-246`，`ctx.revokedTombstone`）；新一次人类批准会解除墓碑。撤销就是彻底的停止。

**相关的撤销路径：** connection-key **轮换**会使旧密钥引导的会话失效（`sessions.invalidateByKey`，`sessions.ts:115-124`）。注意 PAT 引导的 agent 会话建立在 PAT 之下，与密钥轮换刻意解耦，只随各自的 PAT 一同死去。agent 可以出示自己的 token 来交回**自己的** token（`revoke` 路径 b，`handlers.ts:512-533`）；替别人按 jti 撤销、按 bundle 撤销，都需要管理密钥（`handlers.ts:536-539`）。

## 6. 编译模型安全（会自我集成的技能）

编译模型把资源作为原生产物交付给 agent（v1：一个 Claude Code plugin）。不变量 VI 是安全脊柱：**产物的 auth/invoke 内核一律确定性模板化、可对着 Floor 核验——绝非 LLM 撰写**，且**分发出去的产物里不烘焙任何长生命期秘密。**

- **不烘焙秘密；一次性 enroll 码随安装下发。** 分发产物不含持久 PAT，也不含管理员密钥。enroll **码**（短命、单次使用）可以随安装*命令*下发，兑换成 agent 自己存放的 PAT——PAT 在兑换时返回恰好一次，绝不持久化进已发布文件（`well-known.ts:96-105` 描述了"兑换→存放"契约；`agent-enrollment.ts:122-128`）。
- **加固的 `.well-known` 是神谕。** 构建时校验器（`integration/verify-plugin.ts`）沿四条独立的轴，把渲染出的 plugin 对着 Floor 检查，返回结构化的通过/失败：
  1. **受认可的 auth 内核** —— `bin/plexus` 与已提交的受认可引擎（`tools/plexus-cli/plexus`）逐字节相同（sha-256）；管道没有被手工或 LLM 改动。
  2. **无烘焙秘密** —— 任何分发文件都不含 `plx_agent_…` PAT、烘焙的 `plx_enroll_…` 码，或调用方提供的持久凭据（包括管理员 connection-key，可作为 `forbiddenSecrets` 传入检查）。
  3. **只引用已广告/已获授的 cap** —— 技能引用的每个 capability 都必须在 Floor 广告的目录里（提供了 cap 集合时，还必须在该 plugin 编译所针对的集合内）。技能永远无法引用 Floor 未广告的 cap。
  4. **受认可的流程** —— plugin *指示*的 enroll/handshake/invoke 必须与 Floor 的 `auth.enrollment` / `requestShapes` 相符；任何指令文件都不得即兴发挥出一条 auth 路径（读磁盘上的管理员密钥、伪造 token）。
- **陈旧是安全的（不变量 V）。** 技能只是 Floor 上的一层投影，授权由网关**实时**执行。陈旧或误生成的技能永远越不过 Floor 的授权，最坏情况只是外观问题——引用了已撤销的 cap，invoke 在网关处失败而已。自动更新是新鲜度/UX 特性，不是安全特性；**v1 部分实现：** 自动更新推迟到 v2。

## 7. mesh 信任

mesh 访问由**穿过 primary 的等价性**（不变量 IV / ADR-5）治理：从 mesh 节点路由来的 capability，其授权与本地 capability **完全相同**——同一个 PAT、同一个授权器、同样的信任窗口。来源对 agent 的授权路径不可见，只是一个路由细节。

两道 mesh 专属防御兜底：

- **远端断言的信任姿态一概不信。** 挂载远端 workload 的 cap 时，primary **剥掉** proxy 断言的一切 `provenance`/`sensitivity`/`recommendedTrustWindow`/`health`，在本地**重新派生**。挂载的 cap 重新派生为 `extension` 来源（最严格类别），因此挂载的远端读会**挂起**，绝不自动放行；恶意 proxy 断言 `provenance:"first-party"` 也骗不过授权器（`capability-registry.ts:956-973`）。
- **隧道 auth 是双向、钉入的 Ed25519，失败即关闭。** proxy↔primary 边界与 agent↔primary 边界彼此分离。加入时，一次性 join token（即 nonce，静态 sha256，单次使用）准入 workload 并**钉入**它的 Ed25519 公钥（`mesh/enrollment.ts` 头部 + `admit`）。此后每个套接字都跑双向挑战——primary 对着钉入的密钥核验 proxy，proxy 对着钉入的 `upstream.primaryPubKey` 核验 primary（强制，没有裸 TOFU）——未 enroll/未认证的套接字在任何数据帧之前就被断开（`mesh/handshake.ts:399-454`）。
- **传输加密策略。** `requireEncryption`（`PLEXUS_MESH_REQUIRE_ENCRYPTION`）让 primary 以类型化的 `encryption_required` 原因拒绝明文 `ws` 的 proxy 隧道，只接受 `wss`（`mesh/handshake.ts:399-403`）。身份 ⟂ 加密：它门控的是*信道*，不是 Ed25519 身份——有效的钉入密钥走明文 ws 照样被拒。启用了它却没有 TLS 材料，启动时快速失败（`config.ts:562-567`）。

完整的 mesh 开发者模型见[联邦 mesh](/zh/architecture/mesh)。

## 8. 错误卫生也是安全属性

一次盲测发现：含糊的 auth 错误会*诱使*谨慎的 agent 去"到磁盘上找签名密钥、铸造自己的 token"。已提交的错误界面把**朝向受认可路径的可读性当作安全控制**：

- 带活跃会话但无授权的 `/invoke` 返回**结构化的** `approval_required`，附 `pendingId` + `approvalUrl` + `grantStatusUrl`，并明说*"所有者必须在 Plexus 控制台里批准此授权；agent 无法铸造自己的 token"*（`handlers.ts:692-712`）。
- 无会话的 `/invoke` 返回诚实的 `grant_required` 指引，指向 handshake → `PUT /grants`，直说低风险 first-party 读会自动授予，且 **"agent 无法铸造自己的 token"**（`handlers.ts:634-652`）。
- `.well-known` 广告的是授权**请求**入口（`grantRequestUrl` + 方法）和 enroll 兑换步骤，唯一被广告的前进路径就是那条被审计、经所有者批准的路径（`well-known.ts:53-105`）。没有任何响应、错误或使用说明暗示磁盘上有密钥、或 token 可以伪造。
- `GET /grants/status` 上的发起者/管理门保证铸出的 token 只交给创建该 pending 的会话（或管理密钥）——泄露的 `pendingId` 单独只换来 403，换不来 token（`handlers.ts:417-444`）。

原则：**让受认可的路径成为唯一能被发现的路径；措辞错误信息时，绝不把调用方引向伪造凭据或读密钥文件。**

## 9. 威胁模型 —— 范围内、范围外与红队结果

### 范围内（代码防御这些）

- 仅限网络/HTTP 的对手（agent，或启用 LAN 绑定后的 LAN 对端）试图够到管理平面：被所有 `/admin/api/*` 上的 connection-key 门与"HTTP 上不给密钥"规则挡住（`admin.ts:305-343`）。
- agent 试图自称另一个 agent：被 PAT→agentId 绑定挡住（§4）。
- agent 试图不经人类自授 write/execute，或给 extension cap 授权：被默认的 `UserConfirmAuthorizer` 挡住（`authorizer.ts:119-254`）。
- agent 试图让运行代码（`execute`）免摩擦/常驻：结构上不可能（`grant-service.ts:466`）。
- agent 凭据泄露：限定在该 agent 预先获授的 cap 内，可单独撤销（§5）。
- 恶意 mesh proxy 断言有利的信任姿态，或明文/MITM 隧道：被本地重新派生、钉入的双向 auth 与加密策略挡住（§7）。
- 静态秘密：enroll 码、PAT、mesh join token 在磁盘上只存 sha256 哈希（`0600` 账本文件）；PAT/码的明文只返回一次，永不可恢复（`agent-enrollment.ts:36-39, 225-236`）。

### 范围外（有据可查的假设——依赖 OS/部署，而非 Plexus 代码）

::: warning 同 UID 主机隔离
按 agent 独立 PAT 的隔离，假定 agent 进程**读不到管理员 connection-key 文件**。在同 UID 的主机上，agent 可以 `cat ~/.plexus/connection-key` 拿到完整管理员权威——能读所有者主目录的进程，Plexus 的进程内边界拦不住。缓解手段是 **OS 沙箱 / 容器化装置**（mesh/装置史诗；见
[`capability-appliance.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/capability-appliance.md)、
[`linux-confinement.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/linux-confinement.md)），把 agent 放进读不到密钥文件的隔离里。在那之前，"agent 以拥有 `~/.plexus` 的同一用户身份运行"就等于**对该 agent 的完整管理员信任**。
:::

- 主机被攻陷 / root、抓取活跃进程内存、旁路信道：对应用层而言都在范围外。
- **v1 部分加固，明确推迟：**
  - **密钥对 PAT。** v1 用 **bearer** PAT（为操作者的 `.env` 心智模型和简洁而选，ADR-4）。密钥对 PAT（持有证明——静态泄露的凭据没有私钥就毫无用处）是有据可查的 **v2** 加固项。
  - **技能自动更新**（不变量 V）——推迟；安全不依赖它（§6）。
  - **LLM 撰写的教学外壳** —— 即便到 v2，LLM 也只能撰写任务框定/示例，绝不撰写 auth/invoke 机制（不变量 VI）。

### 红队结果

已对提交的 auth 脊柱 + 管理/撤销路径跑过两轮对抗性红队评审。结论：**脊柱是干净的。** 唯一确认的 **HIGH**——`execute` capability 曾被允许在管理员给定的窗口下搭乘常驻授权——**已修复**；修复就是 `grant-service.ts:466` 处的 `def.kind === "once"` 钳制，在权威与建议两条路径上都生效，并在管理员 connect/bundle 流程里再次强制。

## 10. 开发者绝对不能做的事

- **不要把 connection-key（或任何持久秘密）烘焙进任何面向 agent 的东西**——技能、plugin、agent 能读的配置、HTTP 响应，一概不行。connection-key 仅限管理员；返回它的路由刻意不存在。
- **不要让技能的 auth/invoke 内核出自 LLM 或手工编辑。** 它必须是逐字节相同的受认可引擎，对着 Floor 神谕核验（不变量 VI，`verify-plugin.ts`）。让 LLM 撰写 auth 路径，可能发布出一份越权教程。
- **不要分发持久 PAT。** 发布一次性码（短命、单次使用），让 agent 自己兑换并存放 PAT。
- **不要把回环的 Host/Origin 守卫当作管理操作的认证**——它证明的是"一个被接受的权威"，不是"那个受信任的管理客户端"。管理路由必须门控在已核验的 connection-key 上。
- **不要新增 agent 能从 agent 平面够到的管理操作。** agent 平面的操作必须穿过授权器（挂起等所有者批准），绝不授予管理权威。
- **不要让 `execute` 常驻，也不要新增让管理员窗口覆盖 `once` 天花板的代码路径。** 保持 `chooseTrustWindow` 的钳制完好。
- **不要信任 mesh proxy 远端断言的信任姿态**（provenance/sensitivity/health）——一律本地重新派生。
- **不要用暗示"token 可伪造"或"磁盘上有密钥"的方式措辞 auth 错误。** 把调用方指向受认可的所有者批准路径。

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
| mesh enroll（Ed25519 钉入）、双向隧道 auth + 加密策略 | `mesh/enrollment.ts`、`mesh/handshake.ts` |
