---
title: 编译模型
description: Floor 提供自描述信息，为每个 agent 编译的插件则是它的投影视图。本页还介绍每个 agent 专用的 plexus 启动器，以及为什么命令是 agent 的唯一接口。
---

# 编译模型

Plexus 不只让 agent 能访问工具。它还会把“*你*具体该怎样调用*这些*能力”编译成该 agent 原生支持的形式，安装好后交给它。本页专门说明这一过程。要了解完整的概念框架，请先阅读 [核心概念](/zh/concepts/)。

::: tip 它为什么存在
即使资源能完整说明自身，初次接触的 agent 仍要**当场学会一套新协议**。接入者熟悉 MCP 和 REST，却很少见到定义清楚、还能说明自身用法的资源。单靠改进规范解决不了这个问题。办法是**把资源编译成 agent 原生支持的形式，安装好后交给它**。这样，agent 直接拿到的就是原生命令，无须再*摸索* Plexus 的用法。
:::

---

## Floor：始终存在的事实来源 {#floor——那个始终在场的事实源}

**Floor** 是始终存在、能说明自身信息和用法的资源层：

- `GET /.well-known/plexus`——网关身份 + `requestShapes` + auth / enrollment 公示，外加一条指引：
  enroll + handshake 之后即获得 Plexus 授权给你的 capability 列表，
- 握手后收到的 **manifest**：列出所有者授权该 agent 使用的能力，每个条目都通过 `io` 提供输入和输出的 JSON-Schema，
- 附着的 `how-to-use` **skill**（markdown 指引），

……全部走纯 HTTP（或 MCP）。**任何 agent 不装任何产物都能用它**——enroll、handshake、grant、invoke
全都能从这里发现。agent 需要的东西没有一样藏在定制工具后面。这就是事实源；其余一切都是叠在它之上的视图。

Floor 连自己的引导都自描述：`.well-known/plexus` 公示 `auth.enrollment` 块（兑换 URL/方法、`body.code`、
`success.pat`、`patStorage` 指令、`errorCodes`），所以**没有 skill 的** agent 也能仅凭 Floor 自行 enroll，
直接从 `.well-known` 构造 enroll 与 handshake 调用——capability 调用则由握手交付的 manifest 而来。

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
  一项拥有者新授权给这个 agent 的 → `list` 反正会把它列出来。所以自动更新是*新鲜度/UX* 特性，不是*安全*特性。

---

## `plexus-<agentId>` launcher

编译好的 plugin 随附一个**版本隔离的专属 launcher**，收起整条 `enroll → PAT → handshake → token → invoke`
链——agent 只看到一条原生命令，看不到管道。它叫 **`plexus-<agentId>`**（自带捆绑引擎 + 写死的
`PLEXUS_AGENT_ID`），**绝不是**不带 agent 标识的全局 `plexus`，所以同一台主机上的两个 agent 永不冲突，
各自锁定自己的引擎版本。

它的子命令就是 agent 的全部词汇：

- **`plexus-<agentId> enroll <code>`**——兑换一次性码 → PAT → 自行保存（仅首次运行）。
- **`plexus-<agentId> list`** — 用来**查看有哪些能力**：列出这个 agent 的能力，分为 **callable-now**
  （已有持续授权）和 **needs-approval**（需要审批）；**skills** 单独列出，只作为使用指导读入上下文，不通过运行时调用。agent 行动前先查列表，不必猜能力 ID。所有者在插件*编译之后*为这个 agent 授权的能力也能查到：Floor 是实时的，投影只是缓存。
- **`plexus-<agentId> <capabilityId> [args]`**——invoke 一项 capability（例如
  `plexus-<agentId> obsidian.vault.read Welcome.md`）。需要审批的调用会**等待**：启动器通过给出的状态端点阻塞等待，所有者一批准就立即调用。agent 只发起一次调用，随后等待，不要循环重试（`--no-wait` 可跳过等待）。`plexus-<agentId> <skillId>` 会打印 skill 的指导正文。

信息分三层逐步展开：先是始终留在上下文中的一句话，再是 skill 正文，提供使用指导，包括 agent 原生的密钥管理建议；最后是启动器，它的内部实现从不进入 agent 的上下文。

---

## 这条命令是你唯一的接口

::: danger 编译好的 skill 直白陈述的一条硬规则
**每一次**交互都必须通过 `plexus-<agentId> …` 进行。使用编译后的 skill 时，agent **绝不能**自行编写 HTTP 请求访问网关，**绝不能**猜测认证请求头，**绝不能**尝试生成或读取令牌。命令已经封装了规定的认证流程；其他做法既无必要，也超出了权限，网关会拒绝。
:::

这条规则直接针对 agent 初次上手时容易犯的错误：遇到含糊的报错，就试着伪造凭据，或读取磁盘上的密钥。启动器明确提供的调用方式只有一种：使用经过审计、由所有者批准的命令。

两条保证让这条命令值得信任：

- **认证/invoke 内核是模板化的，不是 LLM 写的。** 它从一个**确定性的、按 agent 类型区分的模板**渲染
  而来，由 Floor 的 `requestShapes` / `io` 填充——绝非即兴发挥。（让 LLM 写认证路径，可能写出一份越权
  教程；所以 LLM 只写教学性外壳——任务说明、示例——绝不写机制本身。）
- **产物中绝不嵌入长期有效的秘密凭据。** 构建时，验证器（`integration/verify-plugin.ts`）会对照 Floor 检查渲染后的插件，核验以下五项：
  认证核心与规定版本逐字节一致，没有嵌入秘密，只引用已声明且已授权的能力，采用规定的 enroll/handshake/invoke 流程，手写的 skill 正文通过哈希固定。教学说明部分只要有任何改动，就必须重新审查并重新固定哈希，才能发布。安装时只附带短期有效、仅能使用一次的注册码。

---

## 它如何契合凭据边界

启动器之所以存在，**是因为** `connection-key` **只能由管理员访问**，而每个 agent 都用**自己的**专属 PAT 认证。skill **由管理员在配置／管理阶段、在管理员主机上生成**，与调用流程分开：Connect 流程中不会实时驱动 CLI，invoke 时也不会增加运行时延迟。即使产物泄露，影响范围也只限于一个 agent 预先获授的能力，相关授权可以独立撤销。参见 [信任模型](/zh/concepts/trust-model) 和 [安全模型](/zh/architecture/security-model)。

新增的 source 或 capability 会保存到 `~/.plexus/extensions.json`，并在启动时重放，因此扩展**在网关重启后仍会保留**，不会随进程内存一起丢失。

---

## 接下来去哪

- **[读一遍就通](/zh/concepts/)**——完整的心智模型，包括本页所依据的两层自描述协议。
- **[信任模型](/zh/concepts/trust-model)**——默认拒绝、三个时钟，以及 execute 为什么默认逐次批准。
- **[连接一个 agent](/zh/guide/connect-an-agent)**——看 launcher 端到端驱动一个真实的 Claude Code / Codex agent。
