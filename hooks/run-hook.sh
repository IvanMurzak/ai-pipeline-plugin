#!/bin/sh
# hooks/run-hook.sh — resolves an absolute bun binary and execs it against a
# relay script.
#
# WHY THIS EXISTS: Claude Code runs plugin hook commands through
# non-interactive /bin/sh, which does NOT source ~/.zshrc or ~/.bash_profile.
# On macOS, bun installs to ~/.bun/bin by default and PATH only gains that
# entry from the interactive shell's rc file — so when Claude Code is
# launched from the Dock/Finder (not a terminal), the hook subprocess's
# inherited PATH has no bun on it and a bare `bun "<script>"` hook command
# fails with "/bin/sh: bun: command not found". Windows is unaffected: its
# bun installer writes to the system PATH, which every process inherits
# regardless of how it was launched.
#
# This script is POSIX sh — macOS /bin/sh is NOT bash: no `[[ ]]`, no
# arrays, no `source`. It resolves bun's absolute path itself, before any JS
# runs (the failure this fixes happens before a JS runtime exists to help),
# then `exec`s straight into it so stdin/stdout/stderr/exit-code pass through
# to the relay script completely untouched — Claude Code feeds hook JSON on
# stdin and inspects the relay's own stdout/exit code, so nothing here may
# buffer, wrap, or swallow them.
#
# Usage: run-hook.sh [--loud] <relay-script-path> [args passed to the relay]
#   --loud   bun-not-found prints ONE actionable line to stderr before
#            exiting 0. Reserved for SessionStart, which fires once per
#            session and is where a user can actually see and act on it.
#   (default / no flag) bun-not-found exits 0 with NO output — used for every
#            other hook type. PreToolUse/PostToolUse/UserPromptSubmit fire on
#            nearly every turn; printing there would flood the session, which
#            is worse than the silent no-op these non-blocking hooks already
#            degrade to when disabled.
#
# Resolution order (first hit wins — never regresses a machine where bun
# already works today):
#   1. bun already on PATH             (command -v bun)
#   2. "$BUN_INSTALL/bin/bun"          (the installer's own env var, if set)
#   3. "$HOME/.bun/bin/bun"            (default bun install location)
#   4. /opt/homebrew/bin/bun           (Homebrew, Apple Silicon)
#   5. /usr/local/bin/bun              (Homebrew Intel / common Linux)

mode="quiet"
if [ "${1:-}" = "--loud" ]; then
  mode="loud"
  shift
fi

relay="${1:-}"
if [ -z "$relay" ]; then
  # Nothing to run — misconfigured hooks.json entry, not our problem to report.
  exit 0
fi
shift

BUN_BIN=""

if command -v bun >/dev/null 2>&1; then
  BUN_BIN="$(command -v bun)"
elif [ -n "${BUN_INSTALL:-}" ] && [ -x "$BUN_INSTALL/bin/bun" ]; then
  BUN_BIN="$BUN_INSTALL/bin/bun"
elif [ -n "${HOME:-}" ] && [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_BIN="$HOME/.bun/bin/bun"
elif [ -x /opt/homebrew/bin/bun ]; then
  BUN_BIN="/opt/homebrew/bin/bun"
elif [ -x /usr/local/bin/bun ]; then
  BUN_BIN="/usr/local/bin/bun"
fi

if [ -z "$BUN_BIN" ]; then
  if [ "$mode" = "loud" ]; then
    printf '%s\n' "pipeline plugin: bun not found (checked PATH, \$BUN_INSTALL/bin, ~/.bun/bin, /opt/homebrew/bin, /usr/local/bin) - install it from https://bun.sh, or set BUN_INSTALL to bun's install directory, to restore the pipeline dashboard and notifications" >&2
  fi
  exit 0
fi

exec "$BUN_BIN" "$relay" "$@"
