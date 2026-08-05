# Sourced by every non-interactive bash in the container (via BASH_ENV) and by
# login shells (via /etc/profile.d), so that Claude Code's Bash tool sees it.

# ---------------------------------------------------------------------------
# PATH hygiene
#
# The host home is mounted at the same absolute path, which means host bin
# directories (~/.local/bin, ~/.cargo/bin, nvm shims, ...) are visible inside
# the container — full of executables built for the *host* OS. Left alone they
# shadow the container's own tools, and `claude` resolves to a macOS Mach-O
# binary that cannot possibly run here.
#
# So: container directories always win, and host-home directories are dropped —
# those tools are still reachable, but through the host bridge, where they can
# actually execute. Applied once per process tree so that anything a build
# script legitimately adds to PATH later survives untouched.
# ---------------------------------------------------------------------------

if [ "${DOCLAUDE_PATH_CLEANED:-0}" != "1" ]; then
  __doclaude_fix_path() {
    local base="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    local out="$base" entry
    local IFS=':'
    for entry in $PATH; do
      case ":$base:" in *":$entry:"*) continue ;; esac
      [ -n "$entry" ] || continue
      if [ "${DOCLAUDE_KEEP_HOME_PATH:-0}" != "1" ] && [ -n "$HOME" ]; then
        case "$entry" in "$HOME"/*) continue ;; esac
      fi
      out="$out:$entry"
    done
    PATH="$out"
    export PATH
  }
  __doclaude_fix_path
  unset -f __doclaude_fix_path
  export DOCLAUDE_PATH_CLEANED=1
fi

# ---------------------------------------------------------------------------
# host command fallback
#
# When a command exists on the host but not in the image — a native CLI, a
# brew-installed tool, a company-internal binary — transparently run it on the
# host instead of failing. The host agent still enforces its allow-list, so this
# widens reach without turning the container into a blank cheque.
# ---------------------------------------------------------------------------

if [ "${DOCLAUDE_HOST_FALLBACK:-1}" = "1" ]; then
  command_not_found_handle() {
    local cmd="$1"
    shift
    if [ -x /usr/local/bin/ccd-host ]; then
      ccd-host "$cmd" "$@"
      local status=$?
      # 1 is how ccd-host reports "the agent refused"; anything else is the
      # host command's own exit status and must be passed through untouched.
      if [ $status -eq 1 ]; then
        printf 'bash: %s: not found in the container, and not permitted on the host.\n' "$cmd" >&2
        printf 'cc-docker: if %s exists on your machine, add it to "shimCommands" in %s/config.json\n' \
          "$cmd" "${DOCLAUDE_DIR:-$HOME/.cc-docker}" >&2
      fi
      return $status
    fi
    printf 'bash: %s: command not found\n' "$cmd" >&2
    return 127
  }
fi
