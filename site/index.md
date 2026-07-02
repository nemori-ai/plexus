---
layout: home

hero:
  name: Plexus
  text: Your resources, made agent-operable
  tagline: >-
    Notes, a calendar, an IoT device, a workspace — each speaks a different API,
    and none of it is something an agent can grasp from your side. Plexus describes
    them as one self-describing, semantic object an agent can read and call — with
    authorization and audit as first-class citizens: default-deny, revocable in one
    move, every call on the record.
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
  - title: Any resource, any shape
    details: >-
      Model your world the way it actually is — files, devices, services, running
      code. Plexus organizes them as Connector → Source → Capability, so an
      arbitrary, nested reality becomes one browsable, uniform catalog of what you
      expose.
  - title: An agent-native capability contract
    details: >-
      Every capability advertises its input shape, its semantics, and how to use it
      on a public, self-describing Floor — readable by any agent over plain HTTP.
      For agents with a native idiom, Plexus compiles that contract into a per-agent
      plugin that feels native, never replacing the source of truth.
  - title: Dynamic authorization, revocable anytime
    details: >-
      Reaching Plexus buys knowledge of what exists — never the right to call it.
      A human grants authority, scoped and time-boxed; sensitive actions pend for
      approval, every time; anything can be revoked in one move. Default-deny is the
      floor, not the exception.
  - title: Fine-grained, end-to-end audit
    details: >-
      Every handshake, grant, and invocation is on the record — who asked, for what,
      under whose approval, with what result. The trail isn't a log bolted on
      afterward; it's part of the boundary, so "what did the agent actually do"
      always has an answer.
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
