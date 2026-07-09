---
title: 快速上手
description: 两个决定就能跑起来——网关跑在哪，谁能连上它。选一格，让你的 agent 驱动安装，再看信任回环自证一遍。
---

# 快速上手

Plexus 站在**资源侧**。网关归你所有，挡在你机器上的工具前面；AI agent 想够到它们，只能穿过这道
默认拒绝、全程审计的边界，密钥本身绝不交出去。这套模型在哪都一样。你先选的只有**管线**：
*网关跑在哪*，*谁能连上它*。

那就在下面选一格——网关落在哪台机器上，网络够到多远。选完去[**看信任回环**](/zh/guide/run-it)，
学那件永远不变的事：一次调用如何被发现、授予、执行、撤销。

**最快的入口：让你的 agent 帮你装好。** 选好你的那一格，复制那段话，粘给 Claude Code 或 Codex——它会读
真实的 runbook、把整套配置跑完，边做边叙述，遇到需要你决定或批准的地方就停下来。

<GetStartedSelector />

---

## 每种场景共有的东西

两个角色，自始至终分清——机器换了、线变长了，这一点不变：

- **你是 admin。** 你持有 **connection-key**，即管理凭据；它认证 `/admin` 控制台。**你绝不把它交给 agent。**
- **agent 拿它自己的凭据。** 连接一个 agent 时，它 enroll 得到一份持久的**按 agent 独立的 PAT**，
  用它调用——绝不用 connection-key。

够得着网关，agent 单凭这一点什么都拿不到：enroll 需要你铸的 code，调用需要你批准的 grant，
`execute` 默认逐次批准——只有你在连接时为该 agent + capability 显式开启（默认关闭、双重确认），
它才搭常驻 grant——connection-key 也没有出现在任何 agent 可达的路由上。所以发布到局域网
或隧道，只是可达性变了，信任故事没有新篇。

::: tip 平台
macOS（Apple Silicon 或 Intel）是首要目标；Apple Calendar / Reminders 源仅限 macOS。**headless Linux**
网关已端到端验证（Ubuntu + Bun，跑在 Docker 里），承载可跨平台移植的源——见
[Linux runbook](https://github.com/nemori-ai/plexus/blob/main/docs/deploy-linux.md)。
:::

对心智模型还陌生？先读**[核心概念](/zh/concepts/)**：Connector → Source → Capability、来源、两个时钟、
自描述的 Floor——把这几个概念弄明白，其余的都好读。权威的信任边界在**[安全模型](/zh/architecture/security-model)**。
