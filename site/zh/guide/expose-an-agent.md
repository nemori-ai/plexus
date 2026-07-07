---
title: 把 agent 暴露给别的 agent
description: Plexus 的第二种用法——把一个 coding agent（Claude Code、Codex）发布成 capability，让别的机器上的 agent 跨机调用，每次执行都逐次批准。
---

# 把 agent 暴露给别的 agent

::: warning 骨架——完整 walkthrough 待补
这一页建立在[看信任回环](/zh/guide/run-it)的那个回环之上。这里先立第二大用法的骨架；端到端菜谱
在核心 guide 之后落地。
:::

到目前为止，Plexus 挡在你的**文件和工具**前面。但一个跑着的 **coding agent** 本身就是一个
capability。A 机可以把它的 Claude Code（或 Codex）执行入口经 Plexus 暴露出去，B 机上的 agent
就能调用它——一个 orchestrator 驱动多个 worker 的扇出，每个 worker 都在各自 owner 的门后。

## 为什么执行是更高风险的那档

读可以常驻；一次文件夹读风险低，你也预先拍过板。**执行永不常驻。** `execute` capability
**每次使用、逐次批准**——它永远变不成常驻 grant，连你自己也办不到。把"在你机器上跑代码"的能力
交给另一个 agent，是 Plexus 治理的最锋利一刃，所以这道门守在每一次调用前面，
[Activity](/zh/guide/run-it) 账上记下每一笔。

## 形状

1. **A 机把它的 coding agent 暴露成 execute source**——一个 `claudecode` / `codex` capability。
2. **B 机的 agent 发现并 enroll**，与核心回环完全一致：一个你铸的 code，一份按 agent 独立的
   PAT，没有裸密钥。
3. **每次调用都为 A 的 owner 挂起。** B 发问；A 拍板；批准之后才跑，退出结果可审计。

## 往后走

- **一台机器，多个实例。** 把 Opus 入口和 Sonnet 入口暴露成两个不同的 capability——调用方按
  capability id 挑 worker，你对每个入口单独把门。
- **给团队做池子。** 同一个模式，前面立一个常驻的中立网关，就是团队规模的方向。

**后续会补全。** 在这页填满之前，机制——enroll、逐次批准、审计账——与[信任回环](/zh/guide/run-it)
一模一样；变的只有被调用的 capability，从读文件换成跑代码。另见
[连接一个 agent](/zh/guide/connect-an-agent) 与[安全模型](/zh/architecture/security-model)。
