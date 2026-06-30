---
name: how-to-use-calendar
description: How to read the user's Apple Calendar (calendars + events) read-only through Plexus. Use when you have been granted apple-calendar.calendars.list and/or apple-calendar.events.list and need to answer scheduling questions.
---

# How to read Apple Calendar (read-only)

This source exposes the user's **macOS Apple Calendar** as two **read-only**
capabilities. They read live data from Calendar.app via a fixed, gateway-owned
AppleScript/JXA bridge — there is **no** write, edit, or delete path.

## The two capabilities

### `apple-calendar.calendars.list`
Lists the **names** of the user's calendars. Takes **no input**. Returns:

```json
{ "calendars": ["Home", "Work", "Birthdays"] }
```

### `apple-calendar.events.list`
Lists events overlapping a **date window**. Input is **required**:

```json
{ "start": "2026-06-23T00:00:00Z", "end": "2026-06-30T00:00:00Z" }
```

> ⚠️ **The dates above are illustrative only — do NOT copy them.** Always compute the
> window from the **current date/time provided to you**, in the user's local timezone.
> This example is not "today"; treating it as today will produce wrong results.

- `start` and `end` are **ISO-8601** date/time strings.
- `end` must be **after** `start`, and the window must be **≤ 60 days**
  (a larger window is rejected with an `invalid_input` error — split it up).
- Optionally pass `calendar` (a name from `calendars.list`) to filter to one calendar.

Returns:

```json
{
  "events": [
    {
      "title": "Team sync",
      "start": "2026-06-24T15:00:00.000Z",
      "end": "2026-06-24T15:30:00.000Z",
      "calendar": "Work",
      "location": null,
      "notes": null
    }
  ]
}
```

`location` and `notes` may be `null` when the event has none. (The dates in the
example above are placeholders that illustrate the response shape — they are not real
or current events.)

## Recommended workflow

1. Call `apple-calendar.calendars.list` to see which calendars exist.
2. Call `apple-calendar.events.list` with the window the user asked about
   (keep it ≤ 60 days). Cite events by **title + calendar + start time**.

## Handling "Calendar access not granted" (TCC)

The first time Plexus reads Calendar, macOS gates it behind a privacy prompt.
If a call fails with `transport_error` and a message containing
**"Calendar access not granted"** (detail `reason: "not_authorized"`), do **not**
retry in a loop. Instead, tell the user to grant access once:

> System Settings → Privacy & Security → **Automation** → enable Plexus's control
> of **Calendar**, and (if listed) Privacy & Security → **Calendars** → enable Plexus.

After the user approves, the same call will succeed. The source's HEALTH also
reflects this: it shows **unavailable** with this reason until access is granted.

## What you CANNOT do

Both grants are `["read"]` only. There is **no** create-event, edit, move, or
delete path — none exists in the gateway. Do not promise the user you can add or
change calendar entries through this source.
