---
name: run
description: Run (or resume) a pipeline the pipeline-designer already wrote. Stays in the main session as the thin supervisor and spawns a single pipeline-manager that drives the whole chain in fresh-context step-executors. Invoke when the user wants to run or resume a pipeline.
user-invocable: true
allowed-tools: Read, Bash, Glob, Grep, Agent, WebFetch, WebSearch, Skill, TaskCreate, TaskGet, TaskList
argument-hint: <absolute-path-to-iteration.md> [--model <step_id>=<model> ...] [--effort <step_id>=<level> ...]
---

# Run a Pipeline

You are starting or resuming pipeline execution. The iteration file to start at is provided in `$1`.

## What you are doing

You are the **supervisor** running in the main session (depth 0). You do **not** loop over iterations yourself. Instead you spawn a single **`pipeline-manager`** subagent (depth 1) that drives the entire chain — spawning a fresh `step-executor` per iteration and running `pipeline-improver` / `pipeline-script-creator` between steps (the `pipeline next` CLI it drives auto-emits the per-iteration UI events and executes any external worktree hooks itself) — and returns a structured report when the run completes, halts, or hits an out-of-scope blocker.

You stay at depth 0 because three things must live in the main session and a subagent cannot do them: (a) own a stable pid for the UI's liveness tracking, (b) wait hours for an external condition (a blocker PR to merge) and resume, (c) eventually surface results to the human. So your job is: mint the run id, set up UI tracking, spawn the manager, and act on its report — including running the nested-blocker poll-wait and re-invoking the manager to resume.

## CRITICAL — token discipline: read almost nothing

This skill is a supervisor, not a reader. Every iteration file is read by a `step-executor` in its own fresh context; per-step model resolution happens inside the `pipeline-manager`.

- **Never `Read` an iteration file (`steps/**/*.md`).** You never touch them — not even their frontmatter. The manager resolves per-step models; you only pass it the pipeline-level default.
- **Read `PIPELINE.md` only as frontmatter (`limit: 50`), once, at chain start**, to extract the `model:` field for `pipeline_default_model` and nothing else. Do not pass its content to the manager.
- The only files you may `Read` in full are ones you write yourself in the nested-blocker flow (issue bodies, partial-work notes).

## Runner selection (experimental)

When the `PIPELINE.md` frontmatter you read for `model:` also carries `runner: headless`, do NOT spawn a `pipeline-manager`. Instead run the bundled headless driver as a background process and supervise it:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/apps/pipeline-cli/src/cli.ts" drive \
  --root "<pipeline_root>" --run-id "<run_id>" --start "<iteration-path>" \
  --default-model "<pipeline_default_model-or-null>" \
  [--default-effort "<level-or-null>"] \
  [--model "<step_id>=<model>" ...] [--effort "<step_id>=<level>" ...] --json [--resume]
```

Launch it with `run_in_background: true` and act on its final JSON when it exits: exit 0 → emit `pipeline.completed`; exit 1 → emit `pipeline.halted` and surface the reason; exit 3 (`blocked`) → run the nested-blocker flow below, then re-run `drive` with `--resume`. Everything else about your supervisor role (run id, liveness, mirror binding, human reporting) is unchanged. Headless v1 skips self-improvement actions and leaves `.feedback/<run_id>/` intact — mention that in your final report so the user can run a manual improver pass. When `runner:` is absent or `manager`, proceed exactly as below.

## Model selection

A pipeline (and each iteration) may opt into a Claude model via the OPTIONAL `model:` frontmatter field. The field defaults to inherited — omit it and the step-executor inherits the session model. You resolve only the **pipeline-level default** and hand it to the manager; the `pipeline next` CLI resolves the per-iteration effective model (per-run override ?? `step.model` ?? `pipeline_default_model`) and the manager passes it to each `step-executor` via the `Agent` tool's per-call `model` parameter. **Pass the resolved value through unchanged — do NOT translate an alias to a canonical id.** The `Agent` `model` param accepts the aliases, canonical ids, and `inherit` directly.

**Accepted `model:` vocabulary** (end-to-end): one of the aliases `haiku` / `sonnet` / `opus` / `fable`, OR any exact canonical Claude model id (a string starting with `claude-`, e.g. `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-fable-5`), OR `inherit` / absent (→ session default).

**Resolve `pipeline_default_model`:** if `<pipeline-root>/PIPELINE.md` exists, `Read` it with `limit: 50` and take the frontmatter `model:` value when it is an accepted value (an alias, a `claude-*` id, kept verbatim); `inherit`/absent → `null`. If `PIPELINE.md` is absent, `null`. **Invalid values** — anything that is not one of the accepted aliases, a `claude-*` id, `inherit`, or absent — warn once and fall through to `null` (do not halt). (Reading ≤ ~10 lines of frontmatter is metadata extraction, not content reading — it never duplicates what the step-executor loads.)

**Per-run step overrides (`step_model_overrides`):** the user may pin individual steps to a different model FOR THIS RUN ONLY — without editing any pipeline file — either with explicit flags after the path (`--model <step_id>=<model>`, repeatable) or in natural language ("run steps 02-implement and 03-refine on fable"). Normalize whatever they said into `<step_id>=<model>` pairs: `step_id` is the step's `step_id` frontmatter or its filename stem (e.g. `02-implement` for `steps/02-implement.md`); `model` uses the accepted vocabulary above (`inherit` forces the session default for that step). You do NOT read any step file to validate the ids — the CLI warns on unknown ids and rejects invalid models. Pass the pairs to the manager as `step_model_overrides` (see 5.1) or, on the headless path, as repeated `--model` flags on the `drive` command. An override beats the step's own `model:` frontmatter; steps without an override are untouched. The CLI persists the overrides in the run's state at init, so resumes keep them automatically — re-pass the same pairs when re-invoking the manager anyway (harmless, and it survives a deleted `.runtime/`). No overrides mentioned ⇒ omit entirely.

## Effort selection (reasoning effort — the `model:` twin)

A pipeline and each iteration may also opt into a **reasoning effort** via the OPTIONAL `effort:` frontmatter field (levels: `low` / `medium` / `high` / `xhigh` / `max`; `inherit`/absent → the session's effort). It resolves through the exact same ladder as the model — per-run override ?? step `effort:` ?? pipeline `effort:` ?? inherit — entirely inside the `pipeline next` CLI. Resolve `pipeline_default_effort` from the same `PIPELINE.md` frontmatter read you already do for `model:` (same invalid-value rule: warn once, fall to `null`), hand it to the manager as `pipeline_default_effort`, and normalize user requests like "run 03-refine on max effort" into `step_effort_overrides` pairs (`<step_id>=<level>`) passed exactly like the model pairs (`--effort` flags on the headless path). HONESTY NOTE: the headless runner applies effort for real (`claude --effort` per spawn); in manager mode the Agent tool may not expose a per-call effort parameter yet — the manager passes it when supported and otherwise the step inherits the session effort (see pipeline-manager.md § run-step).

## Prerequisites

- A pipeline exists under the current project's `./.claude/pipeline/` (typically authored with `/pipeline:design`).
- `$1` is the absolute path to an iteration file under `<pipeline>/steps/` (usually `steps/01-*.md` to start fresh, or any later iteration to resume).
- The current working directory is the consumer project's root — all file edits performed by iterations land here.

## UI event emissions (pipeline-ui)

You emit the **run-level lifecycle** to `<project>/.claude/pipeline/.runtime/events.jsonl`; the per-iteration events (`iteration.*`, `improver.*`, `script_creator.*`, `worktree.*`) are auto-emitted in-process by the `pipeline next` CLI the manager drives (the manager itself emits only the retrospective's improver/script events). Because the whole run shares one `session_id`, the mirror binding you register below lets the daemon correlate the manager's and step-executors' tool calls to this run. Emissions are best-effort — never let a failure halt the run.

**One-time setup at the start of the Procedure:** generate a 12-char run id, e.g. `bun -e "console.log(require('crypto').randomBytes(6).toString('hex'))"`. Capture the literal value (e.g. `abc123def456`).

**CRITICAL — pass `run_id` literally on every writer call.** Claude Code's Bash tool does not preserve shell state between invocations, so an exported env var does not reach the next `pipeline event` call. Pass `run_id=<the-literal-id>` as a k=v argument on EVERY call. k=v args have no spaces around `=`; single-quote a value containing spaces.

**Emission helper** (run with Bun, silent on success, exits 0 even on failure — do not check output):

```bash
bun "${CLAUDE_PLUGIN_ROOT}/apps/pipeline-cli/src/cli.ts" event <event-type> run_id=<literal-id> [k=v ...]
```

**What you emit (one call per bullet):**

- After the banner: `pipeline.started run_id=<id> pipeline_name=<name> first_iteration_path=<abs> pipeline_root=<abs> default_model=<model-or-null>` — `default_model` is `pipeline_default_model` (an alias `haiku`/`sonnet`/`opus`/`fable`, a canonical `claude-*` id, or literal `null`).
- Immediately after `pipeline.started`, write the **liveness lockfile** so the daemon can detect this run dying without a terminal event: `bun "${CLAUDE_PLUGIN_ROOT}/apps/pipeline-cli/src/cli.ts" event write-liveness run_id=<id> pid=$PPID` (PowerShell: `pid=$PID`). Pass the OS pid of the process **driving** this supervisor — `$PPID` is the best portable handle for the persistent Claude session. The daemon only auto-retires a run when this pid is a real, dead process, so an untrustworthy value is a safe no-op.
- Immediately after, register the **mirror binding** so the daemon mirrors this run's transcripts into the UI chat panel: `bun "${CLAUDE_PLUGIN_ROOT}/apps/pipeline-cli/src/cli.ts" event register-mirror-binding run_id=<id> pipeline_name=<name> iteration_path=<abs-first-iteration>`. Idempotent; silent on success. If `CLAUDE_SESSION_ID` is unset it writes `session_id=null` and the daemon no-ops the tail.
- On `status: completed`: `pipeline.completed run_id=<id> pipeline_name=<name>`.
- On `status: halted` / `depth-exhausted` (or any unrecoverable stop): `pipeline.halted run_id=<id> pipeline_name=<name> iteration_path=<abs> halt_reason=<short>`.
- On loop exit (**either** outcome), after the terminal event, clear the lockfile: `bun "${CLAUDE_PLUGIN_ROOT}/apps/pipeline-cli/src/cli.ts" event clear-liveness run_id=<id>`. A cleanly-finished run leaves no lockfile; only a crash/kill leaves a stale one (dead pid) for the daemon to retire.

The writer pops `run_id`, `parent_run_id`, and `session_id` out of the kv args and uses them as envelope fields, so those names are reserved — do not use them as data-field names.

## Procedure

1. If `$1` is empty, ask the user which iteration file to start at (suggest `./.claude/pipeline/<pipeline>/steps/01-*.md`). Do not proceed without a path.
2. Verify the file exists and is under the current project's `.claude/pipeline/` tree. If not, stop and ask the user to confirm the path.
3. **Derive the pipeline name and root from the path — do not read iteration content.** Walk up from the iteration file: the parent is `steps/` (or a nested sub-step folder — keep walking until you reach `steps/`), and the parent of `steps/` is the pipeline root; its basename is the pipeline name. Show a one-line banner:

   ```
   ▶ Starting pipeline <pipeline-name>
   ```

   Verify the pipeline-root exists (`Glob` for `<pipeline-root>/PIPELINE.md` — existence only). Resolve `pipeline_default_model` per "Model selection" above.

4. **Generate the run id** and emit `pipeline.started`, then `write-liveness`, then `register-mirror-binding` (see "UI event emissions").

5. **Set up the chain state:** `current_iteration = $1`, `partial_work_note = null`. Then **enter the supervise loop**:

   ### 5.1 Spawn the `pipeline-manager`

   Invoke the `Agent` tool with `subagent_type: "pipeline-manager"` and a prompt that hands it every field it needs:

   ```
   Orchestrate this pipeline run. Drive the chain to completion via fresh
   step-executors, run the improver/script-creator between steps, and end with
   a structured Pipeline Manager Final Report. (The `pipeline next` CLI
   auto-emits the per-iteration UI events — you emit only the retrospective's.)

   run_id = <literal run id>
   pipeline_name = <name>
   pipeline_root = <abs path to the pipeline root folder>
   pipeline_default_model = <haiku|sonnet|opus|null>
   current_iteration = <current_iteration>

   <if PIPELINE.md frontmatter set an effort, or the user asked for one>
   pipeline_default_effort = <low|medium|high|xhigh|max|null>
   </if>

   <if the user asked for per-step model overrides>
   step_model_overrides = <step_id>=<model>, <step_id>=<model>
   </if>

   <if the user asked for per-step effort overrides>
   step_effort_overrides = <step_id>=<level>, <step_id>=<level>
   </if>

   <if partial_work_note is not null>
   partial_work_note (resume after a nested-blocker landed — pass into the first
   step-executor spawn, then clear):
   <partial_work_note>
   </if>
   ```

   Do NOT pass any iteration or manifest content in the prompt — only the fields above. The manager reads what it needs from disk.

   ### 5.2 Parse the Pipeline Manager Final Report

   Extract `run.status`, `last_iteration.file`, `next_on_resume.file`, `blocker_delegation`, `halt_reason`, and `retrospective`. If the manager failed to emit the report in the expected shape, STOP, surface the raw output, emit `pipeline.halted` + `clear-liveness`, and exit — a malformed report likely means the agent hit an error mid-run.

   The `retrospective` section is the manager's **Tier-2 end-of-run summary** (`null` when the run journaled no problems). It reports what the run auto-improved (doc fixes applied + scripts extracted) and lists the HUMAN-ONLY problems (`project-issue` / `env` / `friction`) the run surfaced. You do NOT act on it — you only surface it to the user in your report (see "Report format"). Keep this section even when the run halted; the manager runs the retrospective on both `completed` and `halted`.

   ### 5.3 Act on `run.status`

   - **`completed`** → emit `pipeline.completed` + `clear-liveness`; exit the loop. Pipeline finished.
   - **`halted`** or **`depth-exhausted`** → emit `pipeline.halted` (with `last_iteration.file` and `halt_reason`) + `clear-liveness`; exit the loop. Surface `halt_reason` to the user.
   - **`blocked-delegating`** → run the **Nested-Blocker Flow** below. On successful resolution, set `current_iteration = next_on_resume.file`, set `partial_work_note` from the brief, and go back to 5.1 to re-invoke the manager. On terminal failure, emit `pipeline.halted` + `clear-liveness` and exit.

6. When the loop exits, deliver the report in the format below.

## Nested-Blocker Flow (supervisor-side)

The manager relays a `blocker_delegation` brief (originally emitted by a step-executor) when an iteration hits an out-of-scope blocker. You run this sequence in the main session — neither the manager nor the step-executor can spawn an hours-long poll-wait or a git-merge loop across a finite context.

Brief fields: `parent_task_repo`, `parent_task_issue`, `parent_branch`, `parent_pipeline_iteration`, `blocker_target_repo`, `blocker_pipeline_first_iteration`, `blocker_worktree_source`, `new_issue_title`, `new_issue_body`, `partial_work_note`, `poll_interval_minutes` (default 5), `deadline_hours` (default 4).

1. **File the blocker issue** on `<blocker_target_repo>`:

   ```bash
   gh issue create --repo <blocker_target_repo> --title "<new_issue_title>" --body "<new_issue_body>"
   ```

   Record `blocker_issue_number` and `blocker_issue_url`. If a `--label` fails because the label doesn't exist, drop it and retry. Emit `blocker.delegated run_id=<id> parent_iteration_path=<abs> blocker_issue_url=<url> child_run_id=<child-id> blocker_target_repo=<owner/repo>` (mint a `child_run_id` now for the child run).

2. **Back-link the parent's tracking issue** (skip when `parent_task_issue` is empty):

   ```bash
   gh issue comment <parent_task_issue> --repo <parent_task_repo> --body "Blocked by <blocker_issue_url> (from pipeline iteration <parent_pipeline_iteration>)."
   ```

3. **Resolve `blocker_pipeline_first_iteration`.** If it is `REQUIRES_DESIGN`, spawn `pipeline-designer` first with the brief's `blocker_design_prompt`, then use the first iteration of the new pipeline.

4. **Spawn the child pipeline run** — a child `pipeline-manager` via the `Agent` tool (`subagent_type: "pipeline-manager"`), pointed at `blocker_pipeline_first_iteration`, with its own `run_id=<child_run_id>` and `parent_run_id=<id>` (pass `parent_run_id` literally on the child's events for UI nesting). Its prompt includes the brief fields plus the newly-minted `blocker_issue_number` / `blocker_issue_url`, and the instruction that the child's PR body MUST include `Closes #<blocker_issue_number>`. Provision the child's worktree/branch from `<blocker_worktree_source>`; the child never writes into the parent's worktree. You wait for the child's PR, not for the child subagent call to return.

5. **Poll-wait loop.** Every `poll_interval_minutes`, search for a PR closing the blocker issue and emit `blocker.polling run_id=<id> blocker_issue_url=<url> pr_state=<OPEN|MERGED|CLOSED|none>`:

   ```bash
   gh pr list --repo <blocker_target_repo> --state all --search "<blocker_issue_number> in:body" --json number,url,state,mergedAt,mergeCommit,headRefName
   ```

   Prefer PRs whose body contains `Closes #<blocker_issue_number>` or `Fixes #<blocker_issue_number>`. Classify:
   - `MERGED` → go to 6.
   - `CLOSED` (not merged) → STOP, surface the URL, fail the flow. Do NOT auto-retry.
   - `OPEN` / not-yet-created past `deadline_hours` → STOP, surface the last state, fail the flow.
   - Otherwise → sleep `poll_interval_minutes` and re-check.

6. **Merge the blocker into the parent's branch.** Confirm the parent branch is clean (`git status --porcelain` empty) and HEAD matches `<parent_branch>`; if unclean, STOP. Determine the repo path (same-repo → the parent's working dir; cross-submodule → the submodule path). Fetch and merge (append-only, never rebase-onto, never force):

   ```bash
   git -C <repo-or-submodule-path> fetch origin <base_branch>
   git -C <repo-or-submodule-path> merge origin/<base_branch> --no-edit -m "chore: merge <base_branch> after blocker #<blocker_issue_number> resolved"
   ```

   On conflict, STOP and surface the conflict list — do not auto-resolve. Emit `blocker.resolved run_id=<id> blocker_issue_url=<url> merged_pr_url=<url>`.

7. **Re-run the parent iteration's verification gate** (the Success Criteria commands from `<parent_pipeline_iteration>`). 0 failures required; on any failure STOP — the parent cannot resume on a red baseline.

8. **Resume.** Push the merged branch (never force-push). Return to 5.1: re-invoke the `pipeline-manager` with `current_iteration = <parent_pipeline_iteration>` and `partial_work_note` from the brief.

## Supervisor invariants

- **Spawn ONE manager per supervise-loop pass.** You never spawn `step-executor`, `pipeline-improver`, or `pipeline-script-creator` directly — those are the manager's. The only subagents you spawn are `pipeline-manager` (the run, and any blocker-child run) and, if `REQUIRES_DESIGN`, `pipeline-designer`.
- **The Pipeline Manager Final Report is the only structured signal.** Don't infer intent from prose; act only on its fields.
- **Never read iteration files or `PIPELINE.md` content.** You read at most ~10 lines of `PIPELINE.md` frontmatter (for `pipeline_default_model`) and never touch `steps/**`.
- **Run-level events, liveness, and the mirror binding are yours; per-iteration events are auto-emitted by the `pipeline next` CLI** (the manager adds only the retrospective's improver/script events). Don't double-emit `iteration.*`.
- **One child per blocker.** If the child's PR is CLOSED without merge, STOP — no replacement.
- **No silent deadline extensions; no force-push, ever.** Cross-submodule blockers merge inside the submodule.
- **Always clear the liveness lockfile after the terminal event**, on either outcome.

## Report format

After the loop exits, show the user:

- Which iteration finished last (`last_iteration.file`).
- Whether the pipeline completed or halted (and on `halt_reason`, the iteration where it stopped).
- If completed: the pipeline folder path, so they can re-read iterations as a knowledge base.
- If any blocker-delegation cycles ran: the blocker issue URLs and their resolution.
- **The retrospective, when `retrospective` is non-null.** Surface it concisely:
  - **What the pipeline auto-improved this run** — from `retrospective.auto_improved` (how many problems fed the improver, the doc fixes applied, and the scripts extracted).
  - **Problems for you to handle** — the `retrospective.human_only` list (the `project-issue` / `env` / `friction` problems the run surfaced, each with its category, one-line summary, and iteration). These were NOT auto-fixed — they need a human. Show them as a short bullet list; omit this part when the list is empty. When `retrospective` is `null`, say nothing about it.
