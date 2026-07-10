# How to use browser (read-only)

The `browser` source is a **strictly read-only** window onto the user's browsers —
**Safari** and **Google Chrome** — on this Mac. It exposes three capabilities; none of
them can open, close, navigate, bookmark, or delete anything. History databases are only
ever **copied** to a temp path and read there, so a running browser is never touched.

## Bounded results

Every search is bounded: `limit` defaults to **20** and is hard-capped at **200**. Ask
for a small `limit` and narrow your `query` instead of paging through everything. History
comes back **newest first** with `lastVisited` as **ISO-8601 UTC** (already converted from
Chrome's WebKit-epoch microseconds and Safari's Core-Data-epoch seconds).

## Per-browser degradation (read this once)

Results are **merged** from both browsers, and every result carries a `browsers` field:

```json
{ "browsers": {
    "safari": { "status": "ok" | "unavailable", "count": 3, "note": "…" },
    "chrome": { "status": "ok" | "unavailable", "count": 5, "note": "…" } } }
```

- **Partial results are normal.** One browser being `unavailable` never breaks the other:
  the call still returns `ok:true` with the reachable browser's rows.
- A browser that is **not installed** or **not running** (tabs) is `status:"ok"` with an
  explanatory `note` and zero rows — that is not an error.
- `status:"unavailable"` carries the reason in `note`. The common one: Safari bookmarks
  and history live under `~/Library/Safari`, which macOS protects — the owner must grant
  Plexus **Full Disk Access** in **System Settings › Privacy & Security › Full Disk
  Access**. Relay that note to the user; do not retry in a loop.
- Listing tabs needs per-browser **Automation** approval (System Settings › Privacy &
  Security › Automation) — a denial shows up as that browser's `note`, same pattern.

## Capabilities

### `browser.tabs.list` — what is open right now
Input: `{}` (no arguments).
Returns `{ tabs: [{ browser, window, title, url }], browsers }` — every open tab in every
window of both browsers (`window` is 1-based per browser). Use when the user says "that
page I have open", to resume in-progress research, or to ground an answer in what the
user is currently reading.

### `browser.bookmarks.search` — saved links
Input: `{ query: string, limit?: number }` — `query` is a required, case-insensitive
substring matched against bookmark **title or url**.
Returns `{ bookmarks: [{ browser, title, url, folder }], browsers }` (`folder` is the
"/"-joined folder path). Use when the user asks "did I bookmark…" or you need a saved
link known roughly by name or domain. Example: `{ query: "sqlite", limit: 10 }`.

### `browser.history.search` — what was visited, and when
Input: `{ query: string, start?: ISO date, end?: ISO date, limit?: number }` — `query`
required; `start`/`end` optionally bound the visit time (inclusive; `end` must be after
`start`). Compute dates from the current date you were given.
Returns `{ visits: [{ browser, title, url, lastVisited }], browsers }`, newest first.
Use when the user asks "what was that site I visited last week…" or to reconstruct what
was read and when. Example: `{ query: "recipe", start: "<7 days ago, ISO>", limit: 10 }`.

## Typical flow
1. `browser.tabs.list {}` — what is the user looking at right now?
2. `browser.bookmarks.search { query: "…" }` — did they save it?
3. `browser.history.search { query: "…", start: "…" }` — did they visit it, and when?

Always check `browsers.*.status` before concluding "not found": an empty list with a
`note` means that browser could not be read, not that the data does not exist.
