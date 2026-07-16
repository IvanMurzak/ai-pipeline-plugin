# T00 — Frozen contracts module + step-record schema extension

- **Depends on:** nothing (first task; blocks everything else)
- **Parallel with:** nothing
- **Footprint (only these files):**
  - `apps/pipeline-cli/src/lib/script-types.ts` (NEW)
  - `apps/pipeline-cli/src/lib/step-schema.ts` (edit)
  - `apps/pipeline-cli/tests/step-schema.test.ts` (edit)
  - `apps/pipeline-cli/src/index.ts` (edit — exports only)
- **Status:** done — script-types.ts created verbatim per DESIGN.md §14 (JSDoc'd), STEP_RECORD_SCHEMA gained optional `output` (whitespace-free invariant intact), types/constants exported from index.ts, full suite green (28 files, all passed)

## Goal

Create the shared type/constant module every other task imports, and extend
the step-record JSON Schema with the additive `output` field — so waves 2+
can run in parallel against a frozen TypeScript surface.

## Spec

`DESIGN.md` §14 (copy the interfaces/constants VERBATIM — they are frozen),
§10 (the `output` record field), §4 (ScriptResult shape).

## Steps

1. Create `src/lib/script-types.ts` with exactly the types and constants from
   DESIGN.md §14 (`StepType`, `FailureClass`, `OnFailurePolicy`,
   `ScriptParamSpec`, `ScriptStepSpec`, `ScriptResult`,
   `ScriptFailureRecord`, `LedgerEntry`, all constants). Add concise JSDoc per
   item in the style of `step-schema.ts`.
2. In `src/lib/step-schema.ts`: add an OPTIONAL `output` property to
   `STEP_RECORD_SCHEMA` (`{ type: ['object','null'] }`, description noting it
   feeds the run's outputs store). Keep the serialization WHITESPACE-FREE
   (property names/descriptions without spaces are NOT required — only the
   JSON.stringify output must contain no spaces; check the existing test).
3. Extend `tests/step-schema.test.ts`: the whitespace-free invariant still
   holds; the schema accepts a record with/without `output`.
4. Export the new module's types from `src/index.ts` (mirror how plan/next
   types are exported).
5. `cd apps/pipeline-cli && bun run test` — green.

## Acceptance criteria

- `script-types.ts` compiles, matches DESIGN.md §14 byte-for-meaning (same
  names, same defaults).
- `stepRecordSchemaJson()` output contains no whitespace and includes
  `output`.
- Full test suite green.

## Out of scope

Any parsing, execution, or engine logic. No behavior changes anywhere.
