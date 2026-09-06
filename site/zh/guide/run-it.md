---
title: "了解信任闭环"
description: "跟着内置 demo，从发现 capability、取得授权到执行调用，再撤销授权，走完 Plexus 的信任闭环。按步骤观察每一步的结果，了解一次调用如何获得许可，又如何被阻止。"
---
# 看信任闭环 {#看信任闭环}

网关跑在哪，是连接管线的问题。这一页看 Plexus 实际做什么：一次读直接放行，一次受保护的读停下来等你批准；你批准，请求通过，你拒绝，请求结束。每一步都记在账上。文档里其余的内容，都围绕这个由你决定的闭环展开。

不用先跑起来才能看懂。下面的截图和终端输出，来自一台真实网关把内置 demo 端到端走完的现场。

## 1. 先分清身份和许可 {#_1-你要建立的心智模型}

`connection-key` 是你的管理凭据，用来打开管理控制台，不交给 agent。连接 agent 时，它用一次性 enrollment code 换取自己独立的 PAT，证明“我是谁”。用 PAT 完成 handshake，得到的是 session 和你为它选定的 manifest，不是调用许可。发现有哪些 capability、取得限定范围的 grant/token、实际调用，是分开的步骤。

每个 capability 都默认拒绝；有身份，不等于有权执行。你自己添加的 source 上的低风险读可以预先授予，连接时选中的读会获得 standing grant。已有符合条件的 standing grant，就不用反复问你。写和 execute 默认按次审批；写请求经你批准并给出实际的信任窗口，或由你显式授予，也可以变成 standing。execute 则必须由你针对特定 agent 和 capability 显式选择 standing，agent 自己申请不能越过这条限制。受保护的读没有可用授权时，同样停下来等你。

## 2. 暴露 demo：一个文件夹开放，一个受保护 {#_2-暴露-demo——一个文件夹开放-一个受保护}

内置引导会在 `~/PlexusDemo` 下创建两个文件夹，用一屏展示这两种处理方式。Plexus intro（`demo-intro`）采用开放读的 `auto` 姿态，用来演示你自行添加的 source 上可预先授予的低风险读。Your secret（`your-secret`）采用受保护的 `approval: "ask"` 姿态：没有符合条件的 grant 时，哪怕只是读，也会挂起等你批准；已有可用的 standing grant，则不必再次审批。

![Plexus 引导第 3 步“暴露 demo”：What-I-expose 面板显示 demo 位于 ~/PlexusDemo，并提示 capability 在授予之前默认拒绝。下方的“Plexus intro / demo-intro”卡片标有 WORKSPACE-DIR 和 OPEN READ；“Your secret / your-secret”卡片标有 WORKSPACE-DIR 和 PROTECTED，说明首次使用即使是读也会挂起等待批准；这里指没有符合条件的已有授权时。](/screenshots/guide/01-onboard-expose-demo.png)

两个文件夹，两种姿态，现在已准备好供 agent 发现。开放读与受保护之间这条线，接下来的闭环会把它变成实感。


## 3. 连上 agent，看看哪些调用已获准 {#_3-连上你的-agent——看它能做什么、不能做什么}

agent 完成 enroll 之后，用 `list` 查看自己的调用面。它不用逐个试，也不用猜：网关会明确告诉它，哪些现在就能调，哪些调用会挂起等待批准。

```text
$ plexus-demo-cc list

CALLABLE NOW — standing grant, the call just works (1):
  ● demo-intro.read — Read workspace file (read)  [managed, low]

NEEDS APPROVAL — not standing / elevated; the owner approves on first call (2):
  ○ your-secret.read — Read workspace file (read)  [managed, low]
  ...
```

先看两组标签。`CALLABLE NOW` 下的 `demo-intro.read` 已有可用的 standing grant，可以直接调用。`NEEDS APPROVAL` 下的 `your-secret.read` 当前没有这样的许可，第一次调用会停下来等你。出现在列表里，只说明它属于这个 agent 能发现的调用面；发现本身不会授予访问权。

两边写的都是 `read`，也都标着 `managed, low`，结果却不同。在这两个 demo source 上，差别来自你暴露它们时选择的姿态：`demo-intro` 开放读，已有常驻授权；`your-secret` 受保护，眼下需要你批准。这里不能仅凭动词判断能否放行，也不能由这个例子推成“姿态决定所有授权结果”。列表展示的是这个 agent 此刻面对这两个 source 的状态。

## 4. 第一幕：读 intro，直接放行 {#_4-第一幕——读-intro-放行}

先调用已经获准的那一个，读取 `welcome.md`。这里的开放读 capability 有可用的常驻 grant，调用直接成功，没有审批提示，也没有等待你操作的停顿。

```text
$ plexus-demo-cc demo-intro.read welcome.md
# Welcome to Plexus
You are reading this through Plexus — which means the loop already works.
...
```

这次返回的已经不是 capability 名称或授权状态，而是文件内容。agent 通过 Plexus 读到了你机器上的 `welcome.md`，从发现到实际调用，这一步走通了。

你没有被打断，因为你先前已经允许这个 source 的读保持常驻；这次调用用的是已有授权，不需要你再批准一次。在这个 demo 里，`auto` 姿态的安静就体现在这里：文件读完了，你不必做额外操作。


## 5. 第二幕：读 secret，等你决定 {#_5-第二幕——读-secret}

同一个 `read`，这次对准受保护的文件夹。`your-secret.read` 当前没有可用授权，Plexus 在这里停下，不先把文件交给 agent。

### 先挂起：调用等你批准 {#先挂起——没有你-什么都不会发生}

这次调用没有失败，也没有放行。它挂起等待，你的控制台里出现一张批准卡片。先看谁在请求，再看它具体要什么：请求者是 `demo-cc`，范围是 `your-secret.read [read]`，标注为 managed / low。低风险标签不替你作决定，这个 source 仍然受保护。

卡片还让你选择给多久。生效的 trust-window 由你这个 owner 决定，agent 请求的时长只是建议。截图中选的是七天，不是 agent 自己取得了七天权限。

![受保护的读触发 Plexus 批准卡片。标题为“Grant request”，标签为 GRANT / DEMO-CC / PLEXUS-CLI / MANAGED / LOW，挂起标识为 pend_8d819e81-…。说明写明：批准后 demo-cc 可以 READ 工作区文件，标注 managed、低敏感度，最长 7 天，随时可在 Plexus → Grants 撤销该 grant。Scope 为 your-secret.read [read]。警告指出 source “your-secret” 受保护（approval:"ask"），your-secret.read 的读授权正在等待 owner 决定。右侧显示授予对象 agent “demo-cc”，Trust window 已选“7 days”，下方是 Approve / Deny 两个按钮。](/screenshots/guide/04-approval-card.png)

下面演示同一挂起请求的两种选择，不是先批准成功、紧接着又弹出一次审批。

### 允许：这次读完成 {#允许-→-这次读完成}

你选定 trust-window 并批准后，一直阻塞的 launcher 继续执行，调用通过，agent 拿到文件：

```text
$ plexus-demo-cc your-secret.read secret.md
plexus: 'your-secret.read' is awaiting the owner's approval — waiting (up to 15 min). Approve it in the Plexus console: http://127.0.0.1:7077/admin. (--no-wait or PLEXUS_APPROVAL_WAIT_MS to tune.)
# (owner approves in console)
plexus: approved — invoking 'your-secret.read'.
# The protected note
demo-secret: tangerine-42 🍊
```

输出里的十五分钟，是 launcher 等待审批的上限，可以用 `--no-wait` 或 `PLEXUS_APPROVAL_WAIT_MS` 调整。它不是 token 的寿命，不是 session 的寿命，也不是你授予的时长。

如果你授予的是有实际时间窗口、符合复用条件的 standing grant，后续同一个读就能复用授权，不必再次问你；到期或你撤销该 grant，复用便结束。若选的是 `once`，则只供这一次使用，不能复用，也不能刷新。刷新还要求 session 存活，并有窗口内符合条件的 standing grant。

### 拒绝：这次调用结束 {#拒绝-→-调用关死}

另一条路是不批。如果你对同一挂起请求选择 Deny，agent 的这次调用就此结束：没有文件数据，没有重试循环，而是返回一个干净的非零退出码，agent 能检测、能据此推理。

```text
$ plexus-demo-cc your-secret.read secret.md
plexus: 'your-secret.read' is awaiting the owner's approval — waiting (up to 15 min). Approve it in the Plexus console: http://127.0.0.1:7077/admin. (--no-wait or PLEXUS_APPROVAL_WAIT_MS to tune.)
# (owner denies in console)
plexus: the owner DENIED 'your-secret.read'.
$ echo $?
77
```

退出码 `77`。这让“不行”成为 agent 可以识别的事实，不必把它当作临时故障去绕。这里最要紧的是决定有可见的后果：批准，文件内容返回；拒绝，没有数据，调用以 `77` 结束。两种选择都实际约束了调用，接下来可以到记录里核对。


## 6. 留痕：到记录里核对 {#_6-全程留痕——每一步都在账上}

你可以在 **Activity** 里核对这些结果。日志只增不减，内容已脱敏，每一次 handshake、grant、token、invoke 和撤销都留下记录，能看到谁做了什么。

![Plexus 的 Activity 审计视图：日志只增不减，内容已脱敏。自上而下依次是：demo-cc 在 your-secret.read 上的 grant.deny，your-secret.read 的 grant.pending，handshake，your-secret.read 的 grant.revoke，一次带 token id 的 invoke your-secret.read OK，token.issue，your-secret.read 的 grant.allow，更早的 grant.pending 与 handshake，以及 invoke demo-intro.read OK 连同 grant.allow 与 token.issue。副标题说明：每一次 handshake、grant、token、invoke 与撤销，谁做了什么，都清楚可查。](/screenshots/guide/07-activity-audit.png)

截图里，拒绝之前的挂起还在，更早的批准也没有因为后来撤销而从账上消失。`your-secret.read` 的成功调用标着 `OK`，带有 token id，旁边还能找到 `token.issue` 和 `grant.allow`；再往下，是 `demo-intro.read` 成功调用及其授权、token 发放的记录。

这本账保留了决定怎样变化，也保留了实际执行的结果。你看到的不只是“现在允许还是拒绝”，还可以回头查：先前允许过什么，调用是否成功，后来又撤销了什么。agent 经由 Plexus 做的事，都在记录里。

## 7. 撤销：收回这条授权 {#_7-撤销——一个开关-全部-fail-closed}

grant 可以有期限，也可以一直有效，直到你撤销。已经批准，不意味着以后不能改主意。

**在 Grants 里撤销这里的 `your-secret.read` grant，下一次及后续依赖这条 grant 的访问就会 fail closed，不用重新部署，也不用轮换密钥。**

收回的是这条授权。它不等于撤销 agent 或 scope，不会让其他有效 grant 一并失效，也不会撤掉 agent 用来证明身份的 PAT。身份仍在，并不能让已被撤销的授权继续放行。

你也不用去 agent 那里追查用于访问 source 的 secret 副本，因为这条 grant 授予的是经由网关调用的权限，并没有把 source 的访问凭据交给它。agent 持有自己的 PAT 和限定范围的 token，网关仍会检查调用所依赖的 grant。撤销在网关里就能完成，收回的是此后的访问权；前面已经获准返回的文件内容，不在撤销范围内。

---

哪些读可以通过，哪些请求要停住，已经给出的许可何时收回，由你决定。Plexus 执行这些决定，并留下可核对的记录。网关跑在哪，不改变这件事。

- [安全模型 →](/zh/architecture/security-model)：查看具体的信任边界，分清 `connection-key` 与每个 agent 独立的 PAT，了解 execute 默认逐次批准的规则，以及发布到底暴露了什么。execute 只有在 owner 针对特定 agent 和 capability 显式开启后，才可获得常驻授权。
- [核心概念 →](/zh/concepts/)：理解 Connector → Source → Capability 的关系、来源、三个时钟，以及能描述自身用法的 Floor。
- [连接一个 agent →](/zh/guide/connect-an-agent)：照着完整流程连接第一个 agent，其中也有真实的 `codex` agent 示例。
