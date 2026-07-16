# test-pipeline

## End State

The harness has emitted a small chain of events and the daemon's REST surface reflects them correctly.

## Scope

In:
- Synthetic event emission via `harness.emitEvent`
- Assertions on `/api/runs`, `/api/state`, `/api/health`

Out:
- Real Claude Code invocation (only the Haiku scenario does that, explicitly)

## Project Context

This pipeline is a fixture — it's never actually executed by `step-executor`. The harness only references its files to give the daemon something realistic to discover under `.claude/pipeline/test-pipeline/`.

## Invariants

- Three steps: `01-hello.md`, `02-world.md`, `03-done.md`.
- Step 03 is the terminal step (its `Next` field is `Pipeline complete.`).
