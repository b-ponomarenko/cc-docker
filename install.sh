#!/usr/bin/env bash
#
# cc-docker installer — one command from a fresh clone to a working `doclaude`.
#
#   git clone <repo> && cd cc-docker && ./install.sh
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CCD_DIR="${DOCLAUDE_DIR:-$HOME/.cc-docker}"
VERSION="0.1.0"

# ---------------------------------------------------------------------------
# options
# ---------------------------------------------------------------------------

DO_BUILD=1
NO_CACHE=0
BIN_DIR=""
IMAGE=""
CLAUDE_VERSION=""
MOUNT_PROFILE=""
APT_PACKAGES=""
CA_FILES=()

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

  --no-build              skip building the Docker image
  --no-cache              build the image without the layer cache
  --image NAME            image tag to build/use     (default cc-docker:latest)
  --claude-version VER    pin Claude Code            (default latest)
  --profile home|project  filesystem exposure        (default home)
  --apt "pkg1 pkg2"       extra apt packages in the image
  --ca-file PATH          extra root certificate to trust (repeatable);
                          needed on networks that intercept TLS
  --bin-dir DIR           where to install `doclaude`
  --reinstall             refresh files and rebuild (used by `doclaude self update`)
  -h, --help              this message
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) DO_BUILD=0 ;;
    --no-cache) NO_CACHE=1 ;;
    --reinstall) ;;
    --image) IMAGE="$2"; shift ;;
    --claude-version) CLAUDE_VERSION="$2"; shift ;;
    --profile) MOUNT_PROFILE="$2"; shift ;;
    --apt) APT_PACKAGES="$2"; shift ;;
    --ca-file) CA_FILES+=("$2"); shift ;;
    --bin-dir) BIN_DIR="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# output helpers
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

printf '\n%scc-docker%s — Claude Code in a container, wired to this machine\n\n' "$BOLD" "$RESET"

# ---------------------------------------------------------------------------
# prerequisites
# ---------------------------------------------------------------------------

step "Checking prerequisites"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "Node.js is required on the host (it runs the cc-docker agent). Install Node 18+ and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node 18+ required, found $(node --version)"
ok "node $(node --version) at $NODE_BIN"

DOCKER_BIN=""
for candidate in docker podman nerdctl; do
  if command -v "$candidate" >/dev/null 2>&1; then DOCKER_BIN="$candidate"; break; fi
done
if [ -z "$DOCKER_BIN" ]; then
  cat >&2 <<EOF

  ${RED}✗${RESET} No container runtime found.

    macOS   brew install --cask docker        (or: brew install colima docker && colima start)
    Linux   curl -fsSL https://get.docker.com | sh
    any     https://orbstack.dev  /  https://podman.io

  Install one, make sure it is running, then re-run ./install.sh
EOF
  exit 1
fi

if ! "$DOCKER_BIN" info >/dev/null 2>&1; then
  die "$DOCKER_BIN is installed but its daemon is not running — start it and re-run."
fi
ok "$DOCKER_BIN $("$DOCKER_BIN" info --format '{{.ServerVersion}}' 2>/dev/null || echo '(version unknown)')"

if [ -d "$HOME/.claude" ]; then
  ok "found host Claude Code config at ~/.claude"
else
  warn "no ~/.claude on this host — skills, plugins and MCP servers will be empty until you set them up"
fi

# ---------------------------------------------------------------------------
# layout
# ---------------------------------------------------------------------------

step "Preparing $CCD_DIR"

mkdir -p "$CCD_DIR"/{lib,logs,run,claude,container-cache}
chmod 700 "$CCD_DIR"

if [ ! -f "$CCD_DIR/agent.token" ]; then
  node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$CCD_DIR/agent.token"
  chmod 600 "$CCD_DIR/agent.token"
  ok "generated agent token"
else
  ok "reusing existing agent token"
fi

# Extra root certificates. On a network that inspects TLS, every HTTPS call from
# the build and from the running container is re-signed with a private root that
# a stock Debian image has never heard of.
CA_ARGS=()
for f in ${CA_FILES+"${CA_FILES[@]}"}; do
  [ -f "$f" ] || die "no such certificate file: $f"
  CA_ARGS+=(--ca-file "$f")
done

mkdir -p "$CCD_DIR/certs" "$REPO_DIR/certs"
CA_BUNDLE="$CCD_DIR/certs/extra-ca.crt"
CA_REPORT="$(node "$REPO_DIR/lib/collect-ca.mjs" --out "$CA_BUNDLE" ${CA_ARGS+"${CA_ARGS[@]}"})"
CA_COUNT="$(printf '%s' "$CA_REPORT" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).count))')"

rm -f "$REPO_DIR"/certs/*.crt
if [ "$CA_COUNT" -gt 0 ]; then
  cp "$CA_BUNDLE" "$REPO_DIR/certs/extra-ca.crt"
  ok "trusting $CA_COUNT extra root certificate(s) from this host"
else
  ok "no extra root certificates on this host (standard public trust store)"
fi

# The agent runs from ~/.cc-docker so that deleting the checkout does not break
# an installed doclaude.
rm -rf "$CCD_DIR/lib/host" "$CCD_DIR/lib/shared"
mkdir -p "$CCD_DIR/lib"
cp -R "$REPO_DIR/host" "$CCD_DIR/lib/host"
cp -R "$REPO_DIR/shared" "$CCD_DIR/lib/shared"
ok "installed host agent into $CCD_DIR/lib"

# ---------------------------------------------------------------------------
# configuration
# ---------------------------------------------------------------------------

step "Writing configuration"

GEN_ARGS=(--ccd-dir "$CCD_DIR" --repo "$REPO_DIR" --version "$VERSION")
[ -n "$IMAGE" ] && GEN_ARGS+=(--image "$IMAGE")
[ -n "$CLAUDE_VERSION" ] && GEN_ARGS+=(--claude-version "$CLAUDE_VERSION")
[ -n "$MOUNT_PROFILE" ] && GEN_ARGS+=(--profile "$MOUNT_PROFILE")
[ -n "$APT_PACKAGES" ] && GEN_ARGS+=(--apt "$APT_PACKAGES")

CONFIG_SUMMARY="$(node "$REPO_DIR/lib/gen-config.mjs" "${GEN_ARGS[@]}")"
IMAGE_NAME="$(printf '%s' "$CONFIG_SUMMARY" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).image))')"
PROFILE_NAME="$(printf '%s' "$CONFIG_SUMMARY" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).profile))')"
SHIMS="$(printf '%s' "$CONFIG_SUMMARY" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log((JSON.parse(s).shimCommands||[]).join(", ")||"none"))')"

ok "config at $CCD_DIR/config.json"
ok "mount profile: $PROFILE_NAME"
ok "host commands exposed to the container: $SHIMS"

# ---------------------------------------------------------------------------
# image
# ---------------------------------------------------------------------------

if [ "$DO_BUILD" = "1" ]; then
  step "Building $IMAGE_NAME (first build takes a few minutes)"
  BUILD_ARGS=(build -t "$IMAGE_NAME")
  [ "$NO_CACHE" = "1" ] && BUILD_ARGS+=(--no-cache)
  [ -n "$CLAUDE_VERSION" ] && BUILD_ARGS+=(--build-arg "CLAUDE_VERSION=$CLAUDE_VERSION")
  [ -n "$APT_PACKAGES" ] && BUILD_ARGS+=(--build-arg "EXTRA_APT_PACKAGES=$APT_PACKAGES")
  BUILD_ARGS+=("$REPO_DIR")
  if ! "$DOCKER_BIN" "${BUILD_ARGS[@]}"; then
    printf '\n  %s✗%s Image build failed.\n' "$RED" "$RESET" >&2
    cat >&2 <<EOF

  If the log above mentions ${BOLD}self-signed certificate in certificate chain${RESET} or
  another TLS verification error, this network inspects TLS and the container
  does not yet trust its root certificate.

  Export that root and point the installer at it:

      ./install.sh --ca-file /path/to/corporate-root.crt

  macOS   Keychain Access → System → your organisation's root → Export as .cer,
          or ask IT for the bundle. \`security find-certificate -a -p \\
          /Library/Keychains/System.keychain > roots.crt\` exports them all.
  Linux   usually already in /usr/local/share/ca-certificates or
          /etc/pki/ca-trust/source/anchors — those are picked up automatically.

EOF
    exit 1
  fi
  ok "image built"
else
  step "Skipping image build (--no-build)"
fi

# ---------------------------------------------------------------------------
# the doclaude command
# ---------------------------------------------------------------------------

step "Installing the doclaude command"

# Reuse wherever this machine put doclaude last time, otherwise an update would
# install a second copy in the default location and leave a stale one on PATH.
if [ -z "$BIN_DIR" ]; then
  BIN_DIR="$(node -e 'try{process.stdout.write(require(process.argv[1]).binDir||"")}catch{}' "$CCD_DIR/config.json" 2>/dev/null || true)"
  [ -n "$BIN_DIR" ] && ok "reusing the previous install location $BIN_DIR"
fi

if [ -z "$BIN_DIR" ]; then
  if [ -d "$HOME/.local/bin" ] || mkdir -p "$HOME/.local/bin" 2>/dev/null; then
    BIN_DIR="$HOME/.local/bin"
  elif [ -w /usr/local/bin ]; then
    BIN_DIR="/usr/local/bin"
  else
    BIN_DIR="$CCD_DIR/bin"
    mkdir -p "$BIN_DIR"
  fi
fi
mkdir -p "$BIN_DIR"
install -m 0755 "$REPO_DIR/bin/doclaude" "$BIN_DIR/doclaude"
node -e '
  const fs = require("fs");
  const [file, dir] = process.argv.slice(1);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.binDir = dir;
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
' "$CCD_DIR/config.json" "$BIN_DIR"
ok "installed $BIN_DIR/doclaude"

# ---------------------------------------------------------------------------
# refresh the host agent
#
# The agent was just replaced on disk, but a process started before this run is
# still executing the old code — so an agent fix would not take effect until the
# next reboot. Stop it; the launcher starts a fresh one on demand.
# ---------------------------------------------------------------------------

AGENT_RUN="$CCD_DIR/run/agent.json"
if [ -f "$AGENT_RUN" ]; then
  AGENT_PID="$(node -e 'try{process.stdout.write(String(require(process.argv[1]).pid))}catch{}' "$AGENT_RUN" 2>/dev/null || true)"
  LIVE_SESSIONS="$("$DOCKER_BIN" ps -q --filter 'name=doclaude-' 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${LIVE_SESSIONS:-0}" -gt 0 ]; then
    warn "a doclaude session is running — left the old agent alone so it keeps working"
    warn "when you are done: doclaude self agent restart"
  elif [ -n "$AGENT_PID" ] && kill "$AGENT_PID" 2>/dev/null; then
    rm -f "$AGENT_RUN"
    ok "stopped the previous host agent (a new one starts on the next run)"
  fi
fi

ON_PATH=0
case ":$PATH:" in *":$BIN_DIR:"*) ON_PATH=1 ;; esac

# ---------------------------------------------------------------------------
# done
# ---------------------------------------------------------------------------

printf '\n%sInstalled.%s\n\n' "$GREEN$BOLD" "$RESET"

if [ "$ON_PATH" = "0" ]; then
  printf '  %sAdd this to your shell profile:%s\n\n    export PATH="%s:$PATH"\n\n' "$YELLOW" "$RESET" "$BIN_DIR"
fi

cat <<EOF
  ${BOLD}Next${RESET}
    cd <your project>
    doclaude                    ${DIM}# run Claude Code in the container${RESET}

  ${BOLD}First login${RESET}
    Inside doclaude run ${BOLD}/login${RESET} — your host browser opens automatically and the
    callback is tunnelled back into the container. The token is stored in
    ${DIM}$CCD_DIR/claude/.credentials.json${RESET} and reused on every later run.

    Already logged in on this host? Copy that session instead:
      ${BOLD}doclaude self auth import${RESET}

  ${BOLD}Useful${RESET}
    doclaude self doctor        ${DIM}# verify the whole setup${RESET}
    doclaude self shell         ${DIM}# a shell inside the container${RESET}
    doclaude self config edit   ${DIM}# mounts, MCP policy, host commands${RESET}
    doclaude self rebuild       ${DIM}# rebuild the image${RESET}

EOF
