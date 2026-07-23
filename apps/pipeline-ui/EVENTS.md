# Pipeline UI — Event Schema

Append-only JSON-lines journal at `<project>/.claude/pipeline/.runtime/events.jsonl`. Every event is one line, one JSON object. Schema version: `4`.

## Versioning policy

The daemon parses v1, v2, v3, and v4 events. v1 events lack the `terminal` field on `iteration.completed` and have no `iteration.resumed`; v2 events lack the v3 model-resolution fields (`default_model` on `pipeline.started`, `resolved_model` on `iteration.started`); v3 events lack the v4 DAG field (`step_id` on `iteration.started` / `iteration.resumed` / `iteration.completed`). The fold derives the missing terminal signal from `next_iteration_path: null` for v1, and treats the v3/v4 fields as optional — absent fields read as `null`. **Backward-compat is load-bearing: a v4 daemon MUST parse v1/v2/v3 journals (no `step_id`) exactly as before** — `step_id` is added everywhere as OPTIONAL and never required. When you bump the schema again, keep the daemon backward-compatible for one version (so a daemon at vN parses vN-1 cleanly) — same hard invariant the project's CLAUDE.md enforces.

**Emitter change in plugin 0.54.0 (NO schema bump — stays v4).** The main-loop per-iteration events (`iteration.started` / `iteration.completed`, Tier-1 `improver.*` / `script_creator.*`) and the external-isolation `worktree.created` / `worktree.destroyed` are now auto-emitted **in-process by the `pipeline next` CLI** (from its actions, its `--record` payloads, and the worktree hooks it executes itself) instead of by the `pipeline-manager` shelling out to `pipeline event`. The manager still emits the retrospective's `improver.*` / `script_creator.*` (the CLI cannot see those spawns), and the supervisor still owns `pipeline.*` / liveness / mirror bindings. Shapes, envelope, and field semantics are UNCHANGED — an additive emitter change only; journals written by older plugin versions parse identically.

## Common envelope

```jsonc
{
  "schema": 4,
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
| `iteration.started` | `pipeline next` (CLI, auto-emitted in-process before printing a `run-step` action) | `{ iteration_path, index, resolved_model?: ModelValue\|null, step_id?: string, step_type?: "script" }` |
| `iteration.resumed` | `/api/chat/resume` re-attaches an SDK session | `{ iteration_path, index, resolved_model?: ModelValue\|null, step_id?: string }` |
| `iteration.completed` | `pipeline next` (CLI, derived from the incoming step/layer `--record`) | `{ iteration_path, outcome, next_iteration_path \| null, has_improvement_brief, has_blocker_delegation, halt_reason \| null, terminal: bool, step_id?: string, step_type?: "script", failure_class?: string }` |
| `improver.started` | `pipeline next` around a Tier-1 `run-improver` action; the `pipeline-manager` emits it directly for the retrospective's batch pass | `{ iteration_path }` |
| `improver.completed` | `pipeline next` from the improver `--record`; manager-emitted in the retrospective | `{ iteration_path, applied: boolean, has_script_brief: boolean }` |
| `script_creator.started` | `pipeline next` around a Tier-1 `run-script-creator` action; manager-emitted in the retrospective | `{ iteration_path }` |
| `script_creator.completed` | `pipeline next` from the script `--record` (carries its `script_path`); manager-emitted in the retrospective | `{ iteration_path, script_path \| null, outcome: "created" \| "updated" \| "refused" }` |
| `blocker.delegated` | issue filed + child spawned | `{ parent_iteration_path, blocker_issue_url, child_run_id, blocker_target_repo }` |
| `blocker.polling` | each poll tick | `{ blocker_issue_url, pr_state }` |
| `blocker.resolved` | merge succeeded | `{ blocker_issue_url, merged_pr_url }` |
| `pipeline.completed` | terminal iteration ran cleanly | `{ pipeline_name }` |
| `pipeline.halted` | chain halted | `{ pipeline_name, iteration_path, halt_reason }` |
| `manager.stopped` | SubagentStop hook when a `pipeline-manager` subagent ends | `{ run_id, agent_id \| null }` |
| `worktree.created` | `pipeline next` after executing the consumer's create hook in-process (external isolation, run start) | `{ worktree_path, branch, env_file \| null, port_base \| null, ok: bool, hook_dir }` |
| `worktree.finalized` | `pipeline next` after executing the consumer's MANDATORY finalize hook in-process (external isolation, opted-in, at the end of a COMPLETED run before teardown) | `{ worktree_path \| null, ok: bool, outcome, detail \| null }` |
| `worktree.destroyed` | `pipeline next` after executing the consumer's destroy hook in-process (external isolation, run end) | `{ worktree_path \| null, ok: bool, outcome, detail \| null }` |
| `tool.called` | PostToolUse hook after every tool call | `{ tool_name, success, agent_spawn, tool_use_id }` |
| `turn.usage` | Stop hook (one per assistant Stop event, summed across new transcript turns) | `{ assistant_turns, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens }` |
| `awaiting_input` | `pipeline drive` at EVERY needs-input park (agent-step question AND approval gate; repeat parks re-emit) | `{ run_id, iteration, question_id, question: { text, context \| null, options \| null, question_id?, approval?: { required_role } }, step_id?, iteration_path? }` |
| `run.awaiting_input` | Notification hook, when a permission prompt or an input request blocks the session (see the disambiguation below — NOT the same as `awaiting_input`) | `{ kind: "permission" | "input", message_excerpt: string }` |

### Envelope-level kv overrides on `pipeline event`

> The runtime event emitter is the `pipeline event` command (`apps/pipeline-cli/src/lib/event.ts`, run with Bun). Everything below describes its semantics.

The skill (`/pipeline:run`) passes `run_id`, `parent_run_id`, and `session_id` as **k=v arguments** on every `pipeline event` call, rather than relying on environment variables. Claude Code's Bash tool does not preserve shell state across invocations: a `export PIPELINE_UI_RUN_ID=…` in one Bash call is gone by the next Bash call's `pipeline event …`, which would stamp `run_id: null` on every event after the first and silently drop the run from the UI's fold (events with `run_id: null` are not folded into the run forest).

`pipeline event` pops these three names out of the kv payload and uses them as envelope fields:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/apps/pipeline-cli/src/cli.ts" event iteration.started \
    run_id=abc123def456 \
    iteration_path=/abs/path/to/02-foo.md \
    index=2
```

The envelope ends up as `{run_id: "abc123def456", parent_run_id: null, session_id: null, data: {iteration_path: …, index: 2}}`. The env vars (`PIPELINE_UI_RUN_ID` etc.) remain a defensive fallback for the rare case where the override is absent. The names `run_id` / `parent_run_id` / `session_id` are therefore **reserved** in the kv namespace — do not use them as data-field names on events.

### Emission sources for lifecycle events (`pipeline.started` → `pipeline.completed`/`halted`)

The RUN ANCHOR is the **`pipeline-manager`** (Phase 2). Three call paths produce a pipeline run, and each owns lifecycle emission:

1. **`/pipeline:run` (supervisor, main session) + the `pipeline-manager` it spawns (depth 1)** — the canonical emitters. The supervisor emits the run-level lifecycle (`pipeline.started` / `pipeline.completed` / `halted`) and owns the liveness lockfile + mirror binding; the per-iteration events (`iteration.*`, `improver.*`, `script_creator.*`, `worktree.*`) are auto-emitted in-process by the `pipeline next` CLI as the manager drives it (the manager itself emits only the retrospective's `improver.*` / `script_creator.*` via `pipeline event`, passing the supervisor's `run_id` literally). The per-step worker (`step-executor`, formerly `pipeline-executor`) runs at depth 2. All share one `session_id`, so hook-emitted `tool.called` / `turn.usage` still correlate to the run through the binding.
2. **`POST /api/chat` (daemon, `server.ts`)** — when a chat starts on a pipeline iteration the daemon emits the same events itself (the SDK session is not running `/pipeline:run`). See `emitJournalEvent` in `server.ts`.
3. **Direct `Agent({subagent_type: "pipeline-manager"…})` from a terminal session ("Path C")** — uninstrumented run; nothing in the spawn chain knows it should emit the run-level lifecycle. The hooks (`analytics_relay.ts`) close this gap by SPLITTING **RUN-LEVEL** synthesis across the two hook ticks so the run shows as **active while the manager is in-flight**, not only after it finishes:
   - **`PreToolUse`** (fires before the manager `Agent`/`Task` runs): emits the **START half** — `pipeline.started` ONLY.
   - **`PostToolUse`** (fires when the manager Agent returns): emits the **END half** — `pipeline.completed`/`halted` ONLY.

   **No `iteration.*` is synthesized** — the `pipeline next` CLI the manager drives auto-emits the per-iteration events. Both halves use the **same run_id**, `sha1(tool_use_id).slice(0,12)` (`bypassRunIdFromToolUseId`), so they describe a single run; the manager-spawn's own `tool.called` is stamped with it too. The manager `subagent_type` is matched (bare or marketplace-namespaced) by `^(?:[a-z0-9_-]+:)?pipeline-manager$`. Path B (supervisor-owned) is discriminated by (1) the literal `run_id = …` line the supervisor writes into the manager prompt, and (2) failing that, scanning the journal for a recent `pipeline.started` / `iteration.started` on the same iteration path whose run_id **differs** from this spawn's tool_use_id-derived id — if an owning run resolves, the hooks stay silent on lifecycle (the supervisor owns it). When `PreToolUse` never ran (older Claude Code, missing `tool_use_id`, or a cwd not yet recognized as a pipeline project at spawn time), `PostToolUse` falls back to emitting both run-level events at once (`synthesizeBypassRun`); it detects the split-vs-fallback case with `journalHasPipelineStarted(runId)`. Outcome is derived from `tool_response.is_error`; `default_model` is always `null` (the hook doesn't read `PIPELINE.md`).

   **The WORKER (`step-executor`, or legacy `pipeline-executor`) spawn is NOT a run anchor.** It is matched by `^(?:[a-z0-9_-]+:)?(?:step-executor|pipeline-executor(?:-(haiku|sonnet|opus))?)$` (the legacy name + its removed per-tier suffix are still tolerated for in-flight/forked runs) and only gets a **mirror binding** attributed to the owning run (so the UI shows the step work). The hooks never synthesize a run for a worker spawn — in Path B the supervisor emitted `pipeline.started` and `pipeline next` emitted `iteration.started` when it handed the manager the `run-step`, so the run already exists. The hook mirror-binds BOTH the manager transcript (orchestration) and the worker transcript (step work).

   **Dead-run signals.** As of Phase 2 the **primary** liveness signal is event-driven: `manager.stopped` (see below). A Path-A/B run still also writes a `<runtime>/runs/<run_id>.alive` liveness lockfile the daemon can sweep (secondary fallback). A Path-C run writes no lockfile, so if its driving session is killed *between* the START and END halves AND no `manager.stopped` fires (hard kill), it folds to `running` until cleared via the **Dismiss** button (`POST /api/runs/dismiss`) — the documented guaranteed fallback.

   **Ownership proof (Path B vs Path C discrimination).** Beyond the literal `run_id = …` line in the manager prompt, the hooks scan the journal tail for ownership proof of the spawn's `iteration_path`. TWO event types count as proof:
   - `pipeline.started.first_iteration_path === iterationPath` — covers the chain's FIRST iteration.
   - `iteration.started.iteration_path === iterationPath` (and the analogous `iteration.resumed`) — covers iterations 2..N.

   The match function is `findChainControllerRunId` in `hooks/analytics_relay.ts`; it requires the matching event to carry a non-empty `run_id`.

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

### `iteration.started.step_id`, `iteration.resumed.step_id`, `iteration.completed.step_id` (v4 — DAG / parallel)

Optional kebab-case string identifying the pipeline **step** an iteration event belongs to. Emitted (by the `pipeline next` CLI since plugin 0.54.0; previously by the `pipeline-manager`) **only for Parallel / DAG runs** (triggered by `PIPELINE.md execution: parallel` OR an iteration declaring `depends-on`). In ordinary **sequential** runs the field is OMITTED entirely — and the daemon/web fold falls back to its legacy consecutive-`iteration.started`-window behavior, so every pre-v4 journal and every sequential v4 run behaves exactly as before. v1/v2/v3 events never carry it; readers treat absent as "no step_id → use the window heuristic".

**Why it exists — overlap-safe folding.** In Parallel / DAG mode the manager spawns a whole "ready set" of steps CONCURRENTLY (one `step-executor` per step, each in its own git worktree) and their `iteration.started` … `iteration.completed` windows OVERLAP. The pre-v4 per-iteration analytics fold attributed ambient telemetry (`tool.called`, `turn.usage`) to the window between two CONSECUTIVE `iteration.started` events — which silently mis-attributes everything once windows overlap (a later sibling's `iteration.started` would "close" an earlier, still-running step). With `step_id` present, the fold instead keys each step's window by its `step_id`: the window is the half-open interval `[iteration.started, iteration.completed)` for that step, and an ambient event during overlap is attributed to the **most-recently-started still-open step** (LIFO). When windows don't actually overlap (sequential, or a parallel pipeline that happens to serialize), the result is identical to the legacy window heuristic. The reference fold is `iterationToolStatsForRun` in `apps/pipeline-ui/lib.ts` (server) mirrored by the same name in `web/src/lib/runs.ts` (client); `iterationStatsByRel` additionally surfaces the `step_id` on each iteration-tree row.

**Parallel emission pattern.** For a ready set `{A, B, C}` the `pipeline next` CLI emits `iteration.started{step_id:A}`, `iteration.started{step_id:B}`, `iteration.started{step_id:C}` (one per step, each carrying its own `step_id`) as it hands the manager the concurrent `run-step`; the manager spawns all three concurrently, and the CLI emits `iteration.completed{step_id:…}` per step from the layer `--record`. Each step's `tool.called` / `turn.usage` (correlated by the shared `run_id`) lands in that step's bucket via the LIFO-open-window rule. The hooks do NOT set `step_id` — they never synthesize `iteration.*`; only the pipeline-next emitter does.

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
as `step_id` in v4 and `resolved_effort` in 0.69): two new OPTIONAL `data`
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
  `iteration` is the parked dispatch's `iteration.started.index`. `step_id` +
  `iteration_path` ride along additively. Gate parks use the deterministic
  `question_id` `gate:<run_id>:<step_id>` (no claude session exists to pin
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

Values-only addition — NOT a `SCHEMA_VERSION` bump (same precedent as v4
`step_id` / 0.69 `resolved_effort` / 0.71 `step_type`): one new event type old
consumers ignore (the daemon tolerates unknown types) plus one optional `data`
field. Journals from older emitters parse identically.

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
self-clears: its new output post-dates the interrupt. Gate
`PIPELINE_UI_WATCHDOG_ENABLED` (default ON); inert when `PIPELINE_UI_TRANSCRIPTS`
is off. Accepted gap: an Esc before any model output leaves no marker — an
idle-timeout heuristic would false-positive on long thinking phases.

### `run.awaiting_input` (observability a2 — new TYPE, schema stays 4)

Emitted by the **Notification hook** (`hooks/analytics_relay.ts`) when Claude
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
the `PIPELINE_UI_ENABLED` opt-out: a blocked run is worth surfacing through
`pipeline logs` (`⏸` line) even when no dashboard runs.

### `manager.stopped` (Phase 2 — agent-lifecycle liveness)

Emitted by the **SubagentStop** hook (`analytics_relay.ts`) when a
`pipeline-manager` subagent ends — the PRIMARY "the run's orchestrator is
gone" signal. Shape: `{ run_id, agent_id | null }`. The `run_id` is resolved
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
  (stays `schema: 4`; the daemon tolerates unknown types via the status-fold's
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
`<project>/.claude/pipeline/.hooks/worktree-{create,destroy}`, shared by every
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
- **Schema implication: NONE — no `SCHEMA_VERSION` bump.** Stays `schema: 4`.
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

The **RUN_ANALYTICS** panel (per-run tools / failures / agents / tokens) is folded server-side from the raw Claude Code **transcripts** — the manager's transcript plus every step-executor subagent transcript spawned in the run's time window — via `apps/pipeline-ui/transcript-stats.ts`, served by `GET /api/run-stats` and consumed by the web `useRunStats` hook (which overrides the event-folded `RunState.stats`). This is the only COMPLETE source. Ground-truth validation against real runs showed the hook-emitted events undercount badly: `turn.usage` (Stop hook) tails the MAIN session transcript and never sees the subagent tokens where the bulk of a run's usage lives (so per-run tokens came out near-zero), and `tool.called` (PostToolUse) leaks roughly half its events to `run_id=null` through the fragile session→run binding correlation. The transcript fold reads the actual `usage` and `tool_use`/`tool_result` blocks, gated per-entry by the run's `[started_at, ended_at]` window (a session transcript hosts many runs over its life, so file membership alone is never trusted). It depends ONLY on the spawn-time mirror binding (which records the manager transcript path when `session_id` is reliably known), not on per-event run-id resolution. Resolution: `run_id → manager transcript` via the `active-mirror-bindings.jsonl` index (`indexRunTranscripts`); `run_id → window` via the run summary; subagent files under `<session>/subagents/` are birthtime-prefiltered then per-entry window-gated. A run whose pipeline executed while the daemon was NOT running has no bound transcript → zeroed stats (nothing was mirrored).

### Hook-event correlation (legacy — still drives the per-iteration tree)

`tool.called` and `turn.usage` carry a `run_id` field — set by the `/pipeline:run` skill via the `PIPELINE_UI_RUN_ID` env var, or recovered by the hooks via the session-keyed mirror-binding lookup. Events outside any pipeline run land in the journal as ambient telemetry, excluded from per-run aggregates. These events still feed the **per-iteration** tree breakdown (`IterationTree`/`StepDetail`), which has not yet been migrated to the transcript fold — so the per-iteration numbers remain subject to the undercount described above. (The per-RUN panel no longer uses them.)

The UI computes derived stats client-side from the event stream:

- **Per iteration** — tools called, tools failed, agents spawned, tokens consumed, attributed to the step that produced them:
  - **When events carry `step_id` (v4 / Parallel-DAG runs):** keyed by `step_id`. A step's window is `[iteration.started, iteration.completed)`; OVERLAPPING parallel steps each accumulate their own stats, and an ambient event during overlap is attributed to the most-recently-started still-open step (LIFO). This is the overlap-safe fold (`iterationToolStatsForRun`).
  - **When events have no `step_id` (v1/v2/v3 / sequential runs):** the legacy consecutive-`iteration.started`-window behavior — an ambient event belongs to the iteration whose `iteration.started` most recently preceded it (window runs until the next `iteration.started`). Fully backward-compatible; unchanged from prior schema versions.
- **Per pipeline run** (between `pipeline.started` and `pipeline.completed`/`pipeline.halted`): same totals, plus elapsed time.
- **Per project** (rolling 24h / 7d windows): aggregated across all completed runs.

## File-watcher events (synthesized by daemon, NOT written to journal)

The daemon also broadcasts these to SSE clients when it sees filesystem changes — they don't appear in `events.jsonl`:

| `type` | Trigger | `data` |
|---|---|---|
| `file.changed` | any `<project>/.claude/pipeline/**/*` write/create/delete (incl. UI editor saves) | `{ project_id, path }` |
| `project.registered` | a new project pings `/api/register` or `/api/register-cwd` | `ProjectEntry` |
| `drive.run` | a daemon-launched headless run (`POST /api/runs/launch` / `/api/runs/answer`) changes state: spawned, exited (completed/halted/blocked/failed), parked awaiting-input, or stopped by the user (`POST /api/runs/stop` kills the child and finalizes the snapshot as halted, reason "stopped by user") | `DriveRunSnapshot` — `{ run_id, project_id, pipeline_root, pipeline_name, start_path, status, exit_code, launched_at, ended_at, question: {text, context, options}\|null, awaiting_iteration, halt_reason, task_file }` |
| `hello` | SSE stream opens | `{ plugin_version }` |
| `open` | SSE transport reconnected (browser-side only — emitted by the client wrapper on EventSource `open` events that aren't the first `hello`) | `null` |
| `restart` | daemon is about to hand off to a different plugin install (POST `/api/restart-to`) | `{ from_version, to_version, from_plugin_root, to_plugin_root, grace_ms }` |

### `restart` (version reconciliation)

Broadcast just before the daemon re-execs itself from another plugin install directory. The successor binds the same deterministic seed port, so a browser `EventSource` reconnects within ~1s — this event lets the UI show an intentional "upgrading to vX…" state instead of a connection-error blip. Emitted by `handleRestartTo` in `server.ts`. See "Version reconciliation" under REST endpoints below.

## Chat SSE channel (per `/api/chat` POST stream)

`/api/chat` and `/api/chat/resume` return their own `text/event-stream` response — separate from the daemon-wide `/api/stream` channel. Frames:

| `event:` | When | `data` |
|---|---|---|
| `chat.started` | first frame after SSE is established | `{ session_id, pipeline_name \| null, project_root }` |
| `chat.resumed` | first frame from `/api/chat/resume` | `{ run_id, sdk_session_id, pipeline_name \| null, iteration_path \| null }` |
| `chat.session_linked` | daemon paired our run_id with the SDK's session_id | `{ run_id, sdk_session_id }` |
| `chat.message` | every SDK message (assistant/user/tool/result) | the raw SDK message object |
| `chat.error` | unrecoverable error | `{ message }` |
| `chat.completed` | stream done | `{ session_id }` |

In addition the daemon broadcasts `chat.message_part` over the shared `/api/stream` channel so other browser tabs can mirror an in-flight chat:

```jsonc
{ "type": "chat.message_part", "data": { "run_id": "...", "msg": { /* SDK message */ } } }
```

## REST endpoints (non-streaming)

- `GET  /api/health` — daemon liveness + plugin version + `plugin_root` (the install dir the daemon runs from, slash-normalized)
- `GET  /api/projects` — registered projects
- `GET  /api/state?project_id=` — project + pipelines + last 200 events
- `GET  /api/pipeline?project_id=&name=[&root=]` — single pipeline manifest + steps. `root` (0.68) disambiguates duplicate basenames (same-named targets under two hubs, same name in two categories); name-only keeps first-match for older clients.
- `GET  /api/iteration?project_id=&name=&rel=[&root=]` — parsed iteration file (`root` as above)
- `GET  /api/runs?project_id=&limit=` — server-derived run summaries from the full journal (new in v2 — decouples run history from the live event window)
- `GET  /api/run-stats?project_id=&run_id=` — accurate per-run tool/token analytics, folded from the raw manager+subagent **transcripts** (NOT the hook-emitted `tool.called`/`turn.usage` events, which undercount badly — see Per-run analytics below). Returns `{ tools_called, tools_failed, agents_spawned, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens }`; zeroed when no transcript is bound for the run. Terminal runs are cached indefinitely (immutable); live runs on a short TTL.
- `GET  /api/run-failures?project_id=&run_id=` — per-failure detail behind the FAIL analytics tile (0.68). Same transcript resolution + run window as `/api/run-stats`; returns `{ run_id, failures: [{ ts, tool_name, input_excerpt, error_excerpt, source: "manager"|"subagent" }], truncated, transcript_found }` — every window-gated `tool_result` error, chronological, capped at 200 AFTER a full-run sort, tool name/input resolved from the preceding `tool_use` block (pre-window `tool_use` blocks still resolve names for in-window failures). `transcript_found:false` means "no transcript bound", not "no failures". Cached like run-stats (a terminal no-transcript response stays on the short TTL so a late-materializing binding is picked up).
- `GET  /api/run-breakdown?project_id=&run_id=` — TOOLS/AGENTS drill-down behind the analytics tiles (0.69). Same resolution ladder; returns `{ run_id, transcript_found, tools: [{ name, calls, failed, total_duration_ms, max_duration_ms }], calls: [{ ts, tool_name, duration_ms, is_error, input_excerpt, source }], calls_truncated, agents: [{ agent_type, description, started_at, duration_ms, tools_called, tools_failed, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, matched }] }`. Per-call `duration_ms` = the `tool_use`→`tool_result` timestamp pair (null while unclosed); aggregates cover EVERY call while the `calls` list is capped at 500. Agent rows come from `Agent`/`Task` `tool_use` spawns; each is greedily matched by start-time proximity (≤180 s) to an in-window subagent transcript whose own usage fold provides the agent's tokens/tool counts — `matched:false` marks a spawn with no plausible file (zeros mean "unknown", not zero). Tokens are attributable per AGENT (its own transcript), never per individual tool call. Cached like run-failures.
- `GET  /api/transcripts?project_id=&limit=` — list Claude Code session/subagent transcripts
- `GET  /api/transcript?project_id=&id=` — parsed transcript body
- `GET  /api/chat/messages?project_id=&run_id=` — persisted SDK messages
- `GET  /api/chat/sessions?project_id=` — resumable chat sessions
- `POST /api/register` — register by project_root
- `POST /api/register-cwd` — register by cwd (server walks up to .git/commondir)
- `POST /api/chat` — spawn SDK session, stream as SSE
- `POST /api/chat/resume` — resume SDK session by run_id
- `POST /api/restart-to` — hand the daemon off to another plugin install dir (version reconciliation)
- `POST /api/runs/dismiss` — `{ project_id, run_id }`; clear a run the user knows is dead (see Dead-run protection below)

## Dead-run protection

A run that never received a terminal event (its driving session crashed / was killed / closed) folds to `running` forever and lingers in the UI's Active list. Clearing it is **not** keyed on age — a healthy pipeline can legitimately run for many hours.

- **Manual dismiss (`POST /api/runs/dismiss`)** — the guaranteed escape hatch. The daemon looks the run up, then appends a synthetic `pipeline.halted` (`data.dismissed: true`, `halt_reason: "dismissed by user"`) via `emitJournalEvent`, so the fold flips it to `halted` and the journal tail broadcasts it. `400` on missing `project_id`/`run_id`, `404` on unknown project/run. The UI surfaces this as a "Dismiss" button on Active run cards.

  **Sticky-dismiss semantic in the fold.** Both the client (`web/src/lib/runs.ts`) and the server (`apps/pipeline-ui/lib.ts`) treat `pipeline.halted.data.dismissed === true` as a one-way flag: once observed for a run, every subsequent status-mutating case (`iteration.started`, `iteration.completed`, `improver.started`, `pipeline.completed`, …) becomes a no-op for `r.status`, so the run stays visibly `halted` regardless of how the underlying pipeline behaves afterwards. Stats (`tool.called`, `turn.usage`) and current-iteration tracking still update so the panel reflects what's actually happening. Without the sticky flag the UI would show a contradictory `{status: running, halt_reason: "dismissed by user"}` once any post-dismiss `iteration.started` arrived. The flag is internal-only and stripped from the public `RunState` / `RunSummary` shapes.
- **Daemon boot self-cleanup** — a daemon restart kills any in-flight `/api/chat` SDK query, so chat-driven runs still non-terminal in the journal are dead. At startup the daemon scans each project's `chat-sessions.jsonl` (only projects that have one) and emits `pipeline.halted` (`halt_reason: "daemon restarted — chat session lost"`) for any of those run_ids still non-terminal.

- **Event-driven liveness detection (Phase 2 — primary)** — the SubagentStop hook emits `manager.stopped { run_id, agent_id }` when a run's `pipeline-manager` subagent ends. The daemon's `sweepManagerStoppedRuns` (run alongside `sweepProjectLiveness` in `/api/runs` + the 60s backstop) emits `pipeline.halted` (`halt_reason: "abandoned — pipeline-manager stopped without completing"`, `abandoned: true`) for any run that has a `pipeline.started` and a `manager.stopped` but no terminal event. It is **guarded by the lockfile**: a still-live `<run_id>.alive` driver (the Path-B supervisor poll-waiting on a nested blocker, which legitimately stops + re-spawns the manager) keeps the run alive. Backward-compatible: a journal with no `manager.stopped` is untouched here.

- **Automatic pid-lockfile detection (secondary fallback)** — `/pipeline:run` drops a per-run lockfile `<runtime>/runs/<run_id>.alive` = `{ pid, run_id, started_at }` right after `pipeline.started` (via `pipeline event write-liveness run_id=… pid=$PPID`), where `pid` is the OS process **driving** the run, and removes it on a terminal event (`pipeline event clear-liveness`). A `.alive` file that remains with a **dead** pid therefore means the run crashed/was killed without finishing (e.g. a hard kill that never let SubagentStop fire). The daemon's `sweepProjectLiveness` (run lazily in `/api/runs` for the requested project + a 60s backstop over all projects) emits `pipeline.halted` (`halt_reason: "abandoned — driver process no longer alive"`, `abandoned: true`) for those and deletes the stale lockfile. This machinery is **kept as a deliberate fallback** alongside the event-driven signal — do not remove it. **Liveness, not age, is the trigger** — a healthy multi-hour pipeline keeps its driver alive and is never touched. It **degrades safely**: a pid ≤ 1 (e.g. a sandbox where `$PPID` isn't the real driver), the daemon's own pids, or a still-alive pid are never flagged, so there are no false "dead" verdicts — manual dismiss remains the guaranteed fallback where a trustworthy driver pid can't be captured.

### Version reconciliation (`POST /api/restart-to`)

The daemon should always run whatever plugin version Claude Code currently has installed. The SessionStart hook (`hooks/pipeline_ui_relay.ts`) enforces this: on every session start in a pipeline project it compares the running daemon's `plugin_root` (from the lock, falling back to `/api/health`) against its own `CLAUDE_PLUGIN_ROOT`. On a mismatch it POSTs:

```jsonc
{ "pid": <running-daemon-pid>, "plugin_root": "<CLAUDE_PLUGIN_ROOT>" }
```

Response: `{ ok, restarted, from_version, to_version, pid, grace_ms }`. `restarted:false` means the request was a same-root no-op. Status codes: `400` malformed body / bad `plugin_root` (no `apps/pipeline-ui/server.ts` under it), `409` `pid` targets a different daemon.

Handoff sequence (load-bearing ordering): broadcast `restart` SSE → after `grace_ms` stop the HTTP server (frees the seed port) → delete own lock (so the successor's `isExistingDaemonAlive` returns null) → spawn the successor detached from the target's `server.ts` → `process.exit(0)`. The successor binds the same seed port and rewrites the lock.

Auth is loopback-only (the daemon binds `127.0.0.1`); the `pid` echo is a correctness guard against restarting the wrong daemon, **not** a security boundary — anyone able to read the lock could call this, the same trust level as being able to signal the process.

For daemons predating this endpoint (which 404 on `/api/restart-to`), the hook falls back to a brute-force kill+respawn: SIGTERM (escalating to SIGKILL), clear the stale lock, spawn from the hook's plugin root. This is what lets the very first upgrade *to* a reconcile-capable version take effect via the hook rather than requiring a manual restart.

### Mid-session reconciliation (Phase 2 — `installed_plugins.json` watch)

The SessionStart hook only fires when a new Claude Code session opens. To pick up an upgrade performed *during* a long-running session (e.g. `/plugin` from another terminal), the daemon also watches `~/.claude/plugins/installed_plugins.json` — the file Claude Code rewrites on every per-project install/upgrade/downgrade, stamping a fresh `lastUpdated`.

When that file changes, the daemon re-reads it and picks the install entry for **this** plugin (matched by shared parent dir of its plugin root — i.e. a sibling version, no marketplace name needed) with the newest `lastUpdated`. If that entry's `lastUpdated` advanced past the value captured at boot **and** points at a different install dir than the daemon is running from, the daemon hands off to it via the same `scheduleHandoff` path used by `/api/restart-to`.

This is **most-recent-install-action wins, not highest-semver** — a deliberate downgrade is honored, matching the hook's most-recent-session rule and the daemon-tracks-installed-version invariant. The boot-time baseline guards against unrelated plugins' installs (which rewrite the file but don't touch this plugin's entries) triggering a needless restart. The picker is `pickNewestPluginSibling` in `lib.ts`. A 30s poll backstops the fs.watch (which can miss atomic write-then-rename events on Windows).

### User-triggered restart (`GET /api/update-status` + `POST /api/restart`)

Because the Phase-2 baseline is seeded at boot, a version gap that already existed **when the daemon started** is never auto-reconciled (that's Phase 1's job at the next SessionStart). `GET /api/update-status` reports that gap — `{ current_version, current_plugin_root, update: { plugin_root, version } | null, restarting }`, where `update` is the newest *complete* installed sibling differing from the running root (`resolvePendingUpdate` in `lib.ts`). The web TopBar polls it (60 s) and shows an **UPDATE vX** button only while `update` is non-null.

`POST /api/restart` (no body) restarts the daemon into that pending update — or re-execs from the current root when none is pending (the manual escape hatch; same-root is allowed here, unlike `/api/restart-to`'s defensive no-op, because this endpoint only fires on explicit user action). It reuses the identical `restart` broadcast + `scheduleHandoff` sequence, answers `{ ok, restarted, updated, from_version, to_version, pid, grace_ms }`, and reports the in-flight target when a restart is already scheduled. `pipeline ui --restart` wraps it from the terminal. After ANY handoff the web app hard-reloads once the successor answers `/api/health` (`useReloadOnRestart` in `web/src/lib/sse.ts`) so open tabs pick up the successor's dist bundle instead of rendering stale JS.

## Process model (Phase 3 — supervisor)

The SessionStart hook and `/pipeline:ui` launch `supervisor.ts`, a thin process manager, rather than `server.ts` directly. The supervisor:

- spawns `server.ts` as a **worker** child (passing `PIPELINE_UI_SUPERVISOR_PID`) and `await`s its exit;
- **respawns the worker on an unexpected exit** (crash recovery), reclaiming the worker's last port; a crash-loop cap (5 crashes / 60s) makes it give up so it doesn't spin on a broken install;
- on a **version handoff**, the worker (detecting it's supervised) writes `~/.claude/pipeline-ui/worker-handoff.json` (`{ target_script, reclaim_port }`) and exits 0 instead of self-spawning a detached successor; the supervisor consumes that file and spawns the new worker, so crash-recovery monitoring persists across the upgrade;
- exits when the worker exits 0 with no pending handoff (idle-timeout or `already_running`).

The supervisor owns no port, lock, or HTTP server. The **worker** still binds the port, serves `/api/health`, and writes `daemon.lock` — now stamped with `supervisor_pid`. `lock.pid` is always the worker. **To stop the daemon, signal `supervisor_pid`** (and, on Windows where killing the parent doesn't reap the child, the worker `pid` too) — killing only the worker triggers a respawn.

A worker launched **without** a supervisor (direct `server.ts`, e.g. tests) detects the absence of `PIPELINE_UI_SUPERVISOR_PID` and falls back to self-spawning its successor on handoff (the Phase 1/2 behavior), so direct launches still work.

This is **not** zero-downtime — handoffs/respawns reuse port-reclaim (sub-second reconnect), not socket inheritance. Socket inheritance with Bun on Windows was judged too risky for the benefit.

### Environment overrides

- `PIPELINE_UI_ENABLED` — master opt-OUT switch for the UI/analytics system, which is **ON BY DEFAULT**. It stays on unless you explicitly opt out by setting it to a falsy value (`0`/`false`/`no`/`off`); unset/empty — and any other value — leaves it enabled. When opted out, every UI hook no-ops at entry: the `SessionStart` hook (`pipeline_ui_relay.ts`) does not spawn/reconcile the daemon, register the project, or write `session.opened`; the analytics hook (`analytics_relay.ts`, all of PreToolUse/PostToolUse/SubagentStop/Stop) emits no events and writes no mirror bindings; and `pipeline ui` / `/pipeline:ui` refuse to start the daemon (printing that it was opted out + how to re-enable). The Bun process for a registered hook still launches (an env var can't un-register a `hooks.json` entry) but exits immediately, so an opt-out drops per-hook cost to ~Bun-startup only — to remove the spawn entirely, disable the plugin. Does NOT gate the `pipeline event` journal writer (cheap, and what `pipeline logs` reads — so `/pipeline:run` lifecycle events are still journaled even when the UI is opted out). **This flag ONLY toggles the enable default — it does NOT affect the host/token security gate** (`PIPELINE_UI_HOST`/`PIPELINE_UI_TOKEN`): the daemon still binds `127.0.0.1` only, and a non-loopback bind still requires a mandatory token. Set it in your shell, your OS environment, or your project's `.claude/settings.json` `env` block (hooks inherit the session environment).
- `PIPELINE_UI_HOME` — relocate the per-user daemon state dir (lock, registry, logs). The deterministic seed port is derived from this path, so a distinct home also yields a distinct port. Used by tests to isolate daemon-spawning suites onto their own lock + port so they can run in parallel.
- `PIPELINE_UI_INSTALLED_PLUGINS_PATH` — override the watched `installed_plugins.json` location (testing).
- `PIPELINE_UI_RECLAIM_PORT` — set by a handoff/respawn so the new worker rebinds the predecessor's exact port (open browser tabs reconnect to the same URL). Not meant to be set manually.
- `PIPELINE_UI_SUPERVISOR_PID` — set by `supervisor.ts` on the worker so the worker stamps it into the lock and routes handoffs through the supervisor. Not meant to be set manually.

## Rotation

When `events.jsonl` exceeds 50 MB, the writer renames it to `events-YYYYMMDD-HHMMSS.jsonl` and starts a fresh file. `chat-messages.jsonl` rotates the same way at the same threshold. The daemon serves only the current file's tail by default; historical files are still readable from disk.

## chat-messages.jsonl

Sibling file of `events.jsonl`, populated by the daemon when the user runs `/api/chat` (in-process Agent SDK) AND mirrored from Claude Code terminal-session transcripts by the daemon's MirrorService (issue #11). One JSON object per line:

```json
{"run_id":"<id>","ts":"<iso>","msg":<sdk-or-transcript-message>}
{"run_id":"<id>","ts":"<iso>","msg":<...>,"source":"mirror"}
```

The optional `source` field is set to `"mirror"` only for rows written by the tailer; SDK-originated rows omit it (older readers ignore the unknown field, so the schema stays backward-compat).

## active-mirror-bindings.jsonl (per-user, NOT per-project)

Lives at `~/.claude/pipeline-ui/active-mirror-bindings.jsonl`. Append-only journal of mirror bindings — the hooks (PreToolUse + PostToolUse in `analytics_relay.ts`, plus `pipeline event register-mirror-binding` for Path B) write a record whenever a `pipeline-manager` or worker (`step-executor`, or legacy `pipeline-executor`) spawn should have its transcript mirrored into the chat panel.

```json
{"event":"bound","tool_use_id":"toolu_...","run_id":"<id>","session_id":"<id-or-null>",
 "transcript_path":"<abs-or-null>","project_root":"<abs>","worktree":"<abs-or-null>",
 "pipeline_name":"<name>","iteration_path":"<abs>","start_ts":"<iso>",
 "kind":"bypass-spawn|bypass-spawn-failed|chain-controller|subagent","schema":1}
```

The daemon's MirrorService rebuilds its in-memory binding map from this file on boot, polls it for new lines, and tails the bound transcripts. Strict scope: a transcript path is only ever read if a hook explicitly bound it, OR if it was discovered as a child subagent of an already-bound transcript. Sessions that never spawn a `pipeline-manager` or worker never appear in this file and are never read.

## Project identity (worktree handling)

`project_root` is always the **main repository's working tree path**, never a worktree path. The writer resolves worktrees by reading `.git` — if it's a file starting with `gitdir: <path>`, it follows `<path>/commondir` to find the parent and uses that. Worktrees still report their location in the `worktree` field for UI display.

For events the daemon emits itself (e.g. from `/api/chat`), the worktree is taken from the project's registry entry (captured at `/api/register-cwd` time).
