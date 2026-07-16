---
name: design
description: Design a new REPEATABLE long-chain AI workflow as a pipeline of ordered iteration files under this project's .claude/pipeline/. Invoke ONLY for workflows that will be re-run many times (releases, recurring audits, generic task templates); route one-shot tasks through an existing generic pipeline or a regular agent instead.
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Glob, Grep, Agent
argument-hint: <high-level goal>
---

# Design a Pipeline

You are orchestrating the design of a new pipeline. The goal is provided in `$1` (the argument string passed after `/pipeline:design`).

## When NOT to use this skill (CRITICAL)

This skill creates a NEW pipeline. Pipelines are reserved for **repeatable** long-chain workflows that will be re-run many times across the project's lifetime — releases, recurring audits, generic task templates. **Do not use this skill for one-shot tasks** (single bug fix, single PR, single migration, anything that runs exactly once).

For one-shot tasks:

1. Check whether a **generic pipeline** already exists in the project that fits (e.g. `workflows/implement-task`, `workflows/complete-pull-request`, `workflows/maintain-pull-request`). Route the one-shot through it via `/pipeline:run` or `/pipeline:dispatch` instead of designing a new pipeline.
2. If no generic pipeline fits, fall back to a regular agent (`Agent({subagent_type: "general-purpose", …})` or a domain-specific teammate) with the work embedded in the prompt.

If `$1` describes a clearly one-shot goal (single bug fix, "fix X in file Y", "add a flag once", etc.), push back before delegating to `pipeline-designer`: tell the user this is one-shot, name the existing generic pipeline that fits, and confirm before scaffolding. The `pipeline-designer` agent applies the same rule and will refuse one-shot scaffolding by default — see its "When NOT to design a pipeline" section.

## What you are doing

Delegate the design work to the `pipeline-designer` subagent. That agent knows how to decompose a goal into ordered, self-contained iteration files and write them under `./.claude/pipeline/` in the current consumer project.

## CRITICAL — token discipline: do NOT read pipeline files yourself

This skill is a thin router. The `pipeline-designer` subagent does the reading and writing in its own fresh context. If you, the main session, also read existing `.claude/pipeline/` content here to "understand the project", you double-pay tokens and bloat the main session for the rest of the user's day.

Rules:

- **Never `Read` `PIPELINE.md` or any iteration file (`steps/**/*.md`) in this skill.** If you need to know what pipelines already exist (e.g. to suggest routing a one-shot through a generic pipeline), use `Glob` to list paths only — do not read their content. The designer will read what it needs.
- **Pass the user's goal to the designer verbatim.** Do not paraphrase, summarize, or augment with file content you fetched yourself.
- The designer is responsible for inspecting existing pipelines, choosing categories, and avoiding duplicates — not you.

## Prerequisites

- The current working directory must be the consumer project's root (or a subdirectory from which `.claude/pipeline/` should be created). If unsure, confirm with the user before proceeding.
- The user has provided a high-level goal. If `$1` is empty, ask the user what pipeline they want to design before delegating.
- The goal is for a **repeatable** workflow — see "When NOT to use this skill" above. If it isn't, decline and route the user to an existing generic pipeline or a regular agent.

## Procedure

1. If `$1` is empty, ask the user for the pipeline goal. Do not proceed until you have it.
2. Invoke the `pipeline-designer` subagent via the `Agent` tool with `subagent_type: "pipeline-designer"` and a prompt of this shape. **Do NOT pass a `model` parameter** — `pipeline-designer` pins itself to Opus + `effort: max` in its frontmatter for maximum design quality; a per-call `model` would override (downgrade) it.

   ```
   Design a new pipeline for this goal:

   <verbatim user goal from $1>

   Follow your design protocol. Create the pipeline under
   ./.claude/pipeline/ in the current working directory. When done, report
   the folder path and the command to start execution.
   ```

3. Relay the subagent's final report to the user unchanged. Do not re-describe the pipeline structure yourself — the designer already did.

## Model selection convention

When the user expresses cost/quality preference for the pipeline (e.g. "use the cheap model", "make the hard step use opus", "keep it fast"), forward that verbatim in the prompt to `pipeline-designer`. The designer encodes the preference as `model:` frontmatter on `PIPELINE.md` (pipeline default) and/or individual `steps/NN-*.md` (per-step override). The shorthands are `haiku`, `sonnet`, `opus`; step wins over pipeline, pipeline wins over the session default. Use the cheapest model that fits each step — typically `haiku` for boilerplate/scaffolding/tests, `sonnet` for normal coding, `opus` reserved for genuinely hard reasoning. If the user expresses no preference, the designer omits the field and the session default wins.

```yaml
---
model: sonnet  # PIPELINE.md — pipeline-wide default
---
```

## Report format

After the author finishes, show the user:

- The absolute path of the new pipeline folder.
- The ordered list of iteration titles.
- The command to start execution: `Invoke /pipeline:run <absolute-path>/steps/01-<first-iteration>.md`.
