---
title: Plexus 内部如何运作
description: Plexus 内部结构全景——编译模型、联邦 mesh、安全主干与线上协议，以及每一部分的深入阅读入口。
---

# 内部如何运作

[指南](/zh/guide/)教你运行 Plexus，[概念](/zh/concepts/)给你心智模型。本章写给工程师，讲这两层底下的东西：**内部结构长什么样，那些承重的论断在代码里怎么强制执行。**

这里的一切都建立在同一个形状上。Plexus 是装在用户本机的 **capability 网关**：单个进程，归个人所有，默认只绑定回环地址——开放局域网、或发布到隧道后面的公网域名，都是显式可选项——把机器上的工具挡在身前。AI agent 想触达它们，只能穿过默认拒绝、全程审计的边界；密钥本身绝不交出去。下面四个领域，就是这句话落地的方式。

## 四个内部界面

![一个 loopback 进程里的 Plexus——自描述 floor 与 per-agent 编译、联邦 mesh、安全模型并列](/diagrams/architecture-overview.png)

### 编译模型——会自我集成的资源

冷启动的 agent 面对再完美的自描述接口，也得*在运行时现学一套陌生协议*。Plexus 去掉了这一步：**把资源编译成 agent 自己的惯用语，以装好的形态交付**。始终在场的 **Floor**（`.well-known/plexus` + 请求形状 + 每个 capability 的 schema + 使用 skill）是任何 agent 的真相来源；在它之上，Plexus 确定性地渲染出按 agent 定制的产物（v1 是一个 Claude Code plugin），把选中的 capability 投影成该 agent 的原生形态。

投影是一层缓存，永远不是替代品——过期的 skill 越不过 Floor 的实时授权，网关始终是唯一的执行点。心智模型见[概念 / 编译模型](/zh/concepts/compile-model)，完整领域账本见 DDD SSOT
[`agent-skill-compile-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/agent-skill-compile-domain-model.md)。

### 联邦 mesh——一个入口，多个归属

capability 不必和 agent 对话的那台网关同机。**primary** 网关是 agent 的唯一入口——持有授权、运行授权器、汇聚审计——可以挂载任意数量 **proxy** 网关承载的 capability。proxy 挨着真实服务运行，向外拨出一条持久隧道，proxy 主机不开任何入站端口。对 agent 来说，调用挂载的 capability 和调用本地 capability 别无二致；capability 住在哪里只是路由细节，对授权模型不可见。

→ [联邦 mesh](/zh/architecture/mesh) —— 面向开发者的代码地图。

### 安全模型——两条信任边界

信任边界恰好两条，各由一方持有。**connection-key** 是所有者的管理员凭据，agent 永远不持有。每个 **agent** 用**自己那份持久的、按 agent 独立的 PAT** 认证；PAT 由一次性 enroll 码兑换一次得来，所以 agent 凭据即使泄漏，爆炸半径也只是那一个 agent 预先获授的 capability——且可独立撤销。敏感操作默认逐次批准：运行代码（`execute`）只有在所有者接入时为特定 agent + capability 显式开启（默认关闭、双重确认）后，才能搭上常驻授权——agent 自己永远解除不了这道逐次下限。

→ [安全模型](/zh/architecture/security-model) —— 权威的信任与授权模型，条条引用到代码。授权模型的*演进方向*——任务门票、企业级归因、可插拔策略——作为接缝锁定在[授权可扩展性](/zh/architecture/extensibility)（ADR-020）。

### 协议——线上契约

稳定的、AI 原生的线上契约，一切实现据此定型：
**DISCOVER → ENROLL → HANDSHAKE → GRANT → INVOKE**，契约版本 `0.1.3`。

→ [协议](/zh/protocol/)及其[决策记录](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/DECISIONS.md)。

## 更深的设计文档

这些文档在仓库里，是上面各页背后的设计 SSOT：

- [`architecture.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/architecture.md) —— 核心地图：四个平面、runtime 主干、三条扩展轴，以及不变量清单。
- [`authz-extensibility.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/authz-extensibility.md) —— 1.0 的授权接缝（门票与工牌，ADR-020）。
- [`federated-mesh-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/federated-mesh-domain-model.md) —— mesh 的 DDD SSOT（语言 + 不变量 A–G）。
- [`agent-skill-compile-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/agent-skill-compile-domain-model.md) —— 编译模型的 SSOT。
- [`capability-appliance.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/capability-appliance.md) —— 容器化装置（"暴露一个 capability，而非一整套系统"）。
- [`linux-confinement.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/linux-confinement.md) —— seatbelt → bwrap 的 exec 隔离映射。
- [`encryption-policy.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/encryption-policy.md) · [`networking-resilience.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/networking-resilience.md) · [`mesh-health-reporting.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/mesh-health-reporting.md) —— mesh 的传输、韧性与健康。
