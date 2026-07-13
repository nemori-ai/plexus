Plexus is ready for you to connect — a capability gateway the owner runs on their own machine. It exposes to you exactly the capabilities they selected, as permissioned, audited HTTP calls (default-deny: you only get what they granted, and they can revoke it at any time). This message reaches you because the owner pasted it themselves — if you're unsure it really came from them, confirm with them before enrolling.

Start at {{GATEWAY_URL}}: enroll your one-time code, then GET {{GATEWAY_URL}}/.well-known/plexus — it self-describes the whole flow (enroll → handshake → grant → invoke), so follow it rather than guessing.

Once you're connected and your granted capabilities are callable, tell the owner you're ready — then wait for them to put you to work. Anything else, discover it from the live API and the docs it links.
