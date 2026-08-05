# Sourced by every non-interactive bash in the container (via BASH_ENV) and by
# login shells (via /etc/profile.d), so that Claude Code's Bash tool sees it.
#
# Purpose: when a command exists on the host but not in the image — a native CLI,
# a brew-installed tool, a company-internal binary — transparently run it on the
# host instead of failing. The host agent still enforces its allow-list, so this
# widens reach without turning the container into a blank cheque.

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
