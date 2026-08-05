#!/usr/bin/env bash
# Second half of the entrypoint, running as the unprivileged user.
set -euo pipefail

log() { [ "${DOCLAUDE_QUIET:-0}" = "1" ] || printf 'cc-docker: %s\n' "$*" >&2; }

# Build CLAUDE_CONFIG_DIR out of the host's Claude Code installation.
if ! node /opt/doclaude/setup-config.mjs; then
  printf 'cc-docker: config setup failed; continuing with whatever is already there\n' >&2
fi

# Reverse tunnel to the host. Started before Claude Code so that an immediate
# `/login` finds the channel ready.
if [ -n "${DOCLAUDE_AGENT_PORT:-}" ]; then
  node /opt/doclaude/bin/ccd-relay.mjs &
  relay_pid=$!
  trap 'kill "$relay_pid" 2>/dev/null || true' EXIT

  # Give the relay a moment to register with the agent; without it the very
  # first OAuth callback would have nowhere to land.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$relay_pid" 2>/dev/null || break
    sleep 0.1
  done
fi

# Deliberately *not* login shells: the mounted host home carries the user's own
# dotfiles, which describe the host OS and would put host binaries back on PATH.
# bashenv.sh gives these shells the container's environment instead.
if [ "${DOCLAUDE_SHELL:-0}" = "1" ]; then
  if [ "$#" -gt 0 ]; then exec /bin/bash -c "$*"; fi
  exec /bin/bash
fi

# Absolute path, so no PATH surprise can pick a different (or host) binary.
exec /usr/local/bin/claude "$@"
