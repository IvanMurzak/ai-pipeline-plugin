// Shared backfill reconciliation core — the ONE fold path every trigger
// (SubagentStop/Stop relay, run-init kick, daemon sweep, `pipeline stats
// backfill`) calls through, so every number they produce is bit-identical.
//
// Reconciliation predicate (P2): a run record is a backfill candidate iff
// `tokens === null` — this is the single source of truth for "needs
// enrichment"; nothing here ever rewrites an already-enriched record
// (`rewriteRunTokens` only fills nulls, lib/stats.ts) and nothing here
// fabricates zeros (that is `summarizeRun`'s explicit-zero rule, §12 —
// finalize-time only, untouched by this module).
//
// Source select per record:
//   - `runner === 'headless'` (a `pipeline drive` run) → the pinned per-step
//     session transcripts (`.runtime/<run>/sessions/`, apps/pipeline-cli/src/
//     lib/step-transcripts.ts), envelope `usage.json` preferred over the
//     transcript-folded tokens when it carries any usage/cost — the SAME
//     precedence `pipeline drive`'s own terminal-action enrichment uses
//     (commands/drive.ts `enrichStats`).
//   - everything else (`runner === 'manager'`, or unset/legacy) → locate the
//     manager transcript by run_id (`findTranscriptByRunId`) and fold it +
//     its in-window subagents (`foldRunStatsFromTranscript`,
//     apps/pipeline-ui/transcript-stats.ts) — the exact walk the pre-refactor
//     stats_relay hook used inline.
//
// `transcriptHint` (the relay's known-transcript case) SHORT-CIRCUITS the
// entire source-select step, not just the manager locator: the pre-refactor
// relay never branched on `runner` at all — it folded the SubagentStop
// payload's transcript against every tokens-null record in the window,
// manager or headless alike (a headless record's window essentially never
// overlaps a pipeline-manager transcript, so the fold is a harmless zero for
// it — E2 in 01-current-architecture.md §6). Preserving that exact shape is
// what keeps the refactored relay byte-compatible with the pre-refactor one.
//
// Every record is guarded independently (try/catch) — one malformed/
// unexpected-shape record must never abort the rest of the pass. Nothing in
// this module throws out to the caller; it is polled by best-effort callers
// (a hook, a run-init kick, a CLI verb, a daemon sweep) that must never fail
// their own operation because of a stats hiccup.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  attributeFailureStep,
  findRunsFiles,
  parseRunRecords,
  statsEnrichTokens,
  stepWindows,
  type RunFailureDetail,
  type TokenStats,
} from './stats';
import { readStepSessionRefs, foldStepSessionTranscripts } from './step-transcripts';
import {
  RUN_FAILURES_COLLECT_MAX,
  collectRunToolFailures,
  foldRunStatsFromTranscript,
  findTranscriptByRunId,
} from '../../../pipeline-ui/transcript-stats';

/** D10: default reconciliation window — how far back a record's `ended_at`
 *  may be and still be considered for backfill. The relay keeps its own
 *  narrower 48h window (its trigger fires promptly after the run); this
 *  wider default serves the manual verb / run-init kick / daemon sweep,
 *  which may run long after the fact. */
export const DEFAULT_BACKFILL_WINDOW_MS = 14 * 24 * 3600 * 1000;

export interface BackfillReport {
  /** Records inspected (tokens-null-or-not, in or out of window alike). */
  scanned: number;
  /** run_ids filled this pass. */
  enriched: string[];
  /** tokens !== null already — nothing to do. */
  skipped_enriched: number;
  /** tokens === null but older than windowMs — left alone by design. */
  skipped_window: number;
  /** tokens === null, in window, but no transcript/session evidence found at
   *  all — left null (D10: no snapshotting; revisit on evidence). */
  transcript_pruned: string[];
  /** tokens === null, in window, evidence found, but the fold summed to zero
   *  — left null (never fabricate a zero; a later pass may catch the real
   *  window once the right session is on disk). */
  zero_fold: string[];
  /** Per-record guard trips — the record that failed is skipped; every other
   *  record in the pass still proceeds. */
  errors: string[];
}

export interface BackfillOptions {
  /** Default 14 days (D10). The relay keeps its own 48h. */
  windowMs?: number;
  /** Soft time budget (ms) for best-effort callers (the run-init kick uses
   *  ~1500ms) — checked between records; once exceeded, the pass stops
   *  scanning further records (already-processed records' results stand). */
  budgetMs?: number;
  /** Test seam: threaded to the transcript locator/folds so tests can point
   *  at a fake `~/.claude/projects` home instead of the real one. */
  homeOverride?: string;
  /** The relay's known-transcript case: short-circuits the whole source-select
   *  step (see module header) — every tokens-null record in window is folded
   *  against THIS transcript, regardless of `runner`, exactly like the
   *  pre-refactor stats_relay hook. Only used when the referenced file
   *  actually exists; when it does not, no record can be sourced from it
   *  (records still report through the normal runner-based buckets). */
  transcriptHint?: string;
}

function newTokensFromFold(folded: {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  tools_called: number;
  tools_failed: number;
  agents_spawned: number;
}): TokenStats {
  return {
    input: folded.input_tokens,
    output: folded.output_tokens,
    cache_read: folded.cache_read_tokens,
    cache_creation: folded.cache_creation_tokens,
    tools_called: folded.tools_called,
    tools_failed: folded.tools_failed,
    agents_spawned: folded.agents_spawned,
  };
}

/** Manager-style fold: locate (or use a supplied) transcript, fold it + its
 *  in-window subagents, collect step-attributed failure detail when the fold
 *  saw a failure. Returns null tokens when the fold summed to zero (caller
 *  buckets that as zero_fold) or when no transcript could be sourced at all
 *  (caller buckets that as transcript_pruned via the `found` flag). */
function foldManagerStyle(
  transcript: string,
  rec: { run_id: string; started_at: string | null; ended_at: string; steps: unknown },
): { tokens: TokenStats; failures?: RunFailureDetail[] } | null {
  const folded = foldRunStatsFromTranscript(transcript, rec.started_at, rec.ended_at);
  const sum = folded.input_tokens + folded.output_tokens + folded.cache_read_tokens + folded.cache_creation_tokens;
  if (sum === 0) return null;
  const tokens = newTokensFromFold(folded);
  let failures: RunFailureDetail[] | undefined;
  if (folded.tools_failed > 0) {
    const windows = stepWindows(Array.isArray(rec.steps) ? (rec.steps as Parameters<typeof stepWindows>[0]) : []);
    const { failures: raw } = collectRunToolFailures(transcript, rec.started_at, rec.ended_at, RUN_FAILURES_COLLECT_MAX);
    failures = raw.map((f) => ({
      ts: f.ts,
      tool: f.tool_name,
      step: attributeFailureStep(windows, f.ts),
      error: f.error_excerpt,
    }));
  }
  return { tokens, failures };
}

interface UsageJson {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  cost_usd: number;
}

/** Read a drive run's persisted envelope-usage accumulator. Never throws;
 *  missing/corrupt → all zeros (indistinguishable from "no envelope usage"). */
function readUsageJson(usageFile: string): UsageJson {
  const out: UsageJson = { input: 0, output: 0, cache_read: 0, cache_creation: 0, cost_usd: 0 };
  try {
    const raw = JSON.parse(readFileSync(usageFile, 'utf8')) as Record<string, unknown>;
    for (const k of ['input', 'output', 'cache_read', 'cache_creation', 'cost_usd'] as const) {
      if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) out[k] = raw[k] as number;
    }
  } catch {
    // no prior usage.json — fine, all zeros
  }
  return out;
}

/** Headless-style fold: pinned per-step session transcripts, envelope
 *  `usage.json` preferred over the transcript-folded totals when it carries
 *  any usage/cost — same precedence as `pipeline drive`'s own terminal-action
 *  enrichment (commands/drive.ts `enrichStats`). Returns null when nothing
 *  was found at all (caller buckets as transcript_pruned) or the resulting
 *  totals summed to zero (caller buckets as zero_fold). */
function foldHeadlessStyle(
  runtimeDir: string,
  homeOverride: string | undefined,
): { tokens: TokenStats; failures?: RunFailureDetail[]; found: boolean } {
  const refs = readStepSessionRefs(join(runtimeDir, 'sessions'));
  const fold = foldStepSessionTranscripts(refs, homeOverride);
  const usage = readUsageJson(join(runtimeDir, 'usage.json'));
  const usageExists = existsSync(join(runtimeDir, 'usage.json'));
  const found = fold.found_any || usageExists;
  const hasEnvelopeUsage = usage.input + usage.output + usage.cache_read + usage.cache_creation > 0 || usage.cost_usd > 0;
  const tokens: TokenStats = hasEnvelopeUsage
    ? { input: usage.input, output: usage.output, cache_read: usage.cache_read, cache_creation: usage.cache_creation, cost_usd: usage.cost_usd }
    : { input: fold.input_tokens, output: fold.output_tokens, cache_read: fold.cache_read_tokens, cache_creation: fold.cache_creation_tokens };
  if (fold.found_any) {
    tokens.tools_called = fold.tools_called;
    tokens.tools_failed = fold.tools_failed;
    tokens.agents_spawned = fold.agents_spawned;
  }
  return { tokens, failures: fold.failures.length ? fold.failures : undefined, found };
}

/** Reconcile every `tokens === null` run record under `<projectRoot>/.claude/
 *  pipeline/.stats/` that falls in window, per the source-select rules above.
 *  Writes enrichment via `statsEnrichTokens` (regenerates SUMMARY.md).
 *  Idempotent: a record already enriched (by this pass or an earlier one) is
 *  a no-op (`skipped_enriched`) — re-running over an already-reconciled tree
 *  performs zero writes. Never throws. */
export function backfillProject(projectRoot: string, opts: BackfillOptions = {}): BackfillReport {
  const report: BackfillReport = {
    scanned: 0,
    enriched: [],
    skipped_enriched: 0,
    skipped_window: 0,
    transcript_pruned: [],
    zero_fold: [],
    errors: [],
  };
  const root = resolve(projectRoot);
  const base = join(root, '.claude', 'pipeline', '.stats');
  if (!existsSync(base)) return report;

  const windowMs = opts.windowMs ?? DEFAULT_BACKFILL_WINDOW_MS;
  const now = Date.now();
  const budgetStart = Date.now();
  const hintUsable = opts.transcriptHint !== undefined && existsSync(opts.transcriptHint);

  outer: for (const runsFile of findRunsFiles(base)) {
    let text: string;
    try {
      text = readFileSync(runsFile, 'utf8');
    } catch {
      continue;
    }
    for (const rec of parseRunRecords(text)) {
      if (opts.budgetMs !== undefined && Date.now() - budgetStart > opts.budgetMs) break outer;
      report.scanned++;
      // Per-record guard: one record with an unexpected shape must not abort
      // enrichment for every remaining record and file.
      try {
        if (rec.tokens !== null) {
          report.skipped_enriched++;
          continue;
        }
        const endedMs = Date.parse(rec.ended_at);
        if (!Number.isFinite(endedMs) || now - endedMs > windowMs) {
          report.skipped_window++;
          continue;
        }

        let result: { tokens: TokenStats; failures?: RunFailureDetail[] } | null = null;
        let found = true;

        if (opts.transcriptHint !== undefined) {
          // Relay short-circuit — ignore `runner`, fold uniformly against the
          // hint transcript (byte-compat with the pre-refactor relay).
          found = hintUsable;
          if (hintUsable) result = foldManagerStyle(opts.transcriptHint as string, rec);
        } else if (rec.runner === 'headless') {
          const pipelineRoot = join(root, '.claude', 'pipeline', rec.pipeline);
          const runtimeDir = join(pipelineRoot, '.runtime', rec.run_id);
          const headless = foldHeadlessStyle(runtimeDir, opts.homeOverride);
          found = headless.found;
          if (headless.found) {
            const sum = headless.tokens.input + headless.tokens.output + headless.tokens.cache_read + headless.tokens.cache_creation;
            result = sum === 0 && !headless.tokens.cost_usd ? null : { tokens: headless.tokens, failures: headless.failures };
          }
        } else {
          // 'manager' or unset/legacy — same default as statsFinalizeRun.
          const transcript = findTranscriptByRunId(root, rec.run_id, rec.started_at, rec.ended_at, opts.homeOverride);
          found = transcript !== null;
          if (transcript !== null) result = foldManagerStyle(transcript, rec);
        }

        if (!found) {
          report.transcript_pruned.push(rec.run_id);
          continue;
        }
        if (result === null) {
          report.zero_fold.push(rec.run_id);
          continue;
        }
        const ok = statsEnrichTokens(base, runsFile, rec.run_id, result.tokens, result.failures);
        if (ok) report.enriched.push(rec.run_id);
      } catch (e) {
        report.errors.push(`${rec.run_id ?? 'unknown'}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return report;
}
