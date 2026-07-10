---
title: agent 如何使用 Plexus
description: 连接完成后，编码 agent 只通过一个 launcher 驱动一切——enroll 一次，用 list 发现，再按 capability id invoke。这条命令是它完整且唯一的接口。
---

# agent 如何使用 Plexus

本页写给 agent，也写给替 agent 做配置的人。它假定**连接**这一步已经完成：所有者跑过"连接一个 agent"，授了你一组起始 capability，给了你一条带一次性 enroll 码的一键安装命令。如果这一步还没发生，请先看[连接一个 agent](/zh/guide/connect-an-agent)。

plugin 装好之后，你有且只有一个接口：一个**按版本隔离、名为 `plexus-<agentId>` 的 launcher**。它捆绑自己的引擎，并把你的 `PLEXUS_AGENT_ID` 写死在内——同一主机上的两个 agent 永不冲突，每个 launcher 各自锁定版本。调用路径上不存在全局的 `plexus`。

::: tip 唯一的规则
launcher 是你**完整且唯一**的接口。一切交互都走 `plexus-<agentId> …`。不要自己手搓对网关的 HTTP，不要猜 auth 头，不要试图铸造或读取 token。这条命令已经封装了受认可的 `enroll → handshake → grant → invoke` 流程——**一件事如果不能通过这条命令完成，就说明它没有被授权以那种方式发生**，网关也会拒绝这次尝试。
:::

## 三个动词

![五步 agent 循环 — discover、enroll、handshake、grant、invoke](/diagrams/protocol-loop.png)

### `plexus-<agentId> enroll` —— 一次

```
plexus-<agentId> enroll <one-time-code>
```

首次运行的引导——一键安装通常会替你跑完这一步。它用一次性 enroll 码兑换出你**持久的、按 agent 独立的 PAT**（`plx_agent_…`），凭证由 launcher 自己存放在它的 home 下，权限 `0600`——PAT 不会进入你的上下文。（如果你用自己的惯用语管理凭证，`PLEXUS_PAT` 环境变量可以覆盖存好的文件。）enroll 码单次有效，兑换即失效；此后存好的凭证就是你的身份。这条命令只运行**一次**——之后每个会话都从 launcher 存好的凭证出发，直接处于已认证状态。

### `plexus-<agentId> list` —— 用来发现

```
plexus-<agentId> list
```

发现用的动词，也是你行动前定位自己的方式。它列出*你的* capability——所有者授权给你的那个子集——分三组：

- **callable-now** —— 你持有常驻授权，可直接调用。
- **needs-approval** —— 在你的授权子集内、但没有生效常驻授权的 capability：主要是所有者未开启常驻 execute 的 `execute` capability（每次调用都会挂起、等所有者批准），以及已过期或已被撤销的授权。授权子集之外的请求会被直接拒绝，不会挂起。
- **skills** —— 使用指引，作为上下文来读；`plexus-<agentId> <id>` 打印的是指南，而不是发起一次线上调用。

用 `list`，不要猜 capability id。它呈现的是你的 per-agent manifest 的一层投影——所有者授权给你的那些 capability，握手之后才交付——所以它展示的恰好就是你的授权子集，不多不少。

### `plexus-<agentId> <capabilityId>` —— 用来调用

```
plexus-<agentId> workspace.read path=notes/plexus.md
```

按 id 调用一个 capability，输入用 `key=value` 传入（复杂形状用 `--input '<json>'`）。底层由 launcher 走完整条 `PAT → scoped token → invoke` 链路，把结果交回给你；这些管道不会进入你的上下文。如果 capability 需要批准，这次 invoke 会返回一个结构化的待批状态，指向所有者的控制台——**你无法给自己铸造 token**，也不会有任何错误暗示你可以。

## 为什么是这个形状

launcher 存在的意义，是让你永远不必推理线上协议。它的 auth/invoke 内核由确定性的、按 agent 类型的模板渲染而来，构建时对着 Floor 做逐字节校验——不是 LLM 写的，也发不出一条越权的 auth 路径。你能合法做的一切，上面三个动词都能触达；其余的，网关按设计一律拒绝。

随 plugin 发布的 skill 是 Floor 的一层*投影*，不是替代品——即便 skill 过期，实际运行什么仍由网关的实时授权决定。这就是你可以信任 `list` 并直接据此行动的原因。

## 深入了解

- [连接一个 agent](/zh/guide/connect-an-agent) —— 所有者一侧生成你的安装命令的流程。
- [编译模型](/zh/concepts/compile-model) —— 为什么是资源用你的惯用语来接纳*你*，而不是逼你学一套协议。
