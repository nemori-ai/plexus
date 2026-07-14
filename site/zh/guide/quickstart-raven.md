---
title: 快速上手：Raven
description: 把 Raven——一个 TUI 优先的 agent 框架——用纯 HTTP 接入 Plexus：粘贴一条指令、零安装，看它读取系统状况、驱动 Codex、再把成果取回来。
---

# 快速上手：接入 Raven

[Raven](https://github.com/evermind/raven) 是一个 TUI 优先的 agent 框架——OpenClaw 风格的助手，但在终端里驱动（`raven agent`、`raven gateway`、channels、cron）。和任何会执行命令、会说 HTTP 的 agent 一样，它用 **in-context** 形态接入 Plexus：什么都不用装，粘贴一条指令即可。

demo 故事和所有 agent 一样：Raven 通过 Plexus 读取你机器的负载，让 **Codex 用它的图像生成工具画一张真正的「系统负载晴雨报」插画**——每一步都经过授权、留有审计、随时可撤销。

**你需要：**

- 一个运行中的 Plexus 网关（[先跑起来](/zh/guide/)）。
- 完成 onboard、配好模型的 Raven（`raven onboard`，再用 `raven doctor` 验证）。
- 想要漫画彩蛋：网关机器上装好 **Codex CLI**，并开启 Codex 源的 **Real launch**（控制台 → What I expose → Codex）。

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

选 **In-context / HTTP** 交付形态，复制指令（内嵌一次性 enroll code）：

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

Raven 从网关的自描述出发自己完成引导——enroll → handshake → grant → invoke——并在终端里汇报：

![Raven 在终端里完成任务](/guides/raven/06-raven-run.png)

## 4 · 成果

Codex 在写入受限的 workspace 沙箱里无头运行，用图像工具生成插画：

![Codex 生成的系统负载晴雨报](/guides/raven/load-weather.png)

## 5 · 你能看到什么、能撤销什么

控制台的 **Activity** 有完整轨迹——点开 `codex.run` 那条调用，**replay locally** 面板给你一条命令，在本机终端原样重现那次 Codex 会话：

![审计轨迹](/guides/raven/07-activity.png)

**Agents** 里这个 agent 的卡片展示它的常驻信任——按条撤销或整体撤销都可以：

![agent 的常驻信任](/guides/raven/09-agent-grants.png)

## 下一步

- [快速上手：OpenClaw](/zh/guide/quickstart-openclaw) —— 同一个闭环，走聊天优先的助手。
- [连接一个 agent](/zh/guide/connect-an-agent) —— 三种交付形态的完整讲解。
- [安全模型](/zh/architecture/security-model) —— 为什么读能力常驻、写逐次审批、execute 需要你显式开启。
