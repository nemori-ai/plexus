# Plexus Browser Control — Chrome extension

The third way a Plexus gateway can reach a browser, and the only one whose consent is durable.

## Why this exists

Both of the other routes go through a DevTools port, and that port has two properties an owner
feels every day:

- Chrome **refuses `--remote-debugging-port` on the default profile** (since M136), so that route
  cannot reach the browser you are actually logged into at all;
- the `chrome://inspect` toggle can, but Chrome asks permission on **every new connection** and
  offers no "always allow", so you dismiss a dialog to start each gateway.

`chrome.debugger` has neither problem: granted **once** at install, works on your normal profile,
and exposes the same CDP 1.3 surface. This is the shape Codex and Claude both ship.

## What this extension is — and is not

It is a **transport**. It holds no allowlist, no approval logic, and no idea which sites an agent
may touch.

That is deliberate. Other agent extensions place their safety in the agent's own instructions —
"treat pages as untrusted", "confirm before transmitting". That is a rule the agent can be argued
out of by the very page it is reading. Plexus decides in the **gateway**: the origin gate,
per-use approval and the audit all run before a command is handed to this extension, where a page
cannot reach them. A second, weaker copy of those rules here would only create somewhere for them
to disagree.

What it *does* own is the part only the browser knows: which tabs exist, and keeping the agent's
own tabs in their own group so your windows are not rearranged under you. It closes only tabs it
opened itself.

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this directory.
2. Start a gateway with `PLEXUS_BROWSER_CONTROL_MODE=extension` and the domains an agent may
   reach, e.g. `PLEXUS_BROWSER_CONTROL_ORIGINS=github.com`. An empty list refuses everything —
   this drives your own logged-in browser, so unset means inert, not open.
3. Click the extension's icon and paste the gateway's socket URL
   (`ws://127.0.0.1:<port>/browser-extension`) and its pairing token. The token is minted by the
   gateway and stored at `<PLEXUS_HOME>/browser-extension-token`; it is **not** the
   connection-key, which stays admin-only and never enters a browser.

The badge is green when paired, `·` when the gateway is not running, `!` when the token was
rejected.

## Permissions, and why each is here

| permission | why |
|---|---|
| `debugger` | the CDP surface itself — the same protocol the other transports speak |
| `tabs` | enumerate tabs so the gateway can filter them by the owner's domains |
| `tabGroups` | keep agent tabs in their own labelled group, out of your way |
| `storage` | remember the gateway URL and pairing token locally |
| `<all_urls>` | `chrome.debugger` attaches per tab; Chrome scopes this at the browser, not per site — which is exactly why the **gateway** enforces the per-domain boundary |
