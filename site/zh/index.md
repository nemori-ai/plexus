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

<div class="plx-stance">
  <p class="plx-eyebrow">Plexus 为何存在</p>
  <p class="plx-lead">Agent 从<em>它那侧</em>猜你的 API。Plexus 从<em>你这侧</em>回答。</p>
  <p class="plx-stance-sub">不是又一种 skill 格式，也不是与 MCP / A2A 竞争的协议——Plexus 站在你资源所在的一侧，先答清任何 agent 动手<em>之前</em>，一个资源必须回答的三个问题。</p>
  <ol class="plx-questions">
    <li><span class="plx-q">我怎么介绍自己？</span><span class="plx-a">一份自描述的契约，用 agent 自己的惯用法。</span></li>
    <li><span class="plx-q">每个动作怎么授权？</span><span class="plx-a">默认拒绝、有范围、human-in-the-loop、随时可撤。</span></li>
    <li><span class="plx-q">每次使用怎么记账？</span><span class="plx-a">一条精细的轨迹——各 agent 各自一份。</span></li>
  </ol>
</div>

<div class="plx-start">
  <p class="plx-eyebrow">接入一个 agent——三步，都是真代码</p>
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
