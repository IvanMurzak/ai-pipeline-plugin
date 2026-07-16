/**
 * Pipeline UI — layout shell.
 *
 * State lives in hooks (useProjectState, useSelection). The shell wires
 * those hooks to components and decides what to render in each of the
 * three panels. Side-effects beyond hook orchestration — step-detail
 * loading and per-step stat derivation — also live here because they
 * straddle both hooks' state.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { GitBranch, MessageSquare, Radio, Rocket, ScrollText, Workflow } from "lucide-react";
import { TopBar } from "./components/TopBar";
import { RunList } from "./components/RunList";
import { PipelineTree } from "./components/PipelineTree";
import { PipelineMetaPanel } from "./components/PipelineMetaPanel";
import { SegmentedToggle } from "./components/SegmentedToggle";
import { IterationTree } from "./components/IterationTree";
import { EventStream } from "./components/EventStream";
import { StatsPanel } from "./components/StatsPanel";
import { FailuresPanel } from "./components/FailuresPanel";
import { BreakdownPanel, type BreakdownTab } from "./components/BreakdownPanel";
import { StepDetail } from "./components/StepDetail";
import { ChatPanel } from "./components/ChatPanel";
import { TranscriptsPanel } from "./components/TranscriptsPanel";
import { ScanlineOverlay } from "./components/ScanlineOverlay";
import { ParticleField } from "./components/ParticleField";
import { HudCorners } from "./components/HudFrame";
import { ResizeHandle } from "./components/ResizeHandle";
import { MobileNav, type MobilePane } from "./components/MobileNav";
import { LaunchPanel } from "./components/LaunchPanel";
import { AwaitingInput } from "./components/AwaitingInput";
import { ActiveRunsBar } from "./components/ActiveRunsBar";
import { EditorPanel } from "./components/EditorPanel";
import { RunsOverview } from "./components/RunsOverview";
import { Placeholder } from "./components/Placeholder";
import { CloudConnectCta } from "./components/CloudConnectCta";
import { useDriveRuns } from "./hooks/useDriveRuns";
import { useRunSteps } from "./hooks/useRunSteps";
import { useIsDesktop } from "./lib/useMediaQuery";
import { fetchIteration, stopRun } from "./lib/api";
import {
  applyBasenameAliases,
  buildRunForest,
  flattenRuns,
  isActive,
  iterationStatsByRel,
  iterationToolStatsByRel,
} from "./lib/runs";
import type { IterationToolStats } from "./lib/runs";
import { useProjectState } from "./hooks/useProjectState";
import { useRunStats } from "./hooks/useRunStats";
import { useSelection } from "./hooks/useSelection";
import { useReloadOnRestart } from "./lib/sse";
import type { IterationDetail, RunState, RunSummary, StepTiming } from "./types";

export function App() {
  const project = useProjectState();
  const selection = useSelection();
  // Reload this tab onto the successor's bundle after any daemon handoff
  // (UPDATE button, SessionStart hook, auto-reconcile).
  useReloadOnRestart();
  // Below lg the shell is a single-pane app driven by the bottom nav; on
  // desktop all three panes render side by side and mobilePane is inert.
  const isDesktop = useIsDesktop();
  const [mobilePane, setMobilePane] = useState<MobilePane>("left");
  const {
    projects,
    selectedId,
    setSelectedId,
    state,
    runSummaries,
    chatSessions,
    pluginVersion,
    connection,
  } = project;

  // Reset selection-state when the active project changes. This used to be
  // tangled inside the project-state effect; now it's an explicit dependency.
  useEffect(() => {
    selection.syncOnProjectChange(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Merge live-folded runs (with stats) and server-derived summaries (long
  // history). Rules:
  //   1. A live run that has actually seen pipeline.started (status set
  //      and pipeline_name resolved) wins — it has stats + the latest
  //      streaming state.
  //   2. A live run that's only PARTIAL (status="unknown" because the
  //      pipeline.started event has scrolled out of the 500-event window
  //      but tool.called events remain) is overlaid ON TOP of the server
  //      summary so we keep its stats but adopt the summary's resolved
  //      pipeline_name / status / iteration_count / current_iteration.
  //   3. We collect every run_id that appears anywhere in the live forest
  //      (roots AND blocker children) so a child summary isn't synthesized
  //      as a duplicate top-level row.
  const liveRuns = useMemo(
    () => (state ? buildRunForest(state.events) : []),
    [state],
  );
  const runs = useMemo(() => {
    const liveAll = flattenRuns(liveRuns);
    const liveById = new Map(liveAll.map((r) => [r.run_id, r]));
    const summaryById = new Map(runSummaries.map((s) => [s.run_id, s]));
    const isPartial = (r: RunState) =>
      r.status === "unknown" || r.pipeline_name == null;

    const summaryToRunState = (s: RunSummary): RunState => ({
      ...s,
      // Server summary doesn't carry model fields today — render as "no
      // override set" until the live event window picks them up.
      default_model: null,
      current_resolved_model: null,
      stats: {
        tools_called: 0,
        tools_failed: 0,
        agents_spawned: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      children: [],
    });

    // Overlay a summary onto a live RunState when the live row is partial.
    const overlay = (r: RunState, s: RunSummary): RunState => ({
      ...r,
      pipeline_name: s.pipeline_name ?? r.pipeline_name,
      current_iteration_path: s.current_iteration_path ?? r.current_iteration_path,
      current_iteration_index: s.current_iteration_index ?? r.current_iteration_index,
      iteration_count_completed: Math.max(
        r.iteration_count_completed,
        s.iteration_count_completed,
      ),
      status: s.status,
      halt_reason: s.halt_reason ?? r.halt_reason,
      blocker_issue_url: s.blocker_issue_url ?? r.blocker_issue_url,
      worktree: s.worktree ?? r.worktree,
      started_at: s.started_at,
      last_event_at:
        r.last_event_at > s.last_event_at ? r.last_event_at : s.last_event_at,
    });

    // (a) Walk live roots; if partial AND we have a summary, overlay the
    //     summary's resolved fields onto the live RunState (keeping live
    //     stats + children).
    const mergedRoots: RunState[] = liveRuns.map((r) => {
      const s = summaryById.get(r.run_id);
      return s && isPartial(r) ? overlay(r, s) : r;
    });

    // (b) Determine which summaries are NOT already in the live forest.
    //     These need to either become new top-level rows OR be attached
    //     under a parent that IS in the live forest. Without the parent-
    //     attach step, blocker children whose own events scrolled out of
    //     the 500-event window would silently disappear from the UI.
    const orphans = runSummaries.filter((s) => !liveById.has(s.run_id));
    const orphansByParent = new Map<string, RunSummary[]>();
    const topLevelOrphans: RunSummary[] = [];
    for (const s of orphans) {
      if (s.parent_run_id && liveById.has(s.parent_run_id)) {
        const arr = orphansByParent.get(s.parent_run_id) ?? [];
        arr.push(s);
        orphansByParent.set(s.parent_run_id, arr);
      } else {
        topLevelOrphans.push(s);
      }
    }

    // (c) Attach orphans-with-live-parent under their parent. The parent
    //     may be a root OR a nested child, so walk the merged forest.
    const attachOrphans = (nodes: RunState[]): RunState[] =>
      nodes.map((n) => {
        const extra = orphansByParent.get(n.run_id);
        const children = attachOrphans(n.children);
        if (extra && extra.length) {
          const attached: RunState[] = extra.map(summaryToRunState);
          const merged = [...children, ...attached].sort((a, b) =>
            a.last_event_at < b.last_event_at ? 1 : -1,
          );
          return { ...n, children: merged };
        }
        return children === n.children ? n : { ...n, children };
      });
    const rootsWithOrphanChildren = attachOrphans(mergedRoots);

    // (d) Synthesize remaining top-level orphans — runs whose parent isn't
    //     anywhere in the live forest either.
    const synthesized: RunState[] = topLevelOrphans.map(summaryToRunState);

    return [...rootsWithOrphanChildren, ...synthesized].sort((a, b) =>
      a.last_event_at < b.last_event_at ? 1 : -1,
    );
  }, [liveRuns, runSummaries]);
  const activeCount = useMemo(
    () => runs.filter((r) => isActive(r.status)).length,
    [runs],
  );

  const selectedRun = useMemo(() => {
    if (!runs.length) return null;
    return flattenRuns(runs).find((r) => r.run_id === selection.selectedRunId) ?? null;
  }, [runs, selection.selectedRunId]);

  // Authoritative per-run analytics from /api/run-stats (transcript-folded).
  // The event-folded selectedRun.stats undercounts (hook-event correlation
  // leaks + never sees subagent tokens), so we override the panel with this.
  // A live run re-polls; a terminal run is fetched once.
  const runStatsLive = selectedRun
    ? selectedRun.status !== "completed" && selectedRun.status !== "halted"
    : false;
  const runStats = useRunStats(selectedId, selectedRun?.run_id ?? null, runStatsLive);

  // Per-step wall-clock timings (server fold over the full journal), re-keyed
  // by the iteration tree's rel convention: full rel + unambiguous basename
  // alias — same lookup contract as the other per-step maps.
  const runSteps = useRunSteps(selectedId, selectedRun?.run_id ?? null, runStatsLive);
  const stepTimings = useMemo(() => {
    const out = new Map<string, StepTiming>();
    for (const t of runSteps?.steps ?? []) {
      if (t.rel) out.set(t.rel, t);
    }
    return applyBasenameAliases(out);
  }, [runSteps]);

  const selectedPipeline = useMemo(() => {
    if (!state) return null;
    // Root first: pipeline_name alone is ambiguous (duplicate basenames are
    // legal — same-named targets under two hubs, same name in two category
    // folders), and the tree/editor pickers know the exact root they clicked.
    const pickedRoot = selection.selectedPipelineRoot;
    if (pickedRoot) {
      const norm = pickedRoot.replaceAll("\\", "/").toLowerCase();
      const byRoot = state.pipelines.find(
        (p) => p.pipeline_root.replaceAll("\\", "/").toLowerCase() === norm,
      );
      if (byRoot) return byRoot;
    }
    const name =
      selection.selectedPipelineName ?? selectedRun?.pipeline_name ?? null;
    const byName = name
      ? state.pipelines.find((p) => p.pipeline_name === name) ?? null
      : null;
    if (byName) return byName;
    // Fallback: the run's pipeline_name isn't in the catalog (renamed folder,
    // pre-0.68 daemon without target-family cataloging, …) — resolve by the
    // run's current iteration path against pipeline roots instead. Longest
    // root wins so a family TARGET beats its hub when both prefix-match.
    const cur = selectedRun?.current_iteration_path;
    if (!cur) return null;
    const norm = cur.replaceAll("\\", "/").toLowerCase();
    let best: (typeof state.pipelines)[number] | null = null;
    let bestLen = 0;
    for (const p of state.pipelines) {
      const root = p.pipeline_root.replaceAll("\\", "/").toLowerCase() + "/";
      if (norm.startsWith(root) && root.length > bestLen) {
        best = p;
        bestLen = root.length;
      }
    }
    return best;
  }, [state, selectedRun, selection.selectedPipelineName, selection.selectedPipelineRoot]);

  // Most-recently-observed default_model for the selected pipeline. Walks
  // the live forest (which holds the pipeline.started payload), sorts runs
  // for this pipeline name newest-first, and surfaces the freshest non-null
  // override. Synthesized RunSummary rows force default_model: null (the
  // /api/runs summary doesn't carry the field) so taking [0] blindly hides
  // a default that older live runs captured. Falling through to the next
  // non-null value preserves the user-visible signal across reloads where
  // the live event window scrolled past the original pipeline.started.
  const selectedPipelineDefaultModel = useMemo(() => {
    if (!selectedPipeline) return null;
    const matching = flattenRuns(runs)
      .filter((r) => r.pipeline_name === selectedPipeline.pipeline_name)
      .sort((a, b) => (a.last_event_at < b.last_event_at ? 1 : -1));
    for (const r of matching) {
      if (r.default_model) return r.default_model;
    }
    return null;
  }, [runs, selectedPipeline]);

  const resumableRunIds = useMemo(
    () => new Set(chatSessions.map((s) => s.run_id)),
    [chatSessions],
  );

  // Daemon-launched headless runs (the Launch tab) — needed to overlay the
  // awaiting-input question onto the selected run's board view.
  const { driveRunsById, refresh: refreshDriveRuns } = useDriveRuns(selectedId);
  const selectedDriveRun = selectedRun ? driveRunsById.get(selectedRun.run_id) ?? null : null;

  // Pipeline editor state lives in the selection reducer (selecting a run or
  // pipeline closes it consistently); alias for readability below.
  const editing = selection.editing;

  // --- Step detail (lives here because it depends on both hooks) ---
  const [stepDetail, setStepDetail] = useState<IterationDetail | null>(null);
  const [stepLoading, setStepLoading] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);

  // Failure drill-down (the FAIL analytics tile). Closed on run switch.
  const [failuresOpen, setFailuresOpen] = useState(false);
  // TOOLS/AGENTS drill-down (the other two clickable tiles).
  const [breakdownTab, setBreakdownTab] = useState<BreakdownTab | null>(null);
  useEffect(() => {
    setFailuresOpen(false);
    setBreakdownTab(null);
  }, [selectedRun?.run_id]);

  // --- Right-column width (resizable). Persisted across reloads so the
  // user's layout sticks. Clamped on every change in case the viewport
  // got smaller between sessions. ---
  const RIGHT_MIN = 300;
  const RIGHT_MAX = 720;
  const [rightWidth, setRightWidth] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem("pipeline-ui-right-width"));
      if (Number.isFinite(stored) && stored >= RIGHT_MIN && stored <= RIGHT_MAX) {
        return stored;
      }
    } catch {
      /* ignore */
    }
    return 380;
  });
  useEffect(() => {
    try {
      localStorage.setItem("pipeline-ui-right-width", String(rightWidth));
    } catch {
      /* ignore */
    }
  }, [rightWidth]);
  const onResizeRight = useCallback((dx: number) => {
    // Drag handle sits on the LEFT edge of the right column: dragging
    // left (dx < 0) widens the column; right narrows it.
    setRightWidth((w) => {
      const next = w - dx;
      if (next < RIGHT_MIN) return RIGHT_MIN;
      if (next > RIGHT_MAX) return RIGHT_MAX;
      return next;
    });
  }, []);

  // --- Left-column width (resizable, persisted) — same pattern, its handle
  // sits on the column's RIGHT edge so dragging right widens it. ---
  const LEFT_MIN = 260;
  const LEFT_MAX = 560;
  const [leftWidth, setLeftWidth] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem("pipeline-ui-left-width"));
      if (Number.isFinite(stored) && stored >= LEFT_MIN && stored <= LEFT_MAX) return stored;
    } catch {
      /* ignore */
    }
    return 340;
  });
  useEffect(() => {
    try {
      localStorage.setItem("pipeline-ui-left-width", String(leftWidth));
    } catch {
      /* ignore */
    }
  }, [leftWidth]);
  const onResizeLeft = useCallback((dx: number) => {
    setLeftWidth((w) => {
      const next = w + dx;
      if (next < LEFT_MIN) return LEFT_MIN;
      if (next > LEFT_MAX) return LEFT_MAX;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!selection.selectedStepRel || !selectedPipeline || !selectedId) {
      setStepDetail(null);
      setStepError(null);
      setStepLoading(false);
      return;
    }
    let cancelled = false;
    setStepLoading(true);
    setStepError(null);
    // A family TARGET's shared steps live in the HUB's steps/ — fetch them
    // under the hub. Own steps (incl. same-basename overrides, which the
    // tree dedupes in favor of the target) resolve locally. The root travels
    // with the request so duplicate basenames can't resolve to the wrong
    // pipeline server-side.
    const rel = selection.selectedStepRel;
    const fromHub =
      !selectedPipeline.iterations.includes(rel) &&
      (selectedPipeline.shared_iterations ?? []).includes(rel) &&
      selectedPipeline.family_hub != null;
    fetchIteration(
      selectedId,
      fromHub
        ? selectedPipeline.family_hub!.pipeline_name
        : selectedPipeline.pipeline_name,
      rel,
      fromHub ? selectedPipeline.family_hub!.pipeline_root : selectedPipeline.pipeline_root,
    )
      .then((d) => {
        if (cancelled) return;
        setStepDetail(d);
        setStepLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setStepError(`Couldn't load this step: ${String(e?.message ?? e)}`);
        setStepDetail(null);
        setStepLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selection.selectedStepRel, selectedPipeline, selectedId]);

  const stepStats = useMemo(() => {
    if (!state || !selectedPipeline) return new Map();
    return iterationStatsByRel(
      state.events,
      selectedPipeline.pipeline_name,
      selectedPipeline.family_hub?.pipeline_name,
      selectedPipeline.iterations,
    );
  }, [state, selectedPipeline]);

  const selectedStepStats = useMemo(() => {
    const rel = selection.selectedStepRel;
    if (!rel) return null;
    const tail = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
    return stepStats.get(tail) ?? stepStats.get(rel) ?? null;
  }, [stepStats, selection.selectedStepRel]);

  // Per-step TOOL/TOKEN stats for the selected run, keyed by the iteration
  // tree's rel path. Sourced from the step_id-aware overlap-safe fold
  // (iterationToolStatsForRun via iterationToolStatsByRel), so a PARALLEL run
  // attributes each overlapping step's tools/tokens correctly while a
  // SEQUENTIAL run uses the legacy window. Empty when no run is selected.
  // Computed once per (events, run, pipeline) and threaded down to the tree
  // rather than recomputed per row.
  const stepToolStats = useMemo(() => {
    if (!state || !selectedRun || !selectedPipeline) {
      return new Map<string, IterationToolStats>();
    }
    return iterationToolStatsByRel(
      state.events,
      selectedRun.run_id,
      selectedPipeline.pipeline_name,
      selectedPipeline.family_hub?.pipeline_name,
      selectedPipeline.iterations,
    );
  }, [state, selectedRun, selectedPipeline]);

  const selectedStepToolStats = useMemo(() => {
    const rel = selection.selectedStepRel;
    if (!rel) return null;
    const tail = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
    return stepToolStats.get(tail) ?? stepToolStats.get(rel) ?? null;
  }, [stepToolStats, selection.selectedStepRel]);

  // Stable handlers — useCallback because they cross hook boundaries.
  const handleResumeRun = useCallback(
    (runId: string) => selection.startResume(runId),
    [selection],
  );

  const handleStopRun = useCallback(
    (runId: string) => {
      if (!selectedId) return;
      // Kills the daemon-launched drive child when one exists, and appends the
      // synthetic pipeline.halted in every case (covers stale/dead runs). The
      // run leaves Active when the halt broadcasts over SSE; refreshSummaries()
      // covers the server-derived Recent view regardless of SSE timing.
      void stopRun(selectedId, runId)
        .then(() => project.refreshSummaries())
        .catch(() => project.refreshSummaries());
    },
    [selectedId, project],
  );

  // On mobile, picking something in the left pane should land you on the
  // board — otherwise every selection needs a manual tab switch.
  const selectRunMobile = useCallback(
    (runId: string) => {
      selection.selectRun(runId);
      if (!isDesktop) setMobilePane("middle");
    },
    [selection, isDesktop],
  );
  const selectPipelineMobile = useCallback(
    (name: string, root?: string | null) => {
      selection.selectPipeline(name, root);
      if (!isDesktop) setMobilePane("middle");
    },
    [selection, isDesktop],
  );

  const paneClass = (pane: MobilePane) =>
    `${mobilePane === pane ? "flex" : "hidden"} min-h-0 flex-1 flex-col lg:flex lg:max-h-[calc(100vh-96px)]`;

  return (
    <div className="relative min-h-screen text-ink">
      <div className="accent-wash" aria-hidden />
      {/* Canvas decor is desktop-only: a hidden canvas still burns frames on
          a phone battery, so it isn't rendered at all below lg. */}
      {isDesktop && <ParticleField />}
      {isDesktop && <ScanlineOverlay />}
      <div className="relative z-10 flex min-h-screen flex-col">
        <TopBar
          projects={projects}
          selectedId={selectedId}
          onSelect={setSelectedId}
          connection={connection}
          pluginVersion={pluginVersion}
        />

        <ActiveRunsBar
          runs={runs}
          selectedRunId={selectedRun?.run_id ?? null}
          driveRunsById={driveRunsById}
          onSelect={selectRunMobile}
          onOverview={() => {
            selection.clearSelection();
            if (!isDesktop) setMobilePane("middle");
          }}
        />

        <AnimatePresence mode="wait">
          <motion.main
            key={selectedId ?? "empty"}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25 }}
            style={{ "--right-col": `${rightWidth}px`, "--left-col": `${leftWidth}px` } as React.CSSProperties}
            className="flex flex-1 flex-col gap-4 px-3 pb-24 pt-1 sm:px-4 lg:grid lg:grid-cols-[var(--left-col)_minmax(0,1fr)_var(--right-col)] lg:px-6 lg:pb-6 lg:pt-0"
          >
            <section className={`relative ${paneClass("left")} gap-3`}>
              <ResizeHandle side="right" onResize={onResizeLeft} ariaLabel="Resize runs / pipelines panel" />
              <SegmentedToggle
                value={selection.leftTab}
                onChange={selection.setLeftTab}
                segments={[
                  {
                    value: "runs",
                    label: (
                      <span className="flex items-center gap-1.5">
                        <GitBranch size={12} /> Runs
                      </span>
                    ),
                    count: activeCount > 0 ? activeCount : runs.length,
                  },
                  {
                    value: "pipelines",
                    label: (
                      <span className="flex items-center gap-1.5">
                        <Workflow size={12} /> Pipelines
                      </span>
                    ),
                    count: state?.pipelines.length,
                  },
                ]}
              />

              <div className="min-h-0 flex-1 overflow-hidden">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={selection.leftTab}
                    initial={{ opacity: 0, x: selection.leftTab === "runs" ? -8 : 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: selection.leftTab === "runs" ? 8 : -8 }}
                    transition={{ duration: 0.18 }}
                    className="h-full"
                  >
                    {selection.leftTab === "runs" ? (
                      <RunList
                        runs={runs}
                        pipelines={state?.pipelines ?? []}
                        selectedRunId={selectedRun?.run_id ?? null}
                        resumableRunIds={resumableRunIds}
                        onSelect={selectRunMobile}
                        onResume={handleResumeRun}
                        onStop={handleStopRun}
                      />
                    ) : (
                      <PipelineTree
                        pipelines={state?.pipelines ?? []}
                        runs={runs}
                        selectedPipelineRoot={selectedPipeline?.pipeline_root ?? null}
                        onSelect={selectPipelineMobile}
                        onLaunch={(name, root) => {
                          selection.selectPipeline(name, root);
                          selection.setRightTab("launch");
                          if (!isDesktop) setMobilePane("right");
                        }}
                        onEdit={(name, root) => {
                          selection.openEditor(name, root);
                          if (!isDesktop) setMobilePane("middle");
                        }}
                      />
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
            </section>

            <section className={`${paneClass("middle")} gap-4`}>
              {editing && selectedId ? (
                <EditorPanel
                  projectId={selectedId}
                  pipelineName={editing.name}
                  pipelineRoot={editing.root}
                  onClose={selection.closeEditor}
                />
              ) : !selectedRun && !selectedPipeline && selectedId ? (
                <RunsOverview
                  projectId={selectedId}
                  runs={runs}
                  driveRunsById={driveRunsById}
                  onSelect={selectRunMobile}
                  onStop={handleStopRun}
                  onLaunchClick={() => {
                    selection.setRightTab("launch");
                    if (!isDesktop) setMobilePane("right");
                  }}
                  onAnswered={refreshDriveRuns}
                />
              ) : (
                <>
              <div className="min-h-0 flex-1">
                <IterationTree
                  pipeline={selectedPipeline}
                  activeRun={selectedRun}
                  iterationStats={stepStats}
                  iterationToolStats={stepToolStats}
                  stepTimings={selectedRun ? stepTimings : undefined}
                  selectedRel={selection.selectedStepRel}
                  onSelectStep={selection.toggleStep}
                />
              </div>
              {selectedDriveRun?.status === "awaiting-input" && selectedId && (
                <AwaitingInput
                  projectId={selectedId}
                  run={selectedDriveRun}
                  onAnswered={refreshDriveRuns}
                />
              )}
              <AnimatePresence mode="wait">
                {selection.selectedStepRel ? (
                  <StepDetail
                    key="step"
                    loading={stepLoading}
                    detail={stepDetail}
                    error={stepError}
                    stats={selectedStepStats}
                    toolStats={selectedStepToolStats}
                    onClose={selection.clearStep}
                  />
                ) : selectedRun ? (
                  <motion.div
                    key="stats"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 6 }}
                    transition={{ duration: 0.18 }}
                  >
                    <StatsPanel
                      run={selectedRun}
                      statsOverride={runStats}
                      onShowFailures={() => setFailuresOpen(true)}
                      onShowBreakdown={setBreakdownTab}
                    />
                  </motion.div>
                ) : selectedPipeline ? (
                  <PipelineMetaPanel
                    pipeline={selectedPipeline}
                    onLaunch={() => {
                      selection.setRightTab("launch");
                      if (!isDesktop) setMobilePane("right");
                    }}
                    onEdit={() =>
                      selection.openEditor(selectedPipeline.pipeline_name, selectedPipeline.pipeline_root)
                    }
                    defaultModel={selectedPipelineDefaultModel}
                  />
                ) : null}
              </AnimatePresence>
                </>
              )}
            </section>

            <section className={`relative ${paneClass("right")} gap-3`}>
              <ResizeHandle onResize={onResizeRight} ariaLabel="Resize chat / transcripts panel" />
              <SegmentedToggle
                value={selection.rightTab}
                onChange={selection.setRightTab}
                segments={[
                  {
                    value: "events",
                    label: (
                      <span className="flex items-center gap-1.5">
                        <Radio size={12} /> Events
                      </span>
                    ),
                    count: state?.events.length,
                  },
                  {
                    value: "launch",
                    label: (
                      <span className="flex items-center gap-1.5">
                        <Rocket size={12} /> Launch
                      </span>
                    ),
                  },
                  {
                    value: "chat",
                    label: (
                      <span className="flex items-center gap-1.5">
                        <MessageSquare size={12} /> Chat
                      </span>
                    ),
                  },
                  {
                    value: "transcripts",
                    label: (
                      <span className="flex items-center gap-1.5">
                        <ScrollText size={12} /> Transcripts
                      </span>
                    ),
                  },
                ]}
              />
              <div className="min-h-0 flex-1 overflow-hidden">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={selection.rightTab}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.18 }}
                    className="h-full"
                  >
                    {selection.rightTab === "events" ? (
                      <EventStream
                        events={state?.events ?? []}
                        filterRunId={selectedRun?.run_id ?? null}
                      />
                    ) : selection.rightTab === "launch" ? (
                      selectedId ? (
                        <LaunchPanel
                          projectId={selectedId}
                          initialPipelineName={selectedPipeline?.pipeline_name ?? null}
                          initialPipelineRoot={selectedPipeline?.pipeline_root ?? null}
                          onLaunched={(runId) => {
                            selection.selectRun(runId);
                            project.refreshSummaries();
                            if (!isDesktop) setMobilePane("middle");
                          }}
                        />
                      ) : (
                        <Placeholder>Pick a project to launch a pipeline.</Placeholder>
                      )
                    ) : selection.rightTab === "transcripts" ? (
                      selectedId ? (
                        <TranscriptsPanel projectId={selectedId} />
                      ) : (
                        <Placeholder>Pick a project to browse Claude Code session transcripts.</Placeholder>
                      )
                    ) : selectedId ? (
                      <ChatPanel
                        projectId={selectedId}
                        pipelineName={selectedPipeline?.pipeline_name ?? null}
                        viewRunId={
                          selectedRun && resumableRunIds.has(selectedRun.run_id)
                            ? selectedRun.run_id
                            : null
                        }
                        resumeRunId={selection.resumeRunId}
                        onResumeHandled={selection.resumeHandled}
                        onSessionLinked={() => {
                          // Refetch the resumable-chat-sessions list so the
                          // freshly-linked run picks up its Resume affordance
                          // immediately. refreshSummaries() only refreshes
                          // /api/runs which doesn't drive resumableRunIds.
                          project.refreshChatSessions();
                          project.refreshSummaries();
                        }}
                        onClose={() => selection.setRightTab("events")}
                      />
                    ) : (
                      <Placeholder>Pick a project to start a chat.</Placeholder>
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
            </section>
          </motion.main>
        </AnimatePresence>

        <MobileNav value={mobilePane} onChange={setMobilePane} activeCount={activeCount} />

        {/* Connection-state detection has no dashboard data seam yet (no
            `.claude/pipeline/cloud.json` field on ProjectEntry/ProjectState),
            so `connected` is intentionally left unset — the CTA always
            renders its static invite face. See cloudConnect.ts's module doc
            for the flagged follow-up. Gated on having at least one known
            project so it doesn't show over the empty-state screen. */}
        {projects.length > 0 && <CloudConnectCta />}

        {failuresOpen && selectedId && selectedRun && (
          <FailuresPanel
            projectId={selectedId}
            runId={selectedRun.run_id}
            steps={runSteps?.steps}
            onClose={() => setFailuresOpen(false)}
          />
        )}

        {breakdownTab && selectedId && selectedRun && (
          <BreakdownPanel
            projectId={selectedId}
            runId={selectedRun.run_id}
            initialTab={breakdownTab}
            onClose={() => setBreakdownTab(null)}
          />
        )}

        {!selectedId && projects.length === 0 && <EmptyState />}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.3 }}
      className="pointer-events-none fixed inset-0 z-10 flex items-center justify-center"
    >
      <div className="surface mx-6 max-w-md p-8 text-center text-accent">
        <HudCorners />
        <h2 className="font-display text-base font-bold uppercase tracking-[0.2em] text-gradient-cyber">
          NO_PROJECTS_REGISTERED
        </h2>
        <p className="mt-3 text-xs text-muted">
          Open any project that uses the <code className="text-accent">pipeline</code> plugin
          and run{" "}
          <code className="bg-panel2 px-1.5 py-0.5 font-mono text-accent">/pipeline:run</code>.
          It will appear here automatically — no per-project setup required.
        </p>
      </div>
    </motion.div>
  );
}
