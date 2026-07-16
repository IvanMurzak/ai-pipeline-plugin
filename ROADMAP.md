# Claude-Pipeline — Roadmap / optional follow-ups

Tracks **optional** work deferred after the 2026-06 CLI-consolidation + routing
redesign. Both follow-ups below are now **DONE** (plugin `0.47.0 → 0.48.0`); the
remaining open items are install-only validation gaps. Each item is
self-contained enough to pick up cold in a future session.

## Where things stand (done — for context)

The plugin shipped a unified local CLI and a declarative routing redesign across
6 merged PRs (#33–#38), plugin `0.43.0 → 0.47.0`, marketplace `→ 0.12.16`:

- **Unified CLI** `apps/pipeline-cli/` (TypeScript, run with Bun, no build step
  for plugin use): commands `plan | match | event | route`. **Python is fully
  gone** from the runtime and CI (`match.py`, `writer.py`, `matcher-smoke.py`
  deleted; CI is 4 jobs). Library exports in `src/index.ts` + `bun run build` →
  `dist/cli.mjs` for embedding in other local projects.
- **Routing redesign (Variant A)** — opt-in declarative routing: a `## Graph`
  JSON block in `PIPELINE.md` (nodes → conditional edges `{when, goto|done,
  max}`); `pipeline route` evaluates graph + the just-finished step's
  `result_flags` + per-run edge counters (`<pipeline_root>/.runtime/<run_id>/route.json`,
  gitignored) → next action. Wired into the agents: `step-executor` reports
  `### result_flags`; `pipeline-manager` drives a graph pipeline off `pipeline
  route` instead of `next_iteration`; `pipeline-designer` Authoring Principle 13
  (12 when this shipped; renumbered by 0.71's script-steps principle insertion)
  authors graphs. Bounded-retry/counter is now declarative (loop counter lives
  in the graph, not in step bodies). Legacy (no `## Graph`) pipelines are
  untouched. Validated with a live end-to-end smoke.

- **Mechanical manager + CLI completion (`0.48.0`)** — the two follow-ups below.
  `pipeline next` (the orchestration state machine) and `pipeline ui` (the
  dashboard launcher) landed, so the CLI surface is now
  `plan | match | event | route | next | ui` and the `pipeline-manager` is a thin
  actuator over `pipeline next`.

Runtime dependency is now **Bun** (Python dropped). See `CLAUDE.md` for the full
maintainer contract; `apps/pipeline-cli/README.md` for the CLI.

---

## Follow-up 1 — `pipeline ui` (fold the dashboard daemon into the CLI) ✅ DONE (0.48.0)

Shipped the thin-launcher approach. `pipeline ui [--open] [--json]`
(`apps/pipeline-cli/src/commands/ui.ts`) detects a running daemon via
`~/.claude/pipeline-ui/daemon.lock` + `/api/health`, spawns the **supervisor**
(`apps/pipeline-ui/supervisor.ts`) detached when none is up (mirroring
`hooks/pipeline_ui_relay.ts:spawnDaemon`), `POST`s the cwd to
`/api/register-cwd` when the project uses the plugin, and prints the URL.
`/pipeline:ui` (`skills/ui/SKILL.md`) now routes through it; the `SessionStart`
hook still launches the supervisor directly (unchanged). The daemon's
single-instance / version-reconcile / supervisor-handoff / liveness machinery was
NOT touched. The launcher resolves the daemon via `${CLAUDE_PLUGIN_ROOT}` or by
walking up from the CLI's own dir, so it works both plugin-installed and embedded
(the decision the ROADMAP flagged). Pure helpers unit-tested in `tests/ui.test.ts`;
the spawn/fetch path is integration (like the `event.ts` daemon-ping).

---

## Follow-up 2 — fully-mechanical `pipeline-manager` ✅ DONE (0.48.0)

Shipped `pipeline next` (`apps/pipeline-cli/src/lib/next.ts` +
`src/commands/next.ts`) — a deterministic orchestration state machine that owns
ALL run control flow: sequential advancement (off the step's `next_iteration`),
graph routing (it consumes `routeNext()` and persists the per-edge counters in
its own `next.json`, so it does NOT shell out to `pipeline route`), DAG-layer
stepping, Tier-1 improver / script-creator gating, the end-of-run retrospective
gate (it counts `<root>/.feedback/<run-id>/*.md` itself), and the terminal
`done`/`halt`/`blocked` decision. Each call returns ONE action (`run-step` /
`merge` / `run-improver` / `run-script-creator` / `retrospective` / `done` /
`halt` / `blocked`) and the manager records the outcome (`--record '<json>'`) to
advance.

`agents/pipeline-manager.md` was rewritten from decision-maker to **thin
actuator**: `action ← pipeline next; do(action); record outcome; repeat`. It no
longer decides anything about control flow, builds DAGs, routes graphs, or gates
the improver/retrospective in prose — it spawns subagents, parses their LLM
reports, runs `git merge`, runs the retrospective's batch improver work, relays
blockers, and emits the SAME UI events as before. **All other contracts are
unchanged** (events, feedback-file shapes, the Step Executor / Manager Final
Reports, the nested-blocker flow, backward-compat for legacy/graph/parallel
pipelines) — only the manager's *decision-making* moved into tested code.

The ROADMAP cautioned this was "a large contract change for modest token
savings" and that blocker delegation / parallel merges "benefit from the LLM's
flexibility." Resolution: the deterministic decisions (advancement, gating,
terminal) moved into `pipeline next`; the LLM-flavored work (the actual spawns,
report parsing, `git merge`, the retrospective's batch improver, blocker relay)
stayed in the manager, which is exactly where the ROADMAP wanted it. `--resume`
(and any no-record call on an existing run) re-enters at `--start`, covering both
nested-blocker resumes and crashed-manager re-spawns; graph loop counters survive
re-entry. The engine is exhaustively unit-tested in `tests/next.test.ts`
(sequential/graph/parallel advancement, improver+script gating, retrospective
gate, halt/blocked/resume, merge conflict, plan-error halt).

**Validation note.** The CLI engine is unit-tested here, but the manager doc
rewrite — like the routing redesign before it — could only be validated against
the agent prose in this non-installed dev repo. A live end-to-end run inside a
project where the plugin is actually installed (see the validation gaps below)
would exercise the real manager↔`pipeline next` loop. Worth doing once.

---

## Validation gaps (not bugs — things not verifiable in a non-installed dev session)

- The routing redesign was validated by unit tests + a **simulated** live smoke
  (the plugin isn't installed as active skills/agents in the marketplace dev
  repo, so the smoke played supervisor/manager by hand and spawned
  general-purpose agents that READ the real agent `.md` files). A run inside a
  project where the plugin is actually **installed** would exercise the real
  `subagent_type` dispatch end-to-end. Worth doing once in a real consumer
  project.
- `effort: max` / `model: opus` frontmatter honoring on the brain agents
  (designer/improver/script-creator) is only applied when Claude Code loads them
  as registered subagents — verify in an installed session if those agents ever
  seem not to run at max reasoning. (`model:` pinning works independently of
  `effort:`.)
