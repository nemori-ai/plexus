---
title: Changelog
description: What shipped in each Plexus release — the product story, version by version.
---

# Changelog

What each release changed for the person running Plexus. The wire contract is versioned
separately and moves far more slowly — see [the protocol](/protocol/).

::: tip
Tagged releases and their full commit history live on
[GitHub](https://github.com/nemori-ai/plexus/releases).
:::

## 0.9.1 — reach the browser you are actually logged into

`attach` now works against your everyday Chrome, and a third route arrives.

- **The `chrome://inspect` toggle is supported properly.** Since Chrome 136 the binary refuses
  `--remote-debugging-port` on the default profile, so that toggle is the *only* way into a
  logged-in browser — and it serves a different surface than the classic flag. Both shapes now
  sit behind one connection facade.
- **A Chrome extension, as a third transport.** Consent is granted **once at install** instead
  of per connection, and it works on your normal profile. It is a transport and nothing else:
  the allowlist, the approval and the audit stay in the gateway, where a page cannot argue with
  them.
- **Clicking and typing use real input events.** Custom form widgets and rich-text editors that
  ignore direct DOM writes now actually receive what an agent sends — and a click is refused
  when something else is covering the target.
- Tabs are filtered before they are listed: on a browser with 25 tabs open, only the ones on
  authorized domains appear at all.

## 0.9.0 — browser control

**Drive a real Chrome.** A new execute-class source that navigates, reads, clicks, types,
screenshots and uploads — over the DevTools Protocol, with no Puppeteer or Playwright
dependency and no browser download.

- **The owner's decision is *which browser*:** a fresh empty profile that is nobody, or the
  browser they are logged into. That is what sets the blast radius; everything else is detail.
- **A domain allowlist you control**, checked against the real target URL and re-checked before
  every act — because Chrome's own consent authorizes the browser, not a set of sites.
- **The page surface is open** (arbitrary JavaScript and raw page-scoped CDP included), because
  inside a page an agent may already touch, click + type are already full user agency. The
  browser-global half of CDP is withheld, which is what keeps the allowlist meaningful.
- **Upload is jailed** to one directory you name, and refuses everything until you name one.

See [expose a source](/guide/first-party-sources#browser-control).

## 0.8.1

- The audit records **which transport shape** an invoke actually used.

## 0.8.0 — long calls stop blocking, and the console says more

- **Async invoke handles.** A capability that takes minutes returns a handle immediately instead
  of holding the connection; the agent picks the result up when it is ready.
- **An Activity summary band** in the console — what has been happening, at a glance.
- **Failure output from sandboxed runs is redacted** before it reaches an agent.
- **Agent-protocol hardening:** denials now carry enough for an agent to correct itself without
  guessing, rather than needing an oracle.

## 0.7.0 — first public release

The release the project opened with: the trust model settled, and enough real sources on the
machine to be worth connecting an agent to.

- **Your personal data, as first-party sources.** Apple Notes, Mail, Contacts, Photos and
  Shortcuts joined Calendar and Reminders, alongside read-only browser tabs/bookmarks/history
  and Obsidian search + append.
- **An agent sees only the subset you authorized.** Discovery stopped broadcasting a catalogue:
  what an agent can scan *is* what its owner granted it, and a request from outside that subset
  is denied outright rather than pended for you to rubber-stamp.
- **Side-effecting capabilities are per-use by default.** Selecting a `write` or `execute` at
  connect no longer makes it standing — each call asks. Standing is a deliberate, per-capability
  opt-in, off by default and double-confirmed.
- **Sessions fail closed**, and a revoke is a complete stop rather than a delayed one.
- **Four ways to install an agent**, including an in-context form for agents with no filesystem
  and no shell — plus quick starts that walk the whole loop end to end.
- **Coding agents run in their own native sandbox** rather than a second one wrapped around it.

## Before 0.7

The build-up, in one paragraph each.

- **0.6.0-rc.1** — the first public release candidate: the desktop/runtime redesign, the
  unified authorization and trust model, the *What I expose* view built on
  Connector → Source → Capability, the first Apple sources, and per-source health.
- **0.4.0** — capability sources became **managed**: add, enable, reconfigure and remove them
  live from the console or the CLI, with no flags and no restart. Reconfiguring a source's
  security surface purges its grants.
- **0.3.x** — Claude Code and Codex integrations, so mainstream coding agents could actually
  use what Plexus exposes; Obsidian read-**write** through Obsidian's own Local REST API.
- **0.2.x** — the extension ecosystem: a published manifest spec, user-authored skills and
  workflows, and a first run on macOS that gets you from install to a connected agent.
- **0.1.x** — the gateway itself, the M0 protocol contract, and the decision everything since
  rests on: a **human-in-the-loop authorizer by default**, so an agent can never self-grant a
  write or an execute.
