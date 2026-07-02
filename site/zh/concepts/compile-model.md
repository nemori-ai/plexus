---
title: 编译模型
description: 自描述的 Floor，以及作为其上一层投影的专属编译 plugin——plexus-<agentId> launcher，以及为什么这条命令是 agent 唯一的接口。
---

# 编译模型

Plexus 不只是让你的工具可达——它交给每个 agent"这就是*你*调用*这些* capability 的确切方式"，编译进那个 agent
的原生惯用法并安装好。本页是对这一切如何运作的专注阅读。想在语境里看整个心智模型，先从[核心概念](/zh/concepts/)
起步。

::: tip 它为什么存在
即便一个完美自描述的暴露面，仍然会让一个冷启动的 agent **临场去学一套新协议**——集成者懂 MCP 和 REST；他们
鲜少见过一个会解释如何使用*自己*的、定义良好的资源。解法不是一份更好的规格。解法是**把资源编译进 agent 的
原生惯用法并连同安装一起交付**——于是 agent 不是去*搞懂* Plexus，而是被递到手一条原生命令。
:::

---

## Floor——那个始终在场的事实源

**Floor** 是那个始终在场、自描述的资源暴露面：

- `GET /.well-known/plexus`——capability 目录 + `requestShapes` + auth / enrollment 公示，
- 每项 capability 的 `io`（JSON-Schema 输入/输出），
- 附着的 `how-to-use` **skill**（markdown 指引），

……在纯 HTTP（或 MCP）之上。**它对*任何* agent 都起作用，无需安装任何产物**——enroll、handshake、grant、invoke
全都可从它那里发现。一个 agent 需要的任何东西都不藏在定制工具之后。这是事实源；其余一切都是叠在它之上的一个
视图。

Floor 甚至自描述它自己的引导：`.well-known/plexus` 公示 `auth.enrollment` 块（兑换 URL/方法、`body.code`、
`success.pat`、`patStorage` 指令、`errorCodes`），因此一个**没有 skill 的** agent 可以仅凭 Floor 就自行 enroll，
并直接从 `.well-known` 构造调用。

---

## 编译好的 plugin——一层投影，绝非替代品

在 Floor 之上，Plexus **为每个 agent 编译一件产物**（v1：一个 Claude Code plugin），让同样的 capability 对那个
特定 agent 感觉起来是原生的。这件产物是**对 Floor 的一层投影——一个缓存/快捷方式，绝不是替代品。**

![自描述 Floor 与投影在其上的 per-agent 编译插件](/diagrams/floor-projection.png)

两条不变式让这层投影保持诚实：

- **叠加式，绝非替代。** Floor 对任何 agent、在任何 transport 上始终起作用。没有 Claude Code / Codex 在场 →
  什么都不生成，回落到 Floor。
- **陈旧是安全的。** 因为一个 skill 是一层投影、而网关**实时**强制授权，一个陈旧或误生成的 skill *永远*无法
  超出 Floor 的权限。最坏情况是表面性的：它提到一项已撤销的 capability → invoke 直接在网关处失败；或者它漏掉
  一项新暴露的 → `list` 反正会把它浮现出来。所以自动更新是一个*新鲜度/UX*特性，而非一个*安全*特性。

---

## `plexus-<agentId>` launcher

编译好的 plugin 随附一个**版本隔离的专属 launcher**，它隐藏了整条 `enroll → PAT → handshake → token → invoke`
链——agent 只看到一条原生命令，从不看到管道。它是 **`plexus-<agentId>`**（它自己捆绑的引擎 + 一个烧进去的
`PLEXUS_AGENT_ID`），**绝不**是一个裸的全局 `plexus`，因此一台主机上的两个 agent 永不冲突，且各自钉定自己的
引擎版本。

它的子命令就是 agent 的全部词汇：

- **`plexus-<agentId> enroll <code>`**——兑换一次性码 → PAT → 自存（仅首次运行）。
- **`plexus-<agentId> list`**——**发现动词**：枚举这个 agent 的 capability，分成 **callable-now**（已常驻授权）
  vs **needs-approval**。这是一个 agent 在行动之前认清方向的方式，而不是去猜 capability id——包括任何在 plugin
  被编译*之后*才暴露的 capability（Floor 是鲜活的；投影只是缓存它）。
- **`plexus-<agentId> <capabilityId> [args]`**——invoke 一项 capability（例如
  `plexus-<agentId> obsidian.vault.read Welcome.md`）。

三层渐进式披露贯穿它：一句话说明始终在上下文里 → skill 正文（指引，包括 agent 原生的密钥管理建议）→ 内部永不
进入 agent 上下文的 launcher。

---

## 这条命令是你唯一的接口

::: danger 编译好的 skill 直白陈述的一条硬规则
把**每一次**交互都经由 `plexus-<agentId> …` 来驱动。**绝不**对着网关自己拼 HTTP，**绝不**去猜一个认证头，
**绝不**试图铸造或读取一个 token。这条命令已经封装了那套经认可的认证流程；别的做法既不必要，又是网关会拒绝的
一种越权。
:::

这直接回答了一个冷启动 agent 会陷入的失败模式：面对一条含糊的错误，它去伪造自己的凭据或读一把磁盘上的密钥。
有了 launcher，恰好只有一条被公示的前进路径——那条经审计、经拥有者批准的路径。

两条保证让信任这条命令是安全的：

- **认证/invoke 内核是模板化的，绝非 LLM 撰写。** 它是从一个**确定性的、按 agent 类型的模板**渲染出来的，由
  Floor 的 `requestShapes` / `io` 填充——绝非即兴。（一个 LLM 写认证路径可能会交付一份越权教程；所以一个 LLM
  只可以写教学性的外壳——任务框定、示例——绝不写机制本身。）
- **绝无任何持久密钥被烧进产物。** 一个构建期校验器（`integration/verify-plugin.ts`）沿四个轴把一个渲染出来的
  plugin 对着 Floor 校验：那个经认可的认证内核逐字节一致、没有任何密钥被烧进去、只引用了被公示/已授予的
  capability、且用的是那套经认可的 enroll/handshake/invoke 流程。只有那个短寿命、单次使用的 enroll 码随安装而行。

---

## 它如何契合凭据边界

launcher 存在，**正因为** `connection-key` 是**仅限管理员**的，而每个 agent 用它**自己的**专属 PAT 做认证。
skill 生成是一个**管理时、管理主机**的行为（在配置/管理阶段完成，与调用路径解耦——Connect 流程里没有实时驱动
CLI，调用路径上也没有运行时延迟）。一件泄漏产物的爆炸半径被界定在单个 agent 预先授予的那些 cap，且可独立撤销
——见[信任模型](/zh/concepts/trust-model)和[安全模型](/zh/architecture/security-model)。

agent 被授予的世界所构建于其上的扩展是**跨重启持久的**：一个被添加的 source/capability 被写入
`~/.plexus/extensions.json` 并在启动时重放，因此它熬得过网关重启，而不是随进程内存一起蒸发。

---

## 接下来去哪

- **[读一遍就通](/zh/concepts/)**——完整的心智模型，包括本页所构建于其上的那个两层自描述协议。
- **[信任模型](/zh/concepts/trust-model)**——默认拒绝、两个时钟、以及为什么 execute 永远不能常驻。
- **[连接一个 agent](/zh/guide/connect-an-agent)**——看 launcher 端到端驱动一个真实的 Claude Code / Codex agent。
