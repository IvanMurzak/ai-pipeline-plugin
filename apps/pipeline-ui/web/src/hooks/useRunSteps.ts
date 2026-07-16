/**
 * Per-step wall-clock timings for the selected run, from /api/run-steps
 * (server-side fold over the FULL journal — works for runs whose events
 * scrolled out of the live window).
 */

import { useCallback } from "react";
import { fetchRunSteps } from "../lib/api";
import { usePolledFetch } from "./usePolledFetch";
import type { RunStepsResponse } from "../types";

export function useRunSteps(
  projectId: string | null,
  runId: string | null,
  live: boolean,
): RunStepsResponse | null {
  const ready = !!projectId && !!runId;
  const fetcher = useCallback(() => fetchRunSteps(projectId!, runId!), [projectId, runId]);
  return usePolledFetch(ready ? fetcher : null, ready ? `${projectId}|${runId}` : null, live);
}
