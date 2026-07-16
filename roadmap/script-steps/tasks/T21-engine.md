# T21 — lib/next.ts: engine support for script steps

- **Depends on:** T00, T11 (PlanStep.type/script_spec exist)
- **Parallel with:** T12, T41–T44
- **Footprint (only these files):**
  - `apps/pipeline-cli/src/lib/next.ts` (edit)
  - `apps/pipeline-cli/tests/next-script.test.ts` (NEW)
- **Status:** done — engine threads step `type` onto all dispatches (synthesized off-plan steps fixed to agent/null-spec), `continue` re-emits the pending dispatch idempotently in `await-step` (same dispatch index — the §8 ledger key), `opts.scriptFallback` re-dispatches the failed script step once per run as an agent fallback (parallel degrades to halt), `onLayerRecord` folds `partial_layer_results` + recorded results, and the three new NextState fields normalize like `lint_warnings`; 18 new pure-engine tests, full suite green.

## Goal

The PURE engine understands script steps: threads the step type onto actions,
supports the `continue` action/record, the fallback re-dispatch, the state
bits that bound self-healing, and partial-layer folding — while remaining
filesystem-free and spawn-free (execution is the command layer's job, T31).

## Spec

`DESIGN.md` §6.3–6.4 (policy ladder OUTCOMES as the engine sees them —
the command layer classifies and decides, the engine provides the dispatch
mechanics), §7 (`continue`), §9 (partial layers), §14 (engine-side additions).

## Steps

1. `ActionStep` += `type: StepType` (threaded from `PlanStep`; synthesized
   off-plan steps default `'agent'`), optional `fallback: 'script-failure'`
   and `failure_record: string`.
2. `NextAction` += `{ action: 'continue' }`; `NextRecord` +=
   `{ kind: 'continue' }`. A `continue` record in phase `await-step` re-emits
   the dispatch of the CURRENT pending step(s) (state was persisted before the
   caller went for a fresh call window) — add an explicit phase or reuse
   `await-step` with an idempotent re-dispatch, whichever keeps the state
   machine simplest; document the choice in code comments.
3. Fallback re-dispatch: new engine entry (invoked by the command layer when a
   script step failed with policy `agent` and `state.fallback_attempted` lacks
   the step): re-dispatch the SAME step as `type:'agent'` with
   `fallback`/`failure_record` set, mark `fallback_attempted[step_id]=true`.
   Second failure of the same step ⇒ normal halt path. Expose as either a
   record kind or an opts flag — pick the shape most consistent with existing
   resume mechanics and document it.
4. `NextState` += `fallback_attempted?: Record<string, true>`,
   `repaired_steps?: string[]`, `partial_layer_results?: LayerResultEntry[] |
   null` — all optional with backward-compat normalization (absent key ⇒
   default), mirroring the `lint_warnings` pattern.
5. Partial layers (§9): when the command layer executed a layer's script
   members itself, it stores their `LayerResultEntry[]` in
   `state.partial_layer_results` and the `run-step` action lists only agent
   members; on the incoming `layer` record the engine folds
   `partial_layer_results + record.results` (then clears the field). An
   all-script layer arrives as a complete `layer` record from the command
   layer — no action escapes to the caller.
6. Dispatch-index exposure: the ledger (T12) keys on `(step_id,
   dispatch_index)` — ensure `state.index` (or the ActionStep `index`) is the
   value the command layer can use; no new field needed if `index` already
   suffices (verify + comment).
7. Tests (`next-script.test.ts`, pure-engine style like `next.test.ts`):
   continue round-trip (dispatch → continue record → same step re-dispatched,
   counters intact), fallback dispatch once-only + second-failure halt,
   partial-layer folding (mixed and all-script), backward-compat (old
   next.json without new keys), script steps in graph routing (flags flow
   unchanged).
8. `bun run test` green.

## Acceptance criteria

- Engine stays pure (no fs/spawn imports added).
- All existing `next.test.ts` tests pass unmodified.
- Every new state field survives a save/load round-trip and tolerates legacy
  state files.

## Out of scope

Actual script execution, budget arithmetic, event/stats emission, feedback
writing (all T31). Parsing (T11). Docs.
