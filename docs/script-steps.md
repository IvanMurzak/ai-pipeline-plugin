# Script steps — the `type: script` step contract (reference)

Reference for **pipeline authors** writing `type: script` iteration files (and for maintainers editing the runtime). A script step runs a terminal program **with no AI agent involved** — the `pipeline next` command layer executes it **in-process** (exactly the pattern already used for external-isolation worktree hooks), so it costs **zero LLM tokens** in both runners (the `pipeline-manager` and headless `pipeline drive` share the same `invokeNext`).

Use it when a whole iteration is deterministic software — a build gate, a CI wait, a file/API sequence — that today still pays a full step-executor spawn (~10–20k tokens). The extraction ladder has three rungs:

1. **Inline `Steps`** — only where agent judgment is needed.
2. **A script called from inside an agent step** — the existing script-extraction path (`pipeline-script-creator`); the agent still reads the result and decides.
3. **`type: script` — the whole step is the program.** Branching if/else logic is fine; it is still linear software, not judgment.

**Backward compatibility is absolute.** Absent `type:` ⇒ `agent`; every existing pipeline behaves byte-for-byte identically. An old runtime that does not understand `type: script` treats the file as a plain agent step (see the graceful-degradation `## Steps` line below).

---

## 1. Step declaration

A script step is an ordinary `steps/NN-*.md` file — enumeration, numbering, `step_id` / `depends-on`, graph membership, and improver editability are all preserved.

### 1.1 Frontmatter (parsed in `lib/plan.ts`)

```yaml
---
type: script                 # NEW. 'agent' (default) | 'script'
script: scripts/wait-ci.py   # path RELATIVE to the pipeline root
# command: ["gh", "run", "list"]   # advanced alternative to script: (see below)
timeout: 300                 # seconds; default 600
retries: 2                   # default 0; applies ONLY to failure class 'transient'
on-failure: halt             # 'halt' (default) | 'agent'
step_id: wait-ci             # existing field, unchanged semantics
depends-on: [build]          # existing field, unchanged semantics
---
```

| Field | Values (default first) | Notes |
|---|---|---|
| `type:` | `agent` \| `script` | Absent ⇒ `agent`. |
| `script:` | *(path)* | Path **relative to the pipeline root**. Interpreter resolved by extension. |
| `command:` | *(argv list)* | Explicit argv list (or a whitespace-split string). Advanced alternative to `script:`. |
| `timeout:` | `600` | Seconds. |
| `retries:` | `0` | Mechanical re-runs; applies **only** to failure class `transient`. |
| `on-failure:` | `halt` \| `agent` | What happens when a non-`transient`, non-`env` failure survives retries (see §5.3). |

Rules (all enforced at `pipeline plan` time):

- `script:` and `command:` are **mutually exclusive**, and **exactly one is REQUIRED** when `type: script` — otherwise a plan **ERROR**.
- **`script:` interpreter** is resolved by extension, reusing the `resolveHookScript` ladder in `lib/hooks.ts`: `.py` → python (`python3`/`python` probe), `.ts`/`.js`/`.mjs` → bun, `.ps1` → pwsh, `.sh` → bash, an executable file → direct. **No shell is EVER involved — argv lists only.**
- **`command:`** is an explicit argv list (or a whitespace-split string, same splitting rule as the drive executor template). **Paths with spaces are unsupported.** **Windows caveat:** a bare PATH shim like `npm` / `npx` / `yarn` is a `.cmd` shim that CANNOT be spawned shell-less and fails as class `env` — use `script:` (interpreter resolved by extension) or an explicit `command: ["cmd", "/c", "npm", …]` / a direct executable instead.
- `model:` / `effort:` / `permission-mode:` on a `type: script` step ⇒ plan **WARNING** (meaningless; ignored).
- On a `type: agent` step, the new fields (`script`, `command`, `timeout`, `retries`, `on-failure`) ⇒ plan **WARNING** (ignored).
- **`script:` and `command:` are declared `${PP_*}` substitution surfaces** (D5(c)) — a pipeline's declared pipeline variables (`## Variables` in `PIPELINE.md`) substitute into these two frontmatter values exactly as they do into iteration body text. Every OTHER frontmatter field remains banned from variable substitution (plan **ERROR**). See §2.5 for the full argv/env contract.

### 1.2 Body sections

- **Required:** `# Title`, `## Goal`, `## Success Criteria`, `## Next`. (`## Goal` / `## Success Criteria` are documentation for humans and for the fallback agent — see §5.3.)
- **Optional:** `## Params` (§2), `## Output` (§2.4), `## Context`.
- **Recommended for graceful degradation:** a `## Steps` section with **one human-readable line** — e.g. ``1. Run: `python <abs>/scripts/wait-ci.py` — waits for CI`` — so an OLD runtime that ignores `type:` treats the file as a plain agent step and still does something sensible.

**`## Next` of a sequential-mode script step MUST be exactly one absolute path or the literal `Pipeline complete.`** Anything else (conditional prose, multiple paths) is a plan **ERROR**, because the CLI parses it mechanically (§4.2). Conditional flow belongs to graph mode (`result_flags` + the `## Graph` block).

---

## 2. Params, bindings, and Output

### 2.1 `## Params` block

A fenced ```json block inside a `## Params` section — parsed with an exact `JSON.parse` (no YAML), the same mechanism as the `## Graph` block. The vocabulary is a deliberate **subset of JSON Schema**:

```json
{
  "pr_number": { "type": "number", "required": true,
                 "from": "${steps.create-pr.output.pr_number}" },
  "fail_fast": { "type": "boolean", "default": true },
  "labels":    { "type": "array", "value": ["release", "auto"] }
}
```

Per-param fields:

| Field | Meaning |
|---|---|
| `type` | `string` \| `number` \| `boolean` \| `array` \| `object` |
| `enum?` | Allowed values. |
| `required?` | Default `false`. |
| `default?` | Fallback value. |
| `description?` | Human documentation. |
| `value?` | Static literal (mutually exclusive with `from`). |
| `from?` | Binding template string (see §2.2). |

**Value resolution precedence:** `from` → `value` → `default`. A `required` param with no resolvable value ⇒ failure class `binding` **before the script spawns**. A type / `enum` mismatch after resolution ⇒ `binding`.

### 2.2 Binding references

Inside `from` strings:

| Reference | Resolves to |
|---|---|
| `${steps.<step_id>.output.<dot.path>}` | A field of an earlier step's persisted `output` (§6). |
| `${run.id}` | The run id. |
| `${run.task}` | Contents of the drive `task.md` when present, else `null`. |
| `${env.<NAME>}` | An environment variable (non-secret values only — see §8). |
| `${pipeline.root}` | Absolute pipeline root. |
| `${project.root}` | Absolute consumer project root. |
| `${worktree.path}` | The provisioned worktree path (external isolation only). |
| `${worktree.env_file}` | The worktree env file (external isolation only). |
| `${PP_NAME}` / `${PP_NAME:-default}` / `${PP_NAME-default}` | The run's FROZEN pipeline-variable map (§2.5) — same POSIX `:-`/`-` default rules as body substitution. Always resolves to a JSON **string**, even in single-ref position. |

A `from` that is **exactly one `${…}`** keeps the referenced JSON type; a **mixed template string** interpolates to a string. **`$$` escaping is body-only**: a `$${PP_X}` inside a `from` template is NOT treated as the D13 escape (that collapse belongs to `substituteText` over body text) — write `PP_*` refs in Params templates without `$$`.

### 2.3 Plan-time lints on bindings

- `${steps.x…}` where `x` is not a topological ancestor ⇒ **ERROR** (sequential: an earlier enumerated step; DAG: a transitive `depends-on` ancestor; graph mode: the static check is SKIPPED — order is dynamic, runtime resolution errors handle it).
- `${env.NAME}` where `NAME` matches `/(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)/i` ⇒ **WARNING** (see §8, Secrets).
- Malformed JSON in the block, an unknown `type`, or `value` + `from` together ⇒ **ERROR**.

### 2.4 `## Output` block (optional)

Same vocabulary; declares the shape of the step's `output` object. When present:

- (a) the runtime **VALIDATES** the script's actual `output` against it — a violation ⇒ failure class `contract`;
- (b) plan-time lint field-checks downstream `${steps.x.output.y}` references against it — a reference to a missing declared field ⇒ **ERROR**.

Producers without the block get runtime-only checking (no downstream field-lint).

### 2.5 Pipeline variables (`${PP_*}`) in script steps

When the pipeline declares a `## Variables` section in `PIPELINE.md` (authoring guidance:
`pipeline-designer.md`; CLI flags: `docs/cli.md`), a script step's `command:`/`script:`
frontmatter values and `## Params` `from:` templates (§2.2) are substitution surfaces for the
run's FROZEN `PP_*` map, alongside iteration/manifest body text.

- **argv/`script:` substitution** happens at command build, AFTER plan-time tokenization: each
  `command:` argv element (except `argv[0]`, see below) and the `script:` value each go through
  ONE substitution pass. A value containing spaces or shell metacharacters stays exactly ONE argv
  element — there is no shell anywhere in the spawn path (T3).
- **`argv[0]` (the program name) is NEVER a substitution surface — forbidden outright.** A
  `command:` whose first element contains a `${PP_*}` occurrence fails as a pre-spawn `binding`
  error (nothing spawns): write the executable literally and pass variables only as later
  arguments (T3b).
- **A variable-steered `script:` path must stay inside the project (T3b).** After substitution,
  the resolved script path is checked with a CANONICALIZED containment test (never a string
  prefix) against the project root and the pipeline/script root; a path that escapes ⇒ pre-spawn
  `binding` failure, never a spawn.
- **`.bat`/`.cmd` targets are BLOCKED once variable data reaches them (T3c).** A substituted
  `script:` path landing on `.bat`/`.cmd`, or a substituted `command:` argument passed through an
  authored `cmd`/`cmd.exe`/`.bat`/`.cmd` `argv[0]`, is refused as a `binding` failure — those run
  through `cmd.exe`, which RE-PARSES its command line (metacharacters, `%VAR%` expansion), so a
  substituted value there is shell-reachable, not argv-safe. The check is platform-independent: a
  pipeline authored for win32 fails identically when linted or dry-run on another OS, instead of
  passing there and detonating on Windows. An all-literal (non-substituted) `cmd`/`.bat`/`.cmd`
  command is untouched — this is pre-existing author capability, not a new restriction.
- **Argument/option injection (T3c, CWE-88): use `--` before a variable-derived positional
  argument.** A substituted value beginning with `-` (`PP_SERVICE=--help`) is read as a FLAG by
  the target program even though it is one argv element. Author guidance: place `--` before
  variable-derived positional arguments in the `command:` list so a leading `-` cannot be
  misread as an option; a value placed after an options-taking flag is the author's own
  responsibility — this is NOT fully preventable at the framework layer.
- **Env overlay (D10)**: every resolved `PP_*` entry rides the child process environment too (in
  addition to any substitution above) — see §3.1's precedence note. A script never needs extra
  wiring to read a declared variable: `os.environ["PP_SERVICE"]` / `process.env.PP_SERVICE` works
  the moment Persona A's two-edit declaration lands (no invocation-plumbing changes required).
- **Trust (D4/T10)**: `PP_*` values are non-secret configuration BY CONTRACT — they are visible
  verbatim in the params file, argv, child env, failure records, logs, events, and (once an agent
  step reads a rendered copy) the executor's LLM context, where a substituted value is **untrusted
  data, never an authored instruction**. Never design a variable to carry a secret; secret-looking
  names (`TOKEN`/`SECRET`/`KEY`/`PASSWORD`/`CREDENTIAL`/`PASSWD`) are lint-warned, same spirit as
  the `${env.NAME}` lint in §11.
- **Footgun**: no registry reserves the `PP_` namespace — a `PP_*` name already present in the
  operator's shell/CI environment silently satisfies a declared variable via the environment tier,
  with no flag and no prompt. An explicit `--var` always wins over the environment.

---

## 3. The process I/O contract (FROZEN)

> This contract is **FROZEN**: existing consumer scripts must keep working unmodified. If you change anything in this section, update `apps/pipeline-cli/src/lib/script-step.ts`, `apps/pipeline-cli/src/lib/script-types.ts`, `apps/pipeline-cli/src/commands/next.ts`, and this doc in lockstep, and bump the plugin version.

The step is executed via the same `HOOK_RUNNER` wrapper used for worktree hooks (process-tree kill on timeout — no orphaned grandchildren).

### 3.1 Environment

In addition to the inherited process environment, the CLI sets:

- `PIPELINE_STEP_RUN_ID`
- `PIPELINE_STEP_ID`
- `PIPELINE_STEP_INDEX` — the dispatch index
- `PIPELINE_STEP_PIPELINE_ROOT`
- `PIPELINE_STEP_PROJECT_ROOT`
- `PIPELINE_STEP_PARAMS_FILE` — path to the resolved params file (§3.2)
- under `isolation: external` only: `PIPELINE_STEP_WORKTREE_PATH` + `PIPELINE_STEP_WORKTREE_ENV_FILE`
- when the pipeline declares `## Variables` (§2.5, D10): every resolved `PP_*` name, added AFTER
  the worktree env-file entries below and BEFORE the `PIPELINE_STEP_*` vars above. **Precedence
  for a given name: `PIPELINE_STEP_*` (its own namespace, cannot collide by grammar) >
  frozen `PP_*` > worktree env-file > inherited process env.**

### 3.2 Params file

The resolved params JSON is written to `<pipeline_root>/.runtime/<run-id>/params/<step_id>.json` and its path is passed via `PIPELINE_STEP_PARAMS_FILE`. It is a **file, not an argv/env payload** — for Windows quoting safety and size limits. Read the file, parse it as JSON.

### 3.3 cwd

The consumer **project root**. Under `isolation: external` the cwd is the **`worktree_path`**, and the CLI **PARSES** the worktree env file (`KEY=VALUE` lines, `#` comments ignored) into the child environment — it never shell-`source`s it.

### 3.4 stdin

**Closed.** Scripts MUST NOT prompt — a prompting script hangs until its timeout.

### 3.5 stdout — the result object

stdout is captured with a **10 MB cap** (`STDOUT_CAP_BYTES`; beyond it ⇒ class `contract`). The CLI takes the **last line that parses as a JSON object**; if no line parses, it attempts a **whole-stdout** parse; if neither yields an object ⇒ class `contract` / `crash`. Diagnostics belong on stderr.

```json
{
  "ok": true,
  "summary": "CI green in 6m12s (14 checks)",
  "flags":   { "ci_green": true },
  "output":  { "pr_number": 132, "checks_passed": 14 },
  "error":   { "class": "transient", "detail": "..." }
}
```

- `ok` (boolean) is **REQUIRED**; everything else is optional.
- `summary` — one human line for logs/records.
- `flags` — routing signals; in graph mode they feed `routeNext()` exactly like an agent step's `result_flags` (§4.2).
- `output` — the step's dataflow payload, persisted to the outputs store (§6).
- `error` — only meaningful with `ok: false`; self-classification `transient | env | bug` (absent ⇒ `bug`).

### 3.6 The `ok:false` rule (load-bearing)

**`ok:false` means "the step could not do its job", NEVER "the domain answer is no".** Domain outcomes (CI red, no changes to release, tests found a real bug) are `ok:true` + `flags` + graph edges — NOT `ok:false`. A script that returns `ok:false` because CI was red will (with `on-failure: halt`) stop the whole run; a script that returns `ok:true` + `{"flags":{"ci_green":false}}` lets the graph route to the right recovery step.

---

## 4. Record mapping & chain advancement

### 4.1 Success

`exit 0` + `ok:true` ⇒ the CLI synthesizes the engine record `{kind:'step', outcome:'completed', flags, next_iteration, output}`; `output` is persisted per §6. A script step can **never** produce `needs-input` or `blocked-delegating` (by construction — no agent, closed stdin).

### 4.2 Advancement

- **Graph mode:** `flags` feed `routeNext()` exactly like agent-step `result_flags`.
- **Sequential mode:** the CLI deterministically parses the step file's `## Next` — the single absolute path (→ `next_iteration`) or `Pipeline complete.` (→ `PIPELINE_COMPLETE`). Guaranteed unambiguous by the §1.2 plan ERROR.
- **DAG mode:** layers advance in the engine as today; `next_iteration` is unused.

---

## 5. Failure handling

### 5.1 Failure classes

Mechanical classification lives in `lib/script-step.ts`; the script's own `error.class` is trusted when present.

| Class | Cause |
|---|---|
| `transient` | Network blip, timeout — **including the CLI-enforced timeout**. Retried per `retries:`. |
| `binding` | Param resolution / validation failed **before** spawn. |
| `env` | Interpreter ENOENT, or the script self-reported `error.class:"env"` — a broken machine. |
| `crash` | Exit ≠ 0 with no valid JSON result. |
| `contract` | Invalid / oversized stdout JSON, or a `## Output` violation. |
| `bug` | `ok:false` with `error.class:"bug"` or no class. |

### 5.2 What the CLI ALWAYS does on failure (deterministic, before any policy)

1. **Failure record** at `<pipeline_root>/.runtime/<run-id>/failures/<step_id>-<dispatch_index>-<attempt>.json` (the `dispatch_index` segment disambiguates graph loop-back re-executions of the same `step_id` — same rationale as the ledger key, §8):
   `{step_id, attempt, dispatch_index, class, exit_code, timed_out, stderr_tail, stdout_tail, params_file, duration_s, detail}` (the tails are ~2 KB each), plus the **full** stdout/stderr in a sibling `.log` (same base name). Records and events carry only the tails; whoever repairs the script reads the `.log` from disk (token discipline).
2. **Feedback file** into `.feedback/<run-id>/` — the CLI writes it itself, no agent needed: category `script-failure` for `crash | contract | bug`, category `env` for `env`, category `doc-flaw` for `binding` (a `## Params` wiring bug), and category `friction` for an exhausted-retries `transient` failure (human-only — a flake is neither a script nor a doc flaw; a transient failure that later SUCCEEDS within its `retries:` budget writes no feedback at all). This is what lets the end-of-run Tier-2 retrospective heal scripts even when the run halts.

### 5.3 Policy ladder

1. `transient` ⇒ mechanical re-run up to `retries:` times (zero tokens). Budget exhausted ⇒ continue down the ladder as class `transient`.
2. `env` ⇒ **halt** (an agent fallback would only waste tokens on a broken machine).
3. Everything else ⇒ per `on-failure`:
   - **`halt` (default)** — the run halts with a clear `halt_reason` (`script step <id> failed (<class>): <detail>`). The right choice for **mutating** steps (push / merge / release). Feedback is already written, so the retrospective → improver → script-creator (`mode: repair-script`) fixes the script; the human resumes with `pipeline next --resume --start <same step>`.
   - **`agent`** — the engine re-dispatches the SAME step as an agent-type `run-step` whose `steps[0]` carries `fallback: 'script-failure'` + `failure_record: <abs path>`. A normal step-executor achieves the iteration's Goal **manually** (the markdown body IS the fallback spec), returns a NORMAL step record (the chain continues), does NOT edit the script, and emits an `improvement_brief` → Tier-1 → a `script_creation_brief` with `mode: repair-script` fixes the script between steps.

### 5.4 Bounds

- **Fallback agent:** once per step per run (`state.fallback_attempted`); if the fallback itself fails ⇒ normal halt path.
- **Repair:** once per step's script per run (`state.repaired_steps`); a second failure of the same script after an in-run repair ⇒ halt.
- `retries:` apply to class `transient` only.
- v1: `on-failure: agent` inside a **parallel** layer degrades to `halt` (parallel fallback folding is v2).

---

## 6. The outputs store (dataflow)

- Every step's `output` object is persisted by the command layer to `<pipeline_root>/.runtime/<run-id>/outputs/<step_id>.json` (loop-back executions overwrite — latest wins). **Persist cap 64 KB** (`OUTPUT_PERSIST_CAP_BYTES`): an oversized output logs a warning and is **NOT** persisted, so downstream bindings to it fail as `binding` with a clear message.
- **Script steps:** `output` comes from the stdout JSON. **Agent steps:** an optional additive `output` field on the step record.
- **Consumers:** a script step reads its inputs via `${steps.<id>.output.<path>}` params (§2.2); an agent iteration references the file path in its `Inputs` section (`Read <pipeline_root>/.runtime/<run-id>/outputs/<step_id>.json`).

---

## 7. Timeouts & the call budget

The manager reaches `pipeline next` through a Bash call capped at 10 minutes, and in-process scripts run **inside** that call. To prevent deadline inversion:

- **Constants** (in `lib/script-types.ts`): `DEFAULT_SCRIPT_TIMEOUT_S = 600`, `CALL_BUDGET_MS = 480_000` (8 min soft), `SAFETY_MARGIN_MS = 45_000`, `MANAGER_SAFE_TIMEOUT_S = 420`, `MAX_SCRIPT_EXECS_PER_CALL = 200`.
- **Effective deadline** = `min(step.timeout, remaining_call_budget − margin)`. The CLI always kills the script itself (tree-kill), classifies the kill as `transient`, and still has time to write records/state before the outer Bash ceiling.
- **The `continue` action.** Before starting a script that does not fit the remaining budget, the CLI persists state and returns `{action:'continue'}`. The caller performs **nothing** and immediately calls `pipeline next … --record '{"kind":"continue"}'` in a fresh Bash window. Chains of script steps therefore span any number of calls. (The record keeps the loop protocol uniform; a bare no-record call would collide with the auto-resume re-entry semantics.)
- A single script whose `timeout` exceeds `MANAGER_SAFE_TIMEOUT_S` on a `runner: manager` pipeline ⇒ plan **WARNING** ("use `runner: headless` or split"). `pipeline drive` runs with an **infinite** call budget (no outer ceiling), so budget-fit `continue` never fires there — only the `MAX_SCRIPT_EXECS_PER_CALL` execution cap can still yield one, and drive answers it itself with `{"kind":"continue"}`.
- **Manager rule:** always invoke `pipeline next` with Bash `timeout: 600000`.

---

## 8. Idempotency & the attempt ledger

Script conventions require idempotency because the CLI protects side-effectful scripts from re-execution when a crash/kill lands between script success and state persistence:

- **Before spawn:** write `<pipeline_root>/.runtime/<run-id>/ledger/<step_id>-<dispatch_index>.json` `{phase:'started', …}`. **After success:** persist the output file (§6), then flip the ledger entry to `{phase:'finished', record:<synthesized record>}`.
- **On (re-)dispatch** the CLI first checks the ledger for the SAME `(step_id, dispatch_index)`: `finished` ⇒ reuse the stored record/output, **do not re-execute**; `started` ⇒ the previous attempt died mid-flight ⇒ re-execute (hence the idempotency requirement).
- Keying by `(step_id, dispatch_index)` is load-bearing: a graph loop-back re-runs the same `step_id` as a **new** dispatch index ⇒ a new execution, never a stale reuse.

Covers Bash-timeout kills, UI STOP, a manager crash, and machine death.

---

## 9. Parallel / DAG rules (v1)

- Script steps MAY be members of DAG layers. The command layer **partitions** a concurrent layer: script members run in-process **first** (their results held in `state.partial_layer_results`), then the `run-step` action returned to the caller contains ONLY the agent members. When the caller records the layer, the CLI folds partial + recorded results. An all-script layer is fully self-fed (the caller sees only the next real action).
- Script steps in a parallel layer run **in place** — no worktree, no merge entry. Disjoint-footprint discipline is the designer's job (as today).
- `on-failure: agent` in a parallel layer ⇒ treated as `halt` (v1).

---

## 10. Secrets

Secrets **never** travel through params or outputs. Scripts inherit the process environment and read secrets **directly** (`os.environ` / `process.env`). `${env.…}` bindings are for **non-secret** values only; the §2.3 lint warns on secret-looking names. Failure-record stderr tails are redaction-best-effort (a documented limitation — do not print secrets to stderr).

---

## 11. Observability (brief)

Script steps surface additively: `iteration.started` / `iteration.completed` events carry an optional `step_type: "script"`, and `iteration.completed` carries an optional `failure_class`. The run record gains `llm_steps` (count of agent-type steps executed) — a finished run with `llm_steps: 0` finalizes its `tokens` as true zeros. Script failures appear in the run `.log` beside tool fails, so `/pipeline:optimize` sees which scripts are flaky, how often the fallback fired, and what it cost. Full details live in `apps/pipeline-ui/EVENTS.md` and `docs/cli.md`.

---

## 12. Testing a script step — `pipeline step run`

Test a script step **without a full run**:

```
pipeline step run <iteration.md> [--param k=v …] [--var NAME=value …] [--vars-file <path>] [--json]
```

It resolves params (statics / defaults; a `${steps.…}` reference REQUIRES a `--param` override, else exit 2 with a clear message), executes the script exactly as the runtime would (same env / cwd / timeout machinery), and prints the result plus the would-be step record. It **never touches any run state** — no records, no ledger, no outputs store. `--var`/`--vars-file` (§2.5) resolve the pipeline's declared `PP_*` variables and substitute them into `command:`/`script:`/`## Params` exactly like a real run, but EPHEMERALLY — nothing freezes or persists.

Exit codes:

- **`0`** — the script executed and returned `ok:true`.
- **`1`** — the script executed but failed (`ok:false`, or a failure class such as `crash` / `contract`).
- **`2`** — usage error: bad arguments, or a `${steps.…}` binding (or an unresolved/undeclared `${PP_*}` variable) with no resolvable value and no `--param`/`--var` override.

**`--manual-scripts`** on `pipeline next` (mirrors `--manual-hooks`) returns raw script-step `run-step` actions to the caller instead of executing them in-process — debugging only; the caller records the step record itself.

---

## 13. Lockstep

Change these together (full chain in `roadmap/script-steps/DESIGN.md` §15): `lib/plan.ts` ↔ `lib/script-types.ts` / `lib/script-step.ts` ↔ `lib/substitution.ts` / `lib/run-vars.ts` (the `${PP_*}` engine + run-init plumbing, §2.5) ↔ `lib/next.ts` ↔ `commands/next.ts` ↔ `lib/step-schema.ts` ↔ `EVENTS.md` / `web/src/types.ts` / `logs.ts` / `stats.ts` ↔ the agent docs (designer / script-creator / improver / manager / step-executor) ↔ `README.md` / `docs/cli.md` / this file. The pure engine (`lib/next.ts`) never touches the filesystem or spawns processes — execution lives in the command layer / `script-step.ts`. Scripts inherit the sandbox/permission envelope of the Bash call that runs `pipeline next` — the same trust boundary as worktree hooks (consumer-authored code in the consumer project); allowlist accordingly.

## 14. Out of scope (v2)

Detached execution + polling for single scripts longer than the manager window; parallel-layer agent fallback; `secret: true` param transport; full JSON Schema validation; UI editor scaffolding for script steps.
