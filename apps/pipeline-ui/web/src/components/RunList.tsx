import { AnimatePresence, motion } from "framer-motion";
import type { PipelineInfo, RunState } from "../types";
import { RunCard } from "./RunCard";
import { isActive } from "../lib/runs";

interface Props {
  runs: RunState[];
  pipelines: PipelineInfo[];
  selectedRunId: string | null;
  /** Set of run_ids that have a chat-session record on disk and can be resumed. */
  resumableRunIds?: Set<string>;
  onSelect: (runId: string) => void;
  onResume?: (runId: string) => void;
  /** Stop/cancel an active run (kills a drive child; halts stale runs too). */
  onStop?: (runId: string) => void;
}

export function RunList({
  runs,
  pipelines,
  selectedRunId,
  resumableRunIds,
  onSelect,
  onResume,
  onStop,
}: Props) {
  const active = runs.filter((r) => isActive(r.status));
  const finished = runs.filter((r) => !isActive(r.status));

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
      <Section title="Active" count={active.length}>
        <AnimatePresence initial={false}>
          {active.length === 0 && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="border border-dashed border-accent/30 bg-panel/30 px-4 py-6 text-center font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted"
            >
              // no_active_runs
            </motion.p>
          )}
          {active.map((r) => (
            <motion.div
              key={r.run_id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.25 }}
            >
              <RunCard
                run={r}
                pipelines={pipelines}
                selected={r.run_id === selectedRunId}
                resumable={resumableRunIds?.has(r.run_id) ?? false}
                onSelect={() => onSelect(r.run_id)}
                onResume={onResume ? () => onResume(r.run_id) : undefined}
                onStop={onStop ? () => onStop(r.run_id) : undefined}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </Section>

      {finished.length > 0 && (
        <Section title="Recent" count={finished.length}>
          <AnimatePresence initial={false}>
            {finished.slice(0, 12).map((r) => (
              <motion.div
                key={r.run_id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.25 }}
              >
                <RunCard
                  run={r}
                  pipelines={pipelines}
                  selected={r.run_id === selectedRunId}
                  onSelect={() => onSelect(r.run_id)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 px-1 font-mono text-[10px] font-semibold uppercase tracking-[0.28em] text-accent">
        <span className="text-accent2">▌</span>
        {title}
        <span className="border border-line/40 bg-canvas/50 px-1.5 py-px text-[9.5px] text-muted">
          {count.toString().padStart(2, "0")}
        </span>
      </h2>
      <div className="flex flex-col gap-2.5">{children}</div>
    </section>
  );
}
