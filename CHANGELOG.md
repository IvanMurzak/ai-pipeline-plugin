# Changelog

Notable changes to the `pipeline` Claude Code plugin and the `@baizor/pipeline` CLI it ships
(they live in one repo and release together; version numbers are independent — see below).
This file starts here; earlier history is in `git log`.

## Headless self-improvement in `pipeline drive` — UNRELEASED

Version numbers land with the release task; behavior ships behind `PIPELINE_DRIVE_SELF_IMPROVE`
(**default OFF this release** — owner decision; `0`/unset restores the v1 skip byte-identically).
Requires **claude >= 2.1.205** for reliable `--json-schema` structured output (older versions fall
back to conservative `applied:false`/`refused` records with a warning).

### Added

- **`pipeline drive` now runs real self-improvement instead of the v1 skips** (closing the C1 gap —
  cloud/headless runs never self-improved). `run-improver` / `run-script-creator` spawn pinned
  headless `pipeline:pipeline-improver` / `pipeline:pipeline-script-creator` sessions through the
  same session + crash-resume machinery as steps (session files `sessions/improver-<n>.json` /
  `script-<n>.json`, shared crash budget, usage/cost folded into `usage.json` and the terminal
  `.stats` enrichment; a failed session never halts the chain). Command templates overridable via
  `PIPELINE_DRIVE_IMPROVER_CMD` / `PIPELINE_DRIVE_SCRIPT_CREATOR_CMD`.
- **Mechanical end-of-run retrospective.** Drive partitions `.feedback/<run-id>/*.md` by
  frontmatter `category` itself: doc-actionable (`doc-flaw`/`ambiguity`/`script-candidate`/
  `script-failure`) feed ONE batch improver session + strictly-sequential script-creators;
  human-only (`project-issue`/`env`/`friction`) become one-line summaries in the final JSON's
  `retrospective` field; unknown/unparseable files are counted `skipped` (never a halt). Feedback
  is deleted on success and preserved when the improver session failed — and always preserved on
  blocked/awaiting parks (manager parity).
- **New events**: `improvement.applied` and `run.retrospective` — payloads carry paths + one-line
  summaries ONLY, never file content. Retro-internal `improver.*`/`script_creator.*` events are
  drive-emitted (manager parity).
- **`preserve_workspace: true`** (+ reason) in the terminal JSON when improvements were applied but
  no finalize hook landed them — an ephemeral cloud job checkout must not be torn down with
  unshipped improvements inside (design 05 §Cloud interplay).
- **New `lib/improver-schema.ts`** — the improver/script-creator record JSON Schemas
  (`{applied, script_creation_briefs[], summary}` / `{outcome, script_path, summary}`), single
  source for the headless sessions' `--json-schema` and the engine's ScriptRecord vocabulary.
- **Step-record schema carries `improvement_brief`** (additive, optional) so the structured-output
  path delivers the Tier-1 brief to the driver — the record-FILE protocol already had it.

### Changed (behavior)

- On a worktree-scoped external run, drive's step prompts now derive `pipeline_root` (and the
  Tier-2 feedback dir) from the surfaced `worktree_pipeline_root` — matching the manager contract,
  so executors journal where the worktree-scoped retrospective gate counts and improver edits ride
  the run's finalize commit by construction. Unscoped runs are unchanged.

## Worktree-scoped pipeline I/O (`isolation: external`) — UNRELEASED

Version numbers land with the release task; behavior ships behind `PIPELINE_WORKTREE_SCOPED` (default ON).

### Changed (behavior)

- **External-isolation runs now execute the pipeline definition from the RUN WORKTREE — committed
  state only.** `pipeline next` provisions the worktree at init (before plan computation) and plans
  from `<worktree>/<pipeline-root-rel>`: a branch that modifies its own pipeline runs ITS version,
  and dispatch paths, rendered copies, script executions, outputs, ledgers, and per-run feedback
  all live under the worktree's pipeline tree. Because a worktree materializes commits only,
  **uncommitted pipeline edits in the main tree no longer reach an external run** — the engine
  emits a loud preflight warning when the main pipeline dir is dirty (commit first, or set
  `PIPELINE_WORKTREE_SCOPED=0` for the legacy main-scoped reads, restored byte-identically).
- **Self-improvement edits ride the run's finalize commit/PR instead of dirtying main.** The
  improver/script-creator/retrospective targets are worktree paths; `.gitignore` stubs written in
  the worktree pipeline tree (`.runtime/`, `.feedback/`) keep run artifacts out of the finalize
  commit. On a halted run the preserved worktree keeps the edits for inspection.
- **Run bookkeeping stays main-scoped**: `next.json` (crash/blocker resume survives teardown), the
  events journal, `.stats`, and liveness remain under the main root; events/stats/UI are labeled
  with the stable MAIN author paths via a `(worktree_prefix, main_prefix)` swap recorded in
  `next.json`. The flag itself is FROZEN per run at init — a mid-run env flip can never mix path
  models within one run.
- **Init-failure teardown**: an invalid worktree pipeline plan right after provisioning runs the
  destroy hook with `outcome: halted` (preserve-on-halt cue applies) — an invalid plan never
  silently leaks a worktree.
- Native-parallel and in-place (`manual`) isolation modes are UNCHANGED; composed child runs and
  `--manual-hooks` runs stay main-scoped.

## Pipeline variables (`${PP_*}`)

**Plugin `0.73.0 → 0.74.0`** (`.claude-plugin/plugin.json`) · **CLI `@baizor/pipeline` `0.1.1 → 0.2.0`**
(`apps/pipeline-cli/package.json`)

### Added

- **`## Variables` manifest section.** Declare pipeline-scoped variables in `PIPELINE.md`:
  `- PP_NAME (required) — description` or `- PP_NAME (default: value) — description`. Reference
  one anywhere in iteration/manifest body text, or in a script step's `command:`/`script:`
  frontmatter values and `## Params` `from:` templates, as `${PP_NAME}` — with an optional inline
  fallback `${PP_NAME:-default}` (unset-or-empty) / `${PP_NAME-default}` (unset only, POSIX
  semantics) and a `$$` escape for a literal token in prose.
- **`--var NAME=value` (repeatable) and `--vars-file <path>` (dotenv format)** on `pipeline next`,
  `pipeline drive`, and `pipeline step run`. Values resolve `--var`/`--vars-file` > the operator's
  environment > the manifest `(default: ...)`, are validated fail-fast and aggregated (every
  missing/unknown/malformed variable reported at once, never first-error-only), and are FROZEN
  into the run's state at init on `next`/`drive` — a `--resume` reuses the frozen map verbatim and
  supplying new values against an already-frozen run is a loud usage error (exit 2). `step run`
  resolves the same way but never freezes or persists anything (dry-run only).
- **Rendered per-run copies of agent iterations.** When a pipeline declares variables, `pipeline
  next`/`drive` substitute `${PP_*}` tokens into a per-run rendered copy of each dispatched
  iteration (and `PIPELINE.md`) under `.runtime/<run-id>/rendered/<pipeline-slug>/` — source files
  are never mutated. The rest of the pipeline tree (sibling steps, `scripts/**`, fixtures) mirrors
  into the same rendered tree so relative references between steps keep resolving; only an
  **absolute** reference back to the source tree still sees raw `${PP_*}` placeholders.
- **Script-step integration**: a resolved `PP_*` value substitutes into a script step's `command:`
  argv (never into `argv[0]`, which is forbidden as a substitution surface outright) and `script:`
  path, and every resolved variable also rides the child process environment alongside the
  existing `PIPELINE_STEP_*` contract vars — existing scripts read `os.environ["PP_X"]` /
  `process.env.PP_X` with zero changes to their own invocation. A substituted `script:`/`command:`
  path is containment-checked against the project root, and a substituted value reaching a
  `.bat`/`.cmd` target (or an authored `cmd`/`cmd.exe` command) is refused — those run through
  `cmd.exe`, which re-parses its command line and is not argv-safe.
- Full CLI-flag contract: `docs/cli.md`. Full script-step argv/env/Params contract: `docs/script-steps.md` §2.5.

### Trust model (read before using)

- `PP_*` variable values are **non-secret configuration by contract**: they are visible verbatim
  in rendered files, params files, child-script environments, logs, events, and — for agent
  steps — the step-executor's LLM context. Never design a variable to carry a secret; keep using
  the existing secret channels (worktree env files, or a script reading real secrets straight from
  the process environment). Secret-looking declared names are lint-warned.
- A value substituted into an agent iteration is **untrusted data in that iteration's LLM
  context**, not an authored instruction — the step-executor treats it as data even if its content
  reads like an instruction.
- **Environment-collision footgun**: no registry reserves the `PP_` namespace. A `PP_*` name
  already set in the operator's shell/CI environment silently satisfies a declared variable with
  no flag and no prompt. Check your environment (or pass an explicit `--var`, which always wins)
  before running an unfamiliar pipeline.

### Upgrade / downgrade caveat

- **Do not downgrade the CLI mid-run on a pipeline using variables.** There is no state-format
  version marker in `next.json`. A run started on this version (or newer) freezes its resolved
  `PP_*` map into `next.json`; an OLDER CLI resuming that same run ignores the unknown `variables`
  key entirely and hands the step-executor the **source** iteration file with raw, unsubstituted
  `${PP_*}` placeholders in it instead of the rendered copy — the run will not fail loudly, it will
  silently execute the wrong content. Finish (or abandon) a run on the CLI version it started on;
  upgrading mid-run is safe (an old run with no `variables` key just keeps its pre-upgrade
  behavior), downgrading a variable-using run is not.
- Runs on pipelines with **no** `## Variables` section are entirely unaffected by this release —
  zero behavior change, zero new files, zero new state keys (`E9`).

### Compatibility

- Fully backward compatible: pipelines without a `## Variables` section take the exact same code
  paths as before (no rendering, identical `ActionStep.path`, identical argv, identical env).
- The pre-existing `${steps.x.output.y}` / `${env.NAME}` / `${run.*}` / `${pipeline.root}` /
  `${project.root}` / `${worktree.*}` Params bindings, the `{model}` drive-executor template, and
  `--param` on `step run` are all unchanged and coexist with `${PP_*}`.
