---
title: 联邦 mesh
description: Plexus 联邦 mesh 的开发者模型：一个 primary 网关、若干向外拨号的 proxy、来源即地址，以及把它们串起来的 enroll / 隧道 / invoke 转发机制。
---

# 联邦 mesh —— 开发者模型

::: tip 状态
**已实现**（P1–P5 mesh 系列开发任务）。本文是 DDD SSOT [`federated-mesh-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/federated-mesh-domain-model.md) 的配套文档，供运维人员和扩展开发者使用。那份文档定义*语言与不变量*，本文则把保证系统正常运作的每条关键不变量对应到**确保它成立的代码**，标出 `file:line`，并说明从哪里接入扩展。两份文档有分歧时，以代码为准，本文会注明差异（§13）。

下文代码根目录：除非另有路径说明，均为 `packages/runtime/src/mesh/`。
:::

## 五句话说明白心智模型

1. 一个 **mesh** 由恰好一个 `primary` 网关（agent 的唯一入口：持有授权、运行授权器、汇聚审计）和任意数量的 `proxy` 网关组成；proxy 挨着真实服务运行，**向外拨出**一条通往 primary 的持久隧道（NAT 所迫：proxy 主机不开任何入站端口）。
2. proxy **只 enroll 一次**，凭 primary 带外铸造的 256 位一次性 join token；enroll 把 proxy 的 Ed25519 公钥固定写入持久账本（`enrollments.json`），token 本身*就是*防重放的 nonce。
3. 每次重连都在隧道上用 **Ed25519 双向挑战**重新证明身份；只有认证过的 socket 才会被*升格*为承载数据帧，proxy 把抵达该 socket 的任何 `invoke` 都视为**已授权**——权威在 primary（隧道信任）。
4. proxy 通告**不带前缀的 `source.capability` 标识**；primary 将它们**挂载**到 `tenant/workload/…` 下，形成稳定的**地址**，作为身份标识。健康状况和可达性则属于可变的**路由**信息，因此授权绑定地址，不因重连、停机或故障转移而失效。
5. agent 在 primary 上对挂载地址发起的 `invoke` 会被**向下转发**进该 workload 的隧道，按不带前缀的 id 执行，以与来源无关的方式返回；归属端宕机时，调用方得到类型化的 `capability_unavailable`（绝不挂起）；撤销一个 workload 则触发一条有序级联：给 enroll 记录打墓碑 + 卸载 + 清除授权 + 断开 socket。

## 1. 拓扑与角色

![联邦网格 — 各 proxy 向单一 primary 建一条外拨隧道](/diagrams/mesh-topology.png)

```
            AGENT (Claude Code / Codex)
              │  connection-key / HS256 JWT   ← trust boundary ①  (UNCHANGED by the mesh)
              ▼
        ┌───────────────┐   HTTP :7077 (agent surface) + admin
        │    PRIMARY    │   holds grants · runs authorizer · audit sink · resolution table
        │  (authority)  │   MAY ALSO bear its own local workload (0-source is just the minimal case)
        └───────┬───────┘
      ws / wss  │  second listener (the "tunnel acceptor") — the proxy DIALS this
   ┌────────────┼───────────────┐   trust boundary ②  (Ed25519 mutual auth — NEW)
   ▼            ▼               ▼
┌────────┐  ┌────────┐     ┌────────┐
│ PROXY  │  │ PROXY  │ …   │ PROXY  │   each bears local sources, keeps a local exposure veto +
│  (m1)  │  │  (m2)  │     │ egress │   local audit, and DELEGATES authorization UP the tunnel
└────────┘  └────────┘     └────────┘
```

**两条正交的轴**（SSOT §0，不变量 A）。*权威模式*（`primary` | `proxy`）在启动时决定，不可变；*是否承载 workload*（要不要暴露本地 cap）是运行期的独立事实。primary 可以承载自己的 workload；proxy 也可以什么都不承载（纯"egress"路由器）。代码里的模式分叉只有一个启动分支：

- 模式在 `src/config.ts:676`（`loadMeshBootConfig`——注意在 `src/` 下，位于 mesh/ 代码根之外）从 `PLEXUS_MODE` 解析，默认 `"primary"`；未知值，或 `proxy` 却没配 `PLEXUS_UPSTREAM_URL`，都会**快速失败**（`src/config.ts:684`、`src/config.ts:698`）。
- `MeshRuntime.start()` 只在启动时分支一次（`runtime.ts:534`）：`startPrimary()`（`runtime.ts:556`）绑定隧道监听器，`startProxy()`（`runtime.ts:933`）主动向外建立连接。后续配置都在这两个方法内各自完成，两种模式不共用运行时的 socket 连接配置。

**配置一个节点（env 契约）。** 均在 `src/config.ts`（mesh/ 代码根之外）读取：

| 变量 | 含义 | 读取处 |
| --- | --- | --- |
| `PLEXUS_MODE` | `primary` \| `proxy`（默认 primary） | `src/config.ts:676` |
| `PLEXUS_TENANT` | 地址顶层段（缺省隐含 `local`） | `src/config.ts:688` |
| `PLEXUS_WORKLOAD` | 本网关的 workload 名（proxy 在 enroll 时声明） | `src/config.ts:689` |
| `PLEXUS_UPSTREAM_URL` | proxy → 拨向哪个 primary | `src/config.ts:690` |
| `PLEXUS_UPSTREAM_PUBKEY` | proxy → primary 的 Ed25519 公钥（**固定信任**，M1，强制） | `src/config.ts:694` |
| `PLEXUS_JOIN_TOKEN` | proxy → 一次性准入 token（仅首次加入） | `runtime/serve.ts:95` |
| `PLEXUS_MESH_TUNNEL_HOST` / `_WS_PORT` / `_WSS_PORT` | primary 隧道绑定（默认回环 + 临时 ws） | `src/config.ts:622–624` |
| `PLEXUS_MESH_TLS_CERT` / `_KEY` | primary wss 的 TLS 材料 | `src/config.ts:625–626` |
| `PLEXUS_MESH_REQUIRE_ENCRYPTION` | primary 拒绝明文 ws proxy（默认关闭） | `src/config.ts:627` |

## 2. enroll —— 一次性 join token

![proxy enroll——一次性 token、带角色标签的签名 transcript、primary 的五项 admit 校验，然后双向固定密钥](/diagrams/proxy-enroll.png)

注册是**第二道信任边界**，对安全至关重要（`enrollment.ts:1–43`）。它与 agent↔primary 的 HS256 通信完全分开。整个注册过程默认拒绝，出错时也拒绝：遇到格式错误的帧，无效、过期或重复使用的令牌，或无效签名，都会**拒绝 proxy 加入，也不持久化任何内容**。



```
 PROXY                                             PRIMARY (authority)
 ─────                                             ───────────────────
 (operator runs `plexus mesh mint` →)             mintJoinToken()  → raw 256-bit token
        one-time token delivered OUT-OF-BAND  ◄──  (only sha256(token) ever hits disk)
 buildEnrollRequest(payload, proxyKey)             admit(request, primaryIdentity):
   sign role-tagged transcript  ──{payload,sig}─►   1. claim shape · pubkey importable · mode==proxy
                                                     2. token: replay? → unknown? → expired? → valid
                                                     3. proxy sig verifies (proves key ownership)
                                                     4. workload UNIQUE + active (Inv F)
                                                     5. PIN proxyPubKey, persist active record +
                                                        ZERO-EXPOSURE marker, consume token (fsync)
   verifyEnrollAccepted(...)   ◄──{ok,primaryPubKey,sig}─  primary signs the SAME transcript (mutual)
     verify primary sig + enforce the primary-key PIN
```

- **token = nonce，单次使用。** 每枚 token 都是新鲜的 256 位熵（`enrollment.ts:377–378`），并绑入签名记录（`enrollment.ts:167–176`），一次握手的签名/响应无法重放进另一次。消费在成功路径上原子完成（`enrollment.ts:472–474`）；重放会被 `consumed` 集合抓住（`enrollment.ts:427`）。落盘的只有**哈希**（`enrollment.ts:186`，注释 36）。
- **准入顺序刻意为之，失败即关闭** —— 检查 1–5 在 `enrollment.ts:404–493`；每项检查全部通过之后，才消费 token、写入记录。
- **先持久后准入（L1）。** consume+pin 在报告成功前先 `fsync`（`persistDurable`，`enrollment.ts:366–368`，于 `481` 处调用）；写入失败会**回滚**内存变更并返回 `persist_failed`（`enrollment.ts:482–487`），一次性 token 绝不会在"写入丢失 + 重载"之后悄然复活。
- **零暴露条目（Q3）。** 已准入 workload 的 cap 默认**隐藏**——记录带 `exposureDefault: "hidden"`（`enrollment.ts:468`），*加入 ≠ 访问*：暴露 + 授权仍然是门禁。
- **持久账本**是 `~/.plexus/mesh/enrollments.json`，权限 `0600`，原子写入（`enrollment.ts:565–570`、`350–358`）。记录以 workload 为键（唯一性索引，不变量 F —— `enrollment.ts:287`）。
- **签发令牌。** 进程内通过 `EnrollmentRegistry.mintJoinToken`（`enrollment.ts:377`）签发令牌；运维人员可通过管理路由 `POST /admin/api/mesh/join-token`（`core/admin.ts:1276`）调用它。该路由仅限 primary 使用，其他模式返回 409。成功响应还会返回隧道端点和 primary 公钥，便于一次配齐 proxy 的环境变量。`plexus mesh mint` CLI 命令调用的就是这个路由（实现在 `packages/cli/src/mesh-commands.ts`，契约测试见 `tests/mesh-cli-mint.test.ts`）。

::: info 沿革注记（值得知道）
这套"一次性 token → 兑换 → 固定身份密钥 + 持久账本"的原语，正是后来 **agent-PAT enroll** 复用的模式（agent↔primary 一侧有自己的 `agentEnrollment.revoke` 墓碑路径，`core/admin.ts:865`）。mesh enroll 是原型；这套模式（token 即 nonce、单次使用、打墓碑而非删除）是刻意共享的。
:::

## 3. 隧道与传输

隧道是**一条由 proxy 向外拨出的持久 WebSocket**（SSOT §7 传输前提）。enroll、目录推送、invoke 转发、审计上报、健康，全部在它上面多路复用。代码：`tunnel.ts`（客户端 + 服务端 + mux），成帧在 `frames.ts`。

- **帧格式。** 所有复用消息都是 `@plexus/protocol` 中的 `Frame`，编码为不含换行的 JSON（`frames.ts:32`）。解码遇到畸形帧会抛出异常，消息处理路径会捕获异常并丢弃该帧，避免一条坏消息卡住多路复用（`frames.ts:59–70`）。`newCorr`（`frames.ts:73`）生成关联标识，用来配对请求和回复。`FrameMux` 的 pending 映射以 `corr` 为键保存待回复的请求（`tunnel.ts:144–145`）；`request()` 给请求写入关联标识再发送（`tunnel.ts:175`）；`dispatch()` 收到回复时按标识找到对应请求并交回结果，收到请求时则交给 `onRequest`（`tunnel.ts:202–226`）。
- **ws 与 wss（双监听器）。** `MeshServer`（`tunnel.ts:345`）总是绑定明文 `ws` acceptor（`tunnel.ts:438`）；配置了 TLS + wss 端口时*额外*绑定 `wss` acceptor（`tunnel.ts:439–446`）。两者接上的是**同一批**连接处理器。
- **加密策略：`encrypted` 不可伪造。** 标志由接收连接的监听器确定，不从 socket 读取：ws 使用 `buildHandlers(false)`，wss 使用 `buildHandlers(true)`（`tunnel.ts:438,444`；函数签名见 `tunnel.ts:557`），再于 `tunnel.ts:572` 将标志传给握手驱动。启用 `requireEncryption` 后，未加密连接在**第一条**握手消息到达时就会收到类型化错误 `encryption_required`，遭到拒绝。拒绝发生在*任何准入或密钥固定之前*，也在*令牌消耗之前*（`handshake.ts:399–405`），因此运维人员可以通过 wss 用同一令牌重试。默认的 `enc-off` 仍允许普通 ws，保持向后兼容（SSOT Q8）。启用 `requireEncryption` 却未配置 TLS 时，配置检查会立即报错（`src/config.ts:647`）。
- **重连韧性**（客户端，`MeshClient` `tunnel.ts:870`）：
  - 指数退避带硬上限：`backoffMs = min(backoffMs*2, max)`（`tunnel.ts:1181`），初始 50ms / 上限 2000ms（`tunnel.ts:53–54`），**均等抖动**延迟 `raw/2 + rand·raw/2`（`tunnel.ts:1183`）。退避**在 READY（已认证）时复位，不在 socket 打开时**（`markReady`，`tunnel.ts:1044–1045`；open 处理器明确不复位，`tunnel.ts:962–963`）——被拒/明文 ws/已撤销的 proxy 会朝上限翻倍退避，不会风暴式冲击。
  - 心跳：代理约每 15 秒发送一次带关联标识的 `ping`，若已协商则改发 `health` 帧，回复须在 5 秒内到达（`tunnel.ts:56–57,1060–1071`）。未按时收到 pong 会调用 `forceReconnect()`（`tunnel.ts:1077`），关闭 socket，随后进入 `handleDown`（`tunnel.ts:1158`），按退避策略重新连接。这样，无声的半开连接就会变成可观察到的断连。
  - 主节点关闭空闲连接：每收到一帧就更新 `lastSeen`（`tunnel.ts:627`）。连接静默时间超过代理心跳间隔的约 3 倍时，扫描会关闭该连接并触发 `onDisconnect`（`tunnel.ts:529–533`），让解析表及时将其标记为不可用。
- **TLS 热重载。** `reloadTls()`（`tunnel.ts:463`）只停止并重启 wss 监听器；重新绑定失败时，会**回滚**到上一份已知可用的 TLS 材料（`tunnel.ts:489–492`）。若回滚也失败，则保持一致的 DOWN 状态，并重新抛出异常（`tunnel.ts:495–498`）。ws 监听器和 HTTP 平面不受影响。轮换步骤见
  [`encryption-policy.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/encryption-policy.md) §2。

## 4. 握手与信任

mux 本身不区分身份。`handshake.ts` 负责验证 socket 的身份，验证通过后才处理任何数据帧（`handshake.ts:1–43`）。隧道通过 `HandshakeDriver` 接口（`handshake.ts:135`）调用握手逻辑；所有密码学操作都在 `handshake.ts` 中，`tunnel.ts` 不包含密码学代码。

两个阶段，由拨号的 proxy 锁步执行（NAT 所迫，proxy 先开口，`handshake.ts:382`）：

```
 leg 1 (first join only, token in hand):
   proxy → enroll { SignedEnrollRequest }        primary runs LIVE admit() (handshake.ts:409–412)
   primary → enroll-result { EnrollOutcome }      proxy enforces the primary-key PIN (M1)
 leg 2 (EVERY connect — binds THIS socket):
   proxy   → auth-init      { workload, cnonce, healthReporting? }
   primary → auth-challenge { snonce, sig_primary, healthReporting? }   sig over (workload,cnonce,snonce)
   proxy   → auth-response  { sig_proxy }
   primary → auth-ok        → socket PROMOTED
```

- **节点如何证明身份。** 每个连接的新鲜 nonce 让每份记录唯一（`authSignedBytes`，`handshake.ts:177`），捕获的签名无法认证另一个 socket。primary 用**账本里固定的**密钥验证 `sig_proxy`（`pinnedProxyPubKeyFor`，接线于 `runtime.ts:613`；验证于 `handshake.ts:447`）；未 enroll / 已撤销的 workload **没有 pin** → `auth-fail not_enrolled`（`handshake.ts:443–445`）。proxy 用**强制固定**的 `upstream.primaryPubKey` 验证 `sig_primary`（`handshake.ts:304–311`）——绝不退回 TOFU：缺了它，驱动连启动都拒绝（`handshake.ts:218–223`，`runtime.ts:942` 处呼应）。
- **握手完成。** 只有握手返回 `done`，socket 才获准传输数据帧：服务端移除待完成的握手，调用 `register()` 注册连接，并触发 `onConnect`（`tunnel.ts:617–619`）。受握手限制的 socket 若在获准之前收到数据帧，服务端会关闭该连接（`tunnel.ts:631–637`）。
- **握手超时回收（DoS 防护）。** 空闲清扫只看得见*已升格*的连接；卡在握手中途的已接受 socket 住在未认证的 `handshakes` 集合里。同一次清扫会回收任何在 `handshakeDeadlineMs`（默认 ~10s，`tunnel.ts:64,534–546`）内未升格的条目，关闭 socket 且不触发 `onDisconnect`（它从来不是 workload）。`handshakeDeadlineMs:0` 可禁用。见 `tests/mesh-handshake-reaper.test.ts`。
- **恢复（L-1）。** 若之前已成功加入并消耗了令牌，只是 `enroll-result` *丢失*，则**不算致命错误**：代理收到 `token_consumed` 后按已登记继续，进入挑战阶段，仍须用账本固定的密钥重新证明身份（`handshake.ts:274–287`）。从未登记的冒充者没有固定密钥，仍无法通过挑战，会被拒绝。*其他所有*拒绝原因仍按致命错误处理。

## 5. Capability 寻址与目录（来源即地址）

**语法**（`addressing.ts` 是唯一构造/反演它的地方，`addressing.ts:1–23`）：

```
  tenant / <workload-path…> / source.capability
    └ '/' separates LOCATION segments (tenant + variable-depth workload path)
    └ '.' separates the source.capability TAIL — today's bare CapabilityId
```

- **地址是身份，路由是位置**（不变量 B）。地址是授权与审计共同绑定的标识符，在整个生命周期中保持稳定。裸标识符不含 `/`，因此位置前缀与裸尾部可以清楚分开：尾部就是最后一个 `/` 之后的全部内容。
- **primary 挂载 / 名字的 NAT（Q4，不变量 F）。** proxy 在线路上是 **workload 无关的**：只推送不带前缀的 id，从不嵌入自己的 mesh 名，改名/迁移无需重新部署。`mountAddress(tenant, workload, bareId)` 在上升时**只**加一次前缀（`addressing.ts:53–68`，对已带前缀的 id 抛错——失败即关闭，防重复挂载）；`forwardTranslate(address)` 在转发边界**只**还原一次不带前缀的 id（`addressing.ts:79–82`）。往返律：`forwardTranslate(mountAddress(t,w,bare)) === bare`。
- **目录上升 / 级联**（`catalog.ts`）。proxy 用不带前缀的条目构建 `catalog` 帧——`buildCatalogPush` 断言每个 id 都不带前缀，失败即关闭（`catalog.ts:41–63`）。primary 经 `applyCatalog` → `registry.mountRemoteWorkload`（`catalog.ts:81–91`）应用：挂载到 `tenant/workload/` 之下，标记 `transport:"mesh"`，默认**零暴露 / 隐藏**，并推进注册表修订号。
- **实时上升 + 增量。** **每一次**认证过的（重）连接上，proxy 都重推完整目录（`onAuthenticated → pushCatalog`，`runtime.ts:986,1021`）；本地集合变化时推增量（`pushCatalogDelta`，`runtime.ts:1040`）——`added/updated` 走 `entries`，`removed` 走 `withdrawn`（撤销之外**唯一**合法的卸载路径；瞬态掉线绝不卸载——风险 1）。
- **挂载防伪。** primary 挂载在**socket 绑定的已认证 workload** 之下，绝不用 `frame.payload.workload`（`runtime.ts:796–809`）——伪造的 payload workload 会被忽略。
- **v1 深度上限。** 地址语法支持可变深度，`parseAddress` 能解析多段 workload 路径（`addressing.ts:98–107`）。实际部署约定将深度限制为 1，由接入登记策略执行，语法本身不设这一限制，因此更深的拓扑也无需迁移地址。深度大于 1 的拓扑，包括区域委派和在一个 `primary` 后再接一个 `primary`，明确不在 v1 范围内（SSOT §6）。

::: info 交叉引用
这就是 `provenance-as-address`（来源即地址）的 capability 寻址模型：地址=身份（URN），路由=位置（URL），glob=受限授权语法，级联=挂载/名字的 NAT。`tests/mesh-catalog-ascent.test.ts`、`tests/mesh-catalog.test.ts` 锁定这些契约。
:::

## 6. 解析与 invoke 转发

**经主节点调用时，挂载地址与本地地址等价（Q1）。** agent 只与主节点通信。调用挂载地址和本地地址的方式完全相同，调用方无法分辨能力来自哪里。数据平面透传是*结构上的必要条件*，不是为了方便：要根据内容决定是否批准执行，审批方就必须在执行前看到载荷。

转发路径（`runtime.ts` primary 转发边界 `runtime.ts:869–929`；`transports/mesh.ts` 接线）：

```
 POST /invoke (primary, mounted address)
   → mesh transport resolves address → { workload, bareId }  via registry.forwardAddress
       (resolveTarget, transports/mesh.ts:82)
   → forwarder.isEnrolledDestination(workload)?   PIN the target — active enrollment only,
       (runtime.ts:871; transports/mesh.ts:146)    no SSRF via a mutable mounted route
   → forwardInvoke(target, address, input, correlationId)   (runtime.ts:877)
       builds invoke frame: FULL address (audited URN) + BARE id (proxy executes) + correlationId
       (runtime.ts:895–904)
   → server.forward(workload, frame)  routes DOWN exactly that workload's socket (runtime.ts:911)
   ─────────────────── over the tunnel ───────────────────►
   PROXY onProxyInbound → executeForwardedInvoke (runtime.ts:1085,1123)
       runs the BARE id through the proxy's OWN InvokePipeline under a synthetic
       TUNNEL-TRUST context (mintTunnelTrustContext, runtime.ts:1132): grant/scope/session
       SKIPPED (primary already authorized — Inv E), but local EXPOSURE VETO + schema/health
       gates + local AUDIT still run (Inv C)
   ◄─────────────── invoke-result (verbatim InvokeResponse) ──
```

- **没有副本，也不支持故障转移。** 每个能力只有一个归属，就是它所属的 workload。“不可用”表示这个 workload 已无法提供服务。
- **绝不挂起（不变量 E）。** `forward` 到宕机/缺席的 proxy 会拒绝（`MeshDisconnectedError`/`MeshTimeoutError`），在 `runtime.ts:912–921` 被抓住并转成类型化的 `capability_unavailable`，附带 `unavailableSince`（已宕多久）。转发超时本身会把解析标成不可用，后续读取由此达成一致（`runtime.ts:917`）。
- **隧道信任入口不可伪造。** 跳过鉴权依靠一个*模块私有的身份标记（brand）*，只能在 `executeForwardedInvoke` 中创建，agent 无法通过 HTTP 接口伪造它（`runtime.ts:1107–1140`）。能力若在本地被禁用，即使走信任路径，仍会返回 `capability_unexposed`（`runtime.ts:1149–1157`）。是否暴露能力，资源所有者始终有否决权，这项检查不会跳过。
- `tests/mesh-invoke-forward.test.ts` 证明转发 + 线上不带前缀的 id + 目标固定；多 proxy 扇出（对 A 的 invoke 绝不落到 B 的 socket）在 `tests/mesh-multiproxy.test.ts`。

## 7. 健康上报（双向、经协商）

primary 为每个 workload 追踪**两个**健康事实，解析时路由优先：

1. **路由**（粗粒度，`ResolutionTable`，`resolution.ts`）。socket 提升时 `markAvailable`，掉线/关闭/超时时 `markUnavailable`（`resolution.ts:72–90`），以 workload 为键。`unknown` = *从未观测*——从没有 socket 为这个 workload 连接过（`resolution.ts:42–43`）。`unavailableSince` 只打一次戳，冗余的下线信号之间保留原值（`resolution.ts:82–90`）。
2. **报告**（细粒度，`MeshHealthStore`，`mesh-health.ts`）。代理节点汇总各个来源的健康状态，向上报告。

- **注册时协商。** 协商在 challenge 阶段进行，因此每次连接或重连都会重新执行（`negotiateHealthReporting`，`handshake.ts:120–127`）。**双方都**声明了结构有效的 `{version, intervalMs}` 就启用，否则不启用。版本取较小值（`version=min`），间隔取较大值（`intervalMs=max`），再将间隔限制在 `MAX_NEGOTIATED_INTERVAL_MS` 以内（60 秒，`handshake.ts:90`），避免一端把过期窗口任意拉长。格式错误或字段不全的声明都视为*未声明*，以免 `setInterval(…, NaN)` 让定时器因间隔无效而高频触发（`handshake.ts:100–110`）。
- **复用心跳，不另设定时器。** 只有协商启用后，代理节点才把心跳中的普通 `ping` 换成 `health` 帧（`tunnel.ts:1090–1107`）。连接通过认证时先发送一份快照；本地某个来源的健康状态发生变化时，也会立即上报（`reportHealthNow`，`runtime.ts:998`）。主节点到代理节点的循环与此对称，用于级联和向下传递存活信号，见 `startPrimaryHealthLoop`（`runtime.ts:676`）。
- **防伪。** `record(workload, payload)` 以 socket 绑定的已认证 workload 为键，忽略 `payload.reporter`（`mesh-health.ts:12`，`runtime.ts:774–780`）。proxy 伪造 `reporter:"other"` 只会更新它自己的健康。
- **解析优先级**（`stateFor`，`mesh-health.ts:160–199`）：路由 `unavailable` 胜出（第 1 行，不变量 E）→ 尚无报告 ⇒ `connecting` → 陈旧（老于 `interval×3`）⇒ `stale` → 否则取报告的聚合值（`down`/`degraded`/`ok`）。线上 `HealthStatus` 保持冻结的 4 态；更细的区分放在 `detail` 里（`mesh-health.ts:221`）。
- **未知状态有两种来源。** 路由为 `unknown`，表示该工作负载从未连接（`resolution.ts:43`）；另一种是 `connecting` 在线上映射为 `status:"unknown"`（`mesh-health.ts:234`）。所有来自 mesh 的健康值都带有 **`reported:true`**（`mesh-health.ts:213–224`）：它们是远端归属节点经隧道传来的*未经验证的自我声明*，并非主节点探测所得。健康报告只供参考；调用是否放行由路由／解析状态决定，不由报告决定。重连通过 `beginConnection` + 仅在同一连接 epoch 内比较 seq 的检查来处理（`mesh-health.ts:113–116,133–149`），代理重启后即使 seq 重置为 1，也不会卡住恢复。
- 在 `GET /admin/api/mesh` 的 `workloads[]` 里给出（`core/admin.ts:1255–1269`）。

## 8. 撤销与审计级联

**撤销整个工作负载（B6）**。`revokeWorkload`（`runtime.ts:733–751`）可通过仅限 primary 调用的 `POST /admin/api/mesh/revoke`（`core/admin.ts:1336`）访问。先执行*可能抛出异常、将工作负载标为已撤销终态的操作*，避免撤销只完成一半，顺序如下：

```
 1. TOMBSTONE   enrollment.revoke(workload)  → flip record to terminal "revoked" (fsync; THROWS
                on a failed durable write, BEFORE anything destructive)   runtime.ts:735
 2. UNMOUNT     capabilities.unmountWorkload(workload) → remove its addresses  runtime.ts:737
 3. PURGE       grants.removeForCapability(address) for each unmounted addr    runtime.ts:740–741
 4. DROP        server.dropConnection(workload) → close the live socket        runtime.ts:744
 5. STAMP       resolutionTable.markUnavailable + stop primary→proxy health    runtime.ts:747
```

- 墓碑正是撤销**终局性**的来源：`isActive` / `pinnedProxyPubKeyFor` / `isEnrolledDestination` 全部门控在 `status==="active"` 上（`enrollment.ts:541`，`runtime.ts:632–634,874`），拿旧的已固定密钥重连找不到 pin → `not_enrolled`，转发边界同样拒绝。记录只打墓碑，**绝不删除**（`enrollment.ts:511–526`），重放/陈旧的 token 无法复活已撤销的 workload。
- **幂等。** 未知/已撤销的 workload → `tombstoned:false`，步骤 2–5 仍以空操作跑完。对单个挂载地址的按*授权*撤销走 `POST /admin/api/revoke`（`core/admin.ts:625`），enroll + 挂载 + 隧道原封不动（`tests/mesh-revocation.test.ts` 用例 e）。
- **`dropConnection` 不同于拆除。** 撤销以 `fireDown=false` 断开 socket（`tunnel.ts:721`）——这个 workload 是被撤销，不是碰巧断连，因此不重跑瞬态掉线路径。

**审计级联（不变量 D）**。各网关自身能力的审计以其本地日志为准；primary 保存完整的**脱敏审计副本**，供集中审计。日志向上发送不会阻塞请求执行：

- proxy 订阅自己的审计写入路径，把副本作为 `audit` 帧沿隧道上报——发后不管，异常完全吞掉（`bubbleAudit`，`runtime.ts:1066–1074`；接线于 `runtime.ts:1006–1008`）。
- primary 尽力镜像：`mirrorProxyAudit`（`runtime.ts:833–851`）重新打上权威持有的元数据（`tier:"proxy"`、socket 绑定的发起 workload——**绝不**信任 payload），并穿过两个层级共用的**同一个脱敏器**写入，镜像永远不会比 proxy 本地日志泄露更多。镜像写入失败被吞掉，从不拖延 ack（`runtime.ts:848–850`）。
- `correlationId` 把 primary 的边缘 span 串到 proxy 的 workload span（不同于每帧 mux 的 `corr`）——随 invoke 帧（`runtime.ts:902`）与隧道信任上下文（`runtime.ts:1139`）传入。`tests/mesh-audit-cascade.test.ts` 证明同一脱敏器 + 共享 correlationId + 坏掉的上报不阻塞 invoke。

## 9. 隔离（在范围内；两个独立装置）

两者都不在 mesh 线路上，但都关乎 proxy 如何安全地*承载 workload*。

- **Linux 执行隔离（`bwrap`）**。`platform/sandbox-backend.ts` 通过 `SandboxBackend` 抽象“将命令执行限制在指定路径内”的操作。`DarwinSandboxBackend` 封装原有的 seatbelt `.sb` 配置，argv 逐字节不变；`LinuxSandboxBackend` 则用 bwrap 实现等效隔离：空命名空间加显式绑定白名单，对应 seatbelt 的 `(deny default)+(allow subpath)`。**可用性检查**规定，**当且仅当** bwrap 能*实际创建命名空间*时，才在 Linux 上重新启用 `codex`/`claudecode` 执行源。探测会实际运行一条受隔离的命令，而非 `bwrap --version`；因此，主机禁用 userns 时，即使已安装 bwrap，只要无法使用，检查仍会报告不可用，执行源也继续禁用，不会出现声明可用却未隔离执行的情况。完整的 seatbelt→bwrap 对照见
  [`linux-confinement.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/linux-confinement.md)。
- **容器化装置**（"暴露一个 capability，而非一整套系统"）。官方极简容器，入口点 `appliance/boot.ts`：读取 manifest（`PLEXUS_APPLIANCE_MANIFEST`），失败即关闭地校验（严格拒绝未知键；拒绝敏感路径），翻译成标准 env，启动同一个 `startRuntime`，并经 `exposure.setDefaultResolver` 安装一个**常驻的默认拒绝解析器**——manifest 没点名的 capability 在*查询时*就被隐藏，而非只在启动时拍一次快照（堵住扫描竞态 / `POST /extensions` / `list_changed` 泄漏）。设置了 `upstream` 时，装置以 **mesh proxy** 身份启动（向外拨号，cap 上升到 `tenant/workload/…` 之下，默认隐藏）。设计 + 威胁模型见
  [`capability-appliance.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/capability-appliance.md)。

## 10. 不变量（A–G）与执行代码的对应

| # | 不变量（SSOT §5） | 由谁执行 |
| --- | --- | --- |
| **A** | 模式 ⟂ Workload；恰好一个 primary | 启动分支 `runtime.ts:534–536`；模式解析 `src/config.ts:676`；proxy 可不承载 workload（纯 egress） |
| **B** | 地址是身份，路由是位置 | 挂载/翻译接缝 `addressing.ts:53–82`；路由健康绝不变更地址/授权（`resolution.ts:14–17,72–90`）；瞬态掉线不卸载 `mesh-health.ts:113`；风险 1 见 `networking-resilience.md §4` |
| **C** | 有效访问 = 已授权 ∧ 已暴露 ∧ ¬已撤销 ∧ coversInput | 本地暴露否决在隧道信任路径上照样运行（`runtime.ts:1149–1157`，`core/pipeline.ts`）；撤销清除授权 `runtime.ts:740–741` |
| **D** | 审计本地权威 + 逐级上报，永不阻塞 | `bubbleAudit` 发后不管 `runtime.ts:1066–1074`；`mirrorProxyAudit` 尽力而为 + 同一脱敏器 `runtime.ts:833–851` |
| **E** | 授权由 primary 最终决定；请求不得一直挂起 | proxy 向上委托；经 tunnel-trust 入口进入的请求不再重复授权判断（`runtime.ts:1080–1084`）；返回明确类型的 `capability_unavailable` `runtime.ts:912–921`；转发须绑定当前有效的 enrollment（`runtime.ts:871–875`） |
| **F** | Workload 在父级下唯一；地址在上升时级联改写 | 唯一性索引 `enrollment.ts:287,456–459`；primary 挂载 `catalog.ts:81–91`、`addressing.ts:53–68` |
| **G** | 伴生技能随 capability 地址一同流转 | 携带在被推送 + 挂载的 `CapabilityEntry` 中（`catalog.ts:41–91`）；技能随条目沿级联上升 |

## 11. 扩展入口 {#_11-扩展-mesh-——-在哪里挂钩}

- **新增传输方式或修改线协议。** `Frame` 联合类型由 `@plexus/protocol` 发布；`frames.ts` 只负责编解码和校验。新增帧类型时，先在协议包中加入分支，再按需补充编解码和校验。若携带的数据需要设定上限，应参照 `validateHealthPayload`（`frames.ts:120`）的做法，校验不通过即拒绝。在 `onPrimaryInbound`（`runtime.ts:771`）和／或 `onProxyInbound`（`runtime.ts:1085`）中处理新帧。mux（`tunnel.ts`）不区分帧类型，只传递，不解释，因此新增帧无需修改隧道。
- **在 proxy 上新增能力来源。** 按常规方式在注册表（`core/registry.ts`／`sources/index.ts`）中注册，无需 mesh 专用处理。下次推送目录（`pushCatalog`／`pushCatalogDelta`）时，不带前缀的 `source.capability` 标识会自动向上逐级传递。若来源会在 Linux 上调用外部命令，且需要内核隔离，应通过 `SandboxBackend` 实现，并加上可用性检查，使其在无法隔离的环境中保持禁用（见 §9）。
- **新增节点类型或授权拓扑。** 从启动分支（`runtime.ts:534`）开始修改。现有语法支持层数可变的 workload 路径（`addressing.ts:98–107`），因此表达 *区域委托*（一个 `primary` 下再接一个 `primary`）无需新增地址概念。但它仍不在 v1 范围内（SSOT §6.3）；实际要做的是实现中间层，让它在向上传递前先执行自己的暴露策略和审计。
- **新增准入或暴露策略。** enrollment 准入集中在 `EnrollmentRegistry.admit`（`enrollment.ts:404`）；扩展策略时，从这里的检查及其顺序入手。暴露策略通过解析器逐个 id 决定（`exposure.setDefaultResolver`），appliance 和 mesh 的零暴露行为也使用这一接口。新增默认拒绝或默认允许策略，只需实现解析器，无须另开一套代码。
- **观察拓扑/健康。** proxy 自身的 5 态拨号状态机用 `MeshClient.onStateChange`（`tunnel.ts:930`）；primary 的每 workload 视图用 `ResolutionTable.healthOf` + `MeshHealthStore.stateFor`；两者都能在 `GET /admin/api/mesh` 查到。

## 12. 测试地图（契约，非实现）

| 关注点 | 测试 |
| --- | --- |
| enroll 准入 / 重放 / 持久性 | `tests/mesh-enrollment.test.ts`、`tests/mesh-join-token-admin.test.ts` |
| 隧道 mux / 成帧 | `tests/mesh-tunnel.test.ts`、`tests/mesh-protocol-types.test.ts` |
| 握手双向 auth / 信任 / 超时回收 | `tests/mesh-tunnel-auth.test.ts`、`tests/mesh-tunnel-trust.test.ts`、`tests/mesh-handshake-reaper.test.ts` |
| 双监听器 + require-encryption | `tests/mesh-dual-listener.test.ts`、`tests/mesh-require-encryption.test.ts` |
| 重连 / 退避 / 心跳 | `tests/mesh-reconnect-resilience.test.ts`、`tests/mesh-backoff-heartbeat.test.ts` |
| 目录上升 / 挂载 | `tests/mesh-catalog-ascent.test.ts`、`tests/mesh-catalog.test.ts` |
| invoke 转发 / 多 proxy | `tests/mesh-invoke-forward.test.ts`、`tests/mesh-multiproxy.test.ts` |
| 健康上报 / 宕机 | `tests/mesh-health-reporting.test.ts`、`tests/mesh-health-downtime.test.ts` |
| 撤销 + 审计级联 | `tests/mesh-revocation.test.ts`、`tests/mesh-audit-cascade.test.ts` |
| 最小端到端集成／Linux proxy | `tests/mesh-e2e-walking-skeleton.test.ts`，`tests/mesh-linux-proxy-e2e.test.ts` |

可直接运行的混合部署演示：`bash examples/mesh-demo/launch-mesh-hybrid.sh`（Mac 原生 primary ＋ 2 个 Docker Linux proxies，一个用 wss，一个用 ws），管理页位于 `http://127.0.0.1:7077/admin`。

## 13. 代码与 SSOT 的几处出入

都是细微处，值得维护者一瞥——没有一个是 bug，但 SSOT 读起来仿佛其中有些仍悬而未决：

1. **`enroll` 是握手消息，不是一等 `Frame`。** SSOT §7/§3.4 说 `enroll` 帧"经由 T4 隧道 mux"。代码里，enroll + auth 两个阶段是一个*独立的*、模块本地的、以 `h` 为键的联合类型（`handshake.ts:144–151`），承载在**尚未进入 mux 的原始 socket**上，正是为了让 mux 保持身份无关。`Frame` 联合类型（以 `t` 为键）只在*已升格*的 socket 上流动。这个切分比 SSOT 的措辞更干净。
2. **隧道内没有专用的跨层审计机制。** SSOT 列出了 `audit` 帧和向上冒泡机制；代码中，它只是通过关联标识匹配应答的普通请求，走通用的 proxy→primary 请求路径（`runtime.ts:783–787,1066–1074`）。`tunnel.ts` 只传输，不解释内容。“级联”完全发生在 `MeshRuntime` 层，不在传输层。扩展审计时，应接入 `runtime.ts`，而不是隧道。
3. **`persist_failed` 是 SSOT 未列出的注册拒绝原因。** 它来自 L1 持久化写入失败后的回滚（`enrollment.ts:133,480–487`），表示注册因持久化失败而未获准，与 token／签名错误不同。`revoke` 在持久化写入失败时、任何破坏性撤销步骤之前抛错的契约也一样（`enrollment.ts:511–526`）；两者都强化了“先持久化，再报告结果”的要求，DDD 不变量隐含了这一点，却没有明说。
4. **健康值的 `reported:true` 来源标记。** `mesh-health.ts:213–224` 为 *每个* 来自 mesh 的健康值添加这一标记，表示它是未经验证的远端自报结果。SSOT 将健康信息视为参考，但未说明这个线协议标记；使用方可据此区分远端自报正常和网关通过本地探测确认正常。
5. **`unknown` 有两种来源。** 一种是路由从未连接过；另一种是 `connecting` 状态在线协议中映射为 `unknown`。建议在 SSOT 的健康状态表中明确写出这一区别，免得读者混为一谈。
