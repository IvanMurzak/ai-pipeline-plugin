# T33 — `pipeline step run` subcommand + drive-mode verification

- **Depends on:** T12 (uses the exec lib); T31 (for the drive verification half)
- **Parallel with:** T32, T41–T44
- **Footprint (only these files):**
  - `apps/pipeline-cli/src/commands/step-run.ts` (NEW)
  - `apps/pipeline-cli/src/cli.ts` (edit — subcommand routing only)
  - `apps/pipeline-cli/tests/step-run.test.ts` (NEW)
  - `apps/pipeline-cli/tests/drive-script-steps.test.ts` (NEW)
- **Status:** done — `pipeline step run <iteration.md> [--param k=v] [--json]` (exit 0 ok / 1 script-failed / 2 usage) executes one script step via `executeScriptStep` in a throwaway system-temp root (zero `.runtime/`/`.feedback/` pollution); 14 new tests (step-run.test.ts + drive-script-steps.test.ts) green, full suite green. GAP REPORTED (not patched, drive.ts out of footprint): drive's `buildStepPrompt` does not append the manager's fallback trigger line for `on-failure: agent` re-dispatches.

## Goal

(a) The author-facing dry-run tool: execute ONE script step with synthetic
params, no run state touched. (b) Proof that headless `pipeline drive`
inherits script steps correctly through `invokeNext`.

## Spec

`DESIGN.md` §13 (subcommand contract), §7 (drive = infinite call budget),
§4–§6 (execution semantics — all reused from T12, never reimplemented).

## Steps

1. `commands/step-run.ts` — `pipeline step run <iteration.md>
   [--param k=v …] [--json]`:
   - Locate the pipeline root by walking up to `PIPELINE.md` (same rule the
     run skill documents); parse the single step via `computePlan` on that
     root (pick the step by path) so frontmatter/Params parsing is EXACTLY the
     runtime's.
   - Resolve params: statics/defaults from the file; every `${steps…}` (and
     `${run.task}`) reference REQUIRES a `--param <name>=<value>` override,
     else exit 2 listing the missing ones. `--param` values parse as JSON
     when possible, else string.
   - Execute via `executeScriptStep` with a throwaway context (temp dir for
     params/failures/ledger — e.g. under the system temp dir, NOT
     `.runtime/`), full `timeout:` honored, no budget.
   - Print: human summary (exit class, duration, flags, output, would-be step
     record) or one JSON object with `--json`. Exit codes: 0 ok / 1 script
     failed (any class) / 2 usage.
   - Refuse `type: agent` steps with a clear exit-2 message.
2. Wire the `step` subcommand group into `cli.ts` (routing + help line only).
3. `tests/step-run.test.ts`: happy path, missing-ref exit 2, JSON output
   shape, agent-step refusal, no `.runtime/` pollution in the pipeline
   fixture.
4. **Drive verification** (`tests/drive-script-steps.test.ts`): a fixture
   pipeline mixing agent + script steps run through `pipeline drive` with a
   FakeExecutorRunner (existing drive-test pattern): script steps execute
   in-process with NO executor spawn (assert the fake runner saw only agent
   steps), records/outputs/stats land, a long `timeout:` script is NOT
   budget-limited (infinite budget seam), and a script failure with
   `on-failure: agent` produces a real executor spawn with the fallback
   prompt context line.
5. `bun run test` green.

## Acceptance criteria

- `pipeline step run` never creates/modifies anything under the pipeline's
  `.runtime/` or `.feedback/`.
- Drive test proves zero executor spawns for script steps and the fallback
  spawn on policy `agent`.

## Out of scope

UI launcher integration, docs (T44 documents the subcommand), any edits to
`drive.ts` beyond what T31 already landed (if the test reveals a drive gap,
STOP and report — do not patch drive here).
