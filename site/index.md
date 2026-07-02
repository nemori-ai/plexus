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

## Plexus thinks from the resource side

An agent integrates tools from *its* side — using its world-knowledge to guess at
whatever APIs it's handed. Plexus flips that. It isn't another skill format, and it
isn't a new protocol competing with MCP or A2A. It stands where your resources live
and answers the three questions a resource must settle *before* any agent should
touch it:

- **How do I introduce myself?** — one unified, self-describing capability contract,
  in the agent's own idiom.
- **How is each action authorized?** — default-deny, scoped, human-in-the-loop,
  revocable at any moment.
- **How is every use accounted for?** — a fine-grained trail across the whole chain.

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
