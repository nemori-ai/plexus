---
name: how-to-use-photos
description: How to read the user's Apple Photos library (albums, metadata search, single-item export into a confined directory) through Plexus. Use when you have been granted apple-photos.albums.list, apple-photos.search, and/or apple-photos.export.
---

# How to use Apple Photos (read-only)

This source exposes the user's **macOS Photos.app** library through three
capabilities, all `["read"]`. They go through a fixed, gateway-owned
osascript/JXA bridge — there is **no** path that edits, deletes, or adds to the
photo library.

## The three capabilities

### `apple-photos.albums.list`

Lists albums and top-level folders (with one level of child albums), each with an
item count. Takes **no input**. Returns:

```json
{
  "albums": [{ "id": "alb-…", "name": "Vacation 2026", "itemCount": 3 }],
  "folders": [{ "id": "fld-…", "name": "Family", "albums": [ … ] }],
  "truncated": false
}
```

At most **200 albums/folders per level** are returned (`truncated: true` when cut
off). An `itemCount` of `-1` means the count could not be read.

### `apple-photos.search`

Finds media items by **metadata only**. Input (all fields optional):

```json
{
  "album": "Vacation 2026",
  "start": "2026-06-01T00:00:00Z",
  "end": "2026-06-30T23:59:59Z",
  "query": "img_00",
  "limit": 20
}
```

> ⚠️ The dates above are illustrative — **compute real dates from the current
> date/time you were given**, never copy the example.

- `album` — an album name from `albums.list`. **Strongly preferred**: an unscoped
  search over a library with more than **5000 items** is rejected with a
  "too many items to scan" error; scope with `album` and retry.
- `start` / `end` — ISO-8601 inclusive bounds on the **capture date**.
- `query` — case-insensitive **substring** matched against the filename and
  keywords/tags.
- `limit` — max results, **default 20, max 100**.

Returns:

```json
{
  "items": [
    {
      "id": "9C1B…/L0/001",
      "filename": "IMG_0001.HEIC",
      "date": "2026-06-20T10:15:00.000Z",
      "width": 4032,
      "height": 3024,
      "favorite": true
    }
  ],
  "scanned": 3,
  "truncated": false
}
```

`truncated: true` means more items matched than `limit` allowed — narrow the
filters or raise `limit` (≤ 100).

#### What search CANNOT do (be honest with the user)

The scripting bridge exposes **metadata only**. There is **no ML/content
search**: you cannot find "photos of dogs", faces, places, or scene content.
If the user asks for content-based search, say so plainly and offer what IS
possible: album, date range, filename/keyword substring, favorite flag.

### `apple-photos.export`

Exports **exactly one** media item by id and returns its absolute file path:

```json
{ "id": "9C1B…/L0/001" }
```

Returns:

```json
{ "path": "/Users/…/.plexus/exports/photos/export-…/IMG_0001.HEIC", "filename": "IMG_0001.HEIC" }
```

**Disk side effect, stated plainly:** this writes one file — and it can ONLY
land inside the gateway-owned jail directory `~/.plexus/exports/photos/`
(created if missing; a fresh subdirectory per export). It never writes anywhere
else and never modifies the Photos library, which is why the grant is `read`.
The exported file is the current/rendered version, not the RAW original. Ids
must come from `apple-photos.search` — path-shaped ids are rejected. Large
videos may take a while (the export has a 120 s timeout).

## Recommended workflow

1. `apple-photos.albums.list` — see how the library is organized.
2. `apple-photos.search` scoped by `album` (plus date/`query` filters) — get ids.
3. `apple-photos.export` with ONE id — only when the user actually needs the file.

Keep result sets small: default `limit` is 20 for a reason. Enumerating a huge
library through the scripting bridge is slow; every call here is hard-capped and
timeout-killed rather than left to hang.

## Handling "Photos access not granted" (TCC)

The first live call gates on a macOS privacy prompt. If a call fails with
`transport_error` and a message containing **"Photos access not granted"**
(detail `reason: "not_authorized"`), do **not** retry in a loop. Tell the user
to grant access once:

> System Settings → Privacy & Security → **Automation** → allow Plexus (or its
> host terminal) to control **Photos** — and, if listed, Privacy & Security →
> **Photos** → Full Access.

After approval the same call succeeds. The source's HEALTH shows
**unavailable** with this reason until access is granted.

## What you CANNOT do

All grants are `["read"]`. There is **no** create, edit, tag, favorite, album-add,
or delete path — none exists in the gateway. Do not promise the user you can
change their photo library through this source, and do not present the export
jail as a general-purpose file-write ability — it only materializes photo
exports under `~/.plexus/exports/photos/`.
