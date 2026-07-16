/**
 * Tests for the event → RunState folding and per-step / per-pipeline
 * aggregation. Keeps the iteration-status math (running / completed /
 * halted / blocked) in a single place so regressions are caught fast.
 */

import { describe, expect, test } from "vitest";
import {
  aggregateRunsForPipeline,
  buildRunForest,
  isActive,
  iterationStatsByRel,
  iterationToolStatsByRel,
  iterationToolStatsByRun,
  iterationToolStatsForRun,
} from "../runs";
import type { PipelineEvent } from "../../types";

const proj = "C:/proj";

function ev(
  type: PipelineEvent["type"],
  run_id: string | null,
  data: Record<string, unknown> = {},
  extra: Partial<PipelineEvent> = {},
): PipelineEvent {
  return {
    schema: 1,
    ts: extra.ts ?? new Date().toISOString(),
    type,
    project_root: proj,
    worktree: null,
    run_id,
    parent_run_id: extra.parent_run_id ?? null,
    session_id: null,
    data,
    ...extra,
  };
}

describe("isActive", () => {
  test("running statuses", () => {
    expect(isActive("running")).toBe(true);
    expect(isActive("improving")).toBe(true);
    expect(isActive("scripting")).toBe(true);
    expect(isActive("polling-blocker")).toBe(true);
  });
  test("terminal statuses", () => {
    expect(isActive("completed")).toBe(false);
    expect(isActive("halted")).toBe(false);
    expect(isActive("unknown")).toBe(false);
  });
});

describe("buildRunForest", () => {
  test("folds a single run from pipeline.started → iteration.* → pipeline.completed", () => {
    const events: PipelineEvent[] = [
      ev("pipeline.started", "r1", { pipeline_name: "ui-smoke" }, {
        ts: "2026-01-01T00:00:00Z",
      }),
      ev("iteration.started", "r1", { iteration_path: "/x/steps/01.md", index: 1 }, {
        ts: "2026-01-01T00:00:05Z",
      }),
      ev("iteration.completed", "r1", { outcome: "completed" }, {
        ts: "2026-01-01T00:00:10Z",
      }),
      ev("iteration.started", "r1", { iteration_path: "/x/steps/02.md", index: 2 }, {
        ts: "2026-01-01T00:00:15Z",
      }),
      ev("iteration.completed", "r1", { outcome: "completed" }, {
        ts: "2026-01-01T00:00:20Z",
      }),
      ev("pipeline.completed", "r1", {}, { ts: "2026-01-01T00:00:25Z" }),
    ];
    const forest = buildRunForest(events);
    expect(forest).toHaveLength(1);
    const r = forest[0];
    expect(r.pipeline_name).toBe("ui-smoke");
    expect(r.iteration_count_completed).toBe(2);
    expect(r.status).toBe("completed");
    expect(r.current_iteration_index).toBe(2);
    expect(r.current_iteration_path).toBe("/x/steps/02.md");
  });

  test("halts on iteration.completed outcome=halted", () => {
    const events: PipelineEvent[] = [
      ev("pipeline.started", "r1", { pipeline_name: "x" }, { ts: "2026-01-01T00:00:00Z" }),
      ev("iteration.started", "r1", { iteration_path: "/x/01.md", index: 1 }, {
        ts: "2026-01-01T00:00:05Z",
      }),
      ev("iteration.completed", "r1", { outcome: "halted", halt_reason: "no input" }, {
        ts: "2026-01-01T00:00:10Z",
      }),
    ];
    const r = buildRunForest(events)[0];
    expect(r.status).toBe("halted");
    expect(r.halt_reason).toBe("no input");
  });

  test("dismiss is sticky: later iteration.started / pipeline.completed do NOT flip status back to running/completed", () => {
    // Regression: POST /api/runs/dismiss emits a synthetic pipeline.halted
    // with data.dismissed === true. Previously the fold treated this just
    // like any other halt — set status=halted, copy halt_reason — with no
    // memory of the dismiss. Subsequent events for the same run_id would
    // unconditionally flip status back to "running" (iteration.started)
    // or "completed" (pipeline.completed), contradicting the dismissed
    // halt_reason which sticks. The fix sets a sticky _dismissed flag.
    const events: PipelineEvent[] = [
      ev("pipeline.started", "r1", { pipeline_name: "x" }, { ts: "2026-01-01T00:00:00Z" }),
      ev("iteration.started", "r1", { iteration_path: "/x/steps/01.md", index: 1 }, {
        ts: "2026-01-01T00:00:05Z",
      }),
      // User clicks Dismiss while pipeline is still running.
      ev(
        "pipeline.halted",
        "r1",
        { halt_reason: "dismissed by user", dismissed: true },
        { ts: "2026-01-01T00:00:10Z" },
      ),
      // Pipeline keeps running and emits more events. Status must NOT
      // unstick — these are the events that previously caused the
      // contradictory "status: running, halt_reason: dismissed by user"
      // state the user is seeing.
      ev("iteration.started", "r1", { iteration_path: "/x/steps/02.md", index: 2 }, {
        ts: "2026-01-01T00:00:15Z",
      }),
      ev("iteration.completed", "r1", { outcome: "completed", terminal: true }, {
        ts: "2026-01-01T00:00:20Z",
      }),
      ev("pipeline.completed", "r1", {}, { ts: "2026-01-01T00:00:25Z" }),
    ];
    const r = buildRunForest(events)[0];
    expect(r.status).toBe("halted");
    expect(r.halt_reason).toBe("dismissed by user");
    // Data-field tracking still flows (we don't pretend the pipeline
    // stopped); only the status badge is frozen.
    expect(r.current_iteration_index).toBe(2);
    expect(r.current_iteration_path).toBe("/x/steps/02.md");
    expect(r.iteration_count_completed).toBe(1);
    // Internal flag is stripped from the public RunState shape.
    expect((r as unknown as { _dismissed?: boolean })._dismissed).toBeUndefined();
  });

  test("a NON-dismissed pipeline.halted is still overridable by later iteration.started", () => {
    // Belt-and-suspenders: the sticky behavior is gated on data.dismissed
    // (the dismiss action specifically). An ordinary halted-then-resumed
    // chat-resume scenario (rare but valid) must NOT freeze status.
    const events: PipelineEvent[] = [
      ev("pipeline.started", "r1", { pipeline_name: "x" }, { ts: "2026-01-01T00:00:00Z" }),
      ev("pipeline.halted", "r1", { halt_reason: "transient blocker" }, {
        ts: "2026-01-01T00:00:05Z",
      }),
      ev("iteration.started", "r1", { iteration_path: "/x/steps/01.md", index: 1 }, {
        ts: "2026-01-01T00:00:10Z",
      }),
    ];
    const r = buildRunForest(events)[0];
    expect(r.status).toBe("running");
  });

  test("nests blocker children under parent_run_id", () => {
    const events: PipelineEvent[] = [
      ev("pipeline.started", "parent", { pipeline_name: "outer" }, {
        ts: "2026-01-01T00:00:00Z",
      }),
      ev("blocker.delegated", "parent", { blocker_issue_url: "u1", blocker_target_repo: "o/r" }, {
        ts: "2026-01-01T00:00:05Z",
      }),
      ev("pipeline.started", "child", { pipeline_name: "inner" }, {
        ts: "2026-01-01T00:00:10Z",
        parent_run_id: "parent",
      }),
      ev("pipeline.completed", "child", {}, {
        ts: "2026-01-01T00:00:20Z",
        parent_run_id: "parent",
      }),
    ];
    const forest = buildRunForest(events);
    expect(forest).toHaveLength(1);
    expect(forest[0].run_id).toBe("parent");
    expect(forest[0].children).toHaveLength(1);
    expect(forest[0].children[0].run_id).toBe("child");
    expect(forest[0].children[0].status).toBe("completed");
  });

  test("accumulates token usage and tool counts", () => {
    const events: PipelineEvent[] = [
      ev("pipeline.started", "r1", { pipeline_name: "x" }),
      ev("tool.called", "r1", { success: true }),
      ev("tool.called", "r1", { success: false }),
      ev("tool.called", "r1", { success: true, agent_spawn: true }),
      ev("turn.usage", "r1", {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 2,
        cache_creation_tokens: 1,
      }),
      ev("turn.usage", "r1", {
        input_tokens: 7,
        output_tokens: 3,
      }),
    ];
    const r = buildRunForest(events)[0];
    expect(r.stats.tools_called).toBe(3);
    expect(r.stats.tools_failed).toBe(1);
    expect(r.stats.agents_spawned).toBe(1);
    expect(r.stats.input_tokens).toBe(17);
    expect(r.stats.output_tokens).toBe(8);
    expect(r.stats.cache_read_tokens).toBe(2);
    expect(r.stats.cache_creation_tokens).toBe(1);
  });

  test("events without run_id are ignored", () => {
    const events: PipelineEvent[] = [
      ev("session.opened", null, {}),
      ev("pipeline.started", "r1", { pipeline_name: "x" }),
    ];
    const forest = buildRunForest(events);
    expect(forest).toHaveLength(1);
    expect(forest[0].run_id).toBe("r1");
  });
});

describe("iterationStatsByRel", () => {
  test("counts started + outcome buckets per file basename", () => {
    const events: PipelineEvent[] = [
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/workflows/x/steps/01-a.md",
      }),
      ev("iteration.completed", "r1", {
        iteration_path: "/p/.claude/pipeline/workflows/x/steps/01-a.md",
        outcome: "completed",
      }),
      ev("iteration.started", "r2", {
        iteration_path: "/p/.claude/pipeline/workflows/x/steps/01-a.md",
      }),
      ev("iteration.completed", "r2", {
        iteration_path: "/p/.claude/pipeline/workflows/x/steps/01-a.md",
        outcome: "halted",
      }),
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/workflows/x/steps/02-b.md",
      }),
      // Different pipeline, ignored
      ev("iteration.started", "r3", {
        iteration_path: "/p/.claude/pipeline/workflows/y/steps/01-a.md",
      }),
    ];
    const stats = iterationStatsByRel(events, "x");
    expect(stats.get("01-a.md")).toEqual({
      started_count: 2,
      completed_count: 1,
      halted_count: 1,
      blocked_count: 0,
      last_outcome: "halted",
      last_event_at: expect.any(String),
      resolved_model: null,
      resolved_effort: null,
      step_id: null,
    });
    expect(stats.get("02-b.md")?.started_count).toBe(1);
    expect(stats.has("y/01-a.md")).toBe(false);
  });

  test("safely handles pipeline names with regex specials", () => {
    const events: PipelineEvent[] = [
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/some.weird+name/steps/01.md",
      }),
    ];
    const stats = iterationStatsByRel(events, "some.weird+name");
    expect(stats.get("01.md")?.started_count).toBe(1);
  });

  test("resolved_model is preserved when a later event omits the field or carries an invalid value", () => {
    const events: PipelineEvent[] = [
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/x/steps/01.md",
        resolved_model: "opus",
      }),
      // Out-of-order or older-daemon event with the field present but null —
      // should NOT blank the previously-captured value.
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/x/steps/01.md",
        resolved_model: null,
      }),
      // Garbage value (typo) — should also not blank.
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/x/steps/01.md",
        resolved_model: "Opus",
      }),
    ];
    const stats = iterationStatsByRel(events, "x");
    expect(stats.get("01.md")?.resolved_model).toBe("opus");
  });

  test("resolved_model accepts the fable alias", () => {
    const events: PipelineEvent[] = [
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/x/steps/01.md",
        resolved_model: "fable",
      }),
    ];
    const stats = iterationStatsByRel(events, "x");
    expect(stats.get("01.md")?.resolved_model).toBe("fable");
  });

  test("resolved_model preserves a canonical claude-* id verbatim", () => {
    const events: PipelineEvent[] = [
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/x/steps/01.md",
        resolved_model: "claude-opus-4-8",
      }),
      // A later unknown / future canonical id is also kept as-is — the
      // client must never coerce a valid value to null.
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/x/steps/01.md",
        resolved_model: "claude-some-future-model",
      }),
    ];
    const stats = iterationStatsByRel(events, "x");
    expect(stats.get("01.md")?.resolved_model).toBe("claude-some-future-model");
  });
});

describe("iterationToolStatsForRun (step_id-keyed, overlap-safe — schema v4)", () => {
  // Client mirror of apps/pipeline-ui/tests/iteration-tool-stats.test.ts —
  // the web fold and the server fold must agree.
  test("(a) overlapping parallel iterations attribute tools/tokens by step_id", () => {
    const events: PipelineEvent[] = [
      ev("iteration.started", "r1", { iteration_path: "/p/steps/01-a.md", step_id: "a" }, { ts: "2026-01-01T00:00:01Z" }),
      ev("iteration.started", "r1", { iteration_path: "/p/steps/02-b.md", step_id: "b" }, { ts: "2026-01-01T00:00:02Z" }),
      ev("tool.called", "r1", { success: true }, { ts: "2026-01-01T00:00:03Z" }), // → b
      ev("tool.called", "r1", { success: false }, { ts: "2026-01-01T00:00:04Z" }), // → b
      ev("iteration.completed", "r1", { step_id: "b", outcome: "completed" }, { ts: "2026-01-01T00:00:05Z" }),
      ev("tool.called", "r1", { success: true, agent_spawn: true }, { ts: "2026-01-01T00:00:06Z" }), // → a
      ev("turn.usage", "r1", { input_tokens: 100, output_tokens: 40 }, { ts: "2026-01-01T00:00:07Z" }), // → a
      ev("iteration.completed", "r1", { step_id: "a", outcome: "completed" }, { ts: "2026-01-01T00:00:08Z" }),
    ];
    const stats = iterationToolStatsForRun(events);
    const a = stats.find((s) => s.step_id === "a")!;
    const b = stats.find((s) => s.step_id === "b")!;
    expect(a.tools_called).toBe(1);
    expect(a.agents_spawned).toBe(1);
    expect(a.input_tokens).toBe(100);
    expect(b.tools_called).toBe(2);
    expect(b.tools_failed).toBe(1);
    expect(b.input_tokens).toBe(0);
  });

  test("(b) events WITHOUT step_id fold by the legacy consecutive-window behavior", () => {
    const events: PipelineEvent[] = [
      ev("iteration.started", "r1", { iteration_path: "/p/steps/01.md" }, { ts: "2026-01-01T00:00:01Z" }),
      ev("tool.called", "r1", { success: true }, { ts: "2026-01-01T00:00:02Z" }), // → 01
      ev("iteration.completed", "r1", { iteration_path: "/p/steps/01.md", outcome: "completed" }, { ts: "2026-01-01T00:00:03Z" }),
      ev("tool.called", "r1", { success: true }, { ts: "2026-01-01T00:00:04Z" }), // → still 01 (legacy)
      ev("iteration.started", "r1", { iteration_path: "/p/steps/02.md" }, { ts: "2026-01-01T00:00:05Z" }),
      ev("tool.called", "r1", { success: true }, { ts: "2026-01-01T00:00:06Z" }), // → 02
    ];
    const stats = iterationToolStatsForRun(events);
    expect(stats).toHaveLength(2);
    expect(stats[0].tools_called).toBe(2);
    expect(stats[1].tools_called).toBe(1);
  });

  test("iterationToolStatsByRun isolates concurrent runs", () => {
    const events: PipelineEvent[] = [
      ev("iteration.started", "rA", { iteration_path: "/p/steps/01.md", step_id: "a" }),
      ev("iteration.started", "rB", { iteration_path: "/p/steps/01.md", step_id: "x" }),
      ev("tool.called", "rA", { success: true }),
      ev("tool.called", "rB", { success: true }),
      ev("tool.called", "rB", { success: true }),
    ];
    const byRun = iterationToolStatsByRun(events);
    expect(byRun.get("rA")![0].tools_called).toBe(1);
    expect(byRun.get("rB")![0].tools_called).toBe(2);
  });
});

describe("iterationToolStatsByRel (rel-keyed view adapter that feeds the tree)", () => {
  // This is the exact selector App.tsx feeds into <IterationTree>. It must be
  // correct for BOTH a parallel (step_id) run AND a sequential (no-step_id)
  // run, re-keyed onto the iteration tree's rel-path convention (basename
  // first, full rel fallback) so a row can surface its own tool/token counts.

  test("parallel run: overlapping step_id steps surface per-rel tool/token stats", () => {
    const events: PipelineEvent[] = [
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/x/steps/01-a.md",
        step_id: "a",
      }, { ts: "2026-01-01T00:00:01Z" }),
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/x/steps/02-b.md",
        step_id: "b",
      }, { ts: "2026-01-01T00:00:02Z" }),
      // While both a and b are OPEN, ambient events attribute to the
      // most-recently-started still-open step (b).
      ev("tool.called", "r1", { success: true }, { ts: "2026-01-01T00:00:03Z" }), // → b
      ev("tool.called", "r1", { success: false }, { ts: "2026-01-01T00:00:04Z" }), // → b
      ev("iteration.completed", "r1", { step_id: "b", outcome: "completed" }, { ts: "2026-01-01T00:00:05Z" }),
      // b closed; a is still open → these attribute to a.
      ev("tool.called", "r1", { success: true, agent_spawn: true }, { ts: "2026-01-01T00:00:06Z" }), // → a
      ev("turn.usage", "r1", { input_tokens: 100, output_tokens: 40, cache_read_tokens: 7 }, { ts: "2026-01-01T00:00:07Z" }), // → a
      ev("iteration.completed", "r1", { step_id: "a", outcome: "completed" }, { ts: "2026-01-01T00:00:08Z" }),
    ];
    const byRel = iterationToolStatsByRel(events, "r1", "x");
    // Tree looks up by basename (tail) first.
    const a = byRel.get("01-a.md")!;
    const b = byRel.get("02-b.md")!;
    expect(a.tools_called).toBe(1);
    expect(a.agents_spawned).toBe(1);
    expect(a.input_tokens).toBe(100);
    expect(a.output_tokens).toBe(40);
    expect(a.cache_read_tokens).toBe(7);
    expect(b.tools_called).toBe(2);
    expect(b.tools_failed).toBe(1);
    expect(b.input_tokens).toBe(0);
  });

  test("sequential run: no step_id folds by legacy window, still per-rel", () => {
    const events: PipelineEvent[] = [
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/x/steps/01.md",
      }, { ts: "2026-01-01T00:00:01Z" }),
      ev("tool.called", "r1", { success: true }, { ts: "2026-01-01T00:00:02Z" }), // → 01
      ev("iteration.completed", "r1", {
        iteration_path: "/p/.claude/pipeline/x/steps/01.md",
        outcome: "completed",
      }, { ts: "2026-01-01T00:00:03Z" }),
      // Legacy: completed does NOT close the window — the next started does.
      ev("tool.called", "r1", { success: true }, { ts: "2026-01-01T00:00:04Z" }), // → still 01
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/x/steps/02.md",
      }, { ts: "2026-01-01T00:00:05Z" }),
      ev("turn.usage", "r1", { input_tokens: 12, output_tokens: 3 }, { ts: "2026-01-01T00:00:06Z" }), // → 02
      ev("tool.called", "r1", { success: false }, { ts: "2026-01-01T00:00:07Z" }), // → 02
    ];
    const byRel = iterationToolStatsByRel(events, "r1", "x");
    expect(byRel.get("01.md")!.tools_called).toBe(2);
    expect(byRel.get("02.md")!.tools_called).toBe(1);
    expect(byRel.get("02.md")!.tools_failed).toBe(1);
    expect(byRel.get("02.md")!.input_tokens).toBe(12);
  });

  test("isolates the selected run — other runs' events do not leak in", () => {
    const events: PipelineEvent[] = [
      ev("iteration.started", "rA", { iteration_path: "/p/.claude/pipeline/x/steps/01.md", step_id: "a" }),
      ev("iteration.started", "rB", { iteration_path: "/p/.claude/pipeline/x/steps/01.md", step_id: "a" }),
      ev("tool.called", "rA", { success: true }),
      ev("tool.called", "rB", { success: true }),
      ev("tool.called", "rB", { success: true }),
    ];
    expect(iterationToolStatsByRel(events, "rA", "x").get("01.md")!.tools_called).toBe(1);
    expect(iterationToolStatsByRel(events, "rB", "x").get("01.md")!.tools_called).toBe(2);
  });

  test("sub-folder rel keying: ambiguous basenames are looked up by full rel", () => {
    const events: PipelineEvent[] = [
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/x/steps/phase-a/01.md",
        step_id: "pa-01",
      }, { ts: "2026-01-01T00:00:01Z" }),
      ev("tool.called", "r1", { success: true }, { ts: "2026-01-01T00:00:02Z" }),
      ev("iteration.completed", "r1", { step_id: "pa-01", outcome: "completed" }, { ts: "2026-01-01T00:00:03Z" }),
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/x/steps/phase-b/01.md",
        step_id: "pb-01",
      }, { ts: "2026-01-01T00:00:04Z" }),
      ev("tool.called", "r1", { success: true }, { ts: "2026-01-01T00:00:05Z" }),
      ev("tool.called", "r1", { success: true }, { ts: "2026-01-01T00:00:06Z" }),
      ev("iteration.completed", "r1", { step_id: "pb-01", outcome: "completed" }, { ts: "2026-01-01T00:00:07Z" }),
    ];
    const byRel = iterationToolStatsByRel(events, "r1", "x");
    // Colliding basename "01.md" must NOT be aliased (drop ambiguous alias).
    expect(byRel.has("01.md")).toBe(false);
    // Full rel disambiguates.
    expect(byRel.get("phase-a/01.md")!.tools_called).toBe(1);
    expect(byRel.get("phase-b/01.md")!.tools_called).toBe(2);
  });

  test("zero-tool run yields no rel buckets (graceful empty)", () => {
    const events: PipelineEvent[] = [
      ev("pipeline.started", "r1", { pipeline_name: "x" }),
      ev("iteration.started", "r1", { iteration_path: "/p/.claude/pipeline/x/steps/01.md", step_id: "a" }),
      ev("iteration.completed", "r1", { step_id: "a", outcome: "completed" }),
    ];
    const byRel = iterationToolStatsByRel(events, "r1", "x");
    // The step bucket exists (a started) but carries all-zero counts; the
    // tree's ToolStatLine renders nothing for an all-zero bucket. The adapter
    // never crashes and the rel is present with zeros.
    expect(byRel.get("01.md")).toMatchObject({
      tools_called: 0,
      agents_spawned: 0,
      input_tokens: 0,
      output_tokens: 0,
    });
  });

  test("drops events outside this pipeline's steps/ folder", () => {
    const events: PipelineEvent[] = [
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/y/steps/01.md",
        step_id: "a",
      }),
      ev("tool.called", "r1", { success: true }),
    ];
    // Folding for pipeline "x" must ignore pipeline "y"'s step.
    const byRel = iterationToolStatsByRel(events, "r1", "x");
    expect(byRel.size).toBe(0);
  });

  test("family target: hub-shared steps fold under the hub matcher", () => {
    // A target run starts in <hub>/targets/<t>/steps/ then chains into the
    // hub's shared steps/ — both must land in the same rel-keyed map.
    const events: PipelineEvent[] = [
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/hub/targets/tgt/steps/01-entry.md",
        step_id: "e",
      }, { ts: "2026-01-01T00:00:01Z" }),
      ev("tool.called", "r1", { success: true }, { ts: "2026-01-01T00:00:02Z" }),
      ev("iteration.completed", "r1", { step_id: "e", outcome: "completed" }, { ts: "2026-01-01T00:00:03Z" }),
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/hub/steps/02-shared.md",
        step_id: "s",
      }, { ts: "2026-01-01T00:00:04Z" }),
      ev("tool.called", "r1", { success: false }, { ts: "2026-01-01T00:00:05Z" }),
      ev("iteration.completed", "r1", { step_id: "s", outcome: "completed" }, { ts: "2026-01-01T00:00:06Z" }),
    ];
    // Without the hub name only the target-local step matches.
    expect(iterationToolStatsByRel(events, "r1", "tgt").size).toBe(1);
    const byRel = iterationToolStatsByRel(events, "r1", "tgt", "hub");
    expect(byRel.get("01-entry.md")!.tools_called).toBe(1);
    expect(byRel.get("02-shared.md")!.tools_failed).toBe(1);
    // The hub matcher must NOT swallow the target path (`hub/targets/...`
    // does not contain `/hub/steps/`), so no double-keyed duplicates exist.
    expect(byRel.has("targets/tgt/steps/01-entry.md")).toBe(false);
  });

  test("family target: a target-local OVERRIDE excludes the hub copy's executions", () => {
    // tgt ships its own 02-build.md; the hub's shared copy of the same
    // basename is executed by OTHER runs. Without ownIterations both paths
    // fold onto rel "02-build.md" and the override row shows foreign stats.
    const events: PipelineEvent[] = [
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/hub/targets/tgt/steps/02-build.md",
        step_id: "own",
      }, { ts: "2026-01-01T00:00:01Z" }),
      ev("tool.called", "r1", { success: true }, { ts: "2026-01-01T00:00:02Z" }),
      ev("iteration.completed", "r1", { step_id: "own", outcome: "completed" }, { ts: "2026-01-01T00:00:03Z" }),
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/hub/steps/02-build.md",
        step_id: "hubcopy",
      }, { ts: "2026-01-01T00:00:04Z" }),
      ev("tool.called", "r1", { success: true }, { ts: "2026-01-01T00:00:05Z" }),
      ev("tool.called", "r1", { success: true }, { ts: "2026-01-01T00:00:06Z" }),
      ev("iteration.completed", "r1", { step_id: "hubcopy", outcome: "completed" }, { ts: "2026-01-01T00:00:07Z" }),
    ];
    // Without ownIterations both copies merge into one rel bucket.
    const merged = iterationToolStatsByRel(events, "r1", "tgt", "hub");
    expect(merged.get("02-build.md")!.tools_called).toBe(3);
    // With the target's own list, the hub copy's executions are excluded.
    const own = iterationToolStatsByRel(events, "r1", "tgt", "hub", ["02-build.md"]);
    expect(own.get("02-build.md")!.tools_called).toBe(1);
  });
});

describe("iterationStatsByRel — family hub matcher", () => {
  test("hub-shared iteration.* events fold in for a target pipeline", () => {
    const events: PipelineEvent[] = [
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/hub/targets/tgt/steps/01-entry.md",
      }, { ts: "2026-01-01T00:00:01Z" }),
      ev("iteration.completed", "r1", {
        iteration_path: "/p/.claude/pipeline/hub/targets/tgt/steps/01-entry.md",
        outcome: "completed",
      }, { ts: "2026-01-01T00:00:02Z" }),
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/hub/steps/02-shared.md",
        resolved_model: "opus",
      }, { ts: "2026-01-01T00:00:03Z" }),
    ];
    const withoutHub = iterationStatsByRel(events, "tgt");
    expect(withoutHub.has("02-shared.md")).toBe(false);
    const withHub = iterationStatsByRel(events, "tgt", "hub");
    expect(withHub.get("01-entry.md")!.completed_count).toBe(1);
    expect(withHub.get("02-shared.md")!.started_count).toBe(1);
    expect(withHub.get("02-shared.md")!.resolved_model).toBe("opus");
  });
});

describe("iterationStatsByRel captures step_id (schema v4)", () => {
  test("step_id from iteration.* events is surfaced on the row", () => {
    const events: PipelineEvent[] = [
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/x/steps/01-a.md",
        step_id: "01-a",
      }),
    ];
    const stats = iterationStatsByRel(events, "x");
    expect(stats.get("01-a.md")?.step_id).toBe("01-a");
  });

  test("step_id stays null for pre-v4 events", () => {
    const events: PipelineEvent[] = [
      ev("iteration.started", "r1", {
        iteration_path: "/p/.claude/pipeline/x/steps/01-a.md",
      }),
    ];
    const stats = iterationStatsByRel(events, "x");
    expect(stats.get("01-a.md")?.step_id).toBeNull();
  });
});

describe("aggregateRunsForPipeline", () => {
  test("counts runs by status, including child runs of the same pipeline", () => {
    const events: PipelineEvent[] = [
      ev("pipeline.started", "r1", { pipeline_name: "x" }, { ts: "2026-01-01T00:00:00Z" }),
      ev("pipeline.completed", "r1", {}, { ts: "2026-01-01T00:00:10Z" }),
      ev("pipeline.started", "r2", { pipeline_name: "x" }, { ts: "2026-01-02T00:00:00Z" }),
      // r2 is still active (no completed/halted event)
      ev("pipeline.started", "r3", { pipeline_name: "y" }, { ts: "2026-01-03T00:00:00Z" }),
    ];
    const forest = buildRunForest(events);
    const agg = aggregateRunsForPipeline(forest, "x");
    expect(agg.total_runs).toBe(2);
    expect(agg.completed_runs).toBe(1);
    expect(agg.active_runs).toBe(1);
    expect(agg.halted_runs).toBe(0);
    expect(agg.last_event_at).toBe("2026-01-02T00:00:00Z");
  });

  test("returns zeros for a never-run pipeline", () => {
    const agg = aggregateRunsForPipeline([], "never-run");
    expect(agg).toEqual({
      total_runs: 0,
      active_runs: 0,
      completed_runs: 0,
      halted_runs: 0,
      last_event_at: null,
    });
  });
});
