# `management-client/` — Plexus local management UI (t11)

A minimal React (Vite + TypeScript) admin panel for the local Plexus gateway.

## How it is served (same-origin)

The gateway enforces a Host/Origin guard (loopback-only, §5b). A separate Vite
dev-server origin would be **rejected** as cross-origin, so the gateway **serves
the built client same-origin** from `GET /admin` (see `src/core/admin.ts`), and the
client calls a same-origin admin API under `/admin/api/*`. There is no standalone
dev server in normal use.

```bash
cd management-client
bun install
bun run build          # → management-client/dist (the gateway serves this)
# then boot the gateway and open http://127.0.0.1:7077/admin
```

`vite.config.ts` sets `base: "/admin/"` so the emitted asset URLs are same-origin.

## Connection-key handling

The admin API runs **inside** the gateway process, so it is the trusted local
management surface: it reads the connection-key directly from `~/.plexus/` (via
`state.connectionKey`) and drives the same `GrantService` the protocol endpoints
use. Mutating admin calls attach the key as `X-Plexus-Connection-Key`.

**F2 — the key is NEVER fetched over HTTP.** An untrusted agent only speaks HTTP
over loopback, so a `GET /admin/api/connection-key` route (now removed) would let it
escalate to the management surface. The admin SPA resolves the key OUT OF BAND, in
order: (a) `window.plexusDesktop.getConnectionKey()` — the Electron desktop shell
read `~/.plexus/connection-key` and injects it over IPC; (b) a value the human
pasted before, cached in `localStorage`; (c) a one-time human paste (the runtime
prints the key to its launching terminal at startup). The same key is shown in the
"Connect an agent" panel so the user can copy it to hand to an agent
(`connectionKeyDelivery: "user-paste"`).

## The four functions

1. **List capabilities** — full self-describe entries (id, kind, label, describe,
   grants, transport, attached skills) from `GET /admin/api/capabilities`.
2. **Select a subset + set access** — per capability: expose/hide and read-only vs
   read-write, mapped to grant verbs, issued via `PUT /admin/api/grants`.
3. **Issue / revoke / list tokens** — issue (above), `GET /admin/api/tokens`,
   `POST /admin/api/revoke` (by jti).
4. **View audit** — `GET /admin/api/audit` renders the handshake/grant/token/invoke/
   revoke trail.

The API client imports the **frozen protocol types** from `../src/protocol` so it
stays in lockstep with the gateway.

## Design

The UI is built to production-grade quality under the **impeccable** design skill
(see `.impeccable.md` at the repo root for the full design context). The aesthetic is
a **custodial permission ledger**: a warm-neutral dark control surface (OKLCH, tinted
toward amber "lamplight") where the trust state is the loudest signal —

- **Capabilities** render as ledger rows, not a card grid. An exposure rail (the row's
  left edge) lights green when a capability is exposed; a background tint reinforces it.
  Per-row: an Exposed/Hidden switch + a read-only / read-write segment. **Verb stamps**
  (read = green, write = amber, execute = clay) light up to show exactly which verbs the
  current access level grants — making default-deny / default-read-only visible.
- A sticky **issue bar** always tallies precisely what is about to be authorized
  (`N capabilities to expose · M with write/execute`) before you mint a scoped token.
- **Tokens** and **Audit** are evidentiary tables: monospaced ids/jti for machine
  identifiers, synthesized workflow scopes annotated `↳ via <workflow>`, and color-coded
  audit event types + outcomes (OK green, DENIED clay-red).
- Type: **Hanken Grotesk** (UI) + **Spline Sans Mono** (machine identifiers only).
- Empty / loading (shimmer skeletons) / error / granted / revoked states are all
  designed, not afterthoughts. Honors `prefers-reduced-motion`.

Source layout: `src/App.tsx` (shell + the three section tabs and the ledger),
`src/icons.tsx` (inline stroke icons), `src/styles.css` (the full token system + theme).
The data layer (`src/api.ts`) and the same-origin `/admin` serving are unchanged.
