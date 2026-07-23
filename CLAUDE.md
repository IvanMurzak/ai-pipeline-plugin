# CLAUDE.md — pipeline plugin

This file guides Claude Code when working **inside the plugin repository itself** (editing the two agents, the two skills, or the docs). For guidance on using the plugin in a consumer project, see `README.md`.

## Plugin layout

```
.claude-plugin/plugin.json          # plugin manifest
agents/
  pipeline-designer.md              # designs pipelines (no execution)
  pipeline-manager.md               # orchestrates ONE run (depth 1, has Agent): spawns a step-executor per iteration, dispatches improver/script-creator; per-iteration events + external worktree hooks are CLI-executed by `pipeline next` (the manager emits only retrospective events)
  step-executor.md                  # executes ONE iteration in a fresh context and reports to the manager (chain leaf; has Agent for intra-step fan-out ONLY) — formerly pipeline-executor
  pipeline-improver.md              # edits existing iteration/manifest docs based on a step-executor-provided improvement brief
  pipeline-script-creator.md        # extracts heavy procedural Steps blocks into Python scripts under <pipeline-root>/scripts/
  pipeline-disambiguator.md         # cheap LLM tiebreaker (Haiku 4.5) — picks one pipeline among 2-5 ambiguous BM25 candidates
skills/
  design/SKILL.md                   # /pipeline:design   — routes to pipeline-designer
  run/SKILL.md                      # /pipeline:run      — spawns pipeline-manager (which spawns step-executors); chains improver and script-creator after each iteration; emits UI lifecycle events
  dispatch/SKILL.md                 # /pipeline:dispatch — three-tier ladder (`pipeline match` → disambiguator/Haiku → main-session chain detection); auto-runs chosen pipeline(s)
  find/SKILL.md                     # /pipeline:find     — deterministic-only match (BM25 + Scope.Out hard-filter); accepts --issue; asks before running
  ui/SKILL.md                       # /pipeline:ui       — opens the local pipeline dashboard (single shared Bun daemon per machine)
  optimize/SKILL.md                 # /pipeline:optimize — USER-INVOKED ONLY (disable-model-invocation): weekly review of .stats/ measurements → targeted pipeline-improver fixes
apps/
  pipeline-cli/                     # Unified local TypeScript CLI (`pipeline <command>`), run with Bun — deterministic, LLM-free work the agents shell out to
    src/cli.ts                      #   entry; subcommands: `plan`, `match`, `event`, `route`, `next`, `drive`, `step`, `gc`, `ci-wait`, `stats` (+ `stats backfill`), `ui`, `logs`, `submodule`, `release`
    src/commands/drive.ts           #   `pipeline drive` — EXPERIMENTAL interactive headless runner (belt-and-braces step-record recovery: structured_output → tmp drop file (--add-dir grant; .claude/ writes are sensitive-denied headless on claude >= 2.1.21x) → legacy file → result-text; pinned sessions + needs-input answer resume + crash-resume, awaiting_input park journaling, per-step permission modes; see docs/cli.md)
    src/commands/submodule.ts       #   `pipeline submodule bump` — guarded submodule-pointer bump (Phase-1 guarded git primitive; replaces AI-improvised land recipes)
    src/commands/step-run.ts        #   `pipeline step run` — dry-run one `type: script` step, no run state (resolves params, executes, prints result + would-be record; never touches records/ledger/outputs)
    src/lib/git.ts                  #   injectable git (+gh) subprocess core: stableEnv/realGit/realGh + read-only probes (gitlink/ancestry/drift/worktree); GitRunner/GhRunner injection seams for tests
    src/lib/land.ts                 #   landToMain() — isolation-safe throwaway-worktree land (fetch→worktree add off origin/<base>→cacheinfo→commit→push→PR→squash-merge→ff-only reconcile w/ bounded retry + pre-flight orphan self-clean)
    src/lib/drift.ts                #   classifyDrift() — submodule-pointer drift + the fork-diff/conflict/reachability guards (#132 fix applied to POINTERS)
    src/commands/logs.ts            #   `pipeline logs [-f]` — read-only terminal tail of .runtime/events.jsonl (pretty one-liners); daemon-free, works regardless of PIPELINE_UI_ENABLED (even when the UI is opted out; UI on by default)
    src/lib/plan.ts                 #   computePlan() — PIPELINE.md + steps frontmatter → execution-plan JSON (mode/isolation/steps+models/DAG layers/validation/graph)
    src/lib/match.ts                #   matchPipelines() — BM25 pipeline matcher (the runtime matching engine)
    src/lib/event.ts                #   emitEvent()/writeLiveness()/etc. — runtime UI event writer
    src/lib/graph.ts                #   Variant-A routing: parse/validate the `## Graph` block + routeNext() (declarative loops/skips/counters)
    src/lib/next.ts                 #   computeNext() — the PURE orchestration state machine (sequential/graph/DAG advancement + improver/script/retro gating); what `pipeline-manager` drives off. The `next` COMMAND (src/commands/next.ts) additionally executes external worktree hooks in-process + auto-emits per-iteration UI events
    src/lib/hooks.ts                #   resolveHookScript()/runHook()/parseHookJson() — external-isolation worktree hook resolution + in-process spawnSync execution (used by commands/next.ts; PIPELINE_WT_* env contract FROZEN)
    src/lib/script-step.ts          #   script-step execution core: bindings→spawn→classify→failure records→ledger (in-process by commands/next.ts; process I/O contract FROZEN, see docs/script-steps.md)
    src/lib/script-types.ts         #   frozen script-step type/constant contract (StepType/FailureClass/ScriptResult/ScriptFailureRecord/LedgerEntry + timeout & cap constants; see roadmap/script-steps/DESIGN.md §14)
    src/lib/substitution.ts         #   pure `${PP_*}` pipeline-variable engine: manifest ## Variables parse, plan lints, POSIX `:-`/`-` default resolution, single-pass substitution (no I/O, never reads process.env; see docs/cli.md + docs/script-steps.md §2.5)
    src/lib/run-vars.ts             #   run-init composition seam over substitution.ts: `--var`/`--vars-file` flag folding, resolve→validate→F2-halt-message (used by commands/next.ts + commands/step-run.ts)
    src/lib/render.ts               #   lazy per-run rendered shadow copies of agent iterations + PIPELINE.md when a pipeline declares variables (full-tree mirror for sibling refs, E12); ActionStep.path vs source_path
    src/lib/stats.ts                #   per-run measurement (PIPELINE_STATS_ENABLED, default ON): timeline buffer → .claude/pipeline/.stats/{SUMMARY.md, <rel>/runs.jsonl, <rel>/runs/<id>.log}; enrichment adds tokens + tool-failure counts/details; wired into invokeNext; `pipeline stats` views it (see docs/cli.md)
    src/lib/stats-backfill.ts       #   backfillProject() — the SHARED token/tool reconciliation core every rung calls (Stop + SubagentStop relay, run-init kick, `pipeline stats backfill`, the daemon's 60s sweep) so all four produce bit-identical numbers; correlation invariant: a record is never folded from a transcript that isn't correlated with its run (hintMode always|correlated)
    src/lib/step-transcripts.ts     #   drive-run transcript fold: pinned per-step session transcripts → tools_called/tools_failed + exact-step failure details for .stats enrichment (walks transcripts via lib/vendor/transcript-walk.ts)
    src/lib/vendor/transcript-walk.ts #  VENDORED copy of the pipeline-ui transcript-stats/transcripts/lib.ts walkers step-transcripts.ts needs — apps/pipeline-cli publishes standalone to npm (`bin` points at raw `src/cli.ts`) and the tarball never contains sibling apps/pipeline-ui, so a relative reach-out import crashes every npm install at `pipeline drive` import time (this was a shipped 0.2.0 regression); keep in lockstep with its source per the file's header comment — same "can't import a sibling app at runtime" constraint that already forced lib/event.ts's own encodeClaudeProjectDir copy
    src/lib/generated-dir.ts        #   ensureGeneratedDir() — the ONE place that creates a machine-generated tree in the consumer's repo (.runtime/, .feedback/, .stats/) and drops a self-contained `.gitignore` at that tree's ROOT, so a `git add -A` after a run can't sweep runtime state into the user's commit. Never overwrites an existing stub (a project that deliberately commits a tree keeps its rule), and a stub can't untrack what git already tracks
    src/lib/frontmatter.ts          #   dependency-free YAML-frontmatter reader
    src/lib/envelope.ts             #   parseEnvelope() — the `claude -p --output-format json` result envelope (session_id, structured_output, usage/cost) consumed by `pipeline drive`
    src/lib/step-schema.ts          #   STEP_RECORD_SCHEMA — single-source step-record JSON Schema passed via --json-schema (whitespace-free serialization; lockstep with lib/next.ts records + step-executor.md)
    src/commands/ui.ts              #   `pipeline ui` — thin launcher for the dashboard daemon (detect/spawn supervisor, register cwd, print URL)
    tests/                          #   run with `bun run test` (parallel: scripts/parallel-tests.ts shards files across processes; `bun run test:seq` = plain sequential bun test)
    scripts/parallel-tests.ts       #   parallel test runner — shards *.test.ts files over N `bun test` child processes (safe: per-file process isolation; bun's --concurrent is NOT safe here). pipeline-ui's `bun run test` reuses it
  pipeline-ui/                      # Live dashboard subsystem (see `docs/ui-subsystem.md`)
    server.ts                       #   Bun daemon — file watchers, SSE, REST, project registry, journal tail; host/token gate (PIPELINE_UI_HOST/_TOKEN)
    launcher.ts                     #   Run launcher — /api/pipelines catalog + /api/runs/launch|answer via `pipeline drive` (needs-input questions surface in the UI); drive-usage stats fallback
    editor.ts                       #   Pipeline editor — guarded read/write of .claude/pipeline/** (traversal-proof, ext allow-list, optimistic concurrency, create-step scaffold, plan-lint validate)
    aifix.ts                        #   AI Fix — background `claude -p` job that repairs validate-lint issues inside one pipeline root (model picked in the UI; polled job snapshot)
    transcribe.ts                   #   Speech-to-text proxy — /api/transcribe(-/status): browser audio → OpenAI-compatible Whisper endpoint (OPENAI_API_KEY / GROQ_API_KEY / PIPELINE_STT_*); no provider → web falls back to Web Speech API
    transcript-stats.ts             #   Per-run tool/token analytics folded from the RAW manager+subagent transcripts (the only complete source; backs /api/run-stats — the hook tool.called/turn.usage events undercount badly)
    web/                            #   Vite + React + TS + Tailwind + Framer Motion source
    dist/                           #   Pre-built static bundle served by server.ts (committed)
    EVENTS.md                       #   Event schema (currently v4)
    .gitignore                      #   Excludes web/node_modules, web/.vite, etc.
hooks/
  hooks.json                        # Registers Stop + SubagentStop (matcher: pipeline-manager) + SessionStart + PreToolUse + PostToolUse + UserPromptSubmit + Notification hooks (loaded by Claude Code from default plugin location)
  pipeline_ui_relay.ts              # SessionStart hook — launches pipeline-ui daemon if needed, registers project, emits session.opened
  analytics_relay.ts                # Multi-event hook (PreToolUse + PostToolUse + SubagentStop + Stop + Notification) — the Notification branch journals `run.awaiting_input` and is evaluated BEFORE the PIPELINE_UI_ENABLED opt-out under its own PIPELINE_AWAITING_INPUT_ENABLED (default ON), so a blocked run still shows in `pipeline logs` with no daemon; mirror bindings, tool.called, run-level bypass synthesis, manager.stopped liveness, turn.usage. The transcript-sensitive bits (binding transcript_path + the Stop turn.usage tail) are separately gated by PIPELINE_UI_TRANSCRIPTS (default ON; off ⇒ null the pointer + skip the tail, basic events keep flowing) — orthogonal to the PIPELINE_UI_ENABLED master switch and to PIPELINE_STATS_ENABLED; see docs/ui-subsystem.md
  stats_relay.ts                    # Stop + SubagentStop (matcher: pipeline-manager) — thin wrapper over lib/stats-backfill.ts; token + tool-failure enrichment for .stats/ run records (transcript fold; per-tool fail counts + .log fail details); gated by PIPELINE_STATS_ENABLED (default ON, independent of PIPELINE_UI_ENABLED)
docs/                               # On-demand reference docs split out of CLAUDE.md — read before editing the matching subsystem
  cli.md                            #   the `pipeline` CLI — commands & contracts (plan/match/event/route/next/ui/logs/submodule bump)
  execution-modes.md                #   execution modes (DAG/parallel, external isolation + finalize), model selection, EVENTS schema, self-improvement + nested-blocker loops, spawn-depth rules
  ui-subsystem.md                   #   Pipeline UI subsystem — three-layer split, hard invariants, editing rules
  nested-blocker-delegation.md      #   blocker_delegation brief fields + the supervisor orchestration flow
  worktree-hook-contract.md         #   FROZEN consumer contract for external-isolation worktree hooks (create/finalize/destroy)
  script-steps.md                   #   FROZEN consumer contract for `type: script` steps (declaration, params/bindings, process I/O, failure ladder, ledger, outputs, `step run`)
  history.md                        #   provenance — where the agents were ported from
README.md
CLAUDE.md
.gitignore
```

## Path resolution rules (critical)

The single most important invariant in this plugin:

- **Pipelines live in the consumer project, not the plugin.** Every pipeline file is written under `<cwd>/.claude/pipeline/` — where `<cwd>` is the consumer project's working directory. The plugin install path (`${CLAUDE_PLUGIN_ROOT}`) is **read-only** at runtime.
- **Absolute paths in iteration files resolve against the consumer project.** When an iteration's `Next` field points to `/.../.claude/pipeline/...`, that path is a location inside the user's project filesystem.
- **Never hardcode a specific project's name or a specific category name in agent docs or skills.** Use generic placeholders like `<pipeline-name>` and `<category>`. The existing `pipeline-designer` / `step-executor` / `pipeline-improver` docs contain no references to any particular project layout — keep it that way.

If you see a concrete path like `unity-project/` or `migrate-auth-module/` appearing in any of these files, replace it with a neutral placeholder. Those are consumer-project choices, not plugin defaults.

## CRITICAL: bump `version` in `plugin.json` on any meaningful change

Claude Code caches installed plugins by `name@version` under
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. It does
NOT re-fetch when the source content changes — only when the version
string in `.claude-plugin/plugin.json` changes.

**Any edit that changes agent behavior, skill instructions, or hook
logic MUST also bump the `version` field.** Without the bump, users
who've already installed the plugin see the old content forever and
every skill invocation loads stale instructions.

Use semver:
- Patch bump (0.2.0 → 0.2.1): bug fixes, doc-only changes, marker
  regex fixes.
- Minor bump (0.2.0 → 0.3.0): new skill, new agent, new hook, new
  template version (e.g., CLAUDE.md stanza v4 → v5).
- Major bump (0.2.0 → 1.0.0): reserved for a stable public release.

Don't forget: bumping here requires a second commit in the parent
marketplace repo to bump the submodule pointer.

## Editing rules

- `agents/pipeline-designer.md`, `agents/pipeline-manager.md`, `agents/step-executor.md`, `agents/pipeline-improver.md`, and `agents/pipeline-script-creator.md` share the same mental model of pipeline folder structure (PIPELINE.md + steps/ + optional scripts/). When you change one, check the others — invariants, folder-structure diagrams, and path-resolution rules must stay consistent. (`pipeline-disambiguator` is exempt — it never reads files from disk; it just reasons over manifests inlined in its prompt.)
- `design` is a thin router over the designer subagent. Keep it minimal.
- `run` is NOT a thin router — it is the **supervisor**. `/pipeline:run` (main session, depth 0) mints the run id, owns UI liveness + the mirror binding, and spawns ONE **`pipeline-manager`** subagent (depth 1) that drives the whole chain in fresh-context `step-executor`s (depth 2), dispatching the improver/script-creator between steps. The supervisor keeps only what a subagent cannot do: a stable liveness pid, the hours-long nested-blocker poll-wait, and human-facing reporting; it acts on the manager's structured final report and can re-spawn the manager fresh on crash/overflow (the disk, not the manager, is the source of truth). Full original contract: `docs/execution-modes.md` § "Skill-layer architecture".
- `dispatch` contains real logic (matching ladder + chaining). It runs in the main session, not a subagent, because it needs to spawn subagents (the disambiguator, the executor) and hand off to `/pipeline:run` once per matched pipeline. It does NOT load all manifests into context except in the rare tier-3 chain-detection path; tier 1 happens in `pipeline match` and tier 2 happens inside the disambiguator subagent.
- The agents have different `tools` frontmatter. Keep it tight: `pipeline-manager` **gets `Agent`** — it owns **chain-orchestration** spawning (a `step-executor` per step, plus `pipeline-improver` / `pipeline-script-creator`), running at depth 1 with depth-5 headroom; `pipeline-designer` does not need `Agent` (it never spawns anyone); `step-executor` **gets `Agent` for INTRA-STEP FAN-OUT ONLY** — it is a leaf worker for the *chain* (runs one iteration and reports to the manager) and must never spawn a `pipeline-manager`/`step-executor` or advance the chain itself, but it MAY spawn a *synchronous, iteration-instructed* helper (e.g. a read-only `code-reviewer` at `03a`, or `Explore` searches) to do part of its own step's work — see the "Intra-step fan-out" section in `step-executor.md` for the load-bearing rules (only-when-instructed, synchronous, no re-entrancy, shallow tree, best-effort). It also gets `TaskUpdate` (to close/advance the harness tasks it opens — it already had `TaskCreate`/`TaskGet`/`TaskList`), plus `ToolSearch` + `LSP` (to load deferred MCP/browser tools and use language-server code intel when a step needs them); `pipeline-improver` does NOT get `Agent` either — it is a leaf, it edits files and emits a structured report (which may include a `script_creation_briefs` list for the caller to act on); `pipeline-script-creator` does NOT get `Agent` either — it writes one script, edits one iteration, reports; `pipeline-disambiguator` gets only `Read` and runs on Haiku (`model: haiku` — the alias, so it tracks the latest Haiku rather than pinning a version) — no Write/Edit/Bash, it is pure reasoning over inlined manifest content.

- **Token discipline at the skill layer.** `/pipeline:run`, `/pipeline:design`, and `/pipeline:find` are pure routers — they MUST NOT read iteration files (`steps/**/*.md`) or `PIPELINE.md` content themselves. `/pipeline:dispatch` is also disciplined: tier 1 (the deterministic matcher) reads manifests inside `pipeline match`, tier 2 (the disambiguator) reads only the 2–5 ambiguous candidates' manifests inlined into a Haiku subagent's prompt, and only tier 3 (chain detection) loads all manifests into the main session — which fires on ~5% of calls. Each skill carries an explicit "token discipline" section near the top — preserve and update those when refactoring.

- **`/pipeline:find` vs `/pipeline:dispatch`.** Both answer "task → pipeline?" — they differ in **ergonomics**, not in matcher technology. They share the same first-stage matcher (`pipeline match`, `apps/pipeline-cli/src/lib/match.ts`). `/pipeline:find` is the **inspection variant**: deterministic-only, single-pipeline, asks the user before running, accepts GitHub issue URLs via `--issue`, surfaces excluded-with-reason output. `/pipeline:dispatch` is the **autonomous variant**: same deterministic match in tier 1, falls back to a Haiku-based disambiguator (tier 2) when `pipeline match`'s top two scores are within 2× of each other, falls back to main-session chain detection (tier 3) when `pipeline match` returns 0 candidates AND the task contains chain phrasing. Dispatch auto-runs the chosen pipeline(s) without confirmation.

- **Script-step behavior is a lockstep chain.** Anything touching the `type: script` step contract — frontmatter / `## Params` parsing, in-process execution, records/actions, observability, or the docs — changes the whole chain together: `lib/plan.ts` ↔ `lib/script-types.ts` / `lib/script-step.ts` ↔ `lib/substitution.ts` / `lib/run-vars.ts` (whenever a change touches `command:`/`script:`/`## Params` `${PP_*}` semantics) ↔ `lib/next.ts` ↔ `commands/next.ts` ↔ `lib/step-schema.ts` ↔ `EVENTS.md` / `web/src/types.ts` / `logs.ts` / `stats.ts` ↔ the agent docs ↔ `README.md` / `docs/cli.md` / `docs/script-steps.md`. The frozen public contract is `docs/script-steps.md`; the full chain + rationale is in `roadmap/script-steps/DESIGN.md` §15.

- **Pipeline variables (`${PP_*}`)** parameterize a pipeline for different targets/environments without cloning it: an optional `## Variables` section in `PIPELINE.md` declares `PP_NAME (required)` / `PP_NAME (default: ...)` bullets (authoring guidance: `agents/pipeline-designer.md`); `pipeline next` / `drive` / `step run` accept repeatable `--var NAME=value` and `--vars-file <path>` to resolve them once at run init (CLI flag > environment > manifest default), validate fail-fast (aggregated, never first-error-only), and FREEZE the result for the whole run (a `--resume` reuses the frozen map verbatim; supplying new `--var`/`--vars-file` against a frozen run is a usage error). Values substitute into per-run rendered copies of agent iterations (`lib/render.ts`) and into script-step `command:`/`script:` argv + child env + `## Params` bindings (`lib/script-step.ts`, `docs/script-steps.md` §2.5) — non-secret by contract (D4): values are visible verbatim in rendered files, params files, child-script environments, logs, events, and AI context, so never design one to carry a secret. Full CLI-flag contract: `docs/cli.md`; full script-step argv/env contract incl. the argv[0]-substitution ban and the `.bat`/`.cmd` block: `docs/script-steps.md` §2.5.

## Pipeline folder contract (`PIPELINE.md` + `steps/`)

This is a load-bearing invariant across the plugin — do not weaken it without re-doing the token-cost analysis:

- Every pipeline folder has two REQUIRED children at its root: the `PIPELINE.md` manifest (uppercase) and a `steps/` subfolder. Every iteration file (`NN-*.md`) lives inside `steps/`, never at the pipeline root. Recognized OPTIONAL siblings: `scripts/` (extracted Python scripts), `targets/` (a target family — each `targets/<name>/` is a complete sub-pipeline; dot-prefixed dirs like `targets/.common/` hold family-shared docs/scripts and are skipped by target resolution), and per-pipeline context modules (e.g. `conventions.md`, `setup.md`, `test.md`) that iterations reference explicitly. See pipeline-designer.md § "Target families".
- The 300-token manifest cap applies to LEAF pipelines. A family HUB (has `targets/`) is exempt (its manifest carries the routing table); a family TARGET (lives under `targets/`) gets ~1500 tokens. `pipeline plan`'s lint enforces exactly this split.
- The manifest is **metadata**, not an iteration. `step-executor` does NOT auto-load it. Iterations remain self-contained.
- The executor loads the manifest **only** when an iteration's `Context` section explicitly references it (opt-in per iteration).
- The `/pipeline:run` skill reads the manifest **once** at pipeline start to show a banner. It does not pass manifest content to the executor. It finds the manifest by walking upward from the iteration's folder until it finds a directory containing `PIPELINE.md`.
- The manifest is capped at **300 tokens** and has required sections: End State, Scope, Project Context, Invariants. Related Pipelines and Glossary are optional.
- Nested sub-folders inside `steps/` do **not** get their own manifest. One manifest per pipeline, at the pipeline root.

If you ever change the executor to auto-load the manifest, you are re-introducing per-iteration token cost and breaking fresh-context self-containment. Don't.

## Testing the plugin

1. In a scratch directory (e.g. `C:/tmp/pipeline-test`), confirm CWD is the scratch dir.
2. Run `/pipeline:design Build a small CLI that lists top-level files sorted by size`.
3. Verify that `./.claude/pipeline/<pipeline-name>/` is created in the scratch dir and contains:
   - `PIPELINE.md` at the pipeline root with all required sections, ≤ 300 tokens.
   - A `steps/` subfolder holding at least two iteration files (`steps/01-*.md`, `steps/02-*.md`), each with all required sections and no dependency on the manifest.
4. Verify that **no files were created inside `${CLAUDE_PLUGIN_ROOT}`** — the plugin install directory must stay untouched.
5. Run `/pipeline:run <absolute-path>/.claude/pipeline/<pipeline-name>/steps/01-*.md`:
   - Confirm the skill shows a `▶ Starting pipeline <name>: <end state>` banner before delegation.
   - Confirm the executor does NOT read `PIPELINE.md` (check its tool-call log — only the current iteration file should be loaded, plus whatever it explicitly references).
   - Confirm the chain runs to `Pipeline complete.` or halts with a clear blocker message.

## Reference docs (read on demand)

The deep contracts below were moved out of this file verbatim to keep every-session context lean. They are load-bearing — read the relevant doc BEFORE editing that subsystem, and keep its lockstep rules.

- The `pipeline` CLI — commands & contracts (`plan`/`match`/`event`/`route`/`next`/`ui`/`logs`/`submodule bump`; `pipeline next` is the orchestration state machine) — see `docs/cli.md`
- Execution modes, models & events — EVENTS schema v4, opt-in DAG/parallel, `isolation: external` + finalize, per-spawn model resolution + the shorthand map, the two-tier self-improvement loop, the nested-blocker loop, Agent-tool depth rules, and the full `/pipeline:run` supervisor architecture — see `docs/execution-modes.md`
- Pipeline UI subsystem — three-layer split, hard invariants (liveness, bypass synthesis, transcript analytics, version reconcile), UI editing rules — see `docs/ui-subsystem.md`
- Nested-blocker delegation — `blocker_delegation` brief fields + the supervisor orchestration flow — see `docs/nested-blocker-delegation.md`
- External-isolation worktree hooks — the FROZEN `PIPELINE_WT_*` env-var + JSON consumer contract — see `docs/worktree-hook-contract.md`
- Script steps (`type: script`) — the FROZEN process I/O contract for zero-token deterministic steps: frontmatter, `## Params`/`## Output` + `${…}` bindings, `PIPELINE_STEP_*` env vars + the stdout result object, failure classes + `on-failure`/`retries`, the attempt ledger, the outputs store, and `pipeline step run` — see `docs/script-steps.md`
- Source of the design (provenance) — see `docs/history.md`
