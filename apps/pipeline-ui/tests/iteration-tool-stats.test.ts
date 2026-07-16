/**
 * Per-iteration analytics fold (schema v4 — step_id-keyed, overlap-safe).
 *
 *   bun test tests/iteration-tool-stats.test.ts
 *
 * Covers the DAG/parallel folding contract added in Phase 3:
 *   (a) overlapping parallel iterations keyed by step_id attribute their
 *       own tools/tokens correctly (not mis-windowed onto a sibling);
 *   (b) v3 (and older) events WITHOUT step_id still fold by the legacy
 *       consecutive-`iteration.started`-window behavior (backward-compat);
 *   (c) the per-run grouping keeps two concurrent runs separate.
 *
 * No daemon boot, no network — pure fold over an in-memory event array.
 */

import { describe, expect, test } from "bun:test";

import {
  iterationToolStatsByRun,
  iterationToolStatsForRun,
} from "../lib.ts";

interface Ev {
  ts: string;
  type: string;
  run_id?: string | null;
  data?: Record<string, unknown>;
}

let seq = 0;
function ev(
  type: string,
  data: Record<string, unknown> = {},
  run_id: string | null = "r1",
): Ev {
  // monotonic ISO timestamp so ordering is unambiguous
  seq += 1;
  const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, seq)).toISOString();
  return { ts, type, run_id, data };
}

function byStep(stats: ReturnType<typeof iterationToolStatsForRun>) {
  const m = new Map<string, (typeof stats)[number]>();
  for (const s of stats) m.set(s.step_id, s);
  return m;
}

describe("iterationToolStatsForRun — step_id mode (parallel / overlap-safe)", () => {
  test("(a) overlapping parallel iterations attribute tools/tokens to the correct step", () => {
    // Two parallel steps A and B started together (a ready-set). Their
    // tool.called / turn.usage events interleave while BOTH windows are
    // open. With the legacy consecutive-window heuristic, B's iteration.started
    // would have "closed" A's window and stolen all of A's later tools. With
    // step_id keying each step keeps its own.
    const events: Ev[] = [
      ev("iteration.started", { iteration_path: "/p/steps/01-a.md", step_id: "a", index: 1 }),
      ev("iteration.started", { iteration_path: "/p/steps/02-b.md", step_id: "b", index: 1 }),
      // b is most-recently-started → it is the active window now.
      ev("tool.called", { success: true }), // → b
      ev("tool.called", { success: false }), // → b (failed)
      // b completes; a is still open → a becomes active again.
      ev("iteration.completed", { iteration_path: "/p/steps/02-b.md", step_id: "b", outcome: "completed" }),
      ev("tool.called", { success: true, agent_spawn: true }), // → a
      ev("turn.usage", { input_tokens: 100, output_tokens: 40 }), // → a
      ev("iteration.completed", { iteration_path: "/p/steps/01-a.md", step_id: "a", outcome: "completed" }),
    ];
    const m = byStep(iterationToolStatsForRun(events));
    expect(m.size).toBe(2);

    const a = m.get("a")!;
    expect(a.tools_called).toBe(1);
    expect(a.tools_failed).toBe(0);
    expect(a.agents_spawned).toBe(1);
    expect(a.input_tokens).toBe(100);
    expect(a.output_tokens).toBe(40);
    expect(a.iteration_path).toBe("/p/steps/01-a.md");

    const b = m.get("b")!;
    expect(b.tools_called).toBe(2);
    expect(b.tools_failed).toBe(1);
    expect(b.agents_spawned).toBe(0);
    expect(b.input_tokens).toBe(0);
    expect(b.iteration_path).toBe("/p/steps/02-b.md");
  });

  test("(c) the iteration tree shows parallel steps as distinct rows", () => {
    // A 3-wide ready-set: a, b, c all open before any completes. Each gets
    // one tool while it is the newest-open window, then completes LIFO.
    const events: Ev[] = [
      ev("iteration.started", { iteration_path: "/p/steps/01-a.md", step_id: "a" }),
      ev("tool.called", { success: true }), // → a (only a open)
      ev("iteration.started", { iteration_path: "/p/steps/02-b.md", step_id: "b" }),
      ev("tool.called", { success: true }), // → b (newest open)
      ev("iteration.started", { iteration_path: "/p/steps/03-c.md", step_id: "c" }),
      ev("tool.called", { success: true }), // → c (newest open)
      ev("iteration.completed", { step_id: "c", outcome: "completed" }),
      ev("iteration.completed", { step_id: "b", outcome: "completed" }),
      ev("iteration.completed", { step_id: "a", outcome: "completed" }),
    ];
    const stats = iterationToolStatsForRun(events);
    // Three distinct rows, first-seen order a, b, c.
    expect(stats.map((s) => s.step_id)).toEqual(["a", "b", "c"]);
    expect(stats.map((s) => s.tools_called)).toEqual([1, 1, 1]);
  });

  test("ambient telemetry before the first iteration.started is dropped (no open window)", () => {
    const events: Ev[] = [
      ev("tool.called", { success: true }), // no window open → ignored
      ev("iteration.started", { iteration_path: "/p/steps/01.md", step_id: "s1" }),
      ev("tool.called", { success: true }), // → s1
    ];
    const m = byStep(iterationToolStatsForRun(events));
    expect(m.get("s1")!.tools_called).toBe(1);
  });
});

describe("iterationToolStatsForRun — legacy mode (no step_id, backward-compat)", () => {
  test("(b) v3 events without step_id fold by the consecutive-iteration.started window", () => {
    // Sequential chain, no step_id anywhere (a v3 journal). Each step's
    // window runs from its iteration.started until the NEXT iteration.started.
    // Tools after iteration.completed but before the next start still belong
    // to the just-run step (historical behavior).
    const events: Ev[] = [
      ev("iteration.started", { iteration_path: "/p/steps/01.md", index: 1 }),
      ev("tool.called", { success: true }), // → 01
      ev("tool.called", { success: false }), // → 01 (failed)
      ev("iteration.completed", { iteration_path: "/p/steps/01.md", outcome: "completed" }),
      // post-completed, pre-next-start tool still belongs to 01:
      ev("turn.usage", { input_tokens: 10, output_tokens: 5 }), // → 01
      ev("iteration.started", { iteration_path: "/p/steps/02.md", index: 2 }),
      ev("tool.called", { success: true, agent_spawn: true }), // → 02
      ev("iteration.completed", { iteration_path: "/p/steps/02.md", outcome: "completed" }),
    ];
    const stats = iterationToolStatsForRun(events);
    expect(stats).toHaveLength(2);

    const s01 = stats[0];
    expect(s01.iteration_path).toBe("/p/steps/01.md");
    expect(s01.tools_called).toBe(2);
    expect(s01.tools_failed).toBe(1);
    expect(s01.input_tokens).toBe(10);
    expect(s01.output_tokens).toBe(5);
    expect(s01.agents_spawned).toBe(0);

    const s02 = stats[1];
    expect(s02.iteration_path).toBe("/p/steps/02.md");
    expect(s02.tools_called).toBe(1);
    expect(s02.agents_spawned).toBe(1);
    expect(s02.input_tokens).toBe(0);
  });

  test("legacy mode: one active window at a time (no overlap leakage)", () => {
    const events: Ev[] = [
      ev("iteration.started", { iteration_path: "/p/steps/01.md" }),
      ev("tool.called", { success: true }),
      ev("iteration.started", { iteration_path: "/p/steps/02.md" }),
      ev("tool.called", { success: true }),
      ev("tool.called", { success: true }),
    ];
    const stats = iterationToolStatsForRun(events);
    expect(stats[0].tools_called).toBe(1); // only the pre-02 tool
    expect(stats[1].tools_called).toBe(2);
  });
});

describe("iterationToolStatsByRun — per-run isolation", () => {
  test("two concurrent runs do not share open windows", () => {
    const events: Ev[] = [
      ev("iteration.started", { iteration_path: "/p/steps/01.md", step_id: "a" }, "runA"),
      ev("iteration.started", { iteration_path: "/p/steps/01.md", step_id: "x" }, "runB"),
      ev("tool.called", { success: true }, "runA"), // → runA/a
      ev("tool.called", { success: true }, "runB"), // → runB/x
      ev("tool.called", { success: true }, "runB"), // → runB/x
    ];
    const byRun = iterationToolStatsByRun(events);
    expect(byRun.get("runA")![0].tools_called).toBe(1);
    expect(byRun.get("runB")![0].tools_called).toBe(2);
  });

  test("events without a run_id are ignored", () => {
    const events: Ev[] = [
      ev("iteration.started", { iteration_path: "/p/steps/01.md", step_id: "a" }, null),
      ev("tool.called", { success: true }, null),
    ];
    const byRun = iterationToolStatsByRun(events);
    expect(byRun.size).toBe(0);
  });
});
