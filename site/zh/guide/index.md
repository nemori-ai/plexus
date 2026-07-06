---
title: 快速上手
description: 选择你的场景——无论 agent 和资源共用一台 Mac、隔着隧道分处两台机器、还是横跨一个团队，Plexus 跑的都是同一套信任模型。
---

# 快速上手

Plexus 站在**资源侧**：它是一个归你所有的网关，挡在你机器上的工具前面，让 AI agent 只能经过一道
默认拒绝、全程审计的边界去够到它们——绝不交出裸钥匙。这套模型在下面三种场景里完全一致；变的只是
**agent 相对于你资源的位置**。挑一个符合你的，跟着它的 walkthrough 走。

<div class="level-cards">

### [Level 1 · 全在一台 Mac 上 →](/zh/guide/local)

**agent 和资源共用一台机器。** 什么都不出这台 Mac。这是装机基线，也是*学模型*的最佳起点——连一个
agent，看着一次读顺畅放行、一次写挂起等批准，再撤销。
<br>**从这开始，如果**你刚接触 Plexus，或在本地开发/测试。
*示例：`pomodoro-demo`、`min-agent`、`mesh-security-audit/local`。*

### [Level 2 · 从任何地方够到它 →](/zh/guide/home)

**你的 agent 和资源不在同一台机器上。** 把你家里的网关发布到一个域名下（用你自己域名上的
Cloudflare 隧道——或任何你自带的边缘），让公司的 Claude Code 从任何地方发现、enroll、调用家里的
capability。读可常驻；写为*你*挂起；一次撤销全部 fail closed。
<br>**从这开始，如果**你的资源在家、agent 在别处。
*示例：`home-gateway`（在真实域名上端到端验证过）。*

### [Level 3 · 给团队做资源池 →](/zh/guide/fleet)

**资源属于团队，不属于个人。** 一个常驻的、中立的 parent 网关挡在众多 workload 机器前面，那些机器
向它拨出——这是企业方向。
<br>**从这开始，如果**你在跨一个团队汇聚 capability。
*示例：`mesh-security-audit/cloud`（概览 + 菜谱）。*

</div>

---

## 每种场景共有的东西

两个角色，自始至终分清——这一点跨越所有 level 都不变：

- **你是 admin。** 你持有 **connection-key**，即管理凭据；它认证 `/admin` 控制台。**你绝不把它交给 agent。**
- **agent 拿它自己的凭据。** 连接一个 agent 时，它 enroll 得到一份持久的**按 agent 独立的 PAT**，
  用它调用——绝不用 connection-key。

::: tip 平台
macOS（Apple Silicon 或 Intel）是交付目标。Apple Calendar / Reminders 源仅限 macOS。完整的前置条件
和安装在 [Level 1](/zh/guide/local)。
:::

对心智模型还陌生？**[核心概念](/zh/concepts/)**（Connector → Source → Capability、来源、两个时钟、
自描述的 Floor）会让其余部分一下子通透。权威的信任边界是**[安全模型](/zh/architecture/security-model)**。
