# Privacy tiers — exactly what leaves your machine

This page is the **field-by-field list**. It is not a summary of a design
document: every field below is transcribed from the filter that actually runs,
`src/lib/vendor/privacy.ts` in the [`pipeline` CLI][cli], and the sample outputs
further down were produced by running that file over planted secrets.

Nothing here applies until you have run `pipeline cloud connect`. With no
`.pipeline/cloud.json` there is no upload path at all — see
[Connecting to the cloud](cloud-connect.md).

[cli]: https://github.com/IvanMurzak/pipeline

---

## The one-paragraph version

Your runs are recorded locally in an append-only journal
(`.pipeline/.runtime/events.jsonl`) and in per-run measurement files
(`.pipeline/.stats/`). When you are connected, a filter runs over each record
**before it is written to the upload queue** — not before it is sent, before it
is *queued* — and only the fields listed on this page survive it. Prompts,
transcripts, code, tool arguments, tool output, error text and absolute
filesystem paths are not on the list, so they never reach the queue file, let
alone the network.

The filter is a **positive allowlist**. An unknown event type ships with its
`data` emptied; an unknown field inside a known type is dropped. New fields
never leak by default — they leak only if someone adds them to the tables below
on purpose.

---

## The three tiers

| Tier | What ships | How to select it |
| --- | --- | --- |
| **`metadata`** | **The default.** Only the allowlisted fields on this page. | nothing to do |
| `events` | The full journal event stream, **verbatim** — including prompts, paths and free text. | `PIPELINE_PRIVACY_TIER=events` |
| `full` | Intended to add step transcripts and logs. **Transcript shipping is not implemented**, so `full` currently ships exactly what `events` ships. | `PIPELINE_PRIVACY_TIER=full` |

Two properties of that switch are worth knowing:

- **It fails closed.** An unrecognised value degrades to `metadata` and says so,
  never up. Verified:

  ```text
  PIPELINE_PRIVACY_TIER=evets
  → tier: metadata
    warning: unrecognized privacy tier 'evets' (config) — failing closed to 'metadata'
  ```

- **Raising it is a real disclosure.** `events` and `full` pass the event
  verbatim by contract; at those tiers the *tier* is the control and no field
  rule applies. Everything else on this page describes `metadata`, which is what
  you get unless you deliberately change it. If you are reading this page to
  decide whether to connect, `metadata` is the tier the product's promises are
  written against.

`PIPELINE_PRIVACY_SALT` optionally hardens the fingerprints described below.
It is never uploaded.

---

## The four field rules

Every allowlisted field carries one of these dispositions.

| Rule | What happens |
| --- | --- |
| **keep** | Copied verbatim — ids, counts, flags, taxonomy, names. |
| **fingerprint** | Replaced by a deterministic `fp:<16 hex>` so the value still correlates across events and restarts without disclosing it. `null` stays `null`. |
| **summary** | Kept but **truncated to 256 characters**. |
| **question / message parts** | Replaced by a fixed placeholder — `[question content stripped: privacy tier metadata]` / `[message content stripped: privacy tier metadata]` — so the server's strict parse still works while zero authored text leaves the machine. |

### And then: no absolute path, and no OS account name, in any field

After the allowlist has run, **every string leaf of the result, at any depth, is
swept again** — including fields marked `keep`, and including free text that
merely *contains* a path. Each one is either:

1. **made relative** to one of the run's own roots (its project root, its
   worktree, its pipeline root), emitted POSIX-separated —
   `C:\Users\IvanD\proj\acme-api\.pipeline\release\steps\03-review.md` becomes
   `.pipeline/release/steps/03-review.md`; or
2. **fingerprinted**, if it is under no root the filter knows, or if the
   relativized remainder would still carry your OS account name.

There is no branch that returns a raw absolute path. This is the rule that a
field-name-based check could not have enforced: `stats.failures[].step` is a
`keep` field that is not `*_path`-named, and a truncated `halt_reason` can drag
a path onto the wire inside free text where no field name is involved. Both are
covered because the rule is about the **shape of the value**, not the name of
its field.

---

## Journal events — the allowlist, field for field

### On every event envelope

| Field | Rule |
| --- | --- |
| `schema`, `ts`, `type` | keep |
| `run_id`, `parent_run_id`, `session_id` | keep |
| `project_root` | **fingerprint** |
| `worktree` | **fingerprint** |
| `task_id`, `context_id` | keep |
| `department_id`, `engine` | keep |
| `sender` (a person, e.g. `ivan@acme`) | **fingerprint** |

Any other envelope field — including one a newer version of the tooling adds —
is **dropped**.

### Per event type — the `data` object

An event type that is not in this table ships `data: {}`.

| Event type | Fields kept | Special dispositions |
| --- | --- | --- |
| `session.opened` | `claude_pid` | |
| `pipeline.started` | `pipeline_name`, `first_iteration_path`, `default_model` | `pipeline_root` → fingerprint |
| `run.started` | `pipeline_name`, `first_iteration_path`, `orchestrator`, `default_model` | `pipeline_root` → fingerprint |
| `iteration.started` | `iteration_path`, `index`, `resolved_model`, `resolved_effort`, `step_name`, `step_id`, `step_type`, `resumed`, `emission`, `step_uuid` | |
| `iteration.resumed` | `iteration_path`, `index`, `resolved_model`, `resolved_effort`, `step_name`, `step_id`, `resumed`, `emission`, `step_uuid` | |
| `iteration.completed` | `iteration_path`, `outcome`, `next_iteration_path`, `has_improvement_brief`, `has_blocker_delegation`, `terminal`, `step_name`, `step_id`, `step_type`, `failure_class`, `step_uuid` | `halt_reason` → summary |
| `improver.started` | `iteration_path`, `step_uuid` | |
| `improver.completed` | `iteration_path`, `applied`, `has_script_brief`, `step_uuid` | |
| `script_creator.started` | `iteration_path`, `step_uuid` | |
| `script_creator.completed` | `iteration_path`, `script_path`, `outcome`, `step_uuid` | |
| `tool.called` | `tool_name`, `success`, `agent_spawn`, `tool_use_id`, `step_uuid` | **tool arguments and tool output are not listed — they are dropped** |
| `turn.usage` | `assistant_turns`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `step_uuid` | |
| `manager.stopped` | `run_id`, `agent_id`, `step_uuid` | |
| `awaiting_input` | `run_id`, `iteration`, `question_id`, `step_name`, `iteration_path`, `step_uuid` | `question` → placeholder |
| `blocker.delegated` | `parent_iteration_path`, `blocker_issue_url`, `child_run_id`, `blocker_target_repo` | |
| `blocker.polling` | `blocker_issue_url`, `pr_state` | |
| `blocker.resolved` | `blocker_issue_url`, `merged_pr_url` | |
| `pipeline.completed` | `pipeline_name` | |
| `pipeline.halted` | `pipeline_name`, `iteration_path` | `halt_reason` → summary |
| `run.completed` | `pipeline_name`, `outcome` | |
| `run.halted` | `pipeline_name`, `iteration_path` | `halt_reason` → summary |
| `worktree.created` | `branch`, `port_base`, `ok` | `worktree_path`, `env_file`, `hook_dir` → fingerprint; **`detail` (raw hook stderr) is dropped** |
| `worktree.finalized` | `ok`, `outcome` | `worktree_path` → fingerprint |
| `worktree.destroyed` | `ok`, `outcome` | `worktree_path` → fingerprint |
| `stats.run_record` | — | the nested stats filter below runs instead |

Department events (only relevant if you use [departments](departments-mcp.md)):

| Event type | Fields kept | Special dispositions |
| --- | --- | --- |
| `department.status` | `state` | `message` → summary |
| `department.progress` | — | `note` → summary |
| `department.input_required` | `question_id` | `question` → placeholder |
| `department.message` | — | `parts` → placeholder (the department's task content never ships) |
| `department.artifact` | `name`, `media_type` | **the artifact's path and bytes are dropped** |
| `department.completed` | — | `summary` → summary |
| `department.failed` | `retry_safe` | `reason` → summary |

> `run.awaiting_input` — the hook-emitted sibling of `awaiting_input` — has **no
> allowlist entry at all**, so it ships `data: {}`. That is deny-by-default
> working as intended, not an oversight.

---

## The run record — the allowlist, field for field

At the end of a run the CLI folds one summary record into
`.pipeline/.stats/**/runs.jsonl`, and that record is queued too. It has its own
nested allowlists.

**The record**

`schema`, `run_id`, `pipeline`, `started_at`, `ended_at`, `duration_s`,
`outcome`, `runner`, `mode`, `steps_run`, `improver_runs`, `improver_applied`,
`scripts_created`, `merges`, `merge_conflicts`, `llm_steps`, `revision`,
`origin` — all kept. `halt_reason` → summary. Anything else is dropped.

**`steps[]`** — `id`, `started_at`, `seconds`, `outcome`, `model`, `effort`,
`step_type`, `failure_class`, `step_uuid`.

**`tokens`** — `input`, `output`, `cache_read`, `cache_creation`,
`tools_called`, `tools_failed`, `failed_tools` (a tool-name → count map),
`agents_spawned`, `cost_usd`.

**`failures[]`** — `ts`, `tool`, `step`. The `error` excerpt text is **stripped
at every tier**, before the tier filter runs and before anything is written to
the queue: failure excerpts routinely contain code, paths and command lines.
The tool name, the step and the count all survive, so the dashboard can still
tell you *what* failed and *how often* without holding the text.

---

## Why `step_uuid` is on the list

`step_uuid` appears on every step-scoped event above, and it is deliberately
`keep` rather than `fingerprint`. It is a locally minted UUIDv7 — 48 bits of
millisecond timestamp plus random bits. It is not derived from and cannot be
inverted to a path, an account name, a hostname, a project name or any authored
content; the generator reads nothing from your environment except the clock. It
is strictly less disclosing than `step_name`, which this tier already keeps
verbatim.

It is on the list because it is the step's **row identity**: the CLI stamps the
same value on the step's events and on its run-record entry, so the dashboard
writes one row per step instead of two. Fingerprinting it would buy no privacy
and would break that.

A sweep over the live tables refuses any step-shaped allowlist that forgets it,
and a conformance test asserts the sweep is empty in every repository that
carries a copy of this filter.

---

## What it actually does — real output

These are not illustrations. They are the output of the shipped filter, run at
the `metadata` tier over records with secrets planted in every disposition.

**An `iteration.started` with an absolute path and a prompt in it**

```jsonc
// in
{ "type": "iteration.started",
  "project_root": "C:/Users/IvanD/proj/acme-api",
  "note": "a field a newer peer added",
  "data": {
    "iteration_path": "C:/Users/IvanD/proj/acme-api/.pipeline/release/steps/03-review.md",
    "step_name": "03-review",
    "step_uuid": "019fded9-3a7c-7c31-9f0e-2b5a1d4e8c60",
    "prompt": "SECRET: the whole step prompt" } }

// out
{ "type": "iteration.started",
  "project_root": "fp:9e5189a93b01d658",
  "data": {
    "iteration_path": ".pipeline/release/steps/03-review.md",
    "step_name": "03-review",
    "step_uuid": "019fded9-3a7c-7c31-9f0e-2b5a1d4e8c60" } }
```

The project root became a fingerprint, the absolute step path became relative,
the prompt is gone, and so is `note` — an envelope field nothing allowlisted.

**A `tool.called` carrying its arguments**

```jsonc
// in  → data: { tool_name, success, tool_use_id, step_uuid,
//               tool_input: { file_path: "…/src/billing.ts", old_string: "SECRET CODE" } }
// out → data: { "tool_name": "Edit", "success": true,
//               "tool_use_id": "toolu_01",
//               "step_uuid": "019fded9-3a7c-7c31-9f0e-2b5a1d4e8c60" }
```

**A `run.halted` whose `halt_reason` quotes a path outside the project**

```jsonc
// in  → "halt_reason": "ENOENT: no such file C:/Users/IvanD/Documents/other-client/keys.txt while reading"
// out → "halt_reason": "ENOENT: no such file fp:39f0bcf82c0e18cb while reading"
```

A path embedded in prose, under no root this run knows, fails closed to a
fingerprint. The sentence survives; the path does not.

**An event type the filter has never heard of**

```jsonc
// in  → { "type": "chat.message", "data": { "text": "SECRET conversation body" } }
// out → { "type": "chat.message", "data": {} }
```

**The run record**

```jsonc
// in  → …, secret_extra: "SECRET",
//        steps: [{ id, seconds, outcome, model, step_uuid, notes: "SECRET" }],
//        tokens: { input, output, cost_usd, prompt: "SECRET" },
//        failures: [{ ts, tool, step: "C:/Users/IvanD/proj/acme-api/.pipeline/…/03-review.md",
//                     error: "SECRET stack trace" }]

// out → …,
//        steps: [{ "id": "03-review", "seconds": 91, "outcome": "fail",
//                  "model": "opus", "step_uuid": "019fded9-…" }],
//        tokens: { "input": 1200, "output": 400, "cost_usd": 0.11 },
//        failures: [{ "ts": "…", "tool": "Bash",
//                     "step": ".pipeline/release/steps/03-review.md" }]
```

---

## Where the filter runs, and where it does not

- It runs **inside the enqueue**, so the on-disk queue at
  `.pipeline/.runtime/telemetry/outbox.jsonl` — which lives in your repository,
  survives reboots, and is read by a background process — only ever holds
  filtered records. "Filter at upload" would leave prompts and paths sitting in
  `.pipeline/` for as long as you are offline.
- It runs **again at the wire**, over the queued record, so a queue file written
  by an older build is re-filtered by the build that sends it.
- It does **not** touch your local journal or your local stats files. Those are
  yours, they are complete, and they never move. `pipeline logs` reads them
  offline; nothing about this page changes what you can see locally.

---

## Turning it off

| What | How |
| --- | --- |
| **Upload nothing at all** | `PIPELINE_SYNC_LOCAL_STATS=0` — the master switch. Runs proceed identically; nothing is queued and no uploader is spawned. |
| **Do not upload your run history on connect** | `pipeline cloud connect --no-history` |
| **Do not journal at all** (also stops the local journal) | `PIPELINE_JOURNAL_ENABLED=0` |
| **Keep the journal, stop reading transcripts** | `PIPELINE_JOURNAL_TRANSCRIPTS=0` |
| **Opt this org out of cross-org aggregates** | `pipeline cloud optout --set true` — a *different* thing; see [Connecting to the cloud](cloud-connect.md#two-different-opt-outs) |

`pipeline stats telemetry` shows the current state of all of this on one screen.

---

## How to check this page yourself

You do not have to trust it.

```bash
# 1. Read the filter. It is one file, it is pure, and it has no dependencies
#    beyond node:crypto.
#    https://github.com/IvanMurzak/pipeline → src/lib/vendor/privacy.ts

# 2. Look at what is actually queued on your machine.
cat .pipeline/.runtime/telemetry/outbox.jsonl
```

The queue file holds exactly what will be sent. If something is in your journal
but not in that file, it is not going anywhere.

The same filter body ships in three places — this CLI, `pipeline-runner`, and
the published `@baizor/pipeline-protocol` package — and a drift check in the
umbrella repository fails CI if the three ever diverge by a byte.
