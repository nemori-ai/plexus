---
title: Level 3 · 给团队做资源池
description: 企业方向——parent 网关常驻云端、立场中立，挡在众多 workload 机器前面，机器向它拨出。概览，以及完整菜谱在哪。
---

# Level 3 · 给团队做资源池

**适合谁：** 资源属于**团队**，不属于个人。在 [Level 2](/zh/guide/home)，入口是某个人自己的机器；
这一档把入口换成云端的 **parent 网关**——常驻、中立，挡在众多 **workload 机器**前面。一台 Mac、一台
Linux 盒子、一台 CI runner，各自向它*拨出*。agent 只跟 parent 说话；某个 capability 实际住在哪，
是对授权模型不可见的路由细节。

[联邦 mesh](/zh/architecture/mesh) 和 [ADR-020](/zh/architecture/extensibility) 里预留的企业级
字段（`Attribution.principal` / `policyRef`——"代表谁"、"哪条策略规则"）就是为这一档准备的。
角色化、策略化的授权将来落在这里，底下仍是同一套默认拒绝内核。

::: warning 不是给个人的
如果你是一个人发布自己的机器，这些你都不需要：网关就是*你自己的电脑*，配方就是简单得多的
[Level 2 · home-gateway](/zh/guide/home)（没有云 parent、没有 mesh，端到端验证过）。等资源属于
一个团队、而不属于你个人，再来这里。
:::

## 形态

```
                         ┌──────────────────────────────────────────┐
   agent  ──── https ────┤   边缘（你的域名）  → parent 网关          │
                         └──────────────────────────────────────────┘
                                        ▲ parent 不开任何入站
                                        │
                         ┌──────────────┴───────────────┐
                         │  常驻 PARENT（云端）           │  持有授权、运行授权器、
                         │  中立：自己不承载资源          │  汇聚审计
                         └───────────────────────────────┘
                             ▲                         ▲
                向外拨出      │                         │      向外拨出
             ┌────────────────┴─────┐      ┌────────────┴───────────────┐
             │  workload：一台 Mac  │      │  workload：一台 Linux 盒子  │
             │  （codex、一个 vault）│      │  （sysinfo、一个服务）      │
             └──────────────────────┘      └─────────────────────────────┘
```

每个 workload 向 parent 拨一条持久的、双向认证的隧道——**任何 workload 主机都不开入站端口**
（NAT 友好）。权限终结在 parent：转发给 workload 的一次 invoke 已经获授权，workload 只重新检查它
*本地*的门（暴露、schema、健康）。每个网关保留自己权威的审计；workload 的事件向上冒泡到 parent 的
镜像。完整模型见[联邦 mesh](/zh/architecture/mesh)。

## 完整菜谱

旗舰示例端到端交付了这套拓扑——一个云端 agent 经 mesh 扫描一台 Linux 盒子，把日志交给一台 Mac
workload 上的 Codex，把结论写进一个 vault，全程 owner 批准，带按主机分账的审计和一次 fail-closed 撤销：

**→ [`examples/mesh-security-audit/cloud`](https://github.com/nemori-ai/plexus/tree/main/examples/mesh-security-audit/cloud)**
——一个跑在 Fly.io 上的常驻 parent + 你自己域名上的 Cloudflare Tunnel 边缘，加上 Mac 和 Linux 的
workload 子机。

::: tip 诚实的状态
菜谱是完整的，每个 `PLEXUS_*` flag 都对着 runtime 交叉核对过，join → mount → revoke 的流程和
[本地 hero 拓扑](https://github.com/nemori-ai/plexus/tree/main/examples/mesh-security-audit/local)
端到端验证的是同一套。但**云**这条路径需要*你自己*的 Fly + Cloudflare 账号（要花钱），我们没有端到端
跑过——风险完全在边缘/算力环境，不在 Plexus 的机制里。把它当作一份你来补完的生产模板，而不是一键 demo。
:::

## 后续步骤

- **[联邦 mesh](/zh/architecture/mesh)**——面向开发者的代码地图（primary vs proxy、隧道信任边界、审计冒泡）。
- **[授权可扩展性](/zh/architecture/extensibility)**——把它长成企业级授权的那些接缝（门票/工牌、
  `principal`/`policyRef`）。
- **[安全模型](/zh/architecture/security-model)**——权威的信任与认证模型。