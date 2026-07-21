---
name: ui
description: Open the local pipeline dashboard in the browser — one shared daemon per machine showing live iteration progress, blocker trees, recent events, and per-run analytics across all projects. Use when the user wants to see what's running or watch a chain execute.
user-invocable: true
allowed-tools: Bash, Read
argument-hint: (optional) project name to focus on
---

# Pipeline UI

You are opening the local pipeline dashboard. It runs as a single shared Bun daemon that aggregates every project on this machine that uses the pipeline plugin.

## What the dashboard shows

- **All registered projects** in a picker — switch between them without restarting anything.
- **Active runs** for the selected project: which iteration is in flight, elapsed time, status (running / improving docs / extracting script / awaiting blocker).
- **Blocker children** nested under their parent run.
- **Iteration tree** with completed / current / pending markers.
- **Live event stream** — tails the journal in real-time via Server-Sent Events.
- **Light / dark theme switcher** with animated transitions.

The dashboard is read-only. It never writes to project files; it only reads `<project>/.claude/pipeline/.runtime/events.jsonl` and the pipeline manifests.

## Procedure

The bundled `pipeline ui` CLI subcommand does the whole launch: it detects a
running daemon (or starts the supervisor detached if none is up), registers the
current project, and prints the dashboard URL. You do NOT spawn the daemon by
hand or duplicate its detection logic — just call the launcher.

1. **Run the launcher.** Add `--open` only when the user explicitly asked to open
   a browser (most invocations just want the URL):

   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/apps/pipeline-cli/src/cli.ts" ui
   ```

   It prints `▶ Pipeline UI:  http://127.0.0.1:<port>/`. On success it exits 0; on
   failure (Bun missing, or the daemon didn't come up within 6s) it exits non-zero
   and prints a one-line reason. Show the URL it printed.

2. **If the launcher fails because Bun is missing**, tell the user the UI requires
   Bun (https://bun.sh) and stop — do NOT try to install it for them.

3. **If the current project has no `.claude/pipeline/` directory** yet, the
   launcher notes it; pass that along — nothing will appear until they run
   `/pipeline:design` or `/pipeline:run` somewhere.

### What `pipeline ui` does under the hood (for reference — don't reimplement)

- Reads `~/.claude/pipeline-ui/daemon.lock` (`pid`, `port`, `host`,
  `supervisor_pid`); if the pid is alive and `/api/health` responds, it reuses
  that daemon.
- Otherwise it spawns the **supervisor** (`apps/pipeline-ui/supervisor.ts`)
  detached — the supervisor owns the worker and restarts it across crashes and
  version handoffs — and waits up to ~6s for the lock to appear. (To fully STOP a
  running daemon, signal `supervisor_pid`, and on Windows the worker `pid` too;
  killing only the worker makes the supervisor respawn it.)
- POSTs the current cwd to `/api/register-cwd` (the daemon resolves worktree →
  main repo internally) when the project uses the pipeline plugin. The
  `SessionStart` hook normally registers projects at session boot; this covers
  the mid-session-install case so the project shows up without a Claude restart.

If `${CLAUDE_PLUGIN_ROOT}` is not set in your environment, `pipeline ui` still
locates the daemon by walking up from the CLI's own directory.

## Notes

- The UI/analytics system is **on by default** — no setup needed. A user can opt out with `PIPELINE_UI_ENABLED=0` (or `false`/`no`/`off`); when opted out, `pipeline ui` prints an opt-out notice (with how to re-enable) instead of starting the daemon, and `pipeline logs -f` still tails events in the terminal with no daemon. The enable default does NOT affect the host/token binding: the daemon always binds 127.0.0.1 only unless `PIPELINE_UI_HOST` + a mandatory `PIPELINE_UI_TOKEN` are set.
- The daemon binds to **127.0.0.1 only** and picks a high random-ish port in the IANA ephemeral range (49152–65535). It is not network-exposed.
- The daemon serves **all projects on this machine** — opening the UI from one project automatically shows the others. The project picker in the top bar switches between them.
- The daemon auto-shuts-down after 60 minutes of no events and no browser clients (configurable via `PIPELINE_UI_IDLE_MINUTES`).
- A `SessionStart` hook in this plugin also launches the daemon automatically when Claude Code starts in any project that has `.claude/pipeline/`. So in practice this skill rarely needs to *start* the daemon — most users just need the URL.
- Bun is required (it already runs the bundled `pipeline` CLI); the UI promotes it to a hard requirement only if you use the UI.
