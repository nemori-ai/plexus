---
layout: home

hero:
  name: Plexus
  text: Your resources, made agent-operable
  tagline: >-
    Each of your tools speaks a different API — none of it graspable from the
    agent's side. Plexus turns them into one self-describing object an agent can
    read and call, with authorization and audit as first-class citizens.
  actions:
    - theme: brand
      text: Get running
      link: /guide/
    - theme: alt
      text: Read the concepts
      link: /concepts/
    - theme: alt
      text: GitHub
      link: https://github.com/nemori-ai/plexus
---

<div class="plx-stance">
  <p class="plx-eyebrow">Why Plexus exists</p>
  <p class="plx-lead">An agent guesses your APIs from <em>its</em> side. Plexus answers from <em>yours</em>.</p>
  <p class="plx-stance-sub">Not another skill format, and not a protocol competing with MCP or A2A — Plexus stands where your resources live and settles the three questions a resource must answer <em>before</em> any agent touches it.</p>
  <ol class="plx-questions">
    <li><span class="plx-q">How do I introduce myself?</span><span class="plx-a">One self-describing contract, in the agent’s own idiom.</span></li>
    <li><span class="plx-q">How is each action authorized?</span><span class="plx-a">Default-deny, scoped, human-in-the-loop, revocable.</span></li>
    <li><span class="plx-q">How is every use accounted for?</span><span class="plx-a">A fine-grained trail — kept per agent.</span></li>
  </ol>
</div>

<div class="plx-start">
  <p class="plx-eyebrow">Connect an agent — three steps, all real</p>
  <div class="plx-steps">
    <div class="plx-step">
      <span class="plx-step-n">01</span>
      <p class="plx-step-t">Connect</p>
      <p>Name the agent, grant a starting cap-set, and mint a one-time code.</p>
    </div>
    <div class="plx-step">
      <span class="plx-step-n">02</span>
      <p class="plx-step-t">Install</p>
      <p>One command redeems the code for the agent’s own durable credential — then deletes it.</p>
    </div>
    <div class="plx-step">
      <span class="plx-step-n">03</span>
      <p class="plx-step-t">Call</p>
      <p><code>list</code> what it can do right now, then invoke by capability id. That launcher is its whole interface.</p>
    </div>
  </div>
  <div class="plx-cta">
    <a class="plx-cta-primary" href="/guide/">Get running →</a>
    <a class="plx-cta-link" href="/concepts/">Read the concepts →</a>
  </div>
</div>
