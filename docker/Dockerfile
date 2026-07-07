# Plexus gateway image — the SAME stock binary a real Ubuntu VM runs.
#
# ONE image, TWO roles (selected at run time by `PLEXUS_MODE`):
#   • primary  (PLEXUS_MODE unset)  — authority root + mesh tunnel acceptor.
#   • proxy    (PLEXUS_MODE=proxy)  — dials a primary, enrolls with a one-time
#     join token, live-ascends its catalog. Dials OUT (NAT-friendly: no inbound).
#
# The default CMD boots the STOCK headless gateway (`packages/runtime/src/index.ts`
# → `startRuntime`, the SAME supervised seam `bin/plexus` and `src/index.ts` use).
# On Linux the source registry auto-gates the active first-party MODULES to the
# portable allowlist {workspace, sysinfo} (P3-1); the macOS-native + exec sources
# (apple-*, things, claudecode, codex) are not scanned/advertised. A6 means this
# stock boot reads `PLEXUS_JOIN_TOKEN` (+ upstream env) and enrolls as a proxy from
# ENV ALONE — no custom launcher, no code injection. That is why the demo compose,
# the hermetic e2e, AND a real VM all run THIS image unchanged.
#
# Base:  ubuntu 22.04  (glibc 2.35; arm64/x86_64 per host).
#        (24.04 also works; 22.04 is pinned because it is what this box had cached —
#         Docker Hub metadata pulls were stalling here. Bump once registry is reliable.)
# Bun:   pinned to 1.3.11 (matches the dev box; repo engines require bun >=1.3.0).
# Repo:  copied in; node_modules is .dockerignore'd so deps install fresh on Linux.
#
# Build (REPO ROOT as context — the Dockerfile lives in docker/):
#   docker build -f docker/Dockerfile -t plexus-gateway:latest ..
#
# Run a PRIMARY (routable tunnel on 0.0.0.0, dual ws+wss):
#   docker run --rm -p 7077:7077 \
#     -e PLEXUS_MESH_TUNNEL_HOST=0.0.0.0 -e PLEXUS_MESH_WS_PORT=8080 -e PLEXUS_MESH_WSS_PORT=8443 \
#     -e PLEXUS_MESH_TLS_CERT=/certs/primary-cert.pem -e PLEXUS_MESH_TLS_KEY=/certs/primary-key.pem \
#     -v "$PWD/docker/certs:/certs:ro" plexus-gateway:latest
#
# Run a PROXY (dials a primary over wss, trusting a self-signed CA via NODE_EXTRA_CA_CERTS):
#   docker run --rm \
#     -e PLEXUS_MODE=proxy -e PLEXUS_WORKLOAD=proxy-a \
#     -e PLEXUS_UPSTREAM_URL=wss://primary:8443 -e PLEXUS_UPSTREAM_PUBKEY=<pinned-key> \
#     -e PLEXUS_JOIN_TOKEN=<one-time-token> -e NODE_EXTRA_CA_CERTS=/certs/primary-cert.pem \
#     -v "$PWD/docker/certs:/certs:ro" plexus-gateway:latest
#
# Scouting override (Linux pass/fail of the whole suite — the image's old job):
#   docker run --rm plexus-gateway:latest bun test

FROM ubuntu:22.04

# Pin the Bun version so the image is reproducible.
ARG BUN_VERSION=1.3.11
ENV BUN_INSTALL=/usr/local
ENV PATH=/usr/local/bin:$PATH
ENV DEBIAN_FRONTEND=noninteractive

# curl + unzip are required by the official Bun installer; ca-certificates for TLS;
# git because some tooling/tests may shell out to it; bash is the login shell the
# Linux platform seam probes ($SHELL -lic ...).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl unzip ca-certificates git bash \
 && rm -rf /var/lib/apt/lists/*

# Install the pinned Bun.
RUN curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}" \
 && bun --version

WORKDIR /app

# Copy the repo (node_modules excluded via .dockerignore so deps resolve for Linux).
COPY . .

# Install dependencies at build time so a Linux-incompatible dep fails the BUILD
# loudly (not silently at run time). Fresh install — no macOS lockfile artifacts.
RUN bun install

# Build the web-admin SPA INTO the image so a headless container serves the FULL
# /admin console (not just the agent API). The runtime serves the console from
# `packages/web-admin/dist` (core/admin.ts → CLIENT_DIST); `dist/` is .dockerignore'd
# (a local build artifact), so we build it fresh on Linux here. Without this step a
# headless box would boot with the console "never built" warning and only the API.
RUN bun run --cwd packages/web-admin build

# Per-process gateway state (connection-key, signing secret, Ed25519 mesh identity,
# audit dir) lives here unless PLEXUS_HOME overrides it. The demo compose gives each
# service its OWN volume-backed PLEXUS_HOME so the three gateways are independent.
ENV PLEXUS_HOME=/state
RUN mkdir -p /state /data

# Documentation only (compose/`docker run -p` publishes the real mappings):
#   7077 = agent-facing HTTP surface (loopback inside the container by default)
#   8080 = mesh tunnel  ws  listener (enc-OFF)   — primary only
#   8443 = mesh tunnel  wss listener (enc-ON)     — primary only
EXPOSE 7077 8080 8443

# Default: boot the STOCK headless gateway. PLEXUS_MODE (+ upstream/join-token env)
# selects primary vs proxy at run time. Override with `bun test` to scout Linux.
CMD ["bun", "run", "packages/runtime/src/index.ts"]
