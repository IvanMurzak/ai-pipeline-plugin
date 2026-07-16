/**
 * Selection state — what's the user currently looking at?
 *
 * One reducer instead of 6+ useState calls in App.tsx. The reducer enforces
 * the invariants that were previously implicit (e.g. selecting a run clears
 * the pipeline pick AND any selected step). When we change all three in one
 * dispatch, intermediate renders can't show inconsistent state.
 */

import { useCallback, useEffect, useReducer } from "react";

const LAST_LEFT_TAB_KEY = "pipeline-ui-left-tab";
const LAST_RIGHT_TAB_KEY = "pipeline-ui-right-tab";

export type LeftTab = "runs" | "pipelines";
export type RightTab = "events" | "launch" | "chat" | "transcripts";

export interface SelectionState {
  leftTab: LeftTab;
  rightTab: RightTab;
  selectedRunId: string | null;
  selectedPipelineName: string | null;
  /** The picked pipeline's root, when the picker knew it (PipelineTree rows,
   *  the editor). pipeline_name alone is ambiguous — duplicate basenames are
   *  legal (same-named targets under two hubs, same-named pipelines in two
   *  categories) — so resolution prefers the root when present. */
  selectedPipelineRoot: string | null;
  selectedStepRel: string | null;
  resumeRunId: string | null;
  /** The pipeline whose files the editor is showing (takes over the middle
   *  pane). Lives in the reducer so run/pipeline selection consistently
   *  closes it — an App-local useState let a run click leave the editor
   *  covering the board. */
  editing: { name: string; root: string } | null;
}

type Action =
  | { type: "selectRun"; runId: string }
  | { type: "selectPipeline"; name: string; root?: string | null }
  | { type: "toggleStep"; rel: string }
  | { type: "clearStep" }
  | { type: "setLeftTab"; tab: LeftTab }
  | { type: "setRightTab"; tab: RightTab }
  | { type: "startResume"; runId: string }
  | { type: "resumeHandled" }
  | { type: "clearSelection" }
  | { type: "openEditor"; name: string; root: string }
  | { type: "closeEditor" }
  | { type: "projectChanged" };

function reducer(s: SelectionState, a: Action): SelectionState {
  switch (a.type) {
    case "selectRun":
      // Picking a run takes over the middle panel; clear pipeline pick, step
      // AND the editor so the panel reflects that run — not stale picks.
      return {
        ...s,
        selectedRunId: a.runId,
        selectedPipelineName: null,
        selectedPipelineRoot: null,
        selectedStepRel: null,
        editing: null,
      };
    case "selectPipeline":
      return {
        ...s,
        selectedPipelineName: a.name,
        selectedPipelineRoot: a.root ?? null,
        selectedRunId: null,
        selectedStepRel: null,
        editing: null,
      };
    case "toggleStep":
      return {
        ...s,
        selectedStepRel: s.selectedStepRel === a.rel ? null : a.rel,
      };
    case "clearStep":
      return { ...s, selectedStepRel: null };
    case "setLeftTab":
      return { ...s, leftTab: a.tab };
    case "setRightTab":
      return { ...s, rightTab: a.tab };
    case "startResume":
      return {
        ...s,
        selectedRunId: a.runId,
        selectedPipelineName: null,
        selectedPipelineRoot: null,
        rightTab: "chat",
        resumeRunId: a.runId,
      };
    case "resumeHandled":
      return { ...s, resumeRunId: null };
    case "clearSelection":
      // Back to the overview board: nothing selected in the middle pane.
      return {
        ...s,
        selectedRunId: null,
        selectedPipelineName: null,
        selectedPipelineRoot: null,
        selectedStepRel: null,
        editing: null,
      };
    case "openEditor":
      // Editing a pipeline selects it too (the board context follows).
      return {
        ...s,
        editing: { name: a.name, root: a.root },
        selectedPipelineName: a.name,
        selectedPipelineRoot: a.root,
        selectedRunId: null,
        selectedStepRel: null,
      };
    case "closeEditor":
      return { ...s, editing: null };
    case "projectChanged":
      // A different project's runs/pipelines are unrelated — reset.
      return {
        ...s,
        selectedRunId: null,
        selectedPipelineName: null,
        selectedPipelineRoot: null,
        selectedStepRel: null,
        resumeRunId: null,
        editing: null,
      };
  }
}

function initial(): SelectionState {
  return {
    leftTab:
      (localStorage.getItem(LAST_LEFT_TAB_KEY) as LeftTab | null) ?? "runs",
    rightTab:
      (localStorage.getItem(LAST_RIGHT_TAB_KEY) as RightTab | null) ?? "events",
    selectedRunId: null,
    selectedPipelineName: null,
    selectedPipelineRoot: null,
    selectedStepRel: null,
    resumeRunId: null,
    editing: null,
  };
}

export interface UseSelectionResult extends SelectionState {
  selectRun: (runId: string) => void;
  selectPipeline: (name: string, root?: string | null) => void;
  toggleStep: (rel: string) => void;
  clearStep: () => void;
  setLeftTab: (tab: LeftTab) => void;
  setRightTab: (tab: RightTab) => void;
  startResume: (runId: string) => void;
  resumeHandled: () => void;
  clearSelection: () => void;
  openEditor: (name: string, root: string) => void;
  closeEditor: () => void;
  /** Caller passes the current selectedId from useProjectState; this hook
   *  resets selections whenever it changes. */
  syncOnProjectChange: (projectId: string | null) => void;
}

export function useSelection(): UseSelectionResult {
  const [s, dispatch] = useReducer(reducer, undefined, initial);

  // Persist tab choices.
  useEffect(() => {
    localStorage.setItem(LAST_LEFT_TAB_KEY, s.leftTab);
  }, [s.leftTab]);
  useEffect(() => {
    localStorage.setItem(LAST_RIGHT_TAB_KEY, s.rightTab);
  }, [s.rightTab]);

  return {
    ...s,
    selectRun: useCallback((runId: string) => dispatch({ type: "selectRun", runId }), []),
    selectPipeline: useCallback(
      (name: string, root?: string | null) => dispatch({ type: "selectPipeline", name, root }),
      [],
    ),
    toggleStep: useCallback((rel: string) => dispatch({ type: "toggleStep", rel }), []),
    clearStep: useCallback(() => dispatch({ type: "clearStep" }), []),
    setLeftTab: useCallback((tab: LeftTab) => dispatch({ type: "setLeftTab", tab }), []),
    setRightTab: useCallback((tab: RightTab) => dispatch({ type: "setRightTab", tab }), []),
    startResume: useCallback((runId: string) => dispatch({ type: "startResume", runId }), []),
    resumeHandled: useCallback(() => dispatch({ type: "resumeHandled" }), []),
    clearSelection: useCallback(() => dispatch({ type: "clearSelection" }), []),
    openEditor: useCallback((name: string, root: string) => dispatch({ type: "openEditor", name, root }), []),
    closeEditor: useCallback(() => dispatch({ type: "closeEditor" }), []),
    syncOnProjectChange: useCallback((_projectId: string | null) => {
      dispatch({ type: "projectChanged" });
    }, []),
  };
}
