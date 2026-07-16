# Script Steps — Implementation Roadmap

Feature spec: [`DESIGN.md`](./DESIGN.md) (frozen contracts — read it FIRST).
Task files: [`tasks/`](./tasks/). Target plugin version: 0.71.0 (bumped only in T51).

## Execution rules (for every agent picking up a task)

1. Read `DESIGN.md` in full, then your task file. The task's **Footprint**
   lists the ONLY files you may create/edit — footprints of tasks in the same
   wave are disjoint by construction, so parallel agents never conflict.
2. Work inside the `Claude-Pipeline` repo (this folder's parent). Do NOT touch
   the marketplace repo, `${CLAUDE_PLUGIN_ROOT}`, or other submodules.
3. Before marking a task done: `cd apps/pipeline-cli && bun run test` must be
   green (plus any task-specific verification listed in the task).
4. Do NOT bump the plugin version — T51 does that once.
5. On completion: tick the task's checkbox below and fill its `Status` line in
   the task file (`done — <one-line result>`). If you had to deviate from
   DESIGN.md, update DESIGN.md in the same change and say so.
6. If blocked or the spec is ambiguous: STOP and report; do not improvise a
   contract.

## Dependency graph

```
T00 ─┬─→ T11 ──→ T21 ──┐
     └─→ T12 ──────────┼─→ T31 ─┬─→ T32
     └─→ (T41 T42 T43 T44) ─────┤   ├─→ T33
                                └───┴─→ T51
```

## Waves (suggested scheduling)

| Wave | Tasks | Mode |
|------|-------|------|
| 1 | T00 | solo (blocks everything) |
| 2 | T11, T12, T41, T42, T43, T44 | **parallel** (disjoint footprints) |
| 3 | T21 | solo (needs T11; parallel with any unfinished docs tasks) |
| 4 | T31 | solo (needs T11+T12+T21) |
| 5 | T32, T33 | **parallel** (disjoint footprints; need T31) |
| 6 | T51 | solo (needs everything) |

Docs tasks T41–T44 depend only on T00/DESIGN.md (contracts are frozen) and can
run any time from wave 2 on; T51 re-verifies docs against the implementation.

## Task list

### Stage 0 — Foundation
- [x] **T00** — Frozen contracts module + step-record schema extension
      → [tasks/T00-contracts.md](./tasks/T00-contracts.md)

### Stage 1 — Parsing & execution core (parallel)
- [x] **T11** — `plan.ts`: script-step frontmatter, `## Params`/`## Output`
      parsing, all plan lints → [tasks/T11-plan-parser.md](./tasks/T11-plan-parser.md)
- [x] **T12** — `lib/script-step.ts`: bindings, validation, spawn, stdout
      parse, classification, failure records, ledger, `## Next` parse
      → [tasks/T12-script-exec-lib.md](./tasks/T12-script-exec-lib.md)

### Stage 2 — Engine
- [x] **T21** — `lib/next.ts`: step type threading, `continue` action,
      fallback re-dispatch, state bits, partial-layer support
      → [tasks/T21-engine.md](./tasks/T21-engine.md)

### Stage 3 — Command-layer integration
- [x] **T31** — `commands/next.ts` (`invokeNext`): in-process execution, chain
      collapse + call budget, mixed-layer partition, outputs store, feedback
      writing, events/stats notes, `--manual-scripts`
      → [tasks/T31-invoke-next.md](./tasks/T31-invoke-next.md)

### Stage 4 — Surfaces (parallel)
- [x] **T32** — Observability: `EVENTS.md`, web types, `logs.ts`, `stats.ts`
      (`llm_steps`, zero-token finalize) → [tasks/T32-observability.md](./tasks/T32-observability.md)
- [x] **T33** — `pipeline step run` subcommand + drive-mode verification
      → [tasks/T33-step-run-and-drive.md](./tasks/T33-step-run-and-drive.md)

### Stage 5 — Agent & user docs (parallel, can start wave 2)
- [x] **T41** — `pipeline-designer.md`: script-steps principle, extraction
      ladder, ok:false rule, halt/agent guidance → [tasks/T41-designer-doc.md](./tasks/T41-designer-doc.md)
- [x] **T42** — `pipeline-script-creator.md` (`convert-step`, `repair-script`
      modes) + `pipeline-improver.md` (brief `mode`, `script-failure` mapping)
      → [tasks/T42-creator-improver-docs.md](./tasks/T42-creator-improver-docs.md)
- [x] **T43** — `pipeline-manager.md` (executed scripts, `continue`, Bash
      timeout rule) + `step-executor.md` (fallback protocol, outputs)
      → [tasks/T43-manager-executor-docs.md](./tasks/T43-manager-executor-docs.md)
- [x] **T44** — `README.md`, `docs/cli.md`, new `docs/script-steps.md`
      (frozen I/O contract reference), `CLAUDE.md` pointers
      → [tasks/T44-user-docs.md](./tasks/T44-user-docs.md)

### Stage 6 — Verification & release
- [x] **T51** — End-to-end verification (manager + drive, failure matrix,
      ledger reuse), docs cross-check, version bump 0.71.0
      → [tasks/T51-e2e-release.md](./tasks/T51-e2e-release.md)

---

## Completion report (T51, 2026-07-10)

**Shipped: plugin 0.71.0 — `type: script` zero-token steps, full stack** (T00–T51).
Frozen contracts in `lib/script-types.ts`; parsing + lints in `plan.ts`; execution
core (bindings → spawn → classify → failure records → ledger) in
`lib/script-step.ts`; engine threading (`continue`, §6.3 fallback, §6.4 bounds,
partial layers) in `lib/next.ts`; in-process dispatch + chain collapse + call
budget + outputs store + CLI-written feedback in `commands/next.ts`;
observability (`step_type`/`failure_class` event tags, `llm_steps`, zero-token
finalize) across EVENTS.md/web types/logs.ts/stats.ts; `pipeline step run`;
docs across the five agent docs + README + docs/cli.md + docs/script-steps.md.

**E2E verified against real scratch projects** (`%TEMP%\pipeline-script-steps-e2e`,
real CLI processes, hand-acted manager): mixed sequential run (agent → script →
script → agent; `${steps…}`/`${run.id}`/static/mixed-template bindings, params
file + `PIPELINE_STEP_*` env + cwd contract asserted inside the fixture script;
scripts collapsed into one call; outputs store incl. agent-record `output`);
graph run (flag-routed loop-back, loop-back = NEW ledger index, whole graph in
ONE call, `llm_steps: 0` + tokens finalized as true zeros); DAG partition
(all-script layer self-fed, agent-only `run-step` returned); failure matrix —
crash+halt (failure record + `.log` + `script-failure` feedback + retrospective
before halt + exit 1), crash+agent (fallback re-dispatch with
`fallback`/`failure_record`, once-per-run bound stamped, chain continued),
retries (transient once → success, intermediate failure record kept, NO
feedback), timeout kill (tree-killed at ~2.7s of an 8s sleep, `transient`,
`friction` feedback), env ENOENT (halts DESPITE `on-failure: agent`), budget
exhaustion (`continue` across two real call windows, SAME dispatch index),
ledger reuse (crashed-window simulation; auto-resume re-entry reused the
`finished` record — side-effect counter stayed 1); headless `pipeline drive`
all-script run (real process, zero executor spawns, exit 0, runner `headless`,
`llm_steps: 0`, zero tokens); `pipeline logs` renders `[script]` + failure
class; `pipeline step run` exit codes 0/1/2 + no run state touched.

**Verification fallout fixed (all with tests where applicable):**
1. `commands/drive.ts` — `buildStepPrompt` now appends the §6.3 fallback prompt
   line (`This step's script failed; failure record at <path>; …`) for
   `fallback: 'script-failure'` steps, matching pipeline-manager.md;
   `tests/drive-script-steps.test.ts` asserts the line (gap comments removed).
2. `lib/next.ts` — `resumeRun` re-emits a pending SCRIPT dispatch at its
   ORIGINAL index (was: always bump), so §8 ledger reuse also fires on the
   documented `--resume`/no-record crash re-entry, not only on
   `{"kind":"continue"}`; new regression test in
   `tests/script-exec-integration.test.ts`.
3. `commands/next.ts` — sequential `step.completed` stats lines now carry
   `step_id` (started lines always did), fixing lost per-step wall-clock
   seconds for any step whose explicit `step_id` differs from its filename stem
   (e.g. the documented `03-wait-ci.md` + `step_id: wait-ci` shape).
4. `agents/pipeline-manager.md` — removed the `executed_scripts` bullet (field
   was never specified in DESIGN.md nor implemented; T43 invention).
5. Root `ROADMAP.md` — stale "Authoring Principle 12 authors graphs" updated to
   13 (T41's principle insertion renumbered 10–15 → 11–16).
6. `docs/script-steps.md` §5.2 + `DESIGN.md` §6.2.2 — recorded the T12 gap-fill:
   exhausted-retries `transient` ⇒ feedback category `friction` (human-only);
   transient-then-success writes no feedback. Spec was silent; no doc
   contradicted it (improver doc already treats `friction` as human-only).

**Docs cross-check:** field names, record JSON, exit codes (`step run` 0/1/2 as
T44 documented), prompt lines, constants, and the §12 events story all match
the implementation; the designer/creator/improver/manager/executor docs are
mutually consistent (Principles 10/13 numbering verified).

**Deviations from DESIGN.md:** none, beyond the two recorded gap-fills
(§6.2.2 friction category; §8 resume-path index preservation — an
implementation requirement implied by §8's coverage list, now explicit in
`resumeRun`).

**Follow-ups (not blocking):** parallel-layer resume re-entry still re-bumps
member indices (script members rely on mandated idempotency — consistent with
the v1 §6.4 parallel degradations; fold into the v2 parallel-fallback work);
`iteration.completed` (sequential) still omits `step_id` in the EVENT payload
(events pair by `iteration_path`; documented optional).
