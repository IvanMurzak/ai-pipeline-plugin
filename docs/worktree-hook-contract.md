# External-isolation worktree hooks — consumer contract (FROZEN)

Reference for **hook authors** writing `.claude/pipeline/.hooks/worktree-{create,finalize,destroy}` scripts in a consumer project. The `pipeline next` CLI executes these hooks itself, in-process (from the PROJECT ROOT, env-var inputs, JSON-on-stdout; timeouts: 600 s create, 600 s finalize, 300 s destroy) — the `pipeline-manager` agent never passes these variables and never runs the hooks.

This contract is **FROZEN**: existing consumer hooks must keep working unmodified. If you change anything here, update `apps/pipeline-cli/src/lib/hooks.ts`, `apps/pipeline-cli/src/commands/next.ts`, and the README's external-isolation section in lockstep, and bump the plugin version.

## `worktree-create` (required for `isolation: external`)

Runs with env vars:

- `PIPELINE_WT_ACTION=create`
- `PIPELINE_WT_RUN_ID`
- `PIPELINE_WT_NAME` — defaults to the run id (12 hex chars, filesystem-safe); drives the worktree slot, branch `worktree-<name>`, and registry key
- `PIPELINE_WT_PIPELINE_NAME`, `PIPELINE_WT_PIPELINE_ROOT`, `PIPELINE_WT_PROJECT_ROOT`
- `PIPELINE_WT_BASE_BRANCH` (from the pipeline's optional `base_branch:` frontmatter; default `main`)
- `PIPELINE_WT_SUBMODULES` (comma-list, possibly empty)
- `PIPELINE_WT_DRY_RUN=0`

Prints ONE JSON object on stdout (all diagnostics on stderr), idempotent per name:

```json
{ "worktree_path": "<abs>", "branch": "<e.g. worktree-abc123def456>", "env_file": "<abs or null>", "port_base": 0, "ports": { "BACKEND_PORT": 5103 } }
```

Only `worktree_path` / `branch` / `env_file` are threaded onward; `port_base`/`ports` are informational (per-port values live in the written env file, which steps source).

## `worktree-finalize` (optional; presence opts the run in, as does `finalize: true` frontmatter)

Runs ONCE at the very end of a COMPLETED run, after the last step + optional retrospective, BEFORE teardown. Env: `PIPELINE_WT_ACTION=finalize` plus the full create-style context (`PIPELINE_WT_RUN_ID`, `PIPELINE_WT_NAME`, `PIPELINE_WT_PIPELINE_NAME`, `PIPELINE_WT_PIPELINE_ROOT`, `PIPELINE_WT_PROJECT_ROOT`, `PIPELINE_WT_BASE_BRANCH`, `PIPELINE_WT_SUBMODULES`, `PIPELINE_WT_WORKTREE_PATH`, `PIPELINE_WT_OUTCOME=completed`, `PIPELINE_WT_DRY_RUN=0`).

UNLIKE destroy it is **strict must-succeed** — it MUST print `{"ok":true}` (optional `detail`) or the run halts with the worktree preserved. WHAT it does with the worktree (commit, push, publish, anything) is entirely the hook's business; the plugin never inspects it.

## `worktree-destroy` (required for `isolation: external`)

Runs on every terminal outcome (`completed`/`halted`/`depth-exhausted`), never on `blocked-delegating`. Env: `PIPELINE_WT_ACTION=destroy`, `PIPELINE_WT_RUN_ID`, `PIPELINE_WT_NAME`, `PIPELINE_WT_PIPELINE_ROOT`, `PIPELINE_WT_PROJECT_ROOT`, `PIPELINE_WT_WORKTREE_PATH`, `PIPELINE_WT_OUTCOME` (`completed|halted|depth-exhausted|create-failed`), `PIPELINE_WT_DELETE_BRANCHES`, `PIPELINE_WT_DRY_RUN=0`.

**`PIPELINE_WT_DELETE_BRANCHES` is outcome-aware:** `1` when the run COMPLETED (the work is fully done — the run branch should not outlive it), `0` on `halted`/`depth-exhausted`/`create-failed` (preserve for debugging and resume). A pipeline can opt out of completed-run branch deletion with `delete_branches: false` in `PIPELINE.md` frontmatter (then it's always `0`). Hooks that honor the flag get leak-free branches on success and preserved state on failure; hooks that ignore it behave as before.

**`create-failed` (additive):** the CLI ALSO invokes destroy best-effort, once, immediately after a failed/timed-out create hook — to clean a possibly half-created slot before the run halts. In that call `PIPELINE_WT_OUTCOME=create-failed` and `PIPELINE_WT_WORKTREE_PATH` may be absent (the create never reported one). Hooks SHOULD treat `create-failed` as "reap the partial slot for this name, if any"; an existing hook whose unknown-outcome default preserves is acceptable (same leak as before this addition, never worse). This cleanup attempt never changes the run's halt outcome.

Prints `{"ok":true}` on a clean teardown, `{"ok":false,"detail":"<short>"}` + exit 0 on a soft failure, or exits non-zero on a hard failure — none of which strands the run.

## Location

The hooks live at `<project>/.claude/pipeline/.hooks/` (sibling to the pipeline folders, shared by all pipelines; a pipeline may override the dir via `worktree_hook_dir` frontmatter).

## Worktree-scoped pipeline I/O (default) and self-improvement edits

By default (`PIPELINE_WORKTREE_SCOPED`, frozen per run at init; `0` restores the legacy main-scoped reads), an external-isolation run **reads its pipeline definition from — and self-improves into — the run worktree's pipeline copy**: the CLI computes the run plan from `<worktree>/<pipeline-root-rel>` right after the create hook returns, and the improver/script-creator/retrospective edit that tree. Consequences for hook authors:

- **Improver edits ride finalize.** Whatever the run improved sits in the worktree as ordinary uncommitted changes when the finalize hook runs — a finalize hook that commits the worktree (`git add -A && git commit …`) lands them in the run's own commit/PR. Nothing ever dirties the main checkout.
- **Run artifacts never ride finalize.** The CLI writes `.gitignore` stubs (`*`) for `.runtime/` and `.feedback/` inside the worktree's pipeline tree at provision, so a blanket `git add -A` cannot commit rendered copies, outputs, ledgers, or feedback files.
- **Committed state only.** A worktree materializes commits — uncommitted pipeline edits in the main tree do NOT exist in the worktree. The CLI warns at run start when the main tree's pipeline dir is dirty; users must commit pipeline edits before an external run (or set `PIPELINE_WORKTREE_SCOPED=0`).
- **Invalid plan after create → destroy with `PIPELINE_WT_OUTCOME=halted`.** If the worktree's pipeline definition fails plan lint, the CLI immediately runs the destroy hook (outcome `halted` — your preserve-on-halt cue applies) instead of leaking the slot.
- **Detached-HEAD checkouts: branch creation is YOUR hook's responsibility.** A headless/cloud job checkout is a detached-HEAD, shallow fetch; commits on it are legal but garbage-collection bait until referenced, and a PR needs a remote branch. The consumer's create/finalize hook owns branch creation (`git switch -c <branch>` at create, or `git push origin HEAD:refs/heads/<branch>` at finalize) — the plugin never invents git pushes. Pushing from a depth-1 checkout is supported (git ≥ 1.9).

## Recommended patterns (observed in production deployments)

- **Preserve-on-halt:** destroy hooks should tear the worktree down only on `PIPELINE_WT_OUTCOME=completed` and preserve it on `halted`/`depth-exhausted` for post-mortem and same-worktree resume. (The CLI already never calls destroy on `blocked-delegating`.)
- **Edit-capture before removal (optional belt-and-suspenders):** with worktree-scoped I/O the run's improver/retrospective edits live inside the worktree and ride the finalize commit — the old "land edits back onto the shared main checkout from the destroy hook" workaround is no longer needed. It remains a legitimate safety net for `PIPELINE_WORKTREE_SCOPED=0` (legacy) runs, or for hooks that want halted runs' unfinalized improvements captured before a manual cleanup; keep it best-effort and never abort teardown over it.
- **Finalize as the "work is truly landed" gate:** use the finalize hook for terminal actions the run must not complete without (e.g. bumping submodule pointers to the published merged tip and landing that in one PR) — returning `{"ok":false}` halts the run with the worktree preserved.
