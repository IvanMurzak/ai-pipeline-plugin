import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ChevronDown, ChevronRight, CircleX, Loader2, X } from "lucide-react";
import type { RunFailuresResponse, StepTiming, ToolFailure } from "../types";
import { fetchRunFailures } from "../lib/api";
import { iterationLabel } from "../lib/format";
import { HudCorners } from "./HudFrame";

interface Props {
  projectId: string;
  runId: string;
  /** Per-step timings for the run (from /api/run-steps) — used to attribute
   *  each failure to the step whose window contains its timestamp. */
  steps?: StepTiming[];
  onClose: () => void;
}

/** The step a failure happened in: the step with the LATEST start at or
 *  before the failure's timestamp. Timestamps come from two producers
 *  (event journal vs transcript) whose ISO precision can differ, so compare
 *  EPOCHS, never strings. A step's still-open re-attempt window (open_since)
 *  counts as its start — a graph loop-back re-running an early step would
 *  otherwise attribute its failures to whatever ran in between (a closed
 *  re-attempt is still approximated by first_started_at; per-attempt windows
 *  aren't exposed by /api/run-steps). */
function stepLabelFor(ts: string, steps: StepTiming[] | undefined): string | null {
  if (!steps?.length) return null;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  let best: StepTiming | null = null;
  let bestStart = -Infinity;
  for (const s of steps) {
    const open = s.open_since ? Date.parse(s.open_since) : NaN;
    const first = Date.parse(s.first_started_at);
    const start = Number.isFinite(open) && open <= t ? open : first;
    if (!Number.isFinite(start) || start > t) continue;
    if (!best || start > bestStart) {
      best = s;
      bestStart = start;
    }
  }
  return best?.rel ? iterationLabel(best.rel) : null;
}

function timeOf(ts: string): string {
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString() : ts;
}

function FailureRow({ f, step }: { f: ToolFailure; step: string | null }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className="border border-line/30 bg-canvas/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-2 text-left hover:bg-panel2/60"
      >
        <Chevron size={12} className="shrink-0 text-muted" />
        <span className="font-mono text-[10.5px] tabular-nums text-muted">{timeOf(f.ts)}</span>
        {f.tool_name && (
          <span className="border border-bad/40 px-1.5 py-px font-mono text-[10px] uppercase tracking-wider text-bad">
            {f.tool_name}
          </span>
        )}
        {step && (
          <span className="border border-line/40 px-1.5 py-px font-mono text-[10px] uppercase tracking-wider text-muted">
            {step}
          </span>
        )}
        <span className="border border-line/30 px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wider text-muted/70">
          {f.source}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink/80">
          {f.error_excerpt.split("\n")[0]}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-line/30 px-3 py-2.5">
          {f.input_excerpt && (
            <div>
              <p className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.2em] text-muted">
                input
              </p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all bg-canvas/60 p-2 font-mono text-[11px] leading-relaxed text-muted">
                {f.input_excerpt}
              </pre>
            </div>
          )}
          <div>
            <p className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.2em] text-bad">
              error
            </p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-canvas/60 p-2 font-mono text-[11px] leading-relaxed text-ink/90">
              {f.error_excerpt}
            </pre>
          </div>
        </div>
      )}
    </li>
  );
}

/** Modal drill-down behind the FAIL analytics tile: every failed tool call in
 *  the run, with the tool's input and the error it returned. */
export function FailuresPanel({ projectId, runId, steps, onClose }: Props) {
  const [data, setData] = useState<RunFailuresResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Close only when the CLICK started on the backdrop — a text-selection drag
  // that starts inside the modal and releases over the backdrop dispatches
  // its click on the backdrop and must not close the modal.
  const downOnBackdrop = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetchRunFailures(projectId, runId)
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

  const rows = useMemo(
    () =>
      (data?.failures ?? []).map((f, i) => ({
        key: `${f.ts}-${i}`,
        f,
        step: stepLabelFor(f.ts, steps),
      })),
    [data, steps],
  );

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
          <CircleX size={14} className="text-bad" />
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-accent">
            ▌ FAILED_TOOL_CALLS
          </p>
          {data && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
              {data.failures.length}
              {data.truncated ? "+ (truncated)" : ""} · run {runId.slice(0, 8)}
            </span>
          )}
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
              // couldn't load failures: {error}
            </p>
          ) : !data ? (
            <p className="flex items-center justify-center gap-2 px-2 py-6 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
              <Loader2 size={13} className="animate-spin" /> reading transcripts…
            </p>
          ) : !data.transcript_found ? (
            <p className="px-2 py-6 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
              // no transcript resolved for this run — failure detail unavailable
            </p>
          ) : rows.length === 0 ? (
            <p className="px-2 py-6 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-good">
              // no failed tool calls recorded
            </p>
          ) : (
            <ul className="space-y-1.5">
              {rows.map((r) => (
                <FailureRow key={r.key} f={r.f} step={r.step} />
              ))}
            </ul>
          )}
        </div>
      </motion.div>
    </div>
  );
}
