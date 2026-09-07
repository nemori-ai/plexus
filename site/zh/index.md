---
layout: home

hero:
  name: Plexus
  text: 让 agent <span style="white-space:nowrap">能操作你的资源</span>
  tagline: >-
    你的工具各有一套 API，agent 却无从理解这些接口。Plexus 把它们变成一个能自我描述的对象，让 agent 可以读取和调用，并将授权与审计放在核心位置。
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

<div class="plx-stance">
  <p class="plx-eyebrow">Plexus 为何存在</p>
  <p class="plx-lead">Agent 从<em>它那侧</em>猜你的 API。Plexus 从<em>你这侧</em>回答。</p>
  <p class="plx-stance-sub">Plexus 不是又一种 skill 格式，也不是与 MCP 或 A2A 竞争的协议。它位于你的资源一侧，先解决资源在任何 agent 接触<em>之前</em>必须回答的三个问题。</p>
  <ol class="plx-questions">
    <li><span class="plx-q">我该如何介绍自己？</span><span class="plx-a">一份自描述契约，采用智能体熟悉的表达方式。</span></li>
    <li><span class="plx-q">每次操作如何获得授权？</span><span class="plx-a">默认拒绝，限定授权范围，授权过程有人参与，授权可撤销。</span></li>
    <li><span class="plx-q">如何记录每一次使用？</span><span class="plx-a">留下详细的使用记录，按智能体分别保存。</span></li>
  </ol>
</div>

<div class="plx-start">
  <p class="plx-eyebrow">接入智能体——实实在在的三步</p>
  <div class="plx-steps">
    <div class="plx-step">
      <span class="plx-step-n">01</span>
      <p class="plx-step-t">连接</p>
      <p>给 agent 命名，授予初始 cap 集合，签发一次性码。</p>
    </div>
    <div class="plx-step">
      <span class="plx-step-n">02</span>
      <p class="plx-step-t">安装</p>
      <p>一条命令把码换成 agent 自己的持久凭据——随即删码。</p>
    </div>
    <div class="plx-step">
      <span class="plx-step-n">03</span>
      <p class="plx-step-t">调用</p>
      <p>先 <code>list</code> 看它此刻能做什么，再按 capability id 调用。这个 launcher 就是它的全部接口。</p>
    </div>
  </div>
  <div class="plx-cta">
    <a class="plx-cta-primary" href="/zh/guide/">快速上手 →</a>
    <a class="plx-cta-link" href="/zh/concepts/">阅读核心概念 →</a>
  </div>
</div>
