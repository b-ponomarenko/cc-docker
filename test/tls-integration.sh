#!/usr/bin/env bash
#
# Integration test for extra root certificates (TLS-inspecting networks).
#
# A corporate proxy cannot be conjured up in a test, but the situation it
# creates can: a server presenting a certificate signed by a root the container
# has never seen. This stands up exactly that, then checks both paths that
# matter — the system trust store (curl, uv, the build itself) and
# NODE_EXTRA_CA_CERTS (node, npx, Claude Code).
#
# It also runs the negative case first, so a pass means something.
#
#   ./test/tls-integration.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${DOCLAUDE_TEST_IMAGE:-cc-docker:tls-test}"
WORK="$(mktemp -d)"
PORT="${DOCLAUDE_TEST_PORT:-8443}"
SERVER_PID=""

if [ -t 1 ]; then GREEN=$'\033[32m'; RED=$'\033[31m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else GREEN=""; RED=""; BOLD=""; RESET=""; fi

pass() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
fail() { printf '  %s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
step() { printf '\n%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
  docker rmi -f "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

DOCKER="${DOCLAUDE_TEST_DOCKER:-docker}"
command -v "$DOCKER" >/dev/null || fail "no container runtime on PATH"
command -v openssl >/dev/null || fail "openssl is required"

# ---------------------------------------------------------------------------
step "Creating a private root CA and a server certificate for host.docker.internal"
# ---------------------------------------------------------------------------

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 2 \
  -keyout "$WORK/ca.key" -out "$WORK/ca.crt" \
  -subj "/CN=cc-docker test root" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -sha256 \
  -keyout "$WORK/srv.key" -out "$WORK/srv.csr" \
  -subj "/CN=host.docker.internal" >/dev/null 2>&1
openssl x509 -req -in "$WORK/srv.csr" -CA "$WORK/ca.crt" -CAkey "$WORK/ca.key" \
  -CAcreateserial -out "$WORK/srv.crt" -days 2 -sha256 \
  -extfile <(printf 'subjectAltName=DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1\n') \
  >/dev/null 2>&1
pass "root CA and leaf certificate issued"

# ---------------------------------------------------------------------------
step "Starting an HTTPS server signed by that root"
# ---------------------------------------------------------------------------

cat > "$WORK/server.mjs" <<'EOF'
import https from 'node:https';
import fs from 'node:fs';
const [key, cert, port] = [process.argv[2], process.argv[3], Number(process.argv[4])];
https
  .createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('INTERCEPTED-OK\n');
  })
  .listen(port, '127.0.0.1', () => console.log(`listening on ${port}`));
EOF
node "$WORK/server.mjs" "$WORK/srv.key" "$WORK/srv.crt" "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
sleep 1
kill -0 "$SERVER_PID" 2>/dev/null || fail "the test HTTPS server did not start (port $PORT in use?)"
pass "listening on 127.0.0.1:$PORT"

URL="https://host.docker.internal:$PORT/"
RUN_ARGS=(run --rm --add-host host.docker.internal:host-gateway --entrypoint bash)

# ---------------------------------------------------------------------------
step "Negative control: an image without the root must reject the connection"
# ---------------------------------------------------------------------------

rm -f "$REPO"/certs/*.crt
"$DOCKER" build -q -t "$IMAGE" "$REPO" >/dev/null
if "$DOCKER" "${RUN_ARGS[@]}" "$IMAGE" -c "curl -sS -m 10 -o /dev/null $URL" 2>/dev/null; then
  fail "curl trusted an unknown root — the test cannot prove anything"
fi
pass "curl refuses the untrusted root, as it should"

if "$DOCKER" "${RUN_ARGS[@]}" "$IMAGE" -c "node -e 'fetch(\"$URL\").then(()=>process.exit(0)).catch(()=>process.exit(1))'" 2>/dev/null; then
  fail "node trusted an unknown root — the test cannot prove anything"
fi
pass "node refuses the untrusted root, as it should"

# ---------------------------------------------------------------------------
step "Build-time trust: the root in certs/ reaches the system store"
# ---------------------------------------------------------------------------

mkdir -p "$REPO/certs"
cp "$WORK/ca.crt" "$REPO/certs/extra-ca.crt"
"$DOCKER" build -q -t "$IMAGE" "$REPO" >/dev/null

out="$("$DOCKER" "${RUN_ARGS[@]}" "$IMAGE" -c "curl -sS -m 10 $URL" 2>&1)" \
  || fail "curl still rejects the root after it was baked in: $out"
[ "$out" = "INTERCEPTED-OK" ] || fail "unexpected response body: $out"
pass "curl trusts the baked-in root (this is the path the image build itself uses)"

# ---------------------------------------------------------------------------
step "Runtime trust: NODE_EXTRA_CA_CERTS covers node, npx and Claude Code"
# ---------------------------------------------------------------------------

# Deliberately built *without* the root, to prove the runtime path stands alone.
rm -f "$REPO"/certs/*.crt
"$DOCKER" build -q -t "$IMAGE" "$REPO" >/dev/null

out="$("$DOCKER" run --rm --add-host host.docker.internal:host-gateway \
  -v "$WORK/ca.crt:/tmp/ca.crt:ro" -e NODE_EXTRA_CA_CERTS=/tmp/ca.crt \
  --entrypoint bash "$IMAGE" \
  -c "node -e 'fetch(\"$URL\").then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{console.error(e.message);process.exit(1)})'" 2>&1)" \
  || fail "node still rejects the root with NODE_EXTRA_CA_CERTS set: $out"
[ "$out" = "INTERCEPTED-OK" ] || fail "unexpected response body: $out"
pass "node trusts the root via NODE_EXTRA_CA_CERTS"

# ---------------------------------------------------------------------------
step "Runtime refresh: the entrypoint installs a root added after the build"
# ---------------------------------------------------------------------------

out="$("$DOCKER" run --rm --add-host host.docker.internal:host-gateway \
  -v "$WORK/ca.crt:/tmp/ca.crt:ro" \
  -e DOCLAUDE_CA_BUNDLE=/tmp/ca.crt -e HOME=/root -e DOCLAUDE_UID=0 -e DOCLAUDE_GID=0 \
  -e DOCLAUDE_SHELL=1 -e DOCLAUDE_QUIET=1 -e CLAUDE_CONFIG_DIR=/tmp/cfg \
  "$IMAGE" "curl -sS -m 10 $URL" 2>&1 | tail -1)" \
  || fail "the entrypoint did not refresh the trust store: $out"
[ "$out" = "INTERCEPTED-OK" ] || fail "unexpected response body after runtime refresh: $out"
pass "curl trusts a root supplied only at runtime — no rebuild needed"

printf '\n%sAll TLS interception checks passed.%s\n\n' "$GREEN$BOLD" "$RESET"
