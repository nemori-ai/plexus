---
title: 快速上手：OpenClaw
description: 五分钟把 OpenClaw 助手接入 Plexus——agent 侧零安装——看它读取你的系统状况、驱动 Codex、再把成果取回来，每一步都经过授权、留有审计、随时可撤销。
---

# 快速上手：接入 OpenClaw

[OpenClaw](https://openclaw.ai) 是一个可自行托管的个人 AI 助手，你可以在平时用的聊天应用里给它发消息。它能运行 shell 命令，也支持 HTTP，因此可以**通过上下文**连接 Plexus：无需安装任何东西，只要在聊天中粘贴一条指令。

本指南配真实截图走完整个闭环，结尾有个小彩蛋：OpenClaw 通过 Plexus 读取你机器的负载，让 **Codex 用它的图像生成工具画一张真正的「系统负载晴雨报」插画**——每一步都经过授权、留有审计、随时可撤销。

**你需要：**

- 一个正在运行的 Plexus 网关（[先跑起来](/zh/guide/)）——可以在本机（`http://127.0.0.1:7077`）运行，也可以通过你自己的域名提供服务。
- 一个配好模型、正在运行的 OpenClaw。
- 想要漫画彩蛋：网关机器上装好 **Codex CLI**，并在控制台开启 Codex 源的 **Real launch**（控制台 → What I expose → Codex）。不开启时 `codex.run` 走记录模式——命令被组装并审计，但不真正执行。

::: tip 为什么选 in-context？
OpenClaw 本身就是一个 agent 运行时——你不会往里面装插件。**In-context / HTTP** 交付形态给它一条自描述指令：用一次性 code 完成 enroll，然后从 `/.well-known/plexus` 自己发现整个协议。agent 永远接触不到你的管理 connection-key。
:::

## 1 · 打开控制台

打开网关的 `/admin`，粘贴你的 **connection key**（运行时启动时打印，也存在 `$PLEXUS_HOME/connection-key`）。这是你的管理凭证——agent 永远拿不到它。

![粘贴 connection key](/guides/openclaw/01-paste-connection-key.png)

## 2 · 连接一个 agent

点击 **Connect an agent**，将它命名为 `openclaw`，再选择允许它使用的能力。本次演示选择五项：

- `sysinfo.resources.read` + `sysinfo.processes.list` —— 读取机器负载
- `codex.run` —— 驱动本机 Codex CLI，沙箱限定在一个目录内
- `workspace.list` + `workspace.read` —— 取回 Codex 产出的文件

你在这里勾选的读能力会成为**常驻（standing）授权**——勾选这个动作本身就是人的批准。`codex.run` 是 **execute** 能力，默认**逐次审批**：每次调用都要等你批准。

![勾选能力集](/guides/openclaw/04-connect-capabilities.png)

in-context agent 有一个特殊点：纯 HTTP 的 agent 没法停在审批循环里等你，所以逐次审批的 execute 会被**直接拒绝并附上说明**（而不是挂起）。想让它无人值守地跑通——就像这个 demo——需要在连接时把 `codex.run` 显式开为 **Standing**。Plexus 会二次确认，因为这是真实的信任让渡：

![Standing execute 是显式的、双重确认的选择](/guides/openclaw/04b-standing-confirm.png)

## 3 · 把指令交给 OpenClaw

选 **In-context / HTTP** 交付形态。你会得到一条可直接粘贴的指令，里面嵌着一次性 enroll code（约 15 分钟过期）：

![in-context 指令 + 一次性 code](/guides/openclaw/05-connect-install-incontext.png)

把它粘贴给 OpenClaw——聊天界面、WhatsApp 或 CLI 都行：

```bash
openclaw agent --agent main --message "<你复制的指令>

连接完成后，这是你的第一个任务：
1. 用授权给你的 sysinfo 能力读取我机器当前的负载。
2. 调用一次 codex.run：让 Codex 用它内建的图像生成工具画一张卡通晴雨报插画——
   轻松是晴、紧张是暴风雨，把真实数字写进画面——存为 load-weather.png。
3. 通过 workspace.list 确认文件已生成，汇报它的大小。"
```

剩下的 OpenClaw 自己完成：拉取 `/.well-known/plexus`、用一次性 code 换取自己的持久凭证（一个 `plx_agent_…` PAT，存在它自己的工作区）、握手，然后**只收到你勾选的那五个能力**——manifest 就是它被授权的世界，能直接调用的条目上盖着 `standing: true`。

![OpenClaw 接入并完成任务](/guides/openclaw/06-openclaw-run.png)

## 4 · 成果

Codex 以无界面模式运行，**只能在工作区目录内写入**，用自己的图像工具生成插图，OpenClaw 通过 `workspace.list` 确认文件已写入：

![Codex 生成的系统负载晴雨报](/guides/openclaw/load-weather.png)

## 5 · 你能看到什么、能撤销什么

agent 做过的每件事都在 **Activity** 里——握手、授权、每一次调用连同参数和结果：

![审计轨迹](/guides/openclaw/07-activity.png)

打开这次 `codex.run` 调用，就能看到 **replay locally** 面板。把面板中的命令粘贴到网关机器上的终端，就能重新打开这次调用对应的那个 Codex 会话。这就证明，远程调用确实驱动了本地工具：

![在本机终端重放这次运行](/guides/openclaw/08-replay-locally.png)

**Agents** 里这个 agent 的卡片展示它的授权子集和常驻授权——随时可以撤销任何一条，或整个 agent：

![agent 的常驻信任，按条可撤销](/guides/openclaw/09-agent-grants.png)

## 下一步

- [连接一个 agent](/zh/guide/connect-an-agent) —— 三种交付形态的完整讲解。
- [安全模型](/zh/architecture/security-model) —— 为什么读能力常驻、写逐次审批、execute 需要你显式开启。
- [看信任闭环](/zh/guide/run-it) —— 同一个闭环，端到端的叙述。
