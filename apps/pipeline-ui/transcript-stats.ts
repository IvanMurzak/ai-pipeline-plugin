/**
 * Per-run tool/token stats, folded from the RAW Claude Code transcripts.
 *
 * Why this exists: the hook-emitted `tool.called` / `turn.usage` events are an
 * unreliable stats source. `turn.usage` (from the Stop hook) tails the MAIN
 * session transcript — but in a pipeline run the real work (and the real
 * tokens) happen inside the manager + step-executor SUBAGENT transcripts, which
 * no hook tails, so per-run tokens come out near-zero. And `tool.called`
 * correlation leaks ~half its events to `run_id=null`. Ground-truth validation
 * against real runs showed the only complete source is the transcripts
 * themselves: the manager's transcript plus every subagent transcript spawned
 * inside its run window.
 *
 * This module reads those transcript files directly and folds the canonical
 * stats. It is pure I/O over the filesystem + parsing; the daemon (server.ts)
 * resolves WHICH files belong to a run (via the mirror-binding index + the
 * run's event window) and caches the result. Completed runs are immutable, so
 * the daemon caches their stats permanently; a live run is recomputed on a TTL.
 *
 * Attribution model: a session transcript can host MANY runs over time, so we
 * NEVER trust file membership alone — every transcript ENTRY is gated by the
 * run's [windowStart, windowEnd] timestamp window. Subagent files are
 * pre-filtered by birthtime as a cheap optimization, but correctness comes from
 * the per-entry timestamp gate.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import {
  emptyToolTokenCounters,
  isAgentSpawnTool,
  normalizePathForCompare,
  toEpochOrNull,
  type ToolTokenCounters,
} from "./lib.ts";
import { claudeProjectsDir, encodeClaudeProjectDir } from "./transcripts.ts";

/** Per-run tool/token stats. Same 7-field shape the event fold uses — the field
 *  set is single-sourced as `ToolTokenCounters` in lib.ts, so a new metric is
 *  added in one place and both folds stay aligned. */
export type TranscriptRunStats = ToolTokenCounters;

export const emptyTranscriptRunStats = emptyToolTokenCounters;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Small slack (ms) on the window so an entry written a beat before/after the
 *  lifecycle event timestamps isn't dropped (clock skew + fs granularity). */
const WINDOW_SLACK_MS = 2000;
const BIRTHTIME_SLACK_MS = 5000;

interface Window {
  start: number | null; // epoch ms; null = open start
  end: number | null; // epoch ms; null = open end (live run)
}

// toEpochOrNull is imported from lib.ts (the Window invariant — "finite number
// or null" — holds by construction so downstream gates never re-check NaN).

/** Fold one parsed transcript entry into the accumulator, gated by the window.
 *  Exported for unit tests. */
export function foldTranscriptEntry(
  entry: unknown,
  acc: TranscriptRunStats,
  win: Window,
): void {
  if (!entry || typeof entry !== "object") return;
  const e = entry as Record<string, unknown>;
  const type = typeof e.type === "string" ? e.type : "";
  // Window gate by the entry's own timestamp. An unparseable timestamp is
  // treated as IN-window only when the window is fully open; otherwise it is
  // dropped (we cannot prove it belongs to this run).
  const tsRaw = typeof e.timestamp === "string" ? e.timestamp : "";
  const ts = tsRaw ? Date.parse(tsRaw) : NaN;
  if (win.start !== null || win.end !== null) {
    if (!Number.isFinite(ts)) return;
    if (win.start !== null && ts < win.start - WINDOW_SLACK_MS) return;
    if (win.end !== null && ts > win.end + WINDOW_SLACK_MS) return;
  }
  const message = e.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") return;
  const role = typeof message.role === "string" ? message.role : type;
  const content = message.content;

  if (role === "assistant") {
    const u = message.usage as Record<string, unknown> | undefined;
    if (u) {
      acc.input_tokens += num(u.input_tokens);
      acc.output_tokens += num(u.output_tokens);
      acc.cache_read_tokens += num(u.cache_read_input_tokens);
      acc.cache_creation_tokens += num(u.cache_creation_input_tokens);
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_use") continue;
        acc.tools_called += 1;
        if (isAgentSpawnTool(b.name)) acc.agents_spawned += 1;
      }
    }
  }
  // tool_result blocks (carried on `user` entries) report failures.
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_result" && b.is_error === true) acc.tools_failed += 1;
    }
  }
}

// --------------------------------------------------------------------
// Per-failure detail (/api/run-failures) — same transcript walk as the stats
// fold, but instead of counting `tool_result` errors it captures WHAT failed:
// the tool name + input (resolved from the preceding tool_use block with the
// same id) and the error text the tool returned.
// --------------------------------------------------------------------

export interface ToolFailure {
  ts: string;
  tool_name: string | null;
  /** Compact JSON of the tool_use input (truncated) — e.g. the command that failed. */
  input_excerpt: string | null;
  error_excerpt: string;
  source: "manager" | "subagent";
}

const FAILURE_INPUT_EXCERPT_MAX = 400;
const FAILURE_ERROR_EXCERPT_MAX = 1000;

/** Flatten a tool_result / message content value to plain text. */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

function excerpt(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max) + " […]" : t;
}

/** Collect window-gated tool failures from ONE transcript file. tool_use
 *  blocks always precede their tool_result in the same session file, so a
 *  single streaming pass with an id→use map resolves names and inputs. */
export function collectFailuresFromFile(
  path: string,
  win: Window,
  source: ToolFailure["source"],
  out: ToolFailure[],
  cap: number,
): void {
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  const useById = new Map<string, { name: string | null; input: string | null }>();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(t);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const message = e.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    // Index tool_use blocks UNGATED — a use just before the window's start
    // slack must still resolve the name for an in-window failure.
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_use" || typeof b.id !== "string") continue;
      let input: string | null = null;
      try {
        input = b.input === undefined ? null : JSON.stringify(b.input);
      } catch {
        input = null;
      }
      useById.set(b.id, {
        name: typeof b.name === "string" ? b.name : null,
        input: input ? excerpt(input, FAILURE_INPUT_EXCERPT_MAX) : null,
      });
    }
    // Failure capture is window-gated with the same rules as the stats fold.
    const tsRaw = typeof e.timestamp === "string" ? e.timestamp : "";
    const ts = tsRaw ? Date.parse(tsRaw) : NaN;
    if (win.start !== null || win.end !== null) {
      if (!Number.isFinite(ts)) continue;
      if (win.start !== null && ts < win.start - WINDOW_SLACK_MS) continue;
      if (win.end !== null && ts > win.end + WINDOW_SLACK_MS) continue;
    }
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_result" || b.is_error !== true) continue;
      if (out.length >= cap) return;
      const use = typeof b.tool_use_id === "string" ? useById.get(b.tool_use_id) : undefined;
      out.push({
        ts: tsRaw,
        tool_name: use?.name ?? null,
        input_excerpt: use?.input ?? null,
        error_excerpt: excerpt(textOfContent(b.content), FAILURE_ERROR_EXCERPT_MAX),
        source,
      });
    }
  }
}

export const RUN_FAILURES_CAP = 200;

/** Hard per-run collection bound — a memory backstop far above anything the
 *  UI will show; the display cap is applied AFTER the chronological sort so
 *  a full manager file can't crowd out earlier subagent failures. Exported:
 *  the .stats enrichment paths (hooks/stats_relay.ts + pipeline-cli
 *  step-transcripts.ts) collect against the same bound. */
export const RUN_FAILURES_COLLECT_MAX = 5000;

/** All tool failures for a run: the manager/parent transcript + every
 *  in-window subagent transcript, chronological. Mirrors
 *  foldRunStatsFromTranscript's file walk so both endpoints agree on which
 *  entries belong to the run. Collects everything (bounded by the backstop),
 *  sorts, THEN caps — so the kept `cap` entries are the chronologically
 *  first across ALL files, not whichever file was walked first. */
export function collectRunToolFailures(
  managerTranscriptPath: string | null,
  windowStartIso: string | null,
  windowEndIso: string | null,
  cap: number = RUN_FAILURES_CAP,
): { failures: ToolFailure[]; truncated: boolean } {
  const all: ToolFailure[] = [];
  if (!managerTranscriptPath) return { failures: all, truncated: false };
  const win: Window = { start: toEpochOrNull(windowStartIso), end: toEpochOrNull(windowEndIso) };
  collectFailuresFromFile(managerTranscriptPath, win, "manager", all, RUN_FAILURES_COLLECT_MAX);
  for (const sub of inWindowSubagentFiles(managerTranscriptPath, win)) {
    if (all.length >= RUN_FAILURES_COLLECT_MAX) break;
    collectFailuresFromFile(sub, win, "subagent", all, RUN_FAILURES_COLLECT_MAX);
  }
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { failures: all.slice(0, cap), truncated: all.length > cap };
}

// --------------------------------------------------------------------
// Per-run breakdown (/api/run-breakdown) — behind the TOOLS/AGENTS tiles.
// Same transcript walk as the stats fold, but keeps STRUCTURE: every tool
// call with its duration (tool_use ts → tool_result ts), per-tool-name
// aggregates, and one row per spawned agent with its own token fold.
// --------------------------------------------------------------------

export interface ToolCallDetail {
  ts: string;
  tool_name: string;
  /** tool_result ts − tool_use ts, ms. null while the result hasn't landed
   *  (still running / crashed mid-call). */
  duration_ms: number | null;
  is_error: boolean;
  input_excerpt: string | null;
  source: "manager" | "subagent";
}

export interface ToolAggregate {
  name: string;
  calls: number;
  failed: number;
  /** Sum over CLOSED calls (open calls contribute nothing). */
  total_duration_ms: number;
  max_duration_ms: number;
}

export interface AgentDetail {
  /** subagent_type from the Agent tool_use input, when present. */
  agent_type: string | null;
  /** The spawn's `description` (short label) or a prompt excerpt. */
  description: string | null;
  started_at: string | null;
  /** Parent-view duration: Agent tool_use → its tool_result. Falls back to
   *  the matched transcript's first→last entry span. */
  duration_ms: number | null;
  tools_called: number;
  tools_failed: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  /** false when no subagent transcript file could be matched to this spawn —
   *  token/tool counts are then zero, not "really zero". */
  matched: boolean;
}

export interface RunBreakdown {
  tools: ToolAggregate[];
  /** Individual calls, chronological, capped (see truncated flag). */
  calls: ToolCallDetail[];
  calls_truncated: boolean;
  agents: AgentDetail[];
}

const BREAKDOWN_CALLS_CAP = 500;
const BREAKDOWN_COLLECT_MAX = 20_000;
/** Max spawn-ts ↔ transcript-first-entry gap for agent↔file matching. */
const AGENT_MATCH_SLACK_MS = 180_000;

interface AgentSpawn {
  ts: number;
  tsIso: string;
  agent_type: string | null;
  description: string | null;
  tool_use_id: string;
  duration_ms: number | null;
}

interface SubagentFileFold {
  firstTs: number | null;
  lastTs: number | null;
  tools_called: number;
  tools_failed: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

/** One streaming pass over a transcript file collecting tool-call details
 *  (window-gated on the tool_use entry) and, when `spawns` is given, Agent
 *  spawn records. Exported for unit tests. */
export function collectCallsFromFile(
  path: string,
  win: Window,
  source: ToolCallDetail["source"],
  calls: ToolCallDetail[],
  spawns: AgentSpawn[] | null,
  fold?: SubagentFileFold,
): void {
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  // tool_use id → index into `calls` / `spawns`, so the matching tool_result
  // can close the call with a duration + error flag.
  const openCalls = new Map<string, number>();
  const openSpawns = new Map<string, number>();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(t);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const tsRaw = typeof e.timestamp === "string" ? e.timestamp : "";
    const ts = tsRaw ? Date.parse(tsRaw) : NaN;
    const inWindow =
      win.start === null && win.end === null
        ? true
        : Number.isFinite(ts) &&
          (win.start === null || ts >= win.start - WINDOW_SLACK_MS) &&
          (win.end === null || ts <= win.end + WINDOW_SLACK_MS);
    const message = e.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_use" && typeof b.name === "string") {
        if (!inWindow || calls.length >= BREAKDOWN_COLLECT_MAX) continue;
        const isSpawn = isAgentSpawnTool(b.name);
        if (isSpawn && spawns) {
          const input = (b.input ?? {}) as Record<string, unknown>;
          const desc =
            typeof input.description === "string"
              ? input.description
              : typeof input.prompt === "string"
                ? input.prompt.slice(0, 140)
                : null;
          spawns.push({
            ts: Number.isFinite(ts) ? ts : 0,
            tsIso: tsRaw,
            agent_type: typeof input.subagent_type === "string" ? input.subagent_type : null,
            description: desc,
            tool_use_id: typeof b.id === "string" ? b.id : "",
            duration_ms: null,
          });
          if (typeof b.id === "string") openSpawns.set(b.id, spawns.length - 1);
        }
        let input: string | null = null;
        try {
          input = b.input === undefined ? null : JSON.stringify(b.input);
        } catch {
          input = null;
        }
        calls.push({
          ts: tsRaw,
          tool_name: b.name,
          duration_ms: null,
          is_error: false,
          input_excerpt: input ? excerpt(input, FAILURE_INPUT_EXCERPT_MAX) : null,
          source,
        });
        if (typeof b.id === "string") openCalls.set(b.id, calls.length - 1);
      } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const ci = openCalls.get(b.tool_use_id);
        if (ci !== undefined) {
          openCalls.delete(b.tool_use_id);
          const started = Date.parse(calls[ci].ts);
          if (Number.isFinite(ts) && Number.isFinite(started)) {
            calls[ci].duration_ms = Math.max(0, ts - started);
          }
          if (b.is_error === true) calls[ci].is_error = true;
        }
        const si = spawns ? openSpawns.get(b.tool_use_id) : undefined;
        if (spawns && si !== undefined) {
          openSpawns.delete(b.tool_use_id);
          if (Number.isFinite(ts) && spawns[si].ts > 0) {
            spawns[si].duration_ms = Math.max(0, ts - spawns[si].ts);
          }
        }
      }
    }
    // Per-file usage fold (subagent token attribution).
    if (fold && inWindow) {
      if (Number.isFinite(ts)) {
        if (fold.firstTs === null || ts < fold.firstTs) fold.firstTs = ts;
        if (fold.lastTs === null || ts > fold.lastTs) fold.lastTs = ts;
      }
      const role = typeof message?.role === "string" ? message.role : "";
      if (role === "assistant") {
        const u = message?.usage as Record<string, unknown> | undefined;
        if (u) {
          fold.input_tokens += num(u.input_tokens);
          fold.output_tokens += num(u.output_tokens);
          fold.cache_read_tokens += num(u.cache_read_input_tokens);
          fold.cache_creation_tokens += num(u.cache_creation_input_tokens);
        }
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b?.type === "tool_use") fold.tools_called += 1;
        }
      }
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b?.type === "tool_result" && b.is_error === true) fold.tools_failed += 1;
      }
    }
  }
}

/** Full TOOLS/AGENTS breakdown for one run. Tool calls come from the manager
 *  + every in-window subagent transcript; agent rows come from the Agent
 *  tool_use spawns, each matched (by start-time proximity) to a subagent
 *  transcript whose own fold provides the agent's tokens/tool counts. */
export function collectRunBreakdown(
  managerTranscriptPath: string | null,
  windowStartIso: string | null,
  windowEndIso: string | null,
): RunBreakdown {
  const empty: RunBreakdown = { tools: [], calls: [], calls_truncated: false, agents: [] };
  if (!managerTranscriptPath) return empty;
  const win: Window = { start: toEpochOrNull(windowStartIso), end: toEpochOrNull(windowEndIso) };

  const calls: ToolCallDetail[] = [];
  const spawns: AgentSpawn[] = [];
  collectCallsFromFile(managerTranscriptPath, win, "manager", calls, spawns);

  const subFolds: Array<{ path: string; fold: SubagentFileFold }> = [];
  for (const sub of inWindowSubagentFiles(managerTranscriptPath, win)) {
    const fold: SubagentFileFold = {
      firstTs: null,
      lastTs: null,
      tools_called: 0,
      tools_failed: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    };
    // Nested spawns (a subagent spawning helpers) also count as agent rows.
    collectCallsFromFile(sub, win, "subagent", calls, spawns, fold);
    subFolds.push({ path: sub, fold });
  }

  calls.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  // Per-tool aggregates over ALL collected calls (not just the capped list).
  const byName = new Map<string, ToolAggregate>();
  for (const c of calls) {
    let agg = byName.get(c.tool_name);
    if (!agg) {
      agg = { name: c.tool_name, calls: 0, failed: 0, total_duration_ms: 0, max_duration_ms: 0 };
      byName.set(c.tool_name, agg);
    }
    agg.calls += 1;
    if (c.is_error) agg.failed += 1;
    if (c.duration_ms !== null) {
      agg.total_duration_ms += c.duration_ms;
      if (c.duration_ms > agg.max_duration_ms) agg.max_duration_ms = c.duration_ms;
    }
  }
  const tools = [...byName.values()].sort((a, b) => b.total_duration_ms - a.total_duration_ms);

  // Greedy spawn↔file matching by start-time proximity: each spawn takes the
  // unclaimed subagent transcript whose first entry is closest to (and
  // plausibly after) the spawn. Exact for sequential runs; approximate for
  // overlapping parallel spawns of the same shape.
  spawns.sort((a, b) => a.ts - b.ts);
  const claimed = new Set<number>();
  const agents: AgentDetail[] = spawns.map((s) => {
    let bestIdx = -1;
    let bestDelta = Infinity;
    subFolds.forEach(({ fold }, i) => {
      if (claimed.has(i) || fold.firstTs === null) return;
      const delta = Math.abs(fold.firstTs - s.ts);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIdx = i;
      }
    });
    const matched = bestIdx >= 0 && bestDelta <= AGENT_MATCH_SLACK_MS;
    if (matched) claimed.add(bestIdx);
    const fold = matched ? subFolds[bestIdx].fold : null;
    const foldSpan =
      fold && fold.firstTs !== null && fold.lastTs !== null ? fold.lastTs - fold.firstTs : null;
    return {
      agent_type: s.agent_type,
      description: s.description ? excerpt(s.description, 200) : null,
      started_at: s.tsIso || null,
      duration_ms: s.duration_ms ?? foldSpan,
      tools_called: fold?.tools_called ?? 0,
      tools_failed: fold?.tools_failed ?? 0,
      input_tokens: fold?.input_tokens ?? 0,
      output_tokens: fold?.output_tokens ?? 0,
      cache_read_tokens: fold?.cache_read_tokens ?? 0,
      cache_creation_tokens: fold?.cache_creation_tokens ?? 0,
      matched,
    };
  });

  return {
    tools,
    calls: calls.slice(0, BREAKDOWN_CALLS_CAP),
    calls_truncated: calls.length > BREAKDOWN_CALLS_CAP,
    agents,
  };
}

/** Fold every entry of a single transcript file into `acc`, window-gated. */
export function foldTranscriptFile(path: string, acc: TranscriptRunStats, win: Window): void {
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue;
    }
    foldTranscriptEntry(parsed, acc, win);
  }
}

/** Given a manager/parent transcript path, return the sibling subagents
 *  directory CC writes (`<encoded-cwd>/<session-id>/subagents/`). */
export function subagentsDirFor(transcriptPath: string): string {
  return join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents");
}

/** List subagent transcript files whose CREATION time plausibly falls inside
 *  the run window — a cheap birthtime pre-filter so we don't open every file
 *  in a busy session's subagents dir. The per-entry timestamp gate in
 *  foldTranscriptFile is what actually guarantees correctness; this only avoids
 *  reading obviously-out-of-window files. With an open window (null/null) all
 *  files are returned. */
export function inWindowSubagentFiles(transcriptPath: string, win: Window): string[] {
  const dir = subagentsDirFor(transcriptPath);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const p = join(dir, name);
    let createdMs: number;
    try {
      const s = statSync(p);
      createdMs = s.birthtimeMs && s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs;
    } catch {
      continue;
    }
    if (win.start !== null && createdMs < win.start - BIRTHTIME_SLACK_MS) continue;
    // A subagent born after the run's end can't belong to it.
    if (win.end !== null && createdMs > win.end + BIRTHTIME_SLACK_MS) continue;
    out.push(p);
  }
  return out;
}

/**
 * Fold complete per-run stats: the manager/parent transcript + every in-window
 * subagent transcript under it. `windowStartIso`/`windowEndIso` bound the run
 * (pass the run's started_at and, for a finished run, its last_event_at; pass
 * `null` end for a live run). Returns zeroed stats when the transcript is
 * missing (e.g. the daemon wasn't running during the run, so nothing mirrored).
 */
/**
 * Locate the parent-session transcript for a run WITHOUT a mirror binding.
 *
 * The bindings written by `pipeline event register-mirror-binding` carry
 * `transcript_path: null` whenever the caller's environment had no
 * CLAUDE_SESSION_ID (observed in production since ~June 2026), so most
 * chain-controller bindings can't resolve a transcript and /api/run-stats
 * used to return zeros. This fallback scans the project's Claude Code
 * transcripts dir (`~/.claude/projects/<encoded-root>/*.jsonl`):
 *
 *   1. cheap window pre-filter — a file whose mtime predates the run start,
 *      or whose creation postdates the run end, can't be the host session;
 *   2. content check — the surviving candidates (typically 1-3 files) are
 *      searched for the literal run_id (the supervisor prompt and the
 *      `pipeline event`/`register-mirror-binding` commands all embed it).
 *
 * The candidate containing the MOST occurrences wins (the driving session
 * mentions the run id many times; a bystander session that merely displayed
 * it once loses). Returns null when nothing contains the run id — callers
 * must treat that as "no transcript", never guess by window alone.
 */
// Per-(file, run_id) occurrence-count memo. The negative-result path retries
// every 15 s while a live run has no resolved transcript — without this it
// re-reads every in-window multi-MB session file each time even though none
// of them changed. Keyed by path|runId; invalidated by size/mtime drift.
const occurrenceMemo = new Map<string, { size: number; mtimeMs: number; count: number }>();
const OCCURRENCE_MEMO_MAX = 2000;

export function findTranscriptByRunId(
  projectRoot: string,
  runId: string,
  windowStartIso: string | null,
  windowEndIso: string | null,
  homeOverride?: string,
): string | null {
  if (!runId) return null;
  const dir = join(claudeProjectsDir(homeOverride), encodeClaudeProjectDir(projectRoot));
  if (!existsSync(dir)) return null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const start = toEpochOrNull(windowStartIso);
  const end = toEpochOrNull(windowEndIso);
  let best: string | null = null;
  let bestCount = 0;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const birth = st.birthtimeMs && st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    // Window overlap: the session must still have been written to after the
    // run started, and must have existed before the run ended.
    if (start !== null && st.mtimeMs < start - BIRTHTIME_SLACK_MS) continue;
    if (end !== null && birth > end + BIRTHTIME_SLACK_MS) continue;
    const memoKey = `${p}|${runId}`;
    const memo = occurrenceMemo.get(memoKey);
    let count: number;
    if (memo && memo.size === st.size && memo.mtimeMs === st.mtimeMs) {
      count = memo.count;
    } else {
      let text: string;
      try {
        text = readFileSync(p, "utf-8");
      } catch {
        continue;
      }
      count = 0;
      for (let i = text.indexOf(runId); i !== -1; i = text.indexOf(runId, i + runId.length)) count++;
      if (occurrenceMemo.size >= OCCURRENCE_MEMO_MAX) occurrenceMemo.clear();
      occurrenceMemo.set(memoKey, { size: st.size, mtimeMs: st.mtimeMs, count });
    }
    if (count > bestCount) {
      bestCount = count;
      best = p;
    }
  }
  return best;
}

export function foldRunStatsFromTranscript(
  managerTranscriptPath: string | null,
  windowStartIso: string | null,
  windowEndIso: string | null,
): TranscriptRunStats {
  const acc = emptyTranscriptRunStats();
  if (!managerTranscriptPath) return acc;
  const win: Window = { start: toEpochOrNull(windowStartIso), end: toEpochOrNull(windowEndIso) };

  foldTranscriptFile(managerTranscriptPath, acc, win);
  for (const sub of inWindowSubagentFiles(managerTranscriptPath, win)) {
    foldTranscriptFile(sub, acc, win);
  }
  return acc;
}

// --------------------------------------------------------------------
// Mirror-binding index — resolve a run_id → its manager/parent transcript.
// The hooks write one binding per manager/worker spawn into
// ~/.claude/pipeline-ui/active-mirror-bindings.jsonl with {run_id,
// transcript_path, start_ts, kind, project_root}. We want the run's PARENT
// transcript (the one whose subagents dir holds the step-executors): prefer a
// chain-controller / bypass-spawn binding (the manager spawn) over a recursive
// `subagent` binding. The earliest start_ts for the run is its window start
// fallback when no pipeline.started event exists.
// --------------------------------------------------------------------

export interface RunTranscriptRef {
  transcript_path: string;
  start_ts: string;
}

interface BindingLite {
  run_id?: string;
  transcript_path?: string | null;
  start_ts?: string;
  kind?: string;
  project_root?: string;
}

/** Build run_id → parent transcript ref from raw bindings-file text. Keeps the
 *  binding with the EARLIEST start_ts per run (the manager spawn that opened
 *  the run); ignores records without a transcript_path. Optionally filters to a
 *  project_root. */
export function indexRunTranscripts(
  bindingsText: string,
  projectRoot?: string,
): Map<string, RunTranscriptRef> {
  const out = new Map<string, RunTranscriptRef>();
  for (const line of bindingsText.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let rec: BindingLite;
    try {
      rec = JSON.parse(t) as BindingLite;
    } catch {
      continue;
    }
    if (!rec.run_id || !rec.transcript_path) continue;
    // Compare normalized (the bindings file's project_root and the daemon's
    // registered project_root can differ in drive-letter case / separators on
    // Windows) so a real binding is never dropped by a cosmetic path mismatch.
    if (
      projectRoot &&
      rec.project_root &&
      normalizePathForCompare(rec.project_root) !== normalizePathForCompare(projectRoot)
    ) {
      continue;
    }
    const start = typeof rec.start_ts === "string" ? rec.start_ts : "";
    const prev = out.get(rec.run_id);
    if (!prev || (start && start < prev.start_ts)) {
      out.set(rec.run_id, { transcript_path: rec.transcript_path, start_ts: start || prev?.start_ts || "" });
    }
  }
  return out;
}
