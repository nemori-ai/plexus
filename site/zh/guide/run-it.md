---
title: 看信任闭环
description: 唯一不变的那件事——一次调用如何被发现、授予、执行、撤销。跟着内置 demo 走完一遍，你就懂了 Plexus，哪怕从没开过终端。
---

# 看信任闭环

网关在哪里运行，是部署上的事。**这里演示的信任循环**才是 Plexus 的核心：读取直接通过，受保护的读取停下来等你；你批准就放行，拒绝就终止，每一步都有记录。文档其余内容都是这个循环的不同形式。

不用先跑起来才能看懂。下面的截图和终端输出，来自一台真实网关把内置 demo 端到端走完的现场。

## 1. 你要建立的心智模型

Plexus 给代理的是**票据**，绝不会给它钥匙。connection-key 是你的**徽章**，用来打开管理控制台，始终由你保管。连接代理时，代理会注册并领取自己的 **per-agent PAT**：这张票据只表明它是谁。所有能力都**默认拒绝（default-deny）**：票据让代理发起请求，不代表它能直接访问。对于你自己添加的数据源，可以预先授权低风险读取，让请求直接通过；**写入、执行，或任何被你标为受保护的操作**都会停下来等你批准。这一步等待，就是产品的核心。

## 2. 暴露 demo——一个文件夹开放，一个受保护

内置引导会创建 `~/PlexusDemo`，用其中的两个文件夹，在一屏内讲清整个模型。**Plexus intro**（`demo-intro`）以 **open-read** 方式开放，对应 `auto` 模式，适用于对你自己添加的来源进行低风险读取。**Your secret**（`your-secret`）则是 **protected**（`approval: "ask"`）：首次使用时，即使只是读取，也一律要等你批准。

![Plexus 引导第 3 步"暴露 demo"：What-I-expose 面板显示 demo 暴露在 ~/PlexusDemo，注明 capability 在授予之前默认拒绝；下方两张 source 卡片——"Plexus intro / demo-intro" 标着 WORKSPACE-DIR 与 OPEN READ，"Your secret / your-secret" 标着 WORKSPACE-DIR 与 PROTECTED，说明写着：每次首用，哪怕是读，都会为你挂起。](/screenshots/guide/01-onboard-expose-demo.png)

两个文件夹，一个开放读取，一个受保护。接下来的演示会让你看到两者的实际区别。

## 3. 连上你的 agent——看它能做什么、不能做什么

代理注册后，用 `list` 查看它的能力清单。哪些现在就能调用，哪些需要等待批准，网关都会明确列出，不用猜。

```text
$ plexus-demo-cc list

CALLABLE NOW — standing grant, the call just works (1):
  ● demo-intro.read — Read workspace file (read)  [managed, low]

NEEDS APPROVAL — not standing / elevated; the owner approves on first call (2):
  ○ your-secret.read — Read workspace file (read)  [managed, low]
  ...
```

两者执行的都是 `read`。区别不在*操作本身*，而在你开放的**数据源采用什么访问策略**。`demo-intro.read` 已有持续授权，`your-secret.read` 则需要你批准。

## 4. 第一幕——读 intro，放行

开放读的 capability 有常驻 grant，调用直接成功——没有提示，没有停顿。

```text
$ plexus-demo-cc demo-intro.read welcome.md
# Welcome to Plexus
You are reading this through Plexus — which means the loop already works.
...
```

代理读了你机器上的文件，没有打断你，因为*你*事先判断访问这个数据源是安全的，并给了持续授权。这就是 `auto` 的作用：你已经作过决定，这次读取便无需再问。

## 5. 第二幕——读 secret

同一个 `read`，这次对准**受保护的**文件夹。Plexus 在这里停下。

### 先挂起——没有你，什么都不会发生

这次调用没有失败，也没有放行。它在**等**，批准卡片出现在你的控制台。卡片为人类决策而设计：**谁**在请求，**具体要什么**（`your-secret.read [read]`，标注 managed / low），**给多久**——trust-window 由你选；agent 请求的时长只是建议。

![受保护读触发的 Plexus 批准卡片。标题 "Grant request"，标签 GRANT / DEMO-CC / PLEXUS-CLI / MANAGED / LOW，挂起 id pend_8d819e81-…。Plexus 的说明：批准后 demo-cc 可以 READ 工作区文件（managed、低敏感度），最长 7 天，随时可在 Plexus → Grants 撤销。Scope 一栏是 your-secret.read [read]。警告提示 source "your-secret" 受保护（approval:"ask"），对 your-secret.read 的读授权等待 owner 决定。右侧：授予给 agent "demo-cc"，trust-window "7 days"，以及 Approve / Deny 两个按钮。](/screenshots/guide/04-approval-card.png)

批准人就是你，人就在现场。接下来有两条路。

### 允许 → 这次读完成

你选定信任窗口并批准后，一直阻塞等待的启动器会解除阻塞，继续执行这次调用。agent 会拿到它请求的文件：

```text
$ plexus-demo-cc your-secret.read secret.md
plexus: 'your-secret.read' is awaiting the owner's approval — waiting (up to 15 min). Approve it in the Plexus console: http://127.0.0.1:7077/admin. (--no-wait or PLEXUS_APPROVAL_WAIT_MS to tune.)
# (owner approves in console)
plexus: approved — invoking 'your-secret.read'.
# The protected note
demo-secret: tangerine-42 🍊
```

对同一读取操作的持续授权，在你选定的信任窗口内有效；如果你提前撤销，授权就随之失效。

### 拒绝 → 调用终止 {#拒绝-→-调用关死}

你也可以拒绝。拒绝后，agent 的这次调用会结束：不返回数据，不进入重试循环，并明确返回非零退出码。agent 能检测到这一状态，并据此作出判断。

```text
$ plexus-demo-cc your-secret.read secret.md
plexus: 'your-secret.read' is awaiting the owner's approval — waiting (up to 15 min). Approve it in the Plexus console: http://127.0.0.1:7077/admin. (--no-wait or PLEXUS_APPROVAL_WAIT_MS to tune.)
# (owner denies in console)
plexus: the owner DENIED 'your-secret.read'.
$ echo $?
77
```

退出码是 `77`。智能体得到的是明确的拒绝，而不是一个可以设法应付过去的报错。**放行和拒绝，两种结果都很重要**：这道关卡允许时能放行，拒绝时也确实能拦住调用。

## 6. 全程留痕——每一步都在账上

这一切没有账外操作。**Activity** 日志只增不减、已脱敏：每一次 handshake、grant、token、invoke、撤销，谁做了什么，全在上面。从头读到尾，整个故事一目了然——那次拒绝、那次挂起、更早的先允许后撤销、以及带 token id 的成功调用。

![Plexus 的 Activity 审计视图——只增不减、已脱敏的日志。自上而下：demo-cc 在 your-secret.read 上的 grant.deny，your-secret.read 的 grant.pending，handshake，your-secret.read 的 grant.revoke，一次带 token id 的 invoke your-secret.read OK，token.issue，your-secret.read 的 grant.allow，更早的 grant.pending 与 handshake，以及 invoke demo-intro.read OK 连同 grant.allow 与 token.issue。副标题写着：每一次 handshake、grant、token、invoke 与撤销——谁做了什么，一清二楚。](/screenshots/guide/07-activity-audit.png)

"全程审计"落到实处，就是这本账。agent 经由 Plexus 做的每一件事，你都看得见。

## 7. 撤销一项授权，依赖它的调用就会被拒绝 {#_7-撤销——一个开关-全部-fail-closed}

授权并非给了就收不回。在 **Grants** 中撤销一项授权，智能体下一次依赖这项授权的调用就会被拒绝——不必重新部署，不必轮换密钥，也不必四处追查秘密的副本，因为从来就没有副本可追查。这张授权的票被撕掉，凭它能进的门也就关上了。授权容易，撤销容易，秘密却无从泄露——正是这种不对称，让这套循环值得你为它停一停。

---

这就是 Plexus 的完整流程：你允许的读取会通过，未经你允许的读取会暂停；你在了解完整情况后作出决定，审计记录一笔不漏。换个地方运行网关，变的只是连接它的那根“线”的长短，这套信任流程不变。

- **[安全模型 →](/zh/architecture/security-model)**——权威的信任边界：connection-key 与按 agent 独立的 PAT、execute 默认逐次批准的规则（仅 owner 按 agent + capability 显式开启才可常驻）、发布到底暴露了什么。
- **[核心概念 →](/zh/concepts/)**——底下的心智模型（Connector → Source → Capability、来源、三个时钟、自描述的 Floor）。
- **[连接一个 agent →](/zh/guide/connect-an-agent)**——第一个 agent 的完整流程，还带一个真实的 `codex` agent。
