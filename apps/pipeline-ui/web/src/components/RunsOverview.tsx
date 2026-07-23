import { useMemo } from "react";
import { motion } from "framer-motion";
import { LayoutGrid, OctagonX, Rocket } from "lucide-react";
import { AwaitingInput } from "./AwaitingInput";
import { StatusBadge } from "./StatusBadge";
import { elapsed as fmtElapsed, iterationLabel } from "../lib/format";
import { activeRuns } from "../lib/runs";
import type { DriveRunSnapshot, RunState } from "../types";

interface Props {
  projectId: string;
  runs: RunState[];
  driveRunsById: Map<string, DriveRunSnapshot>;
  onSelect: (runId: string) => void;
  /** Stop/cancel this run (kills a drive child; halts stale runs too). */
  onStop?: (runId: string) => void;
  onLaunchClick: () => void;
  onAnswered: () => void;
}

/** The overview board — EVERY active run at once, questions answerable in
 *  place. Shown in the middle pane when nothing specific is selected, so
 *  watching several concurrent pipelines needs no switching at all. */
export function RunsOverview({ projectId, runs, driveRunsById, onSelect, onStop, onLaunchClick, onAnswered }: Props) {
  const awaiting = (id: string) => driveRunsById.get(id)?.status === "awaiting-input";
  // Memoized: recomputes per SSE event otherwise. Parked runs float first.
  const active = useMemo(
    () =>
      activeRuns(runs, driveRunsById).sort(
        (a, b) => Number(awaiting(b.run_id)) - Number(awaiting(a.run_id)) || (a.last_event_at < b.last_event_at ? 1 : -1),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runs, driveRunsById],
  );

  if (!active.length) {
    return (
      <div className="surface flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <LayoutGrid size={22} className="text-muted" />
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">No active runs</p>
        <button
          type="button"
          onClick={onLaunchClick}
          className="flex items-center gap-2 border-2 border-accent bg-accent/15 px-4 py-2 font-display text-xs font-bold uppercase tracking-[0.18em] text-accent hover:bg-accent/25"
        >
          <Rocket size={13} /> Launch one
        </button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto pr-0.5">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-accent">
        ▌ ACTIVE_RUNS · {active.length}
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {active.map((r) => {
          const drive = driveRunsById.get(r.run_id);
          const parked = drive?.status === "awaiting-input";
          return (
            <motion.div
              key={r.run_id}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className={`surface flex flex-col gap-2 p-3 ${parked ? "border-2 border-warn/60" : ""}`}
            >
              {/* The header row lives OUTSIDE the select button so Stop can be
                  a real <button> (nested buttons are invalid HTML) — same
                  sibling-button approach as RunCard. */}
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => onSelect(r.run_id)}
                  className="min-w-0 flex-1 truncate text-left font-mono text-xs font-bold text-ink"
                >
                  {r.pipeline_name ?? r.run_id.slice(0, 10)}
                </button>
                <span className="flex shrink-0 items-center gap-1.5">
                  <StatusBadge status={parked ? "polling-blocker" : r.status} awaiting={!parked && r.awaiting_input} />
                  {onStop && (
                    <button
                      type="button"
                      onClick={() => onStop(r.run_id)}
                      className="grid h-6 w-6 place-items-center border border-bad/50 text-bad transition-colors hover:bg-bad/15"
                      title="Stop — cancel this run"
                      aria-label="Stop run"
                    >
                      <OctagonX size={11} />
                    </button>
                  )}
                </span>
              </div>
              <button type="button" onClick={() => onSelect(r.run_id)} className="text-left">
                <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-[10px] text-muted">
                  <span className="min-w-0 truncate">
                    {r.current_iteration_path ? iterationLabel(r.current_iteration_path) : "—"}
                  </span>
                  <span className="shrink-0 tabular-nums">{fmtElapsed(r.started_at, null)}</span>
                </div>
                <div className="mt-1.5 h-1 w-full bg-panel2">
                  <div
                    className={`h-1 ${parked ? "bg-warn" : "bg-accent"} transition-all`}
                    style={{
                      width: `${Math.min(
                        100,
                        Math.round(
                          (r.iteration_count_completed /
                            Math.max(r.iteration_count_completed + 1, r.current_iteration_index ?? 1)) *
                            100,
                        ),
                      )}%`,
                    }}
                  />
                </div>
                <div className="mt-1 font-mono text-[9px] uppercase tracking-wider text-muted/70">
                  {r.iteration_count_completed} done
                  {r.stats.tools_called > 0 ? ` · ${r.stats.tools_called} tools` : ""}
                  {r.worktree ? ` · ${r.worktree}` : ""}
                </div>
              </button>
              {parked && drive && (
                <AwaitingInput projectId={projectId} run={drive} onAnswered={onAnswered} />
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
