---
title: "快速上手：Raven"
description: "把 TUI 优先的 agent 框架 Raven 通过纯 HTTP 接入 Plexus。按指南粘贴一条指令，agent 侧无须额外安装，再让它在授权范围内读取系统状况、驱动 Codex，并取回成果。"
---
# 快速上手：接入 Raven {#快速上手-接入-raven}

[Raven](https://github.com/evermind/raven) 是一个终端优先的 agent 框架：像 OpenClaw 一样做助手，但通过 TUI、`raven agent`、`raven gateway`、channels 和 cron 驱动。只要能执行命令、发送 HTTP 请求，就能把接入指令放进对话，以 **in-context** 形态使用 Plexus，无需安装 Plexus 插件。

这次让 Raven 读取机器的真实负载，再让 Codex 用图像生成工具画一张「系统负载晴雨报」。调用经过授权，过程留有审计，授权随时可以撤销。

开始前需要：

- 一个运行中的 Plexus 网关（[先启动网关](/zh/guide/)）。
- 已完成 `raven onboard`、配好模型，并通过 `raven doctor` 验证的 Raven。
- 要生成演示中的插画，网关机器上还须安装 **Codex CLI**，并开启 Codex 源的 **Real launch**：控制台 → What I expose → Codex。

## 1 · 打开控制台 {#_1-·-打开控制台}

打开网关的 `/admin`，粘贴你的 **connection key**。这是管理凭证，**agent 永远拿不到它**，也不要把它放进接下来交给 Raven 的指令。

![在控制台粘贴 connection key](/guides/raven/01-paste-connection-key.png)

## 2 · 连接一个 agent {#_2-·-连接一个-agent}

依次选择 **Connect an agent** → 命名为 `raven` → 勾选能力集。这里和 OpenClaw 演示一样，选这五项：

- `sysinfo.resources.read`、`sysinfo.processes.list`
- `codex.run`
- `workspace.list`、`workspace.read`

![选择五项能力](/guides/raven/04-connect-capabilities.png)

勾选先确定 agent 的能力子集，不代表所有操作都已获准调用。连接时，**勾选的读能力会成为常驻（standing）授权**，在有效范围内不必每次再问。

`codex.run` 则是 execute，**默认逐次审批**。本次演示的 in-context 工作流不能停在审批循环里等你。为走完这次任务，需要你在连接时，为这个 agent 的 `codex.run` 显式选择 **Standing**，并完成二次确认。这个例外只能由拥有者开启，agent 不能自行决定。

![开启 Standing execute 需要显式选择并二次确认](/guides/raven/04b-standing-confirm.png)

## 3 · 把指令交给 Raven {#_3-·-把指令交给-raven}

选择 **In-context / HTTP** 交付形态，复制内嵌一次性 enroll code 的指令：

![复制含一次性 code 的 in-context 指令](/guides/raven/05-connect-install-incontext.png)

把指令粘贴进 Raven 的 TUI 对话，或用单次 CLI：

```bash
raven agent -m "<你复制的指令>

连接完成后，这是你的第一个任务：
1. 用授权给你的 sysinfo 能力读取我机器当前的负载。
2. 调用一次 codex.run：让 Codex 用它内建的图像生成工具画一张卡通晴雨报插画，
   把真实数字写进画面，存为 load-weather.png。
3. 通过 workspace.list 确认文件已生成，汇报它的大小。"
```

Raven 从网关的自描述开始，依次完成 enroll → handshake → grant → invoke。enroll 用一次性码换取 agent 专属 PAT；handshake 用 PAT 认证，取得会话和子集 manifest，**不授予调用权**。调用前还要通过 grant 取得有范围的授权；已有符合条件的常驻授权时，不必再次提示你批准。

终端会汇报读取、生成和文件检查的结果：

![Raven 在终端里完成任务](/guides/raven/06-raven-run.png)

## 4 · 成果 {#_4-·-成果}

Codex 在写入受限的 workspace 沙箱里无头运行，用图像工具生成插画。画面写入本次读取的真实负载数字，文件保存为 `load-weather.png`；Raven 再通过 `workspace.list` 确认它已生成，并汇报大小。

![Codex 生成的系统负载晴雨报](/guides/raven/load-weather.png)

## 5 · 查看记录与撤销授权 {#_5-·-你能看到什么、能撤销什么}

控制台的 **Activity** 保存完整轨迹。点开 `codex.run` 那条调用，**replay locally** 面板会给出一条命令，让你在本机终端原样重现那次 Codex 会话：

![查看调用审计轨迹](/guides/raven/07-activity.png)

**Agents** 中，`raven` 的卡片展示它的常驻信任。按条撤销，会收回对应的授权；整体撤销，会收回这个 agent 的接入权限。撤销限制后续访问，不会撤回已经完成的工作，也不会抹掉生成的文件。

![查看并撤销 agent 的常驻信任](/guides/raven/09-agent-grants.png)

## 下一步 {#下一步}

- [快速上手：OpenClaw](/zh/guide/quickstart-openclaw) —— 用聊天优先的助手走完同一流程。
- [连接一个 agent](/zh/guide/connect-an-agent) —— 了解三种交付形态。
- [安全模型](/zh/architecture/security-model) —— 了解读能力如何常驻、写操作为何逐次审批，以及 execute 常驻为何必须由你显式开启。
