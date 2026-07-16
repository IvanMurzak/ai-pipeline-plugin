import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ChevronDown, ChevronRight, Cpu, Loader2, Sparkles, Wrench, X } from "lucide-react";
import type { RunBreakdownResponse, ToolAggregate, ToolCallDetail } from "../types";
import { fetchRunBreakdown } from "../lib/api";
import { compactNumber, durationMs } from "../lib/format";
import { HudCorners } from "./HudFrame";

export type BreakdownTab = "tools" | "agents";

interface Props {
  projectId: string;
  runId: string;
  /** Which tab the user opened (TOOLS tile vs AGENTS tile). */
  initialTab: BreakdownTab;
  onClose: () => void;
}

function timeOf(ts: string): string {
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString() : ts;
}

/** One tool's aggregate row; expands to its individual calls (from the capped
 *  chronological call list, filtered by name). */
function ToolRow({ agg, calls }: { agg: ToolAggregate; calls: ToolCallDetail[] }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  const closed = calls.filter((c) => c.duration_ms !== null);
  const avg = closed.length ? agg.total_duration_ms / closed.length : null;
  return (
    <li className="border border-line/30 bg-canvas/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-2 text-left hover:bg-panel2/60"
      >
        <Chevron size={12} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{agg.name}</span>
        <span className="border border-accent/30 px-1.5 py-px font-mono text-[10px] tabular-nums text-accent">
          {compactNumber(agg.calls)}×
        </span>
        {agg.failed > 0 && (
          <span className="border border-bad/40 px-1.5 py-px font-mono text-[10px] tabular-nums text-bad">
            {agg.failed}✗
          </span>
        )}
        <span
          className="border border-line/40 px-1.5 py-px font-mono text-[10px] tabular-nums text-muted"
          title="Total time in this tool (closed calls) · slowest single call"
        >
          Σ {durationMs(agg.total_duration_ms)} · max {durationMs(agg.max_duration_ms)}
          {avg !== null ? ` · avg ${durationMs(avg)}` : ""}
        </span>
      </button>
      {open && (
        <div className="border-t border-line/30">
          {calls.length === 0 ? (
            <p className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted">
              // individual calls fell outside the capped list
            </p>
          ) : (
            <ul>
              {calls.map((c, i) => (
                <li
                  key={`${c.ts}-${i}`}
                  className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 border-b border-line/20 px-3 py-1.5 last:border-b-0"
                >
                  <span className="font-mono text-[10px] tabular-nums text-muted">{timeOf(c.ts)}</span>
                  <span className="font-mono text-[10px] tabular-nums text-accent">
                    {c.duration_ms !== null ? durationMs(c.duration_ms) : "…"}
                  </span>
                  {c.is_error && <span className="font-mono text-[10px] text-bad">✗</span>}
                  <span className="border border-line/30 px-1 py-px font-mono text-[9px] uppercase tracking-wider text-muted/70">
                    {c.source}
                  </span>
                  {c.input_excerpt && (
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink/70">
                      {c.input_excerpt}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/** Modal drill-down behind the TOOLS / AGENTS analytics tiles. */
export function BreakdownPanel({ projectId, runId, initialTab, onClose }: Props) {
  const [data, setData] = useState<RunBreakdownResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<BreakdownTab>(initialTab);
  const downOnBackdrop = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetchRunBreakdown(projectId, runId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, runId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const callsByTool = useMemo(() => {
    const m = new Map<string, ToolCallDetail[]>();
    for (const c of data?.calls ?? []) {
      const arr = m.get(c.tool_name) ?? [];
      arr.push(c);
      m.set(c.tool_name, arr);
    }
    return m;
  }, [data]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.18 }}
        className="surface relative flex max-h-[85vh] w-full max-w-3xl flex-col text-accent"
        onClick={(e) => e.stopPropagation()}
      >
        <HudCorners />
        <header className="flex items-center gap-2.5 border-b frame-divider px-5 py-3.5">
          {tab === "tools" ? (
            <Wrench size={14} className="text-accent" />
          ) : (
            <Sparkles size={14} className="text-accent2" />
          )}
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-accent">
            ▌ RUN_BREAKDOWN
          </p>
          <div className="flex items-center gap-1">
            {(["tools", "agents"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                  tab === t
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-line/40 text-muted hover:text-ink"
                }`}
              >
                {t}
                {data ? ` ${t === "tools" ? data.tools.reduce((n, a) => n + a.calls, 0) : data.agents.length}` : ""}
              </button>
            ))}
          </div>
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            run {runId.slice(0, 8)}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto p-1 text-muted transition-colors hover:text-ink"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error ? (
            <p className="px-2 py-6 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-bad">
              // couldn't load breakdown: {error}
            </p>
          ) : !data ? (
            <p className="flex items-center justify-center gap-2 px-2 py-6 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
              <Loader2 size={13} className="animate-spin" /> reading transcripts…
            </p>
          ) : !data.transcript_found ? (
            <p className="px-2 py-6 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
              // no transcript resolved for this run — breakdown unavailable
            </p>
          ) : tab === "tools" ? (
            data.tools.length === 0 ? (
              <p className="px-2 py-6 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
                // no tool calls recorded
              </p>
            ) : (
              <>
                {data.calls_truncated && (
                  <p className="mb-2 font-mono text-[9.5px] uppercase tracking-wider text-warn">
                    // call list capped — aggregates cover every call, expanded rows may miss late ones
                  </p>
                )}
                <ul className="space-y-1.5">
                  {data.tools.map((agg) => (
                    <ToolRow key={agg.name} agg={agg} calls={callsByTool.get(agg.name) ?? []} />
                  ))}
                </ul>
              </>
            )
          ) : data.agents.length === 0 ? (
            <p className="px-2 py-6 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
              // no agent spawns recorded
            </p>
          ) : (
            <ul className="space-y-1.5">
              {data.agents.map((a, i) => (
                <li key={`${a.started_at}-${i}`} className="border border-line/30 bg-canvas/40 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <Sparkles size={11} className="shrink-0 text-accent2" />
                    <span className="font-mono text-[11px] text-ink">
                      {a.agent_type ?? "agent"}
                    </span>
                    {a.started_at && (
                      <span className="font-mono text-[10px] tabular-nums text-muted">
                        {timeOf(a.started_at)}
                      </span>
                    )}
                    {a.duration_ms !== null && (
                      <span className="border border-accent/30 px-1.5 py-px font-mono text-[10px] tabular-nums text-accent">
                        {durationMs(a.duration_ms)}
                      </span>
                    )}
                    {a.matched ? (
                      <span className="inline-flex items-center gap-1 border border-line/40 px-1.5 py-px font-mono text-[10px] tabular-nums text-muted">
                        <Wrench size={9} />
                        {compactNumber(a.tools_called)}
                        {a.tools_failed > 0 && <span className="text-bad">/{a.tools_failed}✗</span>}
                      </span>
                    ) : (
                      <span
                        className="border border-warn/40 px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wider text-warn"
                        title="No subagent transcript matched this spawn — tokens/tools unknown"
                      >
                        no transcript
                      </span>
                    )}
                    {a.matched && (
                      <span
                        className="inline-flex items-center gap-1 border border-line/40 bg-canvas/50 px-1.5 py-px font-mono text-[10px] tabular-nums text-muted"
                        title="Input↓ / output↑ tokens · cache read R / written W"
                      >
                        <Cpu size={9} />
                        {compactNumber(a.input_tokens)}↓ {compactNumber(a.output_tokens)}↑ ·{" "}
                        {compactNumber(a.cache_read_tokens)}R {compactNumber(a.cache_creation_tokens)}W
                      </span>
                    )}
                  </div>
                  {a.description && (
                    <p className="mt-1 line-clamp-2 font-mono text-[10.5px] leading-snug text-muted">
                      {a.description}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </motion.div>
    </div>
  );
}
