# T31 — commands/next.ts: in-process execution wiring (the heart)

- **Depends on:** T00, T11, T12, T21
- **Parallel with:** T41–T44 (docs)
- **Footprint (only these files):**
  - `apps/pipeline-cli/src/commands/next.ts` (edit)
  - `apps/pipeline-cli/tests/script-exec-integration.test.ts` (NEW)
- **Status:** done — invokeNext executes script steps in-process (chain collapse under the §7 call budget with `continue` hand-off, §9 mixed/all-script layer partition, §6.2 feedback files + §6.3 policy ladder incl. engine fallback re-dispatch and the §6.4 repaired_steps bound, §10 outputs store wired to `ctx.readOutput`, §12 step_type/failure_class event+stats tags, `--manual-scripts` passthrough); drive got the sanctioned one-line `callBudgetMs: Infinity` seam; 12 new integration tests, full suite green.

## Goal

`invokeNext()` executes script steps in-process end-to-end: collapse chains
under the call budget, partition mixed layers, apply the failure-policy
ladder, persist the outputs store, write feedback files, auto-emit events and
stats notes — so BOTH runners (manager via the `next` command, headless via
`pipeline drive`) inherit script steps with zero further work.

## Spec

`DESIGN.md` §5 (record flow), §6.2–6.4 (what the command layer does on
failure, policy ladder, bounds), §7 (call budget + `continue`), §9 (mixed
layers), §10 (outputs store), §12 (event/stats field names), §13
(`--manual-scripts`).

## Steps

1. **Interception loop**: after each engine action, when it is a `run-step`
   whose steps are script-type (and `--manual-scripts` was NOT passed):
   execute via `executeScriptStep` (T12), feed the synthesized record back
   into the engine (the same self-feed pattern `execCreateHook` uses), and
   continue until a non-script action or terminal. Guard with
   `MAX_SCRIPT_EXECS_PER_CALL`.
2. **Call budget** (§7): track elapsed since `invokeNext` entry; effective
   deadline per script = `min(spec.timeoutS*1000, remaining − SAFETY_MARGIN_MS)`;
   when the NEXT script's declared timeout does not fit remaining budget ⇒
   persist state and return `{action:'continue'}` to the caller. `pipeline
   drive` calls with an infinite budget (add an `opts.callBudgetMs` seam;
   drive passes `Infinity` — verify drive's call site compiles, but do NOT
   otherwise edit drive.ts; if a drive edit is unavoidable, it is a one-line
   opts addition and must be noted in your report).
3. **Failure policy actuation** (§6.3): `transient` retries happen inside T12;
   on a returned failure — `env` ⇒ halt record; policy `halt` ⇒ halted step
   record with the spec'd `halt_reason` shape; policy `agent` ⇒ invoke the
   engine's fallback re-dispatch (T21) and RETURN that agent action to the
   caller (with `fallback` + `failure_record` on the step). Parallel layer ⇒
   `agent` degrades to halt (§6.4).
4. **Feedback files** (§6.2.2): persist the `feedback` artifact T12 returned
   into `.feedback/<run_id>/<step_id>-NN.md` (existing problem-file shape,
   CLI-written).
5. **Mixed layers** (§9): partition the layer action; execute script members
   (sequentially is fine — they are independent; note the choice), stash
   results via the T21 `partial_layer_results` mechanics, return agent-only
   action (or self-feed a complete layer record when all-script).
6. **Outputs store** (§10): on EVERY incoming/synthesized step record with an
   `output` object, persist to `.runtime/<run-id>/outputs/<step_id>.json`
   (cap `OUTPUT_PERSIST_CAP_BYTES` ⇒ warn + skip). Wire the T12
   `ctx.readOutput` reader to this store.
7. **Events + stats**: auto-emitted `iteration.started`/`iteration.completed`
   for script steps carry `step_type:"script"` (+ `failure_class` on
   failure) — extend `emitStartedEvents`/`emitCompletionEvents`; stats notes
   (`statsNote*`) tag step lines with `step_type` and count `llm_steps`
   (agent-type dispatches) into the buffer for T32's record work. Keep both
   best-effort (never affect actions/exit codes).
8. **`--manual-scripts`** (§13): parse the flag in `parseArgs`; when set,
   script `run-step` actions pass through to the caller unexecuted.
9. **Tests** (`script-exec-integration.test.ts`, real temp pipelines +
   bun-runnable fixture scripts, FakeProcessRunner where determinism needs
   it): sequential chain of 2 scripts collapses in one call; budget exhaustion
   returns `continue` and the follow-up call resumes; graph routing on script
   flags; halt policy; agent-fallback action shape + once-only; env-class
   halt; feedback file written; outputs persisted + consumed by a downstream
   script's `${steps…}` binding; mixed layer partition; all-script layer;
   `--manual-scripts` passthrough; ledger reuse across a simulated crash
   (kill between record synthesis and state save).
10. `bun run test` green (ALL suites — hooks/next/drive tests must not
    regress).

## Acceptance criteria

- A fixture pipeline of only script steps runs to `done` in N `invokeNext`
  calls with zero caller actuation (besides `continue`).
- `pipeline drive` on the same fixture completes without code changes beyond
  the budget seam.
- No regression in existing tests; events/stats remain best-effort.

## Out of scope

EVENTS.md/web/logs/stats-record surfaces (T32), `pipeline step run` (T33),
docs (T4x), version bump (T51).
