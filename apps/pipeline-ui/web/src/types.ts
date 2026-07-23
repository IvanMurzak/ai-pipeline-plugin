// Shared types — mirrors apps/pipeline-ui/EVENTS.md schema v4.
// `schema` is carried as a plain number on every event (older v1/v2/v3
// journals still parse — newer fields are optional and read as null/absent).

export type EventType =
  | "session.opened"
  | "pipeline.started"
  | "iteration.started"
  | "iteration.resumed"
  | "iteration.completed"
  | "improver.started"
  | "improver.completed"
  | "script_creator.started"
  | "script_creator.completed"
  | "blocker.delegated"
  | "blocker.polling"
  | "blocker.resolved"
  | "pipeline.completed"
  | "pipeline.halted"
  | "worktree.created"
  | "worktree.finalized"
  | "worktree.destroyed"
  | "tool.called"
  | "turn.usage"
  | "run.awaiting_input";

export interface PipelineEvent {
  schema: number;
  ts: string;
  type: EventType;
  project_root: string;
  worktree: string | null;
  run_id: string | null;
  parent_run_id: string | null;
  session_id: string | null;
  data: Record<string, unknown>;
  _project_id?: string;
}

// Script-step observability (values-only addition, 0.71 — event schema STAYS
// v4). `type: script` steps (the zero-token deterministic steps the
// `pipeline next` CLI executes in-process) tag their iteration events with two
// OPTIONAL `data` fields, mirrored here in lockstep with EVENTS.md and the
// CLI's frozen FailureClass (apps/pipeline-cli/src/lib/script-types.ts):
//   • `iteration.started.data.step_type` / `iteration.completed.data.step_type`
//     — `"script"` for a script dispatch; ABSENT means an ordinary agent step
//     (the default, and every §6.3 fallback re-dispatch, which is an agent step).
//   • `iteration.completed.data.failure_class` — one of FAILURE_CLASSES when a
//     script execution failed; ABSENT on success and on every agent step.
// These are NOT new event types (the EventType union is unchanged) and NOT a
// SCHEMA_VERSION bump — `PipelineEvent.data` stays an untyped bag, so pre-0.71
// journals parse unchanged and readers treat absent as "agent step / no
// failure". The literals exist so consumers reading these fields have a typed
// vocabulary, exactly like MODEL_KEYS / EFFORT_KEYS.
export const STEP_TYPE_SCRIPT = "script" as const;
/** An iteration event's `step_type` data value: `"script"`, or absent = agent. */
export type StepTypeValue = typeof STEP_TYPE_SCRIPT;

export const FAILURE_CLASSES = [
  "transient",
  "binding",
  "env",
  "crash",
  "contract",
  "bug",
] as const;
/** `iteration.completed.data.failure_class` value space (mirrors the CLI's
 *  frozen FailureClass). Absent on success and on agent steps. */
export type FailureClass = (typeof FAILURE_CLASSES)[number];

// Model selection (event schema v3+). Absent in v1/v2 events — always treat
// as optional on the consumer side.
//
// `resolved_model` / `default_model` may now be one of the friendly aliases
// (`haiku|sonnet|opus|fable`), OR a canonical `claude-*` id, OR null. The
// daemon never coerces a valid canonical id to null, so the consumer stores
// the raw string and only special-cases the four known aliases for the
// coloured pill (an unknown value, e.g. a canonical id, still DISPLAYS — it
// just gets a neutral pill). The value space is intentionally widened, not
// a structural change: a plain string field still parses on every reader.
/** The model-alias vocabulary — single client-side source; pickers and pill
 *  styling derive from this so a new tier is one edit. */
export const MODEL_KEYS = ["haiku", "sonnet", "opus", "fable"] as const;
export type ModelKey = (typeof MODEL_KEYS)[number];

// The full accepted value space for an event's model field: a known alias,
// any other string (canonical id / future tier), or null/absent.
export type ModelValue = ModelKey | string;

export interface ProjectEntry {
  project_id: string;
  project_root: string;
  project_name: string;
  first_seen: string;
  last_seen: string;
}

export interface PipelineInfo {
  pipeline_name: string;
  pipeline_root: string;
  manifest_excerpt: string | null;
  end_state: string | null;
  iterations: string[];
  /** rel → the step file's frontmatter `model:` (shorthand or canonical id).
   *  Only steps that declare one are present. Absent on pre-0.68 daemons. */
  step_models?: Record<string, string>;
  /** rel → frontmatter `effort:` (low|medium|high|xhigh|max). Absent pre-0.69. */
  step_efforts?: Record<string, string>;
  /** rel → frontmatter `permission-mode:`. Absent pre-0.69. */
  step_permission_modes?: Record<string, string>;
  /** Set when this pipeline is a family TARGET (`<hub>/targets/<name>/`):
   *  the hub whose shared steps/ the target's chain continues into. */
  family_hub?: { pipeline_name: string; pipeline_root: string } | null;
  /** The family hub's steps (rel to the HUB's steps/) — the shared
   *  continuation of a target run. Empty/absent unless family_hub is set. */
  shared_iterations?: string[];
}

// --- Per-failure detail (/api/run-failures) ---------------------------------

export interface ToolFailure {
  ts: string;
  tool_name: string | null;
  /** Compact JSON of the tool_use input (truncated) — e.g. the failing command. */
  input_excerpt: string | null;
  error_excerpt: string;
  source: "manager" | "subagent";
}

export interface RunFailuresResponse {
  run_id: string;
  failures: ToolFailure[];
  truncated: boolean;
  /** false when no transcript could be resolved — "no data", not "no failures". */
  transcript_found: boolean;
}

// --- TOOLS/AGENTS drill-down (/api/run-breakdown) ----------------------------

export interface ToolCallDetail {
  ts: string;
  tool_name: string;
  duration_ms: number | null;
  is_error: boolean;
  input_excerpt: string | null;
  source: "manager" | "subagent";
}

export interface ToolAggregate {
  name: string;
  calls: number;
  failed: number;
  total_duration_ms: number;
  max_duration_ms: number;
}

export interface AgentDetail {
  agent_type: string | null;
  description: string | null;
  started_at: string | null;
  duration_ms: number | null;
  tools_called: number;
  tools_failed: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  /** false = no subagent transcript matched this spawn (zeros are "unknown"). */
  matched: boolean;
}

export interface RunBreakdownResponse {
  run_id: string;
  transcript_found: boolean;
  tools: ToolAggregate[];
  calls: ToolCallDetail[];
  calls_truncated: boolean;
  agents: AgentDetail[];
}

export interface ProjectState {
  project: ProjectEntry;
  pipelines: PipelineInfo[];
  events: PipelineEvent[];
}

export interface IterationSection {
  heading: string;
  body: string;
}

export interface IterationDetail {
  pipeline_name: string;
  rel_path: string;
  absolute_path: string;
  title: string | null;
  sections: IterationSection[];
  raw: string;
  size_bytes: number;
  modified_at: string;
}

export type Theme = "dark" | "light";

// Derived per-run state computed from events.
export type RunStatus =
  | "running"
  | "improving"
  | "scripting"
  | "polling-blocker"
  | "completed"
  | "halted"
  | "unknown";

export interface RunStats {
  tools_called: number;
  tools_failed: number;
  agents_spawned: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  /** Total API cost in USD — present for headless (drive) runs, whose usage
   *  is folded from the claude -p envelopes; absent for transcript folds. */
  cost_usd?: number;
}

export interface RunState {
  run_id: string;
  parent_run_id: string | null;
  pipeline_name: string | null;
  current_iteration_path: string | null;
  current_iteration_index: number | null;
  iteration_count_completed: number;
  status: RunStatus;
  started_at: string;
  last_event_at: string;
  halt_reason: string | null;
  blocker_issue_url: string | null;
  worktree: string | null;
  /** Pipeline-level model from pipeline.started.data.default_model (event
   *  schema v3+). null when absent (v1/v2 events) or when no override was
   *  set at pipeline start. May be an alias OR a canonical `claude-*` id. */
  default_model: ModelValue | null;
  /** Resolved model for the most-recent iteration.started, from
   *  iteration.started.data.resolved_model (event schema v3+). null when
   *  absent. May be an alias OR a canonical `claude-*` id. */
  current_resolved_model: ModelValue | null;
  /** DISPLAY state layered over `running` (design 05): the run emitted
   *  `run.awaiting_input` and nothing has happened since, i.e. a permission
   *  prompt or an input request is blocking it. Derived, not reported — any
   *  later event for the run clears it, because no "resumed" hook signal
   *  exists. Deliberately NOT a RunStatus member: it must never interact with
   *  terminal logic (sweeps, dismissal, completion). */
  awaiting_input: boolean;
  /** What the run is waiting for, when awaiting_input is true. */
  awaiting_input_kind: "permission" | "input" | null;
  stats: RunStats;
  children: RunState[];
}

// Server-derived run summary returned by /api/runs. Same fields as RunState
// minus per-run stats (which require tool.called/turn.usage rollup the
// client computes on its own from the live event window).
export interface RunSummary {
  run_id: string;
  parent_run_id: string | null;
  pipeline_name: string | null;
  current_iteration_path: string | null;
  current_iteration_index: number | null;
  iteration_count_completed: number;
  status: RunStatus;
  started_at: string;
  last_event_at: string;
  halt_reason: string | null;
  blocker_issue_url: string | null;
  worktree: string | null;
  /** Derived WAITING (design 05) — the server fold carries it too, so a run
   *  the live event window has not reached still renders its badge. Optional
   *  on the wire: an older daemon omits the field entirely. */
  awaiting_input?: boolean;
  awaiting_input_kind?: "permission" | "input" | null;
}

// --- Run launcher (/api/pipelines, /api/runs/launch, /api/drive-runs) ---

export interface LaunchCatalogStep {
  step_id: string;
  path: string;
  rel: string;
  model: string | null;
  /** Resolved reasoning effort (step ?? pipeline default ?? null = inherit).
   *  Absent on pre-0.69 daemons. */
  effort?: string | null;
}

/** The reasoning-effort vocabulary (mirrors `claude --effort` / agent
 *  frontmatter `effort:`). Single client-side source, like MODEL_KEYS. */
export const EFFORT_KEYS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortKey = (typeof EFFORT_KEYS)[number];

/** A pipeline's declared `${PP_*}` variable — the launch form renders one
 *  input per entry, prefilled with its default. PP_* values are non-secret by
 *  contract, so all are safe to render. Absent on pre-variable daemons. */
export interface LaunchCatalogVariable {
  name: string;
  description: string;
  required: boolean;
  /** `(default: ...)` value, or null when none is declared. "" is a real
   *  (empty) default, distinct from null. */
  default: string | null;
}

export interface LaunchCatalogPipeline {
  name: string;
  pipeline_root: string;
  first_iteration: string | null;
  end_state: string | null;
  mode: string;
  default_model: string | null;
  /** Pipeline-level `effort:` frontmatter. Absent on pre-0.69 daemons. */
  default_effort?: string | null;
  has_targets: boolean;
  steps: LaunchCatalogStep[];
  /** Declared `${PP_*}` variables. Absent on pre-variable daemons — read
   *  defensively (`?? []`). */
  variables?: LaunchCatalogVariable[];
  errors: string[];
  warnings: string[];
}

export type DriveRunStatus =
  | "running"
  | "completed"
  | "halted"
  | "blocked"
  | "awaiting-input"
  | "failed";

export interface DriveQuestion {
  text: string;
  context: string | null;
  options: string[] | null;
}

/** A daemon-launched headless run (`pipeline drive`), as reported by
 *  /api/drive-runs and the drive.run SSE broadcast. */
export interface DriveRunSnapshot {
  run_id: string;
  project_id: string;
  pipeline_root: string;
  pipeline_name: string;
  start_path: string;
  status: DriveRunStatus;
  exit_code: number | null;
  launched_at: string;
  ended_at: string | null;
  question: DriveQuestion | null;
  awaiting_iteration: string | null;
  halt_reason: string | null;
  task_file: string | null;
}

// --- Per-step wall-clock timings (/api/run-steps) ---------------------------

export interface StepTiming {
  step_id: string | null;
  iteration_path: string;
  /** Path after the last `/steps/` — the iteration tree's rel key. */
  rel: string | null;
  attempts: number;
  first_started_at: string;
  /** Sum of closed active windows, ms (parked needs-input time excluded). */
  duration_ms: number;
  /** ISO of the still-open window — the step is running right now. */
  open_since: string | null;
  last_outcome: string | null;
}

/** One step's slice of the run's transcript fold (/api/run-step-stats). */
export interface RunStepStats {
  step_id: string | null;
  iteration_path: string;
  rel: string | null;
  stats: RunStats;
}

export interface RunStepStatsResponse {
  run_id: string;
  transcript_found: boolean;
  steps: RunStepStats[];
}

export interface RunStepsResponse {
  run_id: string;
  status: RunStatus | "unknown";
  started_at: string | null;
  last_event_at: string | null;
  steps: StepTiming[];
}

// --- AI Fix (/api/editor/ai-fix) --------------------------------------------

export type AiFixStatus = "running" | "done" | "failed";

export interface AiFixJob {
  job_id: string;
  project_id: string;
  pipeline_root: string;
  model: string;
  issues: string[];
  status: AiFixStatus;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  error: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
}
