---
title: Plexus 内部如何运作
description: Plexus 内部架构概览：编译模型、联邦网格、安全模型和消息交换协议，以及各部分的深入阅读入口。
---

# 内部如何运作

[指南](/zh/guide/)介绍怎样运行 Plexus，[概念](/zh/concepts/)帮助你建立对它的整体认识。本节深入工程实现，说明**内部究竟由什么组成，以及代码如何确保那些核心主张成立。**

Plexus 的基本架构是一个在本地运行、由用户自行安装的**能力网关**：它以单一进程运行，由人掌控，默认只绑定到回环地址。要扩大访问范围，无论是开放到 LAN，还是通过隧道以公共主机名对外提供访问，都必须明确选择启用。它为本机工具提供访问入口，让 AI agent 只能经过默认拒绝访问、完整审计的边界使用这些工具，绝不会把原始密钥交给它。下面四个部分说明这些要求如何落实。

## 内部架构的四个部分 {#四个内部界面}

![一个 loopback 进程里的 Plexus——自描述 floor 与 per-agent 编译、联邦 mesh、安全模型并列](/diagrams/architecture-overview.png)

### 编译模型——会自我集成的资源

初次接入的智能体，即使面对能完整描述自身的资源，仍得*临时学会一套新协议*。Plexus 省去了这一步：它**把资源编译成智能体原生支持的形式，安装好再交给它**。始终存在的 **Floor**（`.well-known/plexus` + 请求结构 + 各项能力的结构定义 + 使用指导 skills）是所有智能体的权威依据；Plexus 以此为准，按确定性规则为每个智能体生成产物（v1 为 Claude Code 插件），将选定的能力转成该智能体原生支持的形式。

投影是缓存，不能替代 Floor。过时的 skill 也不能超出 Floor 的实时授权，因此网关始终是唯一的授权管控点。概念说明见[概念／编译模型](/zh/concepts/compile-model)，完整的领域记录见 DDD SSOT [`agent-skill-compile-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/agent-skill-compile-domain-model.md)。

### 联邦网格——单一入口，能力多处部署 {#联邦-mesh——一个入口-多个归属}

能力与智能体所连接的网关不必部署在同一台机器上。**primary** 网关（智能体的接入点，负责保存授权、运行授权器和汇集审计记录）可以挂载任意数量的 **proxy** 网关所承载的能力。这些 proxy 网关部署在实际服务附近，各自主动向外建立一条持久隧道，proxy 主机无须为该隧道开放入站连接。智能体调用挂载能力的方式与调用本地能力完全相同；能力来源属于路由信息，不参与授权判断。

→ [联邦 mesh](/zh/architecture/mesh) —— 面向开发者的代码地图。

### 安全模型——两条信任边界

信任边界恰好有两道，分别由不同的主体掌握。**connection-key** 是所有者的管理凭证，agent 从不持有。每个 **agent** 都用**自己的持久 PAT** 验证身份，通过一次性注册码兑换一次即可获得。因此，agent 凭证泄露的影响只限于该 agent 预先获授的能力，其访问权限也可单独撤销。敏感操作默认每次使用都需批准。运行代码（`execute`）只有在所有者连接时，为特定 agent 的特定能力启用长期授权，才可免去逐次批准。这个选项默认关闭，启用须经两次确认，agent 不能自行解除逐次批准的限制。

→ [安全模型](/zh/architecture/security-model) ——信任与授权模型的权威说明，附有对应代码引用。任务票据、企业归属和可插拔策略属于模型的*后续扩展方向*，相应扩展点已在[授权可扩展性](/zh/architecture/extensibility)中确定（ADR-020）。

### 协议——消息交换约定 {#协议——线上契约}

这是各参与方交换消息时遵循的协议约定，稳定且原生面向 AI，其他部分的类型定义都以它为依据：**DISCOVER → ENROLL → HANDSHAKE → GRANT → INVOKE**，协议版本为 `0.1.3`。

→ [协议](/zh/protocol/)及其[决策记录](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/DECISIONS.md)。

## 更深的设计文档

这些文档在仓库里，是上面各页背后的设计 SSOT：

- [`architecture.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/architecture.md) —— 核心地图：四个平面、runtime 主干、三条扩展轴，以及不变量清单。
- [`authz-extensibility.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/authz-extensibility.md) — 1.0 授权机制的扩展点（ticket 与 badge 的区别，ADR-020）。
- [`federated-mesh-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/federated-mesh-domain-model.md) —— mesh 的 DDD SSOT（语言 + 不变量 A–G）。
- [`agent-skill-compile-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/agent-skill-compile-domain-model.md) —— 编译模型的 SSOT。
- [`capability-appliance.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/capability-appliance.md) — 能力的容器化封装（“对外开放一项能力，而不是一个系统”）。
- [`linux-confinement.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/linux-confinement.md) —— seatbelt → bwrap 的 exec 隔离映射。
- [`encryption-policy.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/encryption-policy.md) · [`networking-resilience.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/networking-resilience.md) · [`mesh-health-reporting.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/mesh-health-reporting.md) — 网格传输、网络容错和健康状态。
