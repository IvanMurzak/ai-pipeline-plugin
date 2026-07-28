# Changelog

Notable changes to the `pipeline` Claude Code plugin and the `@baizor/pipeline` CLI it ships
(they live in one repo and release together; version numbers are independent — see below).
This file starts here; earlier history is in `git log`.

## Terminology rename: "mesh"/"fleet" are gone (simplified-onboarding a11)

**Prepared, not yet released** — this entry documents the code change landed in this PR; the
`plugin.json` `version` bump and the actual release are coordinated with `c13` (see below), not
bundled into this commit. Per the owner directive recorded in `08-terminology.md`/D10/D31, "mesh"
and "fleet" no longer appear anywhere a user reads them:

- **Command:** `pipeline mesh notify` → `pipeline department notify`. The old spelling still works —
  `pipeline mesh notify` is now a hidden, deprecated alias that prints a warning on stderr naming the
  new command, then behaves identically. Scripts and service definitions written against it keep
  working unchanged.
- **Environment variable:** `PIPELINE_MESH_NOTIFY_ENABLED` → `PIPELINE_DEPARTMENT_NOTIFY_ENABLED`. The
  old name is still read as a fallback (with a deprecation warning) when the new one is unset.
- **Files:** `src/lib/mesh-notify.ts` → `src/lib/department-notify.ts`, `src/commands/mesh.ts` →
  `src/commands/department-notify.ts` (a new, thin `src/commands/mesh.ts` now holds only the
  deprecated-alias shim), `hooks/mesh_notifier_relay.ts` → `hooks/department_notifier_relay.ts`,
  `docs/mesh-mcp.md` → `docs/departments-mcp.md`.
- **Prose:** every user-facing string in the CLI, `README.md`, `CLAUDE.md`, and the docs — OS
  notification titles now read "Department task …" instead of "Mesh task …", and the SessionStart
  hook's injected context says "department task update" instead of "department-mesh task update".
- **⚠ Re-consent, on release, not in this commit:** `.claude-plugin/plugin.json`'s `mcpServers` key
  changes from `ai-pipeline-mesh` to `ai-pipeline-departments`. Because that key is embedded in every
  tool's callable name (`mcp__plugin_<plugin>_<server>__<tool>`) and stored OAuth grants are keyed by
  it, this is a one-time, unavoidable cost: **every already-connected user will need to run `/mcp` and
  approve again once**, the next time this key actually ships in a released `version`. Nothing else
  about the connection changes. The `version` bump for that release, and its timing, are coordinated
  with `c13` rather than happening in this PR.

Deliberately NOT renamed: prose inside `.claude/design/**` (the design ledger keeps its original
wording — D17), citations to files in the private `cloud/` repo whose own tier-2 rename has not
landed yet (`mesh-oauth/…`, `mesh-registry/…`, `mesh/routes.ts`, …), and citations to the `pipeline-runner`
sibling repo's own `core/mesh-oauth.ts` (a separate repo's own rename, out of this task's scope).

## Drive record contract on Claude Code >= 2.1.21x + parked-run journaling (e7 kill-drill DEFECT-1 / DEFECT-3)

**CLI 0.3.1** (owner-approved patch release; plugin version unchanged at 0.75.0). Both defects
surfaced in the fix-fundamental-issues e7 kill-drill and blocked the design's prod GO; the
fixes were re-drill-verified end-to-end (all four drill defects dead) before this release.

### Fixed

- **DEFECT-1 (BLOCKER): `pipeline drive`'s executor record contract was dead on current Claude
  Code.** Empirically verified on 2.1.214: (a) a `-p --agent <name>` run returns NO
  `structured_output` — `--json-schema` is silently ignored for subagent runs (upstream
  claude-code#20625); (b) headless `--permission-mode acceptEdits` auto-DENIES every Write under
  `.claude/` as a sensitive path, and NO `--allowedTools`/`permissions.allow` rule overrides it
  (claude-code#66525 — "not planned"), so the canonical
  `.runtime/<run>/records/` file never landed either. Net effect: every agent step did its work,
  then drive halted with "no valid step record (executor exit 0)". The fix keeps the security
  posture (no permission-mode weakening, no bypass) and restores the record through a
  **belt-and-braces channel ladder**:
  1. `structured_output` (authoritative where `--json-schema` still works — <= 2.1.205 behavior
     unchanged);
  2. a per-run tmp **record DROP file** the prompt now names
     (`<os-tmpdir>/pipeline-drive/<rootHash8>-<run>/records/<step>.json`), granted to the claude
     sandbox via the new `--add-dir {record_dir}` template token — the narrowest grant that is
     empirically writable under headless acceptEdits (probed: allow rules and `--add-dir` into
     `.claude/` are both refused; an added tmp dir is accepted);
  3. the legacy canonical record file (custom templates / sessions parked under an older CLI);
  4. the final-response text parsed as a JSON object (`lib/envelope.ts parseResultObject`;
     the hardened headless prompt demands the exact record object as the final response).
  Whichever channel wins, drive persists the canonical `.runtime/<run>/records/` copy ITSELF, so
  every downstream consumer path is unchanged. Templates without `{record_dir}` get the
  `--add-dir` pair appended for step spawns (the `{session}` convention). Headless
  improver/script-creator sessions gain the same result-text recovery (they were taking the
  conservative `applied:false`/`refused` fallback on EVERY run on 2.1.21x).
- **DEFECT-1 DoD — denied-write triage:** the envelope's `permission_denials` are parsed
  (`lib/envelope.ts`), and a no-record halt whose denials name a record path now says
  "record write DENIED by the claude permission gate (<path>)" (plus a live
  `step.record_write_denied` progress event) — distinguishable from "the executor produced no
  record" in logs and stats.
- **DEFECT-3: `pipeline drive` never journalled the `awaiting_input` event**, so a parked
  cloud-dispatched run looked `running` server-side — the sweeper's HOLD disposition was
  unreachable and a parked run would be re-dispatched on lease death (design-forbidden). Drive
  now journals `awaiting_input` at EVERY exit-4 park (agent-step questions AND approval gates,
  first parks AND repeat re-entries) with the exact `@baizor/pipeline-protocol`
  `AwaitingInputData` shape the control plane's runs-ingest consumes
  (`{run_id, iteration, question_id, question}` + additive `step_id`/`iteration_path`), and the
  `--resume` re-entry's re-issued `iteration.started` carries the additive `resumed: true`
  (protocol v5 G5) — the ingest's un-park/next-attempt signal. Gate parks gain a STABLE
  deterministic `question_id` (`gate:<run_id>:<step_id>`), now also present in the gate's exit-4
  JSON. New `lib/event.ts emitEventJson` writes structured (nested-object) journal payloads the
  kv interface cannot carry; the journal envelope stays byte-identical (schema stays 4 —
  values-only addition; see `apps/pipeline-ui/EVENTS.md`).

### Tests

- Fake-runner matrix for the ladder (`tests/drive.test.ts`): `{record_dir}` argv handling,
  result-text + fenced recovery, structured-vs-text precedence, legacy-file compat, denied-write
  triage; park/resume journal contents (order, repeat-park re-emission, resumed tagging).
- `tests/awaiting-input-contract.test.ts` — the cloud-consumed `awaiting_input` shape, with the
  consumer's parsing expectations copied in (provenance: protocol `AwaitingInputData` +
  `QuestionSchema` + envelope, cloud `runs/ingest.ts` `awaiting_input` case, runner shipper
  privacy allowlist).
- `tests/drive-claude-smoke.test.ts` — @serial REAL end-to-end smoke against the installed
  claude binary (a one-step `.claude/`-rooted pipeline through the DEFAULT template on haiku):
  proves a record lands under the fixed contract. Skipped on CI / when claude is absent /
  `PIPELINE_SKIP_CLAUDE_SMOKE=1`.

## Headless self-improvement in `pipeline drive`

**Plugin `0.74.4 → 0.75.0`** (`.claude-plugin/plugin.json`) · **CLI `@baizor/pipeline` `0.2.2 → 0.3.0`**
(`apps/pipeline-cli/package.json`)

Behavior ships behind `PIPELINE_DRIVE_SELF_IMPROVE`
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

## Worktree-scoped pipeline I/O (`isolation: external`)

**Plugin `0.74.4 → 0.75.0`** (`.claude-plugin/plugin.json`) · **CLI `@baizor/pipeline` `0.2.2 → 0.3.0`**
(`apps/pipeline-cli/package.json`)

Behavior ships behind `PIPELINE_WORKTREE_SCOPED` (default ON).

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

## Bounded agent-step retries (`retries:` on `type: agent` steps)

**Plugin `0.74.4 → 0.75.0`** (`.claude-plugin/plugin.json`) · **CLI `@baizor/pipeline` `0.2.2 → 0.3.0`**
(`apps/pipeline-cli/package.json`)

### Added

- **`retries:` frontmatter is now honored on `type: agent` steps** (previously script-step-only):
  a transiently-halted agent step — an executor failure, not a domain `blocked-delegating` or
  depth-ceiling outcome — re-dispatches in a **fresh executor** (a brand-new spawn with its own
  context, not a resume) up to `retries:` times before the run actually halts. Default `0` (omit
  the key ⇒ today's behavior, byte-identical: halt on the first failure). Retry re-dispatches
  carry an additive `retry: n` tag on `iteration.started`; an intermediate halted attempt never
  feeds graph route counters — only the final outcome routes. A mid-retry crash resumes with the
  same retry tag intact (`resumeRun` gained a crash twin beside `pending_fallback`).
- **Sequential steps only in v1** — `retries:` parses harmlessly on a parallel-layer member but is
  structurally never consulted there (layer results arrive as a single `{kind:'layer'}` record,
  never through the per-step retry seam); give the step a `depends-on` fan-in to move it to a
  sequential layer if it needs bounded retries.
- **New plan-time lint (08.5)**: warns when a parallel-layer member's iteration body mentions
  needs-input phrasing, since every layer dispatch runs with `allowInput:false` regardless of
  layer size (companion to the a3 designer self-contained-parallel-steps rule).

### Changed (behavior)

- The script-only ignored-frontmatter warning on agent steps (`script`, `command`, `timeout`,
  `on-failure`) no longer lists `retries` — it now has its own, distinct agent-step meaning and is
  honored on both step kinds.

## `pipeline drive`: correlatable park IDs, provider-limit detection, executor retry env

**Plugin `0.74.4 → 0.75.0`** (`.claude-plugin/plugin.json`) · **CLI `@baizor/pipeline` `0.2.2 → 0.3.0`**
(`apps/pipeline-cli/package.json`)

### Added

- **Top-level `question_id` in the exit-4 (awaiting-input) JSON and persisted session state** —
  minted at park time (06.2.1) so a cloud dispatcher can correlate a parked question across
  restarts without inferring one from nested fields; `--resume --answer` delivers against the SAME
  id.
- **`provider_limit` in the exit-1 (halted) JSON** when the executor envelope indicates a
  provider-side rate-limit or overload (`error_rate_limited` / `error_overloaded`) — shape
  `{reason: "rate_limit_exceeded" | "overloaded", retry_after_ms?}` — so a retry policy can tell
  "the model provider throttled us" apart from every other halt cause (06.7).
- **Executor retry environment (08.4)**: `drive` now sets `CLAUDE_CODE_RETRY_WATCHDOG=1` and
  `CLAUDE_CODE_MAX_RETRIES=15` on every spawned executor (the documented unattended-session
  mechanism, Claude Code 2.1.199+), lifting the transient-retry cap so a flaky provider blip
  doesn't halt the run. Both are overridable: set either env var before invoking `drive` and your
  value wins.

## `pipeline hash` — cloud-equivalent pipeline content hash

**Plugin `0.74.4 → 0.75.0`** (`.claude-plugin/plugin.json`) · **CLI `@baizor/pipeline` `0.2.2 → 0.3.0`**
(`apps/pipeline-cli/package.json`)

### Added

- **New command**: `pipeline hash --root <pipeline_root> [--json]` computes the deterministic
  SHA-256 content hash of a pipeline (`PIPELINE.md` + every file under `steps/**` and
  `scripts/**`) — order-independent (files sorted by POSIX-relative path), rename-sensitive, and
  OS-stable (CRLF→LF normalized by default). Output: `sha256:<hex>` (plain) or
  `{"content_hash":"sha256:<hex>"}` (`--json`). Exit `0` success, `2` on a missing/invalid root.
- This is the SAME identity the cloud registry uses (`registry/hash.ts`, D9) — the runner (c4
  task) shells this exact CLI to verify a lease's content hash before executing. Golden-vector
  tests prove byte-exact equivalence with the cloud registry hash.
- `hashFileSet` (the underlying hashing primitive) is now library-exported for embedding.

## CI, `pipeline gc`, and release-tooling fixes

**Plugin `0.74.4 → 0.75.0`** (`.claude-plugin/plugin.json`) · **CLI `@baizor/pipeline` `0.2.2 → 0.3.0`**
(`apps/pipeline-cli/package.json`)

### Fixed

- **`pipeline gc` silently found nothing to collect on Windows CI (8.3 short-path bug, 06.6).**
  `gc`'s worktree-under-root check compared a Windows 8.3 short-name path segment (`RUNNER~1` —
  what `realpathSync` returns on GitHub's `windows-latest` runner image) against git's own
  long-canonical path output, matching nothing: `report.worktrees` / `removed_worktrees` came back
  empty for both the superproject and submodule scans. Fixed by re-anchoring `gc`'s root on `git
  rev-parse --show-toplevel` (the same resolution `git worktree list` / `prune` already use),
  falling back to `realpathSync` only when git can't answer. pipeline-cli's CI job now runs on
  `windows-latest` in addition to `ubuntu-latest` to catch this class of bug pre-release; the
  `submodule-orphan` / `submodule-modes` / `event` tests are marked `@serial` (flaky under N-way
  local parallel-test contention, not under CI's already-sequential run) so the local test runner
  holds them out of its worker pool. Release workflows are untouched — release stays
  `ubuntu-only`.
- **`pipeline release`'s printed checklist referenced a nonexistent step.** It told users to bump
  a "marketplace.json version" field that doesn't exist — this repo self-distributes via
  `.claude-plugin/marketplace.json`'s `source: "./"`, which carries no per-plugin version to
  drift. Removed; the submodule-pointer-bump step (for the parent marketplace repo) is kept.
  Shipped in plugin `0.74.2`; recorded here since it was undocumented until now.

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
