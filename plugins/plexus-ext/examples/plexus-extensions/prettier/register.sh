#!/usr/bin/env bash
# Register this Plexus extension via the running gateway.
#
# SECURITY: this script embeds NO connection-key and NO token. It reads a LIVE
# handshake sessionId from the environment ($PLEXUS_SESSION) and the gateway base
# URL from $PLEXUS_URL (default loopback). Obtain a sessionId by handshaking with a
# connection-key from the management client; never paste a key into this file.
#
# POST /extensions PENDS for a human to approve in the management client. cli bins /
# non-loopback rest hosts require explicit approval there.
set -euo pipefail
cd "$(dirname "$0")"

: "${PLEXUS_URL:=http://127.0.0.1:7077}"
if [ -z "${PLEXUS_SESSION:-}" ]; then
  echo "set PLEXUS_SESSION to a live handshake sessionId (from POST /link/handshake)" >&2
  exit 1
fi

MANIFEST="$(cat manifest.json)"
curl -fsS -X POST "${PLEXUS_URL}/extensions" \
  -H "Content-Type: application/json" \
  -H "Host: 127.0.0.1:${PLEXUS_URL##*:}" \
  --data "{\"sessionId\":\"${PLEXUS_SESSION}\",\"manifest\":${MANIFEST}}"
echo
echo "Submitted. Approve the registration in the Plexus management client."
