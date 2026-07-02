---
layout: home

hero:
  name: Plexus
  text: 让你的资源，被 Agent 读懂并调用
  tagline: >-
    笔记、日历、IoT、工作区……各说各的 API，Agent 本来无从站在"你的视角"理解它们。Plexus
    把它们描述成一个统一、自描述、语义化的可操作对象——授权与审计是第一公民：默认拒绝、一键可撤、每一次调用都留痕。
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
  - title: 任意结构，统一组织
    details: >-
      你的世界本来是什么结构，就按什么结构建模——文件、设备、服务、可运行的代码。Plexus 用 Connector → Source →
      Capability 三层把它们组织起来，让任意、嵌套的现实变成一份可浏览、统一的"我暴露了什么"目录。
  - title: Agent-Native 的能力契约
    details: >-
      每项 capability 都在公开、自描述的 Floor 上公示自己的输入结构、语义与用法——任何 agent 都能用普通 HTTP
      读到。对有原生惯用法的 agent，Plexus 把这份契约编译成专属 plugin，用起来像原生，却从不取代事实源。
  - title: 随时可撤的动态授权
    details: >-
      触达 Plexus 只换来"存在什么"的知识——换不来调用它的权利。权限由人授予，有范围、有时限；敏感动作每次都挂起等批准；任何授权都能一键撤销。默认拒绝是底线，不是例外。
  - title: 精细化的全链路审计
    details: >-
      每一次握手、授权、调用都留痕——谁在问、要什么、经谁批准、结果如何。审计不是事后外挂的日志，而是边界本身的一部分，所以"agent
      到底做了什么"永远有答案。
---

## 从资源这一侧思考

Agent 是从"它自己"那一侧整合工具的——用世界知识去猜别人递给它的 API。Plexus 把这件事反过来：它不是又一种
skill 格式，也不是与 MCP / A2A 竞争的新协议。它站在你资源所在的一侧，先替资源答完"任何 agent 动它之前必须答清的"三个问题：

- **我怎么介绍自己？**——一份统一、自描述、贴合 agent 惯用法的能力契约。
- **每个动作怎么授权？**——默认拒绝、有范围、human-in-the-loop、随时可撤。
- **每次使用怎么被记录？**——一条贯穿全链路的精细化审计轨迹。

## agent 如何接入

每一步都是真实存在的代码，不是愿景。

1. **你连接一个 agent**——为它命名、授予初始的 capability 集合、签发一次性 enroll 码。
2. **它运行一条命令**——装好专属 plugin，用这个码换取自己那份持久凭据，随即删除该码。
3. **它调用 capability**——通过自己的 launcher：先用 `list` 看此刻能做什么，再按 capability id 去 invoke。这条命令是它完整且唯一的接口；它从不自己拼 HTTP，也不猜认证方式。

初来乍到？先读 **[从零开始 →](/zh/guide/)**，再读
**[核心概念 →](/zh/concepts/)**——正是这一篇让其余一切豁然开朗。
