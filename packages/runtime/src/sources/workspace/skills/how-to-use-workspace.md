# How to use the Workspace

Plexus exposes ONE authorized directory on the user's machine as a path-confined
**workspace** — list, read, and write files **inside that directory only**. Every
path you pass is resolved relative to the workspace root and is **rejected** if it
tries to escape (a `..` traversal, an absolute path, or a symlink that points
outside). You can never see or touch anything outside the authorized directory.

## Read & list (lightweight)

- **`workspace.list`** (read) — list a directory inside the workspace.
  Input: `{ path? }` (workspace-relative; omit or `""` to list the root).
  Returns `{ type: "dir", relativePath, entries: [{ name, relativePath, kind }] }`.
- **`workspace.read`** (read) — read a file inside the workspace.
  Input: `{ path }` (workspace-relative, e.g. `"refs/notes.md"`).
  Returns `{ type: "file", relativePath, content, bytes, modifiedAt }`.

Both are READ-ONLY and path-confined. Reads are auto-granted (lightweight) — no
human approval is needed.

## Write (mutating → PENDS for the owner)

- **`workspace.write`** (write) — write/overwrite a file inside the workspace.
  Input: `{ path, content }` (workspace-relative path + UTF-8 text body).
  Returns `{ ok, relativePath, bytes }`.

`workspace.write` requires a **write** grant. On a first-party source, a write grant
**PENDS for the owner's approval** — when you call it, Plexus returns "pending" and
the helper polls until the owner approves (or rejects) in the Plexus UI. **You CANNOT
self-approve; you wait.** Plan for the pause: write the file, then continue once the
approval lands.

## Etiquette

- Always use workspace-relative paths (e.g. `"PRD.html"`, `"src/app.js"`). Never an
  absolute path — it will be denied.
- Prefer listing/reading first so you write to the right place and don't clobber
  files you didn't mean to.
- Parent directories are created as needed on write; the write still cannot escape
  the authorized directory.
- There is no delete/rename/execute capability here by design — the surface is
  intentionally just list + read + write, all confined to one folder.
