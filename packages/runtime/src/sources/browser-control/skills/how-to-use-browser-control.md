# How to use `browser-control`

You can drive a real browser: list tabs, navigate, wait, read the page, list what you can act
on, scroll, click, type, screenshot.
Plexus decides **which sites** you may touch; the browser decides nothing.

## The one rule that explains every refusal

**Only origins the owner authorized are reachable.** Not "mostly" — an unlisted origin is
refused, and a tab on an unlisted origin is neither listed nor addressable. If
`browser-control.tabs.list` comes back empty, the owner has authorized no sites yet. Ask them;
you cannot widen it yourself, and retrying will not help.

Refusals name the origin you asked for. They do **not** list the authorized sites — that is
deliberate, so a denial can't be used to map what else the owner allows.

## Two modes — check which one you are in

`browser-control.tabs.list` returns `mode`:

- **`launch`** — a browser Plexus started, with its own profile. **No cookies, no logged-in
  sessions.** Anything requiring a login will show you a login wall, and that is correct
  behavior, not a bug to work around.
- **`attach`** — the owner's own Chrome, with their real sessions. Pages may be authenticated.
  Treat everything you see as the owner's private data.

## The loop

```
tabs.list        → see what you may drive, and pick a targetId (or omit it for your own tab)
page.navigate    → go somewhere (execute — usually waits for the owner's approval)
page.wait        → on an app that renders late, wait for what you need before reading
page.read        → SEE what is actually there
page.elements    → the things you can ACT on, each with a selector that works
page.scroll      → reach the rest of a long page, or load more of a lazy list
page.click/type  → act on what you saw
page.read        → confirm what changed
```

**Read before you act, and read again after.** Selectors you invent without looking are the main
way this goes wrong.

**`read` and `screenshot` only see the viewport.** A page that looks short is usually a page you
have not scrolled. `scroll` reports `atBottom`, so a loop knows when it has seen everything; a
whole-page image is `screenshot` with `fullPage`.

**Never invent a selector.** `page.read` returns rendered text, and a form field has no rendered
text — you will see the label "Email" and nothing that tells you the field is `input[name=em]`.
Call `page.elements` and use the selector it hands you. Call it again after filling to confirm the
values are really in the fields; `type` reports whether the field accepted the value, but it does
not echo the value back.

**An empty read is usually an early read.** On an app that renders after load, `wait` for a
selector or a string first. `wait` returns `found:false` on timeout instead of failing, so you
can decide whether to keep waiting. `navigate` and `click` both report the URL they ended on — check it: a
redirect can land somewhere else, and if it leaves the authorized origins you will be told rather
than silently followed.

## Input shapes

```json
{ "id": "browser-control.page.navigate", "input": { "url": "https://example.com/docs" } }
{ "id": "browser-control.page.read",     "input": {} }
{ "id": "browser-control.page.click",    "input": { "selector": "button[type=submit]" } }
{ "id": "browser-control.page.type",     "input": { "selector": "#search", "text": "plexus" } }
{ "id": "browser-control.page.elements", "input": { "within": "form" } }
{ "id": "browser-control.page.scroll",   "input": { "to": "bottom" } }
{ "id": "browser-control.page.wait",     "input": { "selector": "[data-loaded]", "timeoutMs": 8000 } }
{ "id": "browser-control.page.screenshot", "input": { "fullPage": true } }
```

Every page op takes an optional `targetId` from `tabs.list`. Omit it and you get the tab Plexus
opened for you — which is the polite default in `attach` mode, since it leaves the owner's own
tabs alone.

## Approvals

`navigate`, `click` and `type` are **execute** capabilities: unless the owner pre-authorized them
for your connection, **each call waits for a human decision**. Issue the call and wait. Reads
(`tabs.list`, `page.read`, `page.elements`, `page.screenshot`, `page.scroll`, `page.wait`) are
ordinary reads —
moving the viewport or waiting does nothing on the site's behalf.

## Never type a secret

Do not put passwords, card numbers, or one-time codes into `page.type`. Nobody is watching every
call, and a page is not a safe place to put the owner's credentials. If a task needs a login,
say so and stop — in `attach` mode the owner is probably already signed in anyway.

## There is no "run JavaScript"

Deliberately. Arbitrary evaluation would make the origin boundary decorative, because a page can
reach anywhere its own origin allows. Work through the tools above.
