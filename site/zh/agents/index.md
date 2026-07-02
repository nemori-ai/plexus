---
title: agent 如何使用 Plexus
description: 一旦连接完成，编码 agent 通过唯一的 launcher 驱动一切——登记一次，用 list 发现，然后按 capability id 调用 invoke。这条命令就是它完整而唯一的界面。
---

# agent 如何使用 Plexus

本页写给 agent——或写给替 agent 做配置的人。它假定你已经被**连接**过了：某位所有者运行了"连接一个 agent"，授予了你一组起始 capability，并交给你一条携带了一次性登记码的一键安装命令。如果这一步还没发生，请从[连接一个 agent](/zh/guide/connect-an-agent)开始。

plugin 安装好之后，你有且仅有一个界面：一个**按版本隔离、名为 `plexus-<agentId>` 的 launcher**。它捆绑了自己的引擎，并把你的 `PLEXUS_AGENT_ID` 烘焙在内，因此同一主机上的两个 agent 永不冲突，且每个 launcher 各自锁定自己的版本。调用路径上永远不会出现一个全局的 `plexus`。

::: tip 唯一的规则
launcher 是你**完整而唯一**的界面。一切交互都通过 `plexus-<agentId> …` 来驱动。永远不要自己手搓针对网关的 HTTP，永远不要猜测某个 auth 头，永远不要试图铸造或读取一个令牌。这条命令已经封装好了受认可的 `enroll → handshake → grant → invoke` 流程——**如果某件事无法通过这条命令完成，那它就没有被以那种方式授权**，网关也会拒绝这次尝试。
:::

## 三个动词

![五步 agent 循环 — discover、enroll、handshake、grant、invoke](/diagrams/protocol-loop.png)

### `plexus-<agentId> enroll` —— 一次

```
plexus-<agentId> enroll
```

首次运行的引导。它用一次性登记码兑换出你**持久的、按 agent 独立的 PAT**（`plx_agent_…`），并由你自己、以你自己的范式存放（例如一个 `.env`），权限 `0600`。登记码是单次使用的，兑换即失效；PAT 只被返回恰好一次，此后便是你的身份。你只运行这条命令**一次**——之后每个会话都从存好的 PAT 开始，已经处于认证状态。

### `plexus-<agentId> list` —— 用来发现

```
plexus-<agentId> list
```

发现用的动词，也是你行动前定位自己的方式。它列举出*你的* capability，分成两组：

- **callable-now** —— 你持有常驻授权的 capability，可直接调用。
- **needs-approval** —— 你第一次请求时会为所有者挂起待批的 capability（每一个 `write`/`execute`，以及扩展源上的任何东西）。

用 `list`，而不要去猜 capability id。它是 launcher 已经能告诉你的那些关于它自身的信息的一个符合人体工学的前端——是对那个始终在场、自描述的 Floor 的一层投影。

### `plexus-<agentId> <capabilityId>` —— 用来调用

```
plexus-<agentId> fs.read '{ "path": "notes/plexus.md" }'
```

按 id 调用一个 capability。在底层，launcher 执行整条 `PAT → 受限令牌 → invoke` 链路并把结果交回给你；这些管道永远不会进入你的上下文。如果某个 capability 需要批准，这次 invoke 会浮现出一个结构化的待批状态，指向所有者的控制台——**你无法铸造自己的令牌**，并且不会有任何错误暗示你可以。

## 为什么是这个形状

launcher 存在的意义，就是让你永远不必对线上协议进行推理。它的 auth/invoke 内核是从一份确定性的、按 agent 类型的模板渲染出来的，并在构建时对着 Floor 做逐字节校验——它不是由 LLM 撰写的，也不可能发布出一条越权的 auth 路径。你能合法做的一切，都可以通过上面三个动词触达；其余一切，网关按设计一律拒绝。

随 plugin 一起发布的技能是 Floor 上的一层*投影*，而非它的替代品——所以即便技能陈旧了，网关的实时授权仍是唯一决定实际运行什么的东西。这正是你为何可以信任 `list` 并直接据此行动。

## 深入了解

- [连接一个 agent](/zh/guide/connect-an-agent) —— 生成你的安装命令的、所有者一侧的流程。
- [编译模型](/zh/concepts/compile-model) —— 为什么资源用你自己的惯用语来接纳*你*，而不是逼你去学一套协议。
