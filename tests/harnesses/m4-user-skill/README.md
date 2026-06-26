# M4 — User custom-skill authoring (worked path)

A user attaches their **own** usage skills (`kind:"skill"`) to capabilities so an
**agent discovers them as context**. This is Plexus's headline value over raw MCP:
MCP gives you a tool `description`; Plexus lets the *user* layer "how to use me well"
onto a capability — including a capability they did **not** write.

It is just an `ExtensionManifest` carrying `kind:"skill"` entries, registered through
the **same** `POST /extensions` / `registerExtension` path as any extension
(`EXTENSION-SPEC.md` §9). There is no second mechanism. A skill carries `grants:[]`,
`transport:"skill"`, and a `body` — it adds **zero authority** (read-as-context,
never invocable), which is what makes authoring it safe.

## Run it

```bash
bun run tests/harnesses/m4-user-skill/run.ts
```

Boots a real gateway on a free loopback port, registers the first-party
`obsidian.vault.read` (the existing capability a user skill will teach
cross-source), then drives a real `PlexusClient` (the published wire) through the
worked path and prints a PASS/FAIL transcript. Exits 0 iff every check passes.

## The two attach shapes (USER-AUTHORING-DESIGN §A.3)

### (a) Same-source — applied freely

The author teaches their **own** capability. The skill is declared in the same
manifest as the capability and back-linked via `route.attachSkills`:

```jsonc
{
  "name": "snippets.read", "kind": "capability", /* … */
  "route": { "bin": "snipcat", "args": ["{name}"],
             "attachSkills": ["snippets.how-to-search"] }   // ← same-source back-link
}
```

No cross-source trust boundary is crossed (you can only teach what you own), so
`manifestEntries()` wires the `entry.skills[]` back-link **unconditionally** — no
gate, no human. The skill is discoverable both as a standalone `kind:"skill"` entry
**and** from the capability it teaches.

### (b) Cross-source — DEFAULT-OFF, gated, provenance-stamped

The author teaches an **existing capability owned by another source** (here the
first-party `obsidian.vault.read`), via `route.attachTo`:

```jsonc
{
  "name": "obsidian.how-to-cite-well", "kind": "skill", /* … body … */
  "route": { "attachTo": ["obsidian.vault.read"] }   // ← cross-source attach
}
```

A free-text body steering a powerful, trusted capability is a **prompt-injection
channel**, so cross-source attach is **default-OFF**:

| Path | Outcome |
|---|---|
| Pure-wire `POST /extensions` (no opt-in, no human) | **REJECTED outright** — `ok:false`, reason names the cross-source attach; **nothing activates** (not even the same-source parts of that manifest). The denial is a real assertion. |
| Management user `registerExtension(manifest, { allowCrossSource: true })` (the human's deliberate consent) | **Attaches** onto the host, and the host entry is **provenance-stamped**: `extras.attachedSkillProvenance: [{ skillId, authoringSource }]`. |

Provenance is the distinguishing mark: a foreign skill carries
`authoringSource` (≠ the host's source) while a first-party describe / a first-party
bundled skill (e.g. obsidian's own `obsidian.vault.how-to-cite`) does **not**. An
agent reading the manifest can tell them apart.

## What the worked path proves

1. **Same-source** skill back-links onto the author's own capability (freely) and is
   discoverable; its body reaches the agent's handshake manifest as context.
2. **Cross-source default-OFF** — a wire register without opt-in/human is a real
   denial; nothing is smuggled onto the trusted host.
3. **Cross-source with opt-in + approval** — the skill attaches, provenance-stamped,
   and its body reaches the agent — distinguishable from a first-party describe.

## Files

| File | Role |
|---|---|
| `skill-manifests.ts` | The authored manifests (`SAME_SOURCE_EXTENSION`, full `USER_SKILL_EXTENSION`). |
| `demo.ts` | The engine — boots the gateway, runs the worked path, returns a structured `DemoReport`. Shared by `run.ts` + the test. |
| `run.ts` | The runnable entrypoint (real socket). |

Asserted honest-green by `tests/m4-user-skill-attach.test.ts`.

## The mechanism it uses (read-only)

This example uses the shipped mechanism — it does not change it:

- `src/sources/extension.ts` — `applyCrossSourceAttach` (the default-OFF gate +
  provenance stamping), `manifestEntries` (same-source back-link).
- `src/core/capability-registry.ts` — `registerExtension` / `validateRegistration`
  + the `allowCrossSource` opt-in.
- `src/core/handlers.ts` — `POST /extensions` (the wire path that validates without
  the opt-in, so a cross-source attach is rejected).
- `examples/min-agent/client.ts` — the `PlexusClient` that drives discovery.
