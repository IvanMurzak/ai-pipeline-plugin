# The event journal — schema

Append-only JSON-lines journal at `<project>/.pipeline/.runtime/events.jsonl`. Every event is one line, one JSON object. Schema version: `5`.

> Formerly `apps/pipeline-ui/EVENTS.md`. The journal was built for the local
> dashboard, which is deleted (plugin-thin `01-remove-local-ui.md`) — **the
> journal itself is not going anywhere.** It is what `pipeline logs` renders and
> what `ux-v2`'s telemetry outbox / uploader drain to the cloud, so this
> contract is as load-bearing as it ever was. Where the prose below still says
> "the daemon", read it as "a reader of this journal": the rule is about what a
> reader must tolerate, and it survived its first reader.

## Versioning policy

A reader must parse v1, v2, v3, v4, and v5 events. v1 events lack the `terminal` field on `iteration.completed` and have no `iteration.resumed`; v2 events lack the v3 model-resolution fields (`default_model` on `pipeline.started`, `resolved_model` on `iteration.started`); v3 events lack the v4 DAG step-identity field. The fold derives the missing terminal signal from `next_iteration_path: null` for v1, and treats the v3/v4/v5 fields as optional — absent fields read as `null`. **Backward-compat is load-bearing: a v5 reader MUST parse v1/v2/v3/v4 journals exactly as before.** When you bump the schema again, keep readers backward-compatible for one version (so a reader at vN parses vN-1 cleanly) — same hard invariant the project's CLAUDE.md enforces.

### v5 — `step_id` → `step_name` (the one non-additive change)

Every earlier version bump was additive, and every *purely* additive change since (`resolved_effort`, `step_type`, `resumed`, the `run.*` / `worktree.*` / `awaiting_input` event types) deliberately did **not** bump the stamp. v5 is different: it **renames** the step-identity field on `iteration.started`, `iteration.resumed`, `iteration.completed`, and `awaiting_input` from `step_id` to `step_name`.

The rename follows pipeline v2's central decision — *a step is not a file; it is an entry in `pipeline.yml` identified by `name:`* — so the journal calls the step by the same thing the manifest does.

Rules:

- **Emitters write `step_name` only.** They never write `step_id` again. The emission *conditions* are unchanged: only a concurrent layer names its steps, so a sequential/graph dispatch still omits the field entirely.
- **Readers MUST fold `step_name ?? step_id`.** Journals already on disk carry `step_id`; dropping the fallback would silently reattribute every analytic already computed from them (per-step tool/token stats, wall-clock timings, the iteration tree's DAG rows). This fallback is not a convenience — it is the vN/vN-1 invariant above, applied.
- **Absent-both is still meaningful** and unchanged: it selects the legacy consecutive-`iteration.started`-window fold (see §Analytics folds).

Deliberately NOT renamed, for reasons that outlive the rename:

- **`question_id`'s `gate:<run_id>:<step_id>` format** — the value is the step name, but changing the *format* loses already-parked approval gates, which correlate the cloud answer round-trip on the exact string.
- **`.stats` records** — an internal store with accumulated history, not a published contract; renaming breaks reading what is already on disk.
- **The daemon's HTTP surfaces** (`/api/run-steps`, `/api/run-step-stats`, `/api/pipelines`) and the engine's `Plan` still say `step_id`. Those move with the engine's identity change, not with the event schema.

**Emitter change in plugin 0.54.0 (NO schema bump — stays v4).** The main-loop per-iteration events (`iteration.started` / `iteration.completed`, Tier-1 `improver.*` / `script_creator.*`) and the external-isolation `worktree.created` / `worktree.destroyed` are now auto-emitted **in-process by the `pipeline next` CLI** (from its actions, its `--record` payloads, and the worktree hooks it executes itself) instead of by the `pipeline-manager` shelling out to `pipeline event`. The manager still emits the retrospective's `improver.*` / `script_creator.*` (the CLI cannot see those spawns), and the supervisor still owns `pipeline.*` / liveness / mirror bindings. Shapes, envelope, and field semantics are UNCHANGED — an additive emitter change only; journals written by older plugin versions parse identically.

## Common envelope

```jsonc
{
  "schema": 5,
  "ts": "2026-05-21T18:42:11.342Z",   // ISO-8601 UTC
  "type": "<event-type>",
  "project_root": "/abs/path/to/project",
  "worktree": "/abs/path/to/worktree-or-null",
  "run_id": "<ulid-or-short-uuid>",   // groups all events for one /pipeline:run chain
  "parent_run_id": null,              // set when this is a blocker-child run
  "session_id": "<claude-session-id>",
  "data": { /* per-type payload, see below */ }
}
```

## Event types

| `type` | When | `data`-shape |
|---|---|---|
| `session.opened` | SessionStart hook fires | `{ claude_pid }` |
| `pipeline.started` | `/pipeline:run` step 3 | `{ pipeline_name, first_iteration_path, pipeline_root, default_model?: ModelValue\|null }` |
| `iteration.started` | `pipeline next` (CLI, auto-emitted in-process before printing a `run-step` action) | `{ iteration_path, index, resolved_model?: ModelValue\|null, step_name?: string, step_type?: "script", step_uuid?: string }` |
| `iteration.resumed` | `/api/chat/resume` re-attaches an SDK session | `{ iteration_path, index, resolved_model?: ModelValue\|null, step_name?: string }` |
| `iteration.completed` | `pipeline next` (CLI, derived from the incoming step/layer `--record`) | `{ iteration_path, outcome, next_iteration_path \| null, has_improvement_brief, has_blocker_delegation, halt_reason \| null, terminal: bool, step_name?: string, step_type?: "script", failure_class?: string, step_uuid?: string }` |
| `improver.started` | `pipeline next` around a Tier-1 `run-improver` action; the `pipeline-manager` (shelling out to `pipeline event`) or `pipeline drive` (in-process) emits it directly for the retrospective's batch pass | `{ iteration_path, step_uuid?: string }` |
| `improver.completed` | `pipeline next` from the improver `--record`; manager- or drive-emitted in the retrospective | `{ iteration_path, applied: boolean, has_script_brief: boolean, step_uuid?: string }` |
| `script_creator.started` | `pipeline next` around a Tier-1 `run-script-creator` action; manager- or drive-emitted in the retrospective | `{ iteration_path, step_uuid?: string }` |
| `script_creator.completed` | `pipeline next` from the script `--record` (carries its `script_path`); manager- or drive-emitted in the retrospective | `{ iteration_path, script_path \| null, outcome: "created" \| "updated" \| "refused", step_uuid?: string }` |
| `blocker.delegated` | issue filed + child spawned | `{ parent_iteration_path, blocker_issue_url, child_run_id, blocker_target_repo }` |
| `blocker.polling` | each poll tick | `{ blocker_issue_url, pr_state }` |
| `blocker.resolved` | merge succeeded | `{ blocker_issue_url, merged_pr_url }` |
| `pipeline.completed` | terminal iteration ran cleanly | `{ pipeline_name }` |
| `pipeline.halted` | chain halted | `{ pipeline_name, iteration_path, halt_reason }` |
| `manager.stopped` | SubagentStop hook when a `pipeline-manager` subagent ends | `{ run_id, agent_id \| null, step_uuid? }` |
| `worktree.created` | `pipeline next` after executing the consumer's create hook in-process (external isolation, run start) | `{ worktree_path, branch, env_file \| null, port_base \| null, ok: bool, hook_dir }` |
| `worktree.finalized` | `pipeline next` after executing the consumer's MANDATORY finalize hook in-process (external isolation, opted-in, at the end of a COMPLETED run before teardown) | `{ worktree_path \| null, ok: bool, outcome, detail \| null }` |
| `worktree.destroyed` | `pipeline next` after executing the consumer's destroy hook in-process (external isolation, run end) | `{ worktree_path \| null, ok: bool, outcome, detail \| null }` |
| `tool.called` | PostToolUse hook after every tool call | `{ tool_name, success, agent_spawn, tool_use_id, step_uuid? }` |
| `turn.usage` | Stop hook (one per assistant Stop event, summed across new transcript turns) | `{ assistant_turns, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, step_uuid? }` |
| `awaiting_input` | `pipeline drive` at EVERY needs-input park (agent-step question AND approval gate; repeat parks re-emit) | `{ run_id, iteration, question_id, question: { text, context \| null, options \| null, question_id?, approval?: { required_role } }, step_name?, iteration_path? }` |
| `run.awaiting_input` | Notification hook, when a permission prompt or an input request blocks the session (see the disambiguation below — NOT the same as `awaiting_input`) | `{ kind: "permission" | "input", message_excerpt: string, step_uuid? }` |

### Envelope-level kv overrides on `pipeline event`

> The runtime event emitter is the `pipeline event` command (`apps/pipeline-cli/src/lib/event.ts`, run with Bun). Everything below describes its semantics.

The skill (`/pipeline:run`) passes `run_id`, `parent_run_id`, and `session_id` as **k=v arguments** on every `pipeline event` call, rather than relying on environment variables. Claude Code's Bash tool does not preserve shell state across invocations: a `export PIPELINE_RUN_ID=…` in one Bash call is gone by the next Bash call's `pipeline event …`, which would stamp `run_id: null` on every event after the first and silently drop the run from the UI's fold (events with `run_id: null` are not folded into the run forest).

`pipeline event` pops these three names out of the kv payload and uses them as envelope fields:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/apps/pipeline-cli/src/cli.ts" event iteration.started \
    run_id=abc123def456 \
    iteration_path=/abs/path/to/02-foo.md \
    index=2
```

The envelope ends up as `{run_id: "abc123def456", parent_run_id: null, session_id: null, data: {iteration_path: …, index: 2}}`. The env vars (`PIPELINE_RUN_ID` etc.) remain a defensive fallback for the rare case where the override is absent. The names `run_id` / `parent_run_id` / `session_id` are therefore **reserved** in the kv namespace — do not use them as data-field names on events.

### Emission sources for lifecycle events (`pipeline.started` → `pipeline.completed`/`halted`)

The RUN ANCHOR is the **`pipeline-manager`** (Phase 2). Three call paths produce a pipeline run, and each owns lifecycle emission:

1. **`/pipeline:run` (supervisor, main session) + the `pipeline-manager` it spawns (depth 1)** — the canonical emitters. The supervisor emits the run-level lifecycle (`pipeline.started` / `pipeline.completed` / `halted`) and owns the liveness lockfile + mirror binding; the per-iteration events (`iteration.*`, `improver.*`, `script_creator.*`, `worktree.*`) are auto-emitted in-process by the `pipeline next` CLI as the manager drives it (the manager itself emits only the retrospective's `improver.*` / `script_creator.*` via `pipeline event`, passing the supervisor's `run_id` literally). The per-step worker (`step-executor`, formerly `pipeline-executor`) runs at depth 2. All share one `session_id`, so hook-emitted `tool.called` / `turn.usage` still correlate to the run through the binding.
2. **`pipeline drive`** — the headless driver emits the same run-level and per-iteration events from its own process (see `commands/drive.ts`). *(This slot used to be the deleted dashboard's `POST /api/chat`; "Path A" in older prose means that endpoint and no longer exists.)*
3. **Direct `Agent({subagent_type: "pipeline-manager"…})` from a terminal session ("Path C")** — uninstrumented run; nothing in the spawn chain knows it should emit the run-level lifecycle. The hooks (`analytics-relay.ts`) close this gap by SPLITTING **RUN-LEVEL** synthesis across the two hook ticks so the run shows as **active while the manager is in-flight**, not only after it finishes:
   - **`PreToolUse`** (fires before the manager `Agent`/`Task` runs): emits the **START half** — `pipeline.started` ONLY.
   - **`PostToolUse`** (fires when the manager Agent returns): emits the **END half** — `pipeline.completed`/`halted` ONLY.

   **No `iteration.*` is synthesized** — the `pipeline next` CLI the manager drives auto-emits the per-iteration events. Both halves use the **same run_id** — a deterministic UUIDv5 derivation of `tool_use_id` (`bypassRunIdFromToolUseId` → `hookIdFromToolUseId`, `apps/pipeline-cli/src/lib/ids.ts`; never `newId()` — see that file's header for why it must stay derived, not minted), so they describe a single run; the manager-spawn's own `tool.called` is stamped with it too. The manager `subagent_type` is matched (bare or marketplace-namespaced) by `^(?:[a-z0-9_-]+:)?pipeline-manager$`. Path B (supervisor-owned) is discriminated by (1) the literal `run_id = …` line the supervisor writes into the manager prompt, and (2) failing that, scanning the journal for a recent `pipeline.started` / `iteration.started` on the same iteration path whose run_id **differs** from this spawn's tool_use_id-derived id — if an owning run resolves, the hooks stay silent on lifecycle (the supervisor owns it). When `PreToolUse` never ran (older Claude Code, missing `tool_use_id`, or a cwd not yet recognized as a pipeline project at spawn time), `PostToolUse` falls back to emitting both run-level events at once (`synthesizeBypassRun`); it detects the split-vs-fallback case with `journalHasPipelineStarted(runId)`. Outcome is derived from `tool_response.is_error`; `default_model` is always `null` (the hook doesn't read `PIPELINE.md`).

   **The WORKER (`step-executor`, or legacy `pipeline-executor`) spawn is NOT a run anchor.** It is matched by `^(?:[a-z0-9_-]+:)?(?:step-executor|pipeline-executor(?:-(haiku|sonnet|opus))?)$` (the legacy name + its removed per-tier suffix are still tolerated for in-flight/forked runs) and only gets a **mirror binding** attributed to the owning run (so the UI shows the step work). The hooks never synthesize a run for a worker spawn — in Path B the supervisor emitted `pipeline.started` and `pipeline next` emitted `iteration.started` when it handed the manager the `run-step`, so the run already exists. The hook mirror-binds BOTH the manager transcript (orchestration) and the worker transcript (step work).

   **Dead-run signals.** The **primary** liveness signal is event-driven: `manager.stopped` (see below). A Path-B run also writes a `<runtime>/runs/<run_id>.alive` liveness lockfile (secondary fallback). A Path-C run writes no lockfile, so if its driving session is killed *between* the START and END halves AND no `manager.stopped` fires (hard kill), nothing marks it terminal. See "Dead-run signals" below for what does and does not consume these today.

   **Ownership proof (Path B vs Path C discrimination).** Beyond the literal `run_id = …` line in the manager prompt, the hooks scan the journal tail for ownership proof of the spawn's `iteration_path`. TWO event types count as proof:
   - `pipeline.started.first_iteration_path === iterationPath` — covers the chain's FIRST iteration.
   - `iteration.started.iteration_path === iterationPath` (and the analogous `iteration.resumed`) — covers iterations 2..N.

   The match function is `findChainControllerRunId` in `<cli>/src/hooks/analytics-relay.ts`; it requires the matching event to carry a non-empty `run_id`.

### `iteration.completed.terminal` (v2)

Set to `true` for the last iteration in a chain — including the case where `/pipeline:run` ends the chain with `next_iteration.file: PIPELINE_COMPLETE` and the case where `/api/chat` finishes a single-iteration chat run. The client uses this signal to flip the run's status to `completed` even if `pipeline.completed` is never emitted (e.g. the chain controller's turn was cut off). Treat it as a belt-and-suspenders termination marker, not a replacement for `pipeline.completed`.

### `iteration.resumed` (v2)

Emitted by the daemon when `/api/chat/resume` reattaches an existing SDK session. Distinguished from `iteration.started` so per-iteration `started_count` rollups don't double-count a resume as a fresh attempt. The client fold treats both events identically for status/current-step tracking.

### `ModelValue` — the model field value space (v3, widened)

`default_model` and `resolved_model` share one value space, written `ModelValue` above:

- one of the friendly aliases **`"haiku" | "sonnet" | "opus" | "fable"`**, OR
- a canonical Anthropic model id — any string starting with **`claude-`** (e.g. `"claude-opus-4-8"`, `"claude-sonnet-4-6"`, `"claude-fable-5"`), passed through verbatim, OR
- **`null`** (no `model:` set, an `inherit`/absent value, or an unrecognized non-`claude-*` value — the daemon warns once via `console.warn` for the last case; see `resolveStepModel` in `lib.ts`).

This is a deliberate WIDENING of the v3 value space (originally `"haiku"|"sonnet"|"opus"|null`) to support the `fable` alias and exact canonical ids. **It is NOT a `SCHEMA_VERSION` bump** — it only widens the accepted values of an existing OPTIONAL string field; the on-the-wire shape (an optional string-or-null on the same events) is unchanged, so v1–v4 readers parse it without modification. The daemon stores/displays whatever string arrives and **never coerces a valid canonical id to `null`** (an unknown canonical id renders with a neutral badge rather than vanishing). v1 and v2 events omit the field entirely; readers treat absent as `null`.

### `pipeline.started.default_model` (v3)

Optional `ModelValue` (see above) reflecting the `model:` field in the pipeline's `PIPELINE.md` frontmatter. `null` when the manifest has no frontmatter, no `model` key, `model: inherit`, or an unrecognized non-`claude-*` value. v1 and v2 events omit this field; readers should treat absent as `null`.

This is the **pipeline-level default** — the value an iteration will inherit when it has no `model:` of its own. It does NOT promise that every iteration ran on this model: a per-step frontmatter wins via `resolveStepModel`, and the UI-side `body.model` override wins over both.

### `iteration.started.resolved_model` and `iteration.resumed.resolved_model` (v3)

Optional `ModelValue` (see above) reflecting the **effective model** for this iteration after applying `step ?? pipeline ?? null`. `null` means neither side specified (or both said `inherit`), so the SDK fell back to the session default — readers should not display "unknown" for null; display "session default" or omit the badge entirely.

Both `iteration.started` and `iteration.resumed` carry the field: a resume may pick a different tier than the original start if the user changed `body.model` or edited step frontmatter between the original call and the resume. The client fold honors whichever event was most recent.

Source of truth:
- Daemon-emitted iterations (`/api/chat` and `/api/chat/resume`): the daemon parses the step file's frontmatter + the pipeline manifest's frontmatter and stamps the resolved value here. An alias and a canonical id are both honored; an explicit `body.model` override that is a canonical id is stamped verbatim, one that is an alias is stamped as its shorthand; `inherit`/unknown non-`claude-*` overrides yield `null`.
- `/pipeline:run`-driven iterations: `pipeline next` computed each step's effective model itself, so it stamps `resolved_model=<alias-or-canonical-id-or-null>` on the `iteration.started` events it auto-emits.

v1 and v2 events omit this field; readers should treat absent as `null`.

### `iteration.started.resolved_effort` (0.69 — values-only addition, schema stays 4)

Optional string reflecting the **effective reasoning effort** for the iteration after applying the same ladder as the model (`per-run --effort override ?? step effort: ?? pipeline effort: ?? null`). Value space: `low` | `medium` | `high` | `xhigh` | `max`; `null`/absent = inherited (the session's effort level — display "session default" or omit the badge). Stamped by the `pipeline next` auto-emitter alongside `resolved_model`. Pre-0.69 writers omit it; readers treat absent as `null`. This is an additive optional field on an existing event — NOT a schema bump (same policy as the v3→v4 value-space widenings: every old reader parses unchanged).

### `iteration.started.step_name`, `iteration.resumed.step_name`, `iteration.completed.step_name` (v5 — DAG / parallel; `step_id` in v4)

Optional kebab-case string identifying the pipeline **step** an iteration event belongs to. Emitted (by the `pipeline next` CLI since plugin 0.54.0; previously by the `pipeline-manager`) **only for Parallel / DAG runs** (triggered by `execution: parallel` OR a step declaring dependencies). In ordinary **sequential** runs the field is OMITTED entirely — and the daemon/web fold falls back to its legacy consecutive-`iteration.started`-window behavior, so every pre-v4 journal and every sequential run behaves exactly as before. v1/v2/v3 events never carry it; v4 events carry it under the old name `step_id`. Readers resolve it as **`step_name ?? step_id`** and treat absent-both as "no step name → use the window heuristic".

**Why it exists — overlap-safe folding.** In Parallel / DAG mode the manager spawns a whole "ready set" of steps CONCURRENTLY (one `step-executor` per step, each in its own git worktree) and their `iteration.started` … `iteration.completed` windows OVERLAP. The pre-v4 per-iteration analytics fold attributed ambient telemetry (`tool.called`, `turn.usage`) to the window between two CONSECUTIVE `iteration.started` events — which silently mis-attributes everything once windows overlap (a later sibling's `iteration.started` would "close" an earlier, still-running step). With the step name present, the fold instead keys each step's window by that name: the window is the half-open interval `[iteration.started, iteration.completed)` for that step, and an ambient event during overlap is attributed to the **most-recently-started still-open step** (LIFO). When windows don't actually overlap (sequential, or a parallel pipeline that happens to serialize), the result is identical to the legacy window heuristic. The reference fold was `iterationToolStatsForRun`, which lived in the deleted dashboard in two mirrored copies (server + web); the rule is stated here because it is a property of the JOURNAL, and any new reader must implement it; `iterationStatsByRel` additionally surfaces the step name on each iteration-tree row.

**Parallel emission pattern.** For a ready set `{A, B, C}` the `pipeline next` CLI emits `iteration.started{step_name:A}`, `iteration.started{step_name:B}`, `iteration.started{step_name:C}` (one per step, each carrying its own name) as it hands the manager the concurrent `run-step`; the manager spawns all three concurrently, and the CLI emits `iteration.completed{step_name:…}` per step from the layer `--record`. Each step's `tool.called` / `turn.usage` (correlated by the shared `run_id`) lands in that step's bucket via the LIFO-open-window rule. The hooks do NOT set the step name — they never synthesize `iteration.*`; only the pipeline-next emitter does.

### `iteration.started.step_type`, `iteration.completed.step_type` + `iteration.completed.failure_class` (0.71 — script steps, values-only, schema stays 4)

Two optional fields marking a `type: script` step — the zero-token
deterministic steps the `pipeline next` CLI executes in-process (see
`docs/script-steps.md`; `roadmap/script-steps/DESIGN.md` §12):

- **`step_type: "script"`** on `iteration.started` / `iteration.completed` —
  present ONLY for a script-type dispatch; **absent means an ordinary agent
  step** (the default). It is keyed on the DISPATCH type, so a §6.3 fallback (an
  agent re-dispatch of a script step that failed with `on-failure: agent`) is an
  agent step and carries **no** `step_type`. `iteration.resumed` never carries
  it — script steps run in-process and are never resumed.
- **`failure_class`** on `iteration.completed` — one of
  `transient | binding | env | crash | contract | bug` when a script execution
  failed; **absent on success and on every agent step.**

This is a **values-only addition — NOT a `SCHEMA_VERSION` bump** (same precedent
as the step-identity field in v4 and `resolved_effort` in 0.69): two new OPTIONAL `data`
fields on existing event types, no new type and no shape change. Pre-0.71
writers omit them; readers treat absent as "agent step / no failure". A v4
daemon parses a journal containing these fields unchanged (unknown `data` fields
are ignored), and a 0.71 emitter's journal for an all-agent run is byte-for-byte
the old shape. Only the in-process script executor sets them — never the daemon,
never the hooks, never the fallback re-dispatch. The web `EventType` union is
unaffected (these are `data` fields, and `PipelineEvent.data` is an untyped
bag); `web/src/types.ts` mirrors the value literals (`STEP_TYPE_SCRIPT`,
`FAILURE_CLASSES`) for TS-consumer honesty + lockstep with the CLI's frozen
`FailureClass`. The `pipeline logs` tail renders a `[script]` tag and the
failure class; the per-run stats fold counts the untagged `step.started` lines
as `llm_steps` and finalizes a zero-`llm_steps` run's tokens as true zeros.

### `awaiting_input` + `iteration.started.resumed` (e7 remediation — additive, schema stays 4)

Two additive changes closing the parked-run observability gap (e7 DEFECT-3 —
before this, a `pipeline drive` needs-input park left NO journal signal at all
and a cloud-dispatched parked run looked `running` server-side):

- **New event `awaiting_input`** — journalled by `pipeline drive` at EVERY
  exit-4 park: an agent step reporting `outcome: "needs-input"` AND a
  deterministic approval gate (`type: gate`), including repeat parks (a
  `--resume` re-entry without `--answer` re-emits it, restoring the parked
  state after the re-entry's `iteration.started` un-parked it server-side).
  `data` shape is the `@baizor/pipeline-protocol` `AwaitingInputData` contract
  the control plane's runs-ingest consumes to set the run's parked status:
  `{ run_id, iteration, question_id, question: {text, context, options,
  question_id?, approval?} }` — REQUIRED fields exactly as listed (the
  runner's metadata-tier privacy filter allowlists precisely those four, and
  the ingest's strict parse rejects a missing `question_id`/`question.text`).
  `iteration` is the parked dispatch's `iteration.started.index`. `step_name`
  (v5; `step_id` on v4 journals) + `iteration_path` ride along additively.
  Gate parks use the deterministic
  `question_id` `gate:<run_id>:<step_id>` — the FORMAT keeps its old spelling
  on purpose (renaming it would orphan already-parked gates), and the value in
  that slot is the step's name (no claude session exists to pin
  one to; stable across re-entries so answer correlation never breaks);
  agent parks mint a UUID at park time and persist it in the step's session
  file. The envelope `session_id` is the parked executor session (null for
  gates). Emitted via the structured-data journal writer
  (`lib/event.ts emitEventJson` — the kv interface cannot carry the nested
  `question` object). Contract suite:
  `apps/pipeline-cli/tests/awaiting-input-contract.test.ts`.
- **`resumed: true` on `iteration.started`** (optional, absent = fresh) — set
  by the `pipeline next` CLI when a `--resume`/auto-resume re-entry RE-ISSUES
  the step the run was parked on (needs-input answer delivery, crash
  re-spawn, blocked resume). Protocol v5 G5: it is what lets the cloud ingest
  distinguish a resume (settle the parked attempt, open the next) from a
  fresh first dispatch — and its arrival is the un-park signal. A fresh step
  dispatched later in the same re-entered process is never tagged.

Values-only addition — NOT a `SCHEMA_VERSION` bump (same precedent as v4's
step-identity field / 0.69 `resolved_effort` / 0.71 `step_type`): one new event type old
consumers ignore (the daemon tolerates unknown types) plus one optional `data`
field. Journals from older emitters parse identically.

### `step_uuid` on `iteration.started`/`.completed`, `improver.started`/`.completed`, `script_creator.started`/`.completed` (ux-v2 b4 — values-only addition, schema stays 5)

One new optional `data` field, on every event a **client-started** step class
emits: iteration steps, `improver:*`, and `script_creator:*` (the retrospective's
batch spawns included). A UUIDv7 row identity for **this one execution**,
minted once at step start and carried unchanged onto that same execution's
terminal event — distinct from `step_name`/`step_id` (the step_key
*dimension*, which groups the same step across DIFFERENT runs and is
completely unaffected by this addition). A re-run of the same step — a retry,
a §6.3 fallback re-dispatch, a fresh graph loop-back, or simply a second
invocation of the pipeline — mints a NEW `step_uuid` even though `step_name`/
`step_id` stays identical; an idempotent re-emission of a dispatch already in
flight (§7 `continue`, a crash re-entry) reuses the SAME one, since nothing
executed a second time. The identical value also rides the paired
`.stats/<pipeline>/runs.jsonl` `StepStat.step_uuid` (additive there too,
alongside the unchanged `StepStat.id`), so the two independent reporting
paths — the live event stream and the end-of-run stats fold — name one
execution once (`02-target-architecture.md` D15; the server-side ingest
migration that stops writing two rows per step is `c2-step-uuid-migration`,
downstream of this addition, not part of it).

Absent means "recorded before this addition" (the same event-shape fallback
every other values-only field here uses) — never treated as a second
identity or backfilled. `manager` and `step:path:*`, the two step classes the
SERVER derives rather than observes, carry no client event and therefore no
`step_uuid` here; the server assigns them a UUIDv5 derived from the run UUID
on its own side.

### Dead-run protection — third trigger: the interrupt watchdog (observability a3)

A user-pressed **Esc** fires no hook at all. If the terminal session process
stays alive, the `.alive` lockfile still names a live pid and `manager.stopped`
never arrives — so both existing triggers miss it and the run renders `running`
forever. `sweepInterruptedRuns` (server.ts, wired at the same two sweep sites as
the other two) probes the transcript of any non-terminal run that has been
silent for `WATCHDOG_QUIET_MS` (30 s) and emits the same abandonment
`pipeline.halted` the others do, plus `interrupt_ts`:

```json
{ "type": "pipeline.halted",
  "data": { "abandoned": true, "interrupt_ts": "...",
            "halt_reason": "interrupted by user (Esc) — no terminal event" } }
```

Detection (`detectPendingInterrupt`, transcript-stats.ts) takes EITHER signal —
a `[Request interrupted by user` marker or an `interruptedMessageId` field — and
calls it PENDING only when the newest interrupt is at-or-after the newest
activity, comparing timestamps **on the transcript's own clock**; daemon
wall-clock never enters the comparison, so clock skew between the writing
machine and the daemon cannot manufacture an interrupt. A resumed session
self-clears: its new output post-dates the interrupt. Historically gated by
`PIPELINE_UI_WATCHDOG_ENABLED`, inert when the transcript switch was off — but
that switch had zero live-code references after `p3` deleted the daemon that
read it (`sweepInterruptedRuns` lived in the now-gone `server.ts`), so
plugin-thin `p4` deleted the dead variable rather than renaming it. Accepted
gap: an Esc before any model output leaves no marker — an idle-timeout
heuristic would false-positive on long thinking phases.

### `run.awaiting_input` (observability a2 — new TYPE, schema stays 4)

Emitted by the **Notification hook** (`<cli>/src/hooks/analytics-relay.ts`) when Claude
Code tells us the session is blocked on a human: a permission prompt, or an
agent asking for input. Adding a new `type` is not a schema bump — same
precedent as `manager.stopped`; every consumer already ignores unknown types.

**Not the same event as `awaiting_input`.** That one is journalled by
`pipeline drive` at a headless needs-input PARK and carries the protocol's
`AwaitingInputData` (run_id, question_id, the question itself) so the control
plane can mark a dispatched run parked and route an answer back. This one is a
LOCAL, display-grade signal about the session hosting a manager-driven run —
it carries no question and nothing can answer it programmatically. Keep them
distinct: `awaiting_input` = the run is parked and resumable via `--answer`;
`run.awaiting_input` = a human is sitting in front of a prompt right now.

**No clearing event.** No "the user answered" hook signal exists, so WAITING is
DERIVED: `run.awaiting_input` raises the flag and ANY later event for the same
run clears it (resumed activity is the only signal that cannot lie). Both folds
implement exactly that rule — `web/src/lib/runs.ts` and the server-side
`RunSummaryFolder` in `lib.ts`. The flag is a DISPLAY state layered over
`running` (`RunState.awaiting_input`), deliberately kept out of the status
union so it never interacts with terminal logic, sweeps, or dismissal.

**Classification.** The payload's structured `notification_type` decides when
present (`permission_prompt` → `permission`, `agent_needs_input` → `input`,
everything else including `idle_prompt` → no event). It is frequently absent in
the wild (anthropics/claude-code#11964), so a deliberately narrow regex
fallback matches permission/waiting/approval phrasings and ignores idle
"finished responding" notifications. hooks.json registers the hook WITHOUT a
`notification_type` matcher on purpose — a matcher would silently drop every
event while that issue is open.

**Gating.** `PIPELINE_AWAITING_INPUT_ENABLED` (default ON), evaluated BEFORE
the `PIPELINE_JOURNAL_ENABLED` opt-out: a blocked run is worth surfacing through
`pipeline logs` (`⏸` line) even when no dashboard runs.

### `manager.stopped` (Phase 2 — agent-lifecycle liveness)

Emitted by the **SubagentStop** hook (`analytics-relay.ts`) when a
`pipeline-manager` subagent ends — the PRIMARY "the run's orchestrator is
gone" signal. Shape: `{ run_id, agent_id | null, step_uuid? }`. The `run_id` is
resolved
via the same session-keyed mirror-binding recovery the `tool.called` /
`turn.usage` events use (env → `active-mirror-bindings.jsonl` lookup), since
the manager shares the run's `session_id` across all nesting depths. A
SubagentStop for any OTHER agent type (`step-executor`, `pipeline-improver`,
…) is ignored — no `manager.stopped` is emitted.

This is a **new event TYPE, not a field change** — the schema version is NOT
bumped. The daemon tolerates unknown event types (the fold has no
status-mutating default case), so a daemon that predates this event parses a
journal containing `manager.stopped` cleanly, and a newer daemon parses an
older journal that has none. Backward-compat parsing is preserved.

The daemon consumes `manager.stopped` for **event-driven dead-run
detection** (`sweepManagerStoppedRuns` in `server.ts`): a run that has a
`pipeline.started` AND a `manager.stopped` but NO terminal
`pipeline.completed`/`halted` is abandoned, and the daemon emits a synthetic
`pipeline.halted` (`abandoned: true`, `halt_reason` mentioning the manager
stopped) so the existing fold flips it terminal. This coexists with — and
does NOT replace — the pid-lockfile sweep (`sweepProjectLiveness`), which
remains the secondary fallback. The event-driven sweep is **guarded by the
liveness lockfile**: if a `<run_id>.alive` lockfile still names a LIVE driving
process (the Path-B `/pipeline:run` supervisor during a nested-blocker
poll-wait, which legitimately stops and re-spawns the manager), the run is
NOT retired — only the supervisor's terminal event (or its death) ends it.

### `worktree.finalized` (external isolation — mandatory terminal finalize stage)

An **additive** event type emitted by the **`pipeline next` CLI** around the
consumer's **mandatory finalize hook** (`<hook_dir>/worktree-finalize.*`), which
runs at the very end of a **COMPLETED** external run — after the last step and
optional retrospective, and BEFORE teardown. The finalize stage is **opt-in and
GENERIC**: a pipeline enables it by shipping a `worktree-finalize.*` hook in the
resolved hook dir (the primary trigger) OR setting `finalize: true` in
`PIPELINE.md` frontmatter. It exists so a run cannot be marked `done` (and its
worktree cannot be torn down) until some project-defined terminal work has
succeeded. **The plugin has ZERO knowledge of WHAT finalize does** — committing
something, pushing, or anything else is entirely the consumer hook's business;
the plugin only requires the hook return `{"ok":true}`.

```
worktree.finalized data: { worktree_path|null, ok: bool, outcome, detail|null }
```

- `ok: true` → the run proceeds to teardown and `done`.
- `ok: false` (or a missing hook / non-zero exit / timeout / stdout without
  `{"ok":true}`) → **the run HALTS instead of reaching `done`.** The worktree is
  preserved: teardown still runs but with `outcome: "halted"`, the consumer's
  outcome-aware destroy hook's cue to keep the worktree so the un-finalized work
  is not reaped. A pipeline that opts OUT (no finalize hook, no `finalize: true`)
  never emits this event and is byte-for-byte unchanged.
- Like the other worktree events, this is a **new event TYPE, not a schema bump**
  (no bump of its own; the daemon tolerates unknown types via the status-fold's
  `default:` arm). The web `EventType` union adds the literal; the UI fold badge
  is optional (the event never mutates run status).

### `worktree.created` / `worktree.destroyed` (external isolation — run-level worktree lifecycle)

Two **additive** event types emitted by the **`pipeline next` CLI** (plugin
≥0.54.0; previously by the `pipeline-manager` — same shapes) when a run opts
into the **`external`** isolation mode (`PIPELINE.md` frontmatter
`isolation: external`). External mode is a **run-level, sequential-only** mode:
the consumer provisions ONE worktree per run (allocated ports, dev secrets, a
rendered `.env`, submodule worktrees — things the git-only `worktree`/`manual`
modes cannot supply) via convention-path hook scripts at
`<project>/.pipeline/.hooks/worktree-{create,destroy}`, shared by every
sequential step and torn down once at run end. The CLI executes those hooks
ITSELF, in-process — the create hook at run start (before the first step) and
the destroy hook at run end (on every terminal outcome —
`completed`/`halted`/`depth-exhausted` — but NOT on `blocked-delegating`) — and
emits these events around them.

```
worktree.created   data: { worktree_path, branch, env_file|null, port_base|null, ok: bool, hook_dir }
worktree.destroyed data: { worktree_path|null, ok: bool, outcome, detail|null }
```

- `worktree.created` is emitted **after the create hook returns successfully**
  (real `worktree_path`/`branch` known). On hook failure the CLI emits
  `worktree.created { ok: false, detail }` and the run halts.
- `worktree.destroyed` is emitted after the destroy hook returns (`ok: true`, or
  `ok: false` with a `detail` on a soft teardown failure — a teardown failure
  does NOT halt the run, it is logged and the run still terminates).
- **`external` only takes effect in sequential mode.** A pipeline that declares
  both `execution: parallel` and `isolation: external` degrades to
  `execution: parallel` + `isolation: manual` with a warning — no external
  worktree is created and neither `worktree.created` nor `worktree.destroyed` is
  emitted (parallel steps run in-place, exactly like `parallel+manual`).
- **Schema implication: NONE — no `SCHEMA_VERSION` bump of its own.**
  These are new event TYPES with all-optional `data` fields — the same
  precedent as `manager.stopped` (a new TYPE is not a bump; the daemon tolerates
  unknown types via the status-fold's `default:` arm, so a daemon that predates
  these events parses a journal containing `worktree.*` cleanly, and a newer
  daemon parses an older journal with none). The runtime emitter
  (`pipeline event`, `event.ts`) takes a plain string type, so emitting the two
  new types cannot fail a build. The web `EventType` union (`web/src/types.ts`)
  adds the two literals (mandatory for TS-build honesty + lockstep); the UI fold
  badge cases are OPTIONAL (the status switch has no `default:`, so omitting them
  still typechecks — neither event mutates run status).
- **UI value (optional fold):** the dashboard MAY surface "provisioned worktree
  on slot N (ports …)" at run start and "torn down" at end — a nice-to-have, not
  required for correctness.

## Analytics correlation

### Per-run analytics come from the TRANSCRIPTS, not the hook events (authoritative source)

Per-run tools / failures / agents / tokens are folded from the raw Claude Code **transcripts** — the manager's transcript plus every step-executor subagent transcript spawned in the run's time window — not from the hook events. This is the only COMPLETE source. Ground-truth validation against real runs showed the hook-emitted events undercount badly: `turn.usage` (Stop hook) tails the MAIN session transcript and never sees the subagent tokens where the bulk of a run's usage lives (so per-run tokens came out near-zero), and `tool.called` (PostToolUse) leaks roughly half its events to `run_id=null` through the fragile session→run binding correlation. The transcript fold reads the actual `usage` and `tool_use`/`tool_result` blocks, gated per-entry by the run's `[started_at, ended_at]` window (a session transcript hosts many runs over its life, so file membership alone is never trusted).

The live implementation is `apps/pipeline-cli/src/lib/step-transcripts.ts` over `lib/vendor/transcript-walk.ts` — the fold `pipeline drive` uses for its own headless runs and the one `pipeline logs --chat` reads. (Until plugin-thin `p3` a second copy of the same fold lived in the deleted dashboard daemon, served over HTTP; the vendored file's header records that lineage.)

### Hook-event correlation (legacy — still drives the per-iteration tree)

`tool.called` and `turn.usage` carry a `run_id` field — set by the `/pipeline:run` skill via the `PIPELINE_RUN_ID` env var, or recovered by the hooks via the session-keyed mirror-binding lookup. Events outside any pipeline run land in the journal as ambient telemetry, excluded from per-run aggregates. These events still feed the **per-iteration** tree breakdown (`IterationTree`/`StepDetail`), which has not yet been migrated to the transcript fold — so the per-iteration numbers remain subject to the undercount described above. (The per-RUN panel no longer uses them.)

**Step attribution on the driven path (ux-v2 b7).** When the resolved binding is one of `pipeline drive`'s pre-spawn records, the same lookup also yields the **step** UUID, and `tool.called` / `turn.usage` / `manager.stopped` / `run.awaiting_input` carry it as `data.step_uuid`. The field is **absent, not null, when unresolved** — absent means "not known", never "no step" — so every pre-b7 event shape is unchanged and no schema bump is involved. This makes a driven step's tool calls and tokens attributable to one execution without correlating timestamps against `iteration.started`/`iteration.completed` windows (the LIFO-open-window rule above stays as the fallback for events that carry no `step_uuid` — everything on Paths A/B/C). Measured on live `pipeline drive` runs: hook events emitted inside `claude -p` went from **100% `run_id: null` (10/10 over two runs) to 0% (0/11)**, all of them additionally naming the step. The residual `run_id: null` on that path is `session.opened`, which `<cli>/src/hooks/session-relay.ts` writes as a literal null and which never consults the resolver.

Readers of the journal compute derived stats from the event stream:

- **Per iteration** — tools called, tools failed, agents spawned, tokens consumed, attributed to the step that produced them:
  - **When events carry a step name (`step_name` in v5, `step_id` in v4 — Parallel-DAG runs):** keyed by that name, resolved as `step_name ?? step_id`. A step's window is `[iteration.started, iteration.completed)`; OVERLAPPING parallel steps each accumulate their own stats, and an ambient event during overlap is attributed to the most-recently-started still-open step (LIFO). This is the overlap-safe fold (`iterationToolStatsForRun`).
  - **When events carry neither (v1/v2/v3 / sequential runs):** the legacy consecutive-`iteration.started`-window behavior — an ambient event belongs to the iteration whose `iteration.started` most recently preceded it (window runs until the next `iteration.started`). Fully backward-compatible; unchanged from prior schema versions.
- **Per pipeline run** (between `pipeline.started` and `pipeline.completed`/`pipeline.halted`): same totals, plus elapsed time.
- **Per project** (rolling 24h / 7d windows): aggregated across all completed runs.

## Dead-run signals

A run whose driving session crashed, was killed, or was closed never receives a
terminal event, so a naive fold leaves it `running` forever. Clearing that is
**never** keyed on age — a healthy pipeline legitimately runs for hours. Two
signals exist for a reader to key on instead, and both are still emitted:

- **`manager.stopped` (primary, event-driven).** SubagentStop emits it when a
  run's `pipeline-manager` ends. A run with a `pipeline.started` and a
  `manager.stopped` but no terminal event is abandoned.
- **The pid lockfile (fallback).** `/pipeline:run` writes
  `<runtime>/runs/<run_id>.alive` = `{ pid, run_id, started_at }` right after
  `pipeline.started` (`pipeline event write-liveness`) and removes it on a
  terminal event (`pipeline event clear-liveness`). A `.alive` file left behind
  naming a **dead** pid means the run died without finishing — the only
  detector for a hard kill, which never fires SubagentStop. It degrades safely:
  a pid ≤ 1, or a still-live pid, is never flagged.

**No local process sweeps these today.** The dashboard daemon used to run
`sweepManagerStoppedRuns` / `sweepProjectLiveness` / `sweepInterruptedRuns` over
them, and it was deleted with the local UI (plugin-thin `p3`). The signals
themselves are untouched, so a stale-looking `running` run in a local
`pipeline logs` tail is a *rendering* consequence, not lost data; the cloud
dashboard does its own liveness. Do not remove the writers — reinstating a
sweeper is cheap only while they still exist.

## Environment overrides

- `PIPELINE_JOURNAL_ENABLED` — master opt-OUT switch for the journal/analytics hooks, which are **ON BY DEFAULT**. They stay on unless you explicitly opt out by setting it to a falsy value (`0`/`false`/`no`/`off`); unset/empty — and any other value — leaves them enabled. When opted out, every hook no-ops at entry: the `SessionStart` hook (`session-relay.ts`) does not write `session.opened`, and the analytics hook (`analytics-relay.ts`, all of PreToolUse/PostToolUse/SubagentStop/Stop) emits no events and writes no mirror bindings. The Bun process for a registered hook still launches (an env var can't un-register a `hooks.json` entry) but exits immediately, so an opt-out drops per-hook cost to ~Bun-startup only — to remove the spawn entirely, disable the plugin. Does NOT gate the `pipeline event` journal writer (cheap, and what `pipeline logs` reads — so `/pipeline:run` lifecycle events are still journaled even when the hooks are opted out). Set it in your shell, your OS environment, or your project's `.claude/settings.json` `env` block (hooks inherit the session environment).
- `PIPELINE_JOURNAL_TRANSCRIPTS` — narrower opt-out (same falsy parse, also ON by default) for the transcript work only: the `transcript_path` pointer recorded on a mirror binding, and the `Stop` hook's `turn.usage` token tail. Lifecycle events and run correlation are unaffected.

> Renamed from the `PIPELINE_UI_*` prefix in plugin-thin `p4` (clean break, no
> alias). That prefix was a leftover from the deleted local dashboard — these
> gate the JOURNAL, which stays.

## Rotation

When `events.jsonl` exceeds 50 MB, the writer renames it to `events-YYYYMMDD-HHMMSS.jsonl` and starts a fresh file. Historical files are still readable from disk; `pipeline logs` reads the current file.

## active-mirror-bindings.jsonl (per-user, NOT per-project)

Lives at `~/.claude/pipeline-ui/active-mirror-bindings.jsonl`. Append-only journal of mirror bindings — the hooks (PreToolUse + PostToolUse in `analytics-relay.ts`, plus `pipeline event register-mirror-binding` for Path B) write a record whenever a `pipeline-manager` or worker (`step-executor`, or legacy `pipeline-executor`) spawn should have its transcript mirrored into the chat panel. **`pipeline drive` also writes here** (`kind: "drive-session"`, ux-v2 b7) — not to mirror anything, but to declare which run and step own the headless `claude -p` child it is about to spawn.

```json
{"event":"bound","tool_use_id":"toolu_...","run_id":"<id>","step_uuid":"<uuid-or-null>",
 "session_id":"<id-or-null>",
 "transcript_path":"<abs-or-null>","project_root":"<abs>","worktree":"<abs-or-null>",
 "pipeline_name":"<name>","iteration_path":"<abs>","start_ts":"<iso>",
 "kind":"bypass-spawn|bypass-spawn-failed|chain-controller|subagent|drive-session","schema":1}
```

`step_uuid` is written only by `kind: "drive-session"` records; every other writer binds at Agent-spawn time, where no step identity exists yet, and omits the field. Readers treat **absent as null** — the field is additive and does NOT bump the binding schema.

**Strict scope (issue #11) — still load-bearing.** A session appears in this file only because a hook explicitly bound it, and a transcript is reachable only through a binding that names it. Sessions that never spawn a `pipeline-manager` or worker never appear here at all. The deleted dashboard's `MirrorService` was the first consumer of that guarantee; `analytics-relay.ts`'s own `findBindingForSession` is the one that remains, and it is what makes an event's `run_id`/`step_uuid` resolvable at all. `tests/mirror-scope-discipline.test.ts` is the regression test — do not weaken it.

### `kind: "drive-session"` — the pre-spawn binding (ux-v2 b7)

`pipeline drive` pins the session id of every headless spawn itself (`claude --session-id <uuid>`), and Claude Code hands that same value to every hook that fires **inside** the child. So drive writes the record BEFORE the spawn — `registerDriveSessionBinding` in `apps/pipeline-cli/src/lib/event.ts`, called from `drive.ts`'s `bindSession` immediately after the session is persisted — and the hooks recover `{ run_id, step_uuid }` from it by construction. The write must precede the spawn: the child's first hook can fire within milliseconds of exec.

Three properties are load-bearing:

- **`transcript_path` is always `null`.** At pre-write time the child's transcript file does not exist. A pointer-less record names no transcript, so it does NOT widen transcript scope (issue #11).
- **No `terminal` record is written, and none is needed.** `findRunIdForSession` already treats a binding as terminated once `pipeline.completed`/`pipeline.halted` appears for its `run_id` in the project journal — which retires every drive-session record of that run at once. A run that never terminates ages out at `BINDING_MAX_AGE_MS` (7 days). Growth is one line per step-session (the same order as the Path-B worker bindings already written per Agent spawn); a record whose spawn never happened names a session id that will never exist and can therefore never be matched by anything.
- **`PIPELINE_JOURNAL_ENABLED` gates it.** The master opt-out promises "no events, no mirror bindings"; drive writes these unprompted, so `registerDriveSessionBinding` returns early when the switch is off.

**Shelf life, stated deliberately:** this depends on plugin hooks firing inside `claude -p`. When `-p` defaults to `--bare` they stop, and the mechanism has nothing to attach to. It is a near-term improvement, not an architecture — the identity minting it propagates (ux-v2 b4) is the half that survives.

## Project identity (worktree handling)

`project_root` is always the **main repository's working tree path**, never a worktree path. The writer resolves worktrees by reading `.git` — if it's a file starting with `gitdir: <path>`, it follows `<path>/commondir` to find the parent and uses that. Worktrees still report their location in the `worktree` field.

The resolver is copied into every emitter that cannot import a sibling at runtime (`lib/event.ts`, `<cli>/src/hooks/session-relay.ts`, `<cli>/src/hooks/analytics-relay.ts`, `<cli>/src/hooks/prompt-match-relay.ts`); `<superrepo>/tests/cross-repo/resolve-parity.test.ts` fails if any copy drifts.
