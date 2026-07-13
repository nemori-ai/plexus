---
title: 看信任闭环
description: 唯一不变的那件事——一次调用如何被发现、授予、执行、撤销。跟着内置 demo 走完一遍，你就懂了 Plexus，哪怕从没开过终端。
---

# 看信任闭环

网关跑在哪，是管线问题。**这一页**才是 Plexus 本身：一次读顺畅放行，一次受保护的读停下来等你，你批准它就通过——你拒绝它就关死——每一步都记在账上。文档里其余的一切，都是这个闭环的变奏。

不用先跑起来才能看懂。下面的截图和终端输出，来自一台真实网关把内置 demo 端到端走完的现场。

## 1. 你要建立的心智模型

Plexus 交给 agent 的是**门票**，从来没有钥匙。connection-key 是你的**工牌**——它开管理控制台，永远不离你身。连接一个 agent 时，它 enroll 得到自己的**按 agent 独立的 PAT**：一张只证明"它是谁"的门票，别的什么都不给。每个 capability 都**默认拒绝**——门票只让 agent 敲门，进不了门。你自己加的 source 上的低风险读可以预先授予，一路放行；**写、execute、以及任何你标了保护的东西**，在门口停下，等你。这一停，就是整个产品。

## 2. 暴露 demo——一个文件夹开放，一个受保护

内置引导会创建 `~/PlexusDemo`，两个文件夹，一屏讲完整个模型。**Plexus intro**（`demo-intro`）以**开放读**暴露——`auto` 姿态，留给你自己加的 source 上的低风险读。**Your secret**（`your-secret`）是**受保护的**（`approval: "ask"`）——每次首用，哪怕只是读，都为你挂起。

![Plexus 引导第 3 步"暴露 demo"：What-I-expose 面板显示 demo 暴露在 ~/PlexusDemo，注明 capability 在授予之前默认拒绝；下方两张 source 卡片——"Plexus intro / demo-intro" 标着 WORKSPACE-DIR 与 OPEN READ，"Your secret / your-secret" 标着 WORKSPACE-DIR 与 PROTECTED，说明写着：每次首用，哪怕是读，都会为你挂起。](/screenshots/guide/01-onboard-expose-demo.png)

两个文件夹，两种姿态。开放读与受保护之间这条线，接下来的闭环会把它变成实感。

## 3. 连上你的 agent——看它能做什么、不能做什么

agent enroll 之后，用 `list` 发现自己的调用面。它不用猜：网关明确告诉它，哪些现在就能调，哪些会挂起。

```text
$ plexus-demo-cc list

CALLABLE NOW — standing grant, the call just works (1):
  ● demo-intro.read — Read workspace file (read)  [managed, low]

NEEDS APPROVAL — not standing / elevated; the owner approves on first call (2):
  ○ your-secret.read — Read workspace file (read)  [managed, low]
  ...
```

同一个动词——`read`——出现在两边。分界线与*动作*无关，划在你暴露 source 时选的**姿态**上。`demo-intro.read` 常驻；`your-secret.read` 要等你。

## 4. 第一幕——读 intro，放行

开放读的 capability 有常驻 grant，调用直接成功——没有提示，没有停顿。

```text
$ plexus-demo-cc demo-intro.read welcome.md
# Welcome to Plexus
You are reading this through Plexus — which means the loop already works.
...
```

agent 读到了你机器上的一个文件，你没有被打断——因为*你*事先决定了这个 source 可以常驻。`auto` 姿态的意义就在这：它的安静，是你亲手批出来的。

## 5. 第二幕——读 secret

同一个 `read`，这次对准**受保护的**文件夹。Plexus 在这里停下。

### 先挂起——没有你，什么都不会发生

这次调用没有失败，也没有放行。它在**等**，批准卡片出现在你的控制台。卡片为人类决策而设计：**谁**在请求，**具体要什么**（`your-secret.read [read]`，标注 managed / low），**给多久**——trust-window 由你选；agent 请求的时长只是建议。

![受保护读触发的 Plexus 批准卡片。标题 "Grant request"，标签 GRANT / DEMO-CC / PLEXUS-CLI / MANAGED / LOW，挂起 id pend_8d819e81-…。Plexus 的说明：批准后 demo-cc 可以 READ 工作区文件（managed、低敏感度），最长 7 天，随时可在 Plexus → Grants 撤销。Scope 一栏是 your-secret.read [read]。警告提示 source "your-secret" 受保护（approval:"ask"），对 your-secret.read 的读授权等待 owner 决定。右侧：授予给 agent "demo-cc"，trust-window "7 days"，以及 Approve / Deny 两个按钮。](/screenshots/guide/04-approval-card.png)

批准人就是你，人就在现场。接下来有两条路。

### 允许 → 这次读完成

选一个 trust-window 批准，一直阻塞着的 launcher 解锁，调用通过。agent 拿到它要的文件：

```text
$ plexus-demo-cc your-secret.read secret.md
plexus: 'your-secret.read' is awaiting the owner's approval — waiting (up to 15 min). Approve it in the Plexus console: http://127.0.0.1:7077/admin. (--no-wait or PLEXUS_APPROVAL_WAIT_MS to tune.)
# (owner approves in console)
plexus: approved — invoking 'your-secret.read'.
# The protected note
demo-secret: tangerine-42 🍊
```

在你的 trust-window 之内，同一个读从此常驻——直到你撤销。

### 拒绝 → 调用关死

也可以不批。拒绝，agent 的这次调用就此结束——没有数据，没有重试循环，一个干净的非零退出码，agent 能检测、能推理。

```text
$ plexus-demo-cc your-secret.read secret.md
plexus: 'your-secret.read' is awaiting the owner's approval — waiting (up to 15 min). Approve it in the Plexus console: http://127.0.0.1:7077/admin. (--no-wait or PLEXUS_APPROVAL_WAIT_MS to tune.)
# (owner denies in console)
plexus: the owner DENIED 'your-secret.read'.
$ echo $?
77
```

退出码 `77`。对 agent 来说，"不行"是一个可以推理的事实，用不着当报错去绕。**两种结局都是课**：这道门在两个方向上都是真的。

## 6. 全程留痕——每一步都在账上

这一切没有账外操作。**Activity** 日志只增不减、已脱敏：每一次 handshake、grant、token、invoke、撤销，谁做了什么，全在上面。从头读到尾，整个故事一目了然——那次拒绝、那次挂起、更早的先允许后撤销、以及带 token id 的成功调用。

![Plexus 的 Activity 审计视图——只增不减、已脱敏的日志。自上而下：demo-cc 在 your-secret.read 上的 grant.deny，your-secret.read 的 grant.pending，handshake，your-secret.read 的 grant.revoke，一次带 token id 的 invoke your-secret.read OK，token.issue，your-secret.read 的 grant.allow，更早的 grant.pending 与 handshake，以及 invoke demo-intro.read OK 连同 grant.allow 与 token.issue。副标题写着：每一次 handshake、grant、token、invoke 与撤销——谁做了什么，一清二楚。](/screenshots/guide/07-activity-audit.png)

"全程审计"落到实处，就是这本账。agent 经由 Plexus 做的每一件事，你都看得见。

## 7. 撤销——一个开关，全部 fail closed

grant 没有永久这一说。在 **Grants** 里撤销一条，agent 的下一次调用立刻 fail closed——不用重新部署，不用轮换密钥，不用追查散落各处的 secret 副本，因为副本从来就没存在过。门票撕掉，门就关上。授予轻松、撤销轻松、泄露无从谈起——这种不对称，就是闭环值得那一停的理由。

---

这就是完整的 Plexus。一次读放行，因为你允许过；一次读停住，因为你没允许；一个你带着完整上下文做出的决定；一本什么都不忘的账。网关跑在哪，改变的只有线的长度。

- **[安全模型 →](/zh/architecture/security-model)**——权威的信任边界：connection-key 与按 agent 独立的 PAT、execute 默认逐次批准的规则（仅 owner 按 agent + capability 显式开启才可常驻）、发布到底暴露了什么。
- **[核心概念 →](/zh/concepts/)**——底下的心智模型（Connector → Source → Capability、来源、两个时钟、自描述的 Floor）。
- **[连接一个 agent →](/zh/guide/connect-an-agent)**——第一个 agent 的完整流程，还带一个真实的 `codex` agent。
