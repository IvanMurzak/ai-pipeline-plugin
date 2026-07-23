/**
 * Run-level transcript folds for a LIST of runs (the overview board), and the
 * per-step slices for one run (the iteration tree / step detail).
 *
 * Both share `useRunStats`'s zero-coercion rule: an all-zeros fold means "no
 * transcript is bound" (the daemon was off during the run, or the binding is
 * not indexed yet) — NOT "this run did no work". Those entries are dropped so
 * the consumer falls back to the event-folded numbers, marked provisional,
 * instead of regressing a populated row to zeros.
 */

import { useCallback } from "react";
import { fetchRunStatsBatch, fetchRunStepStats } from "../lib/api";
import { usePolledFetch } from "./usePolledFetch";
import type { RunStats, RunStepStats } from "../types";

/** Shared with useRunStats: a run with real activity always has SOMETHING. */
export function hasStatsData(s: RunStats): boolean {
  return (
    s.tools_called > 0 ||
    s.agents_spawned > 0 ||
    s.input_tokens > 0 ||
    s.output_tokens > 0 ||
    s.cache_read_tokens > 0 ||
    s.cache_creation_tokens > 0
  );
}

/** run_id → fold, containing ONLY runs whose fold carries data. */
export function useRunStatsBatch(
  projectId: string | null,
  runIds: string[],
  live: boolean,
): Record<string, RunStats> {
  // Sorted + joined so the key is stable across re-orderings of the same set —
  // otherwise every list re-sort would blank and refetch.
  const key = projectId && runIds.length > 0 ? `${projectId}|${[...runIds].sort().join(",")}` : null;
  const fetcher = useCallback(async () => {
    const raw = await fetchRunStatsBatch(projectId!, runIds);
    const out: Record<string, RunStats> = {};
    for (const [id, stats] of Object.entries(raw)) {
      if (hasStatsData(stats)) out[id] = stats;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return usePolledFetch(key ? fetcher : null, key, live) ?? {};
}

/** rel (or step_id) → per-step fold, ONLY for steps whose fold carries data. */
export function useRunStepStats(
  projectId: string | null,
  runId: string | null,
  live: boolean,
): Record<string, RunStats> {
  const ready = !!projectId && !!runId;
  const fetcher = useCallback(async () => {
    const res = await fetchRunStepStats(projectId!, runId!);
    const out: Record<string, RunStats> = {};
    for (const step of res.steps as RunStepStats[]) {
      if (!hasStatsData(step.stats)) continue;
      // Keyed by `rel` — the iteration tree's own key. `step_id` is carried as
      // a second key so a DAG surface can look up either way.
      if (step.rel) out[step.rel] = step.stats;
      if (step.step_id) out[step.step_id] = step.stats;
    }
    return out;
  }, [projectId, runId]);
  return usePolledFetch(ready ? fetcher : null, ready ? `${projectId}|${runId}` : null, live) ?? {};
}
