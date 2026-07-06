---
title: 编译模型
description: 自描述的 Floor，以及作为其投影的专属编译 plugin——每个 agent 专属的 plexus launcher，以及为什么这条命令是 agent 唯一的接口。
---

# 编译模型

Plexus 不止让你的工具可达——它把"*你*该怎么调用*这些* capability"编译成每个 agent 的原生惯用法，装好
交付。本页专讲这套机制。想在语境里看完整心智模型，从[核心概念](/zh/concepts/)起步。

::: tip 它为什么存在
暴露面再怎么完美自描述，冷启动的 agent 仍要**临场学一套新协议**——集成者懂 MCP 和 REST，却很少见过
一个会解释"如何使用自己"的、定义良好的资源。解法不是一份更好的规格，而是**把资源编译进 agent 的原生
惯用法，随安装交付**——agent 不必*搞懂* Plexus，直接拿到一条原生命令。
:::

---

## Floor——那个始终在场的事实源

**Floor** 是始终在场、自描述的资源暴露面：

- `GET /.well-known/plexus`——capability 目录 + `requestShapes` + auth / enrollment 公示，
- 每项 capability 的 `io`（JSON-Schema 输入/输出），
- 附着的 `how-to-use` **skill**（markdown 指引），

……全部走纯 HTTP（或 MCP）。**任何 agent 不装任何产物都能用它**——enroll、handshake、grant、invoke
全都能从这里发现。agent 需要的东西没有一样藏在定制工具后面。这就是事实源；其余一切都是叠在它之上的视图。

Floor 连自己的引导都自描述：`.well-known/plexus` 公示 `auth.enrollment` 块（兑换 URL/方法、`body.code`、
`success.pat`、`patStorage` 指令、`errorCodes`），所以**没有 skill 的** agent 也能仅凭 Floor 自行 enroll，
直接从 `.well-known` 构造调用。

---

## 编译好的 plugin——一层投影，绝非替代品

在 Floor 之上，Plexus **为每个 agent 编译一件产物**（v1：一个 Claude Code plugin），让同样的 capability
在那个特定 agent 手里像原生的一样。这件产物是 **Floor 的投影——缓存和快捷方式，绝不是替代品。**

![自描述 Floor 与投影在其上的 per-agent 编译插件](/diagrams/floor-projection.png)

两条不变式让这层投影保持诚实：

- **叠加，不替代。** Floor 对任何 agent、任何 transport 始终生效。没有 Claude Code / Codex 在场 →
  什么都不生成，回落到 Floor。
- **陈旧也安全。** skill 只是投影，授权由网关**实时**强制，所以陈旧或误生成的 skill *永远*越不过
  Floor 的权限。最坏情况只在表面：它提到一项已撤销的 capability → invoke 在网关处直接失败；它漏掉
  一项新暴露的 → `list` 反正会把它列出来。所以自动更新是*新鲜度/UX* 特性，不是*安全*特性。

---

## `plexus-<agentId>` launcher

编译好的 plugin 随附一个**版本隔离的专属 launcher**，收起整条 `enroll → PAT → handshake → token → invoke`
链——agent 只看到一条原生命令，看不到管道。它叫 **`plexus-<agentId>`**（自带捆绑引擎 + 烧录的
`PLEXUS_AGENT_ID`），**绝不是**裸的全局 `plexus`，所以同一台主机上的两个 agent 永不冲突，各自锁定
自己的引擎版本。

它的子命令就是 agent 的全部词汇：

- **`plexus-<agentId> enroll <code>`**——兑换一次性码 → PAT → 自行保存（仅首次运行）。
- **`plexus-<agentId> list`**——**发现动词**：枚举这个 agent 的 capability，分为 **callable-now**
  （已有常驻授权）和 **needs-approval**，**skill**（使用指引，读作上下文——绝不走线上调用）单独成组。
  agent 靠它在行动前认清方向，而不是去猜 capability id——
  包括 plugin 编译*之后*才暴露的 capability（Floor 是活的；投影只是它的缓存）。
- **`plexus-<agentId> <capabilityId> [args]`**——invoke 一项 capability（例如
  `plexus-<agentId> obsidian.vault.read Welcome.md`）。需要批准的调用会**原地等待**：
  launcher 阻塞在广告出的 status 端点上，拥有者一批准立刻调用——发起一次、原地等待，绝不重试轮跑
  （`--no-wait` 可退出等待）。`plexus-<agentId> <skillId>` 会打印该 skill 的指引正文。

三层渐进式披露贯穿其中：一句话说明始终在上下文里 → skill 正文（指引，含 agent 原生的密钥管理建议）→
launcher 内部（永不进入 agent 上下文）。

---

## 这条命令是你唯一的接口

::: danger 编译好的 skill 直白陈述的一条硬规则
**每一次**交互都走 `plexus-<agentId> …`。**绝不**自己对网关拼 HTTP，**绝不**去猜认证头，**绝不**试图
铸造或读取 token。这条命令已经封装了经认可的认证流程；别的做法既没必要，也会被网关当作越权拒绝。
:::

这直接堵住了冷启动 agent 的一种失败模式：碰到一条含糊的错误，就去伪造凭据或读磁盘上的密钥。有了
launcher，公示的前进路径恰好只有一条——经审计、经拥有者批准的那条。

两条保证让这条命令值得信任：

- **认证/invoke 内核是模板化的，不是 LLM 写的。** 它从一个**确定性的、按 agent 类型区分的模板**渲染
  而来，由 Floor 的 `requestShapes` / `io` 填充——绝非即兴发挥。（让 LLM 写认证路径，可能写出一份越权
  教程；所以 LLM 只写教学性外壳——任务框定、示例——绝不写机制本身。）
- **产物里绝不烧录持久密钥。** 构建期校验器（`integration/verify-plugin.ts`）沿四条轴把渲染出的 plugin
  对着 Floor 校验：经认可的认证内核逐字节一致、没有烧录任何密钥、只引用被公示/已授予的 capability、
  走的是经认可的 enroll/handshake/invoke 流程。随安装走的只有那个短寿命、一次性的 enroll 码。

---

## 它如何契合凭据边界

launcher 存在，**正因为** `connection-key` **仅限管理员**，而每个 agent 用**它自己的**专属 PAT 认证。
skill 生成是**管理时、管理主机上**的行为，在配置/管理阶段完成，与调用路径解耦——Connect 流程里没有
实时驱动 CLI，调用路径上也没有运行时延迟。产物泄漏的爆炸半径限定在单个 agent 预先获授的那些 cap，
且可独立撤销——见[信任模型](/zh/concepts/trust-model)和[安全模型](/zh/architecture/security-model)。

支撑 agent 获授世界的扩展是**跨重启持久的**：添加的 source/capability 写入 `~/.plexus/extensions.json`，
启动时重放，所以它熬得过网关重启，而不是随进程内存一起蒸发。

---

## 接下来去哪

- **[读一遍就通](/zh/concepts/)**——完整的心智模型，包括本页依托的那套两层自描述协议。
- **[信任模型](/zh/concepts/trust-model)**——默认拒绝、两个时钟，以及 execute 为什么永远不能常驻。
- **[连接一个 agent](/zh/guide/connect-an-agent)**——看 launcher 端到端驱动一个真实的 Claude Code / Codex agent。
