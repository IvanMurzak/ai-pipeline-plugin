import { useEffect, useMemo, useState } from "react";
import { fetchDriveRuns } from "../lib/api";
import { useSSE } from "../lib/sse";
import type { DriveRunSnapshot } from "../types";

/** Daemon-launched headless runs for the selected project: initial fetch +
 *  live drive.run SSE updates. Keyed by run_id; the same ids appear in the
 *  journal-event fold, so callers can overlay awaiting-input/question state
 *  onto RunState rows. */
export function useDriveRuns(projectId: string | null): {
  driveRuns: DriveRunSnapshot[];
  driveRunsById: Map<string, DriveRunSnapshot>;
  refresh: () => void;
} {
  const [runs, setRuns] = useState<DriveRunSnapshot[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!projectId) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    fetchDriveRuns(projectId)
      .then((r) => {
        if (!cancelled) setRuns(r);
      })
      .catch(() => {
        if (!cancelled) setRuns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, tick]);

  useSSE((msg) => {
    if (msg.type !== "drive.run") return;
    const snap = msg.data as DriveRunSnapshot;
    if (!snap || snap.project_id !== projectId) return;
    setRuns((prev) => {
      const i = prev.findIndex((r) => r.run_id === snap.run_id);
      if (i < 0) return [snap, ...prev];
      const next = prev.slice();
      next[i] = snap;
      return next;
    });
  });

  const driveRunsById = useMemo(() => new Map(runs.map((r) => [r.run_id, r])), [runs]);
  return { driveRuns: runs, driveRunsById, refresh: () => setTick((t) => t + 1) };
}
