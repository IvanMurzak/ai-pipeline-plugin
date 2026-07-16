# T12 — lib/script-step.ts: the execution core

- **Depends on:** T00
- **Parallel with:** T11, T41–T44 (do NOT edit plan.ts/next.ts — T11/T21 own them)
- **Footprint (only these files):**
  - `apps/pipeline-cli/src/lib/script-step.ts` (NEW)
  - `apps/pipeline-cli/tests/script-step.test.ts` (NEW)
  - `apps/pipeline-cli/src/index.ts` (edit — exports only)
- **Status:** done — `lib/script-step.ts` execution core landed (bindings → params file → HOOK_RUNNER spawn → stdout parse → §6.1 classification → failure records/.log → ledger → record synthesis) with 42 tests green; exports wired into `src/index.ts`; full suite passes.

## Goal

A self-contained, fully tested library module that executes ONE script step:
resolve bindings → validate params → spawn → parse stdout → classify → write
failure records/ledger → synthesize the engine step record. No knowledge of
the engine loop (T31 wires it in).

## Spec

`DESIGN.md` §3 (bindings/validation), §4 (execution contract), §5 (record
mapping, `## Next` parse), §6.1–6.2 (classification, failure records,
feedback file content — but writing the feedback file is T31's call-site
decision; expose it as a returned artifact/helper), §8 (ledger), §14 (types).

## Steps

1. Public API (design for injectability; everything else module-private):
   ```ts
   export interface ProcessRunner { /* spawn seam, mirrors GitRunner style */ }
   export interface ScriptStepContext {
     runId: string; stepId: string; dispatchIndex: number;
     pipelineRoot: string; projectRoot: string;
     worktreePath?: string | null; worktreeEnvFile?: string | null;
     taskText?: string | null;
     readOutput: (stepId: string) => Record<string, unknown> | null; // outputs store reader
     deadlineMs: number;          // effective deadline (caller computes per §7)
     runner?: ProcessRunner;      // default: real spawn via the HOOK_RUNNER wrapper
   }
   export interface ScriptStepResult {
     record: /* engine StepRecord-shaped object incl. flags/output/next */;
     failure: ScriptFailureRecord | null;   // null on success
     feedback: { category: string; body: string } | null; // per §6.2.2, caller persists
     ledgerReused: boolean;
   }
   export function executeScriptStep(spec: ScriptStepSpec, iterationPath: string,
                                     ctx: ScriptStepContext): ScriptStepResult;
   export function resolveParams(...), parseScriptStdout(...), parseNextSection(...),
                  classifyFailure(...)  // exported for unit tests + step-run (T33)
   ```
   Adjust signatures pragmatically, but keep: injectable runner, caller-owned
   deadline, exported pure helpers.
2. Binding resolution per §3.1–§3.2 (precedence from→value→default; single-ref
   keeps JSON type; missing required / type mismatch ⇒ class `binding`, NO
   spawn). `${steps.x.output.y}` reads via `ctx.readOutput`.
3. Spawn per §4: env vars, params file at
   `<pipelineRoot>/.runtime/<runId>/params/<stepId>.json`, cwd rules
   (worktree + env-file KEY=VALUE parsing), stdin closed, interpreter via the
   `resolveHookScript` ladder (import from `lib/hooks.ts` — read-only import
   is allowed; do not EDIT hooks.ts), tree-kill timeout via the HOOK_RUNNER
   wrapper, stdout capture cap `STDOUT_CAP_BYTES`.
4. Stdout parse per §4 (last JSON-object line → whole-stdout fallback →
   `contract`). `## Output` validation when `spec.output` present (§3.4).
5. Classification per §6.1; failure record + `.log` written to
   `<pipelineRoot>/.runtime/<runId>/failures/` per §6.2.1; feedback CONTENT
   (category per class + Problem/Evidence/Suggested-fix body matching the
   Tier-2 problem-file shape in `agents/step-executor.md`) returned to the
   caller.
6. Ledger per §8: check-before-execute keyed `(stepId, dispatchIndex)`,
   `started` before spawn, `finished` (with record+output) after success;
   `finished` hit ⇒ return stored record with `ledgerReused: true`.
7. Record synthesis per §5: success ⇒ completed + flags + output +
   `next_iteration` from `parseNextSection(iterationPath)` (sequential caller
   passes a flag for whether next is needed — or always parse; T31 decides
   usage). Failure ⇒ the CALLER applies retries/policy; this module returns
   the classified failure (retries live here as a simple loop over `transient`
   only, per §6.3.1 — mechanical, zero external knowledge).
8. Tests (`script-step.test.ts`) — real temp sandboxes + tiny fixture scripts
   (python may be unavailable on CI: prefer `bun`-runnable `.js`/`.ts` fixture
   scripts and a FakeProcessRunner for the interpreter-matrix cases):
   happy path (flags/output/next), each failure class, retries on transient
   only, ledger reuse vs loop-back re-execution, params file content, env
   vars, cwd + env-file parsing, stdout cap, oversized output, no-JSON crash,
   `## Next` parse variants (path / complete / malformed).
9. Export the public API from `src/index.ts`. `bun run test` green.

## Acceptance criteria

- Module has zero imports from `next.ts`/`plan.ts`/`commands/*` (only
  `script-types.ts`, `hooks.ts` (read-only), node builtins) — it must be
  reusable by T31 and T33 without cycles.
- Every failure class has a named test; ledger double-execution test passes.

## Out of scope

Engine loop, call budget/`continue` (T31 computes deadlines), outputs-store
WRITING (T31), event/stats emission, docs.
