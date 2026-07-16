# T42 — script-creator + improver docs: convert-step & repair-script modes

- **Depends on:** T00 (contracts frozen in DESIGN.md)
- **Parallel with:** T11, T12, T41, T43, T44
- **Footprint (only these files):**
  - `agents/pipeline-script-creator.md` (edit)
  - `agents/pipeline-improver.md` (edit)
- **Status:** done — added `mode` field (`extract-block`|`convert-step`|`repair-script`) + `script-failure`/`doc-flaw`/`env` category mapping to improver; convert-step & repair-script protocols, mode-specific refusals, and `converted`|`repaired` outcomes to script-creator; both files verified verbatim-consistent on mode/category vocabulary.

## Goal

The self-improvement chain can (a) convert a fully-deterministic agent
iteration into a `type: script` step and (b) repair a script that failed at
runtime — closing the healing loop designed in DESIGN.md §6.

## Spec

`DESIGN.md` §2–§4 (what a converted step looks like), §6.2–6.4 (failure
records, feedback categories, repair bounds), §8 (idempotency requirement the
repaired script must keep).

## Steps

1. **`pipeline-improver.md`**:
   - `script_creation_briefs` entries gain a `mode` field:
     `extract-block` (today's behavior, the default when absent) |
     `convert-step` | `repair-script`. Document when the improver emits each:
     `convert-step` when a feedback file / lint warning shows an iteration is
     fully deterministic (no judgment verbs); `repair-script` when a
     `script-failure`-category feedback file exists (its body references the
     failure record + `.log` paths).
   - Add the new feedback category `script-failure` to the category list the
     retrospective partitions (DOC-ACTIONABLE — it feeds the improver);
     `binding`-class failures arrive as `doc-flaw` (a `## Params` wiring bug —
     fix the markdown, not the script).
   - Brief shape additions: `repair-script` briefs carry the failure-record
     path + the script path; `convert-step` briefs carry the iteration path +
     the proposed Params/Output sketch.
2. **`pipeline-script-creator.md`**:
   - Document the three modes. Input contract stays ONE brief per invocation.
   - `convert-step` protocol: read the iteration; verify NO judgment remains
     (else refuse); write script + tests per existing conventions; REWRITE the
     iteration: frontmatter (`type: script`, `script:`, `timeout`, sensible
     `on-failure` per the mutating/read-only rule), `## Params`/`## Output`
     blocks, single-path `## Next`, the graceful-degradation `## Steps` line;
     preserve `Goal`/`Success Criteria` semantics.
   - `repair-script` protocol: read the failure record + `.log` + script +
     tests; REPRODUCE the failure as a new test case; fix; all tests green or
     refuse. Never widen scope beyond the failing behavior.
   - Extend the decision gate: refuse `convert-step` when judgment verbs
     remain; refuse `repair-script` when the failure class is `env` (not a
     script bug) or the record shows a consumer-project defect (report it as
     `project-issue` instead).
   - Extend the Final Report `outcome` vocabulary: `converted` | `repaired`
     join `created | updated | refused`.
3. Cross-check the two files agree exactly on the brief `mode` vocabulary and
   the feedback category names (this pair is the lockstep unit of this task).

## Acceptance criteria

- Brief shapes, mode names, and category names match DESIGN.md and each
  other verbatim.
- Existing Tier-1/Tier-2 flows (extract-block) read unchanged — additive
  edits only.

## Out of scope

Manager/executor docs (T43), designer doc (T41), any code. NOTE: the manager
doc's brief-relay text is T43's — if you spot a needed manager-side line,
report it, don't edit.
