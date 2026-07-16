# T43 — manager + step-executor docs: the runtime's view of script steps

- **Depends on:** T00 (contracts frozen in DESIGN.md)
- **Parallel with:** T11, T12, T41, T42, T44
- **Footprint (only these files):**
  - `agents/pipeline-manager.md` (edit)
  - `agents/step-executor.md` (edit)
- **Status:** done — pipeline-manager gained a "Script steps — the CLI executes them" section (continue action, Bash-timeout 600000 rule, executed_scripts, fallback run-step prompt line, mixed layers) + invariant/lockstep updates; step-executor gained a "Script-failure fallback" section, a "Step outputs" note (additive `output` record field + outputs-store reads) + invariant/lockstep updates; invalidated statements qualified in both.

## Goal

Both runtime agents know exactly what changes for them (very little — that is
the point) and what is new: the `continue` action, the fallback protocol, and
the outputs store.

## Spec

`DESIGN.md` §5 (record flow), §6.3 (fallback spawn context), §7 (`continue` +
the Bash-timeout rule), §9 (mixed layers — what the manager sees), §10
(outputs store), §13 (`--manual-scripts` is debug-only, the manager never
passes it).

## Steps

1. **`pipeline-manager.md`**:
   - New short section "Script steps — the CLI executes them" (mirror the
     tone of "External isolation — the CLI runs the hooks itself"): the
     manager NEVER runs a script, never reads script output; consecutive
     script steps happen inside one `pipeline next` call; the returned action
     may carry informational `executed_scripts` context — mention it in
     progress output only.
   - The **`continue` action**: perform nothing, immediately call
     `pipeline next … --record '{"kind":"continue"}'`.
   - The **Bash-timeout rule** (invariant + loop text): every `pipeline next`
     call passes the maximum Bash timeout (600000 ms) — scripts run inside it.
   - Fallback run-steps: a `run-step` whose step carries
     `fallback: "script-failure"` + `failure_record` is spawned like any agent
     step PLUS one documented prompt line ("This step's script failed;
     failure record at <failure_record>; achieve the iteration's Goal per
     your fallback protocol."). Add the line to the documented spawn-prompt
     shape.
   - Mixed layers: the steps list of a concurrent `run-step` may be only the
     agent members (script members already executed) — record the layer
     results for the agent members only, exactly as the action lists them.
2. **`step-executor.md`**:
   - New short section "Script-failure fallback": when the spawn prompt says
     the step's script failed — read the failure record (+ `.log` beside it),
     achieve the iteration's `Goal`/`Success Criteria` by any sound means
     (running the script manually with a diagnosis is allowed), report a
     NORMAL step record; NEVER edit the script or anything under the pipeline
     folder (that is the improver/script-creator's blast radius); emit an
     `improvement_brief` describing the script failure so Tier-1 can repair
     it; journal a `script-failure` problem file if the brief alone is
     insufficient.
   - "Step outputs" note: a record MAY include an `output` object (additive
     schema field); prior steps' outputs are readable at
     `<pipeline_root>/.runtime/<run_id>/outputs/<step_id>.json` when an
     iteration's `Inputs` references them.
3. Keep both files' existing invariant lists updated (one new bullet each,
   matching the sections above). Search both docs for statements the feature
   invalidates (e.g. "every run-step spawns a step-executor") and qualify
   them.

## Acceptance criteria

- Spawn-prompt shape, record examples, and the `continue` record JSON match
  DESIGN.md / T21's implemented shapes verbatim.
- The lockstep footer paragraphs in both files mention the new script-step
  contract surface.

## Out of scope

Designer/creator/improver docs (T41/T42), README (T44), code.
