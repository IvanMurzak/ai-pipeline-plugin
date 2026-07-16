# Nested-Blocker Delegation — brief fields & orchestration flow

This document is loaded **on demand**:

- The **`step-executor`** reads it when (and only when) it has classified an obstacle as a case (c) major out-of-scope blocker and is about to emit a `blocker_delegation` brief — the exact field list and issue-body template live here.
- The **orchestration-layer flow** and **guardrails** sections are reference for maintainers and for the `/pipeline:run` supervisor, which performs them. The step-executor never performs any of them.

## Blocker delegation brief — fields to include

All fields are mandatory unless marked optional. The orchestration layer uses this verbatim:

- `parent_task_issue` — the parent iteration's tracking issue, if any (owner/repo#number). Optional (free-form parent tasks have none).
- `parent_task_repo` — the repo the parent iteration is running inside.
- `parent_branch` — the branch this iteration is running against.
- `parent_pipeline_iteration` — absolute path of the iteration file that discovered the blocker.
- `blocker_target_repo` — owner/repo the blocker lives in.
- `blocker_pipeline_first_iteration` — absolute path of the first iteration in the pipeline the child should run to fix the blocker. If no dedicated pipeline exists yet, set this to `REQUIRES_DESIGN` and add a `blocker_design_prompt` field the supervisor passes to `pipeline-designer` before spawning the child.
- `blocker_worktree_source` — one of `main` or `parent-branch`, plus one-sentence rationale when it's `parent-branch`.
- `new_issue_title` — concise blocker title (the supervisor creates the issue; the executor supplies the title and body).
- `new_issue_body` — the full issue body text, following this template:

  ```
  ## Context
  Blocking work on <parent_task_repo>#<parent_task_issue> (branch `<parent_branch>`).

  ## Problem
  <what is wrong, with evidence / a minimal repro>

  ## Expected
  <what needs to be true for the parent iteration to resume>

  ## Scope
  <what this issue does and does not cover — keep it tight>

  ## Parent task
  - Parent issue: <parent_task_repo>#<parent_task_issue>
  - Parent branch: `<parent_branch>`
  - Discovered during: pipeline `<pipeline-name>`, iteration `<iteration-filename>`
  ```

- `partial_work_note` — 1-4 sentences describing what was completed before stopping and the exact resumption point. Used when re-invoking the executor on merge.
- `poll_interval_minutes` — optional; defaults to 5 when omitted.
- `deadline_hours` — optional; defaults to 4 when omitted.

## Orchestration-layer responsibilities (supervisor-side — the executor never does these)

The `pipeline-manager` relays the executor's brief up to the `/pipeline:run` supervisor in the main session, which performs:

1. Create the new blocker issue on `<blocker_target_repo>` with `new_issue_title` / `new_issue_body`. Record `blocker_issue_number` and `blocker_issue_url`.
2. Post the back-link comment on the parent's tracking issue (skip if `parent_task_issue` is unset).
3. Spawn the child pipeline run — a child `pipeline-manager` via the `Agent` tool with `subagent_type: "pipeline-manager"`, pointed at the blocker pipeline's first iteration. The child's prompt includes every field from the brief plus the newly-minted `blocker_issue_number` / `blocker_issue_url`. The child's PR body MUST include `Closes #<blocker_issue_number>`.
4. Poll-wait loop on `<blocker_target_repo>` — poll every `poll_interval_minutes` for a PR whose body contains `Closes #<blocker_issue_number>` or `Fixes #<blocker_issue_number>`. Terminal states:
   - `MERGED` → proceed to (5).
   - `CLOSED` (not merged) → STOP and report; do not auto-retry.
   - `OPEN` / not-yet-created past `deadline_hours` → STOP and report.
5. Fetch + merge `origin/<base_branch>` into the parent's branch (inside the correct repo path; for cross-submodule blockers that's the submodule path). Merge commit preferred over rebase. On conflict, STOP and report — do not auto-resolve.
6. Re-run the parent iteration's verification gate (Success Criteria commands from the iteration file). 0 failures required; on any failure STOP and report.
7. Push the merged branch (never force-push) and re-invoke the parent `step-executor` on the parent's iteration file with `partial_work_note` embedded in the prompt.

## Guardrails

- **One child per blocker.** If the first child's PR is `CLOSED` without merge, the supervisor stops and reports — no auto-retry.
- **No silent deadline extensions.** The deadline is set once; re-entry preserves it.
- **No force-push, ever.** Merging the blocker into the parent's branch is an append-only operation.
- **Cross-submodule blockers merge inside the submodule.** For a cross-submodule blocker, the `fetch` + `merge` happens inside the relevant submodule path, not at the parent repo root.
- **Child never writes into the parent's worktree.** The child pipeline run gets its own worktree/branch. The only cross-link between parent and child is the GitHub issue pair and (eventually) the merged commit on the blocker's target repo.

This contract is load-bearing across `agents/step-executor.md` (classification + protocol + the `blocker_delegation` report section), `agents/pipeline-manager.md` (the `blocked` action relay), and `skills/run/SKILL.md` (the supervisor flow). If you change the brief shape or the flow, change all of them in lockstep.
