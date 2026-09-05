---
title: "编译模型"
description: "自描述的 Floor 如何投影为每个 agent 专属的编译 plugin。使用编译集成时，专属的 plexus launcher 是 agent 的唯一接口；plugin 即使缓存了旧指引，调用仍以网关的权限检查为准。"
---
# 编译模型 {#编译模型}

工具接入 Plexus 后，agent 还需要知道这些 capability 该怎样调用。本页讲 Plexus 如何把调用方法随安装交给每个 agent。想先了解完整的心智模型，可以从[核心概念](/zh/concepts/)读起。

::: tip 为什么还需要编译
接口即使把自己描述得很清楚，刚接入的 agent 仍要当场学一套新协议。集成者懂 MCP 和 REST，却很少遇到定义清楚、还会解释自己该怎么用的资源。规格写得更好，也省不掉这一步学习。

Plexus 先提供一层可发现、自描述的资源，叫作 Floor，再把“这个 agent 该怎样调用这些 capability”编译成它习惯的原生用法，装好交付。agent 拿到的是一条原生命令，不必先弄懂 Plexus。
:::

---

## Floor：始终可用的事实源 {#floor——那个始终在场的事实源}

Floor 是始终可用、会描述自身的资源暴露面。公开入口 `GET /.well-known/plexus` 给出网关身份、端点、`requestShapes`，以及 auth 和 enrollment 公示，告诉 agent 怎样 enroll、怎样 handshake。这里不公开凭证，也不提供完整的逐 agent manifest。

agent 用自己的 PAT 完成认证握手，网关据此绑定真实的 agent 身份，返回 session 和 manifest。manifest 只列出拥有者为这个 agent 选中、且仍开放暴露的 capability；每个条目都带有 `io`，用 JSON-Schema 描述输入和输出。收到这份目录，还不等于取得了调用许可：具体调用所需的范围授权是另一步。附着的 `how-to-use` skill 则用 markdown 提供使用指引。

这些内容全部通过纯 HTTP（或 MCP）提供。任何 agent 都可以不安装任何产物，直接使用 Floor；enroll、handshake、grant、invoke 都能从这里发现，所需信息没有藏在定制工具后面。Floor 就是事实源，其余一切都是在它之上形成的视图。

连最初的接入方法也能从这里找到。`.well-known/plexus` 公示的 `auth.enrollment` 块包含兑换 URL 和方法、`body.code`、`success.pat`、`patStorage` 指令，以及 `errorCodes`。没有 skill 的 agent 也能仅凭 Floor 自行 enroll，从 `.well-known` 构造 enroll 与 handshake 调用；等握手返回 manifest，再据此构造 capability 调用。

---

## 编译好的 plugin：Floor 的投影 {#编译好的-plugin——一层投影-绝非替代品}

Plexus 在 Floor 之上为每个 agent 编译一件产物，让同样的 capability 在它手里有原生的用法。v1 的产物是一个 Claude Code plugin。这就是 Floor 的投影：把调用知识缓存下来，提供快捷方式，不能取代 Floor。

![自描述 Floor 与投影在其上的 per-agent 编译插件](/diagrams/floor-projection.png)

授权始终由网关实时强制执行。skill 即使陈旧或生成有误，也永远越不过 Floor 的权限。它还写着一项已撤销的 capability，invoke 就会在网关处直接失败；它漏掉了拥有者新选给这个 agent、且仍开放暴露的 capability，`list` 仍会把它列出来。陈旧影响的是指引是否准确，不会放宽权限。所以自动更新解决的是新鲜度和 UX 问题，不是安全问题。

Floor 对任何 agent、任何 transport 都始终有效。没有 Claude Code / Codex 在场，就不生成产物，直接回落到 Floor。

---

## 每个 agent 的专属命令 `plexus-<agentId>` {#plexus-agentid-launcher}

plugin 随附一个专属 launcher，把 `enroll → PAT → handshake → token → invoke` 整条链收在内部。agent 看到的是一条原生命令，不必处理背后的凭证和调用流程。

这条命令叫 `plexus-<agentId>`，自带捆绑引擎，并写死 `PLEXUS_AGENT_ID`。名字里必须带上 agent 标识，不使用全局的 `plexus`。同一台主机上的两个 agent 因此各有自己的命令，也各自锁定自己的引擎版本，不会相互冲突。

agent 使用以下命令：

- `plexus-<agentId> enroll <code>`：兑换一次性码，取得这个 agent 自己的 PAT，由 launcher 自行保存。仅首次运行时需要。
- `plexus-<agentId> list`：列出这个 agent 的 capability，分为 callable-now 和 needs-approval。callable-now 表示已有当前可用的常驻授权；needs-approval 表示还需要批准。进入拥有者选定的 manifest，只确定了目录范围，不等于已经有常驻授权。skill 单独成组，提供作为上下文阅读的使用指引，不走线上调用。
- `plexus-<agentId> <capabilityId> [args]`：调用一项 capability，例如 `plexus-<agentId> obsidian.vault.read Welcome.md`。如果传入的是 skill，即 `plexus-<agentId> <skillId>`，则打印该 skill 的指引正文。

行动前先运行 `list`，agent 就能知道有什么可用，不必猜 capability id。plugin 编译之后，拥有者新选入且仍开放暴露的 capability 也能从这里发现。Floor 还在变化，编译产物只保存了其中一份缓存。

已有符合条件的常驻授权时，调用不必再请拥有者批准。需要批准时，launcher 会原地等待：阻塞在公示的 status 端点上，拥有者一批准便继续调用。请求只发起一次，等待不会变成反复 invoke 或重试调用；`--no-wait` 可退出等待。

信息按三层渐进式披露：一句话说明始终留在上下文里 → skill 正文提供使用指引，包括 agent 原生的密钥管理建议 → launcher 内部处理具体流程，永不进入 agent 上下文。

---

## 使用编译集成的 agent，只走这条命令 {#这条命令是你唯一的接口}

::: danger 使用编译集成的 agent 必须遵守
每一次与网关交互都走 `plexus-<agentId> …`。绝不自行对网关拼 HTTP，绝不猜认证头，绝不试图铸造或读取 token。launcher 已经封装了经认可的凭证生命周期，使用这份集成的 agent 必须沿这条路径操作。
:::

这条规则有明确的范围。独立 HTTP 客户端仍然可以按 Floor 公示的协议接入，不必安装 plugin；网关是否允许一次请求，取决于它是否满足认证和授权条件，不能只因它没走 launcher 就认定越权。

对使用编译集成的 agent，这项约束堵住的是一种冷启动时的失败模式：遇到含糊的错误，就试着伪造凭据，或者去磁盘上读密钥。launcher 把凭证和调用流程收在内部，公示给 agent 的前进路径只有一条，就是经审计、经拥有者批准的那条。agent 不必从报错里猜认证办法，也不该把报错当作另找凭据的理由。

这条命令本身又凭什么可信？认证和 `invoke` 的内核由模板生成，不是 LLM 写的。模板是确定性的，按 agent 类型区分，再由 Floor 的 `requestShapes` 和 `io` 填充。认证路径若交给 LLM 即兴编写，可能写成一份越权教程。因此，LLM 只负责教学性描述，包括任务说明和示例，不编写认证与调用机制。

产物里绝不写死持久密钥。构建期校验器 `integration/verify-plugin.ts` 会把渲染出的 plugin 与 Floor 对照，检查五件事：认证内核与经认可的版本逐字节一致；没有写死任何密钥；只引用已公示或已授予的 capability；遵循经认可的 enroll/handshake/invoke 流程；手写的 skill 正文与 SHA-256 pin 锚定的内容一致。确定性的内核和不含持久密钥的产物，都要在构建时经过校验。

教学性外壳也在这道检查之内。它的任何改动，都必须专门重新审查，并重新锚定手写的 skill 正文，才能交付。随安装走的只有那个短寿命、一次性的 enroll 码。

---

## 它如何契合凭据边界 {#它如何契合凭据边界}

launcher 之所以存在，是因为 `connection-key` 是拥有者的管理凭据，仅限管理员使用，而每个 agent 都用自己的专属 PAT 认证。

skill 在配置、管理阶段生成，生成工作在管理主机上完成，与调用路径分开。Connect 流程里没有实时驱动 CLI 的步骤。生成不在调用路径上，也就不会给调用增加这部分延迟。

安装产物不含持久密钥。即使产物泄漏，也不会带来超出这个 agent 策略范围的能力；选入目录的 cap，仍须取得有效的调用授权才能使用。拥有者可以独立撤销这个 agent 的某项 grant，也可以撤销该 agent，两者撤销的范围不同。具体见[信任模型](/zh/concepts/trust-model)和[安全模型](/zh/architecture/security-model)。

支撑 agent 获授能力的扩展会跨重启保留：添加的 source/capability 写入 `~/.plexus/extensions.json`，网关启动时重放，不会随进程内存一起消失。session 则保存在内存中，网关重启后需要重新建立。

---

## 接下来去哪 {#接下来去哪}

[读一遍就通](/zh/concepts/)介绍完整的心智模型，包括本页依托的两层自描述协议。

[信任模型](/zh/concepts/trust-model)解释默认拒绝、三个时钟，以及 execute 为什么默认逐次批准。

[连接一个 agent](/zh/guide/connect-an-agent)展示 launcher 怎样端到端驱动一个真实的 Claude Code / Codex agent。
