# Trusted desktop host distribution

Build on macOS Apple Silicon with `bun install --frozen-lockfile`, then
`bun run build:host`. This produces `dist/plexus-host-darwin-arm64/` and a matching
`.tar.gz` plus `.sha256`. It contains standalone native `bin/plexus-runtime` and
`bin/plexus-management`, the built same-origin admin UI, and runtime text assets.
Bun is needed to build, not to run the installed distribution. The build applies and verifies ad-hoc signatures before hashing. The enclosing
Product release must sign/notarize the native executables for macOS distribution.

`manifest.json` pins the product and wire versions, source commit, hashes of the
actual source files (including uncommitted integration changes), Bun version, and
every packaged file's SHA-256 and size. Verify the manifest against the Product's
pinned manifest digest, then verify all file hashes before installing/launching.
A manifest supplied alongside an untrusted download is not itself a trust anchor.
The manifest does not hash itself; a Product can pin its SHA-256 externally.

Launch the runtime with an explicitly owned absolute `PLEXUS_HOME`,
`PLEXUS_ASSET_ROOT=<distribution>/assets`, and `PLEXUS_PORT=0` for an allocated
loopback port. Parse `PLEXUS_READY {"port":...,"pid":...,"lraVersion":...}` from
stdout and check `GET /v1/health`. The runtime creates the private management key
under that home. Preserve the home across runtime upgrades. Pass the asset root
after relocation; assets must remain trusted and immutable. `/admin/` serves the
built UI and its files with the existing Host/Origin guard. Static files and SPA
fallbacks cannot escape the asset directory through traversal or symlinks.

## Management process contract

This executable is for the trusted Product main process. Never place it on an
agent's PATH, in agent tools, or in model context. The agent uses the HTTP protocol
with its own enrolled credential. Never use the management key for agent traffic.
The existing general CLI also routes `plexus management ...` to the same handler;
its legacy agent commands are not part of this host integration.

Every invocation requires an explicit absolute `PLEXUS_HOME` and the trailing
arguments `--origin http://127.0.0.1:<port>`. No key argument, default home, remote
origin, arbitrary request path, redirect, or shell expansion is accepted. Mutating
commands read one JSON object from private stdin (maximum 1 MiB), so identifiers,
capability selections, paths and reasons need not appear in process arguments.
Requests time out after 15 seconds.

| Arguments before `--origin` | Private stdin JSON |
| --- | --- |
| `capabilities list` | none |
| `agent list` | none |
| `agent connect` | `{agentId, capabilities: string[], standing?: string[], agentType?: "generic", trustWindow?, ttlMs?}` |
| `agent revoke` | `{agentId, reason?}` |
| `pending list` | none |
| `pending resolve` | `{id, action: "approve" or "deny", reason?, trustWindow?, agentId?}` |
| `exposure list` | none |
| `exposure set` | `{id, enabled: boolean}` |
| `source list` | none |
| `source catalog` | none |
| `source add` | existing `ConfiguredSource`: `{id, kind, label, enabled, transport, route?, secretRef?, approval?, metadata?}` |
| `source remove` | `{id}` |

`trustWindow` is the existing protocol shape `{kind, ms?}`. A `custom` window
requires positive `ms`. Source secrets are referenced by name; configure secret
values using the isolated management UI's existing write-only secret endpoint.

Stdout is exactly one JSON line: `{ok:true,data:<existing admin API response>}`.
Success exits 0. Errors exit 1 (request/credential failure) or 2 (invalid input),
with `{ok:false,error:{code,message}}`; messages are fixed and do not echo paths,
input, credentials, or upstream exception bodies. Stderr is empty. The response
inside `data` may itself carry an operation-level `ok:false`; callers must inspect
that value as well as the command envelope.

**Connect is credential replacement.** Run it only for initial connect or an
explicit owner-requested reconnect. It resets enrollment and invalidates an old
PAT. It returns a one-time `code` with `expiresAt`, `enrollUrl`, `handshakeUrl`,
`granted` and `skipped`. Keep this result in trusted host memory, redeem through
the advertised HTTP enrollment route after checking the origin, and store the
resulting agent credential in Product secret storage. Do not log connect output,
copy credentials into the clipboard, or send code/PAT/key/path into model context.
Ordinary refresh uses `agent list`, `capabilities list` and `pending list`.

## Isolated management UI

The normal browser and first-party desktop key flows continue unchanged. A trusted
Product may set only `window.plexusDesktop.hostManagedAuthentication = true` from
an isolated preload. The UI then skips key reads, caching, prompts and auth headers.
The trusted main process injects the actual management header only for requests
from the trusted management frame to its exact runtime origin and the bounded
management paths. Existing UI routes include `/admin/api/*`, `GET /v1/events`
(management events), and `GET /integration/<safe-agent-id>` (integration rendering).
The flag grants no server access: missing or incorrect headers still return 401.
Use an isolated session and disable Node, arbitrary navigation and Product-agent
bridges in this window. The renderer must never receive the actual key.

## Protected filesystem custody

The Product sets `PLEXUS_PROTECTED_PATHS` to a JSON array of absolute protected
roots, for example its private data root and application installation root.
Plexus always additionally protects its own effective `PLEXUS_HOME` (including
the default `~/.plexus`). Invalid JSON or non-absolute entries fail closed for
filesystem resource access. This is trusted process configuration, never an
agent or source configuration field.

Workspace and Obsidian filesystem reads, directory listings, searches and writes
reject a resource root that contains or lies inside a protected root. The same
shared check covers sysinfo file-log reads and browser-control uploads. Canonical
paths cover symlink aliases and the existing parent of a not-yet-created write
target. Protected aliases encountered during listing/search fail the operation;
errors and health failures do not disclose protected paths. A dedicated material
directory outside custody remains usable. Do not put that directory under the
Product data root; use an explicit separate directory such as a sibling workspace.

This policy governs first-party filesystem resources, not arbitrary programs or
third-party extensions. Claude Code/Codex execution adapters rely on external
program sandboxes that do not confine reads; Products requiring management-key
isolation must not expose those execution capabilities without stronger process
isolation. Browser history/bookmark adapters use fixed profile files, not agent
file-path arguments. Apple Photos exports use gateway-generated output paths;
Shortcuts can execute owner-defined workflows and is likewise not a general
filesystem isolation proof. Keep execution and custom extension selection within
the Product's independently enforced capability policy.
