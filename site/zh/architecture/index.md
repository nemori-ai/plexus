---
title: Plexus 内部如何运作
description: Plexus 内部结构全景——编译模型、联邦 mesh、安全主干与线上协议，以及每一部分的深入阅读入口。
---

# 内部如何运作

[指南](/zh/guide/)介绍怎样运行 Plexus，[概念](/zh/concepts/)帮助你建立对它的整体认识。本节深入工程实现，说明**内部究竟由什么组成，以及代码如何确保那些核心主张成立。**

Plexus 的基本架构是一个在本地运行、由用户自行安装的**能力网关**：它以单一进程运行，由人掌控，默认只绑定到回环地址。要扩大访问范围，无论是开放到 LAN，还是通过隧道以公共主机名对外提供访问，都必须明确选择启用。它为本机工具提供访问入口，让 AI agent 只能经过默认拒绝访问、完整审计的边界使用这些工具，绝不会把原始密钥交给它。下面四个部分说明这些要求如何落实。

## 四个内部界面

![一个 loopback 进程里的 Plexus——自描述 floor 与 per-agent 编译、联邦 mesh、安全模型并列](/diagrams/architecture-overview.png)

### 编译模型——会自我集成的资源

冷启动的 agent 面对再完美的自描述接口，也得*在运行时现学一套陌生协议*。Plexus 去掉了这一步：**把资源编译成 agent 自己的惯用语，以装好的形态交付**。始终在场的 **Floor**（`.well-known/plexus` + 请求形状 + 每个 capability 的 schema + 使用 skill）是任何 agent 的真相来源；在它之上，Plexus 确定性地渲染出按 agent 定制的产物（v1 是一个 Claude Code plugin），把选中的 capability 投影成该 agent 的原生形态。

投影是缓存，不能替代 Floor。过时的 skill 也不能超出 Floor 的实时授权，因此网关始终是唯一的授权管控点。概念说明见[概念／编译模型](/zh/concepts/compile-model)，完整的领域记录见 DDD SSOT [`agent-skill-compile-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/agent-skill-compile-domain-model.md)。

### 联邦 mesh——一个入口，多个归属

capability 不必和 agent 对话的那台网关同机。**primary** 网关是 agent 的唯一入口——持有授权、运行授权器、汇聚审计——可以挂载任意数量 **proxy** 网关承载的 capability。proxy 挨着真实服务运行，向外拨出一条持久隧道，proxy 主机不开任何入站端口。对 agent 来说，调用挂载的 capability 和调用本地 capability 别无二致；capability 住在哪里只是路由细节，对授权模型不可见。

→ [联邦 mesh](/zh/architecture/mesh) —— 面向开发者的代码地图。

### 安全模型——两条信任边界

信任边界恰好有两道，分别由不同的主体掌握。**connection-key** 是所有者的管理凭证，agent 从不持有。每个 **agent** 都用**自己的持久 PAT** 验证身份，通过一次性注册码兑换一次即可获得。因此，agent 凭证泄露的影响只限于该 agent 预先获授的能力，其访问权限也可单独撤销。敏感操作默认每次使用都需批准。运行代码（`execute`）只有在所有者连接时，为特定 agent 的特定能力启用长期授权，才可免去逐次批准。这个选项默认关闭，启用须经两次确认，agent 不能自行解除逐次批准的限制。

→ [安全模型](/zh/architecture/security-model) —— 权威的信任与授权模型，条条引用到代码。授权模型的*演进方向*——任务门票、企业级归因、可插拔策略——作为接缝锁定在[授权可扩展性](/zh/architecture/extensibility)（ADR-020）。

### 协议——线上契约

这是各参与方交换消息时遵循的协议约定，稳定且原生面向 AI，其他部分的类型定义都以它为依据：**DISCOVER → ENROLL → HANDSHAKE → GRANT → INVOKE**，协议版本为 `0.1.3`。

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
