#!/usr/bin/env bash
#
# Installs Claude Code into the image.
#
# The official one-liner (`curl https://claude.ai/install.sh | bash`) downloads
# the ~290 MB native binary and then runs `claude install`, which downloads it a
# second time — roughly 580 MB per build, under a ten-minute internal deadline
# that a corporate link cannot always meet. It also fetches with `curl -fsSL`:
# no timeout, no retry, and completely silent, so a stalled transfer and a slow
# one look identical, forever.
#
# This does the work once, with progress, resumable retries and stall detection,
# and keeps the partial download in a build cache so a failed build does not
# throw away what it already fetched.
set -euo pipefail

VERSION="${1:-latest}"
DEST="${CLAUDE_INSTALL_HOME:-/opt/claude}"
BASE="${CLAUDE_DOWNLOAD_BASE_URL:-https://downloads.claude.ai/claude-code-releases}"
CACHE_DIR="${CLAUDE_DOWNLOAD_CACHE:-/var/cache/doclaude}"

# When to call a transfer dead. Generous on purpose: scanning proxies routinely
# buffer a whole response before releasing any of it, so minutes of apparent
# silence are normal on those networks, while a real hang lasts forever.
STALL_BYTES="${CLAUDE_DOWNLOAD_STALL_BYTES:-1024}"
STALL_SECONDS="${CLAUDE_DOWNLOAD_STALL_SECONDS:-300}"

say() { printf 'cc-docker: %s\n' "$*"; }

official_installer() {
  say "falling back to the official installer"
  if [ "$VERSION" = "latest" ]; then
    curl -fsSL https://claude.ai/install.sh | env HOME="$DEST" bash
  else
    curl -fsSL https://claude.ai/install.sh | env HOME="$DEST" bash -s -- "$VERSION"
  fi
}

# Exit codes from direct_install:
#   0  installed
#   2  the fast path is unusable here — the official installer is worth a try
#   1  the download itself failed — falling back would just repeat it, slower

command -v jq >/dev/null 2>&1 || { official_installer; exit $?; }

case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) say "unsupported architecture $(uname -m)"; official_installer; exit $? ;;
esac
if ldd /bin/ls 2>&1 | grep -q musl; then platform="linux-${arch}-musl"; else platform="linux-${arch}"; fi

mkdir -p "$CACHE_DIR" 2>/dev/null || CACHE_DIR=/tmp

# Short metadata requests: fail fast rather than hang.
META=(curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 120)

file_size() { stat -c %s "$1" 2>/dev/null || echo 0; }

download_with_progress() {
  local url="$1" tmp="$2" expected="$3"
  local resume=1 status attempt pid size

  # A previous build may have left this file complete, or part-way there.
  if [ -f "$tmp" ] && [ "$(file_size "$tmp")" -gt 0 ]; then
    say "found $(( $(file_size "$tmp") / 1048576 )) MiB from an earlier build, continuing from there"
  fi

  for attempt in 1 2 3; do
    local -a args=(-fL --no-progress-meter --connect-timeout 30
                   --speed-limit "$STALL_BYTES" --speed-time "$STALL_SECONDS")
    # Resume rather than re-fetch 290 MB — but only while the other end has
    # shown it honours byte ranges.
    [ "$resume" = 1 ] && args+=(-C -)

    curl "${args[@]}" -o "$tmp" "$url" &
    pid=$!

    # Buildkit collapses \r progress bars, so emit a fresh line periodically:
    # this is what tells "slow" apart from "hung".
    while kill -0 "$pid" 2>/dev/null; do
      sleep 15
      size="$(file_size "$tmp")"
      if [ -n "$expected" ] && [ "$expected" -gt 0 ] 2>/dev/null; then
        say "downloaded $((size / 1048576)) MiB of $((expected / 1048576)) MiB ($((size * 100 / expected))%)"
      else
        say "downloaded $((size / 1048576)) MiB"
      fi
    done

    status=0
    wait "$pid" || status=$?
    [ "$status" -eq 0 ] && return 0

    # 33 = "server does not support byte ranges". Some inspecting proxies strip
    # Range headers; start over rather than retry a resume that cannot work.
    if [ "$status" -eq 33 ] && [ "$resume" = 1 ]; then
      say "this connection does not support resuming — restarting the download"
      resume=0
      : > "$tmp"
      continue
    fi

    if [ "$attempt" -eq 3 ]; then
      say "download failed after 3 attempts (curl exit $status)"
      return 1
    fi
    say "download interrupted (curl exit $status), retrying (attempt $((attempt + 1)) of 3)"
    sleep 5
  done
}

direct_install() {
  local version checksum url expected tmp reported

  if [ "$VERSION" = "latest" ]; then
    version="$("${META[@]}" "$BASE/latest")" || return 2
  else
    version="$VERSION"
  fi
  case "$version" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) say "unexpected version response from the download service"; return 2 ;;
  esac

  checksum="$("${META[@]}" "$BASE/$version/manifest.json" | jq -r ".platforms[\"$platform\"].checksum // empty")" || return 2
  if [ "${#checksum}" -ne 64 ]; then
    say "no usable checksum for $platform in the manifest"
    return 2
  fi

  url="$BASE/$version/$platform/claude"
  expected="$("${META[@]}" -I "$url" | awk 'tolower($1)=="content-length:"{gsub(/\r/,"",$2); print $2}' | tail -1)" || expected=""
  say "installing Claude Code $version ($platform, ${expected:-unknown} bytes)"

  # Keyed by version and platform so a cached partial is never mistaken for a
  # different build.
  tmp="$CACHE_DIR/claude-$version-$platform.part"

  local complete=0
  if [ -n "$expected" ] && [ "$(file_size "$tmp")" = "$expected" ]; then
    if echo "$checksum  $tmp" | sha256sum -c - >/dev/null 2>&1; then
      say "reusing the complete download from the build cache"
      complete=1
    else
      say "cached download is corrupt — fetching it again"
      : > "$tmp"
    fi
  fi

  if [ "$complete" = 0 ]; then
    say "a network that inspects TLS re-encrypts every byte of this, so expect several minutes"
    download_with_progress "$url" "$tmp" "$expected" || return 1
    say "verifying checksum"
    if ! echo "$checksum  $tmp" | sha256sum -c - >/dev/null; then
      say "checksum mismatch — the download was corrupted in transit"
      rm -f "$tmp"
      return 1
    fi
  fi

  # Same layout the official installer produces: the binary lives under
  # versions/<version> and the launcher is a symlink to it.
  mkdir -p "$DEST/.local/bin" "$DEST/.local/share/claude/versions"
  install -m 0755 "$tmp" "$DEST/.local/share/claude/versions/$version"
  ln -sf "$DEST/.local/share/claude/versions/$version" "$DEST/.local/bin/claude"

  # Prove the layout guess was right before committing to it.
  reported="$("$DEST/.local/bin/claude" --version 2>/dev/null || true)"
  case "$reported" in
    *"$version"*) say "installed $reported" ;;
    *)
      say "installed binary did not report version $version (got '${reported:-nothing}')"
      return 2
      ;;
  esac
}

set +e
direct_install
rc=$?
set -e

case "$rc" in
  0) ;;
  2)
    # The fast path could not be used at all, so the official installer is a
    # genuinely different route and worth trying.
    official_installer
    ;;
  *)
    # The download itself failed. The official installer fetches the same file
    # from the same place, twice, under its own deadline: going through it would
    # burn another twenty minutes to reach the same result.
    say ""
    say "Not falling back to the official installer: it fetches this same file"
    say "twice and would repeat the failure more slowly."
    say ""
    say "If the link is just slow, run the install again — the partial download"
    say "is kept in the build cache and picks up where it stopped."
    say ""
    exit 1
    ;;
esac
