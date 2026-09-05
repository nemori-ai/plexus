---
title: "快速上手：OpenClaw"
description: "通过 HTTP 把 OpenClaw 助手接入 Plexus，agent 侧无须额外安装。跟着指南读取系统状况、驱动 Codex，再取回成果。各步调用都受授权约束，留有审计记录；所有者可随时撤销授权。"
---
# 快速上手：接入 OpenClaw {#快速上手-接入-openclaw}

[OpenClaw](https://openclaw.ai) 是一个自托管的个人 AI 助手，你可以在常用的聊天软件里给它发消息。它能执行 shell 命令，也能发送 HTTP 请求，因此可以通过 **in-context** 接入 Plexus：agent 侧不用安装东西，把一条指令粘贴进对话即可。

本指南用真实截图走完一次接入和调用：OpenClaw 通过 Plexus 读取机器负载，再让 Codex 用图像生成工具画一张「系统负载晴雨报」插画。各步调用都有授权和审计，授权随时可以撤销。

开始前需要准备：

- 一个运行中的 Plexus 网关（[先跑起来](/zh/guide/)），可以在本地 `http://127.0.0.1:7077`，也可以发布在你自己的域名后面。
- 一个已配置模型、正在运行的 OpenClaw。
- 要生成最后的插画，网关机器上还要安装 **Codex CLI**，并在控制台 → What I expose → Codex 开启 **Real launch**。不开启时，`codex.run` 只走记录模式：命令会被组装并记入审计，但不会真正执行。

::: tip 为什么选 in-context？
OpenClaw 本身就是 agent 运行时，这条接入路径不需要往里面装插件。**In-context / HTTP** 交付给它一条自描述指令：用一次性 code 完成 enroll，再从 `/.well-known/plexus` 发现协议入口和请求形状。这个公开入口不包含凭证或完整能力清单；agent 的能力子集在 handshake 后返回。你的管理 connection-key 不会交给 agent。
:::

## 1 · 打开控制台 {#_1-·-打开控制台}

打开网关的 `/admin`，粘贴你的 **connection key**。运行时启动时会打印它，也会把它保存在 `$PLEXUS_HOME/connection-key`。这是你的管理凭证，agent 永远拿不到它。

![粘贴管理 connection key](/guides/openclaw/01-paste-connection-key.png)

## 2 · 连接一个 agent {#_2-·-连接一个-agent}

点击 **Connect an agent**，命名为 `openclaw`，再选择它的能力子集。本次演示需要五项：

- `sysinfo.resources.read` + `sysinfo.processes.list`：读取机器负载。
- `codex.run`：驱动本机 Codex CLI，沙箱限定在一个目录内。
- `workspace.list` + `workspace.read`：取回 Codex 产出的文件。

选择能力子集，不等于给其中所有能力都授予调用许可。这里勾选的读能力会同时获得**常驻（standing）授权**，勾选本身就是你的批准。`codex.run` 属于 **execute**，默认仍是逐次审批，需要每次调用分别获得批准。

![选择 agent 的能力子集](/guides/openclaw/04-connect-capabilities.png)

但本指南的 in-context 交付流程不会停在审批循环里等你。对于逐次审批的 execute 请求，它会**直接拒绝并附上说明**，而不是挂起等待。这是这条流程的限制，不是说所有 HTTP 客户端都不能等待审批。

如果希望像演示中一样无人值守地完成任务，需要你在连接时将 `codex.run` 显式设为 **Standing**，并通过 Plexus 的二次确认。这个选择意味着：在常驻授权有效期间，它可以执行该能力，不必每次再问你。只有你能作出这个决定，agent 不能自行解除 execute 的限制；开启 Real launch 也不能代替这份授权。

![将 execute 设为 Standing 需要显式选择和二次确认](/guides/openclaw/04b-standing-confirm.png)

确认是否允许常驻执行后，就可以准备交给 OpenClaw 的连接指令。


## 3 · 把指令交给 OpenClaw {#_3-·-把指令交给-openclaw}

选 **In-context / HTTP** 交付形态，控制台会给你一条可以直接粘贴的指令。里面带着一次性 enroll code，约 15 分钟后过期，用它完成接入即可，不需要把管理凭证交出去。

![in-context 指令与一次性 code](/guides/openclaw/05-connect-install-incontext.png)

把指令发给 OpenClaw，聊天界面、WhatsApp 或 CLI 都行。下面的 CLI 示例把连接指令和第一个任务放在同一条消息里：先接入，再读取负载、生成插画，最后检查文件。

```bash
openclaw agent --agent main --message "<你复制的指令>

连接完成后，这是你的第一个任务：
1. 用授权给你的 sysinfo 能力读取我机器当前的负载。
2. 调用一次 codex.run：让 Codex 用它内建的图像生成工具画一张卡通晴雨报插画——
   轻松是晴、紧张是暴风雨，把真实数字写进画面——存为 load-weather.png。
3. 通过 workspace.list 确认文件已生成，汇报它的大小。"
```

接下来的连接步骤由 OpenClaw 自己完成。它拉取 `/.well-known/plexus`，从这个公开入口了解端点、请求形状和 enrollment 流程；这里没有凭证，也不发布完整的 agent manifest。它再用一次性 code 换取自己的持久凭证——一个 `plx_agent_…` PAT，保存在自己的工作区里。

握手时，网关通过 PAT 认证确定它的身份，返回 session 和它的能力子集 manifest。本例中，就是你勾选且仍对外开放的那五个能力，不是网关上的全部能力。

拿到清单还不能直接调用。OpenClaw 仍要另行取得限定 scope 的 grant/token，再带着调用凭证执行任务。清单上的 `standing: true` 表示该能力有常驻授权；已有授权符合条件时，这一步不必再向你请求批准。manifest 负责列出能力，调用凭证则由这一步单独取得。前面为 `codex.run` 作出的 Standing 选择，正是在这里让任务可以继续，而不必等你再次确认。

![OpenClaw 接入并完成任务](/guides/openclaw/06-openclaw-run.png)

## 4 · 成果 {#_4-·-成果}

Codex 在**写入被限定在 workspace 目录内**的沙箱里无头运行，用内建图像工具把真实负载数字画进晴雨报，保存为 `load-weather.png`。

OpenClaw 再通过 `workspace.list` 确认文件已经落盘，并汇报它的大小。下面就是这次生成的插画：

![Codex 生成的系统负载晴雨报](/guides/openclaw/load-weather.png)


## 5 · 你能看到什么、能撤销什么 {#_5-·-你能看到什么、能撤销什么}

agent 做过的每件事都在 **Activity** 里：从握手、取得授权，到每一次调用，连同传入的参数和返回的结果，都有记录。想核对它实际做了什么，可以在这里逐条查看，不必只依赖它在聊天里的汇报。

![审计轨迹](/guides/openclaw/07-activity.png)

点开 `codex.run` 那条调用，会看到 **replay locally** 面板。把其中的命令粘贴到网关机器的终端里，就能重新打开记录中的那次 Codex 会话，查看远程调用驱动本机工具留下的记录。

这里的 replay 是打开那次会话，不是把任务重新执行一遍，也不保证重新生成一张相同的图片。

![在本机终端打开记录中的 Codex 会话](/guides/openclaw/08-replay-locally.png)

**Agents** 中，这个 agent 的卡片显示你为它选择的能力子集，以及它已有的常驻授权。两者要分开看：子集列出你选给它的能力，常驻授权则说明哪些能力已经得到持续有效的批准；它们也都不是 agent 用来证明身份的凭证。

你可以随时撤销某一条授权，收回那份调用许可，而不是撤销整个 agent。若不再允许这个 agent 接入，也可以直接撤销整个 agent。检查记录、决定保留哪一份授权，或把接入资格一并收回，都由你操作。

![agent 的常驻信任，按条可撤销](/guides/openclaw/09-agent-grants.png)

## 下一步 {#下一步}

- [连接一个 agent](/zh/guide/connect-an-agent) —— 完整了解三种交付形态。
- [安全模型](/zh/architecture/security-model) —— 连接时选中的读能力获得常驻授权，写和 execute 默认逐次审批；写也可经批准获得常驻授权，execute 常驻则必须由你显式开启。符合条件的常驻授权不必每次再问。
- [看信任闭环](/zh/guide/run-it) —— 从头到尾看同一个闭环如何运作。
