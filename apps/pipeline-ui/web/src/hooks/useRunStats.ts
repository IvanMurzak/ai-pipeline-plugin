/**
 * Per-run analytics, fetched from the daemon's /api/run-stats (which folds the
 * raw manager+subagent transcripts — the only complete source). Replaces the
 * client's event-folded RunState.stats in the RUN_ANALYTICS panel, which
 * undercounts badly because the tool.called/turn.usage hook events leak run-id
 * correlation and never see subagent tokens.
 */

import { useCallback } from "react";
import { fetchRunStats } from "../lib/api";
import { usePolledFetch } from "./usePolledFetch";
import type { RunStats } from "../types";

/** A run with real activity always has tokens. An all-zeros response means no
 *  transcript is bound (daemon was off during the run, or the binding isn't
 *  indexed yet) — treat it as "no override" so StatsPanel falls back to the
 *  event-folded numbers instead of regressing the panel to zeros. */
function hasData(s: RunStats): boolean {
  return (
    s.tools_called > 0 ||
    s.agents_spawned > 0 ||
    s.input_tokens > 0 ||
    s.output_tokens > 0 ||
    s.cache_read_tokens > 0 ||
    s.cache_creation_tokens > 0
  );
}

export function useRunStats(
  projectId: string | null,
  runId: string | null,
  live: boolean,
): RunStats | null {
  const ready = !!projectId && !!runId;
  const fetcher = useCallback(async () => {
    const s = await fetchRunStats(projectId!, runId!);
    return hasData(s) ? s : null;
  }, [projectId, runId]);
  return usePolledFetch(ready ? fetcher : null, ready ? `${projectId}|${runId}` : null, live);
}
