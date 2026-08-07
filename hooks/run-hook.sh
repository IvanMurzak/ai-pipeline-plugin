#!/bin/sh
# hooks/run-hook.sh — resolves an absolute `pipeline` binary and execs it with
# the arguments this plugin's hooks.json passes (always `hook <name>`).
#
# WHY THIS EXISTS: Claude Code runs plugin hook commands through
# non-interactive /bin/sh, which does NOT source ~/.zshrc or ~/.bash_profile.
# On macOS a global install lands in ~/.bun/bin by default and PATH only gains
# that entry from the interactive shell's rc file — so when Claude Code is
# launched from the Dock/Finder (not a terminal), the hook subprocess's
# inherited PATH has no `pipeline` on it and a bare `pipeline hook <name>`
# hook command fails with "/bin/sh: pipeline: command not found". Windows is
# better positioned: its installer writes to a directory on the machine-wide
# PATH, which every process inherits regardless of how it was launched — and
# under the MSYS `sh` Claude Code uses there, BOTH `command -v pipeline` and
# `[ -x "$HOME/.bun/bin/pipeline" ]` resolve the `pipeline.exe` the installer
# actually writes, so no `.exe` special-casing is needed here (verified, not
# assumed — plugin-thin `p6` / T-CLI-2).
#
# WHAT IT RESOLVED BEFORE, AND WHY THAT CHANGED: until plugin-thin `p6` this
# same shim resolved `bun`, because the hooks were `.ts` relay scripts shipped
# inside this plugin and run as `bun <relay>.ts`. The relays are now
# subcommands of the CLI itself (`pipeline hook <name>`, in the separate
# `IvanMurzak/pipeline` repository), so a hook's version is the CLI's version
# by construction. The shim SURVIVES UNCHANGED IN SHAPE — same probe order,
# same exec, same `--loud` contract — it just resolves a different binary. Do
# not delete it; the failure it prevents has nothing to do with which binary
# is at the end of it.
#
# This script is POSIX sh — macOS /bin/sh is NOT bash: no `[[ ]]`, no
# arrays, no `source`. It resolves the binary's absolute path itself, before
# any JS runs (the failure this fixes happens before a JS runtime exists to
# help), then `exec`s straight into it so stdin/stdout/stderr/exit-code pass
# through to the relay completely untouched — Claude Code feeds hook JSON on
# stdin and inspects the relay's own stdout/exit code, so nothing here may
# buffer, wrap, or swallow them.
#
# Usage: run-hook.sh [--loud] <args passed to `pipeline`>
#   --loud   pipeline-not-found prints ONE actionable line to stderr before
#            exiting 0. Reserved for SessionStart, which fires once per
#            session and is where a user can actually see and act on it.
#            After `p6` the plugin genuinely REQUIRES an installed CLI — it
#            ships no code of its own any more — so that line is the whole
#            safety net for a user who has not installed one, and it names
#            the install command rather than merely reporting absence.
#   (default / no flag) pipeline-not-found exits 0 with NO output — used for
#            every other hook type. PreToolUse/PostToolUse/UserPromptSubmit
#            fire on nearly every turn; printing there would flood the
#            session, which is worse than the silent no-op these non-blocking
#            hooks already degrade to when disabled.
#
# Resolution order (first hit wins — never regresses a machine where the CLI
# already works today):
#   1. pipeline already on PATH          (command -v pipeline)
#   2. "$BUN_INSTALL/bin/pipeline"       (bun's own env var, if set)
#   3. "$HOME/.bun/bin/pipeline"         (default bun global-install location)
#   4. /opt/homebrew/bin/pipeline        (Homebrew, Apple Silicon)
#   5. /usr/local/bin/pipeline           (Homebrew Intel / common Linux, and
#                                         npm's default global prefix there)

mode="quiet"
if [ "${1:-}" = "--loud" ]; then
  mode="loud"
  shift
fi

if [ -z "${1:-}" ]; then
  # Nothing to run — misconfigured hooks.json entry, not our problem to report.
  exit 0
fi

PIPELINE_BIN=""

if command -v pipeline >/dev/null 2>&1; then
  PIPELINE_BIN="$(command -v pipeline)"
elif [ -n "${BUN_INSTALL:-}" ] && [ -x "$BUN_INSTALL/bin/pipeline" ]; then
  PIPELINE_BIN="$BUN_INSTALL/bin/pipeline"
elif [ -n "${HOME:-}" ] && [ -x "$HOME/.bun/bin/pipeline" ]; then
  PIPELINE_BIN="$HOME/.bun/bin/pipeline"
elif [ -x /opt/homebrew/bin/pipeline ]; then
  PIPELINE_BIN="/opt/homebrew/bin/pipeline"
elif [ -x /usr/local/bin/pipeline ]; then
  PIPELINE_BIN="/usr/local/bin/pipeline"
fi

if [ -z "$PIPELINE_BIN" ]; then
  if [ "$mode" = "loud" ]; then
    printf '%s\n' "pipeline plugin: the 'pipeline' CLI is not installed (checked PATH, \$BUN_INSTALL/bin, ~/.bun/bin, /opt/homebrew/bin, /usr/local/bin) - install it with 'bun add -g @baizor/pipeline' (or 'npm i -g @baizor/pipeline'), or set BUN_INSTALL to its install directory; this plugin needs it for every skill, agent and hook" >&2
  fi
  exit 0
fi

exec "$PIPELINE_BIN" "$@"
