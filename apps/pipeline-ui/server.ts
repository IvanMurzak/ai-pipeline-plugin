#!/usr/bin/env bun
/**
 * Pipeline UI daemon.
 *
 * Single shared HTTP server (one per machine, one port) that:
 *   - Maintains a registry of consumer projects in ~/.claude/pipeline-ui/projects.json
 *   - Tails each project's .claude/pipeline/.runtime/events.jsonl
 *   - Watches each project's .claude/pipeline/** for file changes
 *   - Broadcasts a unified event stream via Server-Sent Events
 *   - Serves the React UI bundle from ./dist
 *
 * Lifecycle: spawned on demand by the SessionStart hook (or by
 * `/pipeline:ui`). Idle-shutdown after PIPELINE_UI_IDLE_MINUTES of no
 * events AND no SSE clients.
 *
 * Stateless re: pipelines — every snapshot is rebuildable from the
 * journal. Killing the daemon loses nothing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, watch as fsWatch, statSync, unlinkSync, appendFileSync, renameSync, readdirSync, openSync, closeSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  capMap,
  listJournalShards,
  normalizePathForCompare,
  parseIterationSections,
  pickNewestPluginSibling,
  readJournalLines,
  readJournalWithArchives,
  resolvePendingUpdate,
  resolveProjectRootFromCwd,
  scanPipelines as scanPipelinesRaw,
  stepTimingsForRun,
  streamJournalLines,
  summarizeRuns,
  summarizeRunsFromShards,
  toEpochOrNull,
  pipelineUiTranscriptsEnabled,
  type JournalEvent,
  type PipelineInfo,
  type RunSummary,
  type StepTiming,
} from "./lib.ts";
import {
  FrontmatterCache,
  resolveChatEffort,
  resolveChatModel,
} from "./model-resolver.ts";
import {
  handleListTranscripts,
  handleReadTranscript,
} from "./transcripts.ts";
import { MirrorService, defaultBindingsPath } from "./mirror.ts";
import {
  handleListPipelines,
  handleLaunchRun,
  handleAnswerRun,
  handleListDriveRuns,
  invalidateCatalog,
  findDriveUsage,
  stopDriveRun,
} from "./launcher.ts";
import { resolveHostConfig, checkAuth, maybeSetTokenCookie } from "./auth.ts";
import {
  handleEditorList,
  handleEditorRead,
  handleEditorWrite,
  handleEditorDelete,
  handleEditorCreateStep,
  handleEditorValidate,
} from "./editor.ts";
import { handleTranscribe, handleTranscribeStatus } from "./transcribe.ts";
import { backfillProject } from "../pipeline-cli/src/lib/stats-backfill";
import { findRunsFiles, parseRunRecords } from "../pipeline-cli/src/lib/stats";
import { handleStartAiFix, handleGetAiFixJob } from "./aifix.ts";
import {
  collectRunBreakdown,
  collectRunToolFailures,
  detectPendingInterrupt,
  findTranscriptByRunId,
  foldRunStatsFromTranscript,
  indexRunTranscripts,
  emptyTranscriptRunStats,
  type RunBreakdown,
  type ToolFailure,
  type TranscriptRunStats,
  type RunTranscriptRef,
} from "./transcript-stats.ts";

// scanPipelines wrapper with a short TTL cache keyed by project root. The
// underlying walk is O(N) in the pipeline tree and was being run on every
// /api/state, /api/pipeline, /api/iteration, AND every file.changed-induced
// refresh. The cache is invalidated explicitly when the pipeline-tree
// watcher fires, so it should never serve actually-stale data — but if the
// watcher misses (Windows fsWatch oddities), the TTL caps the staleness.
const PIPELINE_CACHE_TTL_MS = 5000;
const pipelineCache = new Map<
  string,
  { at: number; data: PipelineInfo[] }
>();

function scanPipelines(projectRoot: string): PipelineInfo[] {
  const hit = pipelineCache.get(projectRoot);
  if (hit && Date.now() - hit.at < PIPELINE_CACHE_TTL_MS) return hit.data;
  const data = scanPipelinesRaw(projectRoot);
  pipelineCache.set(projectRoot, { at: Date.now(), data });
  return data;
}

function invalidatePipelineCache(projectRoot: string): void {
  pipelineCache.delete(projectRoot);
  // The launcher's plan catalog derives from the same files.
  invalidateCatalog(projectRoot);
}

/** Resolve a pipeline by name, disambiguated by root when the caller knows
 *  it. pipeline_name is a folder BASENAME and legally collides (same-named
 *  targets under two hubs, same name in two categories) — a root match wins;
 *  name-only falls back to first-match for older clients. */
function findPipelineByNameAndRoot(
  pipelines: PipelineInfo[],
  name: string,
  root: string | null,
): PipelineInfo | undefined {
  if (root) {
    const norm = normalizePathForCompare(root);
    const byRoot = pipelines.find((p) => normalizePathForCompare(p.pipeline_root) === norm);
    if (byRoot) return byRoot;
  }
  return pipelines.find((p) => p.pipeline_name === name);
}

// Shared frontmatter cache for /api/chat's per-pipeline / per-step model
// resolution. Keyed by absolute file path; mtime-aware so a stale entry
// gets replaced on the next read even if the file.changed watcher missed
// the event. Invalidated explicitly when the pipeline-tree watcher fires
// for a project (same trigger as invalidatePipelineCache).
const frontmatterCache = new FrontmatterCache();

// /api/runs reads the FULL events.jsonl + every rotated archive
// synchronously. Without a short cache, a hot pipeline emitting
// pipeline.{started,completed,halted} in rapid succession would trigger
// one full read per event (via useProjectState.refreshSummaries) and
// stall the daemon's event loop. The cache key includes the limit so
// different /api/runs?limit=N callers don't collide.
const RUNS_CACHE_TTL_MS = 1500;
const runsCache = new Map<
  string,
  { at: number; data: RunSummary[] }
>();

function invalidateRunsCache(projectRoot: string): void {
  for (const key of runsCache.keys()) {
    if (key.startsWith(`${projectRoot}|`)) runsCache.delete(key);
  }
  runSummariesCache.delete(projectRoot);
}

// --------------------------------------------------------------------
// Per-run transcript-folded stats (/api/run-stats).
//
// The hook-emitted tool.called / turn.usage events are an unreliable stats
// source (turn.usage tails the MAIN session transcript, missing the subagent
// tokens entirely; tool.called leaks ~half its events to run_id=null). The only
// COMPLETE source is the raw transcripts — the manager's + every step-executor
// subagent's — folded over the run's time window. transcript-stats.ts does the
// fold; here we resolve which transcript a run owns (via the mirror-binding
// index) and its window (via the run summary), then cache.
//
// Caching: a COMPLETED/HALTED run is immutable, so its stats are cached
// indefinitely; a still-running run is recomputed on a short TTL.
// --------------------------------------------------------------------
const RUN_STATS_TTL_MS = 4000;
// The daemon is a long-lived shared process; terminal-run stats are cached
// indefinitely (immutable), so bound the map and evict oldest (FIFO — Map keeps
// insertion order) to keep the optimization without unbounded heap growth.
const RUN_STATS_CACHE_MAX = 500;
/** Upper bound on ids honoured by /api/run-stats-batch — the list views ask for
 *  a page, never the whole history. */
const RUN_STATS_BATCH_MAX = 100;
const runStatsCache = new Map<
  string,
  { at: number; terminal: boolean; data: TranscriptRunStats }
>();

/** Parse the (large, append-only, machine-GLOBAL) bindings file into a per-run
 *  transcript map, scoped to ONE project — run_ids are short (12 hex) and only
 *  unique within a project, so an index filtered by project_root prevents a
 *  cross-project run_id collision from resolving to the wrong transcript. A
 *  binding is immutable once written (its transcript_path + earliest start_ts
 *  never change), so once a run is in the index we never reparse for it — that
 *  keeps the steady-state poll of a live run off the file entirely; we only
 *  re-read (on a size change) when asked for a run we haven't indexed yet. */
const bindingsIndexCache = new Map<string, { size: number; idx: Map<string, RunTranscriptRef> }>();
function bindingsIndex(projectRoot: string, knownRunId?: string): Map<string, RunTranscriptRef> {
  const cached = bindingsIndexCache.get(projectRoot);
  if (knownRunId && cached?.idx.has(knownRunId)) return cached.idx;
  const p = defaultBindingsPath();
  if (!existsSync(p)) return cached?.idx ?? new Map();
  let size = 0;
  try {
    size = statSync(p).size;
  } catch {
    return cached?.idx ?? new Map();
  }
  if (cached && cached.size === size) return cached.idx;
  let text = "";
  try {
    text = readFileSync(p, "utf-8");
  } catch {
    return cached?.idx ?? new Map();
  }
  const idx = indexRunTranscripts(text, projectRoot);
  bindingsIndexCache.set(projectRoot, { size, idx });
  return idx;
}

// All-runs summary fold, TTL-cached per project (own cache so /api/run-stats
// doesn't piggyback on the limit-keyed runsCache via a magic key). Folds the
// full journal+archives, so it's the costly part — computeRunStats only reaches
// it on a stats-cache MISS. invalidateRunsCache clears it alongside runsCache.
const RUN_SUMMARIES_TTL_MS = 6000;
const runSummariesCache = new Map<string, { at: number; data: RunSummary[] }>();
function allRunSummaries(entry: ProjectEntry): RunSummary[] {
  const hit = runSummariesCache.get(entry.project_root);
  if (hit && Date.now() - hit.at < RUN_SUMMARIES_TTL_MS) return hit.data;
  const data = summarizeRunsFromShards(listJournalShards(journalPath(entry)));
  runSummariesCache.set(entry.project_root, { at: Date.now(), data });
  return data;
}

// run_id → transcript path found by findTranscriptByRunId (positive hits are
// stable for the run's lifetime; negatives retried after a short TTL so a
// still-materializing transcript is picked up without re-scanning every 4s poll).
const transcriptScanCache = new Map<string, { path: string | null; at: number }>();
const TRANSCRIPT_SCAN_NEGATIVE_TTL_MS = 15_000;

/** The transcript-resolution ladder shared by /api/run-stats and
 *  /api/run-failures: run summary → window, then mirror binding →
 *  run_id-mention scan for the transcript path. */
function resolveRunTranscript(
  entry: ProjectEntry,
  runId: string,
): { transcriptPath: string | null; startIso: string | null; endIso: string | null; terminal: boolean } {
  const cacheKey = `${entry.project_root}|${runId}`;
  const summary = allRunSummaries(entry).find((r) => r.run_id === runId) ?? null;
  const terminal = summary?.status === "completed" || summary?.status === "halted";
  if (!TRANSCRIPTS_ENABLED) {
    // PIPELINE_UI_TRANSCRIPTS off — never read a Claude Code transcript for
    // analytics. Resolve NO transcript (and skip the run_id-mention scan) so
    // run-stats/-failures/-breakdown fold nothing; the window is still returned
    // for callers that want it. The UI degrades to basic events (+ drive-
    // envelope usage for headless runs), exactly as a run with no transcript.
    const startIso = summary?.started_at ?? null;
    const endIso = terminal ? (summary?.last_event_at ?? null) : null;
    return { transcriptPath: null, startIso, endIso, terminal };
  }
  const ref = bindingsIndex(entry.project_root, runId).get(runId);
  // Window: the run's lifecycle span. Use the event-derived start when present,
  // else the binding's start_ts. End is open (null) for a live run so its
  // still-growing transcript keeps counting.
  const startIso = summary?.started_at ?? ref?.start_ts ?? null;
  const endIso = terminal ? (summary?.last_event_at ?? null) : null;
  // Transcript resolution ladder: mirror binding first; when the binding is
  // absent OR carries transcript_path:null (register-mirror-binding without
  // CLAUDE_SESSION_ID writes those), fall back to scanning the project's
  // transcripts dir for the session that actually mentions this run_id.
  let transcriptPath = ref?.transcript_path ?? null;
  if (!transcriptPath) {
    const scanHit = transcriptScanCache.get(cacheKey);
    if (scanHit && (scanHit.path !== null || Date.now() - scanHit.at < TRANSCRIPT_SCAN_NEGATIVE_TTL_MS)) {
      transcriptPath = scanHit.path;
    } else {
      transcriptPath = findTranscriptByRunId(entry.project_root, runId, startIso, endIso);
      transcriptScanCache.set(cacheKey, { path: transcriptPath, at: Date.now() });
      capMap(transcriptScanCache, RUN_STATS_CACHE_MAX);
    }
  }
  return { transcriptPath, startIso, endIso, terminal };
}

function computeRunStats(entry: ProjectEntry, runId: string): TranscriptRunStats {
  // Project-scoped key — run_ids are only unique within a project.
  const cacheKey = `${entry.project_root}|${runId}`;
  // Cache-first: a terminal run's transcript is immutable (cached forever); a
  // live run is reused within the TTL. Both short-circuit BEFORE the expensive
  // journal fold + bindings read below.
  const cached = runStatsCache.get(cacheKey);
  if (cached && (cached.terminal || Date.now() - cached.at < RUN_STATS_TTL_MS)) {
    return cached.data;
  }
  const { transcriptPath, startIso, endIso, terminal } = resolveRunTranscript(entry, runId);
  let data = transcriptPath
    ? foldRunStatsFromTranscript(transcriptPath, startIso, endIso)
    : emptyTranscriptRunStats();
  // Headless (drive-launched) runs have no bound transcript, but drive folds
  // the claude-envelope usage into .runtime/<run>/usage.json — surface that
  // instead of zeros (with the cost, which transcripts can't provide).
  if (data.input_tokens === 0 && data.output_tokens === 0) {
    const usage = findDriveUsage(entry.project_root, runId);
    if (usage && (usage.input || usage.output || usage.cost_usd)) {
      data = {
        ...data,
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_tokens: usage.cache_read,
        cache_creation_tokens: usage.cache_creation,
        cost_usd: usage.cost_usd,
      };
    }
  }
  runStatsCache.set(cacheKey, { at: Date.now(), terminal, data });
  capMap(runStatsCache, RUN_STATS_CACHE_MAX);
  return data;
}

// Per-run failure detail (/api/run-failures). Fetched on demand (the user
// clicked the FAIL tile), so the cache exists only to absorb double-clicks
// and re-opens: terminal runs cache indefinitely (immutable transcript),
// live runs on the same short TTL as run-stats.
interface RunFailuresResponse {
  run_id: string;
  failures: ToolFailure[];
  truncated: boolean;
  /** false when no transcript could be resolved for the run — the UI should
   *  say "no transcript" rather than "no failures". */
  transcript_found: boolean;
}
const runFailuresCache = new Map<string, { at: number; terminal: boolean; data: RunFailuresResponse }>();

// Per-run TOOLS/AGENTS breakdown (/api/run-breakdown) — same on-demand +
// cache discipline as run-failures (terminal-with-transcript forever, else
// short TTL so a late-materializing transcript is picked up).
interface RunBreakdownResponse extends RunBreakdown {
  run_id: string;
  transcript_found: boolean;
}
const runBreakdownCache = new Map<string, { at: number; terminal: boolean; data: RunBreakdownResponse }>();

function computeRunBreakdown(entry: ProjectEntry, runId: string): RunBreakdownResponse {
  const cacheKey = `${entry.project_root}|${runId}`;
  const cached = runBreakdownCache.get(cacheKey);
  if (cached && (cached.terminal || Date.now() - cached.at < RUN_STATS_TTL_MS)) {
    return cached.data;
  }
  const { transcriptPath, startIso, endIso, terminal } = resolveRunTranscript(entry, runId);
  const data: RunBreakdownResponse = {
    run_id: runId,
    transcript_found: transcriptPath !== null,
    ...collectRunBreakdown(transcriptPath, startIso, endIso),
  };
  runBreakdownCache.set(cacheKey, {
    at: Date.now(),
    terminal: terminal && transcriptPath !== null,
    data,
  });
  capMap(runBreakdownCache, RUN_STATS_CACHE_MAX);
  return data;
}

/** One step's slice of the run's transcript fold (design 07 — the per-step
 *  numbers the iteration tree and the step detail render). */
export interface RunStepStats {
  step_id: string | null;
  iteration_path: string;
  /** Path after the last `/steps/` segment — the iteration tree's key. */
  rel: string | null;
  stats: TranscriptRunStats;
}

interface RunStepStatsResponse {
  run_id: string;
  transcript_found: boolean;
  steps: RunStepStats[];
}

const runStepStatsCache = new Map<
  string,
  { at: number; terminal: boolean; data: RunStepStatsResponse }
>();

/**
 * Per-step transcript fold: the run's own step windows (event-derived, the
 * same `stepTimingsForRun` the timings UI uses) sliced against the run's
 * resolved transcript.
 *
 * Why slice rather than sum the client's per-step event counts: the
 * tool.called/turn.usage hook events undercount badly (they leak run-id
 * correlation and never see subagent tokens), which is the whole reason
 * /api/run-stats exists. This gives the per-step surfaces the same
 * transcript-grade numbers the run-level panel already shows.
 *
 * A step whose window is not closed yet (still running) folds against an OPEN
 * end, so a live step's numbers grow as it works instead of reading zero.
 */
function computeRunStepStats(entry: ProjectEntry, runId: string): RunStepStatsResponse {
  const cacheKey = `${entry.project_root}|${runId}`;
  const cached = runStepStatsCache.get(cacheKey);
  if (cached && (cached.terminal || Date.now() - cached.at < RUN_STATS_TTL_MS)) {
    return cached.data;
  }
  const { transcriptPath, terminal } = resolveRunTranscript(entry, runId);
  const events = readJournalWithArchives(journalPath(entry)).filter((e) => e.run_id === runId);
  const timings = stepTimingsForRun(events);

  const steps: RunStepStats[] = timings.map((t) => {
    // Window: the step's first start → its last close. `open_since` means the
    // step is still running, so the end stays OPEN (null) rather than being
    // clamped to a duration that hasn't finished accruing.
    const startIso = t.first_started_at;
    const startMs = toEpochOrNull(startIso);
    const endIso =
      t.open_since !== null || startMs === null ? null : new Date(startMs + t.duration_ms).toISOString();
    return {
      step_id: t.step_id,
      iteration_path: t.iteration_path,
      rel: t.rel,
      stats: transcriptPath
        ? foldRunStatsFromTranscript(transcriptPath, startIso, endIso)
        : emptyTranscriptRunStats(),
    };
  });

  const data: RunStepStatsResponse = { run_id: runId, transcript_found: transcriptPath !== null, steps };
  runStepStatsCache.set(cacheKey, { at: Date.now(), terminal: terminal && transcriptPath !== null, data });
  capMap(runStepStatsCache, RUN_STATS_CACHE_MAX);
  return data;
}

function computeRunFailures(entry: ProjectEntry, runId: string): RunFailuresResponse {
  const cacheKey = `${entry.project_root}|${runId}`;
  const cached = runFailuresCache.get(cacheKey);
  if (cached && (cached.terminal || Date.now() - cached.at < RUN_STATS_TTL_MS)) {
    return cached.data;
  }
  const { transcriptPath, startIso, endIso, terminal } = resolveRunTranscript(entry, runId);
  const { failures, truncated } = collectRunToolFailures(transcriptPath, startIso, endIso);
  const data: RunFailuresResponse = {
    run_id: runId,
    failures,
    truncated,
    transcript_found: transcriptPath !== null,
  };
  // A terminal run with NO resolved transcript must stay on the short TTL:
  // the binding/scan can materialize moments after run end (that's why the
  // transcript scan has a 15 s negative TTL), and pinning the negative would
  // show "no transcript" forever.
  runFailuresCache.set(cacheKey, {
    at: Date.now(),
    terminal: terminal && transcriptPath !== null,
    data,
  });
  capMap(runFailuresCache, RUN_STATS_CACHE_MAX);
  return data;
}

// --------------------------------------------------------------------
// Per-step wall-clock timings (/api/run-steps).
//
// Folds ONE run's events out of the full journal history (all shards) via
// lib.ts stepTimingsForRun, so runs whose events scrolled out of the live
// 500-event window still show their per-step breakdown. Same caching
// discipline as run-stats: terminal runs forever, live runs on a TTL.
// --------------------------------------------------------------------
interface RunStepsResponse {
  run_id: string;
  status: RunSummary["status"] | "unknown";
  started_at: string | null;
  last_event_at: string | null;
  steps: StepTiming[];
}

const runStepsCache = new Map<string, { at: number; terminal: boolean; sig: string; data: RunStepsResponse }>();

/** Cheap change-detector for the journal: shard paths + sizes. The journal is
 *  append-only, so an unchanged signature means an unchanged fold — this is
 *  what keeps the 4 s live poll from re-reading multi-MB shards for a run
 *  that is parked (no new events). */
function journalSignature(shards: string[]): string {
  return shards
    .map((p) => {
      try {
        return `${p}:${statSync(p).size}`;
      } catch {
        return `${p}:?`;
      }
    })
    .join(";");
}

function computeRunSteps(entry: ProjectEntry, runId: string): RunStepsResponse {
  const cacheKey = `${entry.project_root}|${runId}`;
  const cached = runStepsCache.get(cacheKey);
  if (cached && (cached.terminal || Date.now() - cached.at < RUN_STATS_TTL_MS)) {
    return cached.data;
  }
  const shards = listJournalShards(journalPath(entry));
  const sig = journalSignature(shards);
  if (cached && cached.sig === sig) {
    cached.at = Date.now();
    return cached.data;
  }
  const summary = allRunSummaries(entry).find((r) => r.run_id === runId) ?? null;
  const terminal = summary?.status === "completed" || summary?.status === "halted";
  const runEvents: JournalEvent[] = [];
  for (const shard of shards) {
    streamJournalLines(shard, (ev) => {
      if (ev.run_id === runId) runEvents.push(ev);
    });
  }
  const data: RunStepsResponse = {
    run_id: runId,
    status: summary?.status ?? "unknown",
    started_at: summary?.started_at ?? null,
    last_event_at: summary?.last_event_at ?? null,
    steps: stepTimingsForRun(runEvents),
  };
  runStepsCache.set(cacheKey, { at: Date.now(), terminal, sig, data });
  capMap(runStepsCache, RUN_STATS_CACHE_MAX);
  return data;
}

// --------------------------------------------------------------------
// Config
// --------------------------------------------------------------------

// Schema v4: adds optional `step_id` on iteration.started / .resumed /
// .completed (the DAG/parallel step identity, used for overlap-safe
// per-iteration folding). v3 added optional `default_model` on
// pipeline.started and `resolved_model` on iteration.started (both
// shorthand strings or null). v1, v2, and v3 events are still parsed —
// the new fields are optional and absent in older events; the fold
// treats absent step_id as "use the consecutive-iteration.started window".
const SCHEMA_VERSION = 4;
const IDLE_MINUTES = Number(process.env.PIPELINE_UI_IDLE_MINUTES ?? 60);
const DEBUG = process.env.PIPELINE_UI_DEBUG === "1";
// Transcript mirroring/fold opt-out (PIPELINE_UI_TRANSCRIPTS, default ON).
// Snapshotted once at boot — a daemon is a long-lived shared process, so
// changing this takes effect on the next daemon start (same as every other
// daemon env knob above). When OFF: the MirrorService never tails a transcript
// into a chat panel, and the per-run transcript-folded token/tool analytics
// (/api/run-stats|-failures|-breakdown) resolve no transcript and return empty
// — the UI + basic lifecycle events keep working. Orthogonal to
// PIPELINE_UI_ENABLED (the master switch) and PIPELINE_STATS_ENABLED.
const TRANSCRIPTS_ENABLED = pipelineUiTranscriptsEnabled(process.env);
// Interrupt watchdog (design 06, edge case E5): an Esc fires no hook, so a run
// whose terminal session stays alive renders `running` forever — the pid
// lockfile is healthy and no manager.stopped ever arrives. Default ON; same
// boot-snapshot posture as every other daemon knob. Off ⇒ the sweep is never
// called and no transcript tail is read for it.
const WATCHDOG_ENABLED = (() => {
  const v = (process.env.PIPELINE_UI_WATCHDOG_ENABLED ?? "").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
})();
/** A run must have been silent this long before we tail its transcript — an
 *  actively-emitting run never pays the scan. */
const WATCHDOG_QUIET_MS = 30_000;
// Host + token come from PIPELINE_UI_HOST / PIPELINE_UI_TOKEN. Default stays
// loopback-only; a wider bind (phone access) REQUIRES a token — the UI can
// launch runs and edit pipelines, so exposing it unauthenticated would hand
// those capabilities to the local network. resolveHostConfig enforces the
// fallback; the warning is logged at boot.
const HOST_CONFIG = resolveHostConfig(process.env);
const HOST = HOST_CONFIG.host;
const AUTH_TOKEN = HOST_CONFIG.token;
const PORT_BAND_LOW = 49152;
const PORT_BAND_HIGH = 65535;

// Per-user daemon state dir. PIPELINE_UI_HOME overrides it — used by tests to
// isolate each daemon-spawning suite onto its own lock + seed port (the seed
// port is derived from HOME_DIR, so a distinct home means a distinct port and
// zero cross-suite collision when the runner executes test files in parallel).
const HOME_DIR = process.env.PIPELINE_UI_HOME
  ? resolve(process.env.PIPELINE_UI_HOME)
  : join(homedir(), ".claude", "pipeline-ui");
const LOCK_PATH = join(HOME_DIR, "daemon.lock");
const REGISTRY_PATH = join(HOME_DIR, "projects.json");
const DIST_DIR = join(import.meta.dir, "dist");

// The plugin install directory this daemon was launched from. Used by the
// version-reconciliation protocol: the SessionStart hook compares its own
// CLAUDE_PLUGIN_ROOT against this value and POSTs /api/restart-to when they
// diverge (i.e. the user upgraded/downgraded the plugin since this daemon
// booted). server.ts lives at <plugin_root>/apps/pipeline-ui/server.ts, so
// the plugin root is two levels up from import.meta.dir.
const PLUGIN_ROOT = resolve(import.meta.dir, "..", "..");

function pluginVersionAt(pluginRoot: string): string {
  try {
    const manifest = JSON.parse(
      readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf-8"),
    );
    return manifest.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function readPluginVersion(): string {
  return pluginVersionAt(PLUGIN_ROOT);
}

// Declared after PLUGIN_ROOT + readPluginVersion so the initializer doesn't
// touch PLUGIN_ROOT during its temporal dead zone (module-eval order matters).
const PLUGIN_VERSION = readPluginVersion();

// normalizePathForCompare is imported from ./lib.ts so the daemon, the picker,
// and tests share one definition. It MUST also match the copy in
// hooks/pipeline_ui_relay.ts (the hook can't import from the app dir).

function log(msg: string): void {
  if (DEBUG) console.error(`[pipeline-ui] ${msg}`);
}

// --------------------------------------------------------------------
// Project identity
// --------------------------------------------------------------------

function projectId(projectRoot: string): string {
  return createHash("sha1").update(projectRoot).digest("hex").slice(0, 12);
}

interface ProjectEntry {
  project_id: string;
  project_root: string;
  project_name: string;
  first_seen: string;
  last_seen: string;
  /** Last-known worktree path for this project, if any. Captured at register
   *  time from /api/register-cwd's worktree-resolution result so events emitted
   *  by the daemon itself (e.g. from /api/chat) can attribute the worktree
   *  correctly instead of writing `worktree: null`. */
  worktree?: string | null;
}

function loadRegistry(): Record<string, ProjectEntry> {
  if (!existsSync(REGISTRY_PATH)) return {};
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  } catch (e) {
    log(`registry corrupt, starting fresh: ${e}`);
    return {};
  }
}

function saveRegistry(reg: Record<string, ProjectEntry>): void {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

const registry: Record<string, ProjectEntry> = loadRegistry();

// Project lookup callback passed into modules that need to map project_id →
// ProjectEntry without sharing the registry directly. Keeps the modules
// (e.g. ./transcripts.ts) decoupled from the daemon's mutable state.
const getProject = (pid: string) => registry[pid];

function registerProject(
  projectRoot: string,
  projectName?: string,
  worktree?: string | null,
): ProjectEntry {
  const pid = projectId(projectRoot);
  const now = new Date().toISOString();
  const existing = registry[pid];
  if (existing) {
    existing.last_seen = now;
    // Last-writer wins on worktree, INCLUDING explicit null. Callers
    // (`pipeline event`, pipeline_ui_relay.ts, /api/register*) resolve the
    // worktree from their cwd and always send a meaningful value — null
    // when invoked from main-repo cwd, a path when inside a worktree. A
    // stale worktree pinned from an earlier session is worse than a
    // momentary mis-attribution from concurrent sessions: it persists
    // forever and misattributes every /api/chat event for the lifetime
    // of the daemon. Use `undefined` (parameter omitted) to mean "I have
    // no opinion, keep current value"; pass `null` explicitly to clear.
    if (worktree !== undefined) existing.worktree = worktree;
    saveRegistry(registry);
    if (!projectWatchers.has(pid)) attachProjectWatchers(existing);
    return existing;
  }
  const entry: ProjectEntry = {
    project_id: pid,
    project_root: projectRoot,
    project_name: projectName ?? basename(projectRoot),
    first_seen: now,
    last_seen: now,
    worktree: worktree ?? null,
  };
  registry[pid] = entry;
  saveRegistry(registry);
  attachProjectWatchers(entry);
  log(`registered project ${entry.project_name} (${pid})`);
  return entry;
}

// --------------------------------------------------------------------
// Event journal tailing + file watcher
// --------------------------------------------------------------------

type SSEMessage = { type: string; data: unknown };

const sseClients = new Set<(msg: SSEMessage) => void>();
let lastEventAt = Date.now();

function broadcast(msg: SSEMessage): void {
  lastEventAt = Date.now();
  for (const send of sseClients) {
    try {
      send(msg);
    } catch (e) {
      log(`broadcast to client failed: ${e}`);
    }
  }
}

interface JournalTail {
  path: string;
  offset: number;
  partial: string;
}

const journalTails = new Map<string, JournalTail>();        // pid → tail state
const projectWatchers = new Map<string, ReturnType<typeof fsWatch>[]>();

// MirrorService is created lazily on daemon boot — see bootDaemon below.
// Forward-declared here so readJournalIncremental can notify it of
// pipeline lifecycle events without a circular import.
let mirrorService: MirrorService | null = null;

// Throttle for last_seen disk persistence. The in-memory bump is
// always applied (so /api/projects + SSE see fresh timestamps), but
// saveRegistry rewrites the entire projects.json — doing it on every
// parsed batch would write multiple times per second.
const lastSeenPersistedAt = new Map<string, number>();      // pid → ms
const LAST_SEEN_PERSIST_INTERVAL_MS = 60_000;

function journalPath(entry: ProjectEntry): string {
  return join(entry.project_root, ".claude", "pipeline", ".runtime", "events.jsonl");
}

function readJournalIncremental(entry: ProjectEntry): void {
  const path = journalPath(entry);
  if (!existsSync(path)) return;
  const pid = entry.project_id;
  let tail = journalTails.get(pid);
  if (!tail) {
    tail = { path, offset: 0, partial: "" };
    journalTails.set(pid, tail);
  }
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size < tail.offset) {
    // File was rotated/truncated — restart from 0.
    tail.offset = 0;
    tail.partial = "";
  }
  if (size === tail.offset) return;

  // Reserve the byte range and advance the offset SYNCHRONOUSLY before the
  // async slice read resolves. Without this, concurrent triggers (fsWatch +
  // 2s polling + initial-read on attach) all see the same offset and broadcast
  // the same events multiple times — which is what caused the duplicate
  // events some browser tabs saw.
  const from = tail.offset;
  const to = size;
  const carryIn = tail.partial;
  tail.offset = to;
  tail.partial = "";

  const fd = Bun.file(path);
  fd.slice(from, to)
    .text()
    .then((chunk) => {
      const buf = carryIn + chunk;
      const lines = buf.split("\n");
      const carryOut = lines.pop() ?? "";
      // Stash any unterminated trailing fragment for the next read. If a
      // concurrent read advanced the offset past us we'll just lose this
      // fragment, but `pipeline event` only ever closes the file after writing
      // a newline-terminated line so a non-empty carryOut is rare in practice.
      if (carryOut && !tail!.partial) tail!.partial = carryOut;
      let parsedAny = false;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          ev._project_id = pid;
          // Any new journal line can change /api/runs output (new
          // lifecycle event, new tool.called bumping stats, etc.) — drop
          // the cached summaries so the next call regenerates.
          invalidateRunsCache(entry.project_root);
          broadcast({ type: "journal", data: ev });
          // Let the MirrorService close bindings whose run completed/halted
          // so it stops tailing the executor's transcript. No-op when the
          // service is not yet started (boot ordering safety).
          mirrorService?.onJournalEvent(ev);
          parsedAny = true;
        } catch (e) {
          log(`malformed event line in ${pid}: ${e}`);
        }
      }
      // Bump last_seen so the ProjectPicker's "X ago" reflects actual
      // journal activity. analytics_relay.ts writes directly to the
      // journal without pinging /api/register, so without this, an
      // actively-emitting project shows stale last_seen from the last
      // SessionStart hook hours ago.
      //
      // Persist with throttling — saveRegistry rewrites the entire
      // projects.json synchronously; doing it per parsed batch (which
      // fires on fsWatch + the 400ms poller + each initial attach)
      // would write the registry many times per second on a busy
      // machine. The in-memory bump is unconditional so /api/projects
      // and the SSE broadcast see the fresh timestamp instantly;
      // persistence is debounced.
      //
      // Also broadcast a `project.updated` SSE event so the picker can
      // refresh the "X ago" label without waiting for a new
      // project.registered or page reload.
      if (parsedAny) {
        const now = Date.now();
        entry.last_seen = new Date(now).toISOString();
        if (now - (lastSeenPersistedAt.get(pid) ?? 0) >= LAST_SEEN_PERSIST_INTERVAL_MS) {
          lastSeenPersistedAt.set(pid, now);
          saveRegistry(registry);
        }
        broadcast({ type: "project.updated", data: entry });
      }
    })
    .catch((e) => log(`tail read failed for ${pid}: ${e}`));
}

function attachProjectWatchers(entry: ProjectEntry): void {
  const pid = entry.project_id;
  const pipelineDir = join(entry.project_root, ".claude", "pipeline");
  const runtimeDir = join(pipelineDir, ".runtime");

  // Make sure runtime dir exists so we can watch it.
  try {
    mkdirSync(runtimeDir, { recursive: true });
  } catch (e) {
    log(`cannot ensure runtime dir for ${pid}: ${e}`);
  }

  const watchers: ReturnType<typeof fsWatch>[] = [];

  // Watch the journal directory for events.jsonl changes.
  try {
    const w1 = fsWatch(runtimeDir, { persistent: false }, (_evt, fname) => {
      if (fname && (fname === "events.jsonl" || fname.toString().endsWith(".jsonl"))) {
        readJournalIncremental(entry);
      }
    });
    watchers.push(w1);
  } catch (e) {
    log(`journal watch failed for ${pid}: ${e}`);
  }

  // Watch the pipeline tree for structural changes (recursive on Win/Mac).
  if (existsSync(pipelineDir)) {
    try {
      const w2 = fsWatch(
        pipelineDir,
        { persistent: false, recursive: process.platform !== "linux" },
        (_evt, fname) => {
          if (!fname) return;
          const f = fname.toString();
          // Filter out runtime/measurement artifacts to avoid loops and event
          // storms. Checked as path SEGMENTS, not a top-level prefix: headless
          // runs write under <pipeline_root>/.runtime/<run>/ (records, session
          // files, drive.log, usage.json — the daemon itself appends some of
          // them), and treating each of those writes as a "pipeline changed"
          // event invalidated every cache and refetched every browser per
          // output chunk for the whole duration of a run.
          const segs = f.split(/[\\/]/);
          if (segs.some((s) => s === ".runtime" || s === ".stats" || s === ".feedback")) return;
          // Any pipeline-tree change invalidates the scanPipelines cache for
          // this project — otherwise the UI would keep showing pre-edit
          // manifests until the TTL expires. Also invalidate the
          // per-file frontmatter cache so /api/chat's model resolution
          // re-reads PIPELINE.md / steps/*.md on the next chat call.
          invalidatePipelineCache(entry.project_root);
          frontmatterCache.invalidatePrefix(entry.project_root);
          broadcast({
            type: "file.changed",
            data: { project_id: pid, path: f },
          });
        },
      );
      watchers.push(w2);
    } catch (e) {
      log(`pipeline-tree watch failed for ${pid}: ${e}`);
    }
  }

  projectWatchers.set(pid, watchers);

  // Initial journal read.
  readJournalIncremental(entry);
}

// Attach watchers for any already-registered projects on boot.
for (const entry of Object.values(registry)) {
  if (existsSync(entry.project_root)) attachProjectWatchers(entry);
}

// --------------------------------------------------------------------
// Pipeline structure inspection — scanPipelines / pipelineInfoFromDir /
// parseIterationSections / resolveProjectRootFromCwd live in lib.ts so
// tests can exercise them without booting the daemon.
// --------------------------------------------------------------------

// --------------------------------------------------------------------
// Port discovery + lockfile
// --------------------------------------------------------------------

function pickPort(): number {
  // Stable port derived from the daemon's "machine identity" (homedir + plugin version).
  // We don't have a per-project hash here — this is a single shared daemon.
  const seed = createHash("sha1").update(HOME_DIR).digest();
  const span = PORT_BAND_HIGH - PORT_BAND_LOW + 1 - 64; // leave room for +64 walk
  const offset = seed.readUInt32BE(0) % span;
  return PORT_BAND_LOW + offset;
}

function canBindPort(port: number): boolean {
  try {
    const test = Bun.serve({ hostname: HOST, port, fetch: () => new Response("probe") });
    test.stop();
    return true;
  } catch {
    return false;
  }
}

async function findFreePort(): Promise<number> {
  const start = pickPort();
  for (let i = 0; i < 64; i++) {
    const port = start + i;
    if (canBindPort(port)) return port;
  }
  // Fallback to ephemeral.
  const test = Bun.serve({ hostname: HOST, port: 0, fetch: () => new Response("probe") });
  const port = test.port;
  test.stop();
  return port;
}

/**
 * Pick the port to bind. On a version handoff the predecessor passes its port
 * via PIPELINE_UI_RECLAIM_PORT so we rebind the SAME url — open browser tabs
 * reconnect transparently. The predecessor stops its server and exits before
 * we get here, but the OS may hold the port briefly, so retry for a short
 * window before giving up and walking to a fresh port via findFreePort().
 */
async function acquirePort(): Promise<number> {
  const reclaim = Number(process.env.PIPELINE_UI_RECLAIM_PORT);
  if (Number.isInteger(reclaim) && reclaim >= PORT_BAND_LOW && reclaim <= PORT_BAND_HIGH) {
    for (let i = 0; i < 30; i++) {
      if (canBindPort(reclaim)) return reclaim;
      await Bun.sleep(100);
    }
    log(`could not reclaim port ${reclaim} after retries; walking to a fresh port`);
  }
  return findFreePort();
}

interface DaemonLock {
  pid: number;
  port: number;
  plugin_version: string;
  started_at: string;
  host: string;
  /** Install dir this daemon was launched from. Lets the SessionStart hook
   *  detect a version change without an HTTP round-trip when it only needs
   *  the path. Optional in older locks written before the reconcile feature. */
  plugin_root?: string;
  /** PID of the managing supervisor (Phase 3), when the worker was launched
   *  under one. `pid` above is always the WORKER (it serves /api/health); to
   *  STOP the daemon outright, signal supervisor_pid — killing the worker
   *  alone just makes the supervisor respawn it (crash recovery). Absent when
   *  the worker runs unsupervised (direct server.ts launch, e.g. tests). */
  supervisor_pid?: number;
}

// Set by supervisor.ts when it spawns this process as its worker. Drives the
// handoff mechanism (supervised → signal supervisor via a handoff file;
// unsupervised → self-spawn the successor, the Phase 1/2 behavior).
const SUPERVISOR_PID = (() => {
  const raw = Number(process.env.PIPELINE_UI_SUPERVISOR_PID);
  return Number.isInteger(raw) && raw > 0 ? raw : null;
})();
const SUPERVISED = SUPERVISOR_PID !== null;
// Where the worker drops its handoff request for the supervisor to pick up.
const HANDOFF_PATH = join(HOME_DIR, "worker-handoff.json");
// Sentinel telling the supervisor NOT to respawn — written before a DELIBERATE
// stop (idle-shutdown, or "another daemon already serves"). Its absence is how
// the supervisor distinguishes those exit-0 cases from an external kill or a
// crash (which should respawn): handoff file → respawn target; stop sentinel →
// exit; neither → respawn. Without it the worker's exit code 0 is ambiguous
// (idle vs SIGTERM'd) and the supervisor would wrongly stop on an external kill.
const WORKER_STOP_PATH = join(HOME_DIR, "worker-stop");

/** Ask the managing supervisor to stop (no respawn). No-op when unsupervised. */
function requestSupervisorStop(): void {
  if (!SUPERVISED) return;
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(WORKER_STOP_PATH, String(process.pid), "utf-8");
  } catch (e) {
    log(`failed to write supervisor-stop sentinel: ${e}`);
  }
}

function writeLock(port: number): void {
  mkdirSync(HOME_DIR, { recursive: true });
  const lock: DaemonLock = {
    pid: process.pid,
    port,
    plugin_version: PLUGIN_VERSION,
    started_at: new Date().toISOString(),
    host: HOST,
    plugin_root: PLUGIN_ROOT,
    ...(SUPERVISOR_PID !== null ? { supervisor_pid: SUPERVISOR_PID } : {}),
  };
  writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process EXISTS but we lack permission to signal it (e.g.
    // a driver running as another user / elevation) — it IS alive. Only ESRCH
    // ("no such process"), and anything else, counts as dead. This keeps the
    // liveness sweep from ever falsely retiring a live run.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function isExistingDaemonAlive(): Promise<DaemonLock | null> {
  if (!existsSync(LOCK_PATH)) return null;
  try {
    const txt = readFileSync(LOCK_PATH, "utf-8").trim();
    if (!txt) return null;
    const lock: DaemonLock = JSON.parse(txt);
    if (!isProcessAlive(lock.pid)) return null;
    // Verify it actually responds.
    try {
      const res = await fetch(`http://${lock.host}:${lock.port}/api/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return lock;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

// Orphan recovery: lock missing or stale, but a daemon may still be running on
// the deterministic seed port (older dev iteration, manual launch, deleted lock).
// Probe before binding so we don't end up with two daemons writing to one registry.
async function probeOrphanDaemon(): Promise<DaemonLock | null> {
  const port = pickPort();
  try {
    const res = await fetch(`http://${HOST}:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      ok?: boolean;
      plugin_version?: string;
      pid?: number;
      schema?: number;
      plugin_root?: string;
      supervisor_pid?: number;
    };
    if (!body?.ok || typeof body.plugin_version !== "string") return null;
    return {
      pid: typeof body.pid === "number" ? body.pid : 0,
      port,
      plugin_version: body.plugin_version,
      started_at: new Date().toISOString(),
      host: HOST,
      // Preserve plugin_root + supervisor_pid so a recovered lock doesn't lose
      // the info the hook (version reconcile) and "stop the daemon" need.
      ...(typeof body.plugin_root === "string" ? { plugin_root: body.plugin_root } : {}),
      ...(typeof body.supervisor_pid === "number" ? { supervisor_pid: body.supervisor_pid } : {}),
    };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------
// HTTP routes
// --------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveStatic(path: string): Response {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".")) : "";
  const mime = MIME[ext] ?? "application/octet-stream";
  return new Response(Bun.file(path), { headers: { "Content-Type": mime } });
}

function handleStatic(reqPath: string): Response {
  // Strip leading slash, default to index.html.
  const rel = reqPath === "/" ? "index.html" : reqPath.replace(/^\//, "");
  const full = join(DIST_DIR, rel);
  if (!full.startsWith(DIST_DIR)) {
    return new Response("forbidden", { status: 403 });
  }
  if (existsSync(full) && statSync(full).isFile()) return serveStatic(full);
  // SPA fallback.
  const indexHtml = join(DIST_DIR, "index.html");
  if (existsSync(indexHtml)) return serveStatic(indexHtml);
  return new Response(
    `<!doctype html><html><body><h1>Pipeline UI</h1><p>The React bundle has not been built yet. Run <code>cd apps/pipeline-ui/web && bun install && bun run build</code> inside the plugin to produce <code>apps/pipeline-ui/dist/</code>.</p></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const { pathname } = url;

  if (pathname === "/api/health") {
    return Response.json({
      ok: true,
      plugin_version: PLUGIN_VERSION,
      // The install dir this daemon is running from. The SessionStart hook
      // compares it to its own CLAUDE_PLUGIN_ROOT to decide whether to
      // POST /api/restart-to. Slash-normalized so the hook's string compare
      // tolerates PowerShell-vs-Node drive-letter / separator drift.
      plugin_root: PLUGIN_ROOT.replaceAll("\\", "/"),
      schema: SCHEMA_VERSION,
      pid: process.pid,
      // The managing supervisor (Phase 3), if any — exposed so orphan-recovery
      // and "stop the daemon" tooling don't lose the linkage. Null when the
      // worker runs unsupervised.
      supervisor_pid: SUPERVISOR_PID,
      uptime_seconds: Math.floor((Date.now() - bootAt) / 1000),
      projects: Object.keys(registry).length,
      clients: sseClients.size,
    });
  }

  // /api/restart-to — re-exec the daemon from a different plugin install
  // directory. The version-reconciliation contract (see CLAUDE.md): when the
  // SessionStart hook sees the daemon running from a plugin_root other than
  // its own CLAUDE_PLUGIN_ROOT (i.e. the user upgraded or downgraded the
  // plugin), it POSTs the new root here and this daemon hands off to it.
  //
  // Auth: the daemon binds 127.0.0.1 only, so callers are already local. We
  // additionally require the caller to echo our current pid (read from the
  // lock file) — this is a correctness guard against restarting the wrong
  // daemon if more than one somehow exists, NOT a security boundary (anyone
  // who can read the lock can call this; that's the same trust level as being
  // able to SIGTERM the process).
  if (pathname === "/api/restart-to" && req.method === "POST") {
    return handleRestartTo(req);
  }

  // /api/update-status — is a newer (or different) plugin version already
  // installed than the one this daemon runs from? The auto-reconcile only
  // reacts to installs that happen AFTER boot (the at-boot gap is deferred to
  // the next SessionStart hook), so a daemon can legitimately sit on a stale
  // version for hours. The UI polls this to show an "Update & Restart" button
  // exactly when that gap exists.
  if (pathname === "/api/update-status" && req.method === "GET") {
    return Response.json(computeUpdateStatus());
  }

  // /api/restart — self-service restart. Hands off to the pending update when
  // one is installed, else re-execs from the current root (manual escape
  // hatch: `curl -X POST http://127.0.0.1:<port>/api/restart`). Unlike
  // /api/restart-to this needs no pid/plugin_root — the caller is by
  // definition talking to the daemon it wants restarted, and the target is
  // derived server-side.
  if (pathname === "/api/restart" && req.method === "POST") {
    return handleRestartSelf();
  }

  if (pathname === "/api/register" && req.method === "POST") {
    try {
      const body = (await req.json()) as {
        project_root: string;
        project_name?: string;
        worktree?: string | null;
      };
      if (!body?.project_root) return new Response("missing project_root", { status: 400 });
      // Accept an optional worktree from callers that already resolved it
      // (SessionStart hook, `pipeline event`). Without this, daemon-emitted events
      // for worktree-resolved projects ended up tagged worktree:null.
      // Preserve the undefined-vs-null distinction: undefined = "no
      // opinion, keep existing"; null = "explicitly clear" (caller
      // resolved and confirmed they're in main-repo cwd).
      const hasField = body && Object.prototype.hasOwnProperty.call(body, "worktree");
      const entry = registerProject(
        body.project_root,
        body.project_name,
        hasField ? body.worktree ?? null : undefined,
      );
      broadcast({ type: "project.registered", data: entry });
      return Response.json({ ok: true, project_id: entry.project_id });
    } catch (e) {
      return new Response(`bad request: ${e}`, { status: 400 });
    }
  }

  // /api/register-cwd — register by passing the consumer's cwd; the daemon
  // walks up to .git (handling worktrees) so callers don't have to duplicate
  // that logic. Used by the /pipeline:ui skill to register the active project
  // when the SessionStart hook didn't fire (e.g., plugin installed mid-session).
  if (pathname === "/api/register-cwd" && req.method === "POST") {
    try {
      const body = (await req.json()) as { cwd: string; project_name?: string };
      if (!body?.cwd) return new Response("missing cwd", { status: 400 });
      const { project_root, worktree } = resolveProjectRootFromCwd(body.cwd);
      const entry = registerProject(project_root, body.project_name, worktree);
      broadcast({ type: "project.registered", data: entry });
      return Response.json({
        ok: true,
        project_id: entry.project_id,
        project_root,
        worktree,
      });
    } catch (e) {
      return new Response(`bad request: ${e}`, { status: 400 });
    }
  }

  if (pathname === "/api/projects") {
    return Response.json({ projects: Object.values(registry) });
  }

  // /api/unregister — used by the manual-test harness to drop temp projects
  // it created. Production callers won't normally hit this; the daemon
  // tolerates stale registry entries since project dirs may simply move.
  if (pathname === "/api/unregister" && req.method === "POST") {
    try {
      const body = (await req.json()) as { project_id: string };
      if (!body?.project_id) return new Response("missing project_id", { status: 400 });
      if (!registry[body.project_id]) {
        return Response.json({ ok: true, removed: false });
      }
      // Tear down watchers so the dropped project stops producing SSE noise.
      const watchers = projectWatchers.get(body.project_id);
      if (watchers) {
        for (const w of watchers) {
          try {
            w.close();
          } catch {
            /* best-effort */
          }
        }
        projectWatchers.delete(body.project_id);
      }
      journalTails.delete(body.project_id);
      // Clear the pipeline-tree and runs caches for this project too.
      // Without this, re-registering at the same project_root within the
      // TTL window would serve a stale pipeline list / stale RunSummary[],
      // and even after TTL the entries linger in their Maps forever — an
      // unbounded leak when the harness churns many temp projects.
      invalidatePipelineCache(registry[body.project_id].project_root);
      invalidateRunsCache(registry[body.project_id].project_root);
      frontmatterCache.invalidatePrefix(registry[body.project_id].project_root);
      delete registry[body.project_id];
      saveRegistry(registry);
      return Response.json({ ok: true, removed: true });
    } catch (e) {
      return new Response(`bad request: ${e}`, { status: 400 });
    }
  }

  // /api/runs?project_id=xxx&limit=N — run summaries derived from the FULL
  // events.jsonl. Lets the UI render "Recent" history that survives the
  // live-event window. Newest first; default limit 100, capped at 1000.
  if (pathname === "/api/runs") {
    const pid = url.searchParams.get("project_id");
    if (!pid) return new Response("missing project_id", { status: 400 });
    const entry = registry[pid];
    if (!entry) return new Response("unknown project", { status: 404 });
    // Clamp limit, treating non-numeric / NaN as the default. Without
    // Number.isFinite the Number("abc") → NaN path propagates through
    // Math.min/Math.max and `.slice(0, NaN)` silently returns [].
    const rawLimit = Number(url.searchParams.get("limit") ?? 100);
    const limit = Math.max(
      1,
      Math.min(1000, Number.isFinite(rawLimit) ? rawLimit : 100),
    );
    // TTL-cached: a hot pipeline emitting pipeline.started/completed in
    // quick succession would otherwise trigger one full journal+archives
    // read per event. The lifecycle-driven SSE handler in useProjectState
    // calls /api/runs on every pipeline.{started,completed,halted}, so
    // 1.5s of staleness is fine — the next tick refreshes anyway.
    const cacheKey = `${entry.project_root}|${limit}`;
    const hit = runsCache.get(cacheKey);
    let summaries: RunSummary[];
    if (hit && Date.now() - hit.at < RUNS_CACHE_TTL_MS) {
      summaries = hit.data;
    } else {
      // Detect dead runs (crashed/killed without a terminal event) before
      // folding so this response already reflects the abandonment halts.
      // Event-driven signal (manager.stopped) first, then the pid-lockfile
      // fallback — both emit pipeline.halted for an abandoned run.
      sweepManagerStoppedRuns(entry);
      sweepProjectLiveness(entry);
      // Third trigger: a user-pressed Esc, which fires no hook at all.
      sweepInterruptedRuns(entry);
      // Fold archives too — `events-<stamp>.jsonl` files produced by the
      // 50 MB rotation. Without this, the endpoint would silently truncate
      // history at every rotation boundary, defeating its purpose.
      // summarizeRunsFromShards walks shards one at a time so memory stays
      // bounded by one shard (~50 MB) instead of the full history.
      const shards = listJournalShards(journalPath(entry));
      summaries = summarizeRunsFromShards(shards).slice(0, limit);
      runsCache.set(cacheKey, { at: Date.now(), data: summaries });
    }
    return Response.json({ runs: summaries, total: summaries.length });
  }

  // /api/run-stats?project_id=&run_id= — accurate per-run tool/token stats,
  // folded from the raw manager+subagent TRANSCRIPTS (the only complete source;
  // the tool.called/turn.usage hook events undercount badly — see
  // transcript-stats.ts). Returns zeroed stats when no transcript is known for
  // the run (e.g. the daemon wasn't running during the run, so nothing was
  // mirror-bound). Cached: terminal runs indefinitely, live runs on a short TTL.
  if (pathname === "/api/run-stats") {
    const pid = url.searchParams.get("project_id");
    const runId = url.searchParams.get("run_id");
    if (!pid || !runId) return new Response("missing params", { status: 400 });
    const entry = registry[pid];
    if (!entry) return new Response("unknown project", { status: 404 });
    return Response.json(computeRunStats(entry, runId));
  }

  // /api/run-stats-batch?project_id=&runs=<id,id,…> — the run-level fold for
  // several runs in ONE request, so a list view can prefer transcript numbers
  // without firing a request per row. Each run goes through the same cached
  // computeRunStats, so a batch over already-warm runs costs no transcript
  // reads at all. Capped so a crafted query can't ask for unbounded work.
  if (pathname === "/api/run-stats-batch") {
    const pid = url.searchParams.get("project_id");
    const runsParam = url.searchParams.get("runs");
    if (!pid || !runsParam) return new Response("missing params", { status: 400 });
    const entry = registry[pid];
    if (!entry) return new Response("unknown project", { status: 404 });
    const ids = [...new Set(runsParam.split(",").map((r) => r.trim()).filter(Boolean))].slice(
      0,
      RUN_STATS_BATCH_MAX,
    );
    const stats: Record<string, TranscriptRunStats> = {};
    for (const id of ids) stats[id] = computeRunStats(entry, id);
    return Response.json({ stats });
  }

  // /api/run-step-stats?project_id=&run_id= — the same transcript fold sliced
  // per step window, for the iteration tree + step detail.
  if (pathname === "/api/run-step-stats") {
    const pid = url.searchParams.get("project_id");
    const runId = url.searchParams.get("run_id");
    if (!pid || !runId) return new Response("missing params", { status: 400 });
    const entry = registry[pid];
    if (!entry) return new Response("unknown project", { status: 404 });
    return Response.json(computeRunStepStats(entry, runId));
  }

  // /api/run-failures?project_id=&run_id= — per-failure detail behind the
  // FAIL analytics tile: every window-gated tool_result error from the run's
  // manager + subagent transcripts, with the failing tool's name + input and
  // the error text. Fetched on demand (tile click), so cached only briefly.
  if (pathname === "/api/run-failures") {
    const pid = url.searchParams.get("project_id");
    const runId = url.searchParams.get("run_id");
    if (!pid || !runId) return new Response("missing params", { status: 400 });
    const entry = registry[pid];
    if (!entry) return new Response("unknown project", { status: 404 });
    return Response.json(computeRunFailures(entry, runId));
  }

  // /api/run-breakdown?project_id=&run_id= — TOOLS/AGENTS drill-down behind
  // the analytics tiles: per-tool aggregates + individual calls (durations
  // from tool_use→tool_result ts pairs) and one row per spawned agent with
  // its own transcript's token fold. Fetched on tile click only.
  if (pathname === "/api/run-breakdown") {
    const pid = url.searchParams.get("project_id");
    const runId = url.searchParams.get("run_id");
    if (!pid || !runId) return new Response("missing params", { status: 400 });
    const entry = registry[pid];
    if (!entry) return new Response("unknown project", { status: 404 });
    return Response.json(computeRunBreakdown(entry, runId));
  }

  // /api/runs/dismiss — manually clear a run the user knows is dead. Appends a
  // synthetic pipeline.halted so the fold marks it terminal and it leaves the
  // UI's Active view. The guaranteed "clear a dead pipeline" escape hatch —
  // works regardless of whether automatic liveness detection can identify it.
  if (pathname === "/api/runs/dismiss" && req.method === "POST") {
    return handleDismissRun(req);
  }

  // /api/runs/stop — stop/cancel ANY run the UI shows as active. For a
  // daemon-launched drive run this kills the live child process; in every
  // case a synthetic pipeline.halted lands in the journal so the run leaves
  // the Active view. Works for genuinely-running AND stale/dead runs.
  if (pathname === "/api/runs/stop" && req.method === "POST") {
    return handleStopRun(req);
  }

  // /api/run-steps?project_id=&run_id= — per-step wall-clock timings for one
  // run (total attempts, active duration, still-running flag), folded from
  // the FULL journal history so old runs whose events scrolled out of the
  // live window still show their per-step breakdown.
  if (pathname === "/api/run-steps") {
    const pid = url.searchParams.get("project_id");
    const runId = url.searchParams.get("run_id");
    if (!pid || !runId) return new Response("missing params", { status: 400 });
    const entry = registry[pid];
    if (!entry) return new Response("unknown project", { status: 404 });
    return Response.json(computeRunSteps(entry, runId));
  }

  // /api/state?project_id=xxx — full snapshot for one project (registry + pipelines + recent events)
  if (pathname === "/api/state") {
    const pid = url.searchParams.get("project_id");
    if (!pid) return new Response("missing project_id", { status: 400 });
    const entry = registry[pid];
    if (!entry) return new Response("unknown project", { status: 404 });
    const pipelines = scanPipelines(entry.project_root);
    const events = readRecentEvents(entry, 200);
    return Response.json({ project: entry, pipelines, events });
  }

  // /api/pipeline?project_id=xxx&name=yyy[&root=…] — single pipeline manifest
  // + iteration list. `root` disambiguates duplicate basenames (same-named
  // targets under two hubs, same name in two category folders); name-only
  // resolution keeps first-match for older clients.
  if (pathname === "/api/pipeline") {
    const pid = url.searchParams.get("project_id");
    const name = url.searchParams.get("name");
    if (!pid || !name) return new Response("missing params", { status: 400 });
    const entry = registry[pid];
    if (!entry) return new Response("unknown project", { status: 404 });
    const pipelines = scanPipelines(entry.project_root);
    const p = findPipelineByNameAndRoot(pipelines, name, url.searchParams.get("root"));
    if (!p) return new Response("unknown pipeline", { status: 404 });
    return Response.json(p);
  }

  // /api/iteration?project_id=xxx&name=yyy&rel=NN-foo.md — read one iteration
  // file and return its parsed sections so the UI can render step detail
  // without forcing the consumer to load the file inside its own context.
  if (pathname === "/api/iteration") {
    const pid = url.searchParams.get("project_id");
    const name = url.searchParams.get("name");
    const rel = url.searchParams.get("rel");
    if (!pid || !name || !rel) return new Response("missing params", { status: 400 });
    const entry = registry[pid];
    if (!entry) return new Response("unknown project", { status: 404 });
    // Reject path traversal — the relative path must stay inside steps/.
    if (rel.includes("..") || rel.startsWith("/") || rel.startsWith("\\")) {
      return new Response("invalid rel", { status: 400 });
    }
    // Resolve the pipeline via scanPipelines so we honor nested category
    // folders (e.g. .claude/pipeline/workflows/<name>/) instead of guessing
    // a flat layout. Optional &root= disambiguates duplicate basenames.
    const pipelines = scanPipelines(entry.project_root);
    const pipeline = findPipelineByNameAndRoot(pipelines, name, url.searchParams.get("root"));
    if (!pipeline) return new Response("unknown pipeline", { status: 404 });
    const stepsDir = join(pipeline.pipeline_root, "steps");
    const full = join(stepsDir, rel);
    // Defense in depth: ensure the resolved path is still under steps/ — via
    // the shared normalizer (resolve + case-fold on Windows), same containment
    // check the editor endpoints use.
    if (!normalizePathForCompare(full).startsWith(normalizePathForCompare(stepsDir) + "/")) {
      return new Response("forbidden", { status: 403 });
    }
    if (!existsSync(full)) return new Response("not found", { status: 404 });
    try {
      const raw = readFileSync(full, "utf-8");
      // Truncate absurdly large iterations so the UI doesn't choke.
      const MAX_BYTES = 200_000;
      const content = raw.length > MAX_BYTES ? raw.slice(0, MAX_BYTES) + "\n\n[...truncated]" : raw;
      const sections = parseIterationSections(content);
      const st = statSync(full);
      return Response.json({
        pipeline_name: name,
        rel_path: rel.replaceAll("\\", "/"),
        absolute_path: full.replaceAll("\\", "/"),
        title: sections.title,
        sections: sections.sections,
        raw: content,
        size_bytes: st.size,
        modified_at: st.mtime.toISOString(),
      });
    } catch (e) {
      log(`iteration read failed (${name}/${rel}): ${e}`);
      return new Response(`read failed: ${e}`, { status: 500 });
    }
  }

  // /api/stream — Server-Sent Events
  if (pathname === "/api/stream") {
    return sseResponse();
  }

  // /api/chat — spawn an Agent SDK session and stream messages back as SSE
  if (pathname === "/api/chat" && req.method === "POST") {
    return handleChatRequest(req);
  }

  // /api/chat/resume — resume a previously-interrupted SDK session by run_id.
  if (pathname === "/api/chat/resume" && req.method === "POST") {
    return handleChatResume(req);
  }

  // /api/chat/sessions — list resumable chat sessions for a project. Used by
  // the UI to surface "Resume" buttons after a daemon restart.
  if (pathname === "/api/chat/sessions" && req.method === "GET") {
    return handleListChatSessions(req, url);
  }

  // /api/chat/messages?project_id=&run_id= — full transcript of one chat run.
  // Lets the UI rehydrate a chat that was streamed in a different tab / before
  // the daemon was restarted / from a /pipeline:run that the user wants to
  // inspect.
  if (pathname === "/api/chat/messages" && req.method === "GET") {
    return handleChatMessages(url);
  }

  // /api/transcripts?project_id=... — list every Claude Code session and
  // subagent transcript Claude Code wrote for this project, newest first.
  // Lets the UI surface "what is this executor actually doing right now?"
  if (pathname === "/api/transcripts" && req.method === "GET") {
    return handleListTranscripts(url, getProject);
  }

  // /api/transcript?project_id=...&id=... — return the parsed messages from
  // a single transcript file. `id` is the session uuid or "session/subagent-id".
  if (pathname === "/api/transcript" && req.method === "GET") {
    return handleReadTranscript(url, getProject);
  }

  // --- Run launcher (launcher.ts) — headless `pipeline drive` from the browser.
  if (pathname === "/api/pipelines" && req.method === "GET") {
    return handleListPipelines(url, getProject);
  }
  if (pathname === "/api/runs/launch" && req.method === "POST") {
    return handleLaunchRun(req, launcherDeps);
  }
  if (pathname === "/api/runs/answer" && req.method === "POST") {
    return handleAnswerRun(req, launcherDeps);
  }
  if (pathname === "/api/drive-runs" && req.method === "GET") {
    return handleListDriveRuns(url, getProject);
  }

  // --- Pipeline editor (editor.ts) — guarded writes INSIDE .claude/pipeline only.
  if (pathname === "/api/editor/list" && req.method === "GET") {
    return handleEditorList(url, editorDeps);
  }
  if (pathname === "/api/editor/file" && req.method === "GET") {
    return handleEditorRead(url, editorDeps);
  }
  if (pathname === "/api/editor/file" && req.method === "PUT") {
    return handleEditorWrite(req, editorDeps);
  }
  if (pathname === "/api/editor/file" && req.method === "DELETE") {
    return handleEditorDelete(req, editorDeps);
  }
  if (pathname === "/api/editor/create-step" && req.method === "POST") {
    return handleEditorCreateStep(req, editorDeps);
  }
  if (pathname === "/api/editor/validate" && req.method === "POST") {
    return handleEditorValidate(req, editorDeps);
  }

  // --- AI Fix (aifix.ts) — background `claude -p` repairs of lint issues.
  if (pathname === "/api/editor/ai-fix" && req.method === "POST") {
    return handleStartAiFix(req, aiFixDeps);
  }
  if (pathname === "/api/editor/ai-fix" && req.method === "GET") {
    return handleGetAiFixJob(url);
  }

  // --- Speech-to-text proxy (transcribe.ts) — quality dictation, key stays server-side.
  if (pathname === "/api/transcribe/status" && req.method === "GET") {
    return handleTranscribeStatus();
  }
  if (pathname === "/api/transcribe" && req.method === "POST") {
    return handleTranscribe(req, url);
  }

  return new Response("not found", { status: 404 });
}

// Shared deps for the launcher module — the same decoupling contract as
// transcripts.ts (project lookup callback, no direct registry sharing).
const launcherDeps = {
  getProject,
  broadcast,
  pluginRoot: PLUGIN_ROOT,
  log,
};

const aiFixDeps = {
  getProject,
  log,
};

const editorDeps = {
  getProject,
  broadcast,
  invalidate: (projectRoot: string) => {
    invalidatePipelineCache(projectRoot);
    invalidateRunsCache(projectRoot);
  },
  log,
};

// --------------------------------------------------------------------
// Chat (Agent SDK) — POST /api/chat streams agent messages as SSE.
// --------------------------------------------------------------------

interface ChatRequest {
  project_id: string;
  pipeline_name?: string | null;
  prompt: string;
  /** Optional explicit model id (e.g. "claude-haiku-4-5-20251001"). When
   *  omitted, the Agent SDK picks the session default. Useful for cheap
   *  smoke tests via the manual-test harness. */
  model?: string | null;
  /** Optional explicit reasoning effort (low|medium|high|xhigh|max). When
   *  omitted, resolves from step/pipeline `effort:` frontmatter, else the
   *  SDK session default. */
  effort?: string | null;
}

// Cache the SDK import + install promise so concurrent first-callers share work.
let sdkLoad: Promise<typeof import("@anthropic-ai/claude-agent-sdk")> | null = null;
const SDK_PKG = "@anthropic-ai/claude-agent-sdk";
const DAEMON_DIR = import.meta.dir;

async function loadAgentSdk(): Promise<typeof import("@anthropic-ai/claude-agent-sdk")> {
  if (sdkLoad) return sdkLoad;
  sdkLoad = (async () => {
    try {
      return await import(SDK_PKG);
    } catch {
      log(`agent SDK not yet installed; running \`bun install\` in ${DAEMON_DIR}`);
      const proc = Bun.spawn(["bun", "install"], {
        cwd: DAEMON_DIR,
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      if (code !== 0) {
        const err = await new Response(proc.stderr).text();
        throw new Error(`bun install failed (exit ${code}): ${err.slice(-400)}`);
      }
      // Fresh import after install. Bust the module cache by appending a
      // throwaway query string — Bun honors this for dynamic imports.
      return await import(SDK_PKG + `?t=${Date.now()}`);
    }
  })();
  return sdkLoad;
}

interface ChatSessionRecord {
  run_id: string;
  sdk_session_id: string;
  project_root: string;
  pipeline_name: string | null;
  iteration_path: string | null;
  prompt: string;
  ts: string;
}

/**
 * Persist the chat-session mapping (our run_id ↔ SDK session_id) so a restarted
 * daemon can resume an interrupted SDK conversation via query({ resume: ... }).
 * One record per chat invocation; the file is append-only JSONL.
 */
function recordChatSession(projectRoot: string, rec: ChatSessionRecord): void {
  try {
    const runtime = join(projectRoot, ".claude", "pipeline", ".runtime");
    mkdirSync(runtime, { recursive: true });
    appendFileSync(
      join(runtime, "chat-sessions.jsonl"),
      JSON.stringify(rec) + "\n",
      "utf-8",
    );
  } catch (e) {
    log(`recordChatSession failed: ${e}`);
  }
}

/**
 * Look up the most recent chat-session record for a given run_id. Returns
 * null when the run isn't ours or the file doesn't exist.
 */
function loadChatSession(projectRoot: string, runId: string): ChatSessionRecord | null {
  const path = join(projectRoot, ".claude", "pipeline", ".runtime", "chat-sessions.jsonl");
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf-8");
    const lines = text.split("\n").filter((l) => l.trim());
    // Last match wins so a re-run replaces the earlier entry.
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const r = JSON.parse(lines[i]) as ChatSessionRecord;
        if (r.run_id === runId) return r;
      } catch {
        /* skip malformed line */
      }
    }
  } catch (e) {
    log(`loadChatSession read failed: ${e}`);
  }
  return null;
}

/**
 * Append one SDK message to `<projectRoot>/.claude/pipeline/.runtime/chat-messages.jsonl`
 * tagged with our run_id AND broadcast it over the daemon's SSE stream so
 * every connected browser tab (not just the one that initiated /api/chat)
 * gets live updates. Without the broadcast, opening a chat in tab B that's
 * still streaming in tab A leaves tab B frozen on its initial fetch.
 */
// Mirror events.jsonl: rotate chat-messages.jsonl when it crosses this size
// so a long-running chat with large tool results doesn't accumulate forever.
// Larger than events because chat messages carry raw model output and tool
// results that can be 10-100KB each — 50MB still fits comfortably in memory
// when /api/chat/messages reads the whole file.
const CHAT_MESSAGES_ROTATE_AT = 50 * 1024 * 1024;

function rotateIfLarge(path: string, limit: number): void {
  try {
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size <= limit) return;
    // Match `pipeline event`'s stamp format (YYYYMMDD-HHMMSS) so all rotated
    // archives in .runtime/ follow the same convention regardless of who
    // wrote them. Previous version stripped colons + dots first, then
    // tried to strip the millis suffix — but the dots were already gone,
    // so the second replace was a no-op and the stamp kept the dashes
    // from the date and the trailing milliseconds + 'Z'.
    const d = new Date();
    const stamp =
      `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}` +
      `${String(d.getUTCDate()).padStart(2, "0")}-` +
      `${String(d.getUTCHours()).padStart(2, "0")}` +
      `${String(d.getUTCMinutes()).padStart(2, "0")}` +
      `${String(d.getUTCSeconds()).padStart(2, "0")}`;
    const rotated = path.replace(/\.jsonl$/, `-${stamp}.jsonl`);
    try {
      renameSync(path, rotated);
    } catch (e) {
      log(`rotation failed for ${path}: ${e}`);
    }
  } catch {
    /* best-effort */
  }
}

/** Options for appendChatMessagePart.
 *
 *  `source` (default "sdk") is persisted in the chat-messages.jsonl row
 *  and broadcast via SSE so the UI can distinguish messages written by
 *  the in-process SDK loop (the `/api/chat` runs) from messages
 *  mirrored from a Claude Code terminal session by the MirrorService
 *  (`mirror.ts`). Older clients ignore the field. See issue #11.
 *
 *  `ts` lets the mirror preserve the original transcript timestamp on
 *  each row — without it, mirrored rows would all share "now" and the
 *  chat panel would show the entire executor run as a single instant. */
interface AppendChatOpts {
  source?: "sdk" | "mirror";
  ts?: string;
}

function appendChatMessagePart(
  projectRoot: string,
  runId: string,
  msg: unknown,
  opts: AppendChatOpts = {},
): void {
  const source = opts.source ?? "sdk";
  const ts = opts.ts ?? new Date().toISOString();
  try {
    const runtime = join(projectRoot, ".claude", "pipeline", ".runtime");
    mkdirSync(runtime, { recursive: true });
    const path = join(runtime, "chat-messages.jsonl");
    rotateIfLarge(path, CHAT_MESSAGES_ROTATE_AT);
    const rec = {
      run_id: runId,
      ts,
      msg,
      // Only emit `source` for mirrored rows so existing /api/chat rows
      // remain bytewise identical to the v1 schema and any downstream
      // consumer that round-trips the file doesn't see spurious diffs.
      ...(source === "mirror" ? { source } : {}),
    };
    appendFileSync(path, JSON.stringify(rec) + "\n", "utf-8");
  } catch (e) {
    log(`appendChatMessagePart failed: ${e}`);
  }
  // Side-channel broadcast to all SSE clients — independent of the per-run
  // POST stream's connection lifetime. Mirrored rows annotate the msg
  // payload in-place so the UI's MessageRow can read m.source without
  // a separate envelope-level field.
  try {
    let broadcastMsg = msg;
    if (source === "mirror" && msg && typeof msg === "object") {
      broadcastMsg = { ...(msg as Record<string, unknown>), source };
    }
    broadcast({
      type: "chat.message_part",
      data: { run_id: runId, msg: broadcastMsg, ...(source === "mirror" ? { source } : {}) },
    });
  } catch (e) {
    log(`chat broadcast failed: ${e}`);
  }
}

/**
 * Append a single event to `<projectRoot>/.claude/pipeline/.runtime/events.jsonl`.
 * Mirrors the schema written by `pipeline event` (apps/pipeline-cli/src/lib/event.ts)
 * so the UI / journal tail consumes chat-driven events the same way it consumes
 * /pipeline:run-driven ones.
 * Best-effort: errors are logged and swallowed; the daemon must never throw
 * out of an SSE handler.
 */
function emitJournalEvent(
  projectRoot: string,
  runId: string,
  type: string,
  data: Record<string, unknown>,
  worktree: string | null = null,
): void {
  try {
    const runtime = join(projectRoot, ".claude", "pipeline", ".runtime");
    mkdirSync(runtime, { recursive: true });
    const evt = {
      schema: SCHEMA_VERSION,
      ts: new Date().toISOString(),
      type,
      project_root: projectRoot,
      worktree,
      run_id: runId,
      parent_run_id: null,
      session_id: null,
      data,
    };
    appendFileSync(
      join(runtime, "events.jsonl"),
      JSON.stringify(evt) + "\n",
      "utf-8",
    );
    // Daemon-emitted lifecycle events must invalidate the runs cache so
    // the next /api/runs read reflects them; otherwise the UI would see
    // stale summaries for up to RUNS_CACHE_TTL_MS.
    invalidateRunsCache(projectRoot);
  } catch (e) {
    log(`emitJournalEvent failed (${type}): ${e}`);
  }
}

/**
 * Mark a run terminal on the user's explicit request (a dead pipeline the UI
 * still shows as active). Emits a pipeline.halted carrying the run's known
 * pipeline/iteration context so the fold flips it to halted and the journal
 * tail broadcasts it to every connected tab. Idempotent-ish: dismissing an
 * already-terminal run just appends a redundant halt. If the run were somehow
 * still alive it would re-surface on its next event — correct, since dismiss
 * is meant for runs the user knows are dead.
 */
/** Append the user-initiated synthetic `pipeline.halted` for a run — the ONE
 *  place that owns the event payload shape (the `dismissed: true` marker and
 *  the worktree fallback chain documented in EVENTS.md). Shared by dismiss
 *  and stop. */
function appendUserHalt(entry: ProjectEntry, run: RunSummary, reason: string): void {
  emitJournalEvent(
    entry.project_root,
    run.run_id,
    "pipeline.halted",
    {
      pipeline_name: run.pipeline_name,
      iteration_path: run.current_iteration_path,
      halt_reason: reason,
      // Marks this as a user dismissal rather than a real pipeline halt, so the
      // UI can label it distinctly if it wants. Optional field; folders ignore it.
      dismissed: true,
    },
    run.worktree ?? entry.worktree ?? null,
  );
}

async function handleDismissRun(req: Request): Promise<Response> {
  let body: { project_id?: string; run_id?: string; reason?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch (e) {
    return new Response(`bad request: ${e}`, { status: 400 });
  }
  if (!body?.project_id || !body?.run_id) {
    return new Response("project_id and run_id are required", { status: 400 });
  }
  const entry = registry[body.project_id];
  if (!entry) return new Response("unknown project", { status: 404 });
  // Confirm the run exists (and grab its pipeline/iteration/worktree context).
  const shards = listJournalShards(journalPath(entry));
  const run = summarizeRunsFromShards(shards).find((r) => r.run_id === body.run_id);
  if (!run) return new Response("unknown run", { status: 404 });
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim()
      : "dismissed by user";
  appendUserHalt(entry, run, reason);
  return Response.json({ ok: true, run_id: body.run_id, halt_reason: reason });
}

/**
 * Stop/cancel a run on the user's explicit request. Two halves, both
 * best-effort and independently useful:
 *   1. If this daemon launched the run (`pipeline drive`), KILL the live
 *      child process so the work actually stops (not just the badge).
 *   2. Append the synthetic pipeline.halted (same mechanics as dismiss) so
 *      the event fold flips the run to halted everywhere — this also covers
 *      stale runs that were never daemon-launched (a dead manager-driven
 *      run showing "running" for hundreds of hours).
 * 404 only when NEITHER half knows the run.
 */
async function handleStopRun(req: Request): Promise<Response> {
  let body: { project_id?: string; run_id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch (e) {
    return new Response(`bad request: ${e}`, { status: 400 });
  }
  if (!body?.project_id || !body?.run_id) {
    return new Response("project_id and run_id are required", { status: 400 });
  }
  const entry = registry[body.project_id];
  if (!entry) return new Response("unknown project", { status: 404 });

  const droveStopped = stopDriveRun(body.run_id, broadcast);

  const shards = listJournalShards(journalPath(entry));
  const run = summarizeRunsFromShards(shards).find((r) => r.run_id === body.run_id);
  if (!run && !droveStopped) return new Response("unknown run", { status: 404 });
  if (run && run.status !== "completed" && run.status !== "halted") {
    appendUserHalt(entry, run, "stopped by user");
  }
  return Response.json({ ok: true, run_id: body.run_id, drive_killed: droveStopped });
}

/**
 * Boot self-cleanup: a daemon restart kills any in-flight /api/chat SDK query,
 * so a chat-driven run still non-terminal in the journal is dead. Halt those
 * once at startup. Scoped to projects that actually have a chat-sessions.jsonl
 * (almost none do), so it doesn't fold every project's journal at boot.
 */
function reconcileDeadChatRunsAtBoot(): void {
  for (const entry of Object.values(registry)) {
    try {
      const chatPath = join(
        entry.project_root, ".claude", "pipeline", ".runtime", "chat-sessions.jsonl",
      );
      if (!existsSync(chatPath)) continue;
      const chatRunIds = new Set<string>();
      for (const line of readFileSync(chatPath, "utf-8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const r = JSON.parse(t) as { run_id?: string };
          if (r.run_id) chatRunIds.add(r.run_id);
        } catch { /* skip malformed */ }
      }
      if (chatRunIds.size === 0) continue;
      const shards = listJournalShards(journalPath(entry));
      for (const run of summarizeRunsFromShards(shards)) {
        if (!chatRunIds.has(run.run_id)) continue;
        if (run.status === "completed" || run.status === "halted") continue;
        // Only retire runs that went quiet BEFORE this daemon started. A run
        // with activity at/after bootAt is live under THIS daemon (e.g. a chat
        // resumed in the boot window) — never halt that.
        const lastMs = Date.parse(run.last_event_at);
        if (Number.isFinite(lastMs) && lastMs >= bootAt) continue;
        emitJournalEvent(
          entry.project_root,
          run.run_id,
          "pipeline.halted",
          {
            pipeline_name: run.pipeline_name,
            iteration_path: run.current_iteration_path,
            halt_reason: "daemon restarted — chat session lost",
            dismissed: false,
          },
          run.worktree ?? entry.worktree ?? null,
        );
        log(`boot cleanup: halted dead chat run ${run.run_id}`);
      }
    } catch (e) {
      log(`boot chat-run cleanup failed for ${entry.project_id}: ${e}`);
    }
  }
}

/**
 * Best-effort dead-run detection (stale "active" pipelines). /pipeline:run
 * drops a per-run liveness lockfile (`.runtime/runs/<run_id>.alive` = {pid})
 * naming the OS process driving the run, and removes it on a terminal event.
 * So a `.alive` file that remains AND whose pid is dead = a run that crashed /
 * was killed without finishing. We retire those by emitting pipeline.halted
 * (reason "abandoned") and deleting the stale lockfile.
 *
 * Liveness — NOT age — is the trigger: a healthy multi-hour pipeline keeps its
 * driver pid alive and is never touched. Degrades safely: when the captured
 * pid is untrustworthy (≤1, e.g. a sandbox where $PPID isn't the real driver)
 * or still alive, we do nothing — no false "dead" flags; manual dismiss
 * (/api/runs/dismiss) remains the guaranteed fallback.
 *
 * LOAD-BEARING — do NOT remove the pid-lockfile, even though `manager.stopped`
 * (sweepManagerStoppedRuns) is now the primary liveness signal. This lockfile
 * sweep is the ONLY detector for a HARD kill: a SIGKILL / crash / power-loss
 * never fires the SubagentStop hook, so no `manager.stopped` is emitted and only
 * the dead-pid check catches it. The same `.alive` lockfile is ALSO read by
 * `hasLiveDriver` in sweepManagerStoppedRuns as the guard that prevents the
 * primary sweep from falsely retiring a Path-B supervisor poll-waiting on a
 * nested blocker (which legitimately stops + later re-spawns the manager).
 */
function sweepProjectLiveness(entry: ProjectEntry): void {
  const runsDir = join(entry.project_root, ".claude", "pipeline", ".runtime", "runs");
  if (!existsSync(runsDir)) return;
  let files: string[];
  try {
    files = readdirSync(runsDir).filter((f) => f.endsWith(".alive"));
  } catch {
    return;
  }
  if (files.length === 0) return;
  // Lazily fold the journal to learn which run_ids are ALREADY terminal — only
  // when we actually find a dead-pid lockfile (the common all-alive case folds
  // nothing). A run that finished cleanly but whose clear-liveness didn't run
  // (crash in the gap after the terminal event, or a failed unlink) leaves a
  // stale lockfile; we must NOT re-halt it — just drop the leftover. Mirrors
  // the guard in reconcileDeadChatRunsAtBoot.
  let terminal: Set<string> | null = null;
  const terminalRunIds = (): Set<string> => {
    if (terminal) return terminal;
    terminal = new Set<string>();
    try {
      for (const r of summarizeRunsFromShards(listJournalShards(journalPath(entry)))) {
        if (r.status === "completed" || r.status === "halted") terminal.add(r.run_id);
      }
    } catch { /* fold failed — treat as none known-terminal */ }
    return terminal;
  };
  for (const f of files) {
    const full = join(runsDir, f);
    let pid: number | null = null;
    let runId = f.replace(/\.alive$/, "");
    try {
      const rec = JSON.parse(readFileSync(full, "utf-8")) as { pid?: number; run_id?: string };
      if (typeof rec.pid === "number") pid = rec.pid;
      if (typeof rec.run_id === "string" && rec.run_id) runId = rec.run_id;
    } catch {
      continue; // unreadable/partial lockfile — leave it for next sweep
    }
    // Only act on a trustworthy, real pid. ≤1 (e.g. sandboxed $PPID) is never
    // conclusively "dead"; our own pids aren't the driver.
    if (!Number.isInteger(pid) || (pid as number) <= 1) continue;
    if (pid === process.pid || pid === SUPERVISOR_PID) continue;
    if (isProcessAlive(pid as number)) continue; // driver alive → run is alive
    // Driver dead. If the run already reached a terminal state, the lockfile is
    // just a leftover — drop it WITHOUT emitting a (false) abandonment halt.
    if (terminalRunIds().has(runId)) {
      try { unlinkSync(full); } catch {}
      continue;
    }
    log(`liveness: run ${runId} driver pid ${pid} is dead → marking abandoned`);
    emitJournalEvent(
      entry.project_root,
      runId,
      "pipeline.halted",
      { halt_reason: "abandoned — driver process no longer alive", abandoned: true },
      entry.worktree ?? null,
    );
    try { unlinkSync(full); } catch {}
  }
}

/**
 * Event-driven dead-run detection (Phase 2 primary signal). The
 * SubagentStop hook emits `manager.stopped { run_id, agent_id }` when a
 * run's `pipeline-manager` subagent ends. A run that has a `pipeline.started`
 * AND a `manager.stopped` but NO terminal `pipeline.completed`/`halted` for
 * the same run_id means the orchestrator is gone without finishing — the run
 * is abandoned. We retire those by emitting `pipeline.halted` (reason
 * "abandoned"), exactly as the pid-lockfile sweep does, so the existing fold
 * + UI + isActive machinery flips the run terminal.
 *
 * This coexists with (does NOT replace) `sweepProjectLiveness`: the lockfile
 * sweep is the secondary fallback for runs where no `manager.stopped` ever
 * arrived (e.g. the manager process was hard-killed before SubagentStop
 * could fire). Backward-compatible: a journal with no `manager.stopped`
 * events folds to no abandonment here and nothing is emitted.
 *
 * Idempotent: once we emit the abandonment `pipeline.halted`, the run_id is
 * terminal and is skipped on every subsequent sweep.
 */
function sweepManagerStoppedRuns(entry: ProjectEntry): void {
  const shards = listJournalShards(journalPath(entry));
  if (shards.length === 0) return;

  const started = new Set<string>();
  const stopped = new Set<string>();
  const terminal = new Set<string>();
  // Last-known halt context per run, for a friendlier halt event.
  const context = new Map<string, { pipeline_name: string | null; iteration_path: string | null; worktree: string | null }>();

  let sawManagerStopped = false;
  for (const shard of shards) {
    let text: string;
    try {
      text = readFileSync(shard, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let ev: { type?: string; run_id?: string; worktree?: string | null; data?: Record<string, unknown> };
      try {
        ev = JSON.parse(t);
      } catch {
        continue;
      }
      const rid = ev.run_id;
      if (typeof rid !== "string" || !rid) continue;
      const d = ev.data ?? {};
      const ctx = (): { pipeline_name: string | null; iteration_path: string | null; worktree: string | null } => {
        let c = context.get(rid);
        if (!c) {
          c = { pipeline_name: null, iteration_path: null, worktree: null };
          context.set(rid, c);
        }
        if (ev.worktree) c.worktree = ev.worktree;
        return c;
      };
      switch (ev.type) {
        case "pipeline.started": {
          started.add(rid);
          const c = ctx();
          if (typeof d.pipeline_name === "string") c.pipeline_name = d.pipeline_name;
          if (typeof d.first_iteration_path === "string" && !c.iteration_path) {
            c.iteration_path = d.first_iteration_path;
          }
          break;
        }
        case "pipeline.completed":
        case "pipeline.halted":
          terminal.add(rid);
          break;
        case "manager.stopped":
          stopped.add(rid);
          sawManagerStopped = true;
          break;
        case "iteration.started":
        case "iteration.resumed":
        case "iteration.completed": {
          const c = ctx();
          if (typeof d.iteration_path === "string") c.iteration_path = d.iteration_path;
          break;
        }
        default:
          break;
      }
    }
  }

  // Cheap exit for the overwhelming majority of journals: no manager.stopped
  // event means there is nothing event-driven to retire here.
  if (!sawManagerStopped) return;

  const runsDir = join(entry.project_root, ".claude", "pipeline", ".runtime", "runs");
  // True when run_id still has a liveness lockfile naming a LIVE driving
  // process. In Path B the /pipeline:run supervisor (depth 0) owns the run
  // and keeps this lockfile across nested-blocker poll-waits — during which
  // the FIRST manager subagent stops and re-spawns. So a live lockfile means
  // the run is NOT abandoned even though manager.stopped fired; only the
  // supervisor's terminal event (or its death) ends it. Path C writes no
  // lockfile, so this is always false there and manager.stopped is the
  // authoritative signal.
  const hasLiveDriver = (rid: string): boolean => {
    try {
      const lockFile = join(runsDir, `${rid}.alive`);
      if (!existsSync(lockFile)) return false;
      const rec = JSON.parse(readFileSync(lockFile, "utf-8")) as { pid?: number };
      const pid = rec.pid;
      if (!Number.isInteger(pid) || (pid as number) <= 1) return false;
      if (pid === process.pid || pid === SUPERVISOR_PID) return false;
      return isProcessAlive(pid as number);
    } catch {
      return false;
    }
  };

  for (const rid of stopped) {
    if (!started.has(rid)) continue; // never started → not our concern
    if (terminal.has(rid)) continue; // already finished → leave it
    if (hasLiveDriver(rid)) continue; // supervisor still drives it (Path B blocker-wait)
    const ctx = context.get(rid) ?? { pipeline_name: null, iteration_path: null, worktree: null };
    log(`manager.stopped: run ${rid} orchestrator gone with no terminal event → marking abandoned`);
    emitJournalEvent(
      entry.project_root,
      rid,
      "pipeline.halted",
      {
        pipeline_name: ctx.pipeline_name,
        iteration_path: ctx.iteration_path,
        halt_reason: "abandoned — pipeline-manager stopped without completing",
        abandoned: true,
      },
      ctx.worktree ?? entry.worktree ?? null,
    );
    terminal.add(rid);
  }
}

/**
 * Third abandonment trigger (design 06, edge case E5): a user-pressed Esc.
 *
 * Esc fires NO hook. If the terminal session process stays alive, the `.alive`
 * lockfile still names a live pid and `manager.stopped` never arrives — so
 * neither existing sweep retires the run and it renders `running` forever. The
 * transcript is the only durable evidence, so a run that has been SILENT for
 * WATCHDOG_QUIET_MS gets its transcript tail probed; a pending interrupt (an
 * Esc nothing has happened after) synthesizes the same abandonment
 * `pipeline.halted` the other two sweeps emit, which flips the run terminal
 * through the existing fold + isActive machinery.
 *
 * Deliberately conservative — a false positive retires a run that is still
 * working, which is worse than missing one:
 *   • runs already terminal are excluded upstream (and the synthetic halt makes
 *     a swept run terminal, so this is idempotent);
 *   • a run with no resolvable transcript is skipped entirely (the existing 15 s
 *     negative cache paces those retries);
 *   • the pending test compares transcript timestamps only, never daemon
 *     wall-clock, so clock skew between the writing machine and this daemon
 *     cannot manufacture an interrupt.
 *
 * Not detected (accepted): an Esc BEFORE any model output in the run's window
 * leaves no marker. The 60 s pid sweep and manager.stopped still cover hard
 * deaths; importing an idle-timeout heuristic here would false-positive on long
 * thinking phases.
 */
/** Soft budget for one project's backfill pass on the 60 s timer. The sweep is
 *  a background courtesy — it must never make the daemon unresponsive. */
const BACKFILL_SWEEP_BUDGET_MS = 3000;

/**
 * Recovery rung T4 (design 04): the periodic backfill sweep.
 *
 * Token/tool enrichment normally lands from the Stop/SubagentStop relay, but a
 * run can miss it for entirely ordinary reasons — the session was killed before
 * Stop fired, the machine slept, stats were opted out at the time. This calls
 * the SAME shared `backfillProject` core every other trigger uses, so all four
 * rungs produce bit-identical numbers.
 *
 * Cheap pre-scan first: reading the project's runs.jsonl files and looking for
 * a single `tokens: null` record is orders of magnitude cheaper than the
 * transcript folds, and the overwhelming majority of projects are already
 * clean, so they cost one small read per minute and nothing else.
 */
function sweepStatsBackfill(entry: ProjectEntry): void {
  const statsDir = join(entry.project_root, ".claude", "pipeline", ".stats");
  if (!existsSync(statsDir)) return;

  let hasPending = false;
  try {
    for (const runsFile of findRunsFiles(statsDir)) {
      let text: string;
      try {
        text = readFileSync(runsFile, "utf-8");
      } catch {
        continue;
      }
      // Cheap textual pre-filter before the JSON parse: a file with no
      // `"tokens":null` substring cannot hold an unenriched record.
      if (!text.includes('"tokens":null') && !text.includes('"tokens": null')) continue;
      if (parseRunRecords(text).some((r) => r.tokens === null)) {
        hasPending = true;
        break;
      }
    }
  } catch {
    return; // never let a stats hiccup disturb the daemon
  }
  if (!hasPending) return;

  try {
    const report = backfillProject(entry.project_root, { budgetMs: BACKFILL_SWEEP_BUDGET_MS });
    if (report.enriched.length > 0) {
      log(`stats backfill sweep: enriched ${report.enriched.length} run(s) in ${entry.project_root}`);
    }
  } catch (e) {
    log(`stats backfill sweep failed for ${entry.project_root}: ${e}`);
  }
}

function sweepInterruptedRuns(entry: ProjectEntry): void {
  if (!WATCHDOG_ENABLED) return;
  // The probe reads transcripts; with transcripts opted out there is nothing
  // to read and the watchdog is inert by construction.
  if (!TRANSCRIPTS_ENABLED) return;

  const now = Date.now();
  for (const summary of allRunSummaries(entry)) {
    if (summary.status === "completed" || summary.status === "halted") continue;
    const lastEvent = toEpochOrNull(summary.last_event_at);
    if (lastEvent === null || now - lastEvent < WATCHDOG_QUIET_MS) continue; // still chatty

    const { transcriptPath, startIso } = resolveRunTranscript(entry, summary.run_id);
    if (!transcriptPath) continue; // unresolved — the negative cache paces retries

    const probe = detectPendingInterrupt(transcriptPath, startIso);
    if (!probe.interrupted) continue;

    log(`watchdog: run ${summary.run_id} interrupted by user with no terminal event → marking abandoned`);
    emitJournalEvent(
      entry.project_root,
      summary.run_id,
      "pipeline.halted",
      {
        pipeline_name: summary.pipeline_name,
        iteration_path: summary.current_iteration_path,
        halt_reason: "interrupted by user (Esc) — no terminal event",
        abandoned: true,
        interrupt_ts: probe.interrupt_ts,
      },
      summary.worktree ?? entry.worktree ?? null,
    );
  }
}

async function handleChatRequest(req: Request): Promise<Response> {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch (e) {
    return new Response(`bad request: ${e}`, { status: 400 });
  }
  if (!body.project_id || !body.prompt?.trim()) {
    return new Response("project_id and prompt are required", { status: 400 });
  }
  const entry = registry[body.project_id];
  if (!entry) return new Response("unknown project", { status: 404 });

  // Resolve the pipeline. When a pipeline is selected we make step-executor
  // the main thread agent directly — that's the agent that already knows how
  // to execute one iteration, so wrapping it inside a generic Claude session
  // (which then "spawns step-executor") just burns tokens loading every
  // skill the user has installed before doing anything pipeline-specific.
  let firstIter: string | null = null;
  let pipelineLabel: string | null = null;
  let pipelineRoot: string | null = null;
  if (body.pipeline_name) {
    const pipelines = scanPipelines(entry.project_root);
    const p = pipelines.find((x) => x.pipeline_name === body.pipeline_name);
    if (!p) return new Response("unknown pipeline", { status: 404 });
    if (p.iterations.length === 0) {
      return new Response("pipeline has no iterations yet", { status: 400 });
    }
    firstIter = join(p.pipeline_root, "steps", p.iterations[0]).replaceAll("\\", "/");
    pipelineLabel = p.pipeline_name;
    pipelineRoot = p.pipeline_root;
  }
  const projectWorktree = entry.worktree ?? null;

  // Resolve the model for this chat call. Contract (issue #7):
  //   1. body.model from the UI ALWAYS wins (explicit caller override).
  //   2. Otherwise: step frontmatter ?? pipeline frontmatter ?? null.
  //   3. null → omit `model` from query() so the SDK uses the session default.
  // We always compute pipelineShorthand (the PIPELINE.md `model:` value) so
  // the daemon can stamp it on pipeline.started even when an override or a
  // step-level value won — useful for "UI overrode the default" analytics.
  const explicit =
    typeof body.model === "string" ? body.model.trim() || undefined : undefined;
  const modelResolution = resolveChatModel(
    frontmatterCache,
    pipelineRoot,
    firstIter,
    explicit ?? null,
  );
  // Reasoning effort — same ladder, applied via the SDK's options.effort.
  const chatEffort = resolveChatEffort(
    frontmatterCache,
    pipelineRoot,
    firstIter,
    typeof body.effort === "string" ? body.effort : null,
  );
  log(
    `chat model resolution: pipeline=${pipelineLabel ?? "<none>"} ` +
      `explicit=${explicit ?? "<none>"} ` +
      `pipeline_default=${modelResolution.pipelineShorthand ?? "<none>"} ` +
      `resolved=${modelResolution.shorthand ?? "<session-default>"} ` +
      `→ model_id=${modelResolution.modelId ?? "<session-default>"} ` +
      `effort=${chatEffort ?? "<session-default>"}`,
  );

  // Prompt shape matches what /pipeline:run sends to step-executor when it
  // dispatches a subagent — step-executor's own system prompt already
  // explains the protocol, so we keep this short.
  const fullPrompt = firstIter
    ? `Execute pipeline iteration: ${firstIter}\n\nUser input / task brief:\n${body.prompt}`
    : body.prompt;
  const projectRoot = entry.project_root;

  // Build SSE response. We resolve the SDK lazily inside the stream's start
  // so the response headers go out immediately — the browser sees the
  // connection open and shows "Installing dependencies…" while bun runs.
  //
  // sdkAbort + sdkQuery are shared between start() (where the SDK runs) and
  // cancel() (which fires when the browser disconnects). Belt-and-suspenders:
  // abortController stops the SDK before it issues the NEXT request; q.interrupt()
  // sends a control_request to the running subprocess to interrupt the
  // current generation. We call both because abortController alone has been
  // observed to let the in-flight Anthropic response complete (the SDK only
  // checks the signal between requests).
  const sdkAbort = new AbortController();
  let sdkQuery: { interrupt?: () => Promise<void> } | null = null;
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (type: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          /* client closed */
        }
      };
      // Use a UUID-shaped runId so it sorts and dedupes alongside /pipeline:run
      // ids and shows up cleanly in the existing RunList.
      const runId = createHash("sha1")
        .update(`${Date.now()}-${Math.random()}`)
        .digest("hex")
        .slice(0, 12);

      let sawResult = false;
      let sawError = false;
      let sawAbort = false;
      try {
        send("chat.started", {
          session_id: runId,
          pipeline_name: body.pipeline_name ?? null,
          project_root: projectRoot,
        });

        // Emit pipeline.started + iteration.started so the UI's RunList /
        // IterationTree light up the same way they do for /pipeline:run.
        // Schema v3: pipeline.started carries `default_model` (the
        // PIPELINE.md frontmatter value or null) and iteration.started
        // carries `resolved_model` (the effective shorthand for this
        // step after step ?? pipeline; null when neither side specified).
        if (pipelineLabel && firstIter) {
          emitJournalEvent(
            projectRoot,
            runId,
            "pipeline.started",
            {
              pipeline_name: pipelineLabel,
              first_iteration_path: firstIter,
              pipeline_root: dirname(dirname(firstIter)),
              default_model: modelResolution.pipelineShorthand,
            },
            projectWorktree,
          );
          emitJournalEvent(
            projectRoot,
            runId,
            "iteration.started",
            {
              iteration_path: firstIter,
              index: 1,
              resolved_model: modelResolution.shorthand,
            },
            projectWorktree,
          );
        }

        const sdk = await loadAgentSdk();
        // Use the single `step-executor` worker (model: inherit) as the main
        // thread when a pipeline was picked — its system prompt already knows
        // the iteration protocol. The resolved tier is applied via the SDK's
        // per-call `model` option below (the old per-tier variant agents were
        // removed), so we never pick a `-haiku`/`-sonnet`/`-opus` agent here.
        const agentName = pipelineLabel ? "pipeline:step-executor" : undefined;
        const q = sdk.query({
          prompt: fullPrompt,
          options: {
            cwd: projectRoot,
            permissionMode: "bypassPermissions",
            // Use step-executor as the main thread when a pipeline was
            // picked — its system prompt already knows the iteration
            // protocol, so we skip a generic-Claude wrapper that would
            // otherwise burn tokens loading every installed skill before
            // doing anything useful.
            agent: agentName,
            // Model resolution (issue #7): caller body.model wins; else
            // step frontmatter ?? pipeline frontmatter ?? session default.
            // resolveChatModel returns modelId=undefined when nothing was
            // specified, so we spread conditionally to keep the SDK on its
            // session default in that case.
            ...(modelResolution.modelId ? { model: modelResolution.modelId } : {}),
            // Reasoning effort (step ?? pipeline frontmatter): omit when
            // inherited so the SDK keeps the session's effort level.
            ...(chatEffort ? { effort: chatEffort } : {}),
            // Wire the abort controller so a browser disconnect actually
            // stops the SDK (and stops billing tokens). cancel() below
            // calls both sdkAbort.abort() AND q.interrupt() — see the
            // sdkQuery comment for why both are needed.
            abortController: sdkAbort,
            env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "pipeline-ui/0.18" },
          },
        });
        // Expose to cancel() so the disconnect handler can also call
        // q.interrupt() — that sends an interrupt control message to the
        // running subprocess, which the abortController alone won't do for
        // an already-in-flight response.
        sdkQuery = q as unknown as { interrupt?: () => Promise<void> };
        let sessionPersisted = false;
        for await (const msg of q) {
          send("chat.message", msg);
          appendChatMessagePart(projectRoot, runId, msg);
          // Watch for the init message so we can persist our run_id ↔ SDK
          // session_id link. This is what makes a restarted daemon able to
          // resume the conversation via /api/chat/resume.
          const m = msg as {
            type?: string;
            subtype?: string;
            session_id?: string;
            is_error?: boolean;
          };
          if (!sessionPersisted && m.type === "system" && m.subtype === "init" && m.session_id) {
            recordChatSession(projectRoot, {
              run_id: runId,
              sdk_session_id: m.session_id,
              project_root: projectRoot,
              pipeline_name: pipelineLabel,
              iteration_path: firstIter,
              prompt: body.prompt,
              ts: new Date().toISOString(),
            });
            sessionPersisted = true;
            send("chat.session_linked", { run_id: runId, sdk_session_id: m.session_id });
          }
          if (m.type === "result") {
            sawResult = true;
            if (m.is_error) sawError = true;
          }
        }
        send("chat.completed", { session_id: runId });
      } catch (e) {
        // Distinguish a client-cancel (AbortError from sdkAbort.abort()) from
        // a genuine SDK/runtime failure. Without this, a deliberate browser
        // disconnect gets journaled as "chat session errored" instead of
        // "chat aborted", misleading anyone reading the run history.
        const isAbort =
          sdkAbort.signal.aborted ||
          (e instanceof Error &&
            (e.name === "AbortError" ||
              /abort/i.test(e.message ?? "")));
        if (isAbort) {
          sawAbort = true;
        } else {
          sawError = true;
          send("chat.error", {
            message: String(e instanceof Error ? e.message : e),
          });
        }
      } finally {
        // Always emit a terminal lifecycle event for the UI — even when the
        // SDK errored or the client disconnected before a result arrived.
        // Without this the IterationTree stays spinning forever.
        if (pipelineLabel && firstIter) {
          const outcome =
            sawError || sawAbort || !sawResult ? "halted" : "completed";
          const haltReason = sawError
            ? "chat session errored"
            : sawAbort || !sawResult
              ? "chat aborted"
              : null;
          emitJournalEvent(
            projectRoot,
            runId,
            "iteration.completed",
            {
              iteration_path: firstIter,
              outcome,
              next_iteration_path: null,
              has_improvement_brief: false,
              has_blocker_delegation: false,
              halt_reason: haltReason,
              // Schema v2 — explicit terminal marker so the client doesn't
              // need to infer "is this the last one?" from next_iteration_path.
              terminal: true,
            },
            projectWorktree,
          );
          emitJournalEvent(
            projectRoot,
            runId,
            outcome === "completed" ? "pipeline.completed" : "pipeline.halted",
            outcome === "completed"
              ? { pipeline_name: pipelineLabel }
              : {
                  pipeline_name: pipelineLabel,
                  iteration_path: firstIter,
                  halt_reason: haltReason,
                },
            projectWorktree,
          );
        }
        closed = true;
        try { controller.close(); } catch {}
      }
    },
    cancel() {
      // Browser disconnected — abort the SDK so it stops generating tokens.
      // Belt-and-suspenders:
      //   1. sdkAbort.abort()  — stops the SDK before its NEXT request
      //   2. q.interrupt()     — sends an interrupt control message to the
      //                          live subprocess, which kills generation of
      //                          the IN-FLIGHT response (this is the one
      //                          that matters for token-leak prevention)
      log(`chat client disconnected (aborting SDK)`);
      try { sdkAbort.abort(); } catch {}
      // interrupt() returns a Promise that *rejects* with "Operation aborted"
      // because we also called sdkAbort.abort() above — swallow the rejection
      // explicitly. Plain `void` doesn't catch async rejections in Bun and
      // the unhandled rejection would kill the daemon.
      try { sdkQuery?.interrupt?.()?.catch(() => {}); } catch {}
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// --------------------------------------------------------------------
// Chat resume — restart-survival via SDK session_id.
// --------------------------------------------------------------------

interface ChatResumeRequest {
  project_id: string;
  run_id: string;
  prompt?: string;
  /** Optional model override; see ChatRequest.model. */
  model?: string | null;
}

async function handleChatResume(req: Request): Promise<Response> {
  let body: ChatResumeRequest;
  try {
    body = (await req.json()) as ChatResumeRequest;
  } catch (e) {
    return new Response(`bad request: ${e}`, { status: 400 });
  }
  if (!body.project_id || !body.run_id) {
    return new Response("project_id and run_id are required", { status: 400 });
  }
  const entry = registry[body.project_id];
  if (!entry) return new Response("unknown project", { status: 404 });

  const rec = loadChatSession(entry.project_root, body.run_id);
  if (!rec) return new Response("no chat session for that run_id", { status: 404 });

  const projectRoot = entry.project_root;
  const projectWorktree = entry.worktree ?? null;
  const prompt =
    body.prompt?.trim() ||
    // Sensible default — the SDK requires a prompt, and "continue" reads
    // naturally as a user follow-up in the resumed transcript.
    "Please continue where the previous turn was interrupted.";

  // Resolve the model for the resumed call using the same contract as
  // handleChatRequest: explicit body.model wins; else step ?? pipeline
  // frontmatter; else session default. Locate pipelineRoot by name so
  // PIPELINE.md frontmatter is found even when the iteration sits in a
  // nested sub-folder under steps/.
  const explicit =
    typeof body.model === "string" ? body.model.trim() || undefined : undefined;
  let pipelineRoot: string | null = null;
  if (rec.pipeline_name) {
    const p = scanPipelines(entry.project_root).find(
      (x) => x.pipeline_name === rec.pipeline_name,
    );
    if (p) pipelineRoot = p.pipeline_root;
  }
  const modelResolution = resolveChatModel(
    frontmatterCache,
    pipelineRoot,
    rec.iteration_path,
    explicit ?? null,
  );
  const chatEffort = resolveChatEffort(frontmatterCache, pipelineRoot, rec.iteration_path, null);
  log(
    `chat resume model resolution: pipeline=${rec.pipeline_name ?? "<none>"} ` +
      `explicit=${explicit ?? "<none>"} ` +
      `pipeline_default=${modelResolution.pipelineShorthand ?? "<none>"} ` +
      `resolved=${modelResolution.shorthand ?? "<session-default>"} ` +
      `→ model_id=${modelResolution.modelId ?? "<session-default>"} ` +
      `effort=${chatEffort ?? "<session-default>"}`,
  );

  // Shared between start() and cancel(); see /api/chat for rationale.
  const sdkAbort = new AbortController();
  let sdkQuery: { interrupt?: () => Promise<void> } | null = null;
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (type: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          /* client closed */
        }
      };

      let sawResult = false;
      let sawError = false;
      let sawAbort = false;
      try {
        send("chat.resumed", {
          run_id: body.run_id,
          sdk_session_id: rec.sdk_session_id,
          pipeline_name: rec.pipeline_name,
          iteration_path: rec.iteration_path,
        });

        // Re-emit a dedicated "resumed" event (not iteration.started) so the
        // UI flips this run back to "running" without inflating
        // iteration.started counts in the per-step stats. The runs.ts fold
        // treats `iteration.resumed` the same as `iteration.started` for
        // status purposes but does NOT bump the per-iteration started_count.
        // Schema v3: stamp resolved_model so per-step stats reflect the
        // tier this resume actually ran on.
        if (rec.pipeline_name && rec.iteration_path) {
          emitJournalEvent(
            projectRoot,
            body.run_id,
            "iteration.resumed",
            {
              iteration_path: rec.iteration_path,
              index: 1,
              resolved_model: modelResolution.shorthand,
            },
            projectWorktree,
          );
        }

        const sdk = await loadAgentSdk();
        // Same worker as handleChatRequest — the single `step-executor`
        // (model: inherit); the resolved tier is applied via the per-call
        // `model` option below.
        const agentName = rec.pipeline_name ? "pipeline:step-executor" : undefined;
        const q = sdk.query({
          prompt,
          options: {
            cwd: projectRoot,
            permissionMode: "bypassPermissions",
            resume: rec.sdk_session_id,
            agent: agentName,
            ...(modelResolution.modelId ? { model: modelResolution.modelId } : {}),
            ...(chatEffort ? { effort: chatEffort } : {}),
            abortController: sdkAbort,
            env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "pipeline-ui/0.18" },
          },
        });
        sdkQuery = q as unknown as { interrupt?: () => Promise<void> };
        for await (const msg of q) {
          send("chat.message", msg);
          appendChatMessagePart(projectRoot, body.run_id, msg);
          const m = msg as { type?: string; is_error?: boolean };
          if (m.type === "result") {
            sawResult = true;
            if (m.is_error) sawError = true;
          }
        }
        send("chat.completed", { session_id: body.run_id });
      } catch (e) {
        const isAbort =
          sdkAbort.signal.aborted ||
          (e instanceof Error &&
            (e.name === "AbortError" ||
              /abort/i.test(e.message ?? "")));
        if (isAbort) {
          sawAbort = true;
        } else {
          sawError = true;
          send("chat.error", {
            message: String(e instanceof Error ? e.message : e),
          });
        }
      } finally {
        if (rec.pipeline_name && rec.iteration_path) {
          const outcome =
            sawError || sawAbort || !sawResult ? "halted" : "completed";
          const haltReason = sawError
            ? "chat resume errored"
            : sawAbort || !sawResult
              ? "chat resume aborted"
              : null;
          emitJournalEvent(
            projectRoot,
            body.run_id,
            "iteration.completed",
            {
              iteration_path: rec.iteration_path,
              outcome,
              next_iteration_path: null,
              has_improvement_brief: false,
              has_blocker_delegation: false,
              halt_reason: haltReason,
              terminal: true,
            },
            projectWorktree,
          );
          emitJournalEvent(
            projectRoot,
            body.run_id,
            outcome === "completed" ? "pipeline.completed" : "pipeline.halted",
            outcome === "completed"
              ? { pipeline_name: rec.pipeline_name }
              : {
                  pipeline_name: rec.pipeline_name,
                  iteration_path: rec.iteration_path,
                  halt_reason: haltReason,
                },
            projectWorktree,
          );
        }
        closed = true;
        try { controller.close(); } catch {}
      }
    },
    cancel() {
      log(`resume client disconnected (aborting SDK)`);
      try { sdkAbort.abort(); } catch {}
      // interrupt() returns a Promise that *rejects* with "Operation aborted"
      // because we also called sdkAbort.abort() above — swallow the rejection
      // explicitly. Plain `void` doesn't catch async rejections in Bun and
      // the unhandled rejection would kill the daemon.
      try { sdkQuery?.interrupt?.()?.catch(() => {}); } catch {}
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Read every persisted SDK message for `run_id` in order. Used by the UI to
 * rehydrate the chat transcript when the user clicks on a run that's running
 * (or already finished) in a different browser tab or after a daemon restart.
 */
function handleChatMessages(url: URL): Response {
  const pid = url.searchParams.get("project_id");
  const runId = url.searchParams.get("run_id");
  if (!pid || !runId) return new Response("missing params", { status: 400 });
  const entry = registry[pid];
  if (!entry) return new Response("unknown project", { status: 404 });
  // Fold archives too: rotation renames `chat-messages.jsonl` →
  // `chat-messages-<stamp>.jsonl`. Without walking those, a long-lived chat
  // that crossed the 50 MB threshold loses its full transcript the moment
  // the rotation fires.
  const current = join(
    entry.project_root,
    ".claude",
    "pipeline",
    ".runtime",
    "chat-messages.jsonl",
  );
  // Use the same shard discovery helper the journal uses. It tolerates a
  // missing current file (returns just archives) and a missing dir.
  const out: unknown[] = [];
  // Inline shard discovery so we don't need to expose a generic helper —
  // pattern: <stem>-*.jsonl in the .runtime/ dir, sorted lex (chronological
  // because stamps are ISO-ish). Then append the current file last.
  const runtimeDir = join(entry.project_root, ".claude", "pipeline", ".runtime");
  const shards: string[] = [];
  if (existsSync(runtimeDir)) {
    try {
      for (const name of readdirSync(runtimeDir)) {
        if (/^chat-messages-[^/\\]+\.jsonl$/.test(name)) {
          shards.push(join(runtimeDir, name));
        }
      }
      shards.sort();
    } catch (e) {
      log(`chat messages shard scan failed: ${e}`);
    }
  }
  if (existsSync(current)) shards.push(current);
  for (const path of shards) {
    try {
      const text = readFileSync(path, "utf-8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as {
            run_id: string;
            msg: unknown;
            source?: "mirror" | "sdk";
          };
          if (rec.run_id !== runId) continue;
          // Mirrored rows (issue #11) carry `source: "mirror"` at the
          // record level. The UI's MessageRow reads the field from the
          // msg object, so we copy it inline here. Existing SDK rows
          // omit source — leave them untouched.
          if (rec.source === "mirror" && rec.msg && typeof rec.msg === "object") {
            (rec.msg as Record<string, unknown>).source = "mirror";
          }
          out.push(rec.msg);
        } catch {
          /* skip malformed */
        }
      }
    } catch (e) {
      log(`chat messages read failed (${path}): ${e}`);
    }
  }
  return Response.json({ run_id: runId, messages: out });
}

/**
 * List chat sessions for a project. The UI uses this to figure out which
 * runs have a resumable SDK session attached, regardless of whether the
 * mapping was made by *this* daemon process or a previous one.
 */
async function handleListChatSessions(_req: Request, url: URL): Promise<Response> {
  const pid = url.searchParams.get("project_id");
  if (!pid) return new Response("missing project_id", { status: 400 });
  const entry = registry[pid];
  if (!entry) return new Response("unknown project", { status: 404 });
  const path = join(entry.project_root, ".claude", "pipeline", ".runtime", "chat-sessions.jsonl");
  if (!existsSync(path)) return Response.json({ sessions: [] });
  const seen = new Set<string>();
  const out: ChatSessionRecord[] = [];
  try {
    const text = readFileSync(path, "utf-8");
    const lines = text.split("\n").filter((l) => l.trim());
    // Walk newest-first so the most recent prompt for a run_id wins.
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const r = JSON.parse(lines[i]) as ChatSessionRecord;
        if (seen.has(r.run_id)) continue;
        seen.add(r.run_id);
        out.unshift(r);
      } catch {
        /* skip */
      }
    }
  } catch (e) {
    log(`list chat sessions failed: ${e}`);
  }
  return Response.json({ sessions: out });
}

// parseIterationSections is imported from ./lib.ts so tests can use it
// without booting the daemon.

function readRecentEvents(entry: ProjectEntry, max: number): unknown[] {
  const path = journalPath(entry);
  if (!existsSync(path)) return [];
  try {
    const text = readFileSync(path, "utf-8");
    const lines = text.split("\n").filter((l) => l.trim());
    return lines.slice(-max).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch (e) {
    log(`recent-events read failed: ${e}`);
    return [];
  }
}

function sseResponse(): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (msg: SSEMessage) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${msg.type}\ndata: ${JSON.stringify(msg.data)}\n\n`),
          );
        } catch {
          // client closed
        }
      };
      sseClients.add(send);
      // Initial hello + heartbeat.
      send({ type: "hello", data: { plugin_version: PLUGIN_VERSION } });
      const hb = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: hb\n\n`));
        } catch {
          clearInterval(hb);
          sseClients.delete(send);
        }
      }, 25000);
      // Cleanup hook stored on the controller via a side channel.
      (controller as any)._cleanup = () => {
        clearInterval(hb);
        sseClients.delete(send);
      };
    },
    cancel() {
      // ReadableStream cancel doesn't expose the controller, but we stored cleanup above.
      // Bun calls cancel when client disconnects.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// --------------------------------------------------------------------
// Version reconciliation — POST /api/restart-to hands the daemon off to a
// different plugin install directory. See the route comment in handleApi.
// --------------------------------------------------------------------

// Captured in bootDaemon so the restart handler can release the port before
// spawning the successor. Null until the daemon has bound.
let httpServer: ReturnType<typeof Bun.serve> | null = null;
// Set once a restart is in flight so a second concurrent POST is a no-op
// rather than spawning two successors. restartTarget records WHERE the
// in-flight handoff is going so a concurrent POST aimed elsewhere gets an
// honest answer (it will be reconciled again on the next session start).
let restarting = false;
let restartTarget: { plugin_root: string; plugin_version: string } | null = null;

// Actual port this daemon bound. Captured in bootDaemon so a handoff can hand
// the same port to the successor (PIPELINE_UI_RECLAIM_PORT) — open browser
// tabs reconnect to the same URL instead of breaking when the port walks.
let boundPort = 0;

// Grace window between acking the restart request and actually exiting, so
// the 202 response flushes and SSE clients receive the `restart` event before
// their connection drops. Kept short — the successor binds the same seed port,
// so browser EventSources reconnect within a second.
const RESTART_GRACE_MS = 750;

interface RestartToRequest {
  /** Must equal this daemon's pid (read by the caller from daemon.lock). */
  pid: number;
  /** Plugin install dir to hand off to; must contain apps/pipeline-ui/server.ts. */
  plugin_root: string;
}

async function handleRestartTo(req: Request): Promise<Response> {
  let body: RestartToRequest;
  try {
    body = (await req.json()) as RestartToRequest;
  } catch (e) {
    return new Response(`bad request: ${e}`, { status: 400 });
  }
  if (typeof body?.pid !== "number" || typeof body?.plugin_root !== "string") {
    return new Response("pid (number) and plugin_root (string) are required", {
      status: 400,
    });
  }
  // Correctness guard (not security): refuse if the caller is targeting a
  // different daemon than the one actually serving this request.
  if (body.pid !== process.pid) {
    return new Response(
      `pid mismatch: this daemon is ${process.pid}, request targeted ${body.pid}`,
      { status: 409 },
    );
  }
  const targetRoot = resolve(body.plugin_root);
  const targetScript = join(targetRoot, "apps", "pipeline-ui", "server.ts");
  if (!existsSync(targetScript)) {
    return new Response(
      `invalid plugin_root: no apps/pipeline-ui/server.ts under ${targetRoot}`,
      { status: 400 },
    );
  }
  const toVersion = pluginVersionAt(targetRoot);

  // Same-root no-op: nothing to do, and restarting would drop SSE clients for
  // no reason. Use the SAME normalization as the hook (case-insensitive on
  // Windows) — a raw === would treat c:/x and C:/x as different and restart in
  // a loop. The hook shouldn't call us in this case, but be defensive.
  if (normalizePathForCompare(PLUGIN_ROOT) === normalizePathForCompare(targetRoot)) {
    return Response.json({
      ok: true,
      restarted: false,
      reason: "already running from that plugin_root",
      pid: process.pid,
      plugin_version: PLUGIN_VERSION,
    });
  }

  if (restarting) {
    // A handoff is already scheduled. Report WHERE it's actually going so a
    // caller targeting a different root isn't told its own target won — it'll
    // see the in-flight target, and reconcile again next session if needed.
    return Response.json({
      ok: true,
      restarted: true,
      reason: "restart already in progress",
      pid: process.pid,
      to_version: restartTarget?.plugin_version ?? null,
      to_plugin_root: restartTarget?.plugin_root ?? null,
    });
  }
  restarting = true;
  restartTarget = {
    plugin_root: targetRoot.replaceAll("\\", "/"),
    plugin_version: toVersion,
  };

  // Tell every SSE client a handoff is coming so the UI can show a
  // "reconnecting to vX" affordance instead of a hard error when the socket
  // drops. Broadcast BEFORE we schedule the exit so it lands while clients
  // are still connected.
  broadcast({
    type: "restart",
    data: {
      from_version: PLUGIN_VERSION,
      to_version: toVersion,
      from_plugin_root: PLUGIN_ROOT.replaceAll("\\", "/"),
      to_plugin_root: targetRoot.replaceAll("\\", "/"),
      grace_ms: RESTART_GRACE_MS,
    },
  });

  scheduleHandoff(targetScript, toVersion);

  return Response.json({
    ok: true,
    restarted: true,
    from_version: PLUGIN_VERSION,
    to_version: toVersion,
    pid: process.pid,
    grace_ms: RESTART_GRACE_MS,
  });
}

/**
 * Release the port + lock, spawn the successor daemon detached, then exit.
 * Ordering is load-bearing: the successor's bootDaemon refuses to start if it
 * sees a live daemon (lock PID alive + /api/health responds) or an orphan on
 * the seed port. So we must (1) stop the HTTP server to free the port and (2)
 * delete our own lock BEFORE spawning, otherwise the successor exits as
 * "already_running" and the upgrade silently no-ops.
 */
function scheduleHandoff(targetScript: string, toVersion: string): void {
  setTimeout(() => {
    log(`handing off to ${targetScript} (v${toVersion})`);
    // 1. Stop accepting connections — frees the port for the successor.
    try {
      httpServer?.stop(true);
    } catch (e) {
      log(`server.stop during handoff failed: ${e}`);
    }
    // 2. Delete our lock so the successor's isExistingDaemonAlive() returns
    //    null. Only remove it if it's still OURS — never clobber a lock a
    //    racing daemon may have written.
    try {
      if (existsSync(LOCK_PATH)) {
        const txt = readFileSync(LOCK_PATH, "utf-8").trim();
        if (txt) {
          const lock: DaemonLock = JSON.parse(txt);
          if (lock.pid === process.pid) unlinkSync(LOCK_PATH);
        }
      }
    } catch (e) {
      log(`lock cleanup during handoff failed: ${e}`);
    }
    if (SUPERVISED) {
      // 3a. Supervised: don't self-spawn. Drop a handoff request and exit;
      //     the supervisor (still alive) reads it and spawns the new worker,
      //     so crash-recovery monitoring persists across the version change.
      try {
        writeFileSync(
          HANDOFF_PATH,
          JSON.stringify({ target_script: targetScript, reclaim_port: boundPort }),
          "utf-8",
        );
      } catch (e) {
        log(`failed to write handoff file: ${e}`);
      }
    } else {
      // 3b. Unsupervised (direct server.ts launch, e.g. tests): spawn the
      //     successor detached ourselves, handing it our port so open browser
      //     tabs reconnect to the same URL. This is the Phase 1/2 behavior.
      spawnSuccessor(targetScript, boundPort);
    }
    // 4. Exit. Either the supervisor or the detached successor takes over.
    process.exit(0);
  }, RESTART_GRACE_MS);
}

/**
 * Spawn the successor daemon detached, inheriting the same stdout/stderr log
 * files the SessionStart hook uses. Mirrors hooks/pipeline_ui_relay.ts's
 * spawnDaemon so behavior is identical regardless of who launches the daemon.
 */
function spawnSuccessor(targetScript: string, reclaimPort: number): void {
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    const stdoutLog = join(HOME_DIR, "daemon.stdout.log");
    const stderrLog = join(HOME_DIR, "daemon.stderr.log");
    // Truncate so the successor's boot output isn't appended after ours —
    // a failed handoff is then visible as the only content in the log.
    try { writeFileSync(stdoutLog, ""); } catch {}
    try { writeFileSync(stderrLog, ""); } catch {}
    let outFd: number | null = null;
    let errFd: number | null = null;
    try { outFd = openSync(stdoutLog, "a"); } catch {}
    try { errFd = openSync(stderrLog, "a"); } catch {}
    // Use the same runtime that's executing us (process.execPath = the bun
    // binary) rather than relying on `bun` being on PATH — the npm-shim
    // install on Windows isn't a real exe on PATH for detached children.
    const child = spawn(process.execPath, [targetScript], {
      detached: true,
      stdio: ["ignore", outFd ?? "ignore", errFd ?? "ignore"],
      // Hand the successor our port so it rebinds the same URL. Stripped of
      // PIPELINE_UI_RECLAIM_PORT for any of ITS descendants implicitly since
      // it only reads the var once at boot.
      env: { ...process.env, PIPELINE_UI_RECLAIM_PORT: String(reclaimPort) },
      windowsHide: true,
    });
    child.unref();
    if (outFd !== null) { try { closeSync(outFd); } catch {} }
    if (errFd !== null) { try { closeSync(errFd); } catch {} }
    log(`spawned successor pid=${child.pid}`);
  } catch (e) {
    log(`failed to spawn successor: ${e}`);
  }
}

// --------------------------------------------------------------------
// Version reconciliation — Phase 2: react to plugin installs/upgrades that
// happen WHILE the daemon runs, without waiting for a new SessionStart.
//
// Source of truth is ~/.claude/plugins/installed_plugins.json — Claude Code
// rewrites it on every per-project install/upgrade/downgrade and stamps a
// fresh lastUpdated. We watch it and, when an entry for THIS plugin is touched
// (its lastUpdated advances past what we captured at boot), hand off to that
// entry's installPath. This follows the most-RECENT install action, matching
// Phase 1's most-recent-session rule and the daemon-tracks-installed-version
// invariant (NOT highest-semver: a downgrade is honored too). Picking by
// shared parent dir means a deliberately-pinned OLDER version still wins if it
// was the last thing installed.
// --------------------------------------------------------------------

const INSTALLED_PLUGINS_PATH = process.env.PIPELINE_UI_INSTALLED_PLUGINS_PATH
  ? resolve(process.env.PIPELINE_UI_INSTALLED_PLUGINS_PATH)
  : join(homedir(), ".claude", "plugins", "installed_plugins.json");

// Newest lastUpdated (epoch ms) among this plugin's installed entries seen so
// far. Seeded at boot to the CURRENT global-newest (not the daemon's own
// version) so Phase 2 reacts only to FUTURE changes — seeding to our own entry
// would make the daemon immediately fight Phase 1 by jumping to whatever newer
// sibling another project already pinned. Only a value strictly greater
// triggers a handoff, so an unrelated plugin's install is ignored.
let baselineInstalledUpdated = 0;
// Retain the watcher handle so it isn't garbage-collected — fsWatch with
// { persistent: false } does not root the event loop, and attachProjectWatchers
// keeps its handles for the same reason.
let installedPluginsWatcher: ReturnType<typeof fsWatch> | null = null;

function readNewestInstalledSibling(): { installPath: string; version: string; updatedMs: number } | null {
  let raw: string;
  try {
    raw = readFileSync(INSTALLED_PLUGINS_PATH, "utf-8");
  } catch {
    return null;
  }
  return pickNewestPluginSibling(raw, dirname(PLUGIN_ROOT));
}

/**
 * A handoff target only looks bootable if the core daemon files AND the UI
 * bundle are present. Claude Code can rewrite installed_plugins.json (stamping
 * a fresh lastUpdated) BEFORE it finishes extracting the new cache dir, so a
 * server.ts-only check can fire mid-extraction and hand off to a half-written
 * install whose imports (lib.ts etc.) or dist/ aren't there yet — the
 * successor would crash on boot. Requiring these three makes that race far less
 * likely; the reconcile that skips on this check does NOT advance the baseline,
 * so the periodic poll retries once extraction completes.
 */
function targetLooksComplete(installRoot: string): boolean {
  const ui = join(installRoot, "apps", "pipeline-ui");
  return (
    existsSync(join(ui, "server.ts")) &&
    existsSync(join(ui, "lib.ts")) &&
    existsSync(join(ui, "dist"))
  );
}

/**
 * Re-read installed_plugins.json and, if THIS plugin was installed/upgraded/
 * downgraded since boot to a different (complete) install dir, hand off to it.
 * Guards:
 *   - ignore when a restart is already in flight;
 *   - ignore unless the newest entry's lastUpdated advanced past the baseline
 *     (so unrelated plugins' installs don't bounce us);
 *   - when the newest is our own root, advance the baseline and stop (current);
 *   - when the target is incomplete (mid-extraction), DON'T advance the
 *     baseline so the next poll retries once extraction finishes.
 * Safe to call repeatedly (from the watcher AND the poll) — it's idempotent.
 */
function reconcileToNewestInstalled(): void {
  if (restarting) return;
  const newest = readNewestInstalledSibling();
  if (!newest) return;
  if (newest.updatedMs <= baselineInstalledUpdated) return;
  if (normalizePathForCompare(newest.installPath) === normalizePathForCompare(PLUGIN_ROOT)) {
    // We're already running the most-recently-installed version. Advance the
    // baseline so we don't re-evaluate this same entry every poll.
    baselineInstalledUpdated = newest.updatedMs;
    return;
  }
  if (!targetLooksComplete(newest.installPath)) {
    // Likely a partial install (json written before the cache dir is fully
    // extracted). Do NOT advance the baseline — let the poll retry until the
    // target is bootable, rather than permanently skipping this upgrade.
    log(`installed entry ${newest.installPath} not fully extracted yet; will retry`);
    return;
  }
  // Committed to handing off — advance the baseline so a duplicate event
  // doesn't schedule a second handoff before we exit.
  baselineInstalledUpdated = newest.updatedMs;
  log(`installed_plugins.json change → self-reconciling to ${newest.installPath} (v${newest.version})`);
  restarting = true;
  restartTarget = {
    plugin_root: newest.installPath.replaceAll("\\", "/"),
    plugin_version: newest.version,
  };
  broadcast({
    type: "restart",
    data: {
      from_version: PLUGIN_VERSION,
      to_version: newest.version,
      from_plugin_root: PLUGIN_ROOT.replaceAll("\\", "/"),
      to_plugin_root: newest.installPath.replaceAll("\\", "/"),
      grace_ms: RESTART_GRACE_MS,
    },
  });
  scheduleHandoff(join(newest.installPath, "apps", "pipeline-ui", "server.ts"), newest.version);
}

interface UpdateStatusBody {
  current_version: string;
  current_plugin_root: string;
  /** Non-null when a complete install other than the running root is the
   *  most-recently-installed sibling — i.e. "Update & Restart" would land
   *  somewhere new. */
  update: { plugin_root: string; version: string } | null;
  restarting: boolean;
}

function computeUpdateStatus(): UpdateStatusBody {
  let update: ReturnType<typeof resolvePendingUpdate> = null;
  try {
    const raw = readFileSync(INSTALLED_PLUGINS_PATH, "utf-8");
    update = resolvePendingUpdate(raw, PLUGIN_ROOT, targetLooksComplete);
  } catch {
    // No installed_plugins.json (source checkout / tests) → no update.
  }
  return {
    current_version: PLUGIN_VERSION,
    current_plugin_root: PLUGIN_ROOT.replaceAll("\\", "/"),
    update: update
      ? { plugin_root: update.plugin_root.replaceAll("\\", "/"), version: update.version }
      : null,
    restarting,
  };
}

/**
 * Self-restart: hand off to the pending update when one is installed, else
 * re-exec from the current root. Reuses the exact broadcast + scheduleHandoff
 * sequence of /api/restart-to and reconcileToNewestInstalled, so SSE clients
 * see the same `restart` frame and the successor reclaims the same port.
 * Same-root restarts are ALLOWED here (unlike restart-to's defensive no-op,
 * which exists to stop hook loops): this endpoint only fires on an explicit
 * user action, where "restart anyway" is the point.
 */
function handleRestartSelf(): Response {
  if (restarting) {
    return Response.json({
      ok: true,
      restarted: true,
      reason: "restart already in progress",
      to_version: restartTarget?.plugin_version ?? null,
      to_plugin_root: restartTarget?.plugin_root ?? null,
    });
  }
  const status = computeUpdateStatus();
  const targetRoot = status.update ? resolve(status.update.plugin_root) : PLUGIN_ROOT;
  const toVersion = status.update?.version ?? PLUGIN_VERSION;
  const targetScript = join(targetRoot, "apps", "pipeline-ui", "server.ts");
  if (!existsSync(targetScript)) {
    return new Response(
      `restart target has no apps/pipeline-ui/server.ts under ${targetRoot}`,
      { status: 500 },
    );
  }
  restarting = true;
  restartTarget = {
    plugin_root: targetRoot.replaceAll("\\", "/"),
    plugin_version: toVersion,
  };
  broadcast({
    type: "restart",
    data: {
      from_version: PLUGIN_VERSION,
      to_version: toVersion,
      from_plugin_root: PLUGIN_ROOT.replaceAll("\\", "/"),
      to_plugin_root: targetRoot.replaceAll("\\", "/"),
      grace_ms: RESTART_GRACE_MS,
    },
  });
  scheduleHandoff(targetScript, toVersion);
  return Response.json({
    ok: true,
    restarted: true,
    updated: status.update !== null,
    from_version: PLUGIN_VERSION,
    to_version: toVersion,
    pid: process.pid,
    grace_ms: RESTART_GRACE_MS,
  });
}

/**
 * Watch installed_plugins.json for post-boot changes to THIS plugin and
 * reconcile. Watches the containing directory (not the file) so it survives
 * Claude Code's atomic write-then-rename, debounces a burst of events into one
 * reconcile, and matches both the exact basename AND temp-rename variants
 * (e.g. installed_plugins.json.tmp123) since Windows' rename event often
 * reports the temp name. A periodic poll in bootDaemon backstops any event the
 * watcher misses entirely (Windows fsWatch is flaky — same reason the journal
 * watcher has a poll). No-op if the file's directory doesn't exist.
 */
function watchInstalledPlugins(): void {
  const seed = readNewestInstalledSibling();
  baselineInstalledUpdated = seed?.updatedMs ?? 0;
  const dir = dirname(INSTALLED_PLUGINS_PATH);
  const base = basename(INSTALLED_PLUGINS_PATH);
  if (!existsSync(dir)) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    installedPluginsWatcher = fsWatch(dir, { persistent: false }, (_evt, fname) => {
      // Accept the exact name, a temp/rename variant that contains it, or a
      // null filename (some platforms omit it); the poll covers the rest.
      const f = fname ? fname.toString() : "";
      if (f && f !== base && !f.includes(base)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        reconcileToNewestInstalled();
      }, 600);
    });
  } catch (e) {
    log(`installed_plugins watch failed: ${e}`);
  }
}

// --------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------

const bootAt = Date.now();

async function bootDaemon(): Promise<void> {
  const existing = await isExistingDaemonAlive();
  if (existing) {
    // Another daemon is already serving — tell our supervisor to stop too
    // (don't respawn us into a no-op) before exiting cleanly.
    requestSupervisorStop();
    console.log(JSON.stringify({ ok: true, already_running: true, port: existing.port }));
    process.exit(0);
  }

  // Lock is missing or stale; check whether something is already listening on
  // the deterministic seed port before we try to bind elsewhere. Without this
  // probe an orphan daemon (e.g., started by an older code path that never
  // wrote a lock) would keep running, AND a second daemon would bind to a
  // walked port — both pointed at the same shared registry.
  const orphan = await probeOrphanDaemon();
  if (orphan) {
    try {
      mkdirSync(HOME_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, JSON.stringify(orphan, null, 2));
    } catch (e) {
      log(`failed to recover orphan lock: ${e}`);
    }
    requestSupervisorStop();
    console.log(
      JSON.stringify({ ok: true, already_running: true, recovered: true, port: orphan.port }),
    );
    process.exit(0);
  }

  const port = await acquirePort();
  boundPort = port;

  httpServer = Bun.serve({
    hostname: HOST,
    port,
    // Disable Bun's per-request idle timeout (default 10s). This daemon's core
    // endpoints are long-lived streams — the `/api/stream` SSE channel only
    // heartbeats every 25s, and `/api/chat` can go minutes between Agent-SDK
    // messages during long tool runs. With the 10s default, Bun force-closed
    // every SSE connection before the 25s heartbeat could keep it alive, so
    // every browser's live feed dropped + reconnected every ~10s (visible as
    // repeated "request timed out after 10 seconds" in the daemon log and a
    // perpetually-stale dashboard). 0 = no idle timeout; liveness is handled
    // app-side by the SSE heartbeat + the client's EventSource reconnect.
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // Token gate (no-op when PIPELINE_UI_TOKEN is unset — the loopback
      // default). A valid ?token= visit pins a cookie so asset/SSE requests
      // pass without the query param.
      const denied = checkAuth(req, url, AUTH_TOKEN);
      if (denied) return denied;
      const res = url.pathname.startsWith("/api/") ? await handleApi(req, url) : await handleStatic(url.pathname);
      return maybeSetTokenCookie(res, url, AUTH_TOKEN);
    },
  });

  writeLock(port);
  if (HOST_CONFIG.warning) console.error(`[pipeline-ui] WARNING: ${HOST_CONFIG.warning}`);
  console.log(JSON.stringify({ ok: true, port, plugin_version: PLUGIN_VERSION, url: `http://${HOST}:${port}/` }));
  log(`listening on ${HOST}:${port}${AUTH_TOKEN ? " (token auth ON)" : ""}`);

  // Start the messages-mirror tailer (issue #11). The service rebuilds
  // its binding map from ~/.claude/pipeline-ui/active-mirror-bindings.jsonl
  // and tails each bound terminal-session transcript into the matching
  // project's chat-messages.jsonl. Strict scope: it never reads a
  // transcript that didn't get explicitly bound by the PostToolUse
  // hook (or by recursive subagent discovery from a bound transcript).
  mirrorService = new MirrorService({
    enabled: TRANSCRIPTS_ENABLED,
    appendChat: (projectRoot, runId, msg, opts) => {
      appendChatMessagePart(projectRoot, runId, msg, opts);
    },
  });
  mirrorService.start();
  if (!TRANSCRIPTS_ENABLED) {
    log("PIPELINE_UI_TRANSCRIPTS off — transcript mirror + folded run-stats disabled");
  }

  // A daemon restart kills any in-flight /api/chat SDK query, so chat-driven
  // runs still non-terminal in the journal are dead — retire them so they
  // don't linger as "active". Deferred + best-effort so it never delays serving.
  setTimeout(() => reconcileDeadChatRunsAtBoot(), 1000);

  // First backfill pass at boot rather than 60 s in: a daemon usually starts
  // right after the session that produced the unenriched records, so this is
  // the moment the numbers are most likely missing and most likely wanted.
  // Deferred + best-effort, same posture as the reconcile above.
  setTimeout(() => {
    for (const e of Object.values(registry)) {
      try {
        sweepStatsBackfill(e);
      } catch {
        // never let a stats hiccup disturb boot
      }
    }
  }, 1500);

  // Dead-run liveness backstop: /api/runs sweeps the requested project on the
  // hot path, but a project whose dashboard nobody is watching still needs its
  // crashed runs retired. Sweep every project with a runs/ lockfile dir every
  // 60s (early-returns for the vast majority that have none).
  setInterval(() => {
    for (const e of Object.values(registry)) {
      sweepManagerStoppedRuns(e);
      sweepProjectLiveness(e);
      sweepInterruptedRuns(e);
      // Recovery rung T4 (design 04): the same shared backfill core the hook,
      // the run-init kick and `pipeline stats backfill` call, on a timer — so
      // a run whose enrichment never landed (no Stop ever fired in that
      // session, the machine slept, the hook was opted out at the time) is
      // reconciled without the user doing anything.
      sweepStatsBackfill(e);
    }
  }, 60_000);

  // Phase 2 version reconciliation: watch installed_plugins.json so a plugin
  // upgrade performed mid-session (in another terminal) is picked up without
  // waiting for a new Claude Code session to fire the SessionStart hook.
  watchInstalledPlugins();
  // Poll backstop for the watcher — fsWatch on Windows is flaky (atomic
  // rename may report the temp name, or the event may be dropped under load),
  // so re-check every 30s. reconcileToNewestInstalled is idempotent + guarded
  // by the baseline, so this is a cheap no-op unless an upgrade actually
  // happened (or a previously-incomplete target finished extracting).
  setInterval(() => reconcileToNewestInstalled(), 30_000);

  // Periodic journal poll as fs.watch safety net. Windows fsWatch is flaky
  // for in-place appends; a tight poll keeps event-to-UI latency under a
  // second even when the watcher misses entirely.
  setInterval(() => {
    for (const entry of Object.values(registry)) readJournalIncremental(entry);
  }, 400);

  // Idle-shutdown.
  setInterval(() => {
    const idle = Date.now() - lastEventAt;
    if (idle > IDLE_MINUTES * 60_000 && sseClients.size === 0) {
      log(`idle for ${idle}ms with no clients, shutting down`);
      // Deliberate stop — supervisor must NOT respawn us.
      requestSupervisorStop();
      try {
        if (existsSync(LOCK_PATH)) {
          const txt = readFileSync(LOCK_PATH, "utf-8").trim();
          if (txt) {
            const lock: DaemonLock = JSON.parse(txt);
            if (lock.pid === process.pid) {
              try { unlinkSync(LOCK_PATH); } catch {}
            }
          }
        }
      } catch {}
      process.exit(0);
    }
  }, 60_000);

  // Graceful shutdown on signals.
  const cleanup = () => {
    try {
      if (existsSync(LOCK_PATH)) {
        const txt = readFileSync(LOCK_PATH, "utf-8").trim();
        if (txt) {
          const lock: DaemonLock = JSON.parse(txt);
          if (lock.pid === process.pid) {
            try { unlinkSync(LOCK_PATH); } catch {}
          }
        }
      }
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

bootDaemon().catch((e) => {
  console.error(`pipeline-ui daemon failed to start: ${e}`);
  process.exit(1);
});
