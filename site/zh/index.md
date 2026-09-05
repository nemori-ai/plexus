---
layout: home

hero:
  name: Plexus
  text: "让 Agent 看懂你的资源，按你的授权使用"
  tagline: "每样工具各有自己的 API，Agent 拼不出你眼中的整体。Plexus 把它们组织起来，让资源自己说明有什么、怎么用，也让 Agent 能实际操作。允许谁用、用到什么范围，由你决定。授权和审计从一开始就在：未获授权默认拒绝，指定授权随时可撤，每次调用都有记录。"
  actions:
    - theme: brand
      text: "快速上手"
      link: /zh/guide/
    - theme: alt
      text: "阅读核心概念"
      link: /zh/concepts/
    - theme: alt
      text: GitHub
      link: https://github.com/nemori-ai/plexus
---
<div class="plx-stance">
  <p class="plx-eyebrow">Plexus 为何存在</p>
  <p class="plx-lead">Agent 要用你的 API，得先知道有哪些操作、怎样用。Plexus 让<em>拥有资源的你</em>给出说明，也由你决定<em>谁能在什么范围内动手</em>。</p>
  <p class="plx-stance-sub">Plexus 站在你资源这一侧。它不是另一种 skill 格式，也不跟 MCP / A2A 抢协议；它先答清资源在 agent 动手前必须回答的三个问题。<em>知道有哪些能力，不等于获准调用。</em></p>
  <ol class="plx-questions">
    <li><span class="plx-q">我怎么介绍自己？</span><span class="plx-a">给出一份自描述的契约，按 agent 惯用的方式说明能力和用法。</span></li>
    <li><span class="plx-q">每个动作怎么授权？</span><span class="plx-a">没有授权，默认拒绝。授权由你批准，范围明确，随时可撤。</span></li>
    <li><span class="plx-q">每次使用怎么记账？</span><span class="plx-a">每次使用都留下细致的轨迹，每个 agent 各记一份。</span></li>
  </ol>
</div>

<div class="plx-start">
  <p class="plx-eyebrow">通过编译集成接入 agent——三步，都是真代码</p>
  <div class="plx-steps">
    <div class="plx-step">
      <span class="plx-step-n">01</span>
      <p class="plx-step-t">连接</p>
      <p>给 agent 命名，选定 capability 子集，签发一次性码。选中的读取能力在连接时获得常驻授权；写入、执行默认逐次申请。你可为指定 agent 的指定能力直接授予常驻访问；写入也可在批准请求时设定有效信任窗口，执行则必须由你主动开启常驻授权。</p>
    </div>
    <div class="plx-step">
      <span class="plx-step-n">02</span>
      <p class="plx-step-t">安装</p>
      <p>一条命令把一次性码换成 agent 自己的持久 PAT，随即删码。connection-key 是你的管理凭据，不交给 agent。agent 用 PAT 认证握手，绑定真实身份，取得会话和你选定且仍开放的能力子集 manifest。握手不授予调用权。</p>
    </div>
    <div class="plx-step">
      <span class="plx-step-n">03</span>
      <p class="plx-step-t">调用</p>
      <p>先用 <code>list</code> 了解当前可见的能力，再单独取得有范围的授权和令牌，按 capability id 调用。已有符合条件的常驻授权时，不必再次请你批准。在这套编译集成中，launcher 管理凭据流程，也是 agent 的全部接口。不装插件，也可直接使用 HTTP Floor。插件说明即使过期，调用仍以网关的检查为准。</p>
    </div>
  </div>
  <div class="plx-cta">
    <a class="plx-cta-primary" href="/zh/guide/">快速上手 →</a>
    <a class="plx-cta-link" href="/zh/concepts/">阅读核心概念 →</a>
  </div>
</div>
