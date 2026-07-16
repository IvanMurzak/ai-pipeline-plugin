import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  CheckCircle2,
  CircleDot,
  CodeXml,
  FileCode,
  GitPullRequest,
  Hourglass,
  PauseCircle,
  Play,
  Radio,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { PipelineEvent } from "../types";
import { relativeTime, iterationIndexFromPath } from "../lib/format";
import { HudCorners } from "./HudFrame";

interface Props {
  events: PipelineEvent[];
  filterRunId?: string | null;
}

const ICON: Record<string, LucideIcon> = {
  "pipeline.started": Play,
  "iteration.started": ArrowRight,
  "iteration.resumed": ArrowRight,
  "iteration.completed": CircleDot,
  "improver.started": Wrench,
  "improver.completed": Wrench,
  "script_creator.started": FileCode,
  "script_creator.completed": FileCode,
  "blocker.delegated": GitPullRequest,
  "blocker.polling": Hourglass,
  "blocker.resolved": CheckCircle2,
  "pipeline.completed": CheckCircle2,
  "pipeline.halted": XCircle,
  "session.opened": Radio,
};

const FALLBACK = PauseCircle;

const TONE: Record<string, string> = {
  "pipeline.completed": "text-good",
  "blocker.resolved": "text-good",
  "pipeline.halted": "text-bad",
  "blocker.delegated": "text-warn",
  "blocker.polling": "text-warn",
};

function formatLine(e: PipelineEvent): string {
  const d = e.data ?? {};
  switch (e.type) {
    case "pipeline.started":
      return `▶ Started ${d.pipeline_name ?? "pipeline"}`;
    case "iteration.started":
    case "iteration.resumed": {
      const idx =
        (typeof d.index === "number" || typeof d.index === "string"
          ? String(d.index)
          : null) ?? iterationIndexFromPath(d.iteration_path as string | undefined) ?? "?";
      return e.type === "iteration.resumed"
        ? `↻ Iteration ${idx} resumed`
        : `→ Iteration ${idx} started`;
    }
    case "iteration.completed": {
      const idx =
        iterationIndexFromPath(d.iteration_path as string | undefined) ??
        (typeof d.index === "number" || typeof d.index === "string"
          ? String(d.index)
          : "?");
      const outcome = (d.outcome as string | undefined) ?? "completed";
      return outcome === "completed"
        ? `✓ Iteration ${idx} completed`
        : `▸ Iteration ${idx} → ${outcome}`;
    }
    case "improver.started":
      return "⚙ Improver invoked";
    case "improver.completed":
      return `⚙ Improver ${d.applied ? "applied edits" : "ran"}`;
    case "script_creator.started":
      return "⚙ Script creator invoked";
    case "script_creator.completed":
      return `⚙ Script creator ${d.outcome ?? "ran"}`;
    case "blocker.delegated":
      return `↳ Blocker delegated → ${d.blocker_target_repo ?? "?"}`;
    case "blocker.polling":
      return `⏳ Polling blocker · ${d.pr_state ?? "—"}`;
    case "blocker.resolved":
      return "✓ Blocker resolved";
    case "pipeline.completed":
      return `✓ Pipeline completed`;
    case "pipeline.halted":
      return `✗ Halted: ${d.halt_reason ?? "no reason"}`;
    case "session.opened":
      return "◉ Claude Code session opened";
    default:
      return e.type;
  }
}

export function EventStream({ events, filterRunId }: Props) {
  const filtered = (filterRunId ? events.filter((e) => e.run_id === filterRunId) : events).slice(-100).reverse();
  return (
    <div className="surface flex h-full flex-col overflow-hidden text-accent">
      <HudCorners />
      <header className="flex items-center justify-between border-b frame-divider px-5 py-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-accent">
            ▌ EVENT_STREAM
          </p>
          <h3 className="font-display text-sm font-bold uppercase tracking-[0.14em] text-ink">
            {filterRunId ? "SELECTED_RUN" : "ALL_PROJECTS"}
          </h3>
        </div>
        <span className="border border-accent/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent">
          {filtered.length.toString().padStart(3, "0")}
        </span>
      </header>
      <ol className="flex-1 overflow-y-auto px-3 py-3 font-mono">
        <AnimatePresence initial={false}>
          {filtered.map((e, i) => {
            const Icon = ICON[e.type] ?? FALLBACK;
            const tone = TONE[e.type] ?? "text-accent";
            return (
              <motion.li
                key={`${e.ts}|${e.type}|${e.run_id ?? ""}|${i}`}
                layout
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -6 }}
                transition={{ duration: 0.18 }}
                className="flex items-start gap-3 border-l-2 border-transparent px-2 py-1.5 hover:border-l-accent/60 hover:bg-panel2/60"
              >
                <span className={`mt-0.5 ${tone}`}>
                  <Icon size={13} />
                </span>
                <span className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] text-ink">{formatLine(e)}</p>
                  <p className="truncate text-[10px] uppercase tracking-wider text-muted">
                    {relativeTime(e.ts)} · {e.type}
                  </p>
                </span>
                <CodeXml
                  size={11}
                  className="mt-1 shrink-0 text-muted/40"
                  aria-label={JSON.stringify(e.data)}
                />
              </motion.li>
            );
          })}
        </AnimatePresence>
        {filtered.length === 0 && (
          <li className="px-4 py-8 text-center text-[10.5px] uppercase tracking-[0.22em] text-muted">
            <span className="caret">// awaiting_events</span>
          </li>
        )}
      </ol>
    </div>
  );
}
