---
name: clone
description: Scaffold a ready-made pipeline into this project by copying a bundled template into ./.claude/pipeline/<name>/. Use to bootstrap a working pipeline (e.g. support-answer, ship-feature, example-minimal) without authoring one from scratch. Also lists the available templates with --list.
user-invocable: true
allowed-tools: Bash
argument-hint: <template-name>  (or --list to see all)
---

# Clone a pipeline template

You are copying a bundled, ready-made pipeline TEMPLATE into the user's project so
they have a working pipeline to run and adapt — no authoring required, and no
`bun add -g @baizor/pipeline` needed, because you invoke the CLI that ships INSIDE
this plugin.

The template lands at `<cwd>/.claude/pipeline/<name>/` — inside the **consumer
project**, never the plugin install dir. The template SOURCE ships with the plugin;
the CLI resolves it relative to its own location, so cloning works identically from
a plugin install and a global npm install.

## CRITICAL — token discipline: this is a pure thin router

Do NOT `Read` the cloned `PIPELINE.md` or any `steps/**/*.md` content, and do not
open the template source. Your only job is to shell out to the bundled CLI in the
user's current working directory and report what it printed. The CLI already lists
every file it created; relay that, do not re-read the tree to describe it. (This
skill's `allowed-tools` is `Bash` only, which enforces that.)

## Procedure

1. **Run the bundled CLI in the consumer's current working directory**, passing the
   user's arguments through verbatim (the `<template-name>` plus any flags):

   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/apps/pipeline-cli/src/cli.ts" clone <passthrough-args>
   ```

   - Bare form: `/pipeline:clone support-answer` → run `... clone support-answer`.
   - `/pipeline:clone --list` → run `... clone --list` to show the available
     templates (no clone happens).
   - Pass `--force` (overwrite an existing target) and `--dir <path>` (clone into a
     different project root instead of the cwd) straight through when the user
     supplies them. Do NOT invent or hardcode a `--dir`; the default (cwd) is
     correct almost always.
   - Do NOT `cd` into the plugin dir. Only `${CLAUDE_PLUGIN_ROOT}` in the command
     above points into the install; the clone must happen relative to where the
     user is.

2. **Interpret the exit code and report:**
   - `0` — cloned (or `--list` / `--help`). Relay the CLI's output: the template
     name and the file list it printed. Then tell the user how to run it (step 3).
   - `1` — refused: `./.claude/pipeline/<name>/` already exists (or the copy
     failed). Relay the CLI's message; offer `--force` to overwrite (which replaces
     the folder entirely) if that's what they want. Do not force it yourself.
   - `2` — usage: no name, unknown template, or a bad flag. The CLI prints the list
     of valid templates; relay it so the user can pick a real one.

3. **On a successful clone, tell the user briefly how to run it.** Keep it short:
   - Launch it from the local **Pipeline UI** (on by default) — a Launch form lets
     them set options and start the run, or
   - Run it directly: `/pipeline:run <cwd>/.claude/pipeline/<name>/steps/01-*.md`.
   - For the **`support-answer`** template specifically, mention that it takes two
     pipeline variables — `PP_QUESTION` (the question to answer) and `PP_DOCS_DIR`
     (the folder to retrieve over) — which they can fill in on the UI Launch form
     (or pass as `--var PP_QUESTION=... --var PP_DOCS_DIR=...` to `/pipeline:run`).

## Notes

- **Bun is required** — it runs the bundled CLI (same requirement as `/pipeline:ui`).
  If the run fails because Bun is missing, point the user at https://bun.sh and
  stop; do not try to install it for them.
- The available templates are whatever `... clone --list` prints — do not hardcode
  the list here; it grows over time.
- This skill never edits the template after cloning. If the user wants to adapt it,
  they edit the files under `./.claude/pipeline/<name>/` themselves, or use
  `/pipeline:design` for a brand-new pipeline.
