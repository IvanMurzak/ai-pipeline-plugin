import { expect, test } from "bun:test";
import { stepTimingsForRun } from "../lib.ts";

const T0 = "2026-07-09T10:00:00.000Z";
const T1 = "2026-07-09T10:05:00.000Z"; // +5m
const T2 = "2026-07-09T10:12:00.000Z"; // +12m
const T3 = "2026-07-09T10:30:00.000Z"; // +30m

function ev(type: string, ts: string, data: Record<string, unknown>) {
  return { ts, type, run_id: "r1", data };
}

const STEP_A = "C:/p/.claude/pipeline/demo/steps/01-a.md";
const STEP_B = "C:/p/.claude/pipeline/demo/steps/02-b.md";

test("sequential run: durations per step, rel derived, outcome captured", () => {
  const out = stepTimingsForRun([
    ev("iteration.started", T0, { iteration_path: STEP_A }),
    ev("iteration.completed", T1, { iteration_path: STEP_A, outcome: "completed" }),
    ev("iteration.started", T1, { iteration_path: STEP_B }),
    ev("iteration.completed", T2, { iteration_path: STEP_B, outcome: "halted" }),
  ]);
  expect(out).toHaveLength(2);
  const [a, b] = out;
  expect(a.rel).toBe("01-a.md");
  expect(a.attempts).toBe(1);
  expect(a.duration_ms).toBe(5 * 60_000);
  expect(a.open_since).toBeNull();
  expect(a.last_outcome).toBe("completed");
  expect(b.duration_ms).toBe(7 * 60_000);
  expect(b.last_outcome).toBe("halted");
});

test("a still-open step surfaces open_since instead of ticking duration", () => {
  const out = stepTimingsForRun([
    ev("iteration.started", T0, { iteration_path: STEP_A }),
    ev("iteration.completed", T1, { iteration_path: STEP_A, outcome: "completed" }),
    ev("iteration.started", T1, { iteration_path: STEP_B }),
  ]);
  const b = out[1];
  expect(b.duration_ms).toBe(0);
  expect(b.open_since).toBe(T1);
});

test("legacy mode: a NEW iteration.started closes the previous step's window", () => {
  const out = stepTimingsForRun([
    ev("iteration.started", T0, { iteration_path: STEP_A }),
    // no iteration.completed for A — crashed executor, chain moved on
    ev("iteration.started", T2, { iteration_path: STEP_B }),
  ]);
  const a = out[0];
  expect(a.duration_ms).toBe(12 * 60_000);
  expect(a.open_since).toBeNull();
});

test("needs-input park: resume reopens; parked time is EXCLUDED", () => {
  const out = stepTimingsForRun([
    ev("iteration.started", T0, { iteration_path: STEP_A }),
    ev("iteration.completed", T1, { iteration_path: STEP_A, outcome: "needs-input" }),
    ev("iteration.resumed", T2, { iteration_path: STEP_A }),
    ev("iteration.completed", T3, { iteration_path: STEP_A, outcome: "completed" }),
  ]);
  expect(out).toHaveLength(1);
  const a = out[0];
  // 5m active + 18m after resume; the 7m parked between T1 and T2 not counted.
  expect(a.duration_ms).toBe((5 + 18) * 60_000);
  expect(a.attempts).toBe(1); // resume is NOT a new attempt
  expect(a.last_outcome).toBe("completed");
});

test("DAG mode: overlapping step_id windows accumulate independently", () => {
  const out = stepTimingsForRun([
    ev("iteration.started", T0, { iteration_path: STEP_A, step_id: "a" }),
    ev("iteration.started", T1, { iteration_path: STEP_B, step_id: "b" }),
    ev("iteration.completed", T2, { iteration_path: STEP_A, step_id: "a", outcome: "completed" }),
    ev("iteration.completed", T3, { iteration_path: STEP_B, step_id: "b", outcome: "completed" }),
  ]);
  const a = out.find((s) => s.step_id === "a")!;
  const b = out.find((s) => s.step_id === "b")!;
  expect(a.duration_ms).toBe(12 * 60_000);
  expect(b.duration_ms).toBe(25 * 60_000);
});

test("pipeline.halted closes every open window (no forever-ticking steps)", () => {
  const out = stepTimingsForRun([
    ev("iteration.started", T0, { iteration_path: STEP_A }),
    ev("pipeline.halted", T1, { halt_reason: "stopped by user" }),
  ]);
  const a = out[0];
  expect(a.duration_ms).toBe(5 * 60_000);
  expect(a.open_since).toBeNull();
});
