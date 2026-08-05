#!/usr/bin/env bash
# Container entrypoint. Runs as root, prepares the runtime, then drops to a
# user that matches the host's uid/gid before handing over to Claude Code.
set -euo pipefail

log() { [ "${DOCLAUDE_QUIET:-0}" = "1" ] || printf 'cc-docker: %s\n' "$*" >&2; }
die() { printf 'cc-docker: %s\n' "$*" >&2; exit 1; }

: "${HOME:?HOME must be set by the launcher}"
: "${DOCLAUDE_USER:=claude}"
HOST_UID="${DOCLAUDE_UID:-1000}"
HOST_GID="${DOCLAUDE_GID:-1000}"

# ---------------------------------------------------------------------------
# user matching
#
# On Linux bind mounts preserve numeric ownership, so the container user must
# share the host's uid to be able to write to the mounted home. On Docker
# Desktop ownership is virtualised and this is merely cosmetic — but harmless.
# ---------------------------------------------------------------------------

group_name="$(getent group "$HOST_GID" | cut -d: -f1 || true)"
if [ -z "$group_name" ]; then
  group_name="$DOCLAUDE_USER"
  groupadd -g "$HOST_GID" "$group_name" 2>/dev/null || group_name="$(getent group "$HOST_GID" | cut -d: -f1)"
fi

user_name="$(getent passwd "$HOST_UID" | cut -d: -f1 || true)"
if [ -z "$user_name" ]; then
  user_name="$DOCLAUDE_USER"
  # macOS accounts start at uid 501, which useradd warns about on every run.
  # The warning is cosmetic; real failures still surface.
  useradd -u "$HOST_UID" -g "$HOST_GID" -d "$HOME" -s /bin/bash -M "$user_name" \
    2> >(grep -v 'outside of the UID_MIN' >&2)
else
  # Reuse the pre-existing account (the node image already owns uid 1000) but
  # point it at the mounted home directory.
  usermod -d "$HOME" -s /bin/bash "$user_name" 2>/dev/null || true
fi

if [ "${DOCLAUDE_SUDO:-1}" = "1" ]; then
  printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$user_name" > /etc/sudoers.d/doclaude
  chmod 0440 /etc/sudoers.d/doclaude
fi

# The mounted home belongs to the user already; never chown it — that would
# rewrite ownership across the user's real filesystem.
[ -d "$HOME" ] || die "home directory $HOME is not mounted into the container"

# ---------------------------------------------------------------------------
# PATH shims for host-only commands
# ---------------------------------------------------------------------------

PROTECTED=" sh bash env node npm npx python3 git ls cat rm cp mv chmod chown sudo gosu claude "
if [ -n "${DOCLAUDE_SHIM_COMMANDS:-}" ]; then
  IFS=',' read -ra _shims <<< "$DOCLAUDE_SHIM_COMMANDS"
  for cmd in "${_shims[@]}"; do
    cmd="$(printf '%s' "$cmd" | tr -d '[:space:]')"
    [ -n "$cmd" ] || continue
    case "$PROTECTED" in
      *" $cmd "*)
        log "refusing to shim '$cmd' — it would shadow a container built-in"
        continue
        ;;
    esac
    ln -sf /opt/doclaude/shims/host-cmd "/usr/local/bin/$cmd"
  done
fi

# ---------------------------------------------------------------------------
# container-private caches
#
# The host home is mounted read-write, so an unguarded npm/uv/pip cache would be
# shared between a macOS host and a Linux container and quietly serve the wrong
# native binaries to one of them.
# ---------------------------------------------------------------------------

CACHE_ROOT="${DOCLAUDE_DIR:-$HOME/.cc-docker}/container-cache"
export XDG_CACHE_HOME="$CACHE_ROOT/xdg"
export npm_config_cache="$CACHE_ROOT/npm"
export UV_CACHE_DIR="$CACHE_ROOT/uv"
export PIP_CACHE_DIR="$CACHE_ROOT/pip"
export PLAYWRIGHT_BROWSERS_PATH="$CACHE_ROOT/playwright"
mkdir -p "$XDG_CACHE_HOME" "$npm_config_cache" "$UV_CACHE_DIR" "$PIP_CACHE_DIR" \
         "${CLAUDE_CONFIG_DIR:-$HOME/.cc-docker/claude}"
chown -R "$HOST_UID:$HOST_GID" "$CACHE_ROOT" 2>/dev/null || true

export BROWSER=/usr/local/bin/ccd-open

# BASH_ENV is what makes the host fallback reach Claude Code's Bash tool: that
# tool runs non-interactive shells, which read neither /etc/profile nor ~/.bashrc.
export BASH_ENV=/opt/doclaude/bashenv.sh
export DOCLAUDE_HOST_FALLBACK="${DOCLAUDE_HOST_FALLBACK:-1}"

# Claude Code snapshots the user's shell to reproduce their environment. Point
# it at the container's bash rather than whatever $SHELL the host reported.
export SHELL=/bin/bash

exec gosu "$user_name" /opt/doclaude/run-user.sh "$@"
