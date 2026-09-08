---
title: 快速上手：Raven
description: Raven 是一个以 TUI 为主的智能体框架。粘贴一条指令，就能通过纯 HTTP 将它连接到 Plexus，无需安装；随后它便能读取系统信息、操作 Codex，并取回结果。
---

# 快速上手：接入 Raven

[Raven](https://github.com/evermind/raven) 是一个以 TUI 为主的智能体框架，类似 OpenClaw，可以在终端里操作，支持 `raven agent`、`raven gateway`、channels 和 cron。和其他能执行命令、通过 HTTP 通信的智能体一样，Raven 可以**在上下文中**连接 Plexus：无需安装，粘贴一条指令即可。

所有智能体的演示都用同一个场景：Raven 通过 Plexus 读取你机器的负载，再让 **Codex 用自己的图像工具生成一幅负载“天气预报”插画**。每一步都经过授权、留下审计记录，授权也都可以撤销。

**你需要：**

- 一个运行中的 Plexus 网关（[先跑起来](/zh/guide/)）。
- 完成 onboard、配好模型的 Raven（`raven onboard`，再用 `raven doctor` 验证）。
- 要生成最后那幅漫画插画，网关所在的机器需安装 **Codex CLI**，并在 Codex 来源中启用 **Real launch**（Console → What I expose → Codex）。

## 1 · 打开控制台

打开网关的 `/admin`，粘贴你的 **connection key**。这是你的管理凭证——agent 永远拿不到它。

![粘贴 connection key](/guides/raven/01-paste-connection-key.png)

## 2 · 连接一个 agent

**Connect an agent** → 命名为 `raven` → 勾选能力集。和 OpenClaw 故事相同的五个：

- `sysinfo.resources.read` + `sysinfo.processes.list`
- `codex.run`
- `workspace.list` + `workspace.read`

![勾选能力集](/guides/raven/04-connect-capabilities.png)

勾选的读能力成为**常驻（standing）授权**。`codex.run` 是 execute——默认逐次审批，而 in-context agent 没法停在审批循环里等你，所以在连接时把它显式开为 **Standing**（会二次确认）：

![Standing execute 是显式的、双重确认的选择](/guides/raven/04b-standing-confirm.png)

## 3 · 把指令交给 Raven

选择 **In-context / HTTP**，复制其中的指令。指令里已包含一个用于注册、只能使用一次的代码：

![in-context 指令 + 一次性 code](/guides/raven/05-connect-install-incontext.png)

粘贴进 Raven 的对话——TUI 或单次 CLI 都行：

```bash
raven agent -m "<你复制的指令>

连接完成后，这是你的第一个任务：
1. 用授权给你的 sysinfo 能力读取我机器当前的负载。
2. 调用一次 codex.run：让 Codex 用它内建的图像生成工具画一张卡通晴雨报插画，
   把真实数字写进画面，存为 load-weather.png。
3. 通过 workspace.list 确认文件已生成，汇报它的大小。"
```

Raven 根据网关对自身的说明自行建立连接，依次完成 enroll → handshake → grant → invoke，并在终端中报告结果：

![Raven 在终端里完成任务](/guides/raven/06-raven-run.png)

## 4 · 成果

Codex 以无界面模式运行，只能在工作区内写入，并用自己的图像工具生成插画：

![Codex 生成的系统负载晴雨报](/guides/raven/load-weather.png)

## 5 · 你能看到什么、能撤销什么

控制台的 **Activity** 视图记录了完整过程。打开其中的 `codex.run` 调用记录，就能看到 **replay locally** 命令，用它可以在终端重新打开这次调用所用的 Codex 会话：

![审计轨迹](/guides/raven/07-activity.png)

**Agents** 里这个 agent 的卡片展示它的常驻信任——按条撤销或整体撤销都可以：

![agent 的常驻信任](/guides/raven/09-agent-grants.png)

## 下一步

- [快速上手：OpenClaw](/zh/guide/quickstart-openclaw) —— 用以聊天为主的助手完成同样的流程。
- [连接一个 agent](/zh/guide/connect-an-agent) —— 三种交付形态的完整讲解。
- [安全模型](/zh/architecture/security-model) —— 为什么读取采用持续授权，写入等待批准，而执行的持续授权需要你明确开启。
