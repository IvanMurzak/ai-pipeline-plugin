import { motion } from "framer-motion";
import {
  Check,
  ChevronRight,
  Cpu,
  Database,
  FileText,
  Loader2,
  Sparkles,
  Timer,
  Wrench,
  XCircle,
} from "lucide-react";
import type { PipelineInfo, RunState, StepTiming } from "../types";
import { compactNumber, durationMs, iterationLabel, modelLabel, modelPillClass } from "../lib/format";
import { useNowTick } from "../hooks/useNowTick";
import type { IterationStats, IterationToolStats } from "../lib/runs";
import { HudCorners } from "./HudFrame";

interface Props {
  pipeline: PipelineInfo | null;
  activeRun: RunState | null;
  /** Per-step rollup from the journal, keyed by rel path (e.g. "01-foo.md"). */
  iterationStats?: Map<string, IterationStats>;
  /** Per-step TOOL/TOKEN stats for the selected run, keyed by rel path. From
   *  the step_id-aware overlap-safe fold — correct for parallel AND
   *  sequential runs. Absent when no run is selected. */
  iterationToolStats?: Map<string, IterationToolStats>;
  /** Per-step wall-clock timings for the selected run (from /api/run-steps),
   *  keyed by rel path. A step with `open_since` renders a live-ticking
   *  duration. Absent → no duration chips. */
  stepTimings?: Map<string, StepTiming>;
  /** Currently-selected step (rel path). Highlighted when set. */
  selectedRel?: string | null;
  /** Click handler for a step row; opens the detail panel. */
  onSelectStep?: (rel: string) => void;
}

export function IterationTree({
  pipeline,
  activeRun,
  iterationStats,
  iterationToolStats,
  stepTimings,
  selectedRel,
  onSelectStep,
}: Props) {
  if (!pipeline) {
    return (
      <div className="surface flex h-full items-center justify-center p-10 text-center font-mono text-xs uppercase tracking-[0.2em] text-muted">
        <HudCorners />
        // select a pipeline to inspect its iterations
      </div>
    );
  }

  const terminal =
    activeRun?.status === "completed" || activeRun?.status === "halted";

  // Escape regex metacharacters in the user-controlled pipeline folder name.
  // Without this, a name like `my.api` makes the dot a wildcard and matches
  // the wrong path; a name with `(` throws a SyntaxError and blanks the panel.
  // Mirrors the same escaping in lib/runs.ts iterationStatsByRel.
  const esc = (n: string) => n.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const tailOf = (rel: string) =>
    rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;

  // Rows = own steps + (for a family TARGET) the hub's shared steps the run
  // chains into, interleaved by basename so the numbering convention
  // (01 target-local, 02.. hub-shared) reads as one chain. A shared step
  // whose basename an own step already uses is a target-local override —
  // the own copy wins. Non-family pipelines keep their original order.
  const shared = pipeline.shared_iterations ?? [];
  const ownTails = new Set(pipeline.iterations.map(tailOf));
  const rows: Array<{ rel: string; shared: boolean }> = shared.length
    ? [
        ...pipeline.iterations.map((rel) => ({ rel, shared: false })),
        ...shared
          .filter((rel) => !ownTails.has(tailOf(rel)))
          .map((rel) => ({ rel, shared: true })),
      ].sort((a, b) => tailOf(a.rel).localeCompare(tailOf(b.rel)))
    : pipeline.iterations.map((rel) => ({ rel, shared: false }));

  // The run's current step, rel-ified. A family-target run's current path can
  // sit under the TARGET root or under the HUB's shared steps/ — try both.
  const currentRel = (() => {
    const p = activeRun?.current_iteration_path?.replaceAll("\\", "/");
    if (!p) return null;
    const names = [pipeline.pipeline_name];
    if (pipeline.family_hub) names.push(pipeline.family_hub.pipeline_name);
    for (const n of names) {
      const m = p.match(new RegExp(`\\/${esc(n)}\\/steps\\/(.+)$`));
      if (m) return m[1];
    }
    return null;
  })();

  return (
    <div className="surface flex h-full flex-col overflow-hidden text-accent">
      <HudCorners />
      <header className="border-b frame-divider px-5 py-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-accent">
          ▌ PIPELINE
        </p>
        <h2
          className="glitch mt-1 font-display text-lg font-bold uppercase tracking-[0.14em] text-ink"
          data-text={pipeline.pipeline_name}
        >
          {pipeline.pipeline_name}
        </h2>
        {pipeline.end_state && (
          <p className="mt-1.5 line-clamp-2 text-[12px] leading-snug text-muted">
            <span className="text-accent2">›</span> {pipeline.end_state}
          </p>
        )}
      </header>

      <ol className="flex-1 overflow-y-auto px-3 py-3 font-mono">
        {rows.length === 0 && (
          <li className="px-4 py-6 text-center text-[11px] uppercase tracking-[0.2em] text-muted">
            // no iterations under steps/ yet
          </li>
        )}
        {rows.map(({ rel, shared: isShared }, i) => {
          // When the run has finished (completed / halted), nothing is
          // "current" anymore — every iteration up through the completed
          // count is past. Without this, the last started iteration keeps
          // a spinning loader forever even though pipeline.completed has
          // already fired.
          const isCurrent = !terminal && currentRel && rel === currentRel;
          const selected = selectedRel === rel;
          // Stats are keyed by the file BASENAME (no folder prefix), so look up
          // by tail when the path includes a sub-folder.
          const tail = tailOf(rel);
          const stats = iterationStats?.get(tail) ?? iterationStats?.get(rel);
          const toolStats = iterationToolStats?.get(tail) ?? iterationToolStats?.get(rel);
          const timing = stepTimings?.get(tail) ?? stepTimings?.get(rel);
          // Progress markers. A FAMILY tree's rows include hub steps this run
          // may never execute, so a row index compared against
          // iteration_count_completed marks the wrong rows — family rows use
          // the run's own per-step outcomes (stepTimings) instead. Plain
          // pipelines keep the index heuristic (their rows ARE the plan
          // order, and steps that emitted no events still get marked).
          const isPast = shared.length
            ? !isCurrent && timing != null && !timing.open_since && timing.last_outcome === "completed"
            : terminal
            ? activeRun?.status === "completed" ||
              (activeRun?.iteration_count_completed != null &&
                i < activeRun.iteration_count_completed)
            : activeRun?.iteration_count_completed != null &&
              i < activeRun.iteration_count_completed &&
              !isCurrent;
          const isHaltMark = shared.length
            ? activeRun?.status === "halted" && timing?.last_outcome === "halted"
            : activeRun?.status === "halted" && i === (activeRun?.iteration_count_completed ?? -1);
          // The file's frontmatter `model:`/`effort:`/`permission-mode:` —
          // shown when no observed value exists yet (a step edited but not
          // re-run), so a config change is visible immediately. The
          // event-observed values win once the step runs.
          const configuredModel = pipeline.step_models?.[rel] ?? null;
          const configuredEffort = pipeline.step_efforts?.[rel] ?? null;
          const configuredPermission = pipeline.step_permission_modes?.[rel] ?? null;
          const clickable = !!onSelectStep;
          return (
            <motion.li
              key={rel}
              layout
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.25, delay: Math.min(i * 0.015, 0.25) }}
              className="list-none"
            >
              <button
                type="button"
                disabled={!clickable}
                onClick={() => onSelectStep?.(rel)}
                className={`
                  group relative flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm
                  transition-colors
                  ${isCurrent ? "shimmer border-l-2 border-accent" : "border-l-2 border-transparent"}
                  ${
                    selected
                      ? "bg-accent/10 border-l-accent"
                      : clickable
                      ? "hover:bg-panel2/60"
                      : ""
                  }
                  ${isPast && !selected ? "opacity-75" : ""}
                  ${clickable ? "cursor-pointer" : "cursor-default"}
                `}
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center border border-line/40 bg-canvas/50 text-[10px] uppercase text-muted">
                  {isCurrent ? (
                    <Loader2 size={13} className="animate-spin text-accent" />
                  ) : isHaltMark ? (
                    <XCircle size={13} className="text-bad" />
                  ) : isPast ? (
                    <Check size={13} className="text-good" />
                  ) : (
                    <FileText size={12} />
                  )}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">
                    <span className="text-accent">{String(i + 1).padStart(2, "0")}.</span>{" "}
                    {iterationLabel(rel)}
                  </span>
                  {((stats && stats.started_count > 0) ||
                    timing ||
                    configuredModel ||
                    configuredEffort ||
                    configuredPermission) && (
                    <StatLine
                      stats={stats?.started_count ? stats : undefined}
                      timing={timing}
                      configuredModel={configuredModel}
                      configuredEffort={configuredEffort}
                      configuredPermission={configuredPermission}
                    />
                  )}
                  {toolStats && <ToolStatLine stats={toolStats} />}
                </span>

                {isShared && pipeline.family_hub ? (
                  <span
                    className="hidden truncate text-[10px] uppercase tracking-wider text-muted/70 sm:inline"
                    title={`Shared step from the family hub ${pipeline.family_hub.pipeline_name}`}
                  >
                    ⇡ {pipeline.family_hub.pipeline_name}
                  </span>
                ) : (
                  rel.includes("/") && (
                    <span className="hidden truncate text-[10px] uppercase tracking-wider text-muted sm:inline">
                      {rel.slice(0, rel.lastIndexOf("/"))}
                    </span>
                  )
                )}

                <ChevronRight
                  size={14}
                  className={`shrink-0 transition-colors ${
                    selected ? "text-accent" : "text-muted/40 group-hover:text-muted"
                  }`}
                />
              </button>
            </motion.li>
          );
        })}
      </ol>
    </div>
  );
}

/** Wall-clock chip for one step: "⏱ 7m 05s", ticking live (and highlighted)
 *  while the step's window is still open. Active time only — parked
 *  needs-input hours are excluded by the server fold. Self-ticking LEAF:
 *  only the (typically single) open chip re-renders per second, never the
 *  whole tree. */
function TimingChip({ timing }: { timing: StepTiming }) {
  const now = useNowTick(timing.open_since !== null);
  const openMs = timing.open_since ? Math.max(0, now - Date.parse(timing.open_since)) : 0;
  const total = timing.duration_ms + openMs;
  if (total <= 0 && !timing.open_since) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 border px-1.5 py-px tabular-nums ${
        timing.open_since ? "border-accent/60 text-accent" : "border-line/40 bg-canvas/50"
      }`}
      title={
        timing.open_since
          ? "Step is running — active time so far"
          : `Active work time across ${timing.attempts} attempt${timing.attempts === 1 ? "" : "s"}`
      }
    >
      <Timer size={9} />
      {durationMs(total)}
      {timing.open_since && <span className="animate-pulse">●</span>}
    </span>
  );
}

function StatLine({
  stats,
  timing,
  configuredModel,
  configuredEffort,
  configuredPermission,
}: {
  stats?: IterationStats;
  timing?: StepTiming;
  /** Frontmatter `model:` from the step file — the fallback pill when no
   *  run has been observed for this step yet. */
  configuredModel?: string | null;
  /** Frontmatter `effort:` — same observed-wins fallback rule as the model. */
  configuredEffort?: string | null;
  /** Frontmatter `permission-mode:` (configured only — not observable). */
  configuredPermission?: string | null;
}) {
  const observed = stats?.resolved_model ?? null;
  const model = observed ?? configuredModel ?? null;
  const pill = modelPillClass(model);
  const label = modelLabel(model);
  const modelTitle = observed
    ? "Model observed in the most recent run of this step"
    : "Model configured in the step file (no run observed yet)";
  const observedEffort = stats?.resolved_effort ?? null;
  const effort = observedEffort ?? configuredEffort ?? null;
  const effortTitle = observedEffort
    ? "Reasoning effort the most recent run used"
    : "Reasoning effort configured in the step file";
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
      {timing && <TimingChip timing={timing} />}
      {stats && (
        <>
          <span className="border border-line/40 bg-canvas/50 px-1.5 py-px">
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
        </>
      )}
      {label && (
        <span className={pill} title={modelTitle}>
          {label}
        </span>
      )}
      {effort && (
        <span
          className="border border-accent2/40 px-1.5 py-px text-accent2"
          title={effortTitle}
        >
          ⚡{effort}
        </span>
      )}
      {configuredPermission && (
        <span
          className="border border-line/40 bg-canvas/50 px-1.5 py-px"
          title="permission-mode configured in the step file"
        >
          🛡{configuredPermission}
        </span>
      )}
    </span>
  );
}

// Compact per-step TOOL/TOKEN line, sourced from the step_id-aware overlap-safe
// fold (correct for parallel AND sequential runs). Reuses compactNumber + the
// same iconography as the per-run StatsPanel for visual consistency. Renders
// only non-zero chips to keep the tree dense; a step with no telemetry yet
// (all zeros) renders nothing rather than a row of "0"s. The full breakdown —
// tools, agents, in/out tokens, cache read/write — mirrors the per-run
// StatsPanel cards (the chips wrap onto a second line when needed).
function ToolStatLine({ stats }: { stats: IterationToolStats }) {
  const hasAny =
    stats.tools_called > 0 ||
    stats.agents_spawned > 0 ||
    stats.input_tokens > 0 ||
    stats.output_tokens > 0 ||
    stats.cache_read_tokens > 0 ||
    stats.cache_creation_tokens > 0;
  if (!hasAny) return null;
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted tabular-nums">
      {stats.tools_called > 0 && (
        <span
          className="inline-flex items-center gap-1 border border-accent/30 px-1.5 py-px text-accent"
          title={`Tools called${stats.tools_failed > 0 ? ` (${stats.tools_failed} failed)` : ""}`}
        >
          <Wrench size={9} />
          {compactNumber(stats.tools_called)}
          {stats.tools_failed > 0 && (
            <span className="text-bad">/{compactNumber(stats.tools_failed)}✗</span>
          )}
        </span>
      )}
      {stats.agents_spawned > 0 && (
        <span
          className="inline-flex items-center gap-1 border border-accent2/30 px-1.5 py-px text-accent2"
          title="Agents spawned"
        >
          <Sparkles size={9} />
          {compactNumber(stats.agents_spawned)}
        </span>
      )}
      {(stats.input_tokens > 0 || stats.output_tokens > 0) && (
        <span
          className="inline-flex items-center gap-1 border border-line/40 bg-canvas/50 px-1.5 py-px"
          title="Input / output tokens"
        >
          <Cpu size={9} />
          {compactNumber(stats.input_tokens)}↓ {compactNumber(stats.output_tokens)}↑
        </span>
      )}
      {(stats.cache_read_tokens > 0 || stats.cache_creation_tokens > 0) && (
        <span
          className="inline-flex items-center gap-1 border border-good/30 px-1.5 py-px text-good"
          title="Cache tokens: read / written"
        >
          <Database size={9} />
          {compactNumber(stats.cache_read_tokens)}R
          {stats.cache_creation_tokens > 0 && ` ${compactNumber(stats.cache_creation_tokens)}W`}
        </span>
      )}
    </span>
  );
}
