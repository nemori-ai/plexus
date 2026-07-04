#!/usr/bin/env bash
#
# deploy-parent.sh — deploy the CLOUD (production) mesh-security-audit PARENT to Fly.io.
#
# ┌───────────────────────────────────────────────────────────────────────────────────┐
# │ YOU run this, with YOUR OWN Fly account. It spends YOUR Fly credits. We do NOT      │
# │ deploy for you and this script was NOT run against a real Fly account (no creds).   │
# └───────────────────────────────────────────────────────────────────────────────────┘
#
# What it does (idempotent-ish — safe to re-run):
#   1. Build the STOCK gateway image locally from docker/Dockerfile → plexus-gateway:latest.
#   2. `fly launch`/`fly deploy` the EDGE image (Dockerfile.edge = stock gateway + cloudflared)
#      using --local-only so the `FROM plexus-gateway:latest` resolves from your local daemon.
#   3. Create + attach the PERSISTENT VOLUME at /state (mesh identity + connection-key survive).
#   4. Set the cloudflared TUNNEL_TOKEN secret (you get it from `cloudflared` — see cloudflared.md).
#   5. Pin exactly one always-on Machine.
#
# PREREQUISITES (install + authenticate YOURSELF):
#   • flyctl        — https://fly.io/docs/flyctl/install/   then `fly auth login`
#   • docker        — a running Docker daemon (the stock image builds locally)
#   • a Cloudflare tunnel token — created per cloudflared.md (TUNNEL_TOKEN)
#
# ENV you may override:
#   FLY_APP        Fly app name          (default: value of `app` in fly.toml)
#   FLY_REGION     Fly region            (default: value of primary_region in fly.toml)
#   VOLUME_NAME    persistent volume     (default: plexus_state)
#   VOLUME_SIZE_GB volume size in GB     (default: 1)
#   TUNNEL_TOKEN   cloudflared token     (if set, this script `fly secrets set`s it)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

FLY_TOML="${SCRIPT_DIR}/fly.toml"
VOLUME_NAME="${VOLUME_NAME:-plexus_state}"
VOLUME_SIZE_GB="${VOLUME_SIZE_GB:-1}"

# ── narration ────────────────────────────────────────────────────────────────
BOLD=$'\e[1m'; DIM=$'\e[2m'; CYAN=$'\e[36m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'
say()  { printf '  %s\n' "$1"; }
ok()   { printf '  %s✓%s %s\n' "${GREEN}" "${RESET}" "$1"; }
note() { printf '  %s»%s %s\n' "${YELLOW}" "${RESET}" "$1"; }
step() { printf '\n%s%s== %s ==%s\n' "${BOLD}" "${CYAN}" "$1" "${RESET}"; }
die()  { printf '\n%s%sDEPLOY FAILED%s: %s\n' "${BOLD}" "${RED}" "${RESET}" "$1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required tool not found on PATH: $1"; }

need docker
need fly    # flyctl installs the `fly` binary

# Resolve app + region from fly.toml unless overridden (grep is enough — no toml parser).
FLY_APP="${FLY_APP:-$(grep -E '^app[[:space:]]*=' "${FLY_TOML}" | head -n1 | sed -E 's/.*"([^"]+)".*/\1/')}"
FLY_REGION="${FLY_REGION:-$(grep -E '^primary_region[[:space:]]*=' "${FLY_TOML}" | head -n1 | sed -E 's/.*"([^"]+)".*/\1/')}"
[ -n "${FLY_APP}" ]    || die "could not resolve the Fly app name (set FLY_APP or edit fly.toml)"
[ -n "${FLY_REGION}" ] || die "could not resolve the Fly region (set FLY_REGION or edit fly.toml)"

printf '%s╔══════════════════════════════════════════════════════════════════════╗%s\n' "${BOLD}" "${RESET}"
printf '%s║  mesh-security-audit — CLOUD parent deploy (Fly.io + Cloudflare)      ║%s\n' "${BOLD}" "${RESET}"
printf '%s╚══════════════════════════════════════════════════════════════════════╝%s\n' "${BOLD}" "${RESET}"
say "app: ${FLY_APP}   region: ${FLY_REGION}   volume: ${VOLUME_NAME} (${VOLUME_SIZE_GB}GB)"

# ── 1. Build the STOCK gateway image locally (docker/Dockerfile, UNCHANGED) ────
step "1. Build the stock gateway image (plexus-gateway:latest)"
say "Repo root: ${REPO_ROOT}"
docker build -f "${REPO_ROOT}/docker/Dockerfile" -t plexus-gateway:latest "${REPO_ROOT}" \
  || die "stock image build failed (see docker/Dockerfile). On a throttled box the ubuntu base pull can stall."
ok "plexus-gateway:latest built (Dockerfile.edge layers cloudflared on top of THIS)."

# ── 2. Ensure the Fly app exists ───────────────────────────────────────────────
step "2. Ensure the Fly app exists"
if fly status -a "${FLY_APP}" >/dev/null 2>&1; then
  ok "Fly app '${FLY_APP}' already exists."
else
  say "Creating the Fly app (no deploy yet)…"
  fly apps create "${FLY_APP}" || die "fly apps create failed"
  ok "Fly app '${FLY_APP}' created."
fi

# ── 3. Persistent volume at /state (mesh identity + connection-key persistence) ─
step "3. Ensure the persistent volume '${VOLUME_NAME}' (/state)"
if fly volumes list -a "${FLY_APP}" 2>/dev/null | grep -q "${VOLUME_NAME}"; then
  ok "Volume '${VOLUME_NAME}' already present."
else
  say "Creating a ${VOLUME_SIZE_GB}GB volume in ${FLY_REGION}…"
  fly volumes create "${VOLUME_NAME}" --region "${FLY_REGION}" --size "${VOLUME_SIZE_GB}" -a "${FLY_APP}" --yes \
    || die "fly volumes create failed"
  ok "Volume '${VOLUME_NAME}' created (mounted at /state by fly.toml [mounts])."
fi

# ── 4. The cloudflared tunnel token (the ONLY secret; connection-key is NOT injected) ──
step "4. Set the cloudflared TUNNEL_TOKEN secret"
if [ -n "${TUNNEL_TOKEN:-}" ]; then
  fly secrets set "TUNNEL_TOKEN=${TUNNEL_TOKEN}" -a "${FLY_APP}" --stage \
    || die "fly secrets set TUNNEL_TOKEN failed"
  ok "TUNNEL_TOKEN staged (applied on the next deploy)."
else
  note "TUNNEL_TOKEN not provided to this script. Set it before/after deploy with:"
  note "    fly secrets set TUNNEL_TOKEN=<your-tunnel-token> -a ${FLY_APP}"
  note "Get the token from \`cloudflared tunnel token <NAME>\` or the CF dashboard (cloudflared.md)."
fi
note "The ADMIN connection-key is NOT a secret you set — the gateway auto-generates it into"
note "/state/connection-key on first boot (persisted on the volume). Retrieve it AFTER deploy:"
note "    fly ssh console -a ${FLY_APP} -C 'cat /state/connection-key'"

# ── 5. Deploy the EDGE image (--local-only so FROM plexus-gateway:latest resolves) ──
step "5. Deploy (Dockerfile.edge = stock gateway + cloudflared)"
say "Using --local-only so the FROM plexus-gateway:latest resolves from your local daemon."
fly deploy -c "${FLY_TOML}" -a "${FLY_APP}" --local-only --ha=false \
  || die "fly deploy failed"
ok "Deployed."

# ── 6. Pin exactly ONE always-on Machine ───────────────────────────────────────
step "6. Pin one always-on Machine"
fly scale count 1 -a "${FLY_APP}" --yes || note "could not set scale count (set manually: fly scale count 1)"
ok "Scaled to a single Machine (the mesh primary is a single authority — keep count == 1)."

printf '\n%s%sPARENT DEPLOYED.%s Next:\n' "${BOLD}" "${GREEN}" "${RESET}"
say "1. Point mesh.<domain> + plexus.<domain> at this tunnel  → see cloudflared.md"
say "2. Mint join tokens on the parent + attach children      → ./mint-join.sh, ./mac-child.sh, ./linux-child.sh"
say "3. Authorize the agent + run the flow                     → ../scripts/grant-setup.sh, ../agent/driver.py"
say "See ./README.md for the full ordered walkthrough."
