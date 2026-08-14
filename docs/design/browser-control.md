# Browser control — the technical plan

> Status: **plan, pending owner review.** The read-only `browser` source (tabs / bookmarks /
> history) is unrelated and unchanged; this is a new, execute-class source.

## What the research settles

**Chrome no longer needs an extension to be attached to.** Since **M144** a external process can
request a remote-debugging session against the user's *already running* Chrome: the user enables
it once at `chrome://inspect/#remote-debugging`, and thereafter **Chrome itself shows a permission
dialog per connection** and displays the "Chrome is being controlled by automated test software"
banner for the life of the session. M146 adds a settings toggle. The machine this is being built
on runs **Chrome 151**, so the flow is available today, on stable.

That kills the main reason to ship a browser extension. An extension (plus a native-messaging
host to reach it) is a large surface to build, sign, distribute and keep alive, and it would
duplicate a consent flow Chrome now owns. Its one *remaining* advantage is picking individual
tabs without enabling global remote debugging — recorded as a seam below, not built.

**Chrome's consent is all-or-nothing.** The permission dialog authorizes *the browser*, not a set
of sites. Chrome exposes no per-tab or per-origin scoping. So the boundary the owner actually
wants — "this agent may touch GitHub tabs, nothing else" — cannot come from Chrome.

It has to come from Plexus. Which is the whole point of Plexus.

## The shape

One source, `browser-control`, and **one capability surface**. The two modes differ only in
where the CDP endpoint comes from:

| mode | endpoint | what the agent can reach |
|---|---|---|
| **`launch`** (default) | Plexus spawns Chrome with `--remote-debugging-port` on an **ephemeral port** and a **separate `--user-data-dir`** | a clean profile — no cookies, no logged-in sessions |
| **`attach`** (owner opt-in) | the user's running Chrome, gated by Chrome's own dialog | **every session that browser is logged into** |

`launch` is the safe default and covers ordinary "go read this page" work. `attach` is the sharp
one and is an explicit owner decision, exactly like `Real launch` on the exec sources.

**No new dependency.** CDP is JSON over a WebSocket; Bun has both `fetch` and `WebSocket` natively.
Puppeteer/Playwright would each drag in a browser download and a large dependency tree to give us
an ergonomics layer we do not need for a handful of tools.

## The boundary — the part that is ours

Every call resolves to a **target URL**, and the source enforces an owner-set **origin allowlist**
against the URL that will actually be acted on — parsed server-side from the real target, never
from a field the agent declares. Two rules make it hold:

1. **Empty allowlist denies everything.** The allowlist is not "unset ⇒ open"; unset means the
   capability is inert. Fail closed is the default, not a setting.
2. **In `attach` mode the tab's CURRENT origin is re-checked before every act.** A tab that was
   allowed when it was on `github.com` is not allowed after it navigates to `mail.google.com`.

This composes with, and does not replace, the existing `ScopeConstraint` machinery: an owner can
narrow a grant further per agent (`{field:"url", op:"prefix", …}`), enforced at the same single
invoke chokepoint, fail-closed. The source-level allowlist is the floor; a constraint can only
subtract.

## Verbs and sensitivity

| capability | verb | note |
|---|---|---|
| `browser.control.tabs` | read | which targets are controllable, origin-filtered |
| `browser.control.read` | read | page title/url + a text/a11y snapshot of the current page |
| `browser.control.screenshot` | read | viewport image |
| `browser.control.navigate` | execute | the origin gate's primary subject |
| `browser.control.click` / `.type` | execute | act on a snapshot-returned element ref |

`execute` means per-use approval by default (ADR-5) — the agent cannot lift it. Under `attach`
even the `read` verbs are high-sensitivity, because the page may be an authenticated one.

Deliberately **not** in v1: arbitrary JavaScript evaluation. It would make every other boundary
here decorative.

## Honest risk

`attach` mode is the sharpest thing Plexus would expose: it reaches the user's authenticated
web. That risk is inherent to the feature, and the mitigations are the reason to route it through
Plexus rather than let an agent hold the CDP socket directly — owner opt-in, a fail-closed origin
allowlist enforced on the real URL, per-use approval on every mutating verb, the whole call
audited, plus Chrome's own dialog and its visible automation banner.

The residual that no design here removes: anything reachable *without* re-authentication inside an
allowed origin is reachable by an approved call. The allowlist bounds which sites, not which pages
within a site.

## Seams, not built

- **A Chrome extension** for per-tab selection without global remote debugging, and for
  Codex-style "allow this site for this chat only" prompts driven from the browser UI.
- **Origin-scoped `ScopeConstraint` op** (`op:"origin"`) so URL narrowing stops relying on
  `prefix` string matching, which is defensible with a trailing slash but is not an origin check.
- Firefox / WebKit: CDP is Chromium-only; another engine means another client.
