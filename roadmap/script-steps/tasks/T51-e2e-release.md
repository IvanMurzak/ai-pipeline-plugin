# T51 — End-to-end verification + release (0.71.0)

- **Depends on:** ALL other tasks (T00–T44)
- **Parallel with:** nothing (final gate)
- **Footprint:** read-everything; edits limited to fixing verification
  fallout (any file, with report), `.claude-plugin/plugin.json` (version),
  and ticking `ROADMAP.md` statuses
- **Status:** done — E2E green in both runners against real scratch projects (mixed sequential w/ bindings, graph flag loop-back, DAG partition, full failure matrix incl. budget-`continue` + ledger reuse, all-script `pipeline drive` with `llm_steps: 0` + true-zero tokens); 6 verification-fallout fixes (drive fallback prompt line, §8 resume-path index preservation, sequential stats `step_id` pairing, `executed_scripts` doc removal, stale Principle-12 ref, transient→`friction` gap-fill in docs+DESIGN); docs cross-check clean; version bumped to 0.71.0. Full report at the bottom of `../ROADMAP.md`.

## Goal

Prove the feature end-to-end in both runners against a real scratch project,
verify docs match implementation, and ship the version bump.

## Steps

1. **Scratch-project E2E (manager mode).** In a throwaway git project (e.g.
   under the system temp dir), author a fixture pipeline mixing agent + script
   steps (a script producing `output` consumed by a later script's
   `${steps…}` binding; a graph edge routing on a script flag). Run it via
   `/pipeline:run` semantics OR directly via looped
   `bun .../cli.ts next` calls acting as the manager. Verify: script steps
   spawn no agents, records/outputs/events/stats land, `.runtime/` artifacts
   (params/failures/outputs/ledger) are correct, run reaches `done`.
2. **Failure matrix (same project):** one run each for — script crash with
   `on-failure: halt` (feedback file written, retrospective-eligible); crash
   with `on-failure: agent` (fallback action emitted); `retries` on a
   flaky-once fixture; timeout kill (tree-killed, `transient`); budget
   exhaustion → `continue` (author a multi-script chain with small timeouts
   and a reduced budget seam if needed); ledger reuse (kill between exec and
   state persist, re-enter, assert NO re-execution).
3. **Headless E2E:** the same mixed fixture through `pipeline drive` (real
   `claude -p` executor template if available; else the Fake runner test from
   T33 counts, plus a manual smoke of the all-script pipeline which needs no
   executor at all).
4. **Docs cross-check:** walk `docs/script-steps.md`, `docs/cli.md`, README,
   and the five agent docs against the implemented behavior (field names,
   record JSON, exit codes, prompt lines). Fix drift — code wins only if
   DESIGN.md agrees; otherwise STOP and reconcile.
5. **Suite:** `cd apps/pipeline-cli && bun run test` green; pipeline-ui tests
   green if present.
6. **Release:** `pipeline release minor` (or edit `.claude-plugin/plugin.json`
   to `0.71.0`). Do NOT bump the marketplace submodule pointer — that is a
   separate commit in the parent repo by the maintainer.
7. Tick all `ROADMAP.md` checkboxes; write a short completion report at the
   bottom of `ROADMAP.md` (what shipped, deviations, follow-ups).

## Acceptance criteria

- Every failure-matrix scenario behaves per DESIGN.md §6–§8.
- An all-script pipeline completes with ZERO LLM tokens spent (verify via
  `.stats/` — `llm_steps: 0`, tokens finalized as zeros).
- Version bumped once; no stray edits outside the documented fixes.

## Out of scope

Marketplace repo changes; UI feature work; v2 items (DESIGN.md §16).
