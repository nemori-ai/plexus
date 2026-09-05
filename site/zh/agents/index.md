---
title: "agent 如何使用 Plexus"
description: "使用编译集成的编码 agent 连接后，以 launcher 这条命令作为完整且唯一的接口：enroll 一次，用 list 发现能力，取得授权后再按 capability id invoke。独立 HTTP 客户端也可直接使用 Floor，无须插件。"
---
# agent 如何使用 Plexus {#agent-如何使用-plexus}

本页写给 agent，也写给替 agent 做配置的人。这里假定连接已经完成：所有者跑过“连接一个 agent”，授予你一组起始 capability，并给了你一条带一次性 enroll 码的一键安装命令。还没有这条命令，请先看[连接一个 agent](/zh/guide/connect-an-agent)。

plugin 装好后，使用这套编译集成的 agent 只有一个接口：按版本隔离、名为 `plexus-<agentId>` 的 launcher。它捆绑自己的引擎，内部固定了你的 `PLEXUS_AGENT_ID`。同一主机上的两个 agent 不会因此冲突，每个 launcher 也各自锁定版本。调用路径上没有共享的全局 `plexus` 命令。

::: tip 这套集成只通过 launcher 交互
使用编译集成时，一切交互都走 `plexus-<agentId> …`。不要自行向网关发送 HTTP 请求，不要猜 auth 头，也不要尝试铸造或读取 token。launcher 已经封装了受认可的 `enroll → handshake → grant → invoke` 流程，凭证处理也交给它。

这条规则只约束使用编译集成的 agent。独立 HTTP 客户端可以不装 plugin，直接使用 Floor。因此，一件事能否通过 launcher 完成，不能作为网关是否授权它的通用判断；最终仍由网关执行授权检查，拒绝不符合授权要求的请求。
:::

## 三个命令 {#三个动词}

![agent 的五步循环：discover、enroll、handshake、grant、invoke](/diagrams/protocol-loop.png)

### `plexus-<agentId> enroll`：只需一次 {#plexus-agentid-enroll-——-一次}

```
plexus-<agentId> enroll <one-time-code>
```

这是首次使用的登记步骤，一键安装通常会自动替你完成。launcher 用一次性 enroll 码兑换持久的、按 agent 独立的 PAT，前缀为 `plx_agent_…`。这是 agent 的身份凭证，不是所有者用于管理的 connection-key。

PAT 由 launcher 存在自己的 home 下，文件权限为 `0600`，不会进入 agent 上下文。如果配置者已有自己的凭证管理方式，可以通过 `PLEXUS_PAT` 环境变量覆盖文件中保存的值；在这套集成里，agent 仍不应自行处理凭证。

enroll 码只能用一次，兑换后即失效，此后保存的 PAT 就是你的身份凭证，不必为每个会话重新 enroll。launcher 会用它完成后续需要认证的 handshake；保存 PAT 并不意味着已有永久会话，也不意味着以后无需握手。至此，登记完成，凭证由 launcher 留存。


### `plexus-<agentId> list`：先发现可用项 {#plexus-agentid-list-——-用来发现}

```
plexus-<agentId> list
```

用 `list`，不要猜 capability id。它让你在行动前知道有哪些操作可选、哪些还要等批准。它根据握手后交付的 per-agent manifest 列出 capability：这些是所有者为你选定、并且仍允许暴露的能力，而不是全部已注册能力。选入子集和完成握手，都不等于取得调用许可；具体能否调用，还要看授权。

发现结果分三组：

- **callable-now** —— 已有当前符合条件的常驻授权，可以直接调用，不必再问所有者。
- **needs-approval** —— 在选定子集内，但没有生效的常驻授权。`write`／`execute` 默认按次批准，没有适用的所有者授权常驻安排时，每次调用都会挂起，等待所有者决定。授权已过期或已被撤销，也可能需要重新批准。子集之外的请求则直接拒绝，不会挂起。
- **skills** —— 使用指引，作为上下文来读；`plexus-<agentId> <id>` 打印的是指南，而不是发起一次线上调用。

这里的常驻安排必须来自所有者。所有者可以为特定 agent 与 capability 开启常驻授权。`write` 还有两条途径：待批请求获批时设定有效的信任窗口，或由所有者明确直接授予常驻授权。`execute` 则必须由所有者明确开启，agent 不能靠请求自行放宽限制。

暴露设置可以单独否决调用。所有者关闭某项 capability 的暴露后，它既不再被发现，也不能获得授权；即使已有有效授权，调用仍会被拒绝。

### `plexus-<agentId> <capabilityId>`：按 id 调用 {#plexus-agentid-capabilityid-——-用来调用}

```
plexus-<agentId> workspace.read path=notes/plexus.md
```

按 id 调用一个 capability，输入用 `key=value` 传入（复杂形状用 `--input '<json>'`）。launcher 在底层走完 `PAT → scoped token → invoke` 链路，再把结果交回给你；凭证处理和这些管道细节不会进入你的上下文。

如果需要批准，这次 invoke 会返回结构化的待批状态，指向所有者的控制台。你不能给自己铸造 token，也不应从错误中寻找自行授权的办法。这不妨碍 launcher 沿获准的 grant 流程取得 scoped token：已有符合条件的常驻授权就使用它，否则等待所有者批准，再继续调用。发现告诉你可以请求什么，真正执行仍以当时的暴露设置和授权检查为准。


## 为什么用这个接口 {#为什么是这个形状}

launcher 的意义，是让你永远不必推理线上协议。它的 `auth/invoke` 内核按 agent 类型，由确定性模板渲染生成，构建时还会与 Floor 逐字节校验。这部分不是 LLM 写的。

在这套编译集成里，launcher 封装了受认可的凭证生命周期，获准的操作都能通过前面的三个命令完成。独立客户端仍可以直接发送 HTTP 请求，网关会检查它的权限；请求走哪个入口，本身不能说明它是否越权。

随 plugin 发布的 skill 只是 Floor 的一层投影，不是替代品。你可以依据 `list` 的结果选择下一步，不必猜协议，但发现结果不是调用许可。即便 skill 已经过期，实际能运行什么，仍以网关当下的暴露设置和实时授权检查为准。

## 继续阅读 {#深入了解}

[为 agent 建立连接](/zh/guide/connect-an-agent)：看所有者如何生成交给你的安装命令。

[理解编译模型](/zh/concepts/compile-model)：看资源如何用你惯用的方式接纳你，而不是让你另学一套协议。
