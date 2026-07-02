---
layout: home

hero:
  name: Plexus
  text: 能力网关
  tagline: >-
    暴露你自己的本地工具——你的笔记、你的日历、你的工作区——让 AI agent 通过一个默认拒绝、全程审计的边界来调用它们。而绝不是把一把原始密钥直接交出去。
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
      Plexus 代表资源一侧。一个 agent 即便触达了网关，仍然没有任何权限——触达只换来"存在什么"的知识，而绝不换来调用任何东西的权利。权限是由人来授予的，有范围、可撤销。
  - title: 先自描述，再编译
    details: >-
      一个公开的 Floor 会公示每一项被暴露的 capability、它的输入形状，以及如何使用它——任何 agent 都能读到。对于拥有原生惯用法的 agent，Plexus 会为其编译一个专属的 plugin：它是对那个 Floor 的一层投影，因此感觉起来就像原生的，却从不取代事实源。
  - title: 两种凭据，绝不混淆
    details: >-
      你持有 connection-key——管理员凭据。每个 agent 各自 enroll，换取它自己那份持久、可独立撤销的凭据。agent 永远看不到 connection-key；一份泄漏的 agent 凭据只是单个 agent 的那点 capability，而不是打开整栋房子的钥匙。
  - title: 敏感操作无法被预先批准
    details: >-
      read capability 可以常驻一段时间。execute capability——运行代码——则永远不能常驻：它们每一次使用都要单独批准，每次都是。连拥有者本人也无法豁免这一点。
---

## 一个 agent 如何接入

每一步都是真实的代码，而非愿景。

1. **你连接一个 agent**——为它命名、授予一个初始的 capability 集合、签发一次性的 enroll 码。
2. **它运行一条命令**——一个专属的 plugin 完成安装，用这个码换取它自己那份持久凭据，然后删除该码。
3. **它调用 capability**——通过它自己的 launcher：`list` 用于发现它此刻能做什么，然后用 capability id 去 invoke。这条命令是它完整且唯一的接口；它从不自己拼 HTTP，也不去猜认证方式。

初来乍到？先从 **[从零开始 →](/zh/guide/)** 起步，然后阅读
**[核心概念 →](/zh/concepts/)**——正是这份文档让其余一切豁然开朗。
