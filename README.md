# pipeline

Repository: [`IvanMurzak/ai-pipeline-plugin`](https://github.com/IvanMurzak/ai-pipeline-plugin). This is the source for the installable Claude Code plugin `pipeline` — the manifest, six agents, skills, hooks, and the bundled `pipeline` CLI + local dashboard UI under `apps/`. Looking for the optional remote runner that lets connected compute pick up work dispatched by a pipeline? That lives in the sibling repo [`IvanMurzak/pipeline-runner`](https://github.com/IvanMurzak/pipeline-runner).

Claude Code plugin for designing and executing long-chain AI workflows as ordered, self-contained iteration files under the consumer project's `.claude/pipeline/` directory. Ships six coordinated agents — one that designs pipelines, a depth-0 `/pipeline:run` supervisor + a `pipeline-manager` orchestrator + per-step `step-executor`s that run them, one that feeds discovered knowledge back into the pipeline's own docs, one that extracts heavy procedural blocks out of iteration markdown into per-pipeline Python scripts so each fresh-context run pays fewer tokens, and a cheap Haiku disambiguator for matching tasks to pipelines.

## Install

```
/plugin marketplace add IvanMurzak/ai-pipeline-plugin
/plugin install pipeline@ai-pipeline
```

This repository is itself the plugin, so the `pipeline` CLI and the local dashboard UI under `apps/` ship inside — nothing else to fetch or build. Updates arrive via `/plugin update` whenever this repo's `.claude-plugin/plugin.json` version is bumped.

## What you get

- **`/pipeline:design <high-level goal>`** — invokes the `pipeline-designer` agent to decompose the goal into an ordered chain of iteration files under `./.claude/pipeline/<pipeline-name>/`. Each file is one PR-sized unit of work.
- **`/pipeline:run <absolute-path-to-iteration.md>`** — drives the pipeline end-to-end. It mints the run id, owns UI liveness, and spawns a single `pipeline-manager` (depth 1) that drives the chain — running a fresh `step-executor` per iteration (depth 2) and dispatching `pipeline-improver` / `pipeline-script-creator` between steps. `/pipeline:run` itself stays in the main session: subagents can now nest (up to 5 levels deep), but the supervisor stays at depth 0 because a subagent's context is finite, it cannot wait hours for an external condition (the nested-blocker poll-wait), and it has no stable pid for liveness tracking.
- **`/pipeline:dispatch <task>`** — autonomous task-to-pipeline orchestrator. Walks a three-tier cost ladder per call: (1) deterministic BM25 match via the bundled `pipeline match` CLI — free, resolves most tasks; (2) Haiku-based disambiguator agent — cheap, only runs when the top-2 BM25 candidates are within 2× of each other; (3) full-context chain detection in the main session — expensive, only runs when the matcher returns zero candidates AND the task has chain phrasing. Auto-runs the chosen pipeline(s) without confirmation.
- **`/pipeline:find <task-or-github-issue-url>`** — deterministic, AI-free matcher (the inspection variant of dispatch). Shares dispatch's first-stage matcher (the bundled `pipeline match` CLI) but stops there — no LLM tiers, no auto-run. Returns ranked candidates with score + matched terms plus explicit excluded-with-reason output, then asks before running. Accepts a GitHub issue URL / `owner/repo#NUMBER` / plain issue number — fetches title+body via `gh issue view` and matches against that. Runs with Bun (no `pip install`).
- **`/pipeline:ui`** — opens a live dashboard in the browser. Single shared local Bun daemon (one per machine, one stable port) that aggregates every project on this machine that uses the plugin, with iteration trees, active-run cards, blocker-child views, per-run analytics (tool counts, agent spawns, token usage), light/dark themes, and live SSE updates. The daemon is auto-launched by a `SessionStart` hook the first time you open Claude Code in any pipeline-using project, and self-shuts-down when idle. See "Live dashboard (/pipeline:ui)" below.
- **Six subagents** usable via the `Agent` tool: `pipeline-designer`, `pipeline-manager`, `step-executor`, `pipeline-improver`, `pipeline-script-creator`, and `pipeline-disambiguator`. Most are normally invoked through automated chains — see "Self-improving pipelines", "Token-cheap iterations via script extraction", and "Finding the right pipeline for a task" below. The disambiguator runs on Haiku 4.5 to keep the matching ladder cheap.

## Token discipline (why the architecture looks the way it does)

Every iteration is read by a fresh-context executor on every run, so tokens spent in iteration markdown are paid **forever**, not just once. The plugin's design follows from that:

- **Skills don't read iteration content.** `/pipeline:run` and `/pipeline:design` are pure routers — they pass paths to subagents and never `Read` `steps/**/*.md` or `PIPELINE.md` themselves. The main session stays lean for the rest of the user's day. `/pipeline:dispatch` reads only manifests (capped at 300 tokens each) because matching requires it.
- **Iterations stay self-contained but get leaner over time.** Long deterministic `Steps` blocks (build sequences, file-system manipulations, multi-call API chains) are extracted into Python scripts under `<pipeline-root>/scripts/` and replaced with one-line `python scripts/<name>.py` invocations. The executor reads one line of markdown; the script's logic only runs in the Bash tool, never through the language model.
- **Manifest is metadata, not an iteration.** Capped at 300 tokens, never auto-loaded, opt-in per iteration via an explicit `Context` reference. Adding a new pipeline does not raise the per-iteration baseline cost.

## Mental model

A **pipeline** is a folder of markdown files. Each file is one **iteration**: a self-contained task an agent executes in a brand-new context. The designer writes the folder; the executor runs it file-by-file in fresh contexts. Because every iteration is self-contained, the chain can be arbitrarily long without context-window issues.

```
<your-project>/.claude/pipeline/
└── <pipeline-name>/
    ├── PIPELINE.md            ← required manifest (metadata header, ≤300 tokens)
    ├── scripts/               ← optional — Python scripts extracted from heavy Steps blocks
    │   └── <name>.py          ← stdlib-only, cross-platform, called via `python scripts/<name>.py`
    └── steps/                 ← every iteration file lives here
        ├── 01-<iteration>.md  ← one PR-sized unit of work
        ├── 02-<iteration>.md
        └── ...
```

All files live inside **your current project** (the working directory from which Claude Code was launched). The plugin itself is read-only at runtime — nothing gets written into the plugin install directory.

### The manifest — `PIPELINE.md`

Every pipeline folder has a small metadata file named `PIPELINE.md` at its root (sibling to `steps/`). It describes the pipeline's end state, scope, shared project context, and pipeline-wide invariants. It's written by the `pipeline-designer` and capped at 300 tokens.

**It is NOT auto-loaded by the executor.** Iterations stay self-contained, so the executor pays no per-iteration token cost for the manifest. The manifest is used by:

- Humans browsing the pipeline as a knowledge base.
- The `pipeline-designer` when reviewing or editing iterations.
- `/pipeline:run` once at start, to show a banner like `▶ Starting pipeline <name>: <end state>`.
- Individual iterations that opt in by explicitly referencing it in their `Context` (rare — only when pipeline-wide invariants are needed mid-execution).

## Using the plugin in a consumer project

This section is the practical walkthrough — install once, then a small set of commands you'll use day to day. Everything below assumes you've run the install commands from the "Install" section at the top and that your terminal's working directory is your **consumer project's root** (the project where you want pipelines to live, not the plugin's own folder).

### Cheat sheet — which command does what

| You want to… | Use | Asks before running? | Cost |
|---|---|---|---|
| Author a new repeatable workflow | `/pipeline:design <goal>` | n/a (writes files) | one-time design cost |
| Pick a pipeline for a task and **see** the match before running | `/pipeline:find <task or GH issue URL>` | yes | ~zero LLM tokens |
| Pick a pipeline for a task and **just run it** | `/pipeline:dispatch <task>` | no | ~zero for ~80% of tasks; cheap Haiku for ambiguous; full only for chains |
| Run / resume a specific pipeline you already know the path of | `/pipeline:run <abs-path-to-iteration.md>` | no | n/a |

`/pipeline:design` is the only skill that **writes** files (your new pipeline). The matching skills (`find`, `dispatch`) are read-only inspections of `PIPELINE.md` manifests; the run skills (`run`, `dispatch`) execute pipelines that do whatever those pipelines say in their iteration `Steps`.

### Day 1 — author and run your first pipeline

1. **Decide on a *repeatable* goal.** Pipelines are for workflows that will run **many times** in this project — releases, audits, migration templates, "implement-task" scaffolds. **Do not** use them for one-shot tasks (single bug fix, single PR); the designer will push back on those by default.

2. **Design the pipeline.** From the project root:

   ```
   /pipeline:design Cut a release of the API server: bump version, run tests, build image, deploy staging, smoke-test, deploy prod
   ```

   The `pipeline-designer` subagent will sketch an iteration list, confirm scope with you when non-trivial, then write files under `./.claude/pipeline/<pipeline-name>/` — a `PIPELINE.md` manifest plus an ordered `steps/01-*.md`, `steps/02-*.md`, …. Each iteration file is a self-contained PR-sized unit of work.

3. **Sanity-check the result.** Open the new folder yourself; read the manifest's `End State` and the first iteration's `Goal` / `Steps` / `Success Criteria`. The designer is good but not infallible — five minutes reading what it produced now saves ten minutes mid-execution. Edit by hand if needed; iteration files are just markdown.

4. **Run it.** Two equivalent options:

   ```
   /pipeline:run ./.claude/pipeline/release-api/steps/01-bump.md
   ```

   …or, more naturally, hand the matcher a task and let it find the right pipeline:

   ```
   /pipeline:dispatch Cut a release of the API server with version 2.5.0
   ```

   `/pipeline:run` is the supervisor. It spawns a single `pipeline-manager` (depth 1) that drives the chain — running a fresh `step-executor` per iteration (depth 2) and chaining forward through every iteration until the pipeline declares completion or halts on a blocker — while `/pipeline:run` stays in the main session to own UI liveness, the human-facing report, and the hours-long nested-blocker poll-wait. You'll see banners in the terminal.

5. **Re-read the pipeline folder afterwards.** After a successful run, `.claude/pipeline/<pipeline-name>/` is now both a workflow definition and a knowledge base — future maintainers (and future Claude sessions) can read it cold to understand the project's release process. Commit it to git.

### Day 2+ — picking the right pipeline for a task

Once you have a few pipelines in `.claude/pipeline/`, you stop typing pipeline paths and start typing tasks. Two skills, same matcher, different ergonomics:

**Inspection — `/pipeline:find`.** Use when you want to see the match before committing.

```
/pipeline:find Reduce p99 latency on the /api/users endpoint by adding indexes
```

Output looks like:

```
▶ Task: Reduce p99 latency on the /api/users endpoint by adding indexes

Matches:
  1. optimize-db (score 3.42, matched: database, indexes, lookup, query)
     End state: Database query performance is improved through targeted index additions...
     First iteration: ./.claude/pipeline/optimize-db/steps/01-baseline.md

Excluded by Scope.Out:
  - tune-api-latency: Scope.Out includes ["database index changes"]; matching terms: ["database", "indexes"]

Run "optimize-db" now? [Y/n]
```

The "Excluded by Scope.Out" list shows pipelines the matcher rejected and **why**. That visibility is the whole point of the inspection variant — when the matcher excludes a pipeline you expected to win, the explanation tells you whether to fix the task wording, raise `--neg-threshold`, or edit the rejecting pipeline's `Scope.Out` bullet to be more specific.

**Autonomous run — `/pipeline:dispatch`.** Use when you trust the matcher.

```
/pipeline:dispatch Cut a release of the API server with version 2.5.0
```

Same first-tier match as `/pipeline:find` (stdlib BM25 + Scope.Out hard-filter). On ambiguity (top-2 BM25 scores within 2× of each other), it spawns a Haiku-based disambiguator subagent that reads the ambiguous candidates' manifests and picks one — fractions of a cent. On zero matches with chain phrasing in the task, it falls back to full-context chain detection. On a confident single match (the common case), it runs immediately with zero LLM cost on matching.

**Working from a GitHub issue.** Either skill accepts a URL or `owner/repo#NUMBER` instead of free-form text:

```
/pipeline:find https://github.com/myorg/myrepo/issues/247
/pipeline:dispatch myorg/myrepo#247
```

The matcher calls `gh issue view --json title,body` and uses the issue's title+body as the task. Useful for triaging incoming issues without copy-pasting their text.

### Day-2 — when nothing matches

If `/pipeline:find` returns no candidates and the excluded list doesn't reveal an obvious cause:

1. **Re-read your task wording.** Pipelines match on terminology that appears in `End State` / `Scope.In` / pipeline name. If you describe a "schema migration" but the relevant pipeline calls it "database evolution", your wording and the matcher's vocabulary don't overlap.
2. **Try `--neg-threshold 2`** (you can pass `--` flags after the task in the command if you need to). Default is 1, which is strict. Raising it to 2 means "only exclude if at least 2 task tokens overlap with `Scope.Out`."
3. **Author a new pipeline** with `/pipeline:design <goal>` if no existing pipeline really covers the task and the workflow will repeat.
4. **Fall back to a regular agent** (`Agent({subagent_type: "general-purpose", …})` or a domain-specific teammate) for genuinely one-shot work — pipelines are for *repeatable* workflows.

### Day-N — letting pipelines improve themselves

Pipelines get better over time without you intervening, on **two tiers**:

- **Tier-1 (between steps).** The executor flags any iteration whose docs were ambiguous, missing a step, or pointed at the wrong tool — it emits an improvement brief in its final report. The `pipeline-manager` automatically dispatches `pipeline-improver` between iterations, so the next iteration in the chain reads updated docs. The executor also flags long deterministic Steps blocks that are paying tokens on every fresh-context run; the improver passes those to `pipeline-script-creator`, which extracts the block to a Python script under `<pipeline-root>/scripts/<name>.py` and rewrites the iteration to invoke it with one command.
- **Tier-2 (end-of-run retrospective).** While a run is in flight, each step jots down *every* problem it hits — not just blocking ones — into a gitignored `.feedback/` folder inside your pipeline. At the end of the run the `pipeline-manager` hands the doc-related problems to one Opus `pipeline-improver` (and `pipeline-script-creator`) pass that consolidates them and fixes the pipeline's own docs in a batch. The pure-project problems it can't fix on its own — real code bugs, environment issues, general friction — are surfaced to **you** in the run's final report instead. The feedback folder is cleaned up afterward; the improvements live in the docs and the project/env problems live in the report.

You don't trigger any of this. It happens during normal `/pipeline:run` invocations. Over a few weeks of use, your pipelines drift toward "iterations contain only the parts that need agent judgment; everything else is in scripts" — which is the cheap-tokens steady state.

See "Self-improving pipelines" and "Token-cheap iterations via script extraction" sections below for the full mechanics.

### Common pitfalls

- **Running from the wrong directory.** Pipelines live in your **consumer project's** `./.claude/pipeline/`, not in the plugin install folder. If `/pipeline:design` ends up writing somewhere unexpected, your CWD wasn't the project root. The plugin install dir (`${CLAUDE_PLUGIN_ROOT}`) is read-only at runtime; nothing should ever land there.
- **Designing one-shot pipelines.** Both `/pipeline:design` and the `pipeline-designer` agent will push back when your goal looks like a single-use task. Take the pushback — pipelines pollute `.claude/pipeline/` if used for one-shot work, since that folder doubles as a knowledge base of your project's *recurring* processes.
- **Editing iteration files mid-chain.** If a pipeline is currently running (executor in flight), don't edit its iteration files by hand. Wait for the chain to halt or complete; then edit, then resume with `/pipeline:run <halted-iteration.md>`. Iterations are designed to be idempotent, so re-running from the halted step is safe.
- **Confusing the dispatch-tier-3 fallback for normal behavior.** If you find yourself paying full LLM cost on every `/pipeline:dispatch` call, your matcher is returning zero candidates because of vocabulary mismatch (your tasks don't share terms with manifest `Scope.In` / `End State`). Fix the manifests' wording or your task wording; don't accept tier 3 as the steady state.

## Iteration file shape

Every iteration file contains these sections (and the `pipeline-designer` agent enforces them):

```markdown
# <Iteration Title>

## Goal
One or two sentences.

## Context
- Links to prior iterations (absolute paths).
- Links to project files, specs, docs.

## Inputs
- Files to read, decisions already made, preconditions.

## Steps
1. Ordered, concrete actions — anything requiring agent judgment lives here.
2. Run: `python <abs-path>/scripts/<name>.py [args]` — for long deterministic blocks
   (build/test sequences, file-system manipulations, API call chains). These get
   extracted out of markdown into per-pipeline Python scripts to keep the
   per-iteration token cost low. See "Token-cheap iterations via script extraction" below.
3. More agent-judgment steps using the script's stdout / exit code.

## Success Criteria
- Verifiable, objective, binary.

## Next
- Absolute path to next iteration, OR "Pipeline complete."
```

## Finding the right pipeline for a task

Two user-facing skills, **same matcher under the hood, different ergonomics on top**:

- **`/pipeline:find <task-or-issue-url>`** — inspection variant. Deterministic-only (no LLM). Returns ranked candidates with score, matched terms, and excluded-with-reason output, then asks before running. Use when you want to see the match before committing.
- **`/pipeline:dispatch <task>`** — autonomous variant. Same matcher in tier 1, plus an LLM tiebreaker on ambiguity (tier 2) and a chain-detection fallback on no match (tier 3). Auto-runs without confirmation. Use when you trust the matcher to decide.

Both share the `pipeline match` command (`apps/pipeline-cli`, run with Bun) — it scores each `PIPELINE.md` with Okapi BM25 over the **positive corpus** (name + `End State` + `Scope.In` + `Glossary`) and hard-filters on the **negative corpus** (`Scope.Out`) via keyword overlap. The corpus split exists because BM25 (and embeddings) don't naturally understand negation — to a frequency-based scorer, "update the database schema" and "do not update the database schema" share most of their tokens and look similar. The structural fix is to score the positive bucket and filter the negative bucket separately. A pipeline whose `Scope.Out` reads "database schema migrations" is excluded — with an explicit reason — from a task that mentions "database schema", instead of being ranked alongside the actually-relevant pipeline.

### `/pipeline:dispatch`'s three-tier cost ladder

Each call walks down the ladder; it stops at the first tier that produces a usable answer.

| Tier | What runs | When | Token cost |
|------|-----------|------|-----------:|
| 1 | `pipeline match` (BM25 + keyword filter, run with Bun) | always | ~zero |
| 2 | `pipeline-disambiguator` agent (Haiku 4.5) with 2–5 ambiguous candidates' manifests inlined | when the matcher returns ≥ 2 candidates with top1/top2 score ratio < 2.0 | low — Haiku, scales with ambiguity not project size |
| 3 | Main-session reasoning over all manifests to detect a chain | when the matcher returns 0 candidates AND task contains chain phrasing (`then`, `after that`, `followed by`, …) | full — same as the pre-refactor design used to cost on every call |

The 80% case (one pipeline obviously matches): tier 1 only, no LLM. The 15% case (ambiguous): tier 1 + Haiku tier 2. The 5% case (chain across pipelines): tier 1 + tier 3. Average token cost per dispatch dropped by ~90% versus the pre-refactor design where every call paid the tier-3 cost.

Example output:

```
▶ Task: Cut a release of the backend server with a changelog update

Matches:
  1. release-server (score 5.0, matched: new, release, backend, server, changelog)
     End state: A new tagged release of the backend server is published to production with no rollback required.
     First iteration: ./.claude/pipeline/release-server/steps/01-bump.md

Excluded by Scope.Out:
  - migrate-db: Scope.Out includes ["server release"]; matching terms: ["release", "server"]
  - audit-deps: Scope.Out includes ["server release"]; matching terms: ["release", "server"]

Run "release-server" now? [Y/n]            # /pipeline:find — asks
▶ Why: BM25 confident match (ratio 4.2)    # /pipeline:dispatch — auto-runs
```

For a GitHub issue, run either skill with the URL: `/pipeline:find https://github.com/owner/repo/issues/123`. The matcher calls `gh issue view --json title,body` and uses that as the task. Useful when triaging incoming issues.

The matcher and the disambiguator both live in this plugin — nothing to install in the consumer project beyond **Bun** (already required by the `/pipeline:ui` dashboard); the matcher runs as the bundled `pipeline match` CLI. (`gh` is needed only for the `--issue` form.)

## Self-improving pipelines

Pipelines get better over time by feeding concrete lessons back into their own documentation. This works on **two tiers**.

**Tier-1 — between-steps improvement.** When `step-executor` finishes an iteration and realizes the iteration as written was flawed in a way that blocks the *next* step — missing a step, ambiguous success criterion, unstated precondition — it emits a structured improvement brief in its final report, describing (a) what was wrong, (b) what the correct knowledge is, and (c) the specific edits to apply. The `pipeline-manager` (depth 1 — dispatching the improver is a *between-steps, chain-orchestration* spawn, which is the manager's job, not the step-executor's) picks up the brief and dispatches `pipeline-improver` synchronously before spawning the next step-executor. The improver makes minimal, surgical edits to the iteration file (or `PIPELINE.md` for pipeline-wide invariants) and reports back; the manager then continues the chain so the next step-executor reads the updated files from disk. The next time anyone runs this pipeline, the improved iteration is smoother.

**Tier-2 — end-of-run retrospective.** Tier-1 only carries the single most-blocking flaw per step. To capture everything else, each `step-executor` *also* journals every problem it hits — doc flaws, ambiguities, script-extraction candidates, but also real project bugs, environment issues, and general friction — as individual files in a gitignored `<pipeline-root>/.feedback/<run_id>/` folder, written as it goes (so they survive a crash). After the whole run finishes (completes or halts), the `pipeline-manager` runs a retrospective: it splits the problems into **doc-actionable** (doc-flaw / ambiguity / script-candidate) and **human-only** (project-issue / env / friction). The doc-actionable ones go to a single Opus `pipeline-improver` batch pass that consolidates, dedups, and applies the doc fixes (reading current state first so it never re-does a fix Tier-1 already landed) and emits a list of confirmed script extractions for `pipeline-script-creator`. The human-only ones are summarized straight to you in the run's final report — the pipeline never tries to auto-fix your code or your machine. The feedback folder is deleted afterward; the doc improvements live in the iteration files, and the human-only summary lives in the report.

Boundaries:

- Improvements target pipeline **documentation** only (files under `.claude/pipeline/<name>/`). Never consumer project code.
- Project-side bugs (real code issues, flaky tests, environment problems) do NOT trigger doc improvements — they are surfaced to you in the retrospective summary instead. Only flaws in the iteration's own docs are auto-fixed.
- The improver refuses changes that would break the chain, delete Success Criteria, or renumber files.
- Tier-1: one improvement brief per iteration, max. Tier-2: one batch improver pass per run, run once at the end (a no-op when no problems were journaled).
- The `.feedback/` tree is gitignored by a self-contained `.feedback/.gitignore` (a single `*`), so feedback never lands in your commits.

You can also invoke `pipeline-improver` directly via the `Agent` tool when you spot a pipeline-doc flaw yourself.

## Token-cheap iterations via script extraction

Iteration markdown is paid in tokens on every fresh-context run. A 60-line "do this then this then this" block of imperative shell-style detail in `Steps` becomes a permanent tax on every executor that ever reads the iteration. The plugin's `pipeline-script-creator` agent removes that tax by relocating deterministic procedural blocks to Python scripts.

How it lands automatically:

1. `step-executor` runs an iteration and notices a `Steps` block that is long, deterministic, and judgment-free. It includes a `SCRIPT-EXTRACTION CANDIDATE` bullet inside its `improvement_brief` (it does not extract scripts itself).
2. The `pipeline-manager` spawns `pipeline-improver` with the brief.
3. `pipeline-improver` applies any text edits, then — if the extraction is warranted — emits a `script_creation_briefs` list (0 or 1 entries in this between-steps path; several in the end-of-run retrospective) in its own structured final report. It does not write the script either; that is `pipeline-script-creator`'s job.
4. The `pipeline-manager` parses the improver's report and spawns `pipeline-script-creator` once per brief in the list, sequentially. The script-creator writes a cross-platform Python file under `<pipeline-root>/scripts/<name>.py`, runs `--help` to verify it parses, then rewrites the iteration's `Steps` to invoke the script with one command line.
5. The next executor starts in a fresh context and reads the slimmed-down iteration. Token cost on every future run drops accordingly.

Boundaries:

- Scripts live at `<your-project>/.claude/pipeline/<pipeline-name>/scripts/<name>.py` — sibling to `steps/`, never inside it. Per-pipeline only; no cross-pipeline sharing in v0.8.0.
- Stdlib only by default. Cross-platform (`pathlib`, `tempfile`, no POSIX shell syntax). Argparse-driven CLI with `--help`. Idempotent.
- The script-creator refuses extractions that would require agent judgment, deletions of `Success Criteria`, renumbering, or breaking `Next` links. It is a leaf agent — it does not loop back to the executor or improver.

You can also invoke `pipeline-script-creator` directly via the `Agent` tool when you've drafted a structured `script_creation_brief` yourself and want to apply it manually.

## Script steps (zero-token steps)

Script extraction (above) removes the *heavy procedural block* from an agent iteration — the agent still reads the script's result and decides what to do next. When a **whole** iteration is deterministic — a build gate, a CI wait, a fixed file/API sequence with no judgment at all — you can go one rung further and make the step itself the program, with **no agent involved**. Add `type: script` to the iteration's frontmatter and the `pipeline next` engine runs it **in-process, for zero LLM tokens** (the same mechanism that runs external-isolation worktree hooks). A fully deterministic iteration that used to cost a ~10–20k-token step-executor spawn now costs nothing.

The three-rung extraction ladder:

1. **Inline `Steps`** — only where agent judgment is needed.
2. **A script called from inside an agent step** — the script-extraction path above; the agent still reads the result and decides.
3. **`type: script`** — the whole step is the program (this section).

It is fully backward-compatible: absent `type:`, a step is an `agent` step exactly as before, and an old runtime that doesn't understand `type: script` treats the file as a plain agent step (via a one-line `## Steps` fallback).

A minimal script step (`steps/03-wait-ci.md`):

````markdown
---
type: script
script: scripts/wait-ci.py     # path relative to the pipeline root
timeout: 1800
retries: 2                     # re-run transient failures (network blips, timeouts)
on-failure: halt               # or 'agent' to fall back to a manual step-executor
step_id: wait-ci
---

# Wait for CI

## Goal
Block until the PR's CI reaches a terminal state; expose the result as a flag.

## Params
```json
{ "pr_number": { "type": "number", "required": true,
                 "from": "${steps.open-pr.output.pr_number}" } }
```

## Success Criteria
- CI reached a terminal state and the outcome was reported.

## Steps
1. Run: `python <abs>/scripts/wait-ci.py` — waits for CI (graceful-degradation line).

## Next
Pipeline complete.
````

The script reads its inputs from the JSON file named in `PIPELINE_STEP_PARAMS_FILE`, does its work with stdin closed, and prints ONE JSON object as its **last stdout line**:

```json
{ "ok": true, "summary": "CI green in 6m12s", "flags": { "ci_green": true }, "output": { "checks_passed": 14 } }
```

`ok:true` means "the step did its job" — a domain "no" (CI red, nothing to release) is still `ok:true` with a `flags` entry the pipeline's `## Graph` routes on. `ok:false` is reserved for "the step could not run at all" and (with `on-failure: halt`) stops the run. `flags` become the step's `result_flags`; anything in `output` is persisted so later steps can bind to `${steps.wait-ci.output.checks_passed}`.

Test a script step in isolation before wiring it into a chain — no run required:

```
pipeline step run ./.claude/pipeline/release-api/steps/03-wait-ci.md --param pr_number=132 --json
```

The full contract — frontmatter fields, the `## Params` / `## Output` vocabulary and `${…}` bindings, the **frozen** process I/O contract (env vars, params file, stdin/stdout, exit semantics, the `ok:false` rule), the failure classes + `retries` / `on-failure` agent fallback, the timeout/call-budget ladder, the attempt ledger (idempotency), the outputs store, and secrets handling — is in **[`docs/script-steps.md`](docs/script-steps.md)**.

## Waiting on GitHub CI without burning tokens (`pipeline ci-wait`)

The classic agentic-workflow money pit: a step needs CI to pass, so the agent hand-rolls a poll loop — sleep, run `gh pr checks`, read the whole check table into context, repeat — burning a full agent turn per poll. Worse, agents happily wait **hours** for full CI completion when one job already failed (or hung) and the outcome was decided long ago.

`pipeline ci-wait` replaces the loop with ONE Bash call that blocks until CI reaches a terminal state and prints ONE compact result:

```
pipeline ci-wait --pr 123 --json          # wait on a pull request's checks
pipeline ci-wait --branch main --json     # wait on a branch's HEAD commit (sha pinned at start)
pipeline ci-wait --json                   # no selector = the repo's default branch
```

- **Fails fast by default.** The FIRST failed or cancelled check ends the wait immediately — even while other jobs are still running or stuck. Pass `--no-fail-fast` when you genuinely need the full picture.
- **Never blocks forever.** `--timeout <sec>` (default 1800) caps stuck CI → exit 3 with the still-pending check names; `--grace <sec>` (default 120) bounds the "CI never started" case → exit 4, deliberately distinct from success so "no checks" can never read as a green gate.
- **Silent while waiting.** No output until the verdict (opt into stderr heartbeats with `--verbose`); the result is one line, or one JSON object with `--json`.
- **Exit codes are the contract**: `0` all passed · `1` a check failed · `2` usage / `gh` missing · `3` timeout · `4` no checks appeared. An iteration step just runs it and branches on the code — no poll loops in step docs.

`--pr` accepts a number, URL, or head-branch name (via `gh pr checks`, covering Actions and third-party checks). `--branch`/`--sha` poll the commit check-runs API; a branch is resolved to its HEAD sha once at start, so a later push is a new gate rather than a moving target. Requires an authenticated `gh` CLI (`--repo <path>` selects which repo's remote to use; default: the current directory).

## Measuring every run (`.claude/pipeline/.stats/` + `/pipeline:optimize`)

Every pipeline run is measured by **pure software — no AI agent, zero LLM tokens**. It is ON by
default (`PIPELINE_STATS_ENABLED=0` disables). The `pipeline next` engine appends a timeline as the
run progresses and finalizes it at the terminal action; a `SubagentStop` hook later fills in token
counts folded from the raw manager + subagent transcripts (the only complete token source). You get
simple text files to review whenever you like:

```
.claude/pipeline/.stats/
  SUMMARY.md                      # the whole picture: per pipeline — runs, success rate,
                                  #   avg duration, avg out-tokens, avg tool fails,
                                  #   last run + recent-runs table
  <pipeline>/runs.jsonl           # one machine-readable record per finished run
  <pipeline>/runs/<run-id>.log    # human per-run timeline: step-by-step timings, outcome,
                                  #   tokens + a "tool fails" section (per-failure detail)
```

**Tool failures are measured, not just outcomes.** Enrichment also records how many tool calls
FAILED during the run (`tokens.tools_failed` + a per-tool breakdown like `{"Bash": 5}`), and
appends each failure — timestamp, tool, the step it happened in, the error the tool returned —
to the run's `.log`. A run can be "completed" and still be sick: dozens of failed calls mean the
steps are retrying their way to success on wrong instructions. Headless (`pipeline drive`) runs
fold their pinned per-step session transcripts at the terminal action, so their failures carry
exact step attribution; manager runs attribute by step time-windows.

View from the terminal any time with `pipeline stats [--project <path>] [--json]` (regenerates and
prints `SUMMARY.md`). Crashed/killed runs surface in SUMMARY under "in-flight or
crashed" via their leftover timeline buffers.

**Closing the loop — `/pipeline:optimize`.** A deliberately **user-invoked-only** skill
(`disable-model-invocation: true`, so no agent can auto-trigger it and burn tokens): run it weekly
(or whenever) and it reads `SUMMARY.md`, flags pipelines whose halts/duration/tokens regressed
against their own history — and pipelines with recurring tool failures (same tool failing run
after run) — digs into the relevant `runs/<id>.log` files only, and — with your approval —
applies targeted fixes through `pipeline-improver`. Failure-driven fixes are held to a standard:
only pipeline-attributable patterns (wrong command/path in a step's instructions, missing
preflight) get edits; one-off environment noise is reported, not "fixed". The stats files then
serve as the before/after evidence for whether each optimization helped.

## Nested-blocker delegation

Sometimes an iteration runs into a problem whose fix is clearly **outside the current task's scope** AND blocks further progress — a broken tool in a different module the task depends on, a missing upstream API, a regression in `main` that would need to land before this task can compile. For those cases the plugin splits the work between the executor (subagent, limited to preparing a brief) and `/pipeline:run` (main session, does the spawning and waiting — because a subagent cannot wait hours for a PR to merge or hold a long poll/merge loop across its finite context):

1. The executor stabilizes the parent branch (commits what's done, or reverts the unfinished chunk so the branch is green) and picks the blocker's target repo and base branch.
2. The executor emits a `blocker_delegation` brief in its final report with a full issue body, the child pipeline's first iteration path, a `partial_work_note` for resumption, and poll/deadline settings.
3. The `pipeline-manager` relays the brief up to `/pipeline:run`, which files a **new GitHub issue** on the blocker's target repo, posts a back-link on the parent's issue so the relationship is visible from both sides, and spawns a **child pipeline run** (a `pipeline-manager`) via the `Agent` tool. The child's worktree defaults to `main` of the blocker's target repo; the parent's branch is used as the base only when `main` lacks state that's strictly prerequisite for even starting the fix.
4. `/pipeline:run` **waits** — polling for the child PR to merge (default interval 5 minutes, default deadline 4 hours) — instead of advancing the chain.
5. On merge, `/pipeline:run` fetches the blocker target's updated base, merges (or rebases) it into the parent's branch, re-runs the iteration's verification gate, and re-invokes the `pipeline-manager` to re-enter the original iteration with the `partial_work_note` embedded in the prompt.

Closed-without-merging, merge conflicts, a red verification gate, or a deadline hit all halt the chain for human review rather than auto-retrying. The executor-side protocol (heuristics for in-scope vs tangent vs blocker, brief shape, executor invariants) lives in `step-executor`'s system prompt under "Nested-Blocker Delegation"; the caller-side flow (issue creation, child spawn, poll-wait, merge, re-invocation) lives in `/pipeline:run`'s skill under "Nested-Blocker Flow". If you edit one side, edit the other in lockstep.

## Nesting

When a single iteration is too large, the designer nests a sub-folder inside `steps/` with its own ordered sub-iterations. The executor descends into the sub-folder, runs every file in order, then returns to the parent's next file under `steps/`.

```
<your-project>/.claude/pipeline/<pipeline-name>/
├── PIPELINE.md
└── steps/
    ├── 01-plan.md
    ├── 02-scaffold.md
    ├── 03-implement/            ← nested mini-pipeline (no manifest of its own)
    │   ├── 01-core-module.md
    │   ├── 02-adapters.md
    │   └── 03-wire-up.md
    └── 04-verify.md
```

## Parallel / DAG pipelines (opt-in)

By default a pipeline is a **linear chain** — iterations run one after another, in order. That is the right shape for almost everything and it is what you get unless you explicitly opt in. Nothing about sequential pipelines changed.

When a pipeline has **genuinely independent branches** — steps that touch disjoint files and have no ordering dependency on each other — you can let them run **concurrently**. Two optional fields turn it on:

- In `PIPELINE.md` frontmatter: `execution: parallel`.
- On the independent `steps/NN-*.md` files: `step_id: <short-id>` and `depends-on: [<step_id>, ...]` to declare exactly which steps must finish first.

A pipeline runs in DAG mode **only when `execution: parallel` is set** on `PIPELINE.md` — `depends-on` by itself is not enough (a step that declares `depends-on` without `execution: parallel` runs sequentially, and you'll see a warning saying so). So whenever you add `depends-on`, also set `execution: parallel`. Otherwise it stays sequential. In DAG mode the `pipeline-manager` runs each ready set of steps concurrently, **each in its own throwaway git worktree** (under `.claude/worktrees/`), then merges the finished branches back into your working branch one at a time. Because the steps are supposed to be independent, those merges should never conflict — if two parallel steps DID edit the same file, the merge conflicts and the whole run halts with a clear message (that means the pipeline was mis-designed; make those steps sequential or split the shared file out).

**Bringing your own isolation (`isolation: manual`).** The per-step git worktree above isolates files but NOT environment/ports. If your pipeline already manages its own isolation — e.g. each step creates its own worktree and customises an env file so concurrent servers/ports don't overlap — set `isolation: manual` in `PIPELINE.md` frontmatter (default is `worktree`). In `manual` mode the manager spawns the parallel steps **in place** and does not create or merge any worktree of its own — your pipeline owns isolation end-to-end. Use it only when you genuinely run your own per-branch worktree/port scheme; otherwise leave the default.

Example: an `01-build` step, then `lint` / `typecheck` / `test` of disjoint modules running in parallel (each `depends-on: [build]`), then a `package` step that `depends-on: [lint, typecheck, test]`. Ask the designer to make independent branches parallel, or add the frontmatter by hand — it's just YAML.

Keep it sequential when in doubt; parallelism is an optimization for independent work, not a default.

- **`isolation: external` (run-level, sequential-only) — bring a consumer-provisioned worktree.** For *sequential* pipelines whose steps need project-specific provisioning the git-only worktree can't supply (allocated ports, dev secrets, a rendered `.env`, submodule worktrees), set `isolation: external` in `PIPELINE.md` frontmatter. The plugin then provisions ONE worktree per run: the bundled `pipeline next` CLI executes your convention-path hook scripts at `<project>/.claude/pipeline/.hooks/worktree-{create,destroy}` itself, in-process (deterministic subprocess work — no agent involvement) — once at run start (before the first step), shared by every step, and torn down once on every terminal outcome (including halt). The hook contract is unchanged and frozen: inputs arrive as `PIPELINE_WT_*` environment variables, the create hook prints one JSON object (`worktree_path`/`branch`/`env_file`/`ports`) on stdout and is idempotent per name, the destroy hook prints `{"ok":true}` or soft-fails with `{"ok":false,"detail":"…"}` — existing hooks work unmodified. Your steps just `cd` into the provisioned worktree and source its env file; they don't re-allocate anything. Declare the submodules to include via `submodules: [a, b, c]`. If the hooks are missing the run halts (it never silently runs in-place). Combining `isolation: external` with `execution: parallel` degrades to `isolation: manual` with a warning — `external` is sequential-only.

  **Optional mandatory `finalize` stage.** For a run that must not be considered "done" until some project-defined terminal action has SUCCEEDED, add a `worktree-finalize` hook (its presence opts you in; or set `finalize: true` in `PIPELINE.md`). The CLI runs it once at the very end of a COMPLETED run — after the last step, before teardown — and it **must return `{"ok":true}` or the whole run HALTS with the worktree preserved** (so nothing is reaped). It is entirely GENERIC: the plugin has zero knowledge of what your finalize hook does (commit something, push, publish — anything); it only requires `ok`. The hook runs with `PIPELINE_WT_ACTION=finalize` plus the same `PIPELINE_WT_*` context as create/destroy. A pipeline that ships no finalize hook (and no `finalize: true`) is byte-for-byte unchanged — the stage never fires.

- **`pipeline submodule bump` — a guarded submodule-pointer bump (a git primitive your finalize hook can call).** When a run advances a git *submodule* and you need the SUPERPROJECT's pointer recorded on its base branch, do NOT hand-roll `git` for it — call the bundled command instead: `bun "${CLAUDE_PLUGIN_ROOT}/apps/pipeline-cli/src/cli.ts" submodule bump --project-root <superproject> [--submodules a,b] [--base <branch>] [--source-worktree <path>] [--dry-run] [--json]`. It records the pointer change(s) and pushes them **isolation-safely** — the shared checkout is never `checkout`/`reset`/`switch`ed (its only mutation is `fetch` + `merge --ff-only`); all branch/commit work happens in a throwaway worktree off `origin/<base>`. Built-in guards make the dangerous mistakes *impossible*: it refuses to land a pointer that differs only because the base advanced past the run's fork (no accidental reverts), skips a pointer the base changed since the fork (no clobbering a concurrent bump), only bumps to a commit reachable from the submodule's `origin/<default>`, self-cleans orphaned throwaway worktrees from prior killed runs before it starts (idempotent), and STOPs on any error with a structured `halt_reason` + the exact manual recovery. It auto-detects drifted pointers from `.gitmodules` when `--submodules` is omitted, and a project with no submodules is a no-op. Output is one JSON object (`{status, bumped[], skipped[], pr, infra_sha, …}`); exit `0`/`1`/`2`. Needs `git` + `gh` on PATH.

## Configuration reference

Everything configurable, in one place. All fields are OPTIONAL — a pipeline with no frontmatter at all is a plain sequential chain driven by a pipeline-manager, with every step inheriting your session model.

**`PIPELINE.md` frontmatter (pipeline-level):**

| Field | Values (default first) | What it does |
|---|---|---|
| `model:` | *(inherit)* \| `haiku` \| `sonnet` \| `opus` \| `fable` \| any `claude-*` id | Default model for every step (a step's own `model:` overrides it). |
| `effort:` | *(inherit)* \| `low` \| `medium` \| `high` \| `xhigh` \| `max` | Default reasoning effort for every step (a step's own `effort:` overrides it). Applied for real by headless runs (`claude --effort` per step) and dashboard chat sessions; manager runs pass it to the Agent tool only when the harness supports a per-call effort param. |
| `execution:` | `sequential` \| `parallel` | `parallel` enables DAG mode — steps with satisfied `depends-on` run concurrently. Required gate: `depends-on` alone is ignored. |
| `isolation:` | `worktree` \| `manual` \| `external` | How steps are isolated. `worktree`/`manual` apply to parallel mode (git worktree per step vs. the pipeline owns its own scheme). `external` is run-level + sequential-only: YOUR hooks provision one worktree per run. |
| `runner:` | `manager` \| `headless` | Who drives the run: a `pipeline-manager` subagent (default), or the `pipeline drive` CLI with no manager agent at all (EXPERIMENTAL; v1 skips self-improvement). Headless runs get schema-validated step records from the claude JSON envelope, per-step cost/token stats, and resumable pinned sessions: a step that lacks information reports `needs-input` and parks the run (exit 4) — answer with `pipeline drive --resume --start <same-iteration> --answer "<text>"` and the SAME executor session continues where it stopped; interrupted attempts crash-resume the same way (2 tries per step). |
| `base_branch:` | `main` | External isolation only — the branch your create hook forks the run worktree from. |
| `delete_branches:` | `true` | External isolation only — on a COMPLETED run the destroy hook receives `PIPELINE_WT_DELETE_BRANCHES=1` (delete the run branch; the work is done). Set `false` to always keep branches. Failed runs always preserve. |
| `submodules:` | `[]` | External isolation only — submodule names the worktree should include (passed to your hook). |
| `finalize:` | `false` | External isolation only — require a `worktree-finalize` hook to SUCCEED before a completed run may finish (a `worktree-finalize.*` hook's presence also opts in). |
| `worktree_hook_dir:` | `.claude/pipeline/.hooks` | Where your external-isolation hook scripts live. |

**`steps/NN-*.md` frontmatter (per-step):**

| Field | Values (default first) | What it does |
|---|---|---|
| `model:` | *(pipeline default)* \| `haiku` \| `sonnet` \| `opus` \| `fable` \| `claude-*` | Pin this one step to a model tier. |
| `effort:` | *(pipeline default)* \| `low` \| `medium` \| `high` \| `xhigh` \| `max` | Pin this one step's reasoning effort (e.g. `max` on the hard reasoning step, `low` on scaffolding). |
| `step_id:` | *(filename stem)* | Short id other steps' `depends-on` and the `## Graph` reference. |
| `depends-on:` | *(previous step)* | `[id, id]` — DAG edges; honored only with `execution: parallel`. |
| `permission-mode:` | `acceptEdits` \| `dontAsk` \| `plan` \| … \| `inherit` | Headless runs only — the `--permission-mode` the `pipeline drive` executor subprocess gets for this step (also settable pipeline-wide in `PIPELINE.md`; `inherit` passes no flag). Manager runs ignore it. |

**Per-run model & effort overrides (no file edits):** to run the SAME pipeline once with different models or reasoning efforts on specific steps, pass overrides at invocation — `/pipeline:run <path> --model 02-implement=fable --effort 03-refine=max` (or just ask in words: "run steps 02 and 03 on fable, think as hard as possible on the review step"). An override beats the step's own frontmatter for that run only (`inherit` forces your session default); all other steps keep their configured values. Overrides persist in the run's state, so resumes keep them. The headless runner takes the same flags on `pipeline drive`; the dashboard's Launch form has default-model/default-effort rows plus per-step pickers for both.

**`PIPELINE.md` body — `## Graph` section (optional):** a fenced JSON block of `step_id` → conditional edges (`{"when": "<flag>", "goto": "<id>", "max": N}`) for declarative loops, skips, and bounded retries, routed on the `result_flags` steps report. No `## Graph` = plain `Next`-link chain.

**Environment variables** (dashboard on/off, prompt-match hook, headless executor command, hook timeouts, debug flags): see [Environment variables (reference)](#environment-variables-reference) below.

## No leaked branches or worktrees

Cleanup is part of the run contract, and it is outcome-aware:

- **Parallel / DAG runs** (`isolation: worktree`): after each clean merge the runtime deletes the merged branch (`git branch -d`) and removes its worktree (retrying with `--force` when build artifacts block it). A COMPLETED parallel run leaves zero `worktree-*` branches and zero entries under `.claude/worktrees/`.
- **External-isolation runs**: on a COMPLETED run the destroy hook is invoked with `PIPELINE_WT_DELETE_BRANCHES=1` so the run branch dies with the worktree (opt out via `delete_branches: false`). On `halted` / `depth-exhausted` the worktree AND branch are deliberately preserved for post-mortem and resume — that is not a leak, it is evidence.
- **Failure paths are surfaced, never silent**: a merge conflict or mid-layer halt enumerates every not-yet-merged branch + worktree path in the halt detail.

Verify (or clean) at any time with the bundled janitor:

```
pipeline gc            # report: registered/stale worktrees, prunable records, orphaned worktree-* branches
pipeline gc --clean    # prune + remove merged-only worktrees + safe-delete (-d) merged worktree-* branches
```

**Submodules are scanned too** (skip with `--no-submodules`): external-isolation runs provision worktrees in every declared submodule, so historically each run leaked one `worktree-*` branch into EACH submodule repo. `gc` reports them per submodule against each repo's own default branch, and `--clean` applies the same safe rules inside every submodule.

`--clean` is conservative by design: it never force-deletes a branch, never touches unmerged work or the current checkout, and lists everything it kept and why. One documented exception exists for the machine-owned namespace: `--clean --force-worktree-branches` force-deletes (`-D`) UNMERGED `worktree-*` branches — needed because squash-merged run branches read as "unmerged" to git forever. It never touches branches outside that pattern.

## Where things live

| What                          | Where                                             |
|-------------------------------|---------------------------------------------------|
| Your pipelines                | `<your-project>/.claude/pipeline/<pipeline-name>/...` |
| Parallel-step worktrees       | `<your-project>/.claude/worktrees/<auto-name>/` (transient — created + removed per DAG step) |
| Per-pipeline scripts          | `<your-project>/.claude/pipeline/<pipeline-name>/scripts/*.py` |
| Per-run feedback (Tier-2)     | `<your-project>/.claude/pipeline/<pipeline-name>/.feedback/<run_id>/` (gitignored, transient — created at run start, deleted after the end-of-run retrospective) |
| Plugin agents                 | `${CLAUDE_PLUGIN_ROOT}/agents/*.md` (read-only)   |
| Plugin skills                 | `${CLAUDE_PLUGIN_ROOT}/skills/*/SKILL.md` (read-only) |

The plugin never writes inside itself. Every pipeline file, every code edit performed by an executor, every log entry — all land in the consumer project's working directory.

## Live dashboard (`/pipeline:ui`)

The plugin ships a browser-based dashboard: watch pipelines run in real time, **launch runs**, answer their questions, and **edit pipeline files** — from a desktop or a phone (the layout is fully responsive; below the desktop breakpoint it becomes a single-pane app with bottom navigation).

> **The UI/analytics system is OFF BY DEFAULT.** Enable it by setting `PIPELINE_UI_ENABLED=1` (see [Enabling the UI/analytics system](#enabling-the-uianalytics-system--pipeline_ui_enabled) below) — otherwise the hooks no-op and the daemon never starts. Prefer the terminal? `pipeline logs -f` works with no daemon at all.

### Launching runs from the browser

The **Launch** tab lists every pipeline in the project (with its planned steps and configured models) in a **type-to-search picker** (every word of the query must match the pipeline's name or end-state), takes a task as typed text, **dictated speech**, or a path to a task file, and lets you override the model per step before launching. Launch runs through the interactive headless runner (`pipeline drive`): the run's events stream into the dashboard like any other run, and when a step reports `needs-input` the run parks and **its question appears on the run's board** — answer by tapping an option, typing, or dictating, and the SAME executor session resumes where it stopped.

Every active run — UI-launched or not — carries a **Stop** button (run cards + the overview board): it kills a UI-launched runner's process outright, and for a run that is actually dead but still shows "running" it appends the halt so the run finally leaves the Active view.

### Watching several runs at once

When nothing specific is selected, the middle pane is the **overview board**: every active run as a card (status, current step, progress, elapsed) with parked questions answerable right on the card — no switching required. The strip under the top bar (`ALL_n` + one chip per run) jumps between the overview and individual runs; a run waiting for an answer is flagged with `?`.

Selecting a run shows its **live analytics**: the RUN_ANALYTICS header carries status, a ticking total-elapsed clock, and the current step; each row of the iteration tree gets a **wall-clock chip** (active work time across attempts, ticking while the step runs; parked needs-input time excluded) plus the full per-step breakdown — tools (+fails), agents, in/out tokens, cache read/write, and the step's configured model/effort/permission-mode. Tools/tokens/cost come from the transcript fold (`/api/run-stats`), which now finds the run's session even when the mirror binding lacks a transcript path. The **TOOLS, FAIL, and AGENTS tiles are clickable**: TOOLS opens per-tool aggregates (call counts, failures, total/avg/slowest durations) with every individual timed call expandable; FAIL lists every failed call (tool, input, error text, step, manager vs subagent); AGENTS lists every spawned agent with its type, task description, duration, and its own token spend (in/out/cache) folded from that agent's transcript.

A run of a **target-family pipeline** (`<hub>/targets/<name>/`) shows its full expected chain: the target's own entry steps plus the hub's shared steps it chains into, with the current step tracked across both folders. Each not-yet-run step also shows its **configured model** from the step file's frontmatter (the observed model takes over once the step runs) — and the tree, the launch form, and the step detail all refresh automatically when a pipeline file changes on disk, whether saved from the built-in editor or edited externally.

### Voice input — quality model optional

Dictation has two engines. Out of the box it uses the browser's built-in Web Speech API (Chrome/Edge/Safari). For **Whisper-class quality**, give the daemon a transcription provider — set one of these in the environment the daemon starts from:

| Env | Provider / model |
|---|---|
| `OPENAI_API_KEY` | OpenAI `whisper-1` |
| `GROQ_API_KEY` | Groq `whisper-large-v3-turbo` (fast + cheap) |
| `PIPELINE_STT_URL` (+ `PIPELINE_STT_KEY`, `PIPELINE_STT_MODEL`) | any OpenAI-compatible endpoint, e.g. a local whisper server |

With a provider configured, the mic button records (tap to start/stop) and transcribes server-side — the key never reaches the browser, audio goes only to your chosen provider and is not persisted. `PIPELINE_STT_PROVIDER=openai|groq|custom` picks one when several are set. The language toggle offers **AUTO** (the default, server engine only): no language hint is sent, so Whisper detects it per utterance and **mixed-language dictation — e.g. Russian and English in one sentence — comes out right**; RU/EN pin a single language, and the browser fallback engine is always single-language.

### Editing pipelines from the browser

The **Pipelines** tab shows the project's pipelines as a **folder tree** mirroring the on-disk category layout (`workflows/…`, target families under `targets/`), with per-row ▶ Launch and ✎ Edit actions. The editor opens any file of the pipeline (manifest, steps, context modules, scripts); steps and the manifest get a **structured config form** — `model`, `step_id`, `depends-on`, `permission-mode` (plus `execution`/`runner` on the manifest) — that edits the frontmatter without touching keys it doesn't know, with the markdown body edited below. Save-conflict detection, an **add step** scaffold (designer's required-sections template, auto-numbered), **delete step**, and a **Validate** button running `pipeline plan`'s lint. When validate reports errors or warnings, an **AI Fix** button appears: pick a model (haiku/sonnet/opus/fable, default sonnet) and a background `claude -p` session edits the pipeline files to resolve the issues — the button shows a ticking timer while it works, then the editor re-validates and reloads automatically. Writes are strictly confined to `<project>/.claude/pipeline/` — the daemon refuses anything else. On desktop both side columns are mouse-resizable (widths persist).

### Phone access

The daemon binds `127.0.0.1` only by default. To open it from a phone on your network, set `PIPELINE_UI_HOST=0.0.0.0` **and** `PIPELINE_UI_TOKEN=<secret>` (mandatory — the UI can launch runs and edit files), then open `http://<machine-ip>:<port>/?token=<secret>` once; a cookie keeps the session signed in. Without a token the daemon refuses the wide bind and falls back to loopback. A VPN/tunnel (Tailscale etc.) works the same way and is preferable on untrusted networks.

Once enabled, open it with:

```
/pipeline:ui
```

Architecture in one paragraph: a single shared Bun daemon (lives inside the plugin install dir, never touches your project files) listens on `127.0.0.1` on a stable high-ephemeral port derived from your home directory. Every project that uses this plugin (and has the UI enabled) registers itself with the daemon automatically on `SessionStart`, so opening Claude Code in any pipeline-using project makes that project appear in the dashboard's project picker. The daemon **never writes inside the consumer project** — it only reads `<project>/.claude/pipeline/.runtime/events.jsonl` (an append-only journal written by `/pipeline:run` and the analytics hooks) and the pipeline manifests. Two completely different projects → two entries in the same dashboard, switchable from the top bar. A git **worktree** of a project resolves back to its main repo, so a worktree never appears as a separate project — its events show up under the main project with a `worktree` tag.

### What's shown

- **Active runs** with status badge (running / improving / extracting script / awaiting blocker), elapsed time, and progress bar.
- **Iteration tree** for the selected run — completed iterations checked, current one shimmering, pending greyed.
- **Blocker children** nested under their parent run, so the nested-blocker delegation flow is visible as a tree.
- **Live event stream** filtered to the selected run, animated in as events arrive.
- **Analytics panel** per run: tools called, tools failed, agents spawned, input/output/cache tokens — all collected via the plugin's `PostToolUse` and `Stop` hooks and aggregated client-side.
- **Light / dark theme** with animated transition; persisted to `localStorage`.

### What it stores on disk

- Daemon bookkeeping (port, pid, project registry): `~/.claude/pipeline-ui/` (per-user, not per-project).
- Event journal per project: `<project>/.claude/pipeline/.runtime/events.jsonl` (gitignored — add `.runtime/` to your project's `.gitignore` if it isn't already).
- The plugin install dir itself is read-only — daemon code lives there but every byte of state lives elsewhere.

### Requirements & gotchas

- **Bun** ([bun.sh](https://bun.sh)) is required for the UI daemon and hooks (and for the bundled `pipeline` CLI).
- The daemon binds to `127.0.0.1` only. Not network-exposed.
- Two Claude Code sessions in the same project → both feed events into the same journal → one dashboard shows them.
- A separate project on the same machine → registers automatically → picker has two entries → same dashboard.
- Idle daemon auto-exits after 60 minutes (override with `PIPELINE_UI_IDLE_MINUTES`).

### Upgrades & restarts

The daemon follows the installed plugin version automatically (a plugin update mid-session hands the port off to the new version within ~30 s; a new Claude Code session reconciles on start). The one gap: a daemon that was **already running when you installed the update** and hasn't seen a new session keeps serving the old version. When that happens the dashboard's top bar shows an **UPDATE v\<new\>** button — click it and the daemon restarts into the installed version on the same port; open tabs reconnect and reload themselves (unsaved editor changes prompt first). The same restart is available from a terminal:

```bash
bun "<plugin>/apps/pipeline-cli/src/cli.ts" ui --restart   # or: curl -X POST http://127.0.0.1:<port>/api/restart
```

### If the dashboard is empty

You probably haven't run a pipeline yet in any registered project. The picker shows projects that have at least registered themselves via `SessionStart` or emitted any event. Run `/pipeline:design` or `/pipeline:run` somewhere — the project shows up immediately and events stream in.

### Terminal logs instead of the browser — `pipeline logs`

Prefer to watch events scroll by in a terminal? Tail the same event journal the dashboard reads, pretty-printed as one line per event:

```bash
# from anywhere inside a pipeline project:
bun "<plugin>/apps/pipeline-cli/src/cli.ts" logs --follow
```

```
08:00:01 ▶ pipeline.started   abcdef12  build-cli [opus]
08:00:02 → iteration.started  abcdef12  #1 01-scaffold.md [opus]
08:00:03 · tool.called        abcdef12  Bash
08:00:05 ✓ pipeline.completed abcdef12  build-cli
```

Flags: `-f`/`--follow` to stream live, `--tail <n>` (default 20) for the initial backlog, `--all` for the whole journal, `--json` for raw JSON lines, `--no-color`, and `--project <path>` to point at a project other than the cwd. It is **read-only** — it never starts the daemon or writes anything — so it works whether or not the dashboard is enabled. Stop it with Ctrl-C.

### Enabling the UI/analytics system — `PIPELINE_UI_ENABLED`

**The dashboard, the daemon, and the analytics hooks are OFF BY DEFAULT.** They turn on only when you set the environment variable `PIPELINE_UI_ENABLED` to a non-empty, non-falsy value (`1`, `true`, `yes`, `on`, or really any value other than `0`/`false`/`no`/`off`):

```jsonc
// .claude/settings.json  (per project — hooks inherit the session env)
{ "env": { "PIPELINE_UI_ENABLED": "1" } }
```

When it is **unset** (the default):

- the `SessionStart` hook does not launch/register the daemon or write `session.opened`,
- the analytics hooks (`PreToolUse`/`PostToolUse`/`SubagentStop`/`Stop`) emit nothing and do no filesystem work,
- `/pipeline:ui` prints how to enable instead of starting the dashboard.

When you set it, all of the above turn on. Either way your pipelines run identically — the variable only controls the observability layer. You can also set it in your shell or OS environment before launching Claude Code. Because the hook *registrations* live in the plugin, Claude Code still launches each hook's (instantly-exiting) process even when disabled; to remove even that, disable the plugin. Your core run lifecycle is always journaled by `/pipeline:run`, so `pipeline logs` works as a lightweight terminal view regardless of this setting.

> Performance note: even with the UI enabled, `SubagentStop` only fires the hook for the `pipeline-manager` subagent (via a `matcher`), so the dozens of other subagent stops in a run no longer spawn a hook process.

### Prompt match hook (opt-in) — `PIPELINE_PROMPT_MATCH_ENABLED`

The plugin also ships a `UserPromptSubmit` hook that surfaces a matching pipeline for whatever you just typed — deterministic auto-discovery with **zero always-loaded context**. It runs the same BM25 matcher `/pipeline:find` and `/pipeline:dispatch` use against your prompt, and **only on a confident single match** (exactly one candidate, or the top score at least 2× the runner-up — the same ambiguity threshold `/pipeline:dispatch` uses) injects one line of context suggesting `/pipeline:run <first-iteration>` or `/pipeline:dispatch`. On no match or an ambiguous match it stays completely silent; it never blocks or modifies your prompt.

Like the UI hooks, it is **OFF BY DEFAULT** and gated by its own environment variable (same non-falsy semantics as `PIPELINE_UI_ENABLED`):

```jsonc
// .claude/settings.json  (per project — hooks inherit the session env)
{ "env": { "PIPELINE_PROMPT_MATCH_ENABLED": "1" } }
```

When enabled, it still skips silently for slash commands, prompts shorter than 20 characters, and projects with no `.claude/pipeline/` directory — so it only ever speaks up when a free-form task genuinely looks like one of your pre-authored pipelines.

### Environment variables (reference)

Everything the plugin reads from the environment, in one place. Set the per-project ones via `.claude/settings.json` → `"env": { ... }` (hooks and skills inherit the session environment).

**User-facing configuration:**

| Variable | Default | Purpose |
|---|---|---|
| `PIPELINE_UI_ENABLED` | off | Master opt-in for the whole UI/analytics system (dashboard daemon + analytics hooks). Non-falsy value enables; unset/`0`/`false`/`no`/`off` disables. |
| `PIPELINE_STATS_ENABLED` | **on** | Per-run measurement files under `.claude/pipeline/.stats/` (durations, per-step timings, outcomes, tokens, tool failures — see "Measuring every run" above). Set `0`/`false`/`no`/`off` to disable. Independent of `PIPELINE_UI_ENABLED`. |
| `PIPELINE_PROMPT_MATCH_ENABLED` | off | Opt-in for the `UserPromptSubmit` pipeline-match hook (section above). Same non-falsy semantics. |
| `PIPELINE_UI_IDLE_MINUTES` | `60` | Minutes of inactivity before the dashboard daemon auto-exits. |
| `PIPELINE_UI_HOST` | `127.0.0.1` | Daemon bind address. Any non-loopback value (e.g. `0.0.0.0` for phone access) REQUIRES `PIPELINE_UI_TOKEN` — otherwise the daemon falls back to loopback with a warning. |
| `PIPELINE_UI_TOKEN` | unset | Access token enforced on every request when set (`Authorization: Bearer`, `?token=`, or the cookie the first `?token=` page-load pins). Mandatory for a non-loopback bind: the UI can launch runs and edit pipeline files. |
| `OPENAI_API_KEY` / `GROQ_API_KEY` | unset | Enables server-side Whisper-class dictation in the dashboard (`/api/transcribe`). Without either, voice input falls back to the browser's Web Speech API. |
| `PIPELINE_STT_URL` / `PIPELINE_STT_KEY` / `PIPELINE_STT_MODEL` / `PIPELINE_STT_PROVIDER` | unset | Custom OpenAI-compatible transcription endpoint (e.g. a local whisper server), its key/model, and a provider override (`openai`\|`groq`\|`custom`) when several are configured. |
| `PIPELINE_DRIVE_EXECUTOR_CMD` | `claude -p --agent pipeline:step-executor --model {model} --permission-mode {permissions} --session-id {session} --output-format json --json-schema {schema}` | Overrides the command template the EXPERIMENTAL headless runner (`pipeline drive`) spawns per step. Whitespace-split; tokens `{model}` / `{permissions}` / `{session}` / `{schema}` are substituted (a flag+token pair is dropped when the token has no value; on an answer/crash resume the flag before `{session}` becomes `--resume`); the step prompt always arrives on stdin. Equivalent to `--executor-cmd`. |
| `PIPELINE_HOOK_TIMEOUT_MS` | per-hook (600 000 create/finalize, 300 000 destroy) | Overrides the external-isolation worktree-hook timeout (positive integer, milliseconds). Mostly useful for testing hooks. |
| `PIPELINE_GIT_BIN` / `PIPELINE_GH_BIN` | `git` / `gh` from PATH | Override which `git`/`gh` binaries the CLI's guarded git operations (`pipeline submodule bump`) invoke. |
| `PIPELINE_UI_DEBUG` / `PIPELINE_RELAY_DEBUG` | off | `=1` prints diagnostic detail to stderr from the event writer / relay hooks. Debugging only. |

**Hook contract (set BY the plugin, read by your hook scripts):** every `PIPELINE_WT_*` variable passed to the `worktree-create` / `worktree-finalize` / `worktree-destroy` hooks is specified in [`docs/worktree-hook-contract.md`](docs/worktree-hook-contract.md) — that contract is frozen; write hooks against it, never set those variables yourself.

**Internal (do not set):** `PIPELINE_UI_RUN_ID` / `PIPELINE_UI_PARENT_RUN_ID` are run-correlation plumbing between `/pipeline:run` and the analytics hooks; setting them manually mis-attributes events. `PIPELINE_STATS_RUNNER` is set by `pipeline drive` to tag headless runs in the measurement files.

## Resuming a halted pipeline

If an executor halts on a blocker, fix the underlying issue, then re-invoke:

```
/pipeline:run <absolute-path>/.claude/pipeline/<pipeline-name>/steps/<NN-halted-iteration>.md
```

Iterations are designed to be idempotent, so re-running from the halted step is safe.

## Tips

- Start with a clear one-sentence end-state when calling `/pipeline:design`. Vague goals produce vague pipelines.
- Prefer flat linear chains. Nest only when an iteration is itself a mini-pipeline.
- Pipelines double as a knowledge base: after completion, the folder documents *what was done and why* and can be read by humans or future agents.
