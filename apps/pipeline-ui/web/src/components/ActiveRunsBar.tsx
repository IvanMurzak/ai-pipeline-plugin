import { useMemo } from "react";
import { CircleHelp } from "lucide-react";
import { activeRuns } from "../lib/runs";
import type { DriveRunSnapshot, RunState } from "../types";

interface Props {
  runs: RunState[];
  selectedRunId: string | null;
  driveRunsById: Map<string, DriveRunSnapshot>;
  onSelect: (runId: string) => void;
  /** Deselect everything — jump to the overview board. */
  onOverview: () => void;
}

const STATUS_DOT: Record<string, string> = {
  running: "bg-accent animate-pulseDot",
  improving: "bg-accent2 animate-pulseDot",
  scripting: "bg-accent2 animate-pulseDot",
  "polling-blocker": "bg-warn animate-pulseDot",
};

/** One-line strip of every ACTIVE run — the fast switcher for watching
 *  several concurrent pipelines. Horizontal scroll on phones; a needs-answer
 *  run gets a loud "?" chip. Hidden when nothing is active. */
export function ActiveRunsBar({ runs, selectedRunId, driveRunsById, onSelect, onOverview }: Props) {
  const awaiting = (id: string) => driveRunsById.get(id)?.status === "awaiting-input";
  // Memoized: this bar is always mounted and App re-renders per SSE event.
  const active = useMemo(() => activeRuns(runs, driveRunsById), [runs, driveRunsById]);
  if (!active.length) return null;
  return (
    <div className="flex items-center gap-2 overflow-x-auto px-3 pb-1 pt-2 sm:px-4 lg:px-6" role="tablist" aria-label="Active runs">
      <button
        type="button"
        onClick={onOverview}
        title="Overview — all active runs at once"
        className={`flex min-h-[32px] shrink-0 items-center gap-1 border px-2 py-1 font-mono text-[10px] transition-colors ${
          selectedRunId === null ? "border-accent bg-accent/15 text-accent" : "border-accent/25 text-muted hover:text-ink"
        }`}
      >
        ALL_{active.length}
      </button>
      {active.map((r) => {
        const needsAnswer = awaiting(r.run_id);
        const selected = r.run_id === selectedRunId;
        return (
          <button
            key={r.run_id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(r.run_id)}
            className={`flex min-h-[32px] shrink-0 items-center gap-1.5 border px-2.5 py-1 font-mono text-[10px] transition-colors ${
              selected
                ? "border-accent bg-accent/15 text-accent"
                : needsAnswer
                ? "border-warn/60 text-warn"
                : "border-accent/25 text-muted hover:text-ink"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${needsAnswer ? "bg-warn animate-pulseDot" : STATUS_DOT[r.status] ?? "bg-muted"}`}
              aria-hidden
            />
            <span className="max-w-[140px] truncate sm:max-w-[200px]">
              {r.pipeline_name ?? r.run_id.slice(0, 8)}
            </span>
            {needsAnswer && <CircleHelp size={11} className="text-warn" />}
          </button>
        );
      })}
    </div>
  );
}
