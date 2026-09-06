---
title: "安全模型"
description: "Plexus 信任与授权模型的权威说明，每项论断均附代码引用。说明管理用的 connection-key 与调用用的 scoped token 这两种凭据，以及各 agent 独立的 PAT：connection-key 属于所有者，agent 不用它管理网关。常驻授权受敏感度约束，敏感度由 provenance、verb 和 transport 共同决定；execute 默认逐次授权，只有所有者明确为指定 agent 与 capability 开通常驻授权，才能突破这一默认上限。"
---
# 安全与信任模型 {#安全与信任模型}

::: tip 读者
本文写给正在决定要不要把真实资源托付给 Plexus 的人：每种凭据能做什么、泄露的代价是什么、授权究竟怎么流转，都需要确切答案。拥有者的管理权、agent 的身份和调用许可是三件不同的事。

下文说明代码实际执行的规则，关键论断附有已提交代码的 `file:line` 引用，便于核验。权威设计账本是 [`agent-skill-compile-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/agent-skill-compile-domain-model.md)：不变量 III 规定 PAT 按 agent 独立、`connection-key` 仅限管理员；不变量 IV 规定穿过 primary 的等价性；不变量 VI 规定模板化 auth 内核。除非另有说明，下文路径均相对于 `packages/runtime/src/`。
:::

## 五点看清信任模型 {#五句话说明白信任模型}

1. 管理边界由 `connection-key` 守住，它认证整个管理界面。agent 不持有这份拥有者凭据；在宿主隔离成立、agent 只能通过 HTTP 访问的前提下，agent 无法越过这条边界。

2. 每个 agent 用一次性 enroll 码兑换自己的持久 PAT，可以单独撤销。凭据泄露的影响限于该 agent 获授的 capability。握手只返回 session 和拥有者选定的子集清单，不直接授予调用权；取得 scoped grant/token 是另一道手续。

3. 能否常驻复用授权，要看 capability 的敏感度和拥有者的批准。敏感度由 provenance、verb 和 transport 共同决定。连接时，选中的 read 获得常驻授权，write 和 `execute` 默认逐次批准（`once`）。拥有者可为特定 agent + capability 显式开启常驻；`execute` 的常驻选项默认关闭，必须由拥有者显式开启，agent 不能自行解除限制。write 也可通过带真实信任窗口的请求批准或显式直接授权转为常驻。

4. PAT 证明真实的 `agentId`，客户端不能自称另一个 agent。管理员路径可以点名 `agentId`，是因为持有 `connection-key` 本身就是管理员权威，而不是因为身份字段可以随意相信。

5. 凭据各有用途，验证失败就拒绝访问。采用哈希存储的凭据不能与 scoped JWT 混为一谈，后者使用签名校验模型。agent 可见的界面（“Floor”）只说明认可的拥有者批准路径，不暗示磁盘上有可取用的密钥，也不暗示 token 可以伪造。

## 1. 凭据分类与信任边界 {#_1-凭据分类与信任边界}

Plexus 有两条信任边界，两侧各有一小组凭据。最重要的规则是：**connection-key 仅限管理员；agent 用按 agent 独立的 PAT 认证。** 身份、管理权和调用许可分开验证，不能拿一种凭据代替另一种。

![管理员的 connection-key 与各 agent 自己的 PAT 分属两条信任边界](/diagrams/two-trust-boundaries.png)

| 凭据 | 谁持有 | 授权范围 | 生命期 | 静态存储 | 泄露后的影响范围 |
|---|---|---|---|---|---|
| **管理员 connection-key** | 本地的人、桌面 app、`plexus` CLI；带外取得，绝不通过 HTTP 交付 | 完整管理平面 `/admin/api/*`：连接/撤销 agent、授权、暴露、源、mesh join token；以及 `handshake` 的管理员路径 | 长期有效，可轮换；轮换会使旧密钥引导的会话失效 | 由 `state.connectionKey.verify()` 验证；没有路由返回它 | 对本网关的全部管理员权限 |
| **管理密钥** | 同上 | 与 connection-key 是同一个秘密；在 `/admin/api/*` 和特权 agent 平面操作中，通过 `X-Plexus-Connection-Key` 出示 | 同上 | 同上 | 同 connection-key |
| **按 agent 独立的 enroll 码** | 特定 agent，随安装命令带外交付 | 一次性兑换该 agent 的 PAT | 15 分钟，单次使用（`DEFAULT_CODE_TTL_MS`） | 仅存 sha256 哈希 `codeHash` | 仅影响该 agent 的引导，且须在 15 分钟内、尚未兑换；兑换后即失效 |
| **按 agent 独立的 PAT**（`plx_agent_…`） | 特定 agent，自行存放，如 `.env` | 在 `handshake` 处以真实的 `agentId` 开启会话；已有合资格常驻授权可供后续取得 scoped token，但 PAT 本身不是调用许可 | 持久，无 TTL，直到撤销或重签发 | 仅存 sha256 哈希 `patHash` | 该 agent 预先获授的 capability；PAT 可单独撤销，不能进入管理平面 |
| **受限 token**（scoped token，签名 JWT，`tokenScheme: "plexus-scoped-jwt"`） | 获授的 agent | 只允许 `scopes` 内的 capability/动词，且会话须存活、jti 未撤销 | 单枚默认 15 分钟，钳制到 `[1m, 60m]`（`config.ts:36-40`） | 无状态签名 JWT；追踪 jti 以便撤销 | 限于特定 cap，单枚最长 60 分钟，可按 jti 单独撤销；仍可刷新时，滥用时间不以单枚到期为界 |
| **mesh join token** | 远端 proxy 操作者，带外取得 | 将一个 proxy workload enroll 进 mesh，并固定登记其 Ed25519 密钥 | 可选 TTL，单次使用 | 仅存 sha256 哈希 | 只准入一个 workload；按 §7，加入后的 capability 可见性和访问权均为零，直到拥有者主动暴露并授权 |

这里有三个不同的时钟。内存中的 session 存活 60 分钟，网关重启就消失；scoped token 有自己的短有效期；拥有者的信任窗口则记录授权决定有效多久。invoke 和 refresh 都要求 session 存活。默认 15 分钟不是滥用必然结束的时刻：仍满足刷新条件，就可能继续取得 token。被盗 token 本身不能生成 PAT 或新 session，刷新规则留到后文说明。

### 为什么 connection-key 仅限管理员（可自行核验） {#为什么-connection-key-仅限管理员-可自行核验}

首先，HTTP 不提供取钥匙的入口。`GET /admin/api/connection-key` 被刻意留空，不存在这条路由，也没有 payload 暗示该密钥存在（`admin.ts:409-416`）。代码针对的是只能通过 HTTP 访问的不受信任 agent：返回或暗示密钥，就给了它升级管理权限的路。因此拥有者密钥只走带外交付；这不意味着它能抵御可读取拥有者文件的进程。

其次，管理数据不能因为“只是读取”就绕过认证。总括中间件 `admin.use("/api/*", requireManagementKey)`（`admin.ts:407`）要求每条 `/admin/api/*` 数据路由核验 `X-Plexus-Connection-Key`，读写一视同仁（`requireManagementKey`，`admin.ts:383-399`）。仅靠回环的 Host/Origin 守卫不够：任何本地进程都能发送 `Host: 127.0.0.1`，网关也可能绑定在 LAN 接口上。

最后，凭据放在哪里，决定 `handshake` 走哪条认证路径。agent 在 `Bearer plx_agent_…` 头中出示 PAT，管理员在 JSON body 中出示 `{ "connectionKey": … }`（`handlers.ts:184-248`）。两条路径按凭据是否在场选择，互不穿透。PAT 路径绑定真实身份，返回 session 和拥有者选定的子集清单；清单不是调用许可，后续仍须取得 scoped grant/token，已有合资格常驻授权则无需再次询问拥有者。

## 2. 从连接到调用，授权怎样流转 {#_2-授权流-端到端}

流程从拥有者连接 agent 开始。拥有者通过 `POST /admin/api/agents/connect` 选定 capability 子集，生成有效期为 15 分钟的一次性 enroll 码，再由安装命令把码交给 agent。选中的 read 此时就获得按 `agentId` 保存的常驻授权；这次选择本身就是人的批准。write 和 execute 默认逐次批准，拥有者可以为特定 agent 与 capability 显式开启常驻，其中 execute 必须由拥有者开启，agent 不能自行解除限制。

![agent 的五步调用流程：discover、enroll、handshake、grant、invoke](/diagrams/protocol-loop.png)

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
                                                           (valid standing grant exempts this
                                                            agent/cap; authoritative admin
                                                            path bypasses this subset gate)
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

### （0）Discover：先找到入口

`GET /.well-known/plexus` 公开且免认证，不检查凭据。它返回网关身份、auth 与生命周期端点 URL、请求形状和 enroll 自描述，让 agent 知道下一步往哪里发送什么请求。`capabilitiesVia` 则指向取得 capability 清单的路径：先 enroll，再 handshake。

公开入口不提供完整清单，也绝不披露 connection-key 或其他秘密。capability 的发现发生在 handshake 之后，返回的 manifest 只含拥有者授权给该 agent、并且仍然暴露的子集，因此身份确认之前无法从这里枚举 capability（`buildPublicWellKnown`，`well-known.ts:168-177`）。

### （1）Enroll：用一次性码换取 PAT

`POST /agents/enroll` 以 `{ code }` 提交兑换请求。enroll 码本身就是这一步的凭据，接口绝不接受 connection-key（`handlers.ts:279-324`）。`redeemEnrollmentCode` 按顺序做五项检查，包括码的形状、是否已登记、是否处于 `PENDING` 状态以及是否仍在有效期内，全部通过才铸造 PAT；持久写入并完成 `fsync` 后，才把码标记为已消费（`agent-enrollment.ts:391`）。

失败发生在哪一步，决定怎样返回。body 畸形返回 400；码无效、已用过或已过期，返回 401，并附带类型化原因。持久写入失败则返回 500，码保持未消费，agent 可以重试。

成功时返回 `{ pat: plx_agent_…, agentId }`。PAT 明文只交付这一次，由 agent 按自己的方式保存。

### （2）Handshake：把会话绑定到真实身份

agent 向 `POST /link/handshake` 发送 `Authorization: Bearer plx_agent_…`。只要带了 `Bearer` token，网关就把它视为一次 PAT 认证尝试，必须验证通过。伪造、已撤销、过期或根本不是 PAT 的 bearer 都返回 401，不创建会话，也不会退到 connection-key 管理员路径。

会话绑定到 PAT 核验出的 `agentId`，任何 `client.agentId` 都被强制改写（`handlers.ts:197-215`，`sessions.ts:74-93`）。返回的 `{ sessionId, manifest, … }` 让 agent 有了会话，也知道自己可见的 capability；具体调用所需的 scoped grant/token，仍要在下一步取得。

### （3）Grant：为具体 capability 取得许可

agent 带上 `X-Plexus-Session: <sess>`，向 `PUT /grants` 提交 `{ grants:{ id:"allow"}}`。未知的 capability id 在触及授权服务之前就返回 400，不会静默跳过，也不会生成空 token（`handlers.ts:380-387`）。

对纳入子集模型的 agent，子集外请求通常直接拒绝并记入审计，不进入待批准队列。图中的 `no → DENIED` 是简写，不能当作无条件分支：拥有者已为该 agent 的该 capability 签发过仍然有效的常驻授权时，请求会通过这道子集检查，图中的拒绝分支不适用；所选子集与常驻授权存储并不是同一回事。连接时定义子集的权威管理员路径则不同，它本来就不受这道子集检查约束（`grant-service.ts:613-646`）。

子集内若已有常驻且未过期的授权，就跳过授权器，直接取得 token，无须再问拥有者。否则交给 `UserConfirmAuthorizer`：低风险的 first-party read 自动放行，write/execute 或 extension 请求进入待批准状态，返回 `grant_pending_user`（`authorizer.ts:218-280`）。具体授权规则见 §3。

不过，拥有者还可以单独关闭暴露。这个决定同时阻断发现、授权和调用；即使常驻授权仍有效，也不能越过它。

### （3b）Approve：由拥有者处理待批准请求

拥有者在控制台通过 `POST /admin/api/pending/:id` 提交 `{ action:"approve", trustWindow }`。批准后签发 token；符合常驻条件的授权会持久保存。write 可通过带真实信任窗口的批准或显式直接授权转为常驻，execute 仍须满足拥有者显式开启常驻的条件。

agent 轮询 `GET /grants/status?pendingId=…`，批准后取得 `{ state:"approved", token }`。轮询接口也检查身份，只允许请求发起者或持管理密钥的调用者查询，不能凭一个 `pendingId` 取走别人的结果（`handlers.ts:417-444`）。

### （4）Invoke：检查通过后才执行

agent 向 `POST /invoke` 提交 `{ id, input }`，用 `Authorization: Bearer <scoped-jwt>` 出示调用许可。管线先验证 token 签名、jti 是否撤销和会话是否存活，再检查暴露状态及约束，最后分发调用。拒绝会记入审计，不会静默丢弃（`handlers.ts:585-626`）。

顶层被禁用、也就是“未暴露”的 capability，即便持有效 token 也会被拒。暴露检查通过，原本有效的授权才可能允许访问；其余约束也通过后，调用成功返回 `{ id, ok:true, output }`。

## 3. 常驻授权、信任窗口与敏感度 {#_3-常驻授权、信任窗口与敏感度}

拥有者可以把批准保存为一条持久记录，让 agent 后续在授权作用域内、信任窗口有效时复用，无须每次再请人批准。这就是常驻授权。能否常驻，要看 capability 的敏感度和拥有者的批准；敏感度由 `provenance`、`verb` 和 `transport`，也就是来源、动词和传输方式共同决定。

下面的推荐窗口映射按来源和动词取默认值，不代表完整的风险判断。也不能仅凭 capability 放在远端，就认定它只能逐次批准。

### 敏感度怎样对应到信任窗口 {#敏感度-→-信任窗口}

`recommendedTrustWindowFor(provenance, verbs, table)`（`capability-registry.ts:163-173`）给出两类默认值。

在这套映射里，只有 `execute` 默认逐次批准：任何来源都返回 `once`。这里判断的是动词，mesh 挂载不会改变动词，所以 mesh 的 `execute` capability 与本地的 `execute` capability 一样，得到的都是 `once`。没有哪项 capability 仅仅因为位于远端就得到 `once`（`capability-registry.ts:168-169`；ADR-5／不变量 IV）。

`read` 和 `write` 则按来源类别取得可常驻的默认窗口，值来自 `DEFAULT_TRUST_WINDOWS`（`config.ts:67-74`）：

| 类别 | read | write |
|---|---|---|
| first-party | 7d | 1d |
| managed | 7d | 1d |
| extension | 1d | 1d |

这里的 `extension:write` 是 `1d`，确实是一个常驻窗口，不是 `once`。早期代码曾把 mesh／extension capability 硬编码为 `once`，把远端位置与只能逐次批准混在了一起；这个行为已经移除（`config.ts:56-66`）。

表中有常驻窗口，不等于连接时就会自动创建常驻授权。连接时，选中的 `read` 获得常驻授权，有副作用的 `write` 和 `execute` 默认逐次批准。拥有者可以为特定 agent 与 capability 显式开启常驻；`write` 也可以在待批准请求获批时取得真实信任窗口，或通过显式直接授权转为常驻，并不都要经过下面专属于 `execute` 的开启步骤。

### 为什么 `execute` 默认只能逐次批准（可自行核验） {#execute-→-once-的默认天花板-可自行核验}

`chooseTrustWindow`（`grant-service.ts:461-506`）是决定实际生效窗口的唯一入口。它先把匿名 agent 限在 `once`，再检查 capability 自身的默认窗口：

```ts
// grant-service.ts (chooseTrustWindow)
if (this.isAnon(opts.agentId)) return { kind: "once" };     // ~476  anon:* capped
if (def.kind === "once") {                                  // ~484  execute: per-use DEFAULT
  if (!optedStanding) return { kind: "once" };              //       no owner opt-in → hard floor
  // opted in: honor the admin window; absent → until-revoked (or 7d when disallowed)
  …
}
```

第一道守卫使 `anon:*` 始终只能逐次批准。第二道守卫检查 `def.kind === "once"`：capability 的敏感度给出 `once` 默认值时，`execute` 正是这种情况，只要没有拥有者的显式开启，就仍然返回 `once`。请求什么窗口、这次选择是否带有管理员权威，都不能单独改变这个结果。

非匿名 agent 要让 `execute` 常驻，必须由拥有者在连接时，为那一对特定的 `(agent, capability)` 显式开启。这个选项默认关闭，须双重确认，并可独立撤销（ADR-023）。agent 建议更长的窗口不算开启；管理员单独选择常驻窗口，也不能代替这一步。

这项开启经 `agentSubsets.isStanding` 查询，只能由拥有者的连接流程写入：`core/admin.ts` 中 `POST /admin/api/agents/connect` 按 capability 接受通用的 `standing` 字段，旧 key `standingExecute` 仍作为兼容别名接受。agent 自己永远不能设置它。开启后，`execute` 授权遵循管理员给出的权威窗口；未给出窗口时，常驻到撤销，即 `until-revoked`。如果策略禁用 `until-revoked`，则钳到 `7d`。

`read`／`write` 的默认值不是 `once`，不会触发这个分支，合法的管理员窗口可以生效。上述钳制同时覆盖管理员的权威路径和 agent 的建议路径，所有授权铸造点都汇入 `chooseTrustWindow`（`grant-service.ts:666, 1119, 1476`）。

### 其他常驻授权规则 {#其他常驻授权规则}

第一次批准和后续复用是两回事。`write` 或 `extension` capability 的请求通过授权范围等检查后，若没有可复用的授权，就会挂起，等拥有者批准。`hasPriorApproval` 只对常驻且未过期的授权返回 `true`（`grant-service.ts:394-402`，`isStandingAndUnexpired`）；`once` 或已过期的授权绝不短路。有了合资格的常驻授权，后续请求在作用域和约束允许的范围内，就不用再请人批准。

连接时选中的 capability 集合，与保存下来的常驻授权记录，要分开看。`write` 也可以在待批准请求获批时取得真实信任窗口，或经拥有者显式直接授权转为常驻，连接时的选择不是唯一途径。拥有者创建的有效常驻授权，还能让原先未选中的 capability 进入可见、可请求的授权范围；这仍须通过暴露等检查，agent 不能自行制造这个例外。

匿名会话没有这条持久复用的路。没有已核验 `agentId` 的会话使用 `anon:<sessionId>`，始终只能取得 `once`，不会获得持久的常驻授权。`chooseTrustWindow`（`grant-service.ts:~476`）和授权器的窗口选择（`authorizer.ts:213-215`）都执行这项限制。

窗口由谁提出，也有区别。agent 可以通过 `PUT /grants` 建议窗口，但只能缩短，不能越过类别上限去延长（`shorterWindow`，`grant-service.ts:88-90`，应用于 `:505`）。管理员或人类批准时选定的窗口才是权威值。不过，未开启常驻的 `execute` 仍受 `execute→once` 钳制，`until-revoked` 也仍受策略限制。

约束只收窄。带约束的常驻授权，可以直接复用来满足未填写约束的请求，或约束与它深度相等的请求；更宽或不同的请求则不能这样复用。这里的“未填写”不等于取消限制：铸出的 token 总是携带常驻授权本身的约束，绝不采用被拓宽的约束（`effectiveConstraint`，`grant-service.ts:428-434`）。

批准可以复用，会话却不会因此延长。`invoke` 和 `refresh` 都要求 session 存活；session 存在内存中，寿命为 60 分钟，网关重启就消失。`refresh` 还要求有合资格、仍在信任窗口内的常驻授权，`once` 不能刷新。只要同一会话仍符合刷新条件，就可能继续取得 token，所以单枚 token 到期不一定意味着访问结束。被盗的 scoped token 本身不能创建 PAT，也不能开启新 session。

## 4. 身份怎样核验 {#_4-身份与防伪}

`feat/agent-skill-compile` 之前，客户端可以自行填写 `agentId`，声称自己是任何 agent。PAT 堵住了这个冒名入口。在 `handshake` 处，网关用 `Bearer` token 查询 enroll 账本：找到 `patHash` 匹配的活跃记录，`verifyPat(pat)` 才返回其中的 `agentId`；否则返回 `null`（`verifyPat`，`agent-enrollment.ts:438`）。会话随即绑定到查出的身份，客户端提供的 `agentId` 被核验值覆盖（`handlers.ts:214-215`）。

这个核验结果还要明确传进会话存储。给 `open(bootstrapKey, client, agentId)` 显式传入已核验的 `agentId`，会话存储就使用这个值，并覆盖 `client.agentId`。客户端自己填的 `client.agentId` 只作审计元数据，对公开调用方绝不单独构成可信身份；字段同名，也不意味着客户端的声明就是认证结果（`sessions.ts:33-46, 74-93`）。

因此，知道一个 `agentId`，并不等于拥有它的凭据。不带 PAT，仅凭这个字符串点名某个 agent，只会得到 401，不会创建会话（`handlers.ts:197-209`）。PAT 采用静态哈希存储，按 agent 独立核验、可撤销，但它仍是 bearer 凭据：拿到有效 PAT 的人仍可能再次出示它来认证。因此，不能把 PAT 校验说成完整的防重放。要求调用者证明持有相应密钥的凭据机制，仍属于延后实现的加固。

管理员路径可以点名 `agentId`，依据则是拥有者委托的管理权。控制台“连接一个 agent”时，正是通过 body 中的 `connection-key`，指定这次连接代表哪个 agent。这不是伪冒：持有 `connection-key` 就拥有管理员权威，而 agent 没有它，够不到这条路径（`handlers.ts:174-182`，`admin.ts:668`）。这个判断仍以宿主隔离成立、agent 只能通过 HTTP 访问为前提，不能用来保证可读取拥有者文件的进程也拿不到管理凭据。

普通连接的身份由 PAT 对应的活跃记录确定，管理员代行的身份由管理权明确指定。会话里的 `agentId` 因而有可核验的来处，按 agent 保存的授权与撤销操作才能指向确定的身份。

## 5. 撤销与影响范围 {#_5-撤销与爆炸半径}

撤销一个 agent，会立即使它的访问授权和活跃会话失效，其他 agent 不受影响。管理员路由 `POST /admin/api/agents/revoke`（`admin.ts:838`）按顺序处理三处记录。

先撤销 enroll 记录和 PAT。`agentEnrollment.revoke(agentId)` 把记录改为 `revoked`，再把对应的 `patHash` 从活跃索引中移除。PAT 当即失效，之后再拿它做 handshake，验证一律失败，不会建立会话（`agent-enrollment.ts:457`）。

接着处理已经打开的会话。`sessions.invalidateByAgentId(agentId)` 使绑定到这个 `agentId` 的所有活跃会话失效，并返回它们的 `jti`；这些 `jti` 随即被撤销。因此，撤销不用再等约一个会话生命期才生效。管理员只须知道 `agentId`，不必找回当初建立会话的原始 PAT，就能按身份撤销这些会话（`sessions.ts:126-139`，`admin.ts:871-877`）。

最后清除常驻授权和剩余的活跃 token。`grants.revokeAllForAgent(agentId)` 删除该 agent 的持久授权，使 refresh 无法再据此铸造 token；同时给每一对 `(agentId, cap)` 留下撤销墓碑，再撤销剩余的被追踪 `jti`（`revokeAllForAgent`，`grant-service.ts:1396`）。

每一步都以 `agentId` 为键。第二个 agent 的 enroll、会话、授权分毫不动。每个 agent 各用一份 PAT，实际好处就在这里：可以只停掉一个 agent；共享凭据一旦轮换，所有使用者都会被切断。这里保证立即失效的是授权与活跃会话，并不保证回滚已经完成的副作用，也不保证取消所有已经分发的操作。

墓碑防止刚撤销的授权又被自动补回来。对于刚被撤销的 `(agentId, cap)`，平时会自动放行的低风险读也会转为挂起，等待人类批准（`authorizer.ts:266-271`，`ctx.revokedTombstone`）。agent 即使还在运行，再次请求也不能静默恢复访问。只有新一次人类批准，才会解除墓碑。

几条相关路径撤销的对象不同。agent 可以出示自己的 scoped token，交回这枚 token；这是 `revoke` 的路径 b（`handlers.ts:512-533`），并不等于撤销整个 agent。替别人按 `jti` 撤销，或按 bundle 撤销，都需要管理密钥（`handlers.ts:536-539`）。

拥有者轮换 `connection-key`，则会使旧密钥引导的会话失效（`sessions.invalidateByKey`，`sessions.ts:115-124`）。PAT 引导的 agent 会话建立在各自的 PAT 之下，与管理密钥轮换刻意解耦，不会被这次轮换连带切断。在凭据撤销这件事上，它们随各自的 PAT 一同失效；会话自身的到期和重启失效规则仍然适用。

撤销会删除 grant 行，授权历史则留在审计日志里。持久记录删掉，refresh 就失去了再次铸造 token 所需的授权依据；要重放“曾经授权过什么”的历史，应当读取审计轨迹，不能依赖 grant 存储。每条授权生命周期审计事件都携带成员的 `bundleId`，在行删除前就已写入。因此，一个任务 bundle 从 pend、allow、再铸到撤销的完整过程，在审计保留期内仍可查阅，不随 grant 行一起消失。这项保证，以及授权模型为任务级、企业级使用保留的其他扩展位置，记录在[授权可扩展性](/zh/architecture/extensibility)（ADR-020）中。任务 bundle 后端仍在，但 1.0 控制台尚未提供 bundle 管理，成员授权在其中显示为普通常驻授权。

### 有些暴露范围，在配置时就已定下 {#有时候-爆炸半径是配置时的选择-不是运行时的}

`browser-control` 的三种模式暴露完全一样的 capability，但能触及什么，不能只看这些名字。浏览器是由 Plexus 用空 profile 启动，还是拥有者自己已经登录的那个，暴露范围很不一样。拥有者在配置时就作出了这个选择，早于任何授权请求。

Chrome 自己的同意也收窄不了这个范围：权限对话框授权的是那个浏览器，不是一组站点。因此，这里必须另行强制执行域名边界。每次动作之前，都针对真实目标 URL 重新校验；拥有者一个域名都没填时，就按 fail-closed 拒绝访问。配置方法见[暴露一个 source](/zh/guide/first-party-sources#browser-control)。

## 6. 编译产物怎样守住安全边界 {#_6-编译模型安全-会自我集成的技能}

Plexus 把资源作为 agent 可用的原生产物交付，v1 的形式是一个 Claude Code plugin。产物说明怎样接入网关，所依据的权限仍来自网关，安装它不会增加调用权。HTTP Floor 无需 plugin 也能使用；必须经过 launcher 的要求只适用于编译集成，由 launcher 包装受认可的凭据生命周期。

不变量 VI 约束这份产物：auth/invoke 内核一律由确定性模板生成，可以对照 Floor 核验，绝不由 LLM 撰写；分发出去的文件也绝不写死任何长生命期秘密。分发产物不含持久 PAT，也不含管理员密钥。

安装时仍然需要交付凭据。短命、单次使用的 enroll 码可以随当次安装命令下发，供 agent 兑换自己的 PAT；这不允许把码嵌进已发布产物。PAT 在兑换时恰好返回一次，由 agent 自行存放，绝不持久化进已发布文件。“兑换→存放”的契约见 `well-known.ts:119-129` 和 `agent-enrollment.ts:122-128`。

核验以加固后的 Floor 自描述为依据。公开 `.well-known` 说明网关身份、发现入口、认证与 enrollment 流程、端点及请求形状，不公开凭据，也不枚举完整 capability 目录。按 agent 过滤的 manifest 要在认证 handshake 后取得，而且清单本身不授予调用权。有效授权范围包括拥有者显式选定的子集，也包括拥有者创建、未过期且通过当前 `connection-key` epoch 校验的常驻授权；清单还要经过暴露检查，agent 不能自行制造这个例外。

构建时，`integration/verify-plugin.ts` 沿五条独立的轴检查渲染出的 plugin，对照 Floor 返回结构化的通过或失败结果：

1. 认可的 auth 内核。通过 sha-256 比对，核验 `bin/plexus` 与已提交的认可引擎 `tools/plexus-cli/plexus` 逐字节相同，确认认证与调用管道未经手工或 LLM 改动。

2. 不内置秘密。检查每个分发文件，不能含有 `plx_agent_…` PAT、写死的 `plx_enroll_…` 码，或调用方提供的持久凭据。管理员 `connection-key` 也在检查范围内，调用方可以通过 `forbiddenSecrets` 传入这类禁止出现的秘密。安装命令临时携带一次性码，不豁免已发布文件的检查。

3. capability 引用范围。技能引用的每个 capability 都必须在 Floor 广告的目录中；提供了 cap 集合时，还必须属于该 plugin 编译所针对的集合。技能不能引用 Floor 未广告的 cap。这里的目录不能误读为公开 `.well-known` 枚举的完整清单，也不能把最初选中的集合当成有效授权范围的唯一来源。

4. 认可的接入流程。plugin 指示的 enroll、handshake、invoke 必须符合 Floor 的 `auth.enrollment` 和 `requestShapes`。任何指令文件都不能另编一条 auth 路径，包括指示 agent 读取磁盘上的管理员密钥或伪造 token。

5. 正文完整性。手写的 skill 正文由 `SKILL_BODY_SHA256_PIN` 锚定：源文的哈希必须等于锚定值，渲染出的 `SKILL.md` 必须逐字包含该正文。教学外壳有任何改动，都必须先经过有意识的重新审查，再更新锚定值，才能出货。

这也说明了不变量 V 为什么成立：技能只是 Floor 上的一层投影，授权由网关实时执行。技能陈旧或生成有误，都不能越过 Floor 的授权。引用已撤销的 cap，invoke 会被网关拒绝；过时的指引也可能让 agent 走错步骤、无法完成任务。按不变量 V，这类陈旧或误生成最坏只是外观问题，产物不会因此取得额外权限。

自动更新负责指引的新鲜度和 UX，授权安全不以它为前提。v1 对这一部分只作了部分实现，自动更新明确推迟到 v2。

## 7. mesh 的信任边界 {#_7-mesh-信任}

从 mesh 节点路由来的 capability，仍由 primary 检查 agent 的授权。agent 使用同一个 PAT，经过同一个授权器，遵循同样的信任窗口规则；远端位置只是路由细节，不另开授权路径。这就是“穿过 primary 的等价性”（不变量 IV／ADR-5）。等价指的是共用 primary 的策略机制，具体结果仍取决于本地派生的来源等属性。

因此，primary 不能照单接受 proxy 对信任姿态的声明。挂载远端 workload 的 cap 时，它会剥掉 proxy 断言的全部 `provenance`、`sensitivity`、`recommendedTrustWindow` 和 `health`，在本地重新派生。挂载的 cap 归为 `extension` 来源，属于最严格类别；敏感度仍由来源、动词和传输方式共同决定。恶意 proxy 即使声明 `provenance:"first-party"`，也骗不过授权器（`capability-registry.ts:956-973`）。

这样的远端读，若没有可复用的、由拥有者创建的合资格常驻授权，通过其余授权检查后，就会因 `extension` 来源而挂起等待拥有者批准，授权器绝不自动放行。已有合资格常驻授权时，前文所述的复用检查发生在授权器之前：只有信任窗口、作用域和约束都允许，才能沿用拥有者已经作出的批准取得许可，无须再次询问拥有者。无论本次批准还是复用已有批准，都不能免除暴露和会话有效性等检查。

workload 能否接入隧道，还要单独核验。proxy↔primary 与 agent↔primary 是彼此分离的边界。加入时，一次性 join token 用来准入 workload，并固定登记它的 Ed25519 公钥；后续双向挑战中的 `cnonce` 和 `snonce` 是每次连接另行交换的值，与 join token 分开。join token 单次使用，静态存储只保留 sha256 哈希（`mesh/enrollment.ts` 头部及 `admit`）。

此后，每个 socket 都必须完成双向挑战。primary 用已固定的公钥核验 proxy；proxy 用已固定的 `upstream.primaryPubKey` 核验 primary。后者是强制检查，绝不退回首次使用时信任的 TOFU。任何未 enroll 或未认证的 socket，都会在传递任何数据帧之前被断开；认证失败，连接就关闭（`mesh/handshake.ts:399-454`）。

身份核验通过，信道也未必合格。传输加密有独立策略：启用 `requireEncryption`（`PLEXUS_MESH_REQUIRE_ENCRYPTION`）后，primary 只接受 `wss`，明文 `ws` 的 proxy 隧道会以类型化原因 `encryption_required` 被拒绝（`mesh/handshake.ts:399-403`）。这项策略检查信道是否加密，独立于 Ed25519 身份认证；即便密钥有效且已经固定，走明文 `ws` 仍会被拒。启用了它却没有 TLS 材料，启动时就会快速失败（`config.ts:645-650`）。

当前单 primary mesh 的加入、挂载、转发和撤销均已实现。完整的 mesh 开发者模型见[联邦 mesh](/zh/architecture/mesh)。

## 8. 错误措辞也是安全属性 {#_8-错误措辞也是安全属性}

一次盲测发现，含糊的 auth 错误会把原本谨慎的 agent 引向“到磁盘上找签名密钥、铸造自己的 token”。错误响应会影响调用方接下来做什么。已提交的响应设计因此把受认可路径是否清楚、可读，也当作安全控制。这里的工程要求很具体：让受认可的路径成为唯一能被发现的路径；错误措辞绝不把调用方引向伪造凭据或读取密钥文件。

调用 `/invoke` 时，已有活跃会话、仍在等待授权的 agent 会收到结构化的 `approval_required`，其中带有 `pendingId`、`approvalUrl` 和 `grantStatusUrl`。响应明确说明：拥有者必须在 Plexus 控制台批准这次授权；agent 无法铸造自己的 token。下一步在哪里、由谁来做，都写在响应里（`handlers.ts:692-712`）。

没有会话的调用方得到的是 `grant_required`。这时还没到等待批准的阶段，响应指引它先完成 handshake，再通过 `PUT /grants` 请求授权，并同样明说 agent 无法铸造自己的 token（`handlers.ts:634-652`）。

这份指引也说明，低风险 first-party 读会自动授予。这个默认行为仍受授权范围和暴露控制约束：capability 必须属于拥有者选定的子集，或已有拥有者创建、未过期且通过当前 `connection-key` epoch 校验的常驻授权；关闭暴露后仍会被拒绝。agent 不能自行制造子集外的例外。刚被撤销、留有撤销墓碑的低风险读，也仍须重新批准。

公开的 `.well-known` 把这条路写全：`grantRequestUrl` 给出授权请求入口，广告的方法是 `PUT`，对应 `PUT /grants`；enroll 步骤则说明通过 `POST /agents/enroll` 用一次性码兑换自己的 PAT。对外公布的前进路径只有这条受审计、经拥有者授权的流程，已有合资格批准可以按规则复用。任何响应、错误或使用说明，都不暗示磁盘上有可取用的密钥，或 token 可以伪造（`well-known.ts:60-129`）。

`grantStatusUrl` 指向的轮询接口还守着凭据交付边界：批准后签发的 token 要从这里交给调用方。`GET /grants/status` 因而核验发起者身份或管理密钥，只把 token 交给创建该 pending 的会话，或持有管理密钥的调用者。单独泄露一个 `pendingId`，只能换来 403，换不来 token（`handlers.ts:417-444`）。

## 9. 威胁模型：范围内、范围外与红队结果 {#_9-威胁模型-——-范围内、范围外与红队结果}

### 代码已覆盖的威胁 {#范围内-代码防御这些}

- 只具备网络／HTTP 访问能力的对手（agent，或启用 LAN 绑定后的 LAN 对端）试图进入管理平面：所有 `/admin/api/*` 都检查 `connection-key`，HTTP 也不提供这份密钥（`admin.ts:383-416`）。
- agent 试图冒充另一个 agent：PAT 绑定真实的 `agentId`，不能靠客户端填写的身份蒙混过关（§4）。
- agent 既无人类批准，也无可复用的合资格常驻授权，却试图自授 `write`／`execute` 权限，或给 `extension` cap 授权：默认的 `UserConfirmAuthorizer` 会阻止这种自行授权；已有合资格常驻批准仍可按规则复用（`authorizer.ts:180-280`）。
- agent 试图靠自己让运行代码的 `execute` 免去逐次批准、成为常驻：机制上做不到。只有拥有者能在连接时，为特定的 `(agent, capability)` 开启常驻 `execute`（`chooseTrustWindow`，`grant-service.ts:461-506`）。
- agent 凭据泄露：影响限于该 agent 预先获授的 cap，可以单独撤销该 agent 的凭据和授权，不牵连其他 agent（§5）。
- 恶意 mesh proxy 谎报有利的信任姿态：由本地重新派生阻止。密钥固定的双向 auth 核验双方身份，防止中间人冒名；信道加密另行检查。只有启用 `requireEncryption` 策略，才会拒绝明文 `ws` 隧道，即使对端持有有效的固定密钥也一样（§7）。
- 账本中的 enroll 码、PAT 和 mesh join token：磁盘上只存 sha256 哈希，账本文件权限为 `0600`。PAT／enroll 码的明文只返回一次，永不可恢复；这项哈希存储保证只针对这里列出的凭据（`agent-enrollment.ts:36-39, 225-236`）。

### 应用层之外：依赖 OS 与部署的隔离条件 {#范围外-有据可查的假设——依赖-os-部署-而非-plexus-代码}

::: warning 同 UID 主机隔离
每个 agent 各用一份 PAT，能守住应用层授权边界的前提是：agent 进程读不到管理员 `connection-key` 文件。这是拥有者的管理凭据；一旦能读到它，按 agent 区分权限的边界就拦不住这个进程。

在没有额外隔离的同 UID 主机上，agent 可以执行 `cat ~/.plexus/connection-key`，拿到完整管理员权威。能读取拥有者主目录的进程，不受 Plexus 进程内边界的保护。应用层检查凭据，不能替 OS 决定另一个进程能读哪些文件。

这需要 OS 沙箱或容器化装置，把 agent 放进读不到密钥文件的环境。相关方案属于 mesh／装置史诗，见 [`capability-appliance.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/capability-appliance.md) 和 [`linux-confinement.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/linux-confinement.md)。这些隔离工作仍待落实，不能因为已有按 agent 独立的 PAT，就当作隔离已经完成。

在这样的隔离落实之前，“agent 以拥有 `~/.plexus` 的同一用户身份运行”，就等于对该 agent 的完整管理员信任。
:::

主机被攻陷、对手取得 root 权限、抓取活跃进程内存，以及旁路信道攻击，都在应用层威胁模型的范围外。这里的保障依赖 OS 与部署环境，不能由 Plexus 的凭据校验补上。

v1 只完成了部分加固，以下三项明确留待后续处理，各自的用途也不同。

密钥对 PAT 是有据可查的 v2 加固项。v1 选择 bearer PAT，是为了贴合操作者把凭据放进 `.env` 的使用习惯，并保持简单，理由记录在 ADR-4。密钥对 PAT 则要求持有证明：即使静态保存的凭据泄露，没有相应私钥也毫无用处。当前的 bearer PAT 尚不具备这项保证。

技能自动更新也已推迟，对应不变量 V。它负责让指引保持新鲜，安全不依赖它；授权仍由网关执行，具体原因见 §6。不能把未来的自动更新当成当前安全边界的一部分。

LLM 撰写的教学外壳同样属于后续工作，而且到 v2 也有明确限制：LLM 只能撰写任务说明和示例，绝不撰写 auth/invoke 机制。这是不变量 VI 对未来实现的约束。

### 红队评审记录 {#红队结果}

文档记录了针对当时提交的 auth 主干及管理／撤销路径的两轮对抗性红队评审，报告结论是“主干是干净的”。这说的是当时受评的实现和路径，不能据此视为对当前版本的独立认证，也不能推及所有部署环境。

当时唯一确认的 HIGH，是 `execute` capability 曾能在没有任何拥有者决定的情况下，借管理员给定的窗口搭上常驻授权。报告记录该问题已修复：`chooseTrustWindow` 中的 `def.kind === "once"` 钳制（`grant-service.ts:484`）同时作用于管理员的权威路径和 agent 的建议路径，不能仅凭给出一个常驻窗口就越过逐次批准限制。

ADR-023 保留了这道默认钳制，并加入唯一受认可的解除方式：由拥有者在连接时，按 `(agent, capability)` 逐项开启常驻 `execute`，且须双重确认。后来的常驻选项没有撤掉默认守卫；没有这项拥有者决定，`execute` 仍受 `once` 限制，agent 自己提出更长窗口也不能解除它。

## 10. 维护时逐项检查 {#_10-开发者绝对不能做的事}

- 不要把 `connection-key` 或任何持久秘密写死在面向 agent 的技能、plugin、配置或 HTTP 响应中。`connection-key` 仅限管理员，返回它的路由刻意不存在。
- 不要让 LLM 撰写技能的 auth/invoke 内核，也不要手工修改它。内核必须与受认可引擎逐字节相同，并通过 `verify-plugin.ts` 对照 Floor 核验，这是不变量 VI 的要求。让 LLM 编写 auth 路径，可能把越权教程一同发布出去。
- 不要分发持久 PAT，也不要把 enroll 码嵌入已发布产物。安装时可以通过当次安装命令临时交付短命、单次使用的 enroll 码，让 agent 自行兑换并存放 PAT。这种临时交付不允许把码或兑换得到的持久凭据留在发布文件里。
- 不要拿回环的 Host/Origin 守卫代替管理认证。它只证明请求使用了“被接受的权威”，不能证明调用方就是“受信任的管理客户端”。管理路由必须核验 `connection-key`，通过后才能执行。
- 不要新增 agent 能从 agent 平面调用的管理操作。agent 平面的操作必须经过授权器：已有合资格批准可以按规则复用，需要拥有者批准时就挂起等待，绝不能借这条路径取得管理权。
- 不要让任何 `execute` capability 在未经拥有者按 `(agent, capability)` 逐项显式开启时获得常驻授权。选项默认关闭，连接时须双重确认，而且只能由拥有者开启。保留 `chooseTrustWindow` 中未开启便限制为 `once` 的守卫；agent 提出的窗口始终只是建议，只能缩短，不能延长或解除限制。
- 不要相信 mesh proxy 从远端报来的信任姿态。挂载时剥掉远端声明的 `provenance`、`sensitivity`、`recommendedTrustWindow` 和 `health`，由本地重新派生。来源在本地归为 `extension`；健康状态经 mesh health provider 取得，并保留 `reported` 自述标记。远端声明不能触发本地低风险读的自动批准，拥有者仍可授予符合条件的常驻访问。
- 不要在 auth 错误中暗示“token 可伪造”或“磁盘上有密钥”。错误应明确指向受认可的拥有者批准路径，让调用方知道接下来该走哪一步。

### 附录 —— 关键文件 {#附录-——-关键文件}

| 关注点 | 文件 |
|---|---|
| enroll 账本：码兑换 PAT、静态哈希存储、单次使用与撤销 | `core/agent-enrollment.ts` |
| handshake 的两类凭据：PAT 认证 agent，connection-key 认证管理员 | `core/handlers.ts`（`handshake`、`enrollAgent`） |
| 会话绑定，以及 `invalidateByAgentId`／`invalidateByKey` | `core/sessions.ts` |
| 授权与常驻：`hasPriorApproval`、`chooseTrustWindow`、`revokeAllForAgent` | `core/grant-service.ts` |
| 敏感度与窗口的对应关系、`recommendedTrustWindowFor`、mesh 挂载时重新派生信任姿态 | `core/capability-registry.ts` |
| `DEFAULT_TRUST_WINDOWS`、窗口钳制、`requireEncryption` 快速失败 | `config.ts` |
| 管理密钥校验、agent 的连接与撤销 | `core/admin.ts` |
| 公开的 Floor 与 enroll 自描述 | `core/well-known.ts` |
| 挂起、自动批准与撤销墓碑策略 | `auth/authorizer.ts` |
| 构建时校验技能与 Floor 是否一致（不变量 VI） | `integration/verify-plugin.ts` |
| mesh enroll 的 Ed25519 密钥固定、隧道双向 auth 与加密策略 | `mesh/enrollment.ts`、`mesh/handshake.ts` |
