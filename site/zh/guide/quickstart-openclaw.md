---
title: 快速上手：OpenClaw
description: 五分钟把 OpenClaw 助手接入 Plexus——agent 侧零安装——看它读取你的系统状况、驱动 Codex、再把成果取回来，每一步都经过授权、留有审计、随时可撤销。
---

# 快速上手：接入 OpenClaw

[OpenClaw](https://openclaw.ai) 是一个自托管的个人 AI 助手，你可以从常用的聊天软件里给它发消息。它会执行 shell 命令、会说 HTTP——这意味着它可以用 **in-context** 形态接入 Plexus：什么都不用装，把一条指令粘贴进对话即可。

本指南配真实截图走完整个闭环，结尾有个小彩蛋：OpenClaw 通过 Plexus 读取你机器的负载，让 **Codex 用它的图像生成工具画一张真正的「系统负载晴雨报」插画**——每一步都经过授权、留有审计、随时可撤销。

**你需要：**

- 一个运行中的 Plexus 网关（[先跑起来](/zh/guide/)）——本地（`http://127.0.0.1:7077`）或发布在你自己的域名后面。
- 一个配好模型、正在运行的 OpenClaw。
- 想要漫画彩蛋：网关机器上装好 **Codex CLI**，并在控制台开启 Codex 源的 **Real launch**（控制台 → What I expose → Codex）。不开启时 `codex.run` 走记录模式——命令被组装并审计，但不真正执行。

::: tip 为什么选 in-context？
OpenClaw 本身就是一个 agent 运行时——你不会往里面装插件。**In-context / HTTP** 交付形态给它一条自描述指令：用一次性 code 完成 enroll，然后从 `/.well-known/plexus` 自己发现整个协议。agent 永远接触不到你的管理 connection-key。
:::

## 1 · 打开控制台

打开网关的 `/admin`，粘贴你的 **connection key**（运行时启动时打印，也存在 `$PLEXUS_HOME/connection-key`）。这是你的管理凭证——agent 永远拿不到它。

![粘贴 connection key](/guides/openclaw/01-paste-connection-key.png)

## 2 · 连接一个 agent

点 **Connect an agent**，起个名字（`openclaw`），然后勾选这个 agent 能用的能力。demo 故事需要五个：

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

Codex 在**写入被限定在 workspace 目录内**的沙箱里无头运行，用图像工具生成插画，OpenClaw 再通过 `workspace.list` 确认落盘：

![Codex 生成的系统负载晴雨报](/guides/openclaw/load-weather.png)

## 5 · 你能看到什么、能撤销什么

agent 做过的每件事都在 **Activity** 里——握手、授权、每一次调用连同参数和结果：

![审计轨迹](/guides/openclaw/07-activity.png)

点开 `codex.run` 那条调用，会看到 **replay locally** 面板——把命令粘贴到网关机器的终端里，那次 Codex 会话就会原样重现。这就是「远程调用真的驱动了本机工具」的存证：

![在本机终端重放这次运行](/guides/openclaw/08-replay-locally.png)

**Agents** 里这个 agent 的卡片展示它的授权子集和常驻授权——随时可以撤销任何一条，或整个 agent：

![agent 的常驻信任，按条可撤销](/guides/openclaw/09-agent-grants.png)

## 下一步

- [连接一个 agent](/zh/guide/connect-an-agent) —— 三种交付形态的完整讲解。
- [安全模型](/zh/architecture/security-model) —— 为什么读能力常驻、写逐次审批、execute 需要你显式开启。
- [看信任闭环](/zh/guide/run-it) —— 同一个闭环，端到端的叙述。
