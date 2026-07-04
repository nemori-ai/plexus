#!/usr/bin/env bash
#
# mint-join.sh — mint a ONE-TIME mesh join token on the CLOUD parent (over `fly ssh`)
# and print the exact env a child needs to dial in through the Cloudflare edge.
#
# The parent is the mesh authority; `plexus mesh mint` is a privileged admin call, so we
# run it INSIDE the parent Machine (fly ssh) against its own loopback agent surface. It
# returns { token, primaryPubKey (PEM), … }. We derive the RAW single-line Ed25519 public
# key from the PEM (an --env-file / shell value cannot span lines) — the child's pin
# (`samePublicKey`) treats PEM and raw-base64 as equal. This derivation mirrors
# ../local/up.sh exactly.
#
# Usage:
#   MESH_HOSTNAME=mesh.example.com ./mint-join.sh mac      # → env for the Mac child
#   MESH_HOSTNAME=mesh.example.com ./mint-join.sh linux    # → env for the Linux child
#
# Env:
#   FLY_APP        Fly app name        (default: `app` in fly.toml)
#   MESH_HOSTNAME  your CF mesh host   (REQUIRED, e.g. mesh.example.com — no scheme/port)
#   OUT_ENV_FILE   if set, also write the child env block to this file (KEY=VALUE lines)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLY_TOML="${SCRIPT_DIR}/fly.toml"

WORKLOAD="${1:-}"
[ -n "${WORKLOAD}" ] || { echo "usage: MESH_HOSTNAME=mesh.<domain> $0 <workload>  (e.g. mac | linux)" >&2; exit 2; }

MESH_HOSTNAME="${MESH_HOSTNAME:-}"
[ -n "${MESH_HOSTNAME}" ] || { echo "ERROR: set MESH_HOSTNAME=mesh.<your-domain> (the public-hostname route to the mesh tunnel)" >&2; exit 2; }

FLY_APP="${FLY_APP:-$(grep -E '^app[[:space:]]*=' "${FLY_TOML}" | head -n1 | sed -E 's/.*"([^"]+)".*/\1/')}"
[ -n "${FLY_APP}" ] || { echo "ERROR: could not resolve FLY_APP (set it or edit fly.toml)" >&2; exit 2; }

command -v fly >/dev/null 2>&1 || { echo "ERROR: flyctl (fly) not on PATH — https://fly.io/docs/flyctl/install/" >&2; exit 2; }
command -v jq  >/dev/null 2>&1 || { echo "ERROR: jq not on PATH" >&2; exit 2; }

echo "[mint] minting a one-time join token for workload='${WORKLOAD}' on app='${FLY_APP}'…" >&2

# Run the mint INSIDE the parent Machine. --host/--scheme make the printed endpoint the
# public CF route; --json gives us machine-readable output. The gateway's own agent surface
# is on 127.0.0.1:7077 inside the container. cd /app so the repo-local CLI resolves.
MINT="$(fly ssh console -a "${FLY_APP}" -C \
  "sh -lc 'cd /app && bun run packages/cli/src/bin/plexus mesh mint --url http://127.0.0.1:7077 --workload ${WORKLOAD} --host ${MESH_HOSTNAME} --scheme wss --json'" \
  2>/dev/null)" || { echo "ERROR: fly ssh mint failed — is the app deployed + running? (fly status -a ${FLY_APP})" >&2; exit 1; }

# `fly ssh console -C` can prepend connection chatter; keep only the JSON object line.
MINT_JSON="$(printf '%s\n' "${MINT}" | grep -E '^\s*\{' | tail -n1)"
[ -n "${MINT_JSON}" ] || { echo "ERROR: no JSON in mint output. Raw:" >&2; printf '%s\n' "${MINT}" >&2; exit 1; }

TOKEN="$(printf '%s' "${MINT_JSON}" | jq -r '.token // empty')"
PUBKEY_PEM="$(printf '%s' "${MINT_JSON}" | jq -r '.primaryPubKey // empty')"
[ -n "${TOKEN}" ]      || { echo "ERROR: mint returned no token: ${MINT_JSON}" >&2; exit 1; }
[ -n "${PUBKEY_PEM}" ] || { echo "ERROR: mint returned no primaryPubKey: ${MINT_JSON}" >&2; exit 1; }

# PEM → raw single-line base64 Ed25519 key (strip envelope → SPKI-DER → drop 12-byte header
# → base64 the 32-byte key). Identical to ../local/up.sh.
PUBKEY_RAW="$(printf '%s' "${PUBKEY_PEM}" | grep -v 'PUBLIC KEY' | tr -d '\n ' | base64 -d 2>/dev/null | tail -c 32 | base64 | tr -d '\n')"
[ -n "${PUBKEY_RAW}" ] || { echo "ERROR: failed to derive raw pubkey from PEM: ${PUBKEY_PEM}" >&2; exit 1; }

UPSTREAM_URL="wss://${MESH_HOSTNAME}"   # TLS at the CF edge; port 443 implicit.

echo "[mint] ✓ minted (single-use token; pinned primary pubkey — no bare-TOFU)." >&2

# Emit a copy-pasteable env block on STDOUT (so callers can `eval` / redirect it).
cat <<EOF
# ── join env for the '${WORKLOAD}' child (mint is single-use — re-run for another child) ──
export PLEXUS_UPSTREAM_URL='${UPSTREAM_URL}'
export PLEXUS_UPSTREAM_PUBKEY='${PUBKEY_RAW}'
export PLEXUS_JOIN_TOKEN='${TOKEN}'
export PLEXUS_WORKLOAD='${WORKLOAD}'
EOF

if [ -n "${OUT_ENV_FILE:-}" ]; then
  cat > "${OUT_ENV_FILE}" <<EOF
PLEXUS_UPSTREAM_URL=${UPSTREAM_URL}
PLEXUS_UPSTREAM_PUBKEY=${PUBKEY_RAW}
PLEXUS_JOIN_TOKEN=${TOKEN}
PLEXUS_WORKLOAD=${WORKLOAD}
EOF
  echo "[mint] wrote ${OUT_ENV_FILE}" >&2
fi
