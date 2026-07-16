import { motion } from "framer-motion";
import { ExternalLink, GitBranch, OctagonX, RotateCw, Timer } from "lucide-react";
import type { PipelineInfo, RunState } from "../types";
import { elapsed, iterationLabel } from "../lib/format";
import { StatusBadge } from "./StatusBadge";
import { HudCorners } from "./HudFrame";

interface Props {
  run: RunState;
  pipelines: PipelineInfo[];
  selected: boolean;
  /** When true, a small Resume button is shown — the run was driven by /api/chat
   *  and the daemon still has the SDK session_id, so it can be resumed. */
  resumable?: boolean;
  /** When set, a Stop control cancels the run — kills a daemon-launched drive
   *  child if there is one, and halts a stale/dead run either way. */
  onStop?: () => void;
  onSelect: () => void;
  onResume?: () => void;
}

export function RunCard({ run, pipelines, selected, resumable, onStop, onSelect, onResume }: Props) {
  const pipeline = run.pipeline_name
    ? pipelines.find((p) => p.pipeline_name === run.pipeline_name)
    : null;
  const total = pipeline?.iterations.length ?? 0;
  const completed = run.iteration_count_completed;
  const pct = total > 0 ? Math.min(100, (completed / total) * 100) : run.status === "completed" ? 100 : 8;

  return (
    <motion.button
      layout
      whileHover={{ scale: 1.005 }}
      whileTap={{ scale: 0.995 }}
      onClick={onSelect}
      className={`
        group relative block w-full overflow-hidden border text-left font-mono
        transition-colors
        ${selected
          ? "border-accent border-l-[3px] bg-panel/85 text-accent"
          : "border-accent/40 bg-panel/60 text-muted hover:border-accent/80 hover:bg-panel/80"}
      `}
    >
      {selected && <HudCorners />}
      <div className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold uppercase tracking-[0.12em] text-ink">
            {run.pipeline_name ?? "(unknown pipeline)"}
          </p>
          <p className="mt-0.5 truncate text-[10.5px] text-muted">
            <span className="text-accent">›</span>{" "}
            {iterationLabel(run.current_iteration_path)}{" "}
            {run.current_iteration_index ? `· #${run.current_iteration_index}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10.5px] text-muted">
            <span className="flex items-center gap-1">
              <Timer size={11} /> {elapsed(run.started_at, run.status === "completed" || run.status === "halted" ? run.last_event_at : null)}
            </span>
            {run.worktree && (
              <span className="flex items-center gap-1 text-accent2">
                <GitBranch size={11} /> worktree
              </span>
            )}
            {run.blocker_issue_url && (
              <a
                href={run.blocker_issue_url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-1 text-warn hover:underline"
              >
                <ExternalLink size={11} /> blocker
              </a>
            )}
            {resumable && onResume && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onResume();
                }}
                className="flex items-center gap-1 border border-accent/50 bg-accent/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent transition-colors hover:bg-accent/25"
                title="Resume this chat session"
              >
                <RotateCw size={10} /> Resume
              </button>
            )}
            {onStop && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onStop();
                }}
                className="flex items-center gap-1 border border-bad/50 bg-bad/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-bad transition-colors hover:bg-bad/25"
                title="Stop — cancel this run (kills a UI-launched runner; a dead run is just cleared)"
              >
                <OctagonX size={10} /> Stop
              </button>
            )}
          </div>
        </div>
        <StatusBadge status={run.status} />
      </div>

      <div className="px-4 pb-3">
        <div className="relative h-1 overflow-hidden border border-accent/20 bg-canvas/40">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
            className={`absolute inset-y-0 left-0 bg-gradient-to-r ${
              run.status === "halted"
                ? "from-bad to-warn"
                : run.status === "completed"
                ? "from-good to-accent2"
                : "from-accent to-accent2"
            }`}
          />
        </div>
        <p className="mt-1 text-[9.5px] uppercase tracking-[0.2em] text-muted">
          {String(completed).padStart(2, "0")} / {(total || "??").toString().padStart(2, "0")} iter
        </p>
      </div>

      {run.children.length > 0 && (
        <div className="border-t frame-divider bg-panel2/50 p-3">
          <p className="mb-2 text-[9.5px] uppercase tracking-[0.2em] text-muted">
            ├ Blocker children
          </p>
          <ul className="space-y-1.5">
            {run.children.map((c) => (
              <li
                key={c.run_id}
                className="flex items-center justify-between gap-2 border border-line/40 bg-canvas/40 px-2 py-1.5 text-[11px]"
              >
                <span className="truncate text-ink">{c.pipeline_name ?? c.run_id.slice(0, 8)}</span>
                <StatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </motion.button>
  );
}
