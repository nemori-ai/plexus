---
title: Plexus 内部如何运作
description: Plexus 内部结构的全景图——编译模型、联邦 mesh、安全脊柱与线上协议——以及每一部分深入阅读的入口。
---

# 内部如何运作

[指南](/zh/guide/)告诉你如何运行 Plexus，[概念](/zh/concepts/)给你心智模型。本章节是它们之下那一层工程师的地板：**内部结构究竟是什么，以及那些承重的论断在代码里是如何被强制执行的。**

这里的一切都建立在同一个形状之上。Plexus 是一个本地的、由用户安装的 **capability 网关**：一个人所拥有的、运行在环回地址上的单一进程，它把用户机器上的工具挡在身前，并让 AI agent 只能通过一道默认拒绝、全程审计的边界去触达这些工具——绝不把原始密钥交出去。下面这四个领域，就是这一句话如何被落到实处的方式。

## 四个内部界面

### 编译模型——会自我集成的资源

一个冷启动的 agent，哪怕面对一个完美的自描述界面，仍然得*在运行时现学一套陌生的协议*。Plexus 去掉了这一步：它**把资源编译成 agent 自己的惯用语，并以已安装的形态交付**。一个始终在场的 **Floor**（`.well-known/plexus` + 请求形状 + 每个 capability 的 schema + 使用技能）是任何 agent 的真相来源；在它之上，Plexus 确定性地渲染出一份按 agent 定制的产物（v1：一个 Claude Code plugin），把选中的 capability 投影成该 agent 的原生形态。

这份投影是一层缓存，永远不是替代品——一个陈旧的技能永远无法超出 Floor 的实时授权，所以网关始终是唯一的执行点。心智模型请读[概念 / 编译模型](/zh/concepts/compile-model)，完整的领域账本请读 DDD SSOT
[`agent-skill-compile-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/agent-skill-compile-domain-model.md)。

### 联邦 mesh——一扇前门，多个归属

一个 capability 不必与 agent 所对话的网关处在同一台机器上。一个 **primary** 网关（agent 的前门：它持有授权、运行授权器、汇聚审计）可以挂载由任意数量的 **proxy** 网关承载的 capability，这些 proxy 挨着真实服务运行，并向外拨出一条持久隧道——proxy 主机上不开任何入站口。agent 调用一个挂载的 capability，与调用一个本地 capability 别无二致；来源只是一个对授权模型不可见的路由细节。

→ [联邦 mesh](/zh/architecture/mesh) —— 面向开发者的代码地图。

### 安全模型——两条信任边界

恰好存在两条信任边界，分别由两个不同的当事方持有。**connection-key** 是所有者的管理员凭据，agent 永远不持有它。每个 **agent** 用**自己那份持久的、按 agent 独立的 PAT** 认证，该 PAT 从一次性登记码兑换一次得来，因此一份泄露的 agent 凭据其影响面就是那一个 agent 预先获授的 capability——且可独立吊销。敏感操作无法被预先批准：运行代码（`execute`）永远不能搭乘一个常驻授权，即便在管理员给定的信任窗口之下也不行。

→ [安全模型](/zh/architecture/security-model) —— 权威的信任与授权模型，条条引用到代码。

### 协议——线上契约

一切据以打字的、稳定的、AI 原生的契约：
**DISCOVER → ENROLL → HANDSHAKE → GRANT → INVOKE**，契约版本 `0.1.3`。

→ [协议](/zh/protocol/)及其[决策记录](/zh/protocol/decisions)。

## 更深的设计文档

这些文档存于仓库中——它们是上面各页背后的设计 SSOT：

- [`federated-mesh-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/federated-mesh-domain-model.md) —— mesh 的 DDD SSOT（语言 + 不变量 A–G）。
- [`agent-skill-compile-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/agent-skill-compile-domain-model.md) —— 编译模型的 SSOT。
- [`capability-appliance.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/capability-appliance.md) —— 容器化装置（"暴露一个 capability，而非一整套系统"）。
- [`linux-confinement.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/linux-confinement.md) —— seatbelt → bwrap 的 exec 隔离映射。
- [`encryption-policy.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/encryption-policy.md) · [`networking-resilience.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/networking-resilience.md) · [`mesh-health-reporting.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/mesh-health-reporting.md) —— mesh 的传输、韧性与健康。
