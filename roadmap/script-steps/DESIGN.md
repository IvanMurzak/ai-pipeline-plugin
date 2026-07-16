# Script Steps — Design Specification (frozen contracts)

Status: **APPROVED — implementation pending** (see `ROADMAP.md`).
Target plugin version: **0.71.0** (minor bump, done ONLY in task T51).

This document is the single source of truth for the feature. Task files under
`tasks/` reference sections here by number. If implementation must deviate from
a contract in this file, STOP and update this file first (and note the change
in the task's report) — never let code and spec drift silently.

---

## 1. Overview

A new step type for pipelines: `type: script`. Such a step runs a terminal
program **with no AI agent involved**. It is executed **in-process by the
`pipeline next` command layer** (`invokeNext` in `commands/next.ts`) — exactly
the pattern already used for external-isolation worktree hooks — so it costs
**zero LLM tokens** in both runners (pipeline-manager and headless
`pipeline drive` share `invokeNext`).

Motivation: today a fully deterministic iteration (build gate, CI wait, file
manipulation, API sequence) still pays a full step-executor spawn (~10–20k
tokens). The three-rung extraction ladder becomes:

1. Inline `Steps` — only where agent judgment is needed.
2. A script called from inside an agent step (existing Authoring Principle 9).
3. **`type: script` — the whole step is deterministic software** (branching
   if/else logic is fine; it is still linear software, not judgment).

Backward compatibility is absolute: absent `type:` ⇒ `agent`; every existing
pipeline behaves byte-for-byte identically.

## 2. Step declaration

A script step stays an ordinary `steps/NN-*.md` file (enumeration, numbering,
`step_id`/`depends-on`, graph membership, improver editability, and the
knowledge-base property are all preserved).

### 2.1 Frontmatter (parsed in `lib/plan.ts`)

```yaml
---
type: script            # NEW. 'agent' (default) | 'script'
script: scripts/wait-ci.py   # path RELATIVE to the pipeline root
# command: ["gh", "run", "list"]   # advanced alternative to script: (see 2.2)
timeout: 300            # seconds; default 600
retries: 2              # default 0; applies ONLY to failure class 'transient'
on-failure: halt        # 'halt' (default) | 'agent'  (see §6)
step_id: wait-ci        # existing field, unchanged semantics
depends-on: [build]     # existing field, unchanged semantics
---
```

Rules:
- `script:` and `command:` are mutually exclusive; exactly one is REQUIRED when
  `type: script` (plan ERROR otherwise).
- `script:` interpreter is resolved by extension, reusing the
  `resolveHookScript` ladder in `lib/hooks.ts`: `.py` → python (python3/python
  probe), `.ts`/`.js`/`.mjs` → bun, `.ps1` → pwsh, `.sh` → bash, executable →
  direct. No shell is EVER involved — argv lists only.
- `command:` is a whitespace-split argv template (same splitting rule as the
  drive executor template; paths with spaces unsupported — documented).
  **Windows caveat:** a bare PATH shim like `npm`/`npx`/`yarn` is a `.cmd`
  shim that CANNOT be spawned shell-less and fails as class `env` — use
  `script:` (interpreter resolved by extension) or an explicit
  `command: ["cmd", "/c", "npm", …]` / a direct executable.
- `model:` / `effort:` / `permission-mode:` on a `type: script` step → plan
  WARNING (meaningless; ignored).
- On `type: agent` steps the new fields (`script`, `command`, `timeout`,
  `retries`, `on-failure`) → plan WARNING (ignored).

### 2.2 Body sections

Required: `# Title`, `## Goal`, `## Success Criteria` (documentation for
humans and for the fallback agent — see §6.4), `## Next`.
Optional: `## Params` (§3), `## Output` (§3.4), `## Context`.

**`## Next` of a sequential-mode script step MUST be exactly one absolute
path or the literal `Pipeline complete.`** — anything else (conditional prose,
multiple paths) is a plan **ERROR**, because the CLI parses it mechanically
(§5.2). Conditional flow belongs to graph mode (flags + `## Graph`).

**Graceful degradation**: the designer keeps one human-readable line in a
`## Steps` section (e.g. ``1. Run: `python <abs>/scripts/wait-ci.py` — waits
for CI``) so an OLD runtime that ignores `type:` treats the file as a plain
agent step and still does something sensible.

## 3. Params, bindings, Output

### 3.1 `## Params` block

A fenced ```json block inside a `## Params` section (same mechanism as the
`## Graph` block — exact `JSON.parse`, no YAML). Vocabulary is a deliberate
**subset of JSON Schema** so a later migration to full schema needs no renames:

```json
{
  "pr_number": { "type": "number", "required": true,
                 "from": "${steps.create-pr.output.pr_number}" },
  "fail_fast": { "type": "boolean", "default": true },
  "labels":    { "type": "array", "value": ["release", "auto"] }
}
```

Per-param fields: `type` (`string|number|boolean|array|object`), `enum?`,
`required?` (default false), `default?`, `description?`, `value?` (static
literal), `from?` (binding template string).

Value resolution precedence: `from` → `value` → `default`. A `required` param
with no resolvable value ⇒ failure class `binding` BEFORE the script spawns.
Type/enum mismatch after resolution ⇒ `binding`.

### 3.2 Binding references

Inside `from` strings: `${steps.<step_id>.output.<dot.path>}`, `${run.id}`,
`${run.task}` (contents of the drive `task.md` when present, else null),
`${env.<NAME>}`, `${pipeline.root}`, `${project.root}`,
`${worktree.path}`, `${worktree.env_file}` (external isolation only).
A `from` that is exactly one `${…}` keeps the referenced JSON type; a mixed
template string interpolates to a string.

### 3.3 Plan-time lints on bindings

- `${steps.x…}` where `x` is not a topological ancestor ⇒ ERROR
  (sequential: an earlier enumerated step; DAG: a transitive `depends-on`
  ancestor; graph mode: static check SKIPPED — order is dynamic, runtime
  resolution errors handle it).
- `${env.NAME}` where NAME matches `/(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)/i`
  ⇒ WARNING (see §11 Secrets).
- Malformed JSON in the block, unknown `type`, `value`+`from` together ⇒ ERROR.

### 3.4 `## Output` block (optional)

Same vocabulary, declares the shape of the step's `output` object. When
present: (a) the runtime VALIDATES the script's actual `output` against it —
violation ⇒ failure class `contract`; (b) plan-time lint can field-check
downstream `${steps.x.output.y}` references against it (missing declared field
⇒ ERROR). Producers without the block get runtime-only checking.

## 4. Execution contract (the process I/O)

Mirrors the frozen worktree-hook contract style. Executed via the existing
`HOOK_RUNNER` wrapper (process-tree kill on timeout — no orphaned
grandchildren).

**Environment** (in addition to inherited process env):
`PIPELINE_STEP_RUN_ID`, `PIPELINE_STEP_ID`, `PIPELINE_STEP_INDEX` (dispatch
index), `PIPELINE_STEP_PIPELINE_ROOT`, `PIPELINE_STEP_PROJECT_ROOT`,
`PIPELINE_STEP_PARAMS_FILE`, and under external isolation
`PIPELINE_STEP_WORKTREE_PATH` + `PIPELINE_STEP_WORKTREE_ENV_FILE`.

**Params file**: resolved params JSON written to
`<pipeline_root>/.runtime/<run-id>/params/<step_id>.json`, path passed via
`PIPELINE_STEP_PARAMS_FILE`. A file, not argv/env payload — Windows quoting
safety and size limits.

**cwd**: the consumer project root. Under `isolation: external`: cwd =
`worktree_path`, and the CLI PARSES the worktree env file (`KEY=VALUE` lines,
`#` comments ignored) into the child env — never shell-`source`.

**stdin**: closed. Scripts MUST NOT prompt (a prompting script hangs until its
timeout).

**stdout** (captured, cap 10 MB — beyond ⇒ class `contract`): the CLI takes the
**last line that parses as a JSON object**; if no line parses, it attempts a
whole-stdout parse; if neither ⇒ class `contract`/`crash`. Result shape:

```json
{
  "ok": true,
  "summary": "CI green in 6m12s (14 checks)",
  "flags":   { "ci_green": true },
  "output":  { "pr_number": 132, "checks_passed": 14 },
  "error":   { "class": "transient", "detail": "..." }
}
```

`ok` REQUIRED; everything else optional. `error` is only meaningful with
`ok: false` (self-classification: `transient|env|bug`; absent ⇒ `bug`).

**Designer rule (load-bearing): `ok:false` means "the step could not do its
job", NEVER "the domain answer is no".** Domain outcomes (CI red, no changes)
are `ok:true` + `flags` + graph edges.

## 5. Record mapping & chain advancement

### 5.1 Success

`exit 0` + `ok:true` ⇒ engine record
`{kind:'step', outcome:'completed', flags, next_iteration, output}` synthesized
by the CLI. `output` is persisted per §10. Script steps can NEVER produce
`needs-input` or `blocked-delegating` (by construction).

### 5.2 Advancement

- **Graph mode**: `flags` feed `routeNext()` exactly like agent-step
  `result_flags`.
- **Sequential mode**: the CLI deterministically parses the step file's
  `## Next` section — the single absolute path (→ `next_iteration`) or
  `Pipeline complete.` (→ `PIPELINE_COMPLETE`). Guaranteed unambiguous by the
  §2.2 plan ERROR.
- **DAG mode**: layers advance in the engine as today; `next_iteration` unused.

## 6. Failure handling

### 6.1 Failure classes

`transient` (network blip, timeout — incl. CLI-enforced timeout),
`binding` (param resolution/validation failed BEFORE spawn),
`env` (interpreter ENOENT, `error.class:"env"`),
`crash` (exit ≠ 0 with no valid JSON),
`contract` (invalid/oversized stdout JSON, `## Output` violation),
`bug` (`ok:false` with `error.class:"bug"` or no class).

Mechanical classification lives in `lib/script-step.ts`; the script's own
`error.class` is trusted when present.

### 6.2 What the CLI ALWAYS does on failure (deterministic, before any policy)

1. Write a **failure record**
   `<pipeline_root>/.runtime/<run-id>/failures/<step_id>-<dispatch_index>-<attempt>.json`
   (the `dispatch_index` segment disambiguates graph loop-back re-executions of
   the same `step_id` — same rationale as the ledger key, §8):
   `{step_id, attempt, dispatch_index, class, exit_code, timed_out,
   stderr_tail, stdout_tail (≈2 KB each), params_file, duration_s, detail}`
   plus full stdout/stderr in a sibling `.log` (same base name). Records/events
   carry only the tails; whoever repairs reads the `.log` from disk (token
   discipline).
2. Write a **feedback file** into `.feedback/<run_id>/` — the CLI writes it
   ITSELF, no agent needed: category `script-failure` for
   `crash|contract|bug`, category `env` for `env`, category `doc-flaw` for
   `binding` (it is a `## Params` wiring bug), and category `friction` for an
   exhausted-retries `transient` failure (human-only — nothing for the
   improver to heal; a transient failure that succeeds within `retries:`
   writes no feedback). [T12/T51 gap-fill: the original spec assigned no
   category to `transient`.] This is what makes the existing
   Tier-2 retrospective heal scripts even when the run halts.

### 6.3 Policy ladder

1. `transient` ⇒ mechanical re-run up to `retries:` times (zero tokens).
   Budget exhausted ⇒ continue down the ladder as class `transient`.
2. `env` ⇒ halt (agent fallback would waste tokens on a broken machine).
3. Everything else ⇒ per `on-failure`:
   - **`halt` (default)** — run halts with a clear `halt_reason`
     (`script step <id> failed (<class>): <detail>`). Right choice for
     MUTATING steps (push/merge/release). Feedback is already written, so the
     retrospective → improver → script-creator (`mode: repair-script`) fixes
     the script; the human resumes with `--resume --start <same step>`.
   - **`agent`** — the engine re-dispatches the SAME step as an agent-type
     `run-step` whose `steps[0]` carries `fallback: 'script-failure'` +
     `failure_record: <abs path>`. The manager/drive spawn a normal
     step-executor with one extra prompt line ("this step's script failed;
     failure record at <path>; achieve the iteration's Goal per your fallback
     protocol"). The executor achieves the Goal manually (the markdown body IS
     the fallback spec), returns a NORMAL step record (chain continues), does
     NOT edit the script, and emits an `improvement_brief` → existing Tier-1 →
     `script_creation_brief` with `mode: repair-script` fixes the script
     between steps.

### 6.4 Bounds

- Fallback agent: **once per step per run** (`state.fallback_attempted`);
  if the fallback itself fails ⇒ normal halt path.
- Repair: **once per step's script per run** (`state.repaired_steps`); a
  second failure of the same script after an in-run repair ⇒ halt.
- `retries` apply to class `transient` only.
- v1: `on-failure: agent` inside a PARALLEL layer degrades to `halt`
  (documented; parallel fallback folding is v2).

## 7. Timeouts & the call budget (manager mode)

The manager reaches `pipeline next` through a Bash call capped at 10 minutes.
In-process scripts run INSIDE that call. Deadline-inversion prevention:

- Constants (in `lib/script-types.ts`): `DEFAULT_SCRIPT_TIMEOUT_S = 600`,
  `CALL_BUDGET_MS = 480_000` (8 min soft), `SAFETY_MARGIN_MS = 45_000`,
  `MANAGER_SAFE_TIMEOUT_S = 420`, `MAX_SCRIPT_EXECS_PER_CALL = 200`.
- **Effective deadline** = `min(step.timeout, remaining_call_budget − margin)`.
  The CLI always kills the script itself (tree-kill), classifies `transient`,
  and still has time to write records/state before the outer ceiling.
- **`continue` action**: before starting a script that does not fit the
  remaining budget, the CLI persists state and returns `{action:'continue'}`.
  The caller performs nothing and immediately calls
  `pipeline next … --record '{"kind":"continue"}'` — a fresh Bash window.
  Chains of script steps therefore span any number of calls. (The record keeps
  the loop protocol uniform; a bare no-record call would collide with the
  auto-resume re-entry semantics.)
- A single script whose `timeout` exceeds `MANAGER_SAFE_TIMEOUT_S` on a
  `runner: manager` pipeline ⇒ plan WARNING ("use runner: headless or split").
  `pipeline drive` runs with an infinite call budget (no outer ceiling).
- Manager doc: always call `pipeline next` with Bash `timeout: 600000`.

## 8. Attempt ledger (double-execution protection)

Protects side-effectful scripts from re-execution when a crash/kill lands
between script success and state persistence:

- Before spawn: write `<run>/ledger/<step_id>-<dispatch_index>.json`
  `{phase:'started', …}`. After success: persist the output file (§10), then
  flip the ledger entry to `{phase:'finished', record:<synthesized record>}`.
- On (re-)dispatch of a script step, the CLI first checks the ledger for the
  SAME `(step_id, dispatch_index)`: `finished` ⇒ reuse the stored
  record/output, DO NOT re-execute; `started` ⇒ the previous attempt died
  mid-flight ⇒ re-execute (idempotency requirement — already mandated by the
  script conventions).
- Keying by `(step_id, dispatch_index)` is load-bearing: a graph loop-back
  re-runs the same `step_id` as a NEW dispatch index ⇒ new execution, never a
  stale reuse.

Covers: Bash-timeout kills, UI STOP, manager crash, machine death.

## 9. Parallel / DAG rules (v1)

- Script steps MAY be members of DAG layers. The command layer PARTITIONS a
  concurrent layer: script members are executed in-process FIRST (their
  results held in `state.partial_layer_results`), then the `run-step` action
  returned to the caller contains ONLY the agent members. When the caller
  records the layer, the CLI folds partial + recorded results. An all-script
  layer is fully self-fed (the caller sees only the next real action).
- Script steps in a parallel layer run IN-PLACE (no worktree, no merge entry).
  Disjoint-footprint discipline is the designer's job (as today).
- `on-failure: agent` in a parallel layer ⇒ treated as `halt` (v1, §6.4).

## 10. Dataflow — the outputs store

- Every step's `output` object is persisted by the command layer to
  `<pipeline_root>/.runtime/<run-id>/outputs/<step_id>.json` (loop-back
  executions overwrite — latest wins). Persist cap 64 KB: an oversized output
  logs a warning and is NOT persisted (downstream bindings to it fail as
  `binding` with a clear message).
- Script steps: `output` comes from stdout JSON. Agent steps: a new OPTIONAL
  additive `output` field on the step record (`STEP_RECORD_SCHEMA` +
  `StepRecord` + step-executor "Step record file" protocol — lockstep).
- Consumers: script params via `${steps.<id>.output.<path>}`; agent iterations
  reference the file path in their `Inputs` section (`Read
  <pipeline_root>/.runtime/<run_id>/outputs/<step_id>.json`).

## 11. Secrets

Secrets NEVER travel through params or outputs. Scripts inherit the process
environment and read secrets directly (`os.environ`). `${env.…}` bindings are
for non-secret values only; the §3.3 lint warns on secret-looking names.
Failure-record stderr tails are redaction-best-effort (documented limitation).

## 12. Observability

- **Events** (additive, NO `SCHEMA_VERSION` bump — same pattern as `step_id`
  in v4): `iteration.started`/`iteration.completed` gain optional
  `step_type: "script"`; `iteration.completed` gains optional
  `failure_class`. Update `EVENTS.md`, `web/src/types.ts` (mandatory
  literals), `logs.ts` `bitsForEvent`.
- **Stats**: step timeline lines carry `step_type`; the run record gains
  `llm_steps` (count of agent-type steps executed). A finished run with
  `llm_steps: 0` finalizes `tokens` as true zeros — it must NOT stay
  "pending" (the existing zero-guard is for runs that HAD agent steps).
  Script failures appear in the run `.log` beside tool fails.
- `/pipeline:optimize` therefore sees: which scripts are flaky, how often the
  fallback fired, and what fallbacks cost.

## 13. DX & debugging

- **`pipeline step run <iteration.md> [--param k=v …] [--json]`** — NEW
  subcommand: resolves params (statics/defaults; `${steps…}` refs REQUIRE a
  `--param` override, else exit 2 with a clear message), executes the script
  exactly as the runtime would (same env/cwd/timeout machinery), prints the
  result + the would-be step record. NEVER touches any run state. This is how
  a pipeline author tests a script step without a full run.
- **`--manual-scripts`** flag on `pipeline next` (mirrors `--manual-hooks`):
  returns raw script-step `run-step` actions to the caller instead of
  executing them (debugging only; the caller records the step record itself).

## 14. Frozen TypeScript surface (created in T00 as `lib/script-types.ts`)

```ts
export type StepType = 'agent' | 'script';
export type FailureClass = 'transient' | 'binding' | 'env' | 'crash' | 'contract' | 'bug';
export type OnFailurePolicy = 'halt' | 'agent';

export interface ScriptParamSpec {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  enum?: (string | number)[];
  required?: boolean;
  default?: unknown;
  description?: string;
  value?: unknown;   // static literal (mutually exclusive with `from`)
  from?: string;     // binding template, e.g. "${steps.build.output.sha}"
}

export interface ScriptStepSpec {
  script: string | null;      // pipeline-root-relative path (xor command)
  command: string[] | null;   // whitespace-split argv template
  timeoutS: number;           // default DEFAULT_SCRIPT_TIMEOUT_S
  retries: number;            // default 0, transient-only
  onFailure: OnFailurePolicy; // default 'halt'
  params: Record<string, ScriptParamSpec> | null;
  output: Record<string, ScriptParamSpec> | null;  // ## Output declaration
}

export interface ScriptResult {
  ok: boolean;
  summary?: string | null;
  flags?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  error?: { class?: 'transient' | 'env' | 'bug'; detail?: string | null } | null;
}

export interface ScriptFailureRecord {
  step_id: string; attempt: number; dispatch_index: number;
  class: FailureClass; exit_code: number | null; timed_out: boolean;
  stderr_tail: string; stdout_tail: string;
  params_file: string | null; duration_s: number; detail: string;
}

export interface LedgerEntry {
  step_id: string; dispatch_index: number;
  phase: 'started' | 'finished';
  output?: Record<string, unknown> | null;
  record?: unknown | null;   // the synthesized StepRecord on 'finished'
}

export const DEFAULT_SCRIPT_TIMEOUT_S = 600;
export const CALL_BUDGET_MS = 480_000;
export const SAFETY_MARGIN_MS = 45_000;
export const MANAGER_SAFE_TIMEOUT_S = 420;
export const MAX_SCRIPT_EXECS_PER_CALL = 200;
export const STDOUT_CAP_BYTES = 10 * 1024 * 1024;
export const OUTPUT_PERSIST_CAP_BYTES = 64 * 1024;
export const SECRET_ENV_PATTERN = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)/i;
```

Engine-side additions (T21, in their existing files): `PlanStep.type` +
`PlanStep.script_spec` (plan.ts); `ActionStep.type`, `ActionStep.fallback?`,
`ActionStep.failure_record?`, `NextAction` += `{action:'continue'}`,
`NextRecord` += `{kind:'continue'}`, `NextState` += `fallback_attempted?`,
`repaired_steps?`, `partial_layer_results?` (next.ts). `STEP_RECORD_SCHEMA` +=
optional `output` object (step-schema.ts, T00; keep serialization
whitespace-free — the schema test asserts it).

## 15. Lockstep & invariants

- Change chain: `plan.ts` ↔ `script-types.ts`/`script-step.ts` ↔ `next.ts` ↔
  `commands/next.ts` ↔ `step-schema.ts` ↔ `EVENTS.md`/`web/src/types.ts`/
  `logs.ts`/`stats.ts` ↔ agent docs (designer / script-creator / improver /
  manager / step-executor) ↔ `README.md`/`docs/cli.md` — change together.
- The pure engine (`lib/next.ts`) NEVER touches the filesystem or spawns
  processes — execution lives in the command layer / `script-step.ts`,
  injected seams for tests (a `ProcessRunner` seam like `GitRunner`).
- The plugin stays read-only at runtime; everything written lands under the
  consumer project's `.claude/pipeline/**`.
- Scripts inherit the sandbox/permission envelope of the Bash call that runs
  `pipeline next` (document; recommend allowlisting) — same trust boundary as
  worktree hooks (consumer-authored code in the consumer project).

## 16. Out of scope (v2 candidates — do NOT build now)

Detached execution + polling for single scripts longer than the manager
window; parallel-layer agent fallback; `secret: true` param transport;
full JSON Schema validation; UI editor scaffolding for script steps.
