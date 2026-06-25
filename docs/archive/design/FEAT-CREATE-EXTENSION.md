# Plexus — Create an Extension — FEATURE DESIGN (grounded)

> Status: **implemented (v1)** · Date: 2026-06-25
> Companion to the design-only [`FEAT-EXTENSION-AUTHORING.md`](./FEAT-EXTENSION-AUTHORING.md)
> (the "用嘴造扩展" north-star journey) and the [`../extensions/EXTENSION-SPEC.md`](../extensions/EXTENSION-SPEC.md)
> (the full manifest spec). This doc is the **implementation contract**: the exact
> endpoints, CLI, and authoring surface that ship for v1. It does NOT reinvent the
> registration engine — it wires a thin **management surface** over the primitives
> that already exist.

---

## 1. What an extension is

An extension is a **runtime-registered connector**: an [`ExtensionManifest`](../../packages/protocol/src/types.ts)
(`manifest:"plexus-extension/0.1"`) that declares a `source` and the capability
entries it contributes (`ExtensionCapabilityDecl[]`). The gateway **materializes** it
into the same governed, default-denied, audited capability registry a first-party
source lives in. Nothing about an extension grants access — installing it makes the
caps *discoverable*; they stay dark until a human issues a grant.

The registration primitives already exist and are REUSED, not reinvented:

| Primitive | Where | Role |
| --- | --- | --- |
| `registry.validateRegistration(manifest)` | `core/capability-registry.ts` | default-deny validation: shape, first-party-id reservation, cross-source-attach gate, workflow graph. Returns `{ ok, reasons[], crossSourceProvenance }`. PURE — no commit. |
| `buildRegisterSurface(manifest, crossSourceProvenance)` | `core/register-surface.ts` | PURE projection of the security-sensitive surface (cli bins, rest hosts, cross-source attaches, verbs, transportBacked). |
| `registry.registerExtension(manifest)` | `core/capability-registry.ts` | the COMMIT — re-validates, materializes, bumps revision, emits `manifest_changed`. |
| `registry.unregister(source)` | `core/capability-registry.ts` | remove the contributed ids; grants purged so a re-register must be re-confirmed. |
| `POST /extensions` (agent/wire) | `core/handlers.ts` | the agent path: validate → transport-backed PENDS for a human (`makeRegisterPending`), else commit. |

---

## 2. The authoring contract

A valid manifest is `{ manifest, source, label, transport, capabilities[], secrets?, serviceHint? }`.
Each `ExtensionCapabilityDecl` is `{ name, kind, label, describe, io?, grants, transport, route?, body?, members? }`.

**Per-transport `route` requirements** (read only by the owning transport; never by core):

- **cli** — `route.bin` (bare binary name, no path/shell) + `route.args` (argv template
  with `{placeholders}`) + the user-confirmed `allowedBins` allow-list. The #2 RCE surface.
- **local-rest** — `route.baseUrl` (MUST be loopback, `127.0.0.1`/`localhost`) +
  `route.allowedHosts` + an attached `secrets[]` ref (`attach: bearer|header|query|env`).
  The #3 SSRF / secret-redirect surface.
- **skill** — `body: { format:"markdown", markdown }`. Pure guidance, no transport.
- **workflow** — `members[]` resolving to present entries (cross-source attach OFF by default).

**Security surface** (what the human approves): the set of **cli bins** an extension may
spawn, the **non-loopback rest hosts** it may reach, the **cross-source** skill attaches
(prompt-injection channel), the **verbs** each cap requires, and whether it is
**transport-backed**. `buildRegisterSurface` computes exactly this.

The full, worked authoring guide an agent reads is `docs/extension-authoring.md`,
served live at **`GET /admin/api/extensions/authoring-guide`**.

---

## 3. The agent-authoring story ("用嘴")

"用嘴造扩展" = the natural-language drafting happens **inside an external agent**
(codex / Claude Code), not in-app. The local Plexus's job is to (1) **publish the
authoring contract** an agent can follow (the served guide + the manifest types),
(2) expose a **machine API** the agent drives (`/admin/api/extensions/preview` then
`/admin/api/extensions`), and (3) give the human a **preview + approve** surface.

Flow: the user talks to the agent → the agent fetches the authoring guide → drafts a
manifest → **previews** it (no commit) and shows the human the surface → on the human's
say-so **installs** it. The human is the connection-key holder, so an install through
the admin surface is the *trusted/approved-by-human* path (it commits directly); the
agent/wire `POST /extensions` path still PENDS. **In-app NL drafting is deferred** (v1
keeps the drafting in the agent — Plexus stays the governed registry + preview/approve).

---

## 4. Install / preview / approve lifecycle

```
            ┌── agent/wire path (POST /extensions) ──────────────┐
            │  validate → transport-backed? → PENDING (human      │
            │  approves via POST /admin/api/pending/:id) → commit │
            └─────────────────────────────────────────────────────┘

            ┌── admin/human path (this feature) ─────────────────┐
 preview ── │  POST /admin/api/extensions/preview                 │  no commit
            │     → validateRegistration + buildRegisterSurface   │
 install ── │  POST /admin/api/extensions                         │  commit
            │     → validate → registerExtension → audit          │  (human IS approver)
 remove  ── │  DELETE /admin/api/extensions/:source               │  unregister + purge
            └─────────────────────────────────────────────────────┘
```

The admin path is mgmt-key gated (same gate as `/admin/api/sources`). Because the
local user (connection-key authenticated, same-origin, loopback-only) **is** the human
approver, the admin create commits directly and audits `source.install` —
no self-pend. (The agent/wire path is the untrusted one and still pends.)

### Endpoint contracts (as built)

**`POST /admin/api/extensions/preview`** — `{ manifest }` →
```jsonc
{ ok, valid, reasons: string[],
  surface: { source, label,
             capabilities: {id,label,kind,transport,verbs}[],
             cliBins: string[], restHosts: string[],
             crossSource: {id,sources}[], transportBacked } | null }
```
`valid:false` + `reasons[]` when validation rejects (surface is computed best-effort, else `null`).

**`POST /admin/api/extensions`** — `{ manifest }` →
`{ ok, source, registered: string[], revision, reason? }`. Validates → commits live →
audits `source.install` (outcome `committed`). On validation failure: `ok:false` + `reason`, **no commit**.

**`DELETE /admin/api/extensions/:source`** → `{ ok, source, removed: string[] }`
(unregister + grant purge), mirroring `DELETE /extensions/:source`.

**`GET /admin/api/extensions`** → `{ extensions: { source, label, capabilities: string[] }[], revision }` —
the live registry sources whose provenance is `extension` (read; mgmt-key gated like `GET /api/sources`).

**`GET /admin/api/extensions/authoring-guide`** → the markdown authoring guide (text/markdown).

---

## 5. CLI surface — `plexus extension <sub>`

A thin HTTP client over the admin API (connection-key from `~/.plexus/connection-key`,
mirroring `plexus source`). Never imports the gateway:

- `plexus extension preview <manifest.json>` → POST preview; pretty-prints valid/reasons + surface.
- `plexus extension add <manifest.json>` → POST admin create; prints registered ids.
- `plexus extension list` → GET extensions; lists extension-provenance sources.
- `plexus extension remove <source>` → DELETE admin extensions.

---

## 6. Admin UI surface (built separately)

The UI agent builds against the **pinned** preview-response contract in §4. The intended
surface: a "Create / author an extension" affordance that takes a manifest (pasted, or
handed off from an agent), calls **preview** to render the security surface (cli bins /
rest hosts / cross-source / verbs), and on the human's approval calls **create**. Live
extensions list + remove hang off `GET`/`DELETE /admin/api/extensions`.

---

## 7. v1 scope vs future

**v1 (shipped here):** preview (no commit), admin create (human-approved commit + audit),
admin delete, list, the served authoring guide, the CLI. Drafting lives in the agent.

**Future:** in-app NL drafting (R2 "用嘴" launch of a cc/codex loaded with an authoring
skill, surfaced under WHAT I EXPOSE — see `FEAT-EXTENSION-AUTHORING.md`); a richer install
review UI; signed/versioned manifests; per-extension trust windows.
