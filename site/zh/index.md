---
layout: home

hero:
  name: Plexus
  text: 能力网关
  tagline: >-
    把你的本地工具——笔记、日历、工作区——暴露给 AI agent，每一次调用都要过一道默认拒绝、全程审计的边界，而不是把原始密钥直接交出去。
  actions:
    - theme: brand
      text: 快速上手
      link: /zh/guide/
    - theme: alt
      text: 阅读核心概念
      link: /zh/concepts/
    - theme: alt
      text: GitHub
      link: https://github.com/nemori-ai/plexus
features:
  - title: 资源方掌握边界
    details: >-
      Plexus 代表资源一侧。agent 触达网关不等于拿到权限——触达只换来"存在什么"的知识，换不来调用任何东西的权利。权限由人授予，有范围、可撤销。
  - title: 先自描述，再编译
    details: >-
      公开的 Floor 公示暴露的每项 capability、它的输入结构和用法，任何 agent 都能读到。对有原生惯用法的 agent，Plexus 会为它编译一个专属 plugin——那只是 Floor 的一层投影，用起来像原生，却从不取代事实源。
  - title: 两种凭据，绝不混淆
    details: >-
      connection-key 是管理员凭据，由你持有。每个 agent 各自 enroll，换取自己那份持久、可独立撤销的凭据。agent 永远看不到 connection-key；agent 凭据即使泄漏，丢的也只是那一个 agent 手里的 capability，而不是整栋房子的钥匙。
  - title: 敏感操作无法被预先批准
    details: >-
      read capability 可以常驻一段时间。execute capability——运行代码——永远不能常驻：每次使用都要单独批准，无一例外。拥有者本人也不能豁免。
---

## agent 如何接入

每一步都是真实存在的代码，不是愿景。

1. **你连接一个 agent**——为它命名、授予初始的 capability 集合、签发一次性 enroll 码。
2. **它运行一条命令**——装好专属 plugin，用这个码换取自己那份持久凭据，随即删除该码。
3. **它调用 capability**——通过自己的 launcher：先用 `list` 看此刻能做什么，再按 capability id 去 invoke。这条命令是它完整且唯一的接口；它从不自己拼 HTTP，也不猜认证方式。

初来乍到？先读 **[从零开始 →](/zh/guide/)**，再读
**[核心概念 →](/zh/concepts/)**——正是这一篇让其余一切豁然开朗。
