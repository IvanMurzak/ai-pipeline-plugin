#!/usr/bin/env bun
/**
 * Pipeline plugin — stats relay (Stop; SubagentStop, matcher: pipeline-manager).
 *
 * Token enrichment for the per-run measurement system (pure software, zero
 * LLM tokens). Phase 1 happens in-process inside `pipeline next`: duration,
 * per-step timings, and outcomes are finalized into
 * `<project>/.claude/pipeline/.stats/<pipeline>/runs.jsonl` the moment a run
 * ends — but the CLI subprocess cannot see transcripts, so `tokens` is null.
 * This hook is phase 2: it fires when a pipeline-manager subagent stops (or
 * on a plain session Stop — same script, registered under both), folds the
 * manager + subagent transcripts through the SAME window-gated fold the
 * dashboard uses (apps/pipeline-ui/transcript-stats.ts — validated as the
 * only complete token source), and rewrites the matching runs.jsonl entries
 * in place — tokens, tool counts, AND tool failures (per-tool counts in the
 * record, per-failure detail lines in the run's .log) so /pipeline:optimize
 * can flag failing pipelines without re-reading transcripts.
 *
 * Thin wrapper: the actual reconciliation walk (find every tokens-null
 * record in window, source its transcript, fold, write) lives in the shared
 * core `apps/pipeline-cli/src/lib/stats-backfill.ts#backfillProject` — the
 * SAME core every other trigger (this hook, the run-init kick, the daemon
 * sweep, `pipeline stats backfill`) calls through, so every trigger produces
 * bit-identical numbers. This hook's only job: gate, resolve the project
 * root, and pass its own transcript as the known-transcript short-circuit
 * (`transcriptHint`) with its narrower 48h window.
 *
 * Gating: PIPELINE_STATS_ENABLED (default ON — set 0/false/off/no to disable;
 * NOTE this is deliberately independent of PIPELINE_UI_ENABLED — stats keep
 * their own gate even when the UI/analytics system is opted out). Also a no-op
 * when the cwd has no `.claude/pipeline/.stats/`.
 *
 * Attribution: each tokens-null run recorded in the last 48h is folded with
 * ITS OWN [started_at, ended_at] window over this session's transcript — the
 * per-entry timestamp gate attributes entries correctly even when a session
 * hosts several runs. A fold that lands zero tokens leaves the record null
 * (a later stop in the right session will fill it).
 *
 * Failure posture: silent no-op. This hook must never fail a session stop.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { statsEnabled } from '../apps/pipeline-cli/src/lib/stats';
import { backfillProject } from '../apps/pipeline-cli/src/lib/stats-backfill';

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

  backfillProject(projectRoot, { windowMs: ENRICH_WINDOW_MS, transcriptHint: transcript });
}

try {
  main();
} catch {
  // never fail the stop
}
process.exit(0);
