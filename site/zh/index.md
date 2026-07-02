---
layout: home

hero:
  name: Plexus
  text: 让你的资源，被 Agent 读懂并调用
  tagline: >-
    你的每样工具都各说各的 API，Agent 无从站在"你的视角"理解它们。Plexus
    把它们变成一个自描述、可操作的统一对象——授权与审计是第一公民：默认拒绝、随时可撤、每次调用都留痕。
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
