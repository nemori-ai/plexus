Plexus is ready for you to connect — a local capability gateway on this machine that exposes the owner's files, tools, and services to you as permissioned, audited HTTP capabilities (default-deny: you only get what they granted).

Start at {{GATEWAY_URL}}: enroll your one-time code, then GET {{GATEWAY_URL}}/.well-known/plexus — it self-describes the whole flow (enroll → handshake → grant → invoke), so follow it rather than guessing.

Once you're connected and your granted capabilities are callable, tell the owner you're ready — then wait for them to put you to work. Anything else, discover it from the live API and the docs it links.
