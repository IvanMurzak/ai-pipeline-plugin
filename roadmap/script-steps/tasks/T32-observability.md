# T32 — Observability surfaces: EVENTS.md, web types, logs, stats

- **Depends on:** T00 (field names frozen in DESIGN.md §12); T31 for live
  verification (can start earlier against the spec)
- **Parallel with:** T33, T41–T44
- **Footprint (only these files):**
  - `apps/pipeline-ui/EVENTS.md` (edit)
  - `apps/pipeline-ui/web/src/types.ts` (edit)
  - `apps/pipeline-cli/src/commands/logs.ts` (edit)
  - `apps/pipeline-cli/src/lib/stats.ts` (edit)
  - `apps/pipeline-cli/tests/stats.test.ts` (edit)
  - `apps/pipeline-cli/tests/logs.test.ts` (edit if it exists; else extend the
    logs-covering test file)
- **Status:** done — `iteration.*` events carry optional `step_type:"script"` + `failure_class` (EVENTS.md + web literals, schema stays 4, backward-compat proven); `pipeline logs` renders `[script]` + failure class; stats gain `llm_steps` (untagged `step.started` count) with a zero-`llm_steps` run finalizing `tokens` as true zeros (not pending), script fails shown in the run `.log`. Tests green (stats 46, logs 46 incl. backward-compat); full CLI suite green apart from the two known git-heavy submodule files that pass in isolation.

## Goal

Script steps are first-class in every observability surface: the event
journal, the terminal tail, the web dashboard types, and the per-run stats —
including the zero-token-run truth fix.

## Spec

`DESIGN.md` §12. Additive-only: NO `SCHEMA_VERSION` bump (same precedent as
`step_id` in v4 — optional fields on existing event types).

## Steps

1. `EVENTS.md`: document optional `step_type` (`"script"`, absent = agent) on
   `iteration.started`/`iteration.completed` and optional `failure_class` on
   `iteration.completed`. Note explicitly this is a values-only addition,
   schema stays 4, and old events without the keys must keep parsing.
2. `web/src/types.ts`: add the optional fields to the event type literals
   (mandatory per the repo's EVENTS rules). Do NOT build UI features — types
   only (UI rendering is a later, separate effort).
3. `logs.ts` `bitsForEvent`: render script iterations distinctly (e.g. a
   `[script]` tag and the failure class when present) so `pipeline logs -f`
   reads well.
4. `stats.ts`: run record gains `llm_steps: number` (count of agent-type step
   dispatches, fed from T31's buffer notes). **Zero-token truth fix**: a
   finished run with `llm_steps === 0` finalizes `tokens` as explicit zeros
   instead of leaving the record pending for enrichment (§12). Script-step
   failures render in the run `.log` beside tool fails; SUMMARY.md needs no
   new column in v1 (keep the diff minimal), but must not break on the new
   record field.
5. Tests: stats — a record with `llm_steps: 0` finalizes (not pending), a
   mixed run still waits for enrichment; logs — the new event fields render
   and unknown-field events still fall through gracefully.
6. `bun run test` green in `apps/pipeline-cli`; if `pipeline-ui` has its own
   test script, run it too.

## Acceptance criteria

- Backward-compat parsing proven by tests (events without the new keys).
- `SCHEMA_VERSION` untouched in all three definition sites.
- Stats records from BEFORE this change still load (absent `llm_steps` ⇒
  treated as unknown, existing pending behavior preserved for them).

## Out of scope

Dashboard UI rendering/components, launcher changes, `transcript-stats.ts`,
docs (T4x).
