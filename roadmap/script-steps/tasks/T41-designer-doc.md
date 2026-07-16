# T41 — pipeline-designer.md: teach the designer to prefer script steps

- **Depends on:** T00 (contracts frozen in DESIGN.md)
- **Parallel with:** T11, T12, T42, T43, T44
- **Footprint (only this file):**
  - `agents/pipeline-designer.md` (edit)
- **Status:** done — added Authoring Principle 10 "Script steps (`type: script`)" (ladder rung 3, full template, verbatim ok:false rule, halt/agent + constraints); reframed Principle 9 as rung 2; renumbered old 10–15 → 11–16 and fixed all in-doc cross-refs; updated protocol validation step 8. One out-of-footprint stale ref flagged (repo-root ROADMAP.md:24).

## Goal

The designer authors `type: script` steps whenever a whole iteration is
deterministic — this is where the token economy is actually won.

## Spec

`DESIGN.md` §1 (extraction ladder), §2 (declaration + degradation Steps line),
§3 (Params/Output + ok:false rule), §6.3 (halt vs agent guidance), §7
(manager-window lint), §9 (parallel rules), §11 (secrets).

## Steps

1. Add a new Authoring Principle **"Script steps (`type: script`)"** after the
   current Principle 9, containing:
   - The three-rung extraction ladder (§1) and the decision rule: judgment ⇒
     agent step; fully deterministic (if/else branching included — it is
     still linear software) ⇒ script step; mixed ⇒ script extraction inside an
     agent step (Principle 9).
   - The full file template (frontmatter + `## Params`/`## Output` blocks +
     the mandatory single-path `## Next` + the graceful-degradation `## Steps`
     line) — one complete example, generic placeholders only (repo rule: no
     concrete project names).
   - **The `ok:false` rule verbatim in bold** (§4): domain outcomes are
     `ok:true` + flags + graph edges, never failures.
   - `on-failure` guidance: `halt` (default) for mutating steps
     (push/merge/release), `agent` for read-only/idempotent checks and long
     unattended chains; `retries` for flaky-network steps.
   - Constraints list: no `model`/`effort` on script steps; timeout >
     `MANAGER_SAFE_TIMEOUT_S` needs `runner: headless` or a split; secrets
     never through params (§11); parallel script steps run in-place (§9).
2. Rewrite Principle 9's framing to reference the ladder (its extraction
   content stays; it becomes rung 2 of 3). Cross-link the new principle.
3. Update the "Your Authoring Protocol" validation step (currently step 8) to
   also check: every fully-deterministic iteration was considered for
   `type: script`; script steps pass the `## Next` single-path rule.
4. Keep the repo's editing rules: no concrete project paths, placeholders
   only, and note in the doc that scripts referenced by `script:` follow the
   conventions in `pipeline-script-creator.md` (tests mandatory).

## Acceptance criteria

- A reader can author a valid script step from this doc alone (without
  DESIGN.md).
- No contradiction with `plan.ts` lints (T11) — same field names, same rules.
- Existing principles/numbering references elsewhere in the doc remain
  consistent (search for "Principle" cross-references and fix any you break).

## Out of scope

Other agent docs (T42/T43), README (T44), any code.
