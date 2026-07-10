---
title: Expose an agent to other agents
description: The second use of Plexus — publish a coding agent (Claude Code, Codex) as a capability other agents call across machines, with every execution approved per use by default.
---

# Expose an agent to other agents

So far Plexus fronted your **files and tools**. But a running **coding agent** is itself a
capability. Machine A can expose its Claude Code execution entry point — `claudecode.run` — through
Plexus, and an agent on machine B can call it. That flips the usual picture: instead of one agent
reaching many resources, one **orchestrator** reaches many **workers**, and each worker sits behind
its own owner's gate. On macOS `claudecode.run` is a **first-party** source that registers itself —
nothing to configure. Expose it, and other agents can put your machine to work coding, one approved
run at a time.

## Why execution is the highest-stakes call

Reads can stand. A folder read is low-risk and you pre-decided it, so it flows without interrupting
you. **Execution is per-use by default.** An `execute` capability is approved **per use, every
time** — and the agent can never lift that itself. The only way an execute grant stands is your own
deliberate opt-in at connect time, for one specific agent + capability (off by default,
double-confirmed). Handing another agent the ability to *run code on your machine* is the sharpest
edge Plexus governs, so the gate stays in front of every single call.

You can see the whole rule in the approval card:

![The Plexus approval card for an execute call. Header "Grant request", tags GRANT / ORCHESTRATOR / PLEXUS-CLI, then two badges specific to this kind of call — FIRST-PARTY and ELEVATED. Plexus says: "Approving lets orchestrator EXECUTE Run Claude Code (sandboxed) (first-party, elevated-sensitivity) for this one request only; revoke anytime in Plexus → Grants." Scope: claudecode.run [execute]. The agent requested Once (advisory). A warning reads "granting execute on claudecode.run is a mutating/side-effecting grant and requires a human decision". On the right, the Trust window dropdown — for an execute capability the owner did not opt into standing, whatever window is picked resolves to "Once". Approve / Deny buttons below.](/screenshots/guide/08-execute-approval.png)

Two things on this card don't appear on a read approval. The **ELEVATED** badge and the
**mutating/side-effecting** warning mark it as a human-decision-required act. And the **trust window
resolves to `Once`**: the dropdown shows the usual window choices, but for an execute capability you
did not opt into standing at connect, the gateway clamps whatever you pick to `Once` — the rule
lives in the grant service, not the UI. Approve this call and you've authorized exactly this
call — the next one pends again.

## What one call looks like

The caller discovers its surface with `list`, exactly as in the [trust loop](/guide/run-it). The
execute capability shows up as **needs-approval** — it isn't pre-granted by default:

```text
  ○ claudecode.run — Run Claude Code (sandboxed) (execute)  [first-party, elevated]
      Launch headless Claude Code to do REAL coding work ... sandboxed to ONE authorized
      directory: it does its work there and cannot create or modify files outside it ... you only
      pass a `{ prompt }` ... This is a SENSITIVE execute capability: it PENDS for the owner's
      approval before it runs — issue the call and WAIT.
```

The call itself pends every time, resolves when the owner approves, and returns:

```text
$ plexus-orchestrator claudecode.run --input '{"prompt":"Read README.md, then add a small greet(name) example ..."}'
plexus: 'claudecode.run' is awaiting the owner's approval — waiting (up to 15 min). Approve it in the Plexus console.
# (owner approves — trust window resolves to "Once"; this execute wasn't opted into standing)
plexus: approved — invoking 'claudecode.run'.
{
  "ok": true,
  "launched": false,
  "sandboxed": true,
  "output": "",
  "exitCode": null,
  "reason": "record mode: the owner has not enabled real launch for this source (Plexus console → What I expose → Claude Code → Real launch), so the native command was assembled and audited but not spawned",
  "op": "run"
}
```

Note `launched: false`. Out of the box `claudecode.run` runs in **record mode**: the native
command is fully assembled and audited, but the Claude Code process is **not spawned** — so
the call **burns no model credit**. What's real in record mode is everything that matters for trust:
the enrollment, the per-use pend, the owner's decision, and the confinement posture
(`sandboxed: true`, the jail — Claude Code's own native sandbox, which write-confines the run to the
authorized directory). You can walk the entire authorization loop and never
spend a token. Flipping to a real run is a deliberate, separate switch — see [Real launch](#real-launch-record-to-real).

## What the owner sees vs. what the agent sees

The JSON above is the agent's whole view. It's deliberately thin: `ok / launched / sandboxed /
output / exitCode / reason`, and nothing else. The agent never learns the absolute jail path, the
machine's layout, or the full argv — handing those over would let a caller fingerprint the owner's
machine. Reachability buys an agent a result, never a map.

The owner's **audit** keeps the full posture:

```text
invoke claudecode.run detail = {
  transport: "in-process", kind: "capability", op: "run",
  sandboxed: true,
  jail: "<the authorized dir>",
  mechanism: "claude-native",
  launched: false,
  argv: ["<claude>","-p","«prompt»","--dangerously-skip-permissions","--permission-mode","bypassPermissions"],   # prompt is masked to «prompt» in the audit argv
  confinement: {...}
}
```

Same call, two projections. The agent gets the minimal result it needs to act; the owner keeps the
jail path, the confinement mechanism, and the resolved argv — the evidence that the
run was confined. Even here the prompt text is masked to `«prompt»`, so the audit records *that* a run
happened and *how* it was boxed, without persisting the instruction verbatim. That split — thin wire,
complete audit — is what lets you expose execution to a stranger's agent without exposing your
machine to it.

## Across machines — two paths

Everything above happens on one machine. To let an agent on **another** machine call `claudecode.run`,
you need reachability, and Plexus gives you two shapes for it. The trust model is identical in both;
only *where the pend fires* and *where the sandbox runs* differ.

### Single machine over a tunnel — `publicHostname`

Machine A is the machine the agent connects to. You publish A's gateway under a hostname
(`PLEXUS_PUBLIC_HOSTNAME`), and the remote agent enrolls and calls over that longer wire. The switch
adds **reachability only** — the trust model doesn't move: the pend fires on A, the sandboxed run
happens on A, the audit lives on A. The [`home-gateway` example](https://github.com/nemori-ai/plexus/tree/main/examples/home-gateway)
is the verified recipe for this shape (a real Cloudflare named tunnel, install → enroll → standing
read → pending write → approve → revoke-fails-closed). It demonstrates the pend on `workspace.write`;
`claudecode.run` rides the exact same path, with the execute-per-use ceiling on top.

### Many machines — the federated mesh

When the coding agent lives on a *different* machine from the orchestrator, the capability is mounted
across a [mesh](/architecture/mesh). The cap sits on a **proxy** machine and mounts onto a **parent
primary**; the agent talks to the parent. Now the two halves separate cleanly: the **pend fires in
the parent's admin**, and the **sandboxed run executes on the proxy** — the machine that actually owns
the Claude Code. Each host keeps its own audit of what *it* ran.

The [`mesh-security-audit/cloud` example](https://github.com/nemori-ai/plexus/tree/main/examples/mesh-security-audit)
verifies this shape end to end — but with **`codex.run`**, not `claudecode.run`: a cloud agent reaches
a Mac workload's Codex over the mesh, sandbox-jailed, pending each call, per-host audit, revoke fails
closed.

::: warning Honest status
`claudecode.run`'s cross-machine path is **structurally identical** to `codex.run`'s — same
enrollment, same per-use pend, same wire/audit split, same mesh forwarding. The **`codex.run`**
version is the one verified end-to-end in `mesh-security-audit`. `claudecode.run` rides that same
path, but its own tests are **local record-mode unit tests** — there is no separate cross-machine
end-to-end run for the Claude Code capability specifically. Treat the mesh path for `claudecode.run`
as "the same mechanism codex proved," not as independently e2e-verified.
:::

## Real launch — record to real {#real-launch-record-to-real}

Record mode is the default because it proves the whole trust chain without spending a token. When you
actually want the worker to *do the coding*, the owner opts in explicitly:

- In the console: **What I expose → Claude Code → Real launch**, or
- set `PLEXUS_CC_HEADLESS_LAUNCH=1` on the gateway.

With real launch on, the same approved call spawns a headless Claude Code under that same native
sandbox, write-confined to the authorized directory, and the response carries a real
`launched: true`, `output`, and `exitCode` instead
of the record-mode `reason`. This **really runs Claude Code and really burns model credit** — it is an
owner decision, off by default, and every run still rides the same grant gate (per-use unless you
opted this execute into standing at connect).

## Where this goes

**Multiple workers, one machine — a roadmap.** The obvious next step is to expose an Opus entry point
and a Sonnet entry point as distinct capabilities, so a caller picks the worker by capability id and
you gate each independently. **This does not exist yet.** Today there is no `claudecode` kind adapter,
and `claudecode.run` takes no model parameter — its argv is `claude -p <prompt>` plus CC's
permission-bypass flags, still with no `--model`.
Getting there needs (a) a `claudecode` kind adapter (analogous to the `workspace-dir` one) and (b) a
model parameter threaded through the launcher/entries so it can inject `claude --model`. Until then,
one entry point per machine.

**A pool for a fleet.** The same per-use-approved pattern, fronted by an always-on neutral gateway
with many workers behind it, is the team-scale direction — a resource pool an orchestrator draws from.
That's the enterprise shape the [federated mesh](/architecture/mesh) is built toward; see the
[`mesh-security-audit/cloud`](https://github.com/nemori-ai/plexus/tree/main/examples/mesh-security-audit)
example for how the parent-primary + dial-out-proxy machinery already carries it.

---

The mechanics under all of this are the [trust loop](/guide/run-it) you already know — enroll,
per-use approval, audit, revoke. Only the capability changes: from reading a file to running a coding
agent, which is why the gate never stops asking. See also [Connect an agent](/guide/connect-an-agent)
and [the security model](/architecture/security-model) for the execute-defaults-to-once rule
(owner opt-in required to lift it) in full.
