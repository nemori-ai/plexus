#!/usr/bin/env bash
# ============================================================================
# Plexus — REAL Linux-kernel end-to-end verification of the headless portable
# gateway (P3 series). Proves the NEW code — managed workspace-dir multi-instance
# + per-instance approval:"ask" posture + the demo onboarding loop — holds under a
# real Linux kernel, not just on the macOS dev box.
#
#   bash tests/docker-linux-e2e.sh
#
# Everything runs INSIDE an Ubuntu+Bun container built from docker/Dockerfile:
#   * PLEXUS_HOME=/state (container-internal — NO host secret dir is ever mounted),
#   * the gateway binds 127.0.0.1:7077 (loopback only),
#   * the admin API + the agent `plexus` CLI are driven via `docker exec` so the
#     loopback Host header always matches.
#
# Verified path (each step prints its real echo):
#   1. connection-key present under /state (gateway home)
#   2. POST /admin/api/demo-workspace → demo-intro(auto) + your-secret(ask)
#   3. POST /admin/api/agents/connect → one-time enrollment code
#   4. agent enrolls → PAT stored under ITS OWN home (/agent-home)
#   5. demo-intro.read flows with NO approval (auto posture)
#   6. your-secret.read PENDS (ask) → owner APPROVES → the fake secret returns
#   7. re-run pends AGAIN → owner DENIES → agent gets DENIED (exit 77)
#   8. NO-LEAK: the connection-key never lands in the agent's home (ADR-019);
#      demo files live only under /state.
#
# Exit 0 = all steps passed. Nonzero = a step failed on Linux (a REAL gap).
# This script assumes Docker is present + usable; run-tests.sh SKIPs it otherwise.
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="plexus-gateway:e2e"
NAME="plexus-linux-e2e"
AGENT="linux-e2e-agent"
DEMO_ROOT="/state/PlexusDemo"
AGENT_HOME="/agent-home"

cd "$REPO_ROOT"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> [1/3] building $IMAGE from docker/Dockerfile (fresh Linux install + web-admin build) ..."
docker build -f docker/Dockerfile -t "$IMAGE" .

echo "==> [2/3] booting the stock headless gateway (PLEXUS_HOME=/state, loopback-only) ..."
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e PLEXUS_HOME=/state "$IMAGE" >/dev/null

# Wait for the gateway to serve its Floor inside the container.
ready=""
for _ in $(seq 1 90); do
  if docker exec "$NAME" curl -sf http://127.0.0.1:7077/.well-known/plexus >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then
  echo "FAIL: gateway did not become ready inside the container" >&2
  echo "----- container logs -----" >&2
  docker logs "$NAME" >&2 || true
  exit 1
fi
echo "gateway ready (served /.well-known/plexus inside the container)"

echo "==> [3/3] driving the full agent flow inside the container ..."
docker exec -i \
  -e AGENT="$AGENT" -e AGENT_HOME="$AGENT_HOME" -e DEMO_ROOT="$DEMO_ROOT" \
  "$NAME" bash -s <<'INNER'
set -euo pipefail
GW="http://127.0.0.1:7077"
KEY="$(cat /state/connection-key)"
CLI=(bun /app/tools/plexus-cli/plexus)
HDR=(-H "X-Plexus-Connection-Key: $KEY" -H "content-type: application/json")
say() { printf '\n----- %s -----\n' "$1"; }

say "STEP 1: connection-key present under /state (the gateway home)"
test -f /state/connection-key || { echo "FAIL: no /state/connection-key"; exit 1; }
echo "connection-key at /state/connection-key (value: ${KEY:0:9}...redacted): OK"

say "STEP 2: POST /admin/api/demo-workspace → demo-intro(auto) + your-secret(ask)"
DW="$(curl -s "${HDR[@]}" -X POST -d "{\"path\":\"$DEMO_ROOT\"}" "$GW/admin/api/demo-workspace")"
echo "$DW" | bun -e '
const d = JSON.parse(await Bun.stdin.text());
if (!d.ok) { console.error("demo-workspace not ok:", d.reason); process.exit(1); }
const p = Object.fromEntries(d.sources.map(s => [s.id, s.approval]));
if (p["demo-intro"] !== "auto" || p["your-secret"] !== "ask") {
  console.error("FAIL: posture mismatch", p); process.exit(1);
}
console.log("root:", d.root);
console.log("sources:", d.sources.map(s => `${s.id}(${s.approval})`).join(", "), "OK");
'

say "STEP 3: POST /admin/api/agents/connect → mint a one-time enrollment code"
CN="$(curl -s "${HDR[@]}" -X POST -d "{\"agentId\":\"$AGENT\"}" "$GW/admin/api/agents/connect")"
CODE="$(echo "$CN" | bun -e 'const d=JSON.parse(await Bun.stdin.text()); if(!d.ok||!d.code){console.error("connect failed",d);process.exit(1)} process.stdout.write(d.code)')"
echo "minted enrollment code: ${CODE:0:16}...(redacted)"

say "STEP 4: agent enrolls → PAT stored under its OWN home ($AGENT_HOME)"
env PLEXUS_HOME="$AGENT_HOME" PLEXUS_GATEWAY="$GW" PLEXUS_AGENT_ID="$AGENT" "${CLI[@]}" enroll "$CODE"
AENV=(env PLEXUS_HOME="$AGENT_HOME" PLEXUS_GATEWAY="$GW" PLEXUS_AGENT_ID="$AGENT")

say "STEP 5: demo-intro.read flows with NO approval (auto posture)"
INTRO="$("${AENV[@]}" PLEXUS_APPROVAL_WAIT_MS=0 "${CLI[@]}" demo-intro.read welcome.md)"
echo "$INTRO" | head -3
echo "$INTRO" | grep -q "Welcome to Plexus" \
  && echo "demo-intro.read OK (intro content returned, no pend)" \
  || { echo "FAIL: demo-intro.read did not return the intro"; exit 1; }

find_pending() {
  # echo the pendingId for a still-pending your-secret.read, or empty
  curl -s "${HDR[@]}" "$GW/admin/api/pending" | bun -e '
    const d = JSON.parse(await Bun.stdin.text());
    const p = (d.pending || []).find(x =>
      (x.capabilities || []).includes("your-secret.read") &&
      (x.state === undefined || x.state === "pending"));
    process.stdout.write(p ? p.pendingId : "");
  '
}

say "STEP 6: your-secret.read PENDS (ask) → owner APPROVES (once) → fake secret returns"
"${AENV[@]}" PLEXUS_APPROVAL_WAIT_MS=30000 "${CLI[@]}" your-secret.read secret.md \
  >/tmp/sec_ok.out 2>/tmp/sec_ok.err &
P1=$!
PID1=""
for _ in $(seq 1 60); do PID1="$(find_pending)"; [ -n "$PID1" ] && break; sleep 0.5; done
[ -n "$PID1" ] || { echo "FAIL: your-secret.read never pended"; cat /tmp/sec_ok.err; exit 1; }
echo "PENDING surfaced for your-secret.read: $PID1"
echo "agent stderr while waiting (proves it pended):"; sed 's/^/  | /' /tmp/sec_ok.err
curl -s "${HDR[@]}" -X POST \
  -d "{\"action\":\"approve\",\"agentId\":\"$AGENT\",\"trustWindow\":{\"kind\":\"once\"}}" \
  "$GW/admin/api/pending/$PID1" >/dev/null
set +e; wait "$P1"; RC1=$?; set -e
echo "agent exit after approve: $RC1 (expected 0)"
echo "agent stdout after approve:"; sed 's/^/  | /' /tmp/sec_ok.out
[ "$RC1" = 0 ] || { echo "FAIL: expected exit 0 after approve"; exit 1; }
grep -q "tangerine-42" /tmp/sec_ok.out \
  && echo "APPROVE OK (the fake secret 'tangerine-42' came back)" \
  || { echo "FAIL: the secret was not returned after approval"; exit 1; }

say "STEP 7: re-run pends AGAIN (once never stands) → owner DENIES → agent DENIED (exit 77)"
"${AENV[@]}" PLEXUS_APPROVAL_WAIT_MS=30000 "${CLI[@]}" your-secret.read secret.md \
  >/tmp/sec_deny.out 2>/tmp/sec_deny.err &
P2=$!
PID2=""
for _ in $(seq 1 60); do PID2="$(find_pending)"; [ -n "$PID2" ] && break; sleep 0.5; done
[ -n "$PID2" ] || { echo "FAIL: the re-run never pended (once should NOT stand)"; exit 1; }
echo "PENDING surfaced again (once did not stand): $PID2"
curl -s "${HDR[@]}" -X POST \
  -d "{\"action\":\"deny\",\"agentId\":\"$AGENT\",\"reason\":\"not this folder — it is protected\"}" \
  "$GW/admin/api/pending/$PID2" >/dev/null
set +e; wait "$P2"; RC2=$?; set -e
echo "agent exit after deny: $RC2 (expected 77)"
echo "agent stderr after deny:"; sed 's/^/  | /' /tmp/sec_deny.err
[ "$RC2" = 77 ] || { echo "FAIL: expected exit 77 on deny, got $RC2"; exit 1; }
grep -q "DENIED" /tmp/sec_deny.err \
  && echo "DENY OK (explicit DENIED, exit 77)" \
  || { echo "FAIL: no explicit DENIED in agent stderr"; exit 1; }
if grep -q "tangerine-42" /tmp/sec_deny.out; then echo "FAIL: secret leaked on deny"; exit 1; fi
echo "no secret bytes returned on deny: OK"

say "STEP 8: NO-LEAK — connection-key absent from the agent home; demo files only under /state"
if grep -rIlF -- "$KEY" "$AGENT_HOME" 2>/dev/null; then
  echo "FAIL: the admin connection-key LEAKED into the agent home (ADR-019 violated)"; exit 1
fi
echo "connection-key is NOT anywhere under $AGENT_HOME: OK (ADR-019)"
echo "agent home contents (only its own PAT):"; find "$AGENT_HOME" -type f | sed 's/^/  /'
test -f "$DEMO_ROOT/plexus-intro/welcome.md" \
  && echo "demo files materialized under /state ($DEMO_ROOT): OK" \
  || { echo "FAIL: demo files not under /state"; exit 1; }
if find "$AGENT_HOME" -name welcome.md 2>/dev/null | grep -q .; then
  echo "FAIL: demo file found under the agent home"; exit 1
fi
echo "no demo files under the agent home: OK"

printf '\n===== ALL LINUX-KERNEL E2E STEPS PASSED =====\n'
INNER

echo "==> docker-linux-e2e: PASS"
