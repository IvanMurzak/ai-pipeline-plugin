import { motion } from "framer-motion";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleX,
  Cpu,
  Database,
  Sparkles,
  Timer,
  Wrench,
} from "lucide-react";
import type { RunState, RunStats } from "../types";
import { compactNumber, elapsed, iterationLabel, relativeTime } from "../lib/format";
import { isActive } from "../lib/runs";
import { useNowTick } from "../hooks/useNowTick";
import { StatusBadge } from "./StatusBadge";
import { HudCorners } from "./HudFrame";

interface Props {
  run: RunState | null;
  /** Authoritative per-run stats from /api/run-stats (transcript-folded). When
   *  present it overrides the event-folded run.stats, which undercounts. Null
   *  while loading or on fetch failure → fall back to run.stats. */
  statsOverride?: RunStats | null;
  /** When set and the run has failed tool calls, the FAIL tile becomes a
   *  button that opens the failure drill-down. */
  onShowFailures?: () => void;
  /** When set, the TOOLS / AGENTS tiles become buttons that open the
   *  per-call / per-agent breakdown (durations + tokens). */
  onShowBreakdown?: (tab: "tools" | "agents") => void;
}

/** Total-run-time readout. Self-ticking LEAF while the run is live, so the
 *  1 Hz clock re-renders this span only — not the whole analytics grid. */
function LiveElapsed({ run, live }: { run: RunState; live: boolean }) {
  useNowTick(live);
  return (
    <span
      className={`flex items-center gap-1 font-mono text-[10.5px] tabular-nums ${live ? "text-accent" : "text-muted"}`}
      title={live ? "Total run time — still running" : "Total run time"}
    >
      <Timer size={11} />
      {elapsed(run.started_at, live ? null : run.last_event_at)}
      {live && <span className="animate-pulse">●</span>}
    </span>
  );
}

export function StatsPanel({ run, statsOverride, onShowFailures, onShowBreakdown }: Props) {
  if (!run) return null;
  const live = isActive(run.status);
  const s = statsOverride ?? run.stats;
  const failClickable = s.tools_failed > 0 && !!onShowFailures;
  const toolsClickable = s.tools_called > 0 && !!onShowBreakdown;
  const agentsClickable = s.agents_spawned > 0 && !!onShowBreakdown;
  const cards: Array<{
    label: string;
    value: string;
    Icon: typeof Wrench;
    tone: "accent" | "accent2" | "good" | "warn" | "bad";
    sub?: string;
    onClick?: () => void;
  }> = [
    {
      label: "TOOLS",
      value: compactNumber(s.tools_called),
      Icon: Wrench,
      tone: "accent",
      sub: toolsClickable
        ? "VIEW_DETAILS"
        : s.tools_failed > 0
        ? `${s.tools_failed} FAIL`
        : "ALL_CLEAN",
      onClick: toolsClickable ? () => onShowBreakdown!("tools") : undefined,
    },
    {
      label: "FAIL",
      value: compactNumber(s.tools_failed),
      Icon: CircleX,
      tone: s.tools_failed > 0 ? "bad" : "good",
      sub: failClickable ? "VIEW_DETAILS" : undefined,
      onClick: failClickable ? onShowFailures : undefined,
    },
    {
      label: "AGENTS",
      value: compactNumber(s.agents_spawned),
      Icon: Sparkles,
      tone: "accent2",
      sub: agentsClickable ? "VIEW_DETAILS" : undefined,
      onClick: agentsClickable ? () => onShowBreakdown!("agents") : undefined,
    },
    {
      label: "TOK_IN",
      value: compactNumber(s.input_tokens),
      Icon: ArrowDownToLine,
      tone: "accent",
    },
    {
      label: "TOK_OUT",
      value: compactNumber(s.output_tokens),
      Icon: ArrowUpFromLine,
      tone: "accent2",
    },
    {
      label: "CACHE_R",
      value: compactNumber(s.cache_read_tokens),
      Icon: Database,
      tone: "good",
      sub: s.cache_creation_tokens > 0 ? `${compactNumber(s.cache_creation_tokens)} W` : undefined,
    },
  ];
  if (s.cost_usd != null && s.cost_usd > 0) {
    cards.push({
      label: "COST",
      value: s.cost_usd >= 1 ? `$${s.cost_usd.toFixed(2)}` : `$${s.cost_usd.toFixed(3)}`,
      Icon: Sparkles,
      tone: "warn",
      sub: "API_USD",
    });
  }

  const TONE_BG: Record<string, string> = {
    accent: "border-accent/40",
    accent2: "border-accent2/40",
    good: "border-good/40",
    warn: "border-warn/40",
    bad: "border-bad/40",
  };
  const TONE_TEXT: Record<string, string> = {
    accent: "text-accent",
    accent2: "text-accent2",
    good: "text-good",
    warn: "text-warn",
    bad: "text-bad",
  };

  return (
    <div className="surface p-4 text-accent">
      <HudCorners />
      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b frame-divider pb-2">
        <span className="flex items-center gap-2">
          <Cpu size={13} className="text-accent" />
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-accent">
            ▌ RUN_ANALYTICS
          </p>
        </span>
        <StatusBadge status={run.status} awaiting={run.awaiting_input} />
        <LiveElapsed run={run} live={live} />
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          started {relativeTime(run.started_at)}
        </span>
        {run.current_iteration_path && (
          <span className="min-w-0 truncate font-mono text-[10px] text-muted">
            <span className="text-accent">›</span> {iterationLabel(run.current_iteration_path)}
          </span>
        )}
      </header>
      <div className="grid grid-cols-3 gap-2.5 font-mono">
        {cards.map((c) => (
          <motion.div
            key={c.label}
            layout
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            {...(c.onClick
              ? {
                  role: "button",
                  tabIndex: 0,
                  onClick: c.onClick,
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                      // Suppress the browser's Space-scroll and Enter repeat.
                      e.preventDefault();
                      if (!e.repeat) c.onClick?.();
                    }
                  },
                  title: `Show ${c.label.toLowerCase()} details`,
                }
              : {})}
            className={`
              relative overflow-hidden border ${TONE_BG[c.tone]}
              bg-canvas/40 p-3
              ${c.onClick ? "cursor-pointer transition-colors hover:bg-panel2/70" : ""}
            `}
          >
            <c.Icon size={12} className={`absolute right-2 top-2 ${TONE_TEXT[c.tone]}`} />
            <p className="text-[9.5px] uppercase tracking-[0.2em] text-muted">{c.label}</p>
            <p className="mt-1 font-display text-xl font-bold tabular-nums text-ink">
              {c.value}
            </p>
            {c.sub && (
              <p className="mt-0.5 text-[9.5px] uppercase tracking-wider text-muted">
                {c.sub}
              </p>
            )}
          </motion.div>
        ))}
      </div>
    </div>
  );
}
