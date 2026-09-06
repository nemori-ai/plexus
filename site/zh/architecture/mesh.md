---
title: "联邦 mesh"
description: "Plexus 已实现的联邦 mesh 开发者模型：一个 primary 网关、若干向外拨号的 proxy，来源即地址，通过 enroll / 隧道 / invoke 转发机制串联。更深层或嵌套拓扑、企业归属仍属后续设计。"
---
# 联邦 mesh —— 开发者模型 {#联邦-mesh-——-开发者模型}

::: tip 状态
P1–P5 mesh 史诗已实现。本文供操作者和扩展者配合 DDD SSOT
[`federated-mesh-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/federated-mesh-domain-model.md)
阅读：SSOT 定义语言与不变量，本文逐项指出关键不变量由哪些代码执行，以 `file:line` 标出位置，也说明扩展可以接在哪里。两者有出入时，以代码为准，差异会在本文注明（§13）。

下文代码根目录：除非另有路径说明，均为 `packages/runtime/src/mesh/`。
:::

## 先看 mesh 怎样工作 {#五句话说明白心智模型}

1. 一个 mesh 恰好有一个 `primary` 网关，以及任意数量的 `proxy` 网关。`primary` 是 agent 的唯一入口，持有授权、运行授权器、汇聚审计。`proxy` 靠近真实服务运行；受 NAT 限制，主机不开任何入站端口，而是向 `primary` 拨出一条持久隧道。
2. `proxy` 只 enroll 一次，使用 `primary` 通过带外方式铸造的 256 位一次性 join token。enroll 将它的 Ed25519 公钥固定写入持久账本 `enrollments.json`；token 本身就是防重放的 nonce。
3. 每次重连，双方都在隧道上通过 Ed25519 双向挑战重新证明身份。socket 通过认证后才能承载数据帧。`proxy` 将这个 socket 上收到的任何 `invoke` 视为已授权：授权权威在 `primary`，这是隧道的信任约定。
4. `proxy` 只广告不带前缀的 `source.capability` 原始 id，`primary` 将其挂载到 `tenant/workload/…` 下。地址代表稳定身份，健康和可达性属于会变化的路由事实。授权绑定地址，重连、宕机或故障切换都不改变这层绑定；不过，当前每个 workload 只有一个 owner，尚未实现复制或自动故障切换。
5. agent 向 `primary` 上的挂载地址发起 `invoke`，请求便沿该 workload 的隧道向下转发，以不带前缀的 id 执行，结果按与来源无关的方式返回。归属端宕机时，调用方收到类型化的 `capability_unavailable`，调用不会挂起。撤销 workload 则依次给 enroll 记录打墓碑、卸载、清除授权、断开 socket。

## 1. 拓扑与角色 {#_1-拓扑与角色}

![联邦网格：各 proxy 向单一 primary 建立外拨隧道](/diagrams/mesh-topology.png)

```
            AGENT (Claude Code / Codex)
              │  PAT 认证；HS256 JWT 用于 scoped 调用授权  ← 信任边界 ①（mesh 未改变）
              ▼
        ┌───────────────┐   HTTP :7077 (agent surface) + admin
        │    PRIMARY    │   持有授权 · 运行授权器 · 汇聚审计 · 维护解析表
        │  (authority)  │   也可承载自己的本地 workload（0-source 只是最小情形）
        └───────┬───────┘
      ws / wss  │  第二个监听器（"tunnel acceptor"）—— 由 proxy 拨入
   ┌────────────┼───────────────┐   信任边界 ②（Ed25519 双向认证，mesh 新增）
   ▼            ▼               ▼
┌────────┐  ┌────────┐     ┌────────┐
│ PROXY  │  │ PROXY  │ …   │ PROXY  │   各自承载本地 source，保留本地暴露否决权与
│  (m1)  │  │  (m2)  │     │ egress │   本地审计，沿隧道向上委托授权
└────────┘  └────────┘     └────────┘
```

第一条边界上，agent 用自己的 PAT 认证，再单独取得 scoped 调用授权。`connection-key` 是拥有者的管理凭证。第二条边界处理网关之间的信任，用的是 Ed25519 双向认证。

节点是什么角色，和它是否提供本地能力，是两件独立的事。这就是 SSOT §0 不变量 A 所说的两条正交轴：权威模式（`primary` | `proxy`）在启动时确定，此后不可变；是否承载 workload，也就是是否暴露本地 cap，则是运行期的独立事实。`primary` 可以承载自己的 workload，`proxy` 也可以什么都不承载，只做纯粹的 `egress` 路由器。

模式由 `src/config.ts:676` 的 `loadMeshBootConfig` 从 `PLEXUS_MODE` 读取，默认 `"primary"`。这里的 `src/config.ts` 位于 mesh/ 代码根之外。未知模式会在 `src/config.ts:684` 快速失败；选择 `proxy` 却没有配置 `PLEXUS_UPSTREAM_URL`，也会在 `src/config.ts:698` 快速失败。

运行时只在启动处分叉一次：`MeshRuntime.start()`（`runtime.ts:534`）进入 `startPrimary()`（`runtime.ts:556`）绑定 acceptor，或进入 `startProxy()`（`runtime.ts:933`）向外拨号。后续连接都在这两个方法中接好，两种模式不共享任何活跃 socket 接线。

节点的 env 契约如下。除表中单列的 `PLEXUS_JOIN_TOKEN` 外，配置均在 mesh/ 代码根之外的 `src/config.ts` 读取。

| 变量 | 含义 | 读取处 |
| --- | --- | --- |
| `PLEXUS_MODE` | `primary` \| `proxy`，默认 `primary` | `src/config.ts:676` |
| `PLEXUS_TENANT` | 地址的顶层段；缺省时隐含为 `local` | `src/config.ts:688` |
| `PLEXUS_WORKLOAD` | 本网关的 workload 名；`proxy` 在 enroll 时声明 | `src/config.ts:689` |
| `PLEXUS_UPSTREAM_URL` | `proxy` 要拨向的 `primary` 地址 | `src/config.ts:690` |
| `PLEXUS_UPSTREAM_PUBKEY` | `proxy` 固定信任的 `primary` Ed25519 公钥，M1 强制要求 | `src/config.ts:694` |
| `PLEXUS_JOIN_TOKEN` | `proxy` 首次加入时使用的一次性准入 token | `runtime/serve.ts:95` |
| `PLEXUS_MESH_TUNNEL_HOST` / `_WS_PORT` / `_WSS_PORT` | `primary` 隧道的绑定配置，默认使用回环地址和临时 ws 端口 | `src/config.ts:622–624` |
| `PLEXUS_MESH_TLS_CERT` / `_KEY` | `primary` 的 wss 所用 TLS 证书和密钥 | `src/config.ts:625–626` |
| `PLEXUS_MESH_REQUIRE_ENCRYPTION` | 开启后，`primary` 拒绝通过明文 ws 连接的 `proxy`；默认关闭 | `src/config.ts:627` |

## 2. enroll：用一次性 join token 建立身份信任 {#_2-enroll-——-一次性-join-token}

enroll 把一次性凭证换成双方固定信任的身份公钥，以及持久的 workload 准入记录。它是第二条信任边界，属于安全关键代码（`enrollment.ts:1–43`），与 agent↔primary 的 HS256 线路完全分离。这里默认拒绝，失败即关闭：畸形帧、无效、过期或复用的 token、坏签名，一概不准入，也不持久化任何东西。

![proxy enroll：一次性 token、带角色标签的签名 transcript、primary 的五项准入校验，最后双方固定公钥](/diagrams/proxy-enroll.png)

操作者运行 `plexus mesh mint`，CLI 就会调用 `POST /admin/api/mesh/join-token`（`core/admin.ts:1276`；非 primary 返回 409）。进程内负责铸造的是 `EnrollmentRegistry.mintJoinToken`（`enrollment.ts:377`）。路由同时返回隧道端点和 primary 公钥，足以一次组装好 proxy 的 env。CLI 实现在 `packages/cli/src/mesh-commands.ts`，契约测试在 `tests/mesh-cli-mint.test.ts`。

token 本身就是 nonce，只能用一次。每枚都有新鲜的 256 位熵（`enrollment.ts:377–378`），并绑入带角色标签的签名记录（`enrollment.ts:167–176`），因此一次握手的签名或响应无法重放到另一次握手。原始 token 通过带外方式交付，磁盘上只存哈希（`enrollment.ts:186`，注释 36）。

```
 PROXY                                             PRIMARY（权威）
 ─────                                             ───────────────────
 （操作者运行 `plexus mesh mint` →）                mintJoinToken() → 原始 256 位 token
            通过带外方式交付一次性 token  ◄──        （只有 sha256(token) 会落盘）
 buildEnrollRequest(payload, proxyKey)             admit(request, primaryIdentity):
   签署带角色标签的 transcript ──{payload,sig}─►     1. 声明格式正确 · 公钥可导入 · mode==proxy
                                                     2. token：重放？→ 未知？→ 过期？→ 有效
                                                     3. proxy 签名有效（证明持有私钥）
                                                     4. workload 唯一且 active（Inv F）
                                                     5. PIN proxyPubKey，持久写入 active 记录 +
                                                        ZERO-EXPOSURE 标记，消费 token（fsync）
   verifyEnrollAccepted(...) ◄──{ok,primaryPubKey,sig}─ primary 签署同一份 transcript（双向）
     验证 primary 签名，并强制核对 primary 公钥的 PIN
```

这五项检查的顺序是刻意安排的（`enrollment.ts:404–493`），全部通过才消费 token、写入记录。成功路径上的消费是原子的（`enrollment.ts:472–474`）；再次提交已消费的 token，会被 `consumed` 集合拦下（`enrollment.ts:427`）。账本以 workload 为键，落实不变量 F 的唯一性要求（`enrollment.ts:287`）。

准入还必须经得起重载。账本位于 `~/.plexus/mesh/enrollments.json`，权限为 `0600`，采用原子写入（`enrollment.ts:565–570`、`350–358`）。按 L1，consume+pin 必须先持久化，才能报告成功：`persistDurable` 会先做 `fsync`（`enrollment.ts:366–368`，在 `481` 处调用）。写入失败就回滚内存变更，返回 `persist_failed`（`enrollment.ts:482–487`）。这样，一次性 token 不会因为“写入丢失，再重载”而悄然复活。

::: info 沿革
后来，agent-PAT enroll 复用了 mesh enroll 的这套模式：一次性 token 经兑换后，留下固定的身份密钥和持久账本。token 即 nonce、只用一次、撤销时打墓碑而非删除，都是刻意共享的做法。agent↔primary 一侧有自己的 `agentEnrollment.revoke` 墓碑路径（`core/admin.ts:865`）；共享模式不改变凭证归属，agent PAT 与 mesh 网关凭证仍属于不同的信任域。
:::

成功准入时，写入的还必须是零暴露条目（Q3）：记录带有 `exposureDefault: "hidden"`（`enrollment.ts:468`），已准入 workload 的 cap 默认隐藏。加入不等于取得访问权；实际访问仍须通过暴露和授权两道门禁。

## 3. 隧道与传输 {#_3-隧道与传输}

隧道是一条由 proxy 向外拨出的持久 WebSocket（SSOT §7 传输前提）。enroll、目录推送、invoke 转发、审计上报和健康消息都共用这条连接。不过，共用传输不等于同时进入多路复用：enroll 和认证先完成，之后才进入已认证的 `FrameMux` 流量。客户端、服务端和 mux 都在 `tunnel.ts`，成帧代码在 `frames.ts`。

进入多路复用后，每条消息都是 `@plexus/protocol` 的 `Frame`，编码为不含换行的 JSON（`frames.ts:32`）。解码遇到畸形帧会抛错，热路径捕获错误并丢弃该帧，垃圾帧不会卡死整个 mux（`frames.ts:59–70`）。

请求和回复靠相关 id 配对，由 `newCorr` 生成（`frames.ts:73`）。`FrameMux` 的 pending 映射以 `corr` 为键（`tunnel.ts:144–145`）；`request()` 给请求打戳并发送（`tunnel.ts:175`），`dispatch()` 将回复交给对应的等待者，或把入站请求交给 `onRequest`（`tunnel.ts:202–226`）。

接收连接时，`MeshServer`（`tunnel.ts:345`）总会绑定明文 ws acceptor（`tunnel.ts:438`）；同时配置 TLS 和 wss 端口，才额外绑定 wss acceptor（`tunnel.ts:439–446`）。两个监听器接入同一批连接处理器。

连接是否加密，由接受它的监听器决定。`encrypted` 不从 socket 上读取：ws 调用 `buildHandlers(false)`，wss 调用 `buildHandlers(true)`（`tunnel.ts:438,444`；签名见 `tunnel.ts:557`），再把这个值传入握手驱动（`tunnel.ts:572`），连接方无法伪造。

默认的 `enc-off` 保留明文 ws，以兼容已有连接（SSOT Q8）。开启 `requireEncryption` 后，未加密连接在第一条握手消息处就会收到 `encryption_required`，此时尚未执行任何 admit/pin，也尚未消费 token（`handshake.ts:399–405`）。操作者可以拿同一枚 token 改走 wss 重试。若设置了 `requireEncryption` 却没有 TLS，配置会快速失败（`src/config.ts:647`）。

连接断开后，`MeshClient`（`tunnel.ts:870`）按指数退避重拨：默认初始值为 50ms，上限为 2000ms（`tunnel.ts:53–54`），按 `backoffMs = min(backoffMs*2, max)` 翻倍并限制上限（`tunnel.ts:1181`）。实际延迟采用均等抖动，公式是 `raw/2 + rand·raw/2`（`tunnel.ts:1183`）。

退避只在进入已认证的 `READY` 时复位，由 `markReady` 执行（`tunnel.ts:1044–1045`）；socket 打开时明确不复位（`tunnel.ts:962–963`）。因此，被拒、因明文 ws 不符合策略或已被撤销而无法认证的 proxy，会继续向上限翻倍退避，不会因反复打开 socket、复位延迟而形成重连风暴。

proxy 还会约每 15s 发送一个带相关 id 的 `ping`；协商成功后改发 `health` 帧，回复截止时间为 5s（`tunnel.ts:56–57,1060–1071`）。只要丢失一次 pong，就调用 `forceReconnect()`（`tunnel.ts:1077`）：关闭 socket，进入 `handleDown`（`tunnel.ts:1158`），再退避重拨。静默的半开 socket 由此变成一次可观测的掉线。

primary 也会清理空闲连接。每个入站帧都会更新 `lastSeen`（`tunnel.ts:627`）；静默时间超过约 3 倍 proxy 心跳间隔，连接就会被清扫拆除，并触发 `onDisconnect`（`tunnel.ts:529–533`），让解析表及时将它标为不可用。

更换 TLS 材料时，`reloadTls()` 只停止并重启 wss 监听器（`tunnel.ts:463`）。重新绑定失败，会回滚到上一份已知良好的材料（`tunnel.ts:489–492`）；回滚也失败，则进入一致的 `DOWN` 状态，并明确重抛错误（`tunnel.ts:495–498`）。ws 监听器和 HTTP 平面不受影响。轮换步骤见 [`encryption-policy.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/encryption-policy.md) §2。

要信任这条连接上传来的流量，还必须先完成身份认证。

## 4. 握手与信任 {#_4-握手与信任}

数据帧能否被采信，要先看当前 socket 是否通过认证。mux 本身不识别身份，这道检查由 `handshake.ts` 完成（`handshake.ts:1–43`）。隧道通过 `HandshakeDriver` 驱动握手，不接触其内部细节（`handshake.ts:135`）；所有密码学操作都在 `handshake.ts`，`tunnel.ts` 中没有。

握手分两段，由拨号的 proxy 按顺序锁步执行。受 NAT 限制，必须由 proxy 先开口（`handshake.ts:382`）。第一段只在持有 token、首次加入时执行；第二段每次连接都要执行，证明绑定的是这一个 socket：

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

每次连接都使用新鲜的 nonce，让签名记录唯一（`authSignedBytes`，`handshake.ts:177`）。即使有人捕获了签名，也无法拿它认证另一个 socket。双方验证签名时，依据的都是事先固定的密钥。

primary 通过 `pinnedProxyPubKeyFor` 查询账本中仍处于 active 状态的 enroll 记录，取出固定的 proxy 公钥（接线见 `runtime.ts:613`），再验证 `sig_proxy`（`handshake.ts:447`）。未 enroll 或已撤销的 workload 没有 pin，会收到 `auth-fail not_enrolled`（`handshake.ts:443–445`）。proxy 则用强制固定的 `upstream.primaryPubKey` 验证 `sig_primary`（`handshake.ts:304–311`）。这里绝不退回 TOFU：缺少这个配置，驱动连启动都拒绝（`handshake.ts:218–223`，`runtime.ts:942` 也有对应检查）。

连接已建立、token 已消费，都不能让 socket 跳过认证升格。只有走到 `done`，服务端才删除 pending 握手，调用 `register()` 登记连接并触发 `onConnect`，让它开始承载数据帧（`tunnel.ts:617–619`）。数据帧若抵达尚未升格的门控 socket，该 socket 会被直接关闭（`tunnel.ts:631–637`）。

握手超时需要另行回收。前面的空闲清扫只看得见已升格连接；已接受但卡在握手中途的 socket，仍留在未认证的 `handshakes` 集合里。为防止它们长期占用资源，同一次清扫也会检查这个集合：超过 `handshakeDeadlineMs` 仍未升格，就回收条目并关闭 socket。默认期限约为 10s，设置 `handshakeDeadlineMs:0` 可禁用（`tunnel.ts:64,534–546`）。这里不触发 `onDisconnect`，因为连接从未作为 workload 接入。测试见 `tests/mesh-handshake-reaper.test.ts`。

有一个可以继续的例外（L-1）：先前加入已经消费了 token，但 `enroll-result` 丢失。proxy 再次收到 `token_consumed` 时，不会将其视为致命错误，而是按已 enroll 继续进入挑战；它仍须证明自己持有账本所固定公钥对应的私钥（`handshake.ts:274–287`）。从未 enroll 的冒名者没有 pin，挑战仍会失败，socket 随即关闭。其余所有拒绝原因仍是致命的。

## 5. Capability 的地址与目录：来源即地址 {#_5-capability-寻址与目录-来源即地址}

socket 通过认证后，primary 就知道这条连接属于哪个 workload。这个身份也决定了目录挂在哪里：proxy 报来不带前缀的 capability id，primary 为它加上 `tenant/workload/`，成为 agent 使用的地址。

```
  tenant / <workload-path…> / source.capability
    └ '/' separates LOCATION segments (tenant + variable-depth workload path)
    └ '.' separates the source.capability TAIL — today's bare CapabilityId
```

`/` 分隔位置段，包括 tenant 和可变深度的 workload 路径；`.` 分隔尾部的 source 与 capability，整个尾部就是今天不带前缀的 `CapabilityId`。地址的构造与反演统一放在 `addressing.ts`，只有这一处负责（`addressing.ts:1–23`）。不带前缀的 id 永不含 `/`，所以最后一个 `/` 之后的一切都是尾部，能与位置前缀干净分开。

地址是身份，路由是位置，这是不变量 B。整个生命周期中，授权与审计都用地址作为关联的连接键。

proxy 在线路上只推送不带前缀的 id，不嵌入自己的 mesh 名，因此目录广告与 workload 无关，改名或迁移也无需重新部署。上升时，`mountAddress(tenant, workload, bareId)` 只加一次前缀；遇到已经带前缀的 id 就抛错，失败即关闭，防止重复挂载（`addressing.ts:53–68`）。这就是 primary 挂载所做的名字的 NAT（Q4，不变量 F）。

相应地，`forwardTranslate(address)` 在转发边界只还原一次不带前缀的 id（`addressing.ts:79–82`）。两者遵守往返律：`forwardTranslate(mountAddress(t,w,bare)) === bare`。

目录上升由 `catalog.ts` 处理。proxy 用 `buildCatalogPush` 构建 `catalog` 帧，其中每个条目的 id 都必须不带前缀；断言不通过就失败即关闭（`catalog.ts:41–63`）。primary 收到后，经 `applyCatalog` → `registry.mountRemoteWorkload`，将条目挂到 `tenant/workload/` 下，标记 `transport:"mesh"`，默认零暴露、保持隐藏，并推进注册表修订号（`catalog.ts:81–91`）。

这里的 workload 来自 socket 绑定的已认证身份。primary 绝不用 `frame.payload.workload` 决定挂载命名空间，payload 即使伪造了 workload，也会被忽略（`runtime.ts:796–809`）。

目录还会随本地集合变化。每一次认证成功的连接，包括重连，proxy 都经 `onAuthenticated → pushCatalog` 重推完整目录（`runtime.ts:986,1021`）。本地集合变化时，则用 `pushCatalogDelta` 推送增量：`added/updated` 放进 `entries`，`removed` 放进 `withdrawn`（`runtime.ts:1040`）。

`withdrawn` 明确撤回条目，是撤销 workload 之外唯一合法的卸载路径。瞬态掉线绝不卸载地址；连接暂时不可用，不能据此抹掉挂载（风险 1）。

地址语法允许多段 workload 路径，`parseAddress` 也能解析（`addressing.ts:98–107`），但 v1 的运营约定将深度限为 1，由 enroll 策略执行，不靠语法限制。保留可变深度，是为了让更深的拓扑不必引起地址迁移；深度 >1 的区域委派、`primary` 背后再套 `primary`，在 v1 仍明确越界（SSOT §6）。

::: info 交叉引用
这套 capability 寻址模型称为 `provenance-as-address`（来源即地址）：地址是身份（URN），路由是位置（URL），glob 是受限授权语法，级联通过挂载与名字的 NAT 完成。`tests/mesh-catalog-ascent.test.ts`、`tests/mesh-catalog.test.ts` 锁定这些契约。
:::

## 6. 地址解析与 invoke 转发 {#_6-解析与-invoke-转发}

agent 只与 primary 对话，调用挂载地址与调用本地地址的方式相同，调用方无须分辨来源。这就是穿过 primary 的等价性（Q1），授权仍由 primary 检查。内容感知的批准要求授权权威在执行前看到 payload，因此 primary 必须留在数据路径上，这是结构上的要求。

一次请求经过以下路径。primary 的转发边界在 `runtime.ts:869–929`，mesh transport 的接线在 `transports/mesh.ts`：

```
 POST /invoke（primary，挂载地址）
   → mesh transport 经 registry.forwardAddress 解析地址 → { workload, bareId }
       （resolveTarget，transports/mesh.ts:82）
   → forwarder.isEnrolledDestination(workload)?   固定目标，只允许 active enrollment
       （runtime.ts:871；transports/mesh.ts:146）    防止可变挂载路由引入 SSRF
   → forwardInvoke(target, address, input, correlationId)   （runtime.ts:877）
       构建 invoke 帧：FULL address（审计用 URN）+ BARE id（proxy 执行用）+ correlationId
       （runtime.ts:895–904）
   → server.forward(workload, frame)  只沿该 workload 的 socket 向下发送（runtime.ts:911）
   ─────────────────── 穿过隧道 ──────────────────────────►
   PROXY onProxyInbound → executeForwardedInvoke（runtime.ts:1085,1123）
       将 BARE id 交给 proxy 自己的 InvokePipeline，在合成的
       TUNNEL-TRUST 上下文中执行（mintTunnelTrustContext，runtime.ts:1132）：
       跳过 grant/scope/session（primary 已完成授权，Inv E），
       仍执行本地 EXPOSURE VETO、schema/health 检查和本地 AUDIT（Inv C）
   ◄─────────────── invoke-result（原样返回 InvokeResponse）──
```

解析得到 workload 后，还要确认它仍有 active enrollment，才能固定转发目标。可变的挂载路由不能借此把请求引向任意目的地。帧里则同时保留两种地址用途：完整 address 是审计用的 URN，bareId 是 proxy 本地执行的不带前缀的 id；`correlationId` 随请求传递。最终选中的，是这个 workload 的 socket。

proxy 接收请求后，仍走自己的 `InvokePipeline`。它能省去 grant、scope、session 检查，是因为 primary 已完成授权，而隧道信任入口由模块私有的品牌标记识别。这个标记只能在 `executeForwardedInvoke` 内铸造，agent 无法通过 HTTP 接口伪造（`runtime.ts:1107–1140`）。

省去这些检查，并不消除归属端的决定权。本地暴露、schema、health 检查和本地审计照常执行；本地禁用的 cap 即便走信任路径，也返回 `capability_unexposed`（`runtime.ts:1149–1157`）。授权让调用抵达特定的 owner，资源所有者的暴露否决权始终有效。

没有副本，也没有故障切换。一个 capability 恰好归一个 workload 所有，归属宕了就报不可用。这个信号准确指出归属端的不可用，系统不会把调用转交另一份副本。

绝不挂起（不变量 E）指等待有界。`forward` 遇到已断开或缺席的 proxy，会以 `MeshDisconnectedError` 拒绝；等待回复超过期限，则以 `MeshTimeoutError` 拒绝，超时路径仍要等到期限。两种错误都在 `runtime.ts:912–921` 被捕获，转成类型化的 `capability_unavailable`，并附带 `unavailableSince`，供调用方判断已宕多久。转发超时本身还会把解析状态标成不可用，使后续读取与这次失败一致（`runtime.ts:917`）。

`tests/mesh-invoke-forward.test.ts` 验证转发、线路上不带前缀的 id 和目标固定；`tests/mesh-multiproxy.test.ts` 验证多 proxy 扇出时，对 A 的 invoke 绝不会落到 B 的 socket。

## 7. 健康上报：双向协商 {#_7-健康上报-双向、经协商}

排查调用失败时，要先分清 primary 观测到了什么，远端又报告了什么。primary 为每个 workload 分别保存这两份健康记录，解析时先看路由。

路由记录放在 `ResolutionTable` 中，以 workload 为键，只记粗粒度的可达性。socket 升格时调用 `markAvailable`，掉线、关闭或超时时调用 `markUnavailable`（`resolution.ts:72–90`）。重复的下线信号不会重写 `unavailableSince`，它保留首次下线的时间戳（`resolution.ts:82–90`）。路由为 `unknown`，表示从未观测到这个 workload 有 socket 连入（`resolution.ts:42–43`）。另一份记录放在 `MeshHealthStore` 中，保存 proxy 聚合后向上推送的各个源的细粒度健康报告（`mesh-health.ts`）。

上报在注册时随挑战握手协商，每次连接和重连都重新执行 `negotiateHealthReporting`（`handshake.ts:120–127`）。双方都广告了结构合法的 `{version, intervalMs}`，才会启用：`version=min`，`intervalMs=max`，间隔再限制到 `MAX_NEGOTIATED_INTERVAL_MS`，即 60s，单方不能任意拉长陈旧窗口（`handshake.ts:90`）。畸形或残缺的广告按无广告处理，不启用上报，避免 `setInterval(…, NaN)` 造成洪泛（`handshake.ts:100–110`）。

协商成功后，上报复用心跳，不另加计时器。proxy 将原本单独发送的 `ping` 换成 `health` 帧（`tunnel.ts:1090–1107`）；连接通过认证时发送初始快照，本地源状态翻转时则由 `reportHealthNow` 推送变更（`runtime.ts:998`）。primary 向 proxy 的方向也对称执行，用于级联和向下探活，见 `startPrimaryHealthLoop`（`runtime.ts:676`）。

报告归谁，由连接上的认证身份决定。`record(workload, payload)` 以 socket 绑定的已认证 workload 为键，忽略 `payload.reporter`；proxy 即使伪造 `reporter:"other"`，也只能更新自己的记录（`mesh-health.ts:12`，`runtime.ts:774–780`）。

两份记录怎样合起来看，取决于 `stateFor` 的顺序（`mesh-health.ts:160–199`）。第一行先检查路由：`unavailable` 直接胜出，这是不变量 E。路由未判为不可用，才继续看报告：尚无报告时为 `connecting`；报告老于 `interval×3` 时为 `stale`；否则采用报告的聚合值，即 `down`、`degraded` 或 `ok`。线路上的 `HealthStatus` 仍保持冻结的四态，更细的区分放进 `detail`（`mesh-health.ts:221`）。

因此，看到 `unknown` 还要看它来自哪里。路由的 `unknown` 表示从未连接；线路上的 `status:"unknown"` 也可能由 `connecting` 映射而来，表示尚无报告（`mesh-health.ts:234`）。

每个 mesh 来源的健康值都带有 `reported:true`（`mesh-health.ts:213–224`）。它是远端归属端经隧道转达、未经核验的自我断言，只供参考，并非 primary 亲自探测的结果。认证能确定是谁在报告，不能让报告成为调用依据；为 invoke 把关的仍是路由与解析。

重连还会开启新的连接纪元。`beginConnection` 配合纪元范围内的 seq 检查，让重启后的 proxy 即使把 seq 复位为 1，也能恢复上报，不会被旧序号卡住（`mesh-health.ts:113–116,133–149`）。操作者可在 `GET /admin/api/mesh` 返回的 `workloads[]` 中查看这些健康信息（`core/admin.ts:1255–1269`）。

## 8. 撤销与审计级联 {#_8-撤销与审计级联}

撤销整个 workload（B6），先要把准入记录持久改成终局的 `revoked` 状态，再清理挂载、授权和连接。入口是仅 primary 提供的 `POST /admin/api/mesh/revoke`（`core/admin.ts:1336`），调用 `revokeWorkload`（`runtime.ts:733–751`）。这五步有先后要求：第一步必须完成 `fsync`；持久写入失败就抛错，此时破坏性的清理还没开始，不会出现墓碑没写成、挂载却先被拆掉的半撤销状态。

```
 1. TOMBSTONE   enrollment.revoke(workload)  → flip record to terminal "revoked" (fsync; THROWS
                on a failed durable write, BEFORE anything destructive)   runtime.ts:735
 2. UNMOUNT     capabilities.unmountWorkload(workload) → remove its addresses  runtime.ts:737
 3. PURGE       grants.removeForCapability(address) for each unmounted addr    runtime.ts:740–741
 4. DROP        server.dropConnection(workload) → close the live socket        runtime.ts:744
 5. STAMP       resolutionTable.markUnavailable + stop primary→proxy health    runtime.ts:747
```

写入墓碑后，才卸载这个 workload 的地址，逐个清除地址上的授权，关闭活跃 socket，最后把解析状态标成不可用，并停止 primary 向 proxy 的健康探测。这里保证的是持久墓碑先于清理落盘，并不表示后面几步被包在同一个事务里。

这条路径是幂等的。未知或已经撤销的 workload 返回 `tombstoned:false`，步骤 2–5 仍会走完，作为空操作处理。只想撤掉单个挂载地址的授权，则走 `POST /admin/api/revoke`（`core/admin.ts:625`）；它保留 enroll、挂载和隧道，测试见 `tests/mesh-revocation.test.ts` 用例 e。

撤销时的 `dropConnection` 也有专门语义：它以 `fireDown=false` 关闭 socket（`tunnel.ts:721`）。这个 workload 已被撤销，因此不再触发瞬态掉线的处理路径，不能把这次断连接着当成普通掉线处理。

撤销的终局性来自那条留下来的记录。`isActive`、`pinnedProxyPubKeyFor`、`isEnrolledDestination` 都要求 `status==="active"`（`enrollment.ts:541`，`runtime.ts:632–634,874`）。拿旧的已固定密钥重连，查不到 pin，就会得到 `not_enrolled`；转发边界也拒绝已撤销的目标。记录只打墓碑，绝不删除（`enrollment.ts:511–526`），重放或陈旧的 token 无法让 workload 复活。持久撤销由此去掉了重连和转发所需的准入依据。

审计级联处理的是记录的归属与汇集，这是不变量 D。每个网关的本地日志，对自己的 cap 都是权威记录；primary 汇集脱敏镜像，让操作者能在一处查看。镜像以完整汇集为目的，但上报采用尽力而为的方式，不保证每条记录都能送达，也不阻塞调用热路径。

proxy 订阅自己的审计写入路径，把副本放进 `audit` 帧，沿隧道上报。`bubbleAudit` 发出后不等待，异常全部吞掉（`runtime.ts:1066–1074`）；订阅接线在 `runtime.ts:1006–1008`。

primary 收到副本后，由 `mirrorProxyAudit`（`runtime.ts:833–851`）重新写入权威侧掌握的元数据：`tier:"proxy"`，以及 socket 绑定的发起 workload。这些字段绝不采信 payload。随后，记录经过两个层级共用的同一个脱敏器写入，因此镜像不会比 proxy 本地日志泄露更多。镜像写入失败也会被吞掉，从不拖延 ack（`runtime.ts:848–850`）。

跨网关追踪一次调用，用的是 `correlationId`：它把 primary 的边缘 span 与 proxy 的 workload span 串起来，不同于逐帧 mux 配对使用的 `corr`。它随 invoke 帧传递（`runtime.ts:902`），再进入隧道信任上下文（`runtime.ts:1139`）。`tests/mesh-audit-cascade.test.ts` 验证两端使用同一脱敏器、共享 `correlationId`，以及上报出错时 invoke 仍不受阻塞。

## 9. 隔离：承载 workload 的两个独立装置 {#_9-隔离-在范围内-两个独立装置}

proxy 怎样安全地承载 workload，还涉及两个独立的隔离装置。两者都在本文范围内，但都不在 mesh 线路上。

先看 exec 命令怎样被限制在指定路径里运行。`platform/sandbox-backend.ts` 用 `SandboxBackend` 抽象这件事。`DarwinSandboxBackend` 包裹原有的 seatbelt `.sb` 配置，配置未改，argv 也逐字节相同。`LinuxSandboxBackend` 则构建等价的 bwrap 隔离环境：从空命名空间开始，只通过显式 bind 白名单开放路径，对应 seatbelt 的 `(deny default)+(allow subpath)`。

Linux 上能否启用这些源，要经过一次实际探测。当且仅当 bwrap 真能构建出命名空间，才重新激活 `codex`／`claudecode` exec 源。探测会运行一条真正受隔离的命令，并非只检查 `bwrap --version`。所以，即使主机装了 bwrap，只要 userns 被禁用，就会正确报告不可用，源也始终不会启用，不能出现已经广告能力、执行时却没有隔离的情况。

完整的 seatbelt→bwrap 映射见 [`linux-confinement.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/linux-confinement.md)。网关能在 Linux 上运行，并不意味着 macOS 专属的应用源也能在 Linux 上使用。

另一个装置是官方极简容器，用来只暴露一个 capability，而非整套系统。入口 `appliance/boot.ts` 读取 `PLEXUS_APPLIANCE_MANIFEST` 指定的 manifest，严格拒绝未知键和敏感路径，校验失败就不继续启动。通过后，它将配置翻译成标准 env，启动同一个 `startRuntime`。

启动时还会经 `exposure.setDefaultResolver` 安装一个常驻的默认拒绝解析器。manifest 没点名的 capability，在查询时就会被隐藏。这项检查会持续生效，不是启动时留下一份快照：扫描竞态、`POST /extensions` 新增的扩展，以及 `list_changed` 带来的列表变化，都不能让未点名的能力漏出来。

设置了 `upstream`，容器装置就以 mesh proxy 身份启动，向外拨号，cap 上升后挂载到 `tenant/workload/…` 下，默认隐藏。容器装置的设计与威胁模型见 [`capability-appliance.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/capability-appliance.md)。

## 10. 不变量 A–G 在代码中的落实 {#_10-不变量-a–g-与执行代码的对应}

| # | 不变量（SSOT §5） | 执行位置与行为 |
| --- | --- | --- |
| A | 模式与 Workload 相互独立；恰好一个 `primary` | 启动分支见 `runtime.ts:534–536`，模式解析见 `src/config.ts:676`；`proxy` 可以不承载 workload，只做 `egress` |
| B | 地址是身份，路由是位置 | 挂载与翻译在 `addressing.ts:53–82`；路由健康绝不改变地址或授权（`resolution.ts:14–17,72–90`）；瞬态掉线不卸载（`mesh-health.ts:113`）；风险 1 见 `networking-resilience.md §4` |
| C | 有效访问 = 已授权 ∧ 已暴露 ∧ ¬已撤销 ∧ `coversInput` | 隧道信任路径仍执行本地暴露否决（`runtime.ts:1149–1157`、`core/pipeline.ts`）；撤销时清除授权（`runtime.ts:740–741`） |
| D | 本地审计是权威记录，逐级上报，永不阻塞 | `bubbleAudit` 发出后不等待（`runtime.ts:1066–1074`）；`mirrorProxyAudit` 尽力写入，使用同一脱敏器（`runtime.ts:833–851`） |
| E | 权威止于 `primary`；绝不挂起，等待有界 | `proxy` 向上委派，隧道信任入口不重新裁决（`runtime.ts:1080–1084`）；不可用时返回类型化的 `capability_unavailable`（`runtime.ts:912–921`）；转发目标必须有活跃的 enroll 记录（`runtime.ts:871–875`） |
| F | Workload 在父级下唯一；地址上升时逐级改写 | 唯一性由索引保证（`enrollment.ts:287,456–459`）；`primary` 挂载见 `catalog.ts:81–91`、`addressing.ts:53–68` |
| G | 伴生技能随 capability 地址一同流转 | 技能放在被推送、挂载的 `CapabilityEntry` 中（`catalog.ts:41–91`），随条目逐级上升 |

## 11. 扩展 mesh：从哪里接入 {#_11-扩展-mesh-——-在哪里挂钩}

要加 transport 或改线路，先看帧的定义。`Frame` 联合类型是这条边界上已经发布的语言，归 `@plexus/protocol` 所有；`frames.ts` 只负责 codec 和校验。新增帧类型，要先在 protocol 包中添加变体；若携带有界数据，还要扩展 codec 和校验，参照 `validateHealthPayload` 的失败即关闭上限检查（`frames.ts:120`）。随后按接收方向，在 `onPrimaryInbound`（`runtime.ts:771`）、`onProxyInbound`（`runtime.ts:1085`）中的一处或两处接上处理。mux（`tunnel.ts`）不识别帧类型，只承载、不解释，因此新帧不需要改隧道。

在 proxy 上加 capability 源，就简单一些。按普通方式在注册表中注册源（`core/registry.ts` / `sources/index.ts`），没有 mesh 专属步骤。它的不带前缀的 `source.capability` id，会在下一次目录推送时经 `pushCatalog`／`pushCatalogDelta` 自动上升。不过，若这个源在 Linux 上要调用外部命令、需要内核牢笼，就必须通过 `SandboxBackend` 实现，并加上可用性门。无法隔离的地方，源要保持禁用，具体见 §9。

新增节点类型或改变权威拓扑，入口在启动分支（`runtime.ts:534`）。地址语法已经容纳可变深度的 workload 路径（`addressing.ts:98–107`），因此，区域委派，也就是在 `primary` 背后再套 `primary`，无需引入新的地址名词就能组合。但这种嵌套拓扑在 v1 仍未交付，明确属于范围之外（SSOT §6.3）。以后要实现它，需要接好中间层，让这一层在上报之前完成自己的暴露处理和审计；寻址本身不用改。

准入与暴露各有自己的入口。enroll 准入集中在 `EnrollmentRegistry.admit`（`enrollment.ts:404`），这个方法的检查顺序就是接入策略的位置。暴露则通过 `exposure.setDefaultResolver` 按 id 解析，装置与 mesh 零暴露共用这条接缝。要增加默认拒绝或放行策略，提供一个解析器即可，不需要另开一套代码分支。

观察运行状态时，要分清看的是哪一端。proxy 自身的 5 态拨号状态机，通过 `MeshClient.onStateChange`（`tunnel.ts:930`）观察；primary 按 workload 查看健康，则用 `ResolutionTable.healthOf` 和 `MeshHealthStore.stateFor`。两端的信息都能在 `GET /admin/api/mesh` 查到。

找到扩展入口之后，还要核对哪些行为已有测试约束，哪些仍有实现限制。接下来可沿着测试与实现说明继续查。

## 12. 测试地图：按契约查找 {#_12-测试地图-契约-非实现}

下表按契约列出测试入口，不按实现模块划分。

| 关注点 | 测试 |
| --- | --- |
| enroll 准入、重放与持久性 | `tests/mesh-enrollment.test.ts`、`tests/mesh-join-token-admin.test.ts` |
| 隧道 mux 与成帧 | `tests/mesh-tunnel.test.ts`、`tests/mesh-protocol-types.test.ts` |
| 握手双向 auth、信任与超时回收 | `tests/mesh-tunnel-auth.test.ts`、`tests/mesh-tunnel-trust.test.ts`、`tests/mesh-handshake-reaper.test.ts` |
| 双监听器与 require-encryption | `tests/mesh-dual-listener.test.ts`、`tests/mesh-require-encryption.test.ts` |
| 重连、退避与心跳 | `tests/mesh-reconnect-resilience.test.ts`、`tests/mesh-backoff-heartbeat.test.ts` |
| 目录上升与挂载 | `tests/mesh-catalog-ascent.test.ts`、`tests/mesh-catalog.test.ts` |
| invoke 转发与多 proxy | `tests/mesh-invoke-forward.test.ts`、`tests/mesh-multiproxy.test.ts` |
| 健康上报与宕机 | `tests/mesh-health-reporting.test.ts`、`tests/mesh-health-downtime.test.ts` |
| 撤销与审计级联 | `tests/mesh-revocation.test.ts`、`tests/mesh-audit-cascade.test.ts` |
| 端到端行走骨架与 Linux proxy | `tests/mesh-e2e-walking-skeleton.test.ts`、`tests/mesh-linux-proxy-e2e.test.ts` |

在线混合演示可用 `bash examples/mesh-demo/launch-mesh-hybrid.sh` 启动：原生 mac 上运行 primary，另有 2 个 Docker Linux proxy，一个走 wss，一个走 ws。admin 地址是 `http://127.0.0.1:7077/admin`。

## 13. 代码与 SSOT 的几处出入 {#_13-代码与-ssot-的几处出入}

下面几处差异，都是 SSOT 的措辞或细节没有跟上代码，并非运行时缺陷。实现已有明确处理，读 SSOT 时却容易以为其中一些还没有定下来。

`enroll` 是握手消息，不属于 `Frame` 联合类型。SSOT §7/§3.4 说它“经由 T4 隧道 mux”，代码中的 enroll 和 auth 两个阶段，却使用独立的、模块本地的联合类型，以 `h` 为键（`handshake.ts:144–151`），在尚未进入 mux 的原始 socket 上传输。以 `t` 为键的 `Frame` 联合类型，只在已升格的 socket 上流动。代码里的这条边界比 SSOT 的措辞更清楚，也让 mux 保持身份无关。

审计级联由 `MeshRuntime` 编排，隧道没有专门处理跨层级审计的机制。SSOT 列出了 `audit` 帧和上报机制；在代码里，它走通用的 proxy→primary 请求路径，就是一次普通的相关请求（`runtime.ts:783–787,1066–1074`）。`tunnel.ts` 负责承载，从不解释审计内容。要扩展审计，挂钩 `runtime.ts`，别动隧道。

`persist_failed` 是真实的 enroll 拒绝原因，SSOT 却没有将它列入枚举。它表示 L1 要求的持久写入失败后发生回滚（`enrollment.ts:133,480–487`），与坏 token、坏签名导致的准入失败不同。`revoke` 也有同样的顺序要求：持久写入失败就先抛错，不进入破坏性清理（`enrollment.ts:511–526`）。两处都加固了“先持久后报告”的契约，DDD 不变量隐含了这层要求，却没有点名。

健康值还有一个在线路上传递的来源标记。`mesh-health.ts:213–224` 为每一个 mesh 来源的健康值加上 `reported:true`，表明这是未经核验的远端自我断言。SSOT 已说明健康仅供参考，但没有明确写出这个标记。消费者要区分“远端说 ok”和“网关亲自探测证明 ok”，就需要知道这项契约。

`unknown` 则有两个来源：路由从未连接时是 `unknown`；尚无健康报告的 `connecting`，在线路上也会映射成 `unknown`。SSOT 的健康表需要分开说明这两种来源，否则读者容易把它们混为一谈。
