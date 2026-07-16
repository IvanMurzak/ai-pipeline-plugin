#!/usr/bin/env bun
/**
 * Pipeline plugin — stats relay (SubagentStop, matcher: pipeline-manager).
 *
 * Token enrichment for the per-run measurement system (pure software, zero
 * LLM tokens). Phase 1 happens in-process inside `pipeline next`: duration,
 * per-step timings, and outcomes are finalized into
 * `<project>/.claude/pipeline/.stats/<pipeline>/runs.jsonl` the moment a run
 * ends — but the CLI subprocess cannot see transcripts, so `tokens` is null.
 * This hook is phase 2: it fires when a pipeline-manager subagent stops (the
 * moment the run's transcripts are complete), folds the manager + subagent
 * transcripts through the SAME window-gated fold the dashboard uses
 * (apps/pipeline-ui/transcript-stats.ts — validated as the only complete
 * token source), and rewrites the matching runs.jsonl entries in place —
 * tokens, tool counts, AND tool failures (per-tool counts in the record,
 * per-failure detail lines in the run's .log) so /pipeline:optimize can flag
 * failing pipelines without re-reading transcripts.
 *
 * Gating: PIPELINE_STATS_ENABLED (default ON — set 0/false/off/no to disable;
 * NOTE this is deliberately independent of PIPELINE_UI_ENABLED, which is off
 * by default). Also a no-op when the cwd has no `.claude/pipeline/.stats/`.
 *
 * Attribution: each tokens-null run recorded in the last 48h is folded with
 * ITS OWN [started_at, ended_at] window over this session's transcript — the
 * per-entry timestamp gate attributes entries correctly even when a session
 * hosts several runs. A fold that lands zero tokens leaves the record null
 * (a later manager stop in the right session will fill it).
 *
 * Failure posture: silent no-op. This hook must never fail a session stop.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  attributeFailureStep,
  findRunsFiles,
  parseRunRecords,
  statsEnabled,
  statsEnrichTokens,
  stepWindows,
  type RunFailureDetail,
  type TokenStats,
} from '../apps/pipeline-cli/src/lib/stats';
import {
  RUN_FAILURES_COLLECT_MAX,
  collectRunToolFailures,
  foldRunStatsFromTranscript,
} from '../apps/pipeline-ui/transcript-stats';

const ENRICH_WINDOW_MS = 48 * 3600 * 1000;

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Walk up from `start` to the first dir containing `.claude/pipeline`. */
function findProjectRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, '.claude', 'pipeline'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function main(): void {
  if (!statsEnabled()) return;
  let payload: HookPayload;
  try {
    payload = JSON.parse(readStdin()) as HookPayload;
  } catch {
    return;
  }
  const transcript = payload.transcript_path;
  if (!transcript || !existsSync(transcript)) return;
  const projectRoot = findProjectRoot(payload.cwd || process.cwd());
  if (!projectRoot) return;
  const base = join(projectRoot, '.claude', 'pipeline', '.stats');
  if (!existsSync(base)) return;

  const now = Date.now();
  for (const runsFile of findRunsFiles(base)) {
    let text: string;
    try {
      text = readFileSync(runsFile, 'utf8');
    } catch {
      continue;
    }
    for (const rec of parseRunRecords(text)) {
      // Per-record guard: one malformed line (valid JSON, wrong shape) must
      // not abort enrichment for every remaining run and file.
      try {
        if (rec.tokens !== null) continue;
        const endedMs = Date.parse(rec.ended_at);
        if (!Number.isFinite(endedMs) || now - endedMs > ENRICH_WINDOW_MS) continue;
        const folded = foldRunStatsFromTranscript(transcript, rec.started_at, rec.ended_at);
        const tokens: TokenStats = {
          input: folded.input_tokens,
          output: folded.output_tokens,
          cache_read: folded.cache_read_tokens,
          cache_creation: folded.cache_creation_tokens,
          tools_called: folded.tools_called,
          tools_failed: folded.tools_failed,
          agents_spawned: folded.agents_spawned,
        };
        // Zero tokens ⇒ this session's transcript doesn't cover that run's
        // window — leave it null for the run's own manager-stop to fill.
        if (tokens.input + tokens.output + tokens.cache_read + tokens.cache_creation === 0) continue;
        // Failure detail (same walk as the FAIL tile): per-failure lines for
        // the .log, step-attributed by timestamp against windows built ONCE
        // per record (null when no window, or windows of different steps,
        // contain it). failed_tools counts derive inside statsEnrichTokens.
        let failures: RunFailureDetail[] | undefined;
        if (folded.tools_failed > 0) {
          const windows = stepWindows(Array.isArray(rec.steps) ? rec.steps : []);
          const { failures: raw } = collectRunToolFailures(
            transcript,
            rec.started_at,
            rec.ended_at,
            RUN_FAILURES_COLLECT_MAX,
          );
          failures = raw.map((f) => ({
            ts: f.ts,
            tool: f.tool_name,
            step: attributeFailureStep(windows, f.ts),
            error: f.error_excerpt,
          }));
        }
        statsEnrichTokens(base, runsFile, rec.run_id, tokens, failures);
      } catch {
        // skip this record — the rest still enrich
      }
    }
  }
}

try {
  main();
} catch {
  // never fail the stop
}
process.exit(0);
