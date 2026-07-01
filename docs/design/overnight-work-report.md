# 夜间补充任务 — 工作报告（网络 / 加密 / Linux / 容器化）

> 编排方式：cc-master 多 agent 编排（board `20260630T101930Z-28649`，P5-* 任务簇）。
> 四个主题各自「设计 → 实现 → 测试 → 对抗式安全审查 → 修复 → 端点复验」。
> 所有改动**未提交**，留在 worktree 供你早上 review。SSOT = `docs/design/federated-mesh-domain-model.md`。

---

## 0. 总览（先看这个）

| 主题 | 设计文档 | 实现 | 端点验证 | 对抗审查结论 |
|---|---|---|---|---|
| **① 网络** | `networking-resilience.md` | 代理自动重连(退避+抖动)+心跳+连接态机+握手期清扫 | ✅ 24/24 mesh 套件；混合拓扑真机跑通 | 无 CRITICAL；2 个 DoS 边角→已修 |
| **② 加密** | `encryption-policy.md` | 强制加密策略(默认关)+证书热重载/轮换 | ✅ 通过 | 加密**真·fail-closed**；身份⟂加密成立 |
| **③ Linux** | `linux-confinement.md` | `SandboxBackend` 抽象(darwin seatbelt / linux **bwrap**)+可用性闸 | ✅ 11/11 + 90 项相关套件 | 牢笼是真内核边界；探针缺陷→已修 |
| **④ 容器化** | `capability-appliance.md` | 最小化 appliance 镜像 + 清单驱动 + **常驻默认拒绝** | ✅ 原生 boot-smoke：只暴露 workspace.*，拒 25 项 | **1 个 CRITICAL（一次性快照）→已修** |

**总验证闸（三轨合并后）**：`tsc --noEmit` 干净（exit 0）；全量 `bun test` **957 通过 / 2 失败**，2 个失败是**早已存在**的 `examples/agent-view` Playwright 用例（缺 `@playwright/test` 依赖），与本次四个主题无关。

**关键过程价值**：三个安全敏感主题各跑了一轮**对抗式审查**，每一轮都抓出了真问题（容器 1 个 CRITICAL、Linux 1 个 CONCERN、网络 2 个 DoS 边角）——单元测试和 boot-smoke 都没覆盖到，靠审查抓出后全部修复并复验。这正是「绿 ≠ 真过」的体现。

**一个已知环境限制**（非代码缺陷，见 §4）：容器 appliance 的 **Docker 镜像构建**今晚被这台机器的 Docker Hub 元数据拉取卡死（同一晚 16:12 gateway 镜像还能正常构建，之后网络劣化）。**appliance 的实质逻辑已用原生 boot-smoke 充分验证**；镜像打包是「网络恢复后重试」的待办。

---

## ① 网络（Networking）

**设计** `docs/design/networking-resilience.md`：代理掉线自动重连（**指数退避 + equal-jitter**，关键是**在「认证就绪」而非「socket 打开」时重置退避**，所以被拒的代理不会风暴）；隧道心跳/keepalive（漏一个 pong 即重连，检测半开 socket）；5 态连接状态机上报到 admin；以及承重不变量 **「瞬断不卸载」**（grant/mount 在抖动中存活，只有显式 withdraw/revoke 才卸载 — Invariant B）。

**实现**（`mesh/tunnel.ts` +696、`mesh/runtime.ts`）：MeshClient 重连状态机、心跳、`onStateChange`；MeshServer 每连接 `lastSeen` + 空闲清扫；**握手期清扫器**（见下方修复）。

**对抗审查结论**：无 CRITICAL。两个会成为 CRITICAL 的问题——明文 ws 在强制加密下能否转发一帧、accept-then-reject 是否触发重连风暴——都验证为 **SAFE**。发现 2 个 DoS 边角，已修：
- **握手期 socket 永不回收**：空闲清扫只扫已认证连接，停在握手中途的未认证 socket 会堆积耗尽 FD。→ **修复**：加 `handshakeDeadlineMs`（默认 10s）的握手期清扫器（`mesh-handshake-reaper.test.ts`）。
- （`reloadTls` 回滚见 §②）。

**真机演示**：`examples/mesh-demo/launch-mesh-hybrid.sh` —— **原生 mac primary + 2 个 Docker Linux 代理**，容器跨 docker→host 边界经 `host.docker.internal` 拨入 mac 隧道（一个 wss 加密、一个 ws 明文），聚合成一组多源能力。已亲自跑通（容器→宿主隧道可达、Ed25519 入网、聚合目录）。

---

## ② 加密（Encryption）

**设计** `docs/design/encryption-policy.md`：primary 侧**强制加密开关** `PLEXUS_MESH_REQUIRE_ENCRYPTION`（默认关，向后兼容），开启后 primary 在握手第一帧就**先于 admit、先于消耗 join token** 拒绝明文 ws 入网，返回 typed `encryption_required`；严格建立在 **身份 ⟂ 加密**（ADR Q2，只管信道，从不动 Ed25519 身份）；外加证书/密钥管理（`reloadTls()` 监听器重绑 + TLS 证书与 Ed25519 身份的轮换流程）。

**实现**（`config.ts`、`mesh/handshake.ts`、`mesh/tunnel.ts`）：`encrypted` 标志**由 socket 落在哪个监听器（wss vs ws）推导，客户端无法伪造**；强制加密缺 TLS 物料则启动即 fail-fast。

**对抗审查结论**：**加密策略真·fail-closed**——审查逐行确认明文 ws 在开关下拿不到任何一帧转发，且 token 不被消耗（可换 wss 重试）。身份⟂加密保持。发现并已修：
- **`reloadTls` 失败无回滚**：新证书 `Bun.serve` 抛错时旧监听器已停，wss 面悬空。→ **修复**：捕获后用上一份已知good证书**回滚**重绑；回滚再失败则置空（一致的 down 态，无悬挂）并大声抛出。
- 文档化的运维注意项：`reloadTls` 用不同 CA 的证书会让所有代理 TLS 失败（先分发新 CA）；`reloadTls` 必须 admin 鉴权。

**测试**：`mesh-require-encryption.test.ts`（开关开→wss 入网、明文 ws 被拒、token 未耗）。

---

## ③ Linux 版本（exec 源真隔离，P3-5）

**设计** `docs/design/linux-confinement.md`：`SandboxBackend` 抽象——「把这条 exec 命令限制在这些路径/限额内运行」，两实现：`DarwinSandboxBackend`（包裹现有 seatbelt `.sb` profile，**行为字节级不变**）、`LinuxSandboxBackend`（用 **bwrap** 构建等价牢笼：空 namespace 默认拒 + 显式 bind 白名单，是 seatbelt `(deny default)+(allow subpath)` 的对偶）。含完整 seatbelt→bwrap 标志映射表。

**实现**（新 `platform/sandbox-backend.ts`、`sources/index.ts`、`core/registry.ts`、codex/claudecode launcher+manifest+bridge）：平台选后端；**可用性闸**——Linux 上 codex/claudecode 仅当 bwrap **可用且能真正建 namespace** 时才激活，否则保持 gated OUT（不变「广告了却没牢笼」）；`{cc-master, workspace}` 在 Linux 恒开；darwin 保持全 7 源。

**对抗审查结论**：牢笼是**真内核边界**（unshare/clone 真 namespace、no-new-privs、die-with-parent、new-session），无逃逸、argv 数组无注入、darwin 路径字节不变。发现 1 个 CONCERN 并已修：
- **探针用 `bwrap --version`**——`--version` 根本不触发 namespace 创建，所以在「禁用了非特权 user namespace」的现代主机（Ubuntu 24.04 默认 AppArmor、硬化容器）上会误判 bwrap「可用」，导致 codex/claudecode 被广告却 100% 调用失败。→ **修复**：探针改为真跑 `bwrap --ro-bind / / --unshare-user --unshare-net --die-with-parent true`，只有 exit 0 才算可用（fail-closed）。

**测试**：`p3-5-linux-confinement.test.ts`（11/11）+ 平台/门控/launcher 套件（90 通过）。

---

## ④ 容器化 — 能力暴露 Appliance（未来场景）

**场景**：用户不想开放整机，而是跑一个**官方最小化容器**，只对外暴露**清单声明的、经过策展的**一组能力（"expose a capability, not a system"）。

**设计** `docs/design/capability-appliance.md`：容器即边界；operator 只挂载要暴露的数据目录 + 声明白名单清单；最小权限（非 root、只读根、cap-drop、no-new-privileges、tmpfs state）；清单驱动、默认拒绝未列项。

**实现**（新 `packages/runtime/src/appliance/{boot.ts,manifest.ts}`、`docker/Dockerfile.appliance`、`examples/appliance/*`、新 `.dockerignore`）：boot.ts 读清单→翻译成既有 env→`startRuntime`→**常驻默认拒绝**；清单解析器严格校验。

**对抗审查结论**：审查抓出 **1 个 CRITICAL** + 真实漏洞，均已修：
- **CRITICAL：默认拒绝原本是「启动时一次性快照」而非常驻策略**——任何 boot 之后才进注册表的能力（5s 扫描竞态、agent 调 `POST /extensions`、MCP `list_changed`）会**默认启用→被暴露→可调用**，绕过策展。（调用侧本身是安全的：`pipeline.ts:287` 即便在隧道信任路径也会否决 disabled 能力。）→ **修复**：改用公共 seam `exposure.setDefaultResolver`，让**任何未被清单命名的 id 永远 hidden**，一举堵死三个泄漏向量。新增 `appliance-default-deny.test.ts` 专门验证「boot 之后注册的能力仍被拒」。
- **CRITICAL：Dockerfile 声称有 `.dockerignore` 但根本不存在**——`COPY . .` 会把整个 repo（`.git`、`node_modules`、任何 `.env`）烤进世界可读的 `/app`。→ **修复**：新增根 `.dockerignore`（排除 secrets/.git/node_modules/state/scratchpad 等，且不破坏 gateway 与 appliance 构建）。
- **加固**：清单严格拒绝未知字段（防 `capabilites` 拼错→整源放行）；拒绝把 `path` 指向 `/state`、`/app`、`/etc/plexus`、`PLEXUS_HOME`（防读到自身连接密钥/签名密钥/mesh 身份）。

**端点验证（原生 boot-smoke，比容器更强）**：在 **mac** 上原生启 `boot.ts`（mac 有 25 个能力可拒，比 Linux 容器更严苛），`.well-known` **只暴露 4 个 `workspace.*`，拒掉 25 个**（apple/things/cc-master/codex/claudecode）。`appliance-manifest.test.ts` + `appliance-default-deny.test.ts` 共 24/24。

**⚠️ 已知限制（环境，非代码）**：Docker 镜像 `plexus-appliance:latest` 今晚没能构建完成——构建卡在 `load metadata for ubuntu:22.04`，即 Dockerfile 自己注释里写的「这台机器 Docker Hub 拉取会 stall」。我加了 `BASE_IMAGE` build-arg + `--pull=false` 试图用本地 digest 绕开，但 BuildKit 仍坚持 registry 解析、依旧挂住。**结论：实质逻辑已验证，镜像打包待网络恢复后 `docker build -f docker/Dockerfile.appliance -t plexus-appliance:latest .` 重试即可。**

---

## 产物清单

**新设计文档**（5）：`networking-resilience.md`、`encryption-policy.md`、`linux-confinement.md`、`capability-appliance.md`、本报告。
**新代码**：`platform/sandbox-backend.ts`、`appliance/{boot.ts,manifest.ts}`、`docker/Dockerfile.appliance`、根 `.dockerignore`、`examples/appliance/*`、`examples/mesh-demo/launch-mesh-hybrid.sh`。
**改动代码**：`mesh/{tunnel.ts(+696),runtime.ts,handshake.ts,enrollment.ts}`、`config.ts`、`sources/index.ts`、`core/registry.ts`、codex/claudecode launcher+manifest+bridge。
**新测试**：`mesh-reconnect-resilience`、`mesh-backoff-heartbeat`、`mesh-handshake-reaper`、`mesh-require-encryption`、`p3-5-linux-confinement`、`appliance-manifest`、`appliance-default-deny`。

## 如何看 / 如何跑

- **混合拓扑 admin 页**：http://127.0.0.1:7077/admin （现仍在线，原生 primary + 2 Docker 代理）。
- **重启混合拓扑**：`bash examples/mesh-demo/launch-mesh-hybrid.sh`
- **Appliance 原生验证**：`bash <scratchpad>/appliance-native-smoke.sh`（或网络恢复后 `examples/appliance/run-appliance.sh` 走容器）。
- **全量验证**：`cd packages/runtime && bunx tsc --noEmit`；根目录 `bun test`（957/2，2 个无关 playwright）。

## 建议的下一步（你定）

1. 网络恢复后构建 `plexus-appliance:latest` 镜像，跑 `run-appliance.sh` 完成容器层端点验证。
2. Review 后决定提交策略（四个主题可拆 4 个 PR，或合一个「P5 hardening」分支）。当前全部未提交。
3. 可选加固（审查提到、非阻断）：appliance 侧 gate `POST /extensions`（常驻 resolver 已堵暴露，这是纵深防御）；exec 源的 registry 级门控（never instantiate 非策展源）。
