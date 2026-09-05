---
title: "快速上手"
description: "先确定网关跑在哪、谁能连接它，再从对应的格子选择部署方式，让 agent 按所选方式执行安装。随后走一遍信任闭环，检查授权、调用和撤销如何衔接。"
---
# 快速上手 {#快速上手}

Plexus 站在资源侧。网关归你所有，挡在你机器上的工具前面；AI agent 要使用这些工具，必须经过这道默认拒绝、全程审计的边界，工具背后的密钥不会交给它。无论网关部署在哪里，这套规则都不变。

先选两件事：网关跑在哪台机器上，以及网络要让谁够得着它。下面的选择器按这两个条件给出配置入口。选好以后，可以去[看信任闭环](/zh/guide/run-it)，跟着一次调用走过发现、授予、执行和撤销。

最快的办法，是让你的 agent 帮你安装。选好适合自己的那一格，把其中的配置说明复制给 Claude Code 或 Codex，让它读取实际的 runbook，再照着完成整套配置。

它会边做边说明进展。遇到必须由你决定或批准的地方，就停下来等你，不会替你作主。

<GetStartedSelector />

---

## 每种场景共有的东西 {#每种场景共有的东西}

你是 admin。你持有 `connection-key`，这是认证 `/admin` 控制台的管理凭据，绝不交给 agent。

agent 用的是自己的凭据。连接时，你签发一个一次性的 enrollment code；agent 用这个 code 完成 enroll，换取持久的、按 agent 独立的 PAT。agent 在 handshake 时用 PAT 认证身份。

握手之后，agent 收到你为它选定的能力子集 manifest，知道有哪些操作、怎样使用。网络可达和拿到这份清单，都不赋予调用权限。实际调用还需要有范围的授权，以及据此取得的 scoped token。`connection-key` 也不会出现在任何 agent 可达的路由上。把网关发布到局域网或隧道，只改变谁能连上它，不改变谁能批准调用。

连接时，你选定的 `read` 能力会获得常驻 grant。`write` 和 `execute` 默认逐次批准；已有符合条件、仍然有效的常驻 grant 时，范围内的调用才不必反复提示。普通 `write` 可以在获批后常驻，但仍受 capability 的敏感度限制，不能把这条安排套到所有写入操作上。

`execute` 或其他高敏感度 capability 默认只允许 `once`。agent 不能自行放宽这个限制。连接时，只有拥有者能为特定的 agent + capability 组合显式开启常驻 `execute`；这个开关默认关闭，开启需要双重确认。只有你刻意开启，才可使用常驻授权；高敏感度的 `write` 也不能绕过这项限制。

::: tip 平台
macOS（Apple Silicon 或 Intel）是首要目标；Apple Calendar / Reminders 源仅限 macOS。headless Linux 网关已完成端到端验证，验证路径是 Docker 中的 Ubuntu + Bun，用于承载可跨平台移植的源。部署步骤见 [Linux 部署手册](https://github.com/nemori-ai/plexus/blob/main/docs/deploy-linux.md)。
:::

还不熟悉这些概念，可以先读[核心概念](/zh/concepts/)，了解 Connector → Source → Capability、来源、三个时钟，以及自描述的 Floor。信任边界的权威说明见[安全模型](/zh/architecture/security-model)。
