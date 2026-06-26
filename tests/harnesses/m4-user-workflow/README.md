# m4-user-workflow — authoring a dynamic workflow by composition

The user-facing worked path for **Plexus M4 dynamic workflows**
([`docs/archive/extensions/USER-AUTHORING-DESIGN.md`](../../docs/archive/extensions/USER-AUTHORING-DESIGN.md)
§B, [`EXTENSION-SPEC.md`](../../docs/extensions/EXTENSION-SPEC.md) §12.3). A user
**composes two existing capabilities** into a **new `kind:"workflow"` capability**,
exposed via self-describe — using only the shipped mechanism (`WorkflowTransport`
re-entrancy, `TransitiveGrant` synthesis, register-time anti-cycle / member
validation, the human-confirm register flow). No new wire, no core branching.

## Run it

```bash
bun run tests/harnesses/m4-user-workflow/run.ts
```

Boots a real gateway (loopback socket) + a tiny loopback "journal" service, then
drives the agent client through the worked path and prints a PASS/FAIL transcript.

## The composition

`manifest.ts` is the authoring artifact — a plain `ExtensionManifest` declaring two
member capabilities (over the `local-rest` transport, pointed at the loopback journal
service) and a workflow composing them. Co-declared so the members resolve to
**present** entries in one `scan()` (§12.3 ordering rule):

| id | kind | grants | what |
|---|---|---|---|
| `journal.entry.append` | capability | `write` | `POST /entry` — append a line (mutation) |
| `journal.log.list` | capability | `read` | `GET /entries` — read the log back |
| `journal.note.log` | **workflow** | `write` | composes `[append(write), list(read)]` |

## The worked path (all through the real gateway)

1. **Compose + Register** — the agent `POST /extensions`. The manifest is
   transport-backed (`local-rest`), so after `validateRegistration` passes it **pends
   for a human** (`grant_pending_user`). An unapproved register does **not** activate.
2. **Approve** — a background driver **models the user clicking "Approve"** in the
   management client (it polls the same shared pending store the admin panel reads).
   Only then does the commit run; the workflow becomes discoverable via self-describe.
3. **Grant** — the agent grants `journal.note.log` (`write`). The gateway
   **synthesizes** the transitive member scopes (`append/write` + `list/read`),
   surfaces them, and stamps them `synthesizedFor` into the token.
4. **Invoke** — the granted invoke **fans out via the `WorkflowTransport`**: a real
   `POST` then a real `GET`, each re-entering the uniform invoke pipeline. **Honest
   green:** we read the journal service's *own* state back (the append really ran) and
   a direct `journal.log.list` invoke returns the appended line — the real composed
   result, not a trusted `ok`.

## Guards (real rejections)

- **Dangling member** (`danglingMemberManifest`) — a workflow naming a phantom member
  id → **rejected** at register (no transitive-grant / dispatch target).
- **Cycle** (`cyclicWorkflowManifest`) — two workflows referencing each other (A→B→A)
  → **rejected** by the global anti-cycle walk (the fan-out would otherwise recurse).
- **No over-grant** — the synthesized scopes are *exactly* the member scopes; granting
  the workflow grants no authority beyond its declared members (asserted in the demo).

## Files

- `manifest.ts` — the valid composition + the two guard manifests (the authoring inputs).
- `server.ts` — the loopback journal service the members reach (the real backend).
- `demo.ts` — the runnable engine; returns a structured report the tests assert against.
- `run.ts` — `bun run` entrypoint (real loopback socket).

## Tests

- `tests/m4-user-workflow-path.test.ts` — the full worked path end-to-end (real fan-out).
- `tests/m4-user-workflow-guards.test.ts` — the register-time guards, asserted directly
  against the registry's pure `validateRegistration` seam.
