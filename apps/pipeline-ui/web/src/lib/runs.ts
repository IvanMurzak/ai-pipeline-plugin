import type { ModelValue, PipelineEvent, RunState, RunStats, RunStatus } from "../types";
import { pipelineNameFromIterationPath } from "./format";

interface MutableRun {
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
  default_model: ModelValue | null;
  current_resolved_model: ModelValue | null;
  /** Derived WAITING (design 05) — see RunState in ../types. */
  awaiting_input: boolean;
  awaiting_input_kind: "permission" | "input" | null;
  stats: RunStats;
  /** Iteration paths we've already counted as `outcome: "completed"`. Keeps
   *  iteration_count_completed accurate when (a) the same path emits a
   *  halted-then-resumed-completed pair (chat resume), and (b) halted /
   *  blocked outcomes don't bump the counter. */
  _completedPaths: Set<string>;
  /** True once a terminal iteration.completed was observed. Lets
   *  improver.completed / script_creator.completed restore status to
   *  'completed' if the chain controller is cut off before pipeline.completed. */
  _terminalReached: boolean;
  /** True once the user dismissed this run (POST /api/runs/dismiss emits a
   *  synthetic `pipeline.halted` with `data.dismissed === true`). Subsequent
   *  events keep updating stats and current-iteration tracking, but status
   *  is frozen at "halted" — otherwise a still-running pipeline whose
   *  events keep arriving after dismiss would flip status back to "running"
   *  / "completed" and contradict the dismissed `halt_reason`. */
  _dismissed: boolean;
}

const KNOWN_MODEL_ALIASES = new Set(["haiku", "sonnet", "opus", "fable"]);

// Normalize an event's model field into a ModelValue or null. The value
// space was widened for per-step model selection: besides the friendly
// aliases (haiku|sonnet|opus|fable) the daemon may stamp a canonical
// `claude-*` id, which must be PRESERVED (displayed as-is), never coerced
// to null. The daemon only ever emits a lowercased alias, a `claude-*` id,
// or null — so we accept exactly those and reject everything else (null,
// non-strings, mixed-case typos like "Opus", empty) as "no override set".
// This keeps a stray/older-daemon junk value from blanking a captured one
// while still letting a brand-new canonical id through.
function normalizeModel(v: unknown): ModelValue | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length === 0) return null;
  if (KNOWN_MODEL_ALIASES.has(t)) return t;
  if (t.startsWith("claude-")) return t;
  return null;
}

function emptyStats(): RunStats {
  return {
    tools_called: 0,
    tools_failed: 0,
    agents_spawned: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };
}

function newRun(run_id: string, ts: string): MutableRun {
  return {
    run_id,
    parent_run_id: null,
    pipeline_name: null,
    current_iteration_path: null,
    current_iteration_index: null,
    iteration_count_completed: 0,
    status: "unknown",
    started_at: ts,
    last_event_at: ts,
    halt_reason: null,
    blocker_issue_url: null,
    worktree: null,
    default_model: null,
    current_resolved_model: null,
    awaiting_input: false,
    awaiting_input_kind: null,
    stats: emptyStats(),
    _completedPaths: new Set<string>(),
    _terminalReached: false,
    _dismissed: false,
  };
}

/** Mutate `r.status` unless the run has been dismissed by the user, in
 *  which case status is sticky at "halted". Centralizes the dismiss check
 *  so every case in the fold honors it; without this, a `pipeline.halted`
 *  carrying `data.dismissed: true` would correctly land at "halted" but a
 *  later `iteration.started` from a still-running pipeline would flip the
 *  badge back to "running", contradicting the dismissed halt_reason. */
function setStatus(r: MutableRun, s: RunStatus): void {
  if (r._dismissed) return;
  r.status = s;
}

/**
 * Fold all events for one project into a forest of RunState.
 * Events without run_id are ignored (session.opened, file.changed, etc.).
 */
export function buildRunForest(events: PipelineEvent[]): RunState[] {
  const map = new Map<string, MutableRun>();

  for (const e of events) {
    const id = e.run_id;
    if (!id) continue;
    let r = map.get(id);
    if (!r) {
      r = newRun(id, e.ts);
      map.set(id, r);
    }
    r.last_event_at = e.ts;
    // Derived WAITING (design 05): `run.awaiting_input` raises the flag and ANY
    // other event for the same run clears it — resumed activity is the only
    // signal that cannot lie, since no "the user answered" hook exists.
    r.awaiting_input = e.type === "run.awaiting_input";
    if (!r.awaiting_input) r.awaiting_input_kind = null;
    if (e.parent_run_id && !r.parent_run_id) r.parent_run_id = e.parent_run_id;
    if (e.worktree && !r.worktree) r.worktree = e.worktree;
    const d = e.data ?? {};

    switch (e.type) {
      case "pipeline.started":
        r.pipeline_name = (d.pipeline_name as string) ?? r.pipeline_name;
        // default_model is optional (event schema v3+). Only overwrite when
        // the field is present so an older event arriving late doesn't wipe
        // an already-resolved override.
        if ("default_model" in d) {
          r.default_model = normalizeModel(d.default_model);
        }
        setStatus(r, "running");
        break;
      case "iteration.started":
      case "iteration.resumed":
        // Treat .resumed like .started for status / current-step tracking,
        // but the per-step stats fold (iterationStatsByRel) ignores it so the
        // started_count isn't double-bumped by a resume.
        r.current_iteration_path = (d.iteration_path as string) ?? r.current_iteration_path;
        r.current_iteration_index =
          typeof d.index === "number" ? (d.index as number) : r.current_iteration_index;
        if (!r.pipeline_name) {
          r.pipeline_name = pipelineNameFromIterationPath(r.current_iteration_path);
        }
        // Track the resolved model for the current iteration. Schema v3+
        // carries it on BOTH .started and .resumed (resume may pick a
        // different tier if the user changed body.model or the step's
        // frontmatter mid-pipeline). Only overwrite when the incoming
        // value is a recognized tier so out-of-order / older-daemon
        // events with null don't blank a previously captured value.
        if ("resolved_model" in d) {
          const v = normalizeModel(d.resolved_model);
          if (v) r.current_resolved_model = v;
        }
        setStatus(r, "running");
        break;
      case "run.awaiting_input":
        // Display-only: status is deliberately untouched (the run is still
        // whatever it was — usually `running` — just blocked on a human).
        r.awaiting_input_kind = d.kind === "permission" ? "permission" : "input";
        break;
      case "iteration.completed": {
        // Only count outcome:"completed" — halted and blocked-delegating
        // iterations didn't actually finish. Dedup by iteration_path so a
        // resume that re-runs the same iteration doesn't double-count.
        const path = (d.iteration_path as string | undefined) ?? null;
        if (d.outcome === "completed") {
          if (path && !r._completedPaths.has(path)) {
            r._completedPaths.add(path);
            r.iteration_count_completed += 1;
          } else if (!path) {
            // Defensive: events without an iteration_path can still happen
            // (synthesized by old emitters); count them as we did before.
            r.iteration_count_completed += 1;
          }
        }
        if (d.outcome === "halted") {
          setStatus(r, "halted");
          r.halt_reason = (d.halt_reason as string) ?? r.halt_reason;
        } else if (d.outcome === "completed") {
          // Defensive terminal derivation: if the chain controller never emits
          // a pipeline.completed (skill cut off, /clear, etc.), but the last
          // iteration completed cleanly with no next, the run is done — don't
          // leave it spinning forever.
          //
          // Schema v2 marks the terminal iteration explicitly via `terminal`;
          // v1 emitted only `next_iteration_path: null`. We accept either
          // signal AND we accept the "field absent" case too (`undefined`)
          // so producers that drop the field rather than null'ing it still
          // get terminal derivation.
          const nextIsAbsentOrNull =
            d.next_iteration_path == null; // covers null AND undefined
          const terminal =
            d.terminal === true ||
            (nextIsAbsentOrNull && r.status === "running");
          if (terminal) {
            r._terminalReached = true;
            setStatus(r, "completed");
          }
        }
        break;
      }
      case "improver.started":
        setStatus(r, "improving");
        break;
      case "improver.completed":
        // Normally the next event (running/scripting/pipeline.completed)
        // flips status. But if the chain controller is cut off here AFTER
        // a terminal iteration, restore the terminal status so the run
        // doesn't stay stuck at 'improving' forever.
        if (r._terminalReached && r.status === "improving") {
          setStatus(r, "completed");
        }
        break;
      case "script_creator.started":
        setStatus(r, "scripting");
        break;
      case "script_creator.completed":
        if (r._terminalReached && r.status === "scripting") {
          setStatus(r, "completed");
        }
        break;
      case "blocker.delegated":
        setStatus(r, "polling-blocker");
        r.blocker_issue_url = (d.blocker_issue_url as string) ?? r.blocker_issue_url;
        break;
      case "blocker.polling":
        setStatus(r, "polling-blocker");
        break;
      case "blocker.resolved":
        // Parent will resume; child run completes via its own pipeline.completed.
        setStatus(r, "running");
        break;
      case "pipeline.completed":
        setStatus(r, "completed");
        break;
      case "pipeline.halted":
        // Set the dismissed flag BEFORE writing status so the setStatus
        // gate isn't applied to this case — the dismiss IS the halt event
        // itself, it must always land. After this point setStatus is a
        // no-op for this run (status stuck at "halted") regardless of what
        // events arrive next.
        if (d.dismissed === true) {
          r._dismissed = true;
        }
        r.status = "halted";
        r.halt_reason = (d.halt_reason as string) ?? r.halt_reason;
        break;
      case "tool.called":
        r.stats.tools_called += 1;
        if (d.success === false) r.stats.tools_failed += 1;
        if (d.agent_spawn === true) r.stats.agents_spawned += 1;
        break;
      case "turn.usage":
        r.stats.input_tokens += Number(d.input_tokens ?? 0);
        r.stats.output_tokens += Number(d.output_tokens ?? 0);
        r.stats.cache_read_tokens += Number(d.cache_read_tokens ?? 0);
        r.stats.cache_creation_tokens += Number(d.cache_creation_tokens ?? 0);
        break;
    }
  }

  // Build the forest (top-level runs first; children nested).
  const all: RunState[] = [];
  const byId = new Map<string, RunState>();
  for (const m of map.values()) {
    // Strip internal-only fields before exposing.
    const {
      _completedPaths: _drop1,
      _terminalReached: _drop2,
      _dismissed: _drop3,
      ...rest
    } = m;
    void _drop1;
    void _drop2;
    void _drop3;
    const node: RunState = { ...rest, children: [] };
    byId.set(node.run_id, node);
  }
  for (const node of byId.values()) {
    if (node.parent_run_id && byId.has(node.parent_run_id)) {
      byId.get(node.parent_run_id)!.children.push(node);
    } else {
      all.push(node);
    }
  }
  // Newest first.
  all.sort((a, b) => (a.last_event_at < b.last_event_at ? 1 : -1));
  for (const node of byId.values()) {
    node.children.sort((a, b) => (a.last_event_at < b.last_event_at ? 1 : -1));
  }
  return all;
}

export function isActive(s: RunStatus): boolean {
  return s === "running" || s === "improving" || s === "scripting" || s === "polling-blocker";
}

/** Depth-first flatten of the run forest (roots + all blocker children). */
export function flattenRuns(rs: RunState[]): RunState[] {
  return rs.flatMap((r) => [r, ...flattenRuns(r.children)]);
}

/** Every run the user would call "live": event-fold active, plus drive runs
 *  parked on a needs-input question (their fold still says running, but the
 *  drive snapshot is the authority). One selector so the active-runs strip and
 *  the overview board can never disagree on what counts. */
export function activeRuns(runs: RunState[], driveRunsById: Map<string, { status: string }>): RunState[] {
  const awaiting = (id: string) => driveRunsById.get(id)?.status === "awaiting-input";
  return flattenRuns(runs).filter((r) => isActive(r.status) || awaiting(r.run_id));
}

/**
 * Add basename aliases to a rel-keyed per-step map, in place. The iteration
 * tree looks stats up by the file BASENAME first (then full rel), so every
 * per-step map registers `tail → entry` aliases — but only when the tail is
 * UNAMBIGUOUS (exactly one full rel ends in it) so two sub-folder steps
 * sharing a basename force the full-rel lookup. Single source for the alias
 * contract shared by iterationStatsByRel / iterationToolStatsByRel / the
 * step-timings map in App.
 */
export function applyBasenameAliases<T>(map: Map<string, T>): Map<string, T> {
  const tails = new Map<string, string | "__AMBIGUOUS__">();
  for (const rel of map.keys()) {
    const tail = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
    if (tail === rel) continue;
    tails.set(tail, tails.has(tail) ? "__AMBIGUOUS__" : rel);
  }
  for (const [tail, full] of tails) {
    if (full === "__AMBIGUOUS__") continue;
    const entry = map.get(full);
    if (entry !== undefined && !map.has(tail)) map.set(tail, entry);
  }
  return map;
}

export interface IterationStats {
  started_count: number;
  completed_count: number;
  halted_count: number;
  blocked_count: number;
  last_outcome: "completed" | "halted" | "blocked-delegating" | null;
  last_event_at: string | null;
  /** Latest resolved model observed for this iteration via
   *  iteration.started.data.resolved_model (event schema v3+). null when no
   *  v3 event has been seen for this row. May be an alias OR a canonical
   *  `claude-*` id (preserved as-is, never coerced to null). */
  resolved_model: ModelValue | null;
  /** Latest resolved reasoning effort observed via
   *  iteration.started/.resumed data.resolved_effort (0.69+ writers). null
   *  when absent (older events / inherited effort). */
  resolved_effort: string | null;
  /** The DAG step_id declared on the iteration.* events (schema v4+), when
   *  present. null for sequential / pre-v4 events. Lets the tree show which
   *  rows belong to a parallel DAG and disambiguate overlapping steps. */
  step_id: string | null;
}

function emptyIterStats(): IterationStats {
  return {
    started_count: 0,
    completed_count: 0,
    halted_count: 0,
    blocked_count: 0,
    last_outcome: null,
    last_event_at: null,
    resolved_model: null,
    resolved_effort: null,
    step_id: null,
  };
}

/** iteration_path → rel extractor for one pipeline, family-aware: a rel is
 *  recognized under `/<name>/steps/` OR (for a family target) under the hub's
 *  `/<hubName>/steps/`. The hub matcher can't over-match target paths — those
 *  contain `/<hubName>/targets/<t>/steps/`, not `/<hubName>/steps/`.
 *
 *  `ownIterations` (the target's own step rels) excludes hub executions of a
 *  step the target OVERRIDES with its own same-basename copy: without it the
 *  hub's copy and the target's copy fold onto the same rel key and the
 *  override row shows foreign runs' stats. The own matcher is tried FIRST,
 *  so the target's own executions always fold. */
function iterationRelMatcher(
  pipelineName: string,
  familyHubName?: string | null,
  ownIterations?: string[],
): (path: string) => string | null {
  const esc = (n: string) => n.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const tailOf = (rel: string) =>
    rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
  const own = new RegExp(`/${esc(pipelineName)}/steps/(.+\\.md)$`);
  const hub =
    familyHubName && familyHubName !== pipelineName
      ? new RegExp(`/${esc(familyHubName)}/steps/(.+\\.md)$`)
      : null;
  const ownTails = new Set((ownIterations ?? []).map(tailOf));
  return (path: string) => {
    const p = path.replaceAll("\\", "/");
    const ownHit = p.match(own);
    if (ownHit) return ownHit[1];
    const hubHit = hub ? p.match(hub) : null;
    if (hubHit && !ownTails.has(tailOf(hubHit[1]))) return hubHit[1];
    return null;
  };
}

// Per-step rollup across the whole journal. The map is keyed by the rel path
// from the pipeline's `steps/` folder INCLUDING any sub-folder prefix (e.g.
// "phase-a/01-foo.md") to avoid collisions when two iterations in different
// sub-folders share a basename. Lookups by basename still work because we
// also write a basename alias when there is no collision — IterationTree
// looks up by tail first, then by full rel.
//
// `iteration.resumed` is intentionally NOT counted as a fresh `started` — a
// resume is the same iteration continuing, not a new attempt.
export function iterationStatsByRel(
  events: PipelineEvent[],
  pipelineName: string,
  familyHubName?: string | null,
  ownIterations?: string[],
): Map<string, IterationStats> {
  const out = new Map<string, IterationStats>();
  const matcher = iterationRelMatcher(pipelineName, familyHubName, ownIterations);
  for (const e of events) {
    if (
      e.type !== "iteration.started" &&
      e.type !== "iteration.resumed" &&
      e.type !== "iteration.completed"
    ) {
      continue;
    }
    const ipath = (e.data as { iteration_path?: string } | undefined)?.iteration_path;
    if (!ipath) continue;
    const rel = matcher(ipath);
    if (!rel) continue;
    // For iteration.resumed, only update an EXISTING entry — don't create
    // a fresh emptyIterStats. Otherwise a resume whose matching .started
    // has scrolled out of the live window produces a ghost step row with
    // zero counts but a populated last_event_at.
    let s = out.get(rel);
    if (!s) {
      if (e.type === "iteration.resumed") continue;
      s = emptyIterStats();
      out.set(rel, s);
    }
    // Capture the DAG step_id (schema v4+) on any iteration.* event for this
    // row. Optional — absent on sequential / pre-v4 events (stays null).
    {
      const sid = (e.data as { step_id?: unknown } | undefined)?.step_id;
      if (typeof sid === "string" && sid.length > 0) s.step_id = sid;
    }
    if (e.type === "iteration.started" || e.type === "iteration.resumed") {
      if (e.type === "iteration.started") s.started_count += 1;
      // Schema v3+ carries data.resolved_model on BOTH .started AND .resumed
      // (a resume may pick a different tier if body.model or step frontmatter
      // changed between runs). Only overwrite when a non-empty value is
      // present so out-of-order SSE delivery, a writer typo, or a v3-from-an-
      // older-daemon stamp carrying null/garbage doesn't blank the last good
      // value. The value may be an alias OR a canonical id — both are kept.
      const data = e.data as { resolved_model?: unknown; resolved_effort?: unknown } | undefined;
      const v = normalizeModel(data?.resolved_model);
      if (v) s.resolved_model = v;
      // Same overwrite-only-when-present rule for the resolved effort (0.69+).
      if (typeof data?.resolved_effort === "string" && data.resolved_effort) {
        s.resolved_effort = data.resolved_effort;
      }
    } else if (e.type === "iteration.completed") {
      const outcome = (e.data as { outcome?: string }).outcome;
      if (outcome === "completed") s.completed_count += 1;
      else if (outcome === "halted") s.halted_count += 1;
      else if (outcome === "blocked-delegating") s.blocked_count += 1;
      s.last_outcome = (outcome as IterationStats["last_outcome"]) ?? s.last_outcome;
    }
    if (!s.last_event_at || s.last_event_at < e.ts) s.last_event_at = e.ts;
  }
  return applyBasenameAliases(out);
}

// --------------------------------------------------------------------
// Per-iteration analytics fold (schema v4 — step_id-keyed, overlap-safe).
//
// Client mirror of `iterationToolStatsForRun` in apps/pipeline-ui/lib.ts.
// Attributes ambient telemetry (`tool.called`, `turn.usage`) to the step
// that produced it. When events carry `step_id` (v4 / DAG-parallel) a step's
// window is [iteration.started, iteration.completed) keyed by step_id, so
// OVERLAPPING parallel steps each accumulate their own stats; an ambient
// event during overlap goes to the most-recently-started still-open step.
// When `step_id` is absent (v1/v2/v3 / sequential) the legacy
// consecutive-`iteration.started`-window behavior is used (a window runs
// until the next iteration.started). The two modes are mixed-safe.
//
// Keep this in lockstep with apps/pipeline-ui/lib.ts:iterationToolStatsForRun.
// --------------------------------------------------------------------

export interface IterationToolStats {
  step_id: string;
  iteration_path: string | null;
  tools_called: number;
  tools_failed: number;
  agents_spawned: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

function emptyIterToolStats(step_id: string, iteration_path: string | null): IterationToolStats {
  return {
    step_id,
    iteration_path,
    tools_called: 0,
    tools_failed: 0,
    agents_spawned: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };
}

interface OpenStepWindow {
  key: string;
  stats: IterationToolStats;
}

function stepIdOf(d: Record<string, unknown>): string | null {
  const v = d.step_id;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Fold ONE run's events into per-step tool/token stats. Pass all events for
 *  a single run_id. Returns one IterationToolStats per step, first-seen order. */
export function iterationToolStatsForRun(events: PipelineEvent[]): IterationToolStats[] {
  const buckets = new Map<string, IterationToolStats>();
  const open: OpenStepWindow[] = [];
  const active = (): OpenStepWindow | null => (open.length > 0 ? open[open.length - 1] : null);

  for (const e of events) {
    const d = e.data ?? {};
    switch (e.type) {
      case "iteration.started":
      case "iteration.resumed": {
        const sid = stepIdOf(d);
        const ipath = (d.iteration_path as string | undefined) ?? null;
        if (sid !== null) {
          let stats = buckets.get(sid);
          if (!stats) {
            stats = emptyIterToolStats(sid, ipath);
            buckets.set(sid, stats);
          } else if (!stats.iteration_path && ipath) {
            stats.iteration_path = ipath;
          }
          if (!open.find((w) => w.key === sid)) open.push({ key: sid, stats });
        } else {
          // Legacy: a new iteration.started closes the prior legacy window.
          for (let i = open.length - 1; i >= 0; i--) {
            if (open[i].key.startsWith(" legacy:")) open.splice(i, 1);
          }
          const key = ` legacy:${ipath ?? "?"}`;
          let stats = buckets.get(key);
          if (!stats) {
            stats = emptyIterToolStats(ipath ?? "(unknown)", ipath);
            buckets.set(key, stats);
          }
          open.push({ key, stats });
        }
        break;
      }
      case "iteration.completed": {
        const sid = stepIdOf(d);
        if (sid !== null) {
          const idx = open.findIndex((w) => w.key === sid);
          if (idx >= 0) open.splice(idx, 1);
        }
        // Legacy mode: completed does NOT close the window (next started does).
        break;
      }
      case "tool.called": {
        const t = active();
        if (!t) break;
        t.stats.tools_called += 1;
        if (d.success === false) t.stats.tools_failed += 1;
        if (d.agent_spawn === true) t.stats.agents_spawned += 1;
        break;
      }
      case "turn.usage": {
        const t = active();
        if (!t) break;
        t.stats.input_tokens += Number(d.input_tokens ?? 0);
        t.stats.output_tokens += Number(d.output_tokens ?? 0);
        t.stats.cache_read_tokens += Number(d.cache_read_tokens ?? 0);
        t.stats.cache_creation_tokens += Number(d.cache_creation_tokens ?? 0);
        break;
      }
    }
  }
  return [...buckets.values()];
}

/** Group a project's events by run_id and fold each run's per-step tool
 *  stats. Mirror of iterationToolStatsByRun in lib.ts. */
export function iterationToolStatsByRun(
  events: PipelineEvent[],
): Map<string, IterationToolStats[]> {
  const perRun = new Map<string, PipelineEvent[]>();
  for (const e of events) {
    const id = e.run_id;
    if (!id) continue;
    let arr = perRun.get(id);
    if (!arr) {
      arr = [];
      perRun.set(id, arr);
    }
    arr.push(e);
  }
  const out = new Map<string, IterationToolStats[]>();
  for (const [id, evs] of perRun) out.set(id, iterationToolStatsForRun(evs));
  return out;
}

// --------------------------------------------------------------------
// View adapter: per-step tool/token stats keyed by the iteration tree's
// rel path. `iterationToolStatsForRun` returns one IterationToolStats per
// step keyed by step_id (DAG) or a legacy iteration window, each carrying
// the originating `iteration_path`. The IterationTree renders rows keyed by
// the rel path from `<pipeline>/steps/` (basename, or sub-folder-prefixed
// rel when a sub-folder is present). This adapter re-keys the per-step fold
// onto that same rel convention so a row can look its stats up by `tail`
// first, then by full `rel` — exactly like `iterationStatsByRel`.
//
// Correctness across modes:
//   • Parallel (step_id): overlapping steps each produced their own
//     IterationToolStats bucket with the right counts; we just project each
//     onto its iteration_path's rel.
//   • Sequential (no step_id): the legacy-window fold already attributed
//     ambient tool/token events to the right step; same projection applies.
// When several buckets resolve to the SAME rel (e.g. a step re-run across
// resume, or two sequential windows for one file) their stats are SUMMED so
// the row shows the run-total for that file — consistent with how the
// per-run StatsPanel aggregates.
// --------------------------------------------------------------------
function addIterToolStats(into: IterationToolStats, from: IterationToolStats): void {
  into.tools_called += from.tools_called;
  into.tools_failed += from.tools_failed;
  into.agents_spawned += from.agents_spawned;
  into.input_tokens += from.input_tokens;
  into.output_tokens += from.output_tokens;
  into.cache_read_tokens += from.cache_read_tokens;
  into.cache_creation_tokens += from.cache_creation_tokens;
}

/** Project one run's per-step tool/token fold onto rel-path keys matching the
 *  iteration tree (`<pipeline>/steps/<rel>`). `runId` selects the run; pass the
 *  whole project event list. Buckets whose iteration_path lies outside this
 *  pipeline's `steps/` folder (or carry no iteration_path) are dropped. Keyed
 *  by full rel AND, when unambiguous, by basename — so callers can look up by
 *  tail first, then full rel, exactly like `iterationStatsByRel`. */
export function iterationToolStatsByRel(
  events: PipelineEvent[],
  runId: string,
  pipelineName: string,
  familyHubName?: string | null,
  ownIterations?: string[],
): Map<string, IterationToolStats> {
  const runEvents = events.filter((e) => e.run_id === runId);
  const buckets = iterationToolStatsForRun(runEvents);
  const matcher = iterationRelMatcher(pipelineName, familyHubName, ownIterations);

  const out = new Map<string, IterationToolStats>();
  for (const b of buckets) {
    if (!b.iteration_path) continue;
    const rel = matcher(b.iteration_path);
    if (!rel) continue;
    const existing = out.get(rel);
    if (existing) {
      addIterToolStats(existing, b);
    } else {
      // Clone so summing across buckets never mutates the source fold's
      // objects (they may be referenced elsewhere by the same call).
      out.set(rel, { ...b, step_id: b.step_id, iteration_path: rel });
    }
  }
  return applyBasenameAliases(out);
}

export interface PipelineAggregate {
  total_runs: number;
  active_runs: number;
  completed_runs: number;
  halted_runs: number;
  last_event_at: string | null;
}

export function aggregateRunsForPipeline(
  runs: RunState[],
  pipelineName: string,
): PipelineAggregate {
  let total = 0;
  let active = 0;
  let done = 0;
  let halted = 0;
  let last: string | null = null;
  // Walk children too so blocker sub-runs of the same pipeline name count.
  const flatten = (rs: RunState[]): RunState[] =>
    rs.flatMap((r) => [r, ...flatten(r.children)]);
  for (const r of flatten(runs)) {
    if (r.pipeline_name !== pipelineName) continue;
    total += 1;
    if (isActive(r.status)) active += 1;
    else if (r.status === "completed") done += 1;
    else if (r.status === "halted") halted += 1;
    if (!last || r.last_event_at > last) last = r.last_event_at;
  }
  return {
    total_runs: total,
    active_runs: active,
    completed_runs: done,
    halted_runs: halted,
    last_event_at: last,
  };
}
