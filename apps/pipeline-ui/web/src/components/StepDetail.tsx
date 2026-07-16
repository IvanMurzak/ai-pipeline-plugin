import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Cpu, FileText, Loader2, Sparkles, Wrench, X } from "lucide-react";
import type { IterationDetail } from "../types";
import type { IterationStats, IterationToolStats } from "../lib/runs";
import { compactNumber, modelLabel, relativeTime } from "../lib/format";
import { Markdown } from "./Markdown";
import { HudCorners } from "./HudFrame";

interface Props {
  loading: boolean;
  detail: IterationDetail | null;
  error: string | null;
  stats?: IterationStats | null;
  /** Per-step TOOL/TOKEN stats for the selected run (step_id-aware overlap-safe
   *  fold). null when no run is selected or the step has no telemetry. */
  toolStats?: IterationToolStats | null;
  onClose: () => void;
}

export function StepDetail({ loading, detail, error, stats, toolStats, onClose }: Props) {
  return (
    <motion.section
      key={detail?.rel_path ?? "empty"}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={{ duration: 0.22 }}
      className="surface flex max-h-[55vh] min-h-[180px] flex-col overflow-hidden text-accent2"
    >
      <HudCorners />
      <header className="flex items-start justify-between gap-4 border-b frame-divider px-5 py-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-accent2">
            <FileText size={11} /> STEP_DETAIL
          </p>
          <h3 className="mt-1 truncate font-display text-base font-bold uppercase tracking-[0.12em] text-ink">
            {detail?.title ?? detail?.rel_path ?? "LOADING…"}
          </h3>
          {detail && (
            <p className="mt-0.5 truncate font-mono text-[10.5px] text-muted">
              › {detail.rel_path}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {stats && stats.started_count > 0 && <StatBadges stats={stats} />}
          {toolStats && <ToolStatBadges stats={toolStats} />}
          <button
            onClick={onClose}
            className="border border-transparent p-1 text-muted transition-colors hover:border-accent2/60 hover:text-accent2"
            aria-label="Close step detail"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          {loading && (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex h-full items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-wider text-muted"
            >
              <Loader2 size={13} className="animate-spin text-accent" />
              READING_STEP…
            </motion.div>
          )}
          {!loading && error && (
            <motion.div
              key="error"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="px-5 py-6 text-sm text-bad"
            >
              {error}
            </motion.div>
          )}
          {!loading && !error && detail && (
            <motion.div
              key="content"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-4 px-5 py-4"
            >
              {detail.sections.length === 0 && (
                <Markdown size="sm">{detail.raw}</Markdown>
              )}
              {detail.sections.map((s, i) => (
                <Section key={`${s.heading}-${i}`} heading={s.heading} body={s.body} />
              ))}

              <footer className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t frame-divider pt-3 font-mono text-[10px] uppercase tracking-wider text-muted">
                <span className="break-all normal-case">{detail.absolute_path}</span>
                <span>
                  UPDATED {relativeTime(detail.modified_at)}
                  {modelLabel(stats?.resolved_model) && (
                    <> · MODEL: {modelLabel(stats?.resolved_model)}</>
                  )}
                </span>
              </footer>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.section>
  );
}

function Section({ heading, body }: { heading: string; body: string }) {
  const accentForHeading = (h: string): string => {
    const lower = h.toLowerCase();
    if (lower === "goal") return "from-accent to-accent2";
    if (lower === "next") return "from-good to-accent2";
    if (lower.includes("success")) return "from-good to-accent";
    if (lower === "steps") return "from-accent2 to-accent";
    return "from-muted to-line";
  };
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span
          className={`inline-block h-[2px] w-6 bg-gradient-to-r ${accentForHeading(heading)}`}
        />
        <h4 className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-accent">
          {heading}
        </h4>
      </div>
      <div className="text-[13px] leading-relaxed text-ink/90">
        {heading.toLowerCase() === "next" ? (
          <NextLine body={body} />
        ) : (
          <Markdown size="sm">{body}</Markdown>
        )}
      </div>
    </section>
  );
}

function NextLine({ body }: { body: string }) {
  const trimmed = body.trim();
  const complete = /pipeline\s+complete\.?/i.test(trimmed);
  return (
    <span className="inline-flex items-center gap-1.5 font-mono">
      <ArrowRight size={12} className={complete ? "text-good" : "text-accent"} />
      {trimmed}
    </span>
  );
}

function StatBadges({ stats }: { stats: IterationStats }) {
  return (
    <div className="flex items-center gap-1 font-mono text-[9.5px] uppercase tracking-wider">
      <span className="border border-line/40 bg-canvas/50 px-1.5 py-px text-muted">
        {stats.started_count} {stats.started_count === 1 ? "RUN" : "RUNS"}
      </span>
      {stats.completed_count > 0 && (
        <span className="border border-good/40 px-1.5 py-px text-good">
          {stats.completed_count} ✓
        </span>
      )}
      {stats.halted_count > 0 && (
        <span className="border border-bad/40 px-1.5 py-px text-bad">
          {stats.halted_count} ✗
        </span>
      )}
      {stats.blocked_count > 0 && (
        <span className="border border-warn/40 px-1.5 py-px text-warn">
          {stats.blocked_count} ⏸
        </span>
      )}
    </div>
  );
}

// Per-step TOOL/TOKEN badges, sourced from the step_id-aware overlap-safe fold
// (correct for parallel AND sequential runs). Mirrors the compact line in the
// iteration tree; renders only non-zero chips.
function ToolStatBadges({ stats }: { stats: IterationToolStats }) {
  // Combined effective input (input + cache read + cache creation) in one badge —
  // a deliberate compact rollup, NOT the per-run StatsPanel breakdown (which shows
  // the three separately), so this reads larger than the panel's TOK_IN card.
  const tokensIn = stats.input_tokens + stats.cache_read_tokens + stats.cache_creation_tokens;
  const hasAny =
    stats.tools_called > 0 ||
    stats.agents_spawned > 0 ||
    tokensIn > 0 ||
    stats.output_tokens > 0;
  if (!hasAny) return null;
  return (
    <div className="flex items-center gap-1 font-mono text-[9.5px] uppercase tracking-wider tabular-nums">
      {stats.tools_called > 0 && (
        <span className="inline-flex items-center gap-1 border border-accent/30 px-1.5 py-px text-accent">
          <Wrench size={9} />
          {compactNumber(stats.tools_called)}
          {stats.tools_failed > 0 && (
            <span className="text-bad">/{compactNumber(stats.tools_failed)}✗</span>
          )}
        </span>
      )}
      {stats.agents_spawned > 0 && (
        <span className="inline-flex items-center gap-1 border border-accent2/30 px-1.5 py-px text-accent2">
          <Sparkles size={9} />
          {compactNumber(stats.agents_spawned)}
        </span>
      )}
      {(tokensIn > 0 || stats.output_tokens > 0) && (
        <span className="inline-flex items-center gap-1 border border-line/40 bg-canvas/50 px-1.5 py-px text-muted">
          <Cpu size={9} />
          {compactNumber(tokensIn)}↓ {compactNumber(stats.output_tokens)}↑
        </span>
      )}
    </div>
  );
}
