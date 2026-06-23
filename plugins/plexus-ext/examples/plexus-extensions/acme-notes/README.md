# Plexus extension: Acme Notes (Local REST API) (`acme-notes`)

Transport: `local-rest`. Registered via `POST /extensions` (PENDS for human approval).

## Capabilities
- `acme-notes.notes.search.how-to-use` (skill) — no grant (read-as-context)
- `acme-notes.notes.search` (capability) — grant cost: read

## Registering
1. Start the Plexus gateway.
2. Handshake with a connection-key from the management client to get a `sessionId`.
3. `PLEXUS_SESSION=<sessionId> ./register.sh`
4. Approve the pending registration in the management client (cli bins / non-loopback hosts require explicit approval).

## Secrets
This extension needs secret values provisioned out of band — see `secrets.README.md`. No values are stored here.
