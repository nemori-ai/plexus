---
title: 联邦 mesh
description: Plexus 联邦 mesh 的开发者模型：一个 primary 网关、若干向外拨号的 proxy、来源即地址，以及把它们串起来的 enroll / 隧道 / invoke 转发机制。
---

# 联邦 mesh —— 开发者模型

::: tip 状态
**已实现**（P1–P5 mesh 史诗）。本文是 DDD SSOT
[`federated-mesh-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/federated-mesh-domain-model.md)
面向操作者/扩展者的伴生文档：SSOT 定义*语言与不变量*，本文把每个承重不变量映射到**执行它的代码**（引用 `file:line`），并指出扩展时在哪里挂钩。两者不一致时以代码为准，本文会注明（§13）。

下文代码根目录：除非另有路径说明，均为 `packages/runtime/src/mesh/`。
:::

## 五句话讲清心智模型

1. 一个 **mesh** 由恰好一个 `primary` 网关（agent 的前门：持有授权、运行授权器、汇聚审计）和任意数量的 `proxy` 网关组成；proxy 挨着真实服务运行，**向外拨出**一条通往 primary 的持久隧道（NAT 所迫：proxy 主机不开任何入站端口）。
2. proxy **只 enroll 一次**，凭 primary 带外铸造的 256 位一次性 join token；enroll 把 proxy 的 Ed25519 公钥钉入持久账本（`enrollments.json`），token 本身*就是*防重放的 nonce。
3. 每次重连都在隧道上用 **Ed25519 双向挑战**重新证明身份；只有认证过的套接字才会被*提升*为承载数据帧，proxy 把抵达该套接字的任何 `invoke` 都视为**已授权**——权威在 primary（隧道信任）。
4. proxy 只广告**裸的 `source.capability` id**；primary 把它们**挂载**到 `tenant/workload/…` 之下，构成稳定的**地址**（身份）；健康/可达性则是可变的**路由**事实。授权绑定在地址上，重连、宕机与故障切换之后依然有效。
5. agent 在 primary 上对挂载地址发起的 `invoke` 会被**向下转发**进该 workload 的隧道，按裸 id 执行，以与来源无关的方式返回；归属端宕机时，调用方得到类型化的 `capability_unavailable`（绝不挂起）；撤销一个 workload 则触发一条有序级联：给 enroll 记录打墓碑 + 卸载 + 清除授权 + 断开套接字。

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

- 模式在 `config.ts:593`（`loadMeshConfig`）从 `PLEXUS_MODE` 解析，默认 `"primary"`；未知值，或 `proxy` 却没配 `PLEXUS_UPSTREAM_URL`，都会**快速失败**（`config.ts:601`、`config.ts:615`）。
- `MeshRuntime.start()` 只分叉一次：`runtime.ts:534` → `startPrimary()`（`runtime.ts:556`，绑定 acceptor）或 `startProxy()`（`runtime.ts:933`，向外拨号）。下游一切都接线在这两个方法里；两种模式不共享任何活跃套接字接线。

**配置一个节点（env 契约）。** 均在 `config.ts` 读取：

| 变量 | 含义 | 读取处 |
| --- | --- | --- |
| `PLEXUS_MODE` | `primary` \| `proxy`（默认 primary） | `config.ts:593` |
| `PLEXUS_TENANT` | 地址顶层段（缺省隐含 `local`） | `config.ts:605` |
| `PLEXUS_WORKLOAD` | 本网关的 workload 名（proxy 在 enroll 时声明） | `config.ts:606` |
| `PLEXUS_UPSTREAM_URL` | proxy → 拨向哪个 primary | `config.ts:607` |
| `PLEXUS_UPSTREAM_PUBKEY` | proxy → primary 的**钉入** Ed25519 密钥（M1，强制） | `config.ts:611` |
| `PLEXUS_JOIN_TOKEN` | proxy → 一次性准入 token（仅首次加入） | `runtime/serve.ts:95` |
| `PLEXUS_MESH_TUNNEL_HOST` / `_WS_PORT` / `_WSS_PORT` | primary 隧道绑定（默认回环 + 临时 ws） | `config.ts:539–541` |
| `PLEXUS_MESH_TLS_CERT` / `_KEY` | primary wss 的 TLS 材料 | `config.ts:542–543` |
| `PLEXUS_MESH_REQUIRE_ENCRYPTION` | primary 拒绝明文 ws proxy（默认关闭） | `config.ts:544` |

## 2. enroll —— 一次性 join token

enroll 是**第二条信任边界**，安全关键（`enrollment.ts:1–43`），与 agent↔primary 的 HS256 线路完全分离。它处处默认拒绝 / 失败即关闭：畸形帧、坏的/过期的/复用的 token、坏签名，**一概不准入任何东西，也不持久化任何东西**。



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
- **铸造界面。** 进程内权威是 `EnrollmentRegistry.mintJoinToken`（`enrollment.ts:377`）；操作者通过 `POST /admin/api/mesh/join-token`（`core/admin.ts:940`，非 primary 返回 409）触达它。该路由同时返回隧道端点 + primary 公钥，proxy 的 env 一步就能组装齐。`plexus mesh mint` CLI 驱动这条路由（`packages/cli/src/mesh-commands.ts`；契约在 `tests/mesh-cli-mint.test.ts`）。

::: info 沿革注记（值得知道）
这套"一次性 token → 兑换 → 钉入身份 + 持久账本"的原语，正是后来 **agent-PAT enroll** 复用的模式（agent↔primary 一侧有自己的 `agentEnrollment.revoke` 墓碑路径，`core/admin.ts:691`）。mesh enroll 是原型；其形状（token 即 nonce、单次使用、打墓碑而非删除）是刻意共享的。
:::

## 3. 隧道与传输

隧道是**一条由 proxy 向外拨出的持久 WebSocket**（SSOT §7 传输前提）。enroll、目录推送、invoke 转发、审计上冒、健康，全部在它上面多路复用。代码：`tunnel.ts`（客户端 + 服务端 + mux），成帧在 `frames.ts`。

- **成帧。** 每条多路复用消息都是来自 `@plexus/protocol` 的 `Frame`，编码为无换行 JSON（`frames.ts:32`），解码失败安全——畸形帧抛错，热路径抓住并丢弃，垃圾帧卡不死整个 mux（`frames.ts:59–70`）。相关 id（`newCorr`，`frames.ts:73`）负责请求/回复配对。`FrameMux` 的 pending 映射以 `corr` 为键（`tunnel.ts:144–145`）；`request()` 打戳并发送（`tunnel.ts:175`），`dispatch()` 把回复匹配给等待者，或把入站请求路由到 `onRequest`（`tunnel.ts:202–226`）。
- **ws 与 wss（双监听器）。** `MeshServer`（`tunnel.ts:345`）总是绑定明文 `ws` acceptor（`tunnel.ts:438`）；配置了 TLS + wss 端口时*额外*绑定 `wss` acceptor（`tunnel.ts:439–446`）。两者铺开**同一批**连接处理器。
- **加密策略——`encrypted` 不可伪造。** 这个标志不是从套接字上读的，而是烘焙进"哪个监听器接受了此连接"：ws 用 `buildHandlers(false)`，wss 用 `buildHandlers(true)`（`tunnel.ts:438,444`；签名 `tunnel.ts:557`），再穿入 `tunnel.ts:572` 的握手驱动。设置了 `requireEncryption` 时，未加密连接在**第一条**握手消息处就被拒，类型为 `encryption_required`，*早于*任何 admit/pin，*早于* token 被消费（`handshake.ts:399–405`）——操作者可以拿同一枚 token 改走 wss 重试。`enc-off`（默认）保留明文 ws（向后兼容，SSOT Q8）。设置了 `requireEncryption` 却没有 TLS，配置快速失败（`config.ts:564`）。
- **重连韧性**（客户端，`MeshClient` `tunnel.ts:870`）：
  - 指数退避带硬上限：`backoffMs = min(backoffMs*2, max)`（`tunnel.ts:1181`），初始 50ms / 上限 2000ms（`tunnel.ts:53–54`），**均等抖动**延迟 `raw/2 + rand·raw/2`（`tunnel.ts:1183`）。退避**在 READY（已认证）时复位，不在套接字打开时**（`markReady`，`tunnel.ts:1044–1045`；open 处理器明确不复位，`tunnel.ts:962–963`）——被拒/明文 ws/已撤销的 proxy 会朝上限翻倍退避，不会风暴式冲击。
  - 心跳：proxy 每 ~15s 发一个相关的 `ping`（协商成功时改发 `health` 帧），截止 5s（`tunnel.ts:56–57,1060–1071`）；丢一次 pong 就调用 `forceReconnect()`（`tunnel.ts:1077`），关闭套接字 → `handleDown`（`tunnel.ts:1158`）→ 退避重拨。静默的半开套接字由此变成一次可观测的掉线。
  - primary 侧的空闲拆除：`lastSeen` 在每个入站帧上推进（`tunnel.ts:627`）；静默超过 ~3× proxy 间隔的连接会被清扫拆除并触发 `onDisconnect`（`tunnel.ts:529–533`），解析表及时把它标成不可用。
- **TLS 热重载。** `reloadTls()`（`tunnel.ts:463`）只停止并重启 wss 监听器；重新绑定失败时**回滚**到上一份已知良好的材料（`tunnel.ts:489–492`），回滚也失败则落入一致的 DOWN 状态并大声重抛（`tunnel.ts:495–498`）。ws 监听器 + HTTP 平面不受影响。轮换流程见
  [`encryption-policy.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/encryption-policy.md) §2。

## 4. 握手与信任

裸 mux 不识别身份；`handshake.ts` 是那道门：在任何数据帧被采信之前，先认证套接字（`handshake.ts:1–43`）。隧道通过 `HandshakeDriver` 不透明地驱动它（`handshake.ts:135`）；所有密码学都住在 `handshake.ts`，`tunnel.ts` 里一点没有。

两条腿，由拨号的 proxy 锁步执行（NAT 所迫，proxy 先开口，`handshake.ts:382`）：

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

- **节点如何证明身份。** 每个连接的新鲜 nonce 让每份记录唯一（`authSignedBytes`，`handshake.ts:177`），捕获的签名无法认证另一个套接字。primary 用**账本钉入的**密钥验证 `sig_proxy`（`pinnedProxyPubKeyFor`，接线于 `runtime.ts:613`；验证于 `handshake.ts:447`）；未 enroll / 已撤销的 workload **没有 pin** → `auth-fail not_enrolled`（`handshake.ts:443–445`）。proxy 用**强制**钉入的 `upstream.primaryPubKey` 验证 `sig_primary`（`handshake.ts:304–311`）——没有裸 TOFU：缺了它，驱动连启动都拒绝（`handshake.ts:218–223`，`runtime.ts:942` 处呼应）。
- **提升。** 只有 `done` 步骤才把套接字提升为承载帧：服务端删除 pending 握手、`register()` 该连接并触发 `onConnect`（`tunnel.ts:617–619`）；帧抵达未提升的门控套接字会被直接关闭（`tunnel.ts:631–637`）。
- **握手收割者（DoS 防护）。** 空闲清扫只看得见*已提升*的连接；卡在握手中途的已接受套接字住在未认证的 `handshakes` 集合里。同一次清扫会收割任何在 `handshakeDeadlineMs`（默认 ~10s，`tunnel.ts:64,534–546`）内未提升的条目，关闭套接字且不触发 `onDisconnect`（它从来不是 workload）。`handshakeDeadlineMs:0` 可禁用。见 `tests/mesh-handshake-reaper.test.ts`。
- **一个微妙的可存活细节（L-1）。** token 已被先前那次加入消费、`enroll-result` 却*丢了*——这**并非致命**：proxy 看到 `token_consumed`，把自己当作已 enroll，落到挑战腿，对着账本钉入的密钥重新证明（`handshake.ts:274–287`）。从未 enroll 的冒名者没有 pin，挑战照样失败即关闭。其余*所有*拒绝原因仍是致命的。

## 5. Capability 寻址与目录（来源即地址）

**语法**（`addressing.ts` 是唯一构造/反演它的地方，`addressing.ts:1–23`）：

```
  tenant / <workload-path…> / source.capability
    └ '/' separates LOCATION segments (tenant + variable-depth workload path)
    └ '.' separates the source.capability TAIL — today's bare CapabilityId
```

- **地址是身份；路由是位置**（不变量 B）。地址是授权 + 审计在每个生命周期阶段绑定的连接键；裸 id 永不含 `/`，位置前缀与裸尾部因此可以干净分开（尾部 = 最后一个 `/` 之后的一切）。
- **primary 挂载 / 名字的 NAT（Q4，不变量 F）。** proxy 在线路上是 **workload 无关的**：只推送裸 id，从不嵌入自己的 mesh 名，改名/迁移无需重新部署。`mountAddress(tenant, workload, bareId)` 在上升时**只**加一次前缀（`addressing.ts:53–68`，对非裸 id 抛错——失败即关闭，防重复挂载）；`forwardTranslate(address)` 在转发边界**只**恢复一次裸 id（`addressing.ts:79–82`）。往返律：`forwardTranslate(mountAddress(t,w,bare)) === bare`。
- **目录上升 / 级联**（`catalog.ts`）。proxy 用裸条目构建 `catalog` 帧——`buildCatalogPush` 断言每个 id 都是裸的，失败即关闭（`catalog.ts:41–63`）。primary 经 `applyCatalog` → `registry.mountRemoteWorkload`（`catalog.ts:81–91`）应用：挂载到 `tenant/workload/` 之下，标记 `transport:"mesh"`，默认**零暴露 / 隐藏**，并推进注册表修订号。
- **实时上升 + 增量。** **每一次**认证过的（重）连接上，proxy 都重推完整目录（`onAuthenticated → pushCatalog`，`runtime.ts:986,1021`）；本地集合变化时推增量（`pushCatalogDelta`，`runtime.ts:1040`）——`added/updated` 走 `entries`，`removed` 走 `withdrawn`（撤销之外**唯一**合法的卸载路径；瞬态掉线绝不卸载——风险 1）。
- **挂载防伪。** primary 挂载在**套接字绑定的已认证 workload** 之下，绝不用 `frame.payload.workload`（`runtime.ts:796–809`）——伪造的 payload workload 会被忽略。
- **v1 深度上限。** 语法本身可变深度（`parseAddress` 容忍多段 workload 路径，`addressing.ts:98–107`）；运营约定把深度限为 1，靠 enroll 策略而非语法，更深的拓扑永远不会逼出一次地址迁移。深度 >1（区域委派、`primary` 背后再套 `primary`）在 v1 明确越界（SSOT §6）。

::: info 交叉引用
这就是 `provenance-as-address`（来源即地址）的 capability 寻址模型：地址=身份（URN），路由=位置（URL），glob=受限授权语法，级联=挂载/名字的 NAT。`tests/mesh-catalog-ascent.test.ts`、`tests/mesh-catalog.test.ts` 钉住这些契约。
:::

## 6. 解析与 invoke 转发

**穿过 primary 的等价性（Q1）。** agent 只与 primary 对话；调用挂载地址与调用本地地址完全一样，调用方分辨不出来源。数据平面直通是*结构上必需*（不是图方便）：内容感知的批准要求权威在执行前看到 payload。

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

- **没有副本，没有故障切换。** 一个 capability 恰有一个归属（它的 workload）。"不可用"就是归属宕了——这是准确的信号，不是一套灾备叙事。
- **绝不挂起（不变量 E）。** `forward` 到宕机/缺席的 proxy 会拒绝（`MeshDisconnectedError`/`MeshTimeoutError`），在 `runtime.ts:912–921` 被抓住并转成类型化的 `capability_unavailable`，附带 `unavailableSince`（已宕多久）。转发超时本身会把解析标成不可用，后续读取由此达成一致（`runtime.ts:917`）。
- **隧道信任入口不可伪造。** 跳过 auth 靠的是一个*模块私有的品牌标记*，只有 `executeForwardedInvoke` 里铸得出来；agent 的 HTTP 界面伪造不了（`runtime.ts:1107–1140`）。本地被禁用的 cap 即便在信任路径上也返回 `capability_unexposed`（`runtime.ts:1149–1157`）——暴露是资源所有者的否决权，永远在跑。
- `tests/mesh-invoke-forward.test.ts` 证明转发 + 线上裸 id + 目标钉入；多 proxy 扇出（对 A 的 invoke 绝不落到 B 的套接字）在 `tests/mesh-multiproxy.test.ts`。

## 7. 健康上报（双向、经协商）

primary 为每个 workload 追踪**两个**健康事实，解析时路由优先：

1. **路由**（粗粒度，`ResolutionTable`，`resolution.ts`）。套接字提升时 `markAvailable`，掉线/关闭/超时时 `markUnavailable`（`resolution.ts:72–90`），以 workload 为键。`unknown` = *从未观测*——从没有套接字为这个 workload 连接过（`resolution.ts:42–43`）。`unavailableSince` 只打一次戳，冗余的下线信号之间保留原值（`resolution.ts:82–90`）。
2. **报告**（细粒度，`MeshHealthStore`，`mesh-health.ts`）。proxy 聚合的每源健康，向上推送。

- **在注册时协商**，走挑战腿，每次（重）连接都重跑（`negotiateHealthReporting`，`handshake.ts:120–127`）：**双方都**广告了结构合法的 `{version, intervalMs}` 才启用；`version=min`，`intervalMs=max`，钳制到 `MAX_NEGOTIATED_INTERVAL_MS`（60s，`handshake.ts:90`），单方无法把陈旧窗口任意推高。畸形/残缺的广告按*无广告*处理（失败即关闭，防 `setInterval(…, NaN)` 洪泛，`handshake.ts:100–110`）。
- **复用心跳，不加第二个计时器。** 协商成功后，proxy 的存活拍不再发裸 `ping`，改发 `health` 帧（`tunnel.ts:1090–1107`）；认证连接时触发初始快照，本地源翻转时触发变更推送（`reportHealthNow`，`runtime.ts:998`）。primary→proxy 方向对称（级联 + 向下存活），见 `startPrimaryHealthLoop` `runtime.ts:676`。
- **防伪。** `record(workload, payload)` 以套接字绑定的已认证 workload 为键，忽略 `payload.reporter`（`mesh-health.ts:12`，`runtime.ts:774–780`）。proxy 伪造 `reporter:"other"` 只会更新它自己的健康。
- **解析优先级**（`stateFor`，`mesh-health.ts:160–199`）：路由 `unavailable` 胜出（第 1 行，不变量 E）→ 尚无报告 ⇒ `connecting` → 陈旧（老于 `interval×3`）⇒ `stale` → 否则取报告的聚合值（`down`/`degraded`/`ok`）。线上 `HealthStatus` 保持冻结的 4 态；更细的区分放在 `detail` 里（`mesh-health.ts:221`）。
- **"unknown" 有两个来处**：路由 `unknown`（从未连接的 workload，`resolution.ts:43`），以及 `connecting` → `status:"unknown"` 的线上映射（`mesh-health.ts:234`）。每个 mesh 来源的健康值都盖着 **`reported:true`** 戳（`mesh-health.ts:213–224`）：它是远端归属经隧道转达的*未经核验的自我断言*，不是 primary 亲自探测的结果，仅供参考——门禁 invoke 的是路由/解析，不是报告。重连纪元处理（重启的 proxy seq 复位为 1 也不卡死恢复）在 `beginConnection` + 纪元作用域的 seq 门（`mesh-health.ts:113–116,133–149`）。
- 在 `GET /admin/api/mesh` 的 `workloads[]` 处浮现（`core/admin.ts:919–935`）。

## 8. 撤销与审计级联

**整 workload 撤销（B6）** —— `revokeWorkload`（`runtime.ts:733–751`），经 `POST /admin/api/mesh/revoke` 触达（仅 primary，`core/admin.ts:1000`）。顺序本身承重：*终局的、会抛错的*那一步先跑，任何东西都不会停在半撤销状态：

```
 1. TOMBSTONE   enrollment.revoke(workload)  → flip record to terminal "revoked" (fsync; THROWS
                on a failed durable write, BEFORE anything destructive)   runtime.ts:735
 2. UNMOUNT     capabilities.unmountWorkload(workload) → remove its addresses  runtime.ts:737
 3. PURGE       grants.removeForCapability(address) for each unmounted addr    runtime.ts:740–741
 4. DROP        server.dropConnection(workload) → close the live socket        runtime.ts:744
 5. STAMP       resolutionTable.markUnavailable + stop primary→proxy health    runtime.ts:747
```

- 墓碑正是撤销**终局性**的来源：`isActive` / `pinnedProxyPubKeyFor` / `isEnrolledDestination` 全部门控在 `status==="active"` 上（`enrollment.ts:541`，`runtime.ts:632–634,874`），拿旧钉入密钥重连找不到 pin → `not_enrolled`，转发边界同样拒绝。记录只打墓碑，**绝不删除**（`enrollment.ts:511–526`），重放/陈旧的 token 无法复活已撤销的 workload。
- **幂等。** 未知/已撤销的 workload → `tombstoned:false`，步骤 2–5 仍以空操作跑完。对单个挂载地址的按*授权*撤销走 `POST /api/revoke`（`core/admin.ts:509`），enroll + 挂载 + 隧道原封不动（`tests/mesh-revocation.test.ts` 用例 e）。
- **`dropConnection` 不同于拆除。** 撤销以 `fireDown=false` 断开套接字（`tunnel.ts:721`）——这个 workload 是被撤销，不是碰巧断连，因此不重跑瞬态掉线路径。

**审计级联（不变量 D）。** 每个网关的本地日志对自己的 cap 是权威；primary 保留一份完整**脱敏镜像**用于单一视窗审计，上冒永不阻塞热路径：

- proxy 订阅自己的审计写入路径，把副本沿隧道上冒为 `audit` 帧——发后不管，异常完全吞掉（`bubbleAudit`，`runtime.ts:1066–1074`；接线于 `runtime.ts:1006–1008`）。
- primary 尽力镜像：`mirrorProxyAudit`（`runtime.ts:833–851`）重新打上权威持有的元数据（`tier:"proxy"`、套接字绑定的发起 workload——**绝不**信任 payload），并穿过两个层级共用的**同一个脱敏器**写入，镜像永远不会比 proxy 本地日志泄露更多。镜像写入失败被吞掉，从不拖延 ack（`runtime.ts:848–850`）。
- `correlationId` 把 primary 的边缘 span 串到 proxy 的 workload span（不同于每帧 mux 的 `corr`）——随 invoke 帧（`runtime.ts:902`）与隧道信任上下文（`runtime.ts:1139`）传入。`tests/mesh-audit-cascade.test.ts` 证明同一脱敏器 + 共享 correlationId + 坏掉的上冒不阻塞 invoke。

## 9. 隔离（在范围内；两个独立装置）

两者都不在 mesh 线路上，但都关乎 proxy 如何安全地*承载 workload*。

- **Linux exec 隔离（`bwrap`）。** `platform/sandbox-backend.ts` 把"把这条 exec 命令隔离到这些路径里运行"抽象在 `SandboxBackend` 之后；`DarwinSandboxBackend` 包裹未改动的 seatbelt `.sb` 配置（argv 逐字节相同），`LinuxSandboxBackend` 构建等价的 bwrap 牢笼（空命名空间 + 显式 bind 白名单，即 seatbelt `(deny default)+(allow subpath)` 的对偶）。Linux 上有一道**可用性门**：**当且仅当** bwrap 能*真正构建出命名空间*时才重新激活 `codex`/`claudecode` exec 源——探测跑的是一条真正被牢笼化的命令，不是 `bwrap --version`，所以 bwrap 存在但 userns 被禁用的主机会正确报告不可用，源保持被门在外，绝不"广告了却没牢笼"。完整 seatbelt→bwrap 映射见
  [`linux-confinement.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/linux-confinement.md)。
- **容器化装置**（"暴露一个 capability，而非一整套系统"）。官方极简容器，入口点 `appliance/boot.ts`：读取 manifest（`PLEXUS_APPLIANCE_MANIFEST`），失败即关闭地校验（严格拒绝未知键；拒绝敏感路径），翻译成标准 env，启动同一个 `startRuntime`，并经 `exposure.setDefaultResolver` 安装一个**常驻的默认拒绝解析器**——manifest 没点名的 capability 在*查询时*就被隐藏，而非只在启动时拍一次快照（堵住扫描竞态 / `POST /extensions` / `list_changed` 泄漏）。设置了 `upstream` 时，装置以 **mesh proxy** 身份启动（向外拨号，cap 上升到 `tenant/workload/…` 之下，默认隐藏）。设计 + 威胁模型见
  [`capability-appliance.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/capability-appliance.md)。

## 10. 不变量（A–G）与执行代码的对应

| # | 不变量（SSOT §5） | 由谁执行 |
| --- | --- | --- |
| **A** | 模式 ⟂ Workload；恰好一个 primary | 启动分支 `runtime.ts:534–536`；模式解析 `config.ts:593`；proxy 可不承载 workload（纯 egress） |
| **B** | 地址是身份，路由是位置 | 挂载/翻译缝 `addressing.ts:53–82`；路由健康绝不变更地址/授权（`resolution.ts:14–17,72–90`）；瞬态掉线不卸载 `mesh-health.ts:113`；风险 1 见 `networking-resilience.md §4` |
| **C** | 有效访问 = 已授权 ∧ 已暴露 ∧ ¬已撤销 ∧ coversInput | 本地暴露否决在隧道信任路径上照样运行（`runtime.ts:1149–1157`，`core/pipeline.ts`）；撤销清除授权 `runtime.ts:740–741` |
| **D** | 审计本地权威 + 向上冒，永不阻塞 | `bubbleAudit` 发后不管 `runtime.ts:1066–1074`；`mirrorProxyAudit` 尽力而为 + 同一脱敏器 `runtime.ts:833–851` |
| **E** | 权威终结于 primary；绝不挂起 | proxy 向上委派；隧道信任入口不重新裁决（`runtime.ts:1080–1084`）；类型化 `capability_unavailable` `runtime.ts:912–921`；转发钉在活跃 enroll 上 `runtime.ts:871–875` |
| **F** | Workload 在父级下唯一；地址在上升时级联改写 | 唯一性索引 `enrollment.ts:287,456–459`；primary 挂载 `catalog.ts:81–91`、`addressing.ts:53–68` |
| **G** | 伴生技能随 capability 地址一同旅行 | 携带在被推送 + 挂载的 `CapabilityEntry` 中（`catalog.ts:41–91`）；技能随条目沿级联上升 |

## 11. 扩展 mesh —— 在哪里挂钩

- **加 transport / 改线路。** `Frame` 联合类型是这条边界的已发布语言（归 `@plexus/protocol` 所有）；`frames.ts` 只拥有 codec + 校验。要加帧类型：在 protocol 包里加变体；若携带有界数据，扩展 codec/校验（照 `validateHealthPayload` 的失败即关闭上限来，`frames.ts:120`）；再在 `onPrimaryInbound`（`runtime.ts:771`）和/或 `onProxyInbound`（`runtime.ts:1085`）里处理。mux（`tunnel.ts`）对帧类型无感——只承载、不解释——新帧不需要改隧道。
- **在 proxy 上加 capability 源。** 没有任何 mesh 专属步骤：在普通注册表里注册源（`core/registry.ts` / `sources/index.ts`），它的裸 `source.capability` id 会在下一次目录推送时自动上升（`pushCatalog`/`pushCatalogDelta`）。若它在 Linux 上要外壳调用、需要内核牢笼，就实现在 `SandboxBackend` 之后并加可用性门，在无法隔离的地方保持被门在外（见 §9）。
- **加新节点类型 / 权威拓扑。** 一切都挂在启动分支上（`runtime.ts:534`）。语法已容忍可变深度的 workload 路径（`addressing.ts:98–107`），*区域委派*（`primary` 背后再套 `primary`）无需新的地址名词即可组合——但它在 v1 越界（SSOT §6.3）；真正要做的是接线一个中间层，让它在上冒之前做自己的暴露/审计，寻址本身不用动。
- **加准入或暴露策略。** enroll 准入就是一个方法：`EnrollmentRegistry.admit`（`enrollment.ts:404`），它的检查顺序就是策略缝。暴露是按 id 的解析器（`exposure.setDefaultResolver`，装置与 mesh 零暴露走同一条缝），新的默认拒绝/放行策略就是一个解析器，不是一次代码分叉。
- **观察拓扑/健康。** proxy 自身的 5 态拨号盘用 `MeshClient.onStateChange`（`tunnel.ts:930`）；primary 的每 workload 视图用 `ResolutionTable.healthOf` + `MeshHealthStore.stateFor`；两者都在 `GET /admin/api/mesh` 处浮现。

## 12. 测试地图（契约，非实现）

| 关注点 | 测试 |
| --- | --- |
| enroll 准入 / 重放 / 持久性 | `tests/mesh-enrollment.test.ts`、`tests/mesh-join-token-admin.test.ts` |
| 隧道 mux / 成帧 | `tests/mesh-tunnel.test.ts`、`tests/mesh-protocol-types.test.ts` |
| 握手双向 auth / 信任 / 收割者 | `tests/mesh-tunnel-auth.test.ts`、`tests/mesh-tunnel-trust.test.ts`、`tests/mesh-handshake-reaper.test.ts` |
| 双监听器 + require-encryption | `tests/mesh-dual-listener.test.ts`、`tests/mesh-require-encryption.test.ts` |
| 重连 / 退避 / 心跳 | `tests/mesh-reconnect-resilience.test.ts`、`tests/mesh-backoff-heartbeat.test.ts` |
| 目录上升 / 挂载 | `tests/mesh-catalog-ascent.test.ts`、`tests/mesh-catalog.test.ts` |
| invoke 转发 / 多 proxy | `tests/mesh-invoke-forward.test.ts`、`tests/mesh-multiproxy.test.ts` |
| 健康上报 / 宕机 | `tests/mesh-health-reporting.test.ts`、`tests/mesh-health-downtime.test.ts` |
| 撤销 + 审计级联 | `tests/mesh-revocation.test.ts`、`tests/mesh-audit-cascade.test.ts` |
| 端到端行走骨架 / Linux proxy | `tests/mesh-e2e-walking-skeleton.test.ts`、`tests/mesh-linux-proxy-e2e.test.ts` |

在线混合演示：`bash examples/mesh-demo/launch-mesh-hybrid.sh`（原生 mac primary + 2 个 Docker Linux proxy，一个 wss 一个 ws），admin 在 `http://127.0.0.1:7077/admin`。

## 13. 代码与 SSOT 的几处出入

都是细微处，值得维护者一瞥——没有一个是 bug，但 SSOT 读起来仿佛其中有些仍悬而未决：

1. **`enroll` 是握手消息，不是一等 `Frame`。** SSOT §7/§3.4 说 `enroll` 帧"经由 T4 隧道 mux"。代码里，enroll + auth 两条腿是一个*独立的*、模块本地的、以 `h` 为键的联合类型（`handshake.ts:144–151`），搭乘在**前置 mux 阶段的裸套接字**上，正是为了让 mux 保持身份无关。`Frame` 联合类型（以 `t` 为键）只在*已提升*的套接字上流动。这个切分比 SSOT 的措辞更干净。
2. **审计在隧道里没有专用的跨层级机制。** SSOT 列了 `audit` 帧和一套上冒机制；代码里它就是通用 proxy→primary 请求路径上一次普通的相关请求（`runtime.ts:783–787,1066–1074`）——`tunnel.ts` 承载它，从不解释。"级联"完全在 `MeshRuntime` 层级，不在传输层级。要扩展审计，挂钩 `runtime.ts`，别动隧道。
3. **`persist_failed` 是 SSOT 没有枚举的 enroll 拒绝原因。** 它是 L1 的持久写入回滚（`enrollment.ts:133,480–487`）——真实的准入失败结局，有别于坏 token/坏签名。`revoke` 的先抛错后破坏契约（`enrollment.ts:511–526`）同理；两者都是"先持久后报告"的加固，DDD 不变量隐含了它却没点名。
4. **健康的 `reported:true` 来源标记。** `mesh-health.ts:213–224` 给*每一个* mesh 来源的健康值盖戳，标为未经核验的远端自我断言。SSOT 把健康框定为仅供参考，却没把这个线上标记摆上台面；对要区分"远端说 ok"和"网关亲自探测证明 ok"的消费者，这是一个有意义的契约。
5. **`unknown` 有两个不同来源**（从未连接的路由，对 `connecting`→`unknown` 的线上映射）。值得在 SSOT 的健康表里说清，读者容易把二者混为一谈。
