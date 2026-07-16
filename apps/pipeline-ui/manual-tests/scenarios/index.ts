/**
 * Scenarios — one async fn per bug we want to reproduce / verify.
 *
 * Each returns true on success, false on failure. They share the `Harness`
 * instance so the daemon doesn't get re-spawned per scenario.
 *
 * Cost: $0 — no Claude tokens used. The Haiku scenario lives in
 * scenarios/haiku-smoke.ts and is opt-in.
 */

import { Harness, expect, expectEq, rid } from "../harness.ts";
import {
  chatMessagesRotationFolding,
  worktreeEndToEnd,
} from "./deep.ts";
import {
  modelInvalidFallsThrough,
  modelPipelineDefault,
  modelStepOverrideWins,
} from "./model.ts";

export type Scenario = {
  name: string;
  description: string;
  run: (h: Harness) => Promise<boolean>;
};

// ---------------------------------------------------------------------
// 2.3a — terminal=true (v2) flips status to completed without pipeline.completed
// ---------------------------------------------------------------------

export const terminalFlagV2: Scenario = {
  name: "terminal-flag-v2",
  description:
    "Schema v2 iteration.completed { terminal: true } makes status=completed even when pipeline.completed is never emitted",
  async run(h) {
    const proj = await h.tempProject("terminal-v2");
    const runId = rid("term2");
    h.emitEvent(proj, "pipeline.started", runId, {
      pipeline_name: "test-pipeline",
      first_iteration_path: "01-hello.md",
    });
    h.emitIteration(proj, runId, 1, "01-hello.md", { next: "02-world.md" });
    h.emitIteration(proj, runId, 2, "02-world.md", { next: "03-done.md" });
    // Last iteration — emit terminal:true but NOT pipeline.completed.
    h.emitIteration(proj, runId, 3, "03-done.md", { next: null, terminal: true });

    const runs = await h.getRuns(proj.project_id);
    const r = runs.find((x) => x.run_id === runId);
    if (!r) {
      console.log("    ✗ run not found");
      return false;
    }
    let ok = true;
    ok = expectEq("status is completed", r.status, "completed") && ok;
    ok = expectEq("iteration_count_completed is 3", r.iteration_count_completed, 3) && ok;
    ok = expect(
      "current_iteration_path points at step 03",
      (r.current_iteration_path ?? "").endsWith("03-done.md"),
    ) && ok;
    return ok;
  },
};

// ---------------------------------------------------------------------
// 2.3b — schema v1 back-compat: no terminal field, next=null → completed
// ---------------------------------------------------------------------

export const terminalFlagV1Compat: Scenario = {
  name: "terminal-flag-v1-compat",
  description:
    "Legacy schema=1 events without a terminal field still derive completed status from next_iteration_path=null",
  async run(h) {
    const proj = await h.tempProject("terminal-v1");
    const runId = rid("term1");
    h.emitV1Event(proj, "pipeline.started", runId, {
      pipeline_name: "test-pipeline",
      first_iteration_path: "01-hello.md",
    });
    h.emitV1Event(proj, "iteration.started", runId, {
      iteration_path: "01-hello.md",
      index: 1,
    });
    // v1 iteration.completed with NO terminal field, next null
    h.emitV1Event(proj, "iteration.completed", runId, {
      iteration_path: "01-hello.md",
      outcome: "completed",
      next_iteration_path: null,
      has_improvement_brief: false,
      has_blocker_delegation: false,
      halt_reason: null,
    });

    const runs = await h.getRuns(proj.project_id);
    const r = runs.find((x) => x.run_id === runId);
    if (!r) {
      console.log("    ✗ run not found");
      return false;
    }
    return expectEq("v1 single-step run derived completed", r.status, "completed");
  },
};

// ---------------------------------------------------------------------
// 2.2 — current step does NOT get stuck across many tool.called events
// ---------------------------------------------------------------------

export const currentStepTracking: Scenario = {
  name: "current-step-tracking",
  description:
    "Even when hundreds of tool.called events stream between iteration.started events, the run summary advances current_iteration_path to the latest step",
  async run(h) {
    const proj = await h.tempProject("step-tracking");
    const runId = rid("step");
    h.emitEvent(proj, "pipeline.started", runId, {
      pipeline_name: "test-pipeline",
      first_iteration_path: "01-hello.md",
    });
    // iter 1 starts
    h.emitEvent(proj, "iteration.started", runId, {
      iteration_path:
        proj.project_root + "/.claude/pipeline/test-pipeline/steps/01-hello.md",
      index: 1,
    });
    h.emitToolBurst(proj, runId, 300);
    h.emitEvent(proj, "iteration.completed", runId, {
      iteration_path:
        proj.project_root + "/.claude/pipeline/test-pipeline/steps/01-hello.md",
      outcome: "completed",
      next_iteration_path:
        proj.project_root + "/.claude/pipeline/test-pipeline/steps/02-world.md",
      has_improvement_brief: false,
      has_blocker_delegation: false,
      halt_reason: null,
      terminal: false,
    });
    // iter 2 + tool noise
    h.emitEvent(proj, "iteration.started", runId, {
      iteration_path:
        proj.project_root + "/.claude/pipeline/test-pipeline/steps/02-world.md",
      index: 2,
    });
    h.emitToolBurst(proj, runId, 300);
    h.emitEvent(proj, "iteration.completed", runId, {
      iteration_path:
        proj.project_root + "/.claude/pipeline/test-pipeline/steps/02-world.md",
      outcome: "completed",
      next_iteration_path:
        proj.project_root + "/.claude/pipeline/test-pipeline/steps/03-done.md",
      has_improvement_brief: false,
      has_blocker_delegation: false,
      halt_reason: null,
      terminal: false,
    });
    // iter 3 starts but does NOT complete — should show as current
    h.emitEvent(proj, "iteration.started", runId, {
      iteration_path:
        proj.project_root + "/.claude/pipeline/test-pipeline/steps/03-done.md",
      index: 3,
    });
    h.emitToolBurst(proj, runId, 50);

    const runs = await h.getRuns(proj.project_id);
    const r = runs.find((x) => x.run_id === runId);
    if (!r) return expect("run found", false);
    let ok = true;
    ok = expectEq("status running (no terminal yet)", r.status, "running") && ok;
    ok = expectEq("two iterations completed", r.iteration_count_completed, 2) && ok;
    ok = expect(
      "current_iteration_path is step 03 (not stuck on 01)",
      (r.current_iteration_path ?? "").endsWith("03-done.md"),
    ) && ok;
    return ok;
  },
};

// ---------------------------------------------------------------------
// 2.1 — history persistence: events beyond the live 500-event window
// still appear in /api/runs (server fold reads the full journal)
// ---------------------------------------------------------------------

export const historyPersistence: Scenario = {
  name: "history-persistence",
  description:
    "After 700+ events, all completed runs from earlier in the journal still appear in /api/runs",
  async run(h) {
    const proj = await h.tempProject("history");
    // Three completed runs first.
    const ids = [rid("r1"), rid("r2"), rid("r3")];
    for (const id of ids) {
      h.emitEvent(proj, "pipeline.started", id, { pipeline_name: "test-pipeline" });
      h.emitIteration(proj, id, 1, "01-hello.md", { next: null, terminal: true });
    }
    // Now flood the journal with noise so the live 500-event window has
    // pushed the early pipeline.started events out.
    const noiseId = rid("noise");
    h.emitEvent(proj, "pipeline.started", noiseId, { pipeline_name: "test-pipeline" });
    h.emitToolBurst(proj, noiseId, 700);

    const runs = await h.getRuns(proj.project_id, 200);
    const ids2 = new Set(runs.map((r) => r.run_id));
    let ok = true;
    for (const id of ids) {
      ok = expect(`run ${id.slice(0, 12)} still in /api/runs`, ids2.has(id)) && ok;
    }
    const r1 = runs.find((r) => r.run_id === ids[0]);
    ok = expectEq("earliest run still has correct status", r1?.status, "completed") && ok;
    return ok;
  },
};

// ---------------------------------------------------------------------
// 2.4-related — multiple concurrent runs of same pipeline: distinguishable
// ---------------------------------------------------------------------

export const multipleInstances: Scenario = {
  name: "multiple-instances-same-pipeline",
  description:
    "Two interleaved running instances of the same pipeline come back as two distinct rows with independent state",
  async run(h) {
    const proj = await h.tempProject("multi");
    const a = rid("ra");
    const b = rid("rb");
    // Both pipelines start
    h.emitEvent(proj, "pipeline.started", a, { pipeline_name: "test-pipeline" });
    h.emitEvent(proj, "pipeline.started", b, { pipeline_name: "test-pipeline" });
    // Interleave their progress
    h.emitIteration(proj, a, 1, "01-hello.md", { next: "02-world.md" });
    h.emitIteration(proj, b, 1, "01-hello.md", { next: "02-world.md" });
    h.emitIteration(proj, a, 2, "02-world.md", { next: "03-done.md" });
    // a is now mid step 03; b is mid step 02
    h.emitEvent(proj, "iteration.started", a, {
      iteration_path:
        proj.project_root + "/.claude/pipeline/test-pipeline/steps/03-done.md",
      index: 3,
    });
    h.emitEvent(proj, "iteration.started", b, {
      iteration_path:
        proj.project_root + "/.claude/pipeline/test-pipeline/steps/02-world.md",
      index: 2,
    });
    // Finish a, leave b running
    h.emitEvent(proj, "iteration.completed", a, {
      iteration_path:
        proj.project_root + "/.claude/pipeline/test-pipeline/steps/03-done.md",
      outcome: "completed",
      next_iteration_path: null,
      terminal: true,
      has_improvement_brief: false,
      has_blocker_delegation: false,
      halt_reason: null,
    });

    const runs = await h.getRuns(proj.project_id);
    const ra = runs.find((r) => r.run_id === a);
    const rb = runs.find((r) => r.run_id === b);
    let ok = true;
    ok = expectEq("run A status", ra?.status, "completed") && ok;
    ok = expectEq("run B status", rb?.status, "running") && ok;
    ok = expect(
      "run A current step is 03",
      (ra?.current_iteration_path ?? "").endsWith("03-done.md"),
    ) && ok;
    ok = expect(
      "run B current step is 02",
      (rb?.current_iteration_path ?? "").endsWith("02-world.md"),
    ) && ok;
    ok = expectEq("A completed 3 iterations", ra?.iteration_count_completed, 3) && ok;
    ok = expectEq("B completed 1 iteration", rb?.iteration_count_completed, 1) && ok;
    return ok;
  },
};

// ---------------------------------------------------------------------
// worktree threading — event with worktree set surfaces in summary
// ---------------------------------------------------------------------

export const worktreeThreading: Scenario = {
  name: "worktree-threading",
  description:
    "Events that carry a worktree= field survive through summarizeRuns and appear on the run summary",
  async run(h) {
    const proj = await h.tempProject("worktree");
    const runId = rid("wt");
    const wt = "/tmp/some-worktree-path";
    h.emitEvent(
      proj,
      "pipeline.started",
      runId,
      { pipeline_name: "test-pipeline" },
      { worktree: wt },
    );
    h.emitEvent(
      proj,
      "iteration.started",
      runId,
      {
        iteration_path:
          proj.project_root + "/.claude/pipeline/test-pipeline/steps/01-hello.md",
        index: 1,
      },
      { worktree: wt },
    );

    const runs = await h.getRuns(proj.project_id);
    const r = runs.find((x) => x.run_id === runId);
    return expectEq("run summary carries worktree", r?.worktree, wt);
  },
};

// ---------------------------------------------------------------------
// iteration.resumed — does NOT bump started_count; flips status to running
// ---------------------------------------------------------------------

export const iterationResumed: Scenario = {
  name: "iteration-resumed-not-double-counted",
  description:
    "iteration.resumed flips a halted run back to running without inflating per-iteration started_count",
  async run(h) {
    const proj = await h.tempProject("resume");
    const runId = rid("res");
    const iterAbs =
      proj.project_root + "/.claude/pipeline/test-pipeline/steps/01-hello.md";
    h.emitEvent(proj, "pipeline.started", runId, { pipeline_name: "test-pipeline" });
    h.emitEvent(proj, "iteration.started", runId, { iteration_path: iterAbs, index: 1 });
    h.emitEvent(proj, "iteration.completed", runId, {
      iteration_path: iterAbs,
      outcome: "halted",
      halt_reason: "test",
      next_iteration_path: null,
      terminal: true,
      has_improvement_brief: false,
      has_blocker_delegation: false,
    });

    let runs = await h.getRuns(proj.project_id);
    let r = runs.find((x) => x.run_id === runId);
    let ok = true;
    ok = expectEq("starts halted", r?.status, "halted") && ok;
    ok = expectEq("halt_reason recorded", r?.halt_reason, "test") && ok;

    // Now emit iteration.resumed (what /api/chat/resume produces)
    h.emitEvent(proj, "iteration.resumed", runId, { iteration_path: iterAbs, index: 1 });
    runs = await h.getRuns(proj.project_id);
    r = runs.find((x) => x.run_id === runId);
    ok = expectEq("flipped back to running", r?.status, "running") && ok;
    return ok;
  },
};

// ---------------------------------------------------------------------
// halted-on-iteration scenario — halt reason surfaces correctly
// ---------------------------------------------------------------------

export const haltedRun: Scenario = {
  name: "halted-run",
  description: "Halted iteration produces status=halted and surfaces halt_reason",
  async run(h) {
    const proj = await h.tempProject("halt");
    const runId = rid("halt");
    h.emitEvent(proj, "pipeline.started", runId, { pipeline_name: "test-pipeline" });
    h.emitIteration(proj, runId, 1, "01-hello.md", {
      outcome: "halted",
      haltReason: "tests didn't pass",
      next: null,
      terminal: true,
    });
    const runs = await h.getRuns(proj.project_id);
    const r = runs.find((x) => x.run_id === runId);
    let ok = true;
    ok = expectEq("status halted", r?.status, "halted") && ok;
    ok = expectEq("halt_reason", r?.halt_reason, "tests didn't pass") && ok;
    return ok;
  },
};

// ---------------------------------------------------------------------
// pipeline-discovery via /api/state — fixture pipeline is found
// ---------------------------------------------------------------------

export const pipelineDiscovery: Scenario = {
  name: "pipeline-discovery",
  description: "scanPipelines finds the fixture pipeline under .claude/pipeline/test-pipeline",
  async run(h) {
    const proj = await h.tempProject("discovery");
    const state = await h.getState(proj.project_id);
    let ok = true;
    ok = expectEq("one pipeline discovered", state.pipelines.length, 1) && ok;
    const p = state.pipelines[0] as {
      pipeline_name: string;
      iterations: string[];
    };
    ok = expectEq("pipeline name", p.pipeline_name, "test-pipeline") && ok;
    ok = expectEq("three steps", p.iterations.length, 3) && ok;
    return ok;
  },
};

// ---------------------------------------------------------------------
// /api/iteration — server can read a step file we created in fixture
// ---------------------------------------------------------------------

export const iterationFetch: Scenario = {
  name: "iteration-fetch",
  description: "/api/iteration returns parsed sections for a fixture step",
  async run(h) {
    const proj = await h.tempProject("iter-fetch");
    const res = await fetch(
      `${h.baseUrl()}/api/iteration?project_id=${proj.project_id}&name=test-pipeline&rel=01-hello.md`,
    );
    if (!res.ok) {
      console.log(`    ✗ /api/iteration HTTP ${res.status}`);
      return false;
    }
    const body = (await res.json()) as {
      title: string;
      sections: Array<{ heading: string }>;
    };
    let ok = true;
    ok = expectEq("title parsed", body.title, "01 — Hello") && ok;
    const headings = body.sections.map((s) => s.heading);
    ok = expect(
      "has Goal/Steps/Success Criteria/Next sections",
      headings.includes("Goal") &&
        headings.includes("Steps") &&
        headings.includes("Success Criteria") &&
        headings.includes("Next"),
    ) && ok;
    return ok;
  },
};

// ---------------------------------------------------------------------
// Review fix verification — iteration_count_completed only counts unique
// completed iterations (no halted/blocked, no double-counting on resume).
// ---------------------------------------------------------------------

export const iterationCountAccuracy: Scenario = {
  name: "iteration-count-completed-accuracy",
  description:
    "iteration_count_completed counts only outcome=completed and dedups by iteration_path; halted/blocked don't bump it, and a halted→resumed-completed sequence counts as one",
  async run(h) {
    const proj = await h.tempProject("count");
    const runId = rid("count");
    h.emitEvent(proj, "pipeline.started", runId, { pipeline_name: "test-pipeline" });
    // Step 1: completed
    h.emitIteration(proj, runId, 1, "01-hello.md", { next: "02-world.md" });
    // Step 2: halted (should NOT bump count)
    h.emitIteration(proj, runId, 2, "02-world.md", {
      outcome: "halted",
      haltReason: "tests failed",
      next: null,
      terminal: true,
    });

    let runs = await h.getRuns(proj.project_id);
    let r = runs.find((x) => x.run_id === runId);
    let ok = true;
    ok = expectEq("after halt, count is 1 (only step 1 completed)", r?.iteration_count_completed, 1) && ok;
    ok = expectEq("status is halted", r?.status, "halted") && ok;

    // Now simulate a resume: same step 2 re-runs and completes.
    h.emitEvent(proj, "iteration.resumed", runId, {
      iteration_path:
        proj.project_root + "/.claude/pipeline/test-pipeline/steps/02-world.md",
      index: 2,
    });
    h.emitEvent(proj, "iteration.completed", runId, {
      iteration_path:
        proj.project_root + "/.claude/pipeline/test-pipeline/steps/02-world.md",
      outcome: "completed",
      next_iteration_path: null,
      terminal: true,
      has_improvement_brief: false,
      has_blocker_delegation: false,
      halt_reason: null,
    });

    runs = await h.getRuns(proj.project_id);
    r = runs.find((x) => x.run_id === runId);
    ok = expectEq("after resume-completion, count is 2 (one per unique path)", r?.iteration_count_completed, 2) && ok;
    ok = expectEq("status is completed", r?.status, "completed") && ok;

    // Edge case: a second halted emission for the same path should NOT
    // bump the count further.
    h.emitEvent(proj, "iteration.completed", runId, {
      iteration_path:
        proj.project_root + "/.claude/pipeline/test-pipeline/steps/01-hello.md",
      outcome: "halted",
      halt_reason: "spurious second halt",
      next_iteration_path: null,
      terminal: true,
      has_improvement_brief: false,
      has_blocker_delegation: false,
    });
    runs = await h.getRuns(proj.project_id);
    r = runs.find((x) => x.run_id === runId);
    ok = expectEq("halt on already-completed path doesn't bump count", r?.iteration_count_completed, 2) && ok;
    return ok;
  },
};

// ---------------------------------------------------------------------
// Review fix verification — /api/runs reads rotated archives too
// (otherwise long-term history truncates at every 50 MB boundary)
// ---------------------------------------------------------------------

export const journalArchiveFolding: Scenario = {
  name: "journal-archive-folding",
  description:
    "/api/runs folds events.jsonl AND every rotated events-<stamp>.jsonl archive in the runtime dir; runs from archives still surface",
  async run(h) {
    const proj = await h.tempProject("archive");
    // Emit run A normally → into events.jsonl
    const a = rid("arch-a");
    h.emitEvent(proj, "pipeline.started", a, { pipeline_name: "test-pipeline" });
    h.emitIteration(proj, a, 1, "01-hello.md", { next: null, terminal: true });

    // Simulate a rotation: rename events.jsonl to events-OLDSTAMP.jsonl,
    // then emit run B into a fresh events.jsonl.
    const { readFileSync, writeFileSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const journal = join(
      proj.project_root,
      ".claude",
      "pipeline",
      ".runtime",
      "events.jsonl",
    );
    const archive = join(
      proj.project_root,
      ".claude",
      "pipeline",
      ".runtime",
      "events-20260101T000000.jsonl",
    );
    const archived = readFileSync(journal, "utf-8");
    writeFileSync(archive, archived, "utf-8");
    unlinkSync(journal);

    const b = rid("arch-b");
    h.emitEvent(proj, "pipeline.started", b, { pipeline_name: "test-pipeline" });
    h.emitIteration(proj, b, 1, "01-hello.md", { next: null, terminal: true });

    const runs = await h.getRuns(proj.project_id);
    const ids = new Set(runs.map((r) => r.run_id));
    let ok = true;
    ok = expect("archived run A is in /api/runs", ids.has(a)) && ok;
    ok = expect("current run B is in /api/runs", ids.has(b)) && ok;
    return ok;
  },
};

export const allScenarios: Scenario[] = [
  pipelineDiscovery,
  iterationFetch,
  terminalFlagV2,
  terminalFlagV1Compat,
  currentStepTracking,
  multipleInstances,
  historyPersistence,
  worktreeThreading,
  worktreeEndToEnd,
  iterationResumed,
  haltedRun,
  iterationCountAccuracy,
  journalArchiveFolding,
  chatMessagesRotationFolding,
  // Per-pipeline / per-step model selection (issue #7) — three free
  // resolver scenarios. The opt-in haiku-end-to-end variant lives in
  // ./model.ts but is gated in run.ts behind --include-haiku.
  modelStepOverrideWins,
  modelPipelineDefault,
  modelInvalidFallsThrough,
];
