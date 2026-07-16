# Pipeline UI — manual test harness

Drives the daemon end-to-end without a browser and without spending Claude tokens (except the opt-in Haiku scenario).

## Usage

```bash
# From apps/pipeline-ui/
bun manual-tests/run.ts                 # all $0 scenarios
bun manual-tests/run.ts --include-haiku # add one real Haiku call (~$0.01)
bun manual-tests/run.ts --only=<name>   # run one scenario
bun manual-tests/run.ts --snapshot      # print registry snapshot at the end
```

The harness reuses an already-running daemon if it finds one. Otherwise it spawns a fresh one (detached).

## What it tests

Each scenario reproduces a specific bug from the v0.23.0 audit and verifies the fix landed:

| Scenario | Verifies |
|---|---|
| `pipeline-discovery` | `scanPipelines` finds the test fixture under `.claude/pipeline/test-pipeline` |
| `iteration-fetch` | `/api/iteration` parses sections correctly |
| `terminal-flag-v2` | v2 `terminal: true` flips status to `completed` even without `pipeline.completed` |
| `terminal-flag-v1-compat` | v1 events with `next_iteration_path: null` still derive `completed` |
| `current-step-tracking` | 300+ `tool.called` events between `iteration.started` events don't break current-step tracking |
| `multiple-instances-same-pipeline` | Two concurrent runs of the same pipeline stay independent |
| `history-persistence` | 700+ events of noise don't evict earlier runs from `/api/runs` |
| `worktree-threading` | `worktree=` field on events surfaces on the run summary |
| `iteration-resumed-not-double-counted` | `iteration.resumed` flips status back to `running` without inflating `started_count` |
| `halted-run` | `outcome: halted` produces `status=halted` + `halt_reason` |
| `model-step-override-wins` | Step `model:` frontmatter overrides pipeline default in `resolveStepModel` |
| `model-pipeline-default` | Pipeline `model:` is used when the step has no frontmatter |
| `model-invalid-falls-through` | Invalid shorthand resolves to `null` and emits a warning (no crash) |
| `haiku-smoke` (opt-in) | Real `/api/chat` with `claude-haiku-4-5-20251001` returns expected output |
| `model-haiku-end-to-end` (opt-in `--include-haiku`) | Full SDK call: resolver passes the haiku canonical ID through to `/api/chat` |

## How "see all the important data" works

- The harness's `snapshot(projectId)` helper (in `harness.ts`) dumps daemon health, project info, pipelines, runs, and per-event-type counts in one call. Call it from any scenario to print everything.
- The CLI's `--snapshot` flag prints the daemon-wide registry size at the end.
- Per-scenario, every assertion logs `✓` or `✗ expected/actual` so the failure mode is visible.

## Making new actions

To add a scenario, copy one in `scenarios/index.ts`:

```ts
export const myScenario: Scenario = {
  name: "my-thing",
  description: "what it proves",
  async run(h) {
    const proj = await h.tempProject("my-thing");
    h.emitEvent(proj, "pipeline.started", "run-1", { pipeline_name: "test-pipeline" });
    h.emitIteration(proj, "run-1", 1, "01-hello.md", { next: null, terminal: true });
    const runs = await h.getRuns(proj.project_id);
    return expectEq("status", runs[0]?.status, "completed");
  },
};
```

Then add it to `allScenarios`.

## Cost

- Default suite: **$0** (pure event simulation against the local daemon).
- `--include-haiku`: a few cents per run (one Haiku turn, ~100 output tokens, no tool use).
