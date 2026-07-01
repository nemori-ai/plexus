# Plexus Capability-Exposure Appliance — "expose one folder's workspace caps, and nothing else"

This example boots the **official hardened appliance image** (`docker/Dockerfile.appliance`)
that exposes **only a curated capability set** — here, the `workspace` capabilities over a
**single mounted folder** — and nothing else of the host. The container is itself the
confinement boundary.

> Design + threat model: [`docs/design/capability-appliance.md`](../../docs/design/capability-appliance.md)

## What you provide (the operator)

1. **A manifest** — the curated allowlist. [`manifest.json`](./manifest.json):
   ```json
   {
     "version": 1,
     "instance": "workspace-appliance",
     "workload": "appliance-box",
     "sources": [{ "source": "workspace", "path": "/data/exposed" }]
   }
   ```
   Only `workspace` is curated; only `/data/exposed` backs it. Everything else is
   **default-denied** by the boot wrapper.

2. **The folder to expose** — [`exposed-data/`](./exposed-data). Mounted read-only at
   `/data/exposed`. This is the ONLY host data the agent can reach.

## Run it

```bash
# Build (repo root as context; tag must NOT clobber the shared plexus-gateway:latest):
docker build -f docker/Dockerfile.appliance -t plexus-appliance:latest .

# Either: the raw docker-run form (all least-privilege flags visible)
./examples/appliance/run-appliance.sh

# Or: the compose profile (same flags, declarative)
docker compose -f examples/appliance/compose.appliance.yml up
```

## Prove only the curated caps are exposed

```bash
curl -s -H 'host: 127.0.0.1:7077' http://127.0.0.1:7077/.well-known/plexus \
  | jq '.capabilities[].id'
```

You get the `workspace.*` ids and nothing else — no `cc-master`, no Apple/exec sources
(they are not curated, not Linux-portable, and have no binary baked into the image).

## The least-privilege `docker run` flags (what makes it an appliance)

| Flag | Why |
| --- | --- |
| `--user 10001:10001` | non-root runtime (defense even if the image `USER` is overridden) |
| `--read-only` | immutable root filesystem |
| `--cap-drop=ALL` | drop every Linux capability |
| `--security-opt no-new-privileges` | no setuid escalation |
| `--tmpfs /state:rw,size=16m,mode=0700` | writable gateway state (keys/audit), ephemeral |
| `-v …/manifest.json:/etc/plexus/appliance.json:ro` | the curation, read-only |
| `-v …/exposed-data:/data/exposed:ro` | the ONLY host data exposed, read-only |
| `-p 127.0.0.1:7077:7077` | agent surface bound to host loopback only |

## Read-only vs read-write

The example mounts `/data/exposed:ro` and the manifest curates the whole `workspace`
source — so `workspace.write` is *advertised* but the bind mount makes writes fail. To make
a deliberately **read-only** appliance, curate only the read caps:

```json
{ "source": "workspace", "capabilities": ["workspace.read", "workspace.list"] }
```

Now `workspace.write` is **default-denied** (invisible in `.well-known`), not merely
blocked at the filesystem.

## Mesh-proxy variant

Add an `upstream` block to the manifest and the appliance boots as a mesh **proxy** that
dials a primary (NAT-friendly, no inbound ports), exposing its curated caps INTO the mesh:

```json
{
  "version": 1,
  "workload": "edge-appliance",
  "sources": [{ "source": "workspace", "path": "/data/exposed" }],
  "upstream": { "url": "wss://primary.example:8443", "pubkey": "<pinned-ed25519-key>" }
}
```
