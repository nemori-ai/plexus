# Plexus extension: Prettier (local code formatter) (`prettier`)

Transport: `cli`. Registered via `POST /extensions` (PENDS for human approval).

## Capabilities
- `prettier.code.format.how-to-use` (skill) — no grant (read-as-context)
- `prettier.code.format` (capability) — grant cost: write

## Registering
1. Start the Plexus gateway.
2. Handshake with a connection-key from the management client to get a `sessionId`.
3. `PLEXUS_SESSION=<sessionId> ./register.sh`
4. Approve the pending registration in the management client (cli bins / non-loopback hosts require explicit approval).
