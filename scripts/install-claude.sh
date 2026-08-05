#!/usr/bin/env bash
#
# Installs Claude Code into the image.
#
# The official one-liner (`curl https://claude.ai/install.sh | bash`) downloads
# the ~290 MB native binary and then runs `claude install`, which downloads it a
# second time — roughly 580 MB per build. It also uses `curl -fsSL`: no timeout,
# no retry, and completely silent, so on a slow link the build looks identical
# whether it is progressing or dead.
#
# This does the same thing once, with progress, retries and stall detection, and
# falls back to the official installer if anything about the layout surprises it.
set -euo pipefail

VERSION="${1:-latest}"
DEST="${CLAUDE_INSTALL_HOME:-/opt/claude}"
BASE="${CLAUDE_DOWNLOAD_BASE_URL:-https://downloads.claude.ai/claude-code-releases}"

say() { printf 'cc-docker: %s\n' "$*"; }

official_installer() {
  say "falling back to the official installer"
  if [ "$VERSION" = "latest" ]; then
    curl -fsSL https://claude.ai/install.sh | env HOME="$DEST" bash
  else
    curl -fsSL https://claude.ai/install.sh | env HOME="$DEST" bash -s -- "$VERSION"
  fi
}

command -v jq >/dev/null 2>&1 || { official_installer; exit $?; }

case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) say "unsupported architecture $(uname -m)"; official_installer; exit $? ;;
esac
if ldd /bin/ls 2>&1 | grep -q musl; then platform="linux-${arch}-musl"; else platform="linux-${arch}"; fi

# Short metadata requests: fail fast rather than hang.
META=(curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 120)

direct_install() {
  local version checksum url expected tmp attempt size

  if [ "$VERSION" = "latest" ]; then
    version="$("${META[@]}" "$BASE/latest")" || return 1
  else
    version="$VERSION"
  fi
  case "$version" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) say "unexpected version response from the download service"; return 1 ;;
  esac

  checksum="$("${META[@]}" "$BASE/$version/manifest.json" | jq -r ".platforms[\"$platform\"].checksum // empty")" || return 1
  case "$checksum" in
    [a-f0-9]*) [ "${#checksum}" -eq 64 ] || return 1 ;;
    *) say "no checksum for $platform in the manifest"; return 1 ;;
  esac

  url="$BASE/$version/$platform/claude"
  expected="$("${META[@]}" -I "$url" | awk 'tolower($1)=="content-length:"{gsub(/\r/,"",$2); print $2}' | tail -1)"
  say "installing Claude Code $version ($platform, ${expected:-unknown} bytes)"
  say "a network that inspects TLS re-encrypts every byte of this, so expect several minutes"

  tmp=/tmp/claude-download
  : > "$tmp"

  for attempt in 1 2 3; do
    # --speed-limit/--speed-time turn a silently stalled transfer into an error
    # instead of an indefinite hang; -C - resumes rather than restarting 290 MB.
    # --no-progress-meter rather than -s: curl's own \r meter is unreadable in
    # build logs, but its error messages still need to come through.
    curl -fL -C - --no-progress-meter --connect-timeout 30 \
      --speed-limit 2048 --speed-time 120 -o "$tmp" "$url" &
    local pid=$!

    # Buildkit collapses \r progress bars, so emit a fresh line periodically:
    # this is what tells "slow" apart from "hung".
    while kill -0 "$pid" 2>/dev/null; do
      sleep 15
      size="$(stat -c %s "$tmp" 2>/dev/null || echo 0)"
      if [ -n "$expected" ] && [ "$expected" -gt 0 ] 2>/dev/null; then
        say "downloaded $((size / 1048576)) MiB of $((expected / 1048576)) MiB ($((size * 100 / expected))%)"
      else
        say "downloaded $((size / 1048576)) MiB"
      fi
    done

    if wait "$pid"; then break; fi
    if [ "$attempt" -eq 3 ]; then
      say "download failed after $attempt attempts"
      return 1
    fi
    say "download interrupted, resuming (attempt $((attempt + 1)) of 3)"
    sleep 5
  done

  say "verifying checksum"
  echo "$checksum  $tmp" | sha256sum -c - >/dev/null || { say "checksum mismatch"; return 1; }

  # Same layout the official installer produces: the binary lives under
  # versions/<version> and the launcher is a symlink to it.
  mkdir -p "$DEST/.local/bin" "$DEST/.local/share/claude/versions"
  install -m 0755 "$tmp" "$DEST/.local/share/claude/versions/$version"
  ln -sf "$DEST/.local/share/claude/versions/$version" "$DEST/.local/bin/claude"
  rm -f "$tmp"

  # Prove the layout guess was right before committing to it.
  local reported
  reported="$("$DEST/.local/bin/claude" --version 2>/dev/null || true)"
  case "$reported" in
    *"$version"*) say "installed $reported" ;;
    *) say "installed binary did not report version $version (got '${reported:-nothing}')"; return 1 ;;
  esac
}

if ! direct_install; then
  rm -f /tmp/claude-download
  official_installer
fi
