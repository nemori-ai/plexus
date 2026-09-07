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

这是首次运行时的初始化步骤，一键安装通常会替你完成。它用一次性注册码换取**该代理专属的长期 PAT**（`plx_agent_…`），由启动器自行保存到自己的主目录，文件权限为 `0600`；PAT 不会进入你的上下文。（如果你有自己的凭证管理习惯，可以设置 `PLEXUS_PAT` 环境变量，让启动器优先使用其中的凭证，而非已存文件。）注册码只能使用一次，兑换后即失效；此后，保存的凭证就是你的身份凭据。你只需运行**一次**，之后每个会话启动时都会复用启动器保存的凭证，完成认证。

### `plexus-<agentId> list` —— 用来发现

```
plexus-<agentId> list
```

发现用的动词，也是你行动前定位自己的方式。它列出*你的* capability——所有者授权给你的那个子集——分三组：

- **callable-now** —— 你持有常驻授权，可直接调用。
- **needs-approval** —— 在你的授权子集内、但没有生效常驻授权的 capability：主要是所有者未开启常驻的带副作用（`write`/`execute`）capability（每次调用都会挂起、等所有者批准），以及已过期或已被撤销的授权。授权子集之外的请求会被直接拒绝，不会挂起。
- **skills** —— 使用指引，作为上下文来读；`plexus-<agentId> <id>` 打印的是指南，而不是发起一次线上调用。

用 `list`，不要猜 capability id。它呈现的是你的 per-agent manifest 的一层投影——所有者授权给你的那些 capability，握手之后才交付——所以它展示的恰好就是你的授权子集，不多不少。

### `plexus-<agentId> <capabilityId>` —— 用来调用

```
plexus-<agentId> workspace.read path=notes/plexus.md
```

按能力 ID 调用，以 `key=value` 对传入输入（输入结构较复杂时可用 `--input '<json>'`）。启动器会在后台完成整个 `PAT → scoped token → invoke` 流程，再把结果交给你；这些认证和调用步骤不会进入你的上下文。如果能力需要审批，调用会返回结构化的待审批状态，指向所有者的控制台——**你不能自行签发令牌**，任何错误信息也都不会建议你这样做。

## 为什么是这个形状

有了启动器，你就不必操心底层通信协议的细节。它的认证与调用核心由对应代理类型的确定性模板生成，构建时会与 Floor 逐字节校验；这部分代码不由 LLM 编写，也不可能将越权的认证路径带入发布版本。你有权执行的所有操作，都能通过上面三个命令完成；其余操作，网关会按设计拒绝。

随 plugin 发布的 skill 是 Floor 的一层*投影*，不是替代品——即便 skill 过期，实际运行什么仍由网关的实时授权决定。这就是你可以信任 `list` 并直接据此行动的原因。

## 深入了解

- [连接一个 agent](/zh/guide/connect-an-agent) —— 所有者一侧生成你的安装命令的流程。
- [编译模型](/zh/concepts/compile-model) —— 为什么是资源用你的惯用语来接纳*你*，而不是逼你学一套协议。
