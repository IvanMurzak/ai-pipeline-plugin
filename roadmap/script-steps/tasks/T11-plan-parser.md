# T11 — plan.ts: script-step frontmatter, Params/Output parsing, plan lints

- **Depends on:** T00
- **Parallel with:** T12, T41–T44
- **Footprint (only these files):**
  - `apps/pipeline-cli/src/lib/plan.ts` (edit)
  - `apps/pipeline-cli/tests/plan-script-steps.test.ts` (NEW)
- **Status:** done — `computePlan()` parses `type: script` frontmatter + `## Params`/`## Output` blocks into `PlanStep.type`/`PlanStep.script_spec` with every §2/§3/§7 lint; 19 new tests, full suite green (29 files)

## Goal

`computePlan()` fully understands script steps: parses the new frontmatter and
body blocks into `PlanStep.type` + `PlanStep.script_spec`, and enforces every
design-time lint, so downstream layers never re-read iteration files.

## Spec

`DESIGN.md` §2 (declaration + rules), §3 (Params/Output/bindings + lints),
§7 (the `MANAGER_SAFE_TIMEOUT_S` lint), §14 (types — import from
`script-types.ts`, do not redeclare).

## Steps

1. Extend `PlanStep` with `type: StepType` (default `'agent'`) and
   `script_spec: ScriptStepSpec | null`.
2. Frontmatter parsing per §2.1: `type`, `script`, `command`, `timeout`,
   `retries`, `on-failure`. Unknown/invalid values follow the existing
   warn-and-default idiom (`normalizeModel` style). ERROR when `type: script`
   has neither/both of `script`/`command`.
3. Body-block parsing per §3: extract the fenced ```json block from
   `## Params` and `## Output` sections (mirror `extractGraph` in `graph.ts` —
   consider a small shared helper INSIDE plan.ts rather than editing
   graph.ts, which is outside your footprint). Validate the param vocabulary
   (§3.1): unknown `type`, `value`+`from` together, malformed JSON ⇒ ERROR.
4. Lints (all in `computePlan`, feeding `errors`/`warnings` exactly as
   classified in DESIGN.md):
   - `## Next` of a sequential-mode script step not exactly one absolute path
     or `Pipeline complete.` ⇒ ERROR (§2.2). Parse mechanically; a graph-mode
     pipeline skips this check.
   - `model`/`effort`/`permission-mode` on a script step ⇒ WARNING; the new
     script fields on an agent step ⇒ WARNING (§2.1).
   - `${steps.x…}` binding whose `x` is not a topological ancestor ⇒ ERROR;
     graph mode skips (§3.3).
   - `${steps.x.output.y}` where step `x` declares `## Output` without field
     `y` ⇒ ERROR (§3.4).
   - Secret-looking `${env.NAME}` ⇒ WARNING (§3.3, `SECRET_ENV_PATTERN`).
   - `timeout > MANAGER_SAFE_TIMEOUT_S` on a `runner: manager` pipeline ⇒
     WARNING (§7).
5. Tests (`plan-script-steps.test.ts`, sandbox fixture pipelines under a temp
   dir, same style as existing plan tests): happy-path parse (script + command
   variants, params with from/value/default), every lint above (positive and
   negative case each), backward-compat (a pipeline with no `type:` fields
   produces a byte-identical plan to before — assert key fields).
6. `bun run test` green.

## Acceptance criteria

- `pipeline plan --root <fixture>` JSON shows `type` and `script_spec` per
  step; all lints fire exactly per spec; legacy pipelines unchanged.
- No file outside the footprint touched (in particular NOT `graph.ts`,
  NOT `frontmatter.ts` unless a parsing gap forces it — if it does, STOP and
  report instead).

## Out of scope

Execution, engine, command layer, docs.
