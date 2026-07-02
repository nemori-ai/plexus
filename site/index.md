---
layout: home

hero:
  name: Plexus
  text: The capability gateway
  tagline: >-
    Expose your local tools — your notes, your calendar, your workspace — and
    let an AI agent call them through a default-deny, fully-audited boundary. Never
    by handing over a raw key.
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

features:
  - title: The resource holds the boundary
    details: >-
      Plexus represents the resource side. An agent that reaches the gateway still
      has zero authority — reaching it buys knowledge of what exists, never the
      right to call anything. Authority is something a human grants, scoped and
      revocable.
  - title: Self-describing, then compiled
    details: >-
      A public Floor advertises every exposed capability, its input shape, and how
      to use it — any agent can read it. For agents with a native idiom, Plexus
      compiles a per-agent plugin: a projection over that Floor, so it feels native
      without replacing the source of truth.
  - title: Two credentials, never confused
    details: >-
      You hold the connection-key — the admin credential. Each agent enrolls for
      its own durable, independently-revocable credential. An agent never sees the
      connection-key; a leaked agent credential is one agent's capabilities, not
      the keys to the house.
  - title: Sensitive actions can't be pre-approved
    details: >-
      A read grant can be standing for a while. Execute capabilities — running code
      — never can: they are approved per use, every time. Not even the
      owner can waive that.
---

## How an agent connects

Every step is code, not aspiration.

1. **You connect an agent** — name it, grant a starting capability set, mint a
   one-time enrollment code.
2. **It runs one command** — a per-agent plugin installs, redeems the code for its
   own durable credential, and deletes the code.
3. **It calls capabilities** — through its own launcher: `list` to discover what it
   can do right now, then the capability id to invoke. The command is its complete
   and only interface; it never hand-rolls HTTP or guesses at auth.

New here? Start with **[From zero →](/guide/)**, then read
**[the concepts →](/concepts/)** — the one document that makes the rest click.
