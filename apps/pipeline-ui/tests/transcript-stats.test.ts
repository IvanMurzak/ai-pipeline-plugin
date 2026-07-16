import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectRunToolFailures,
  foldTranscriptEntry,
  emptyTranscriptRunStats,
  foldRunStatsFromTranscript,
  indexRunTranscripts,
  subagentsDirFor,
} from "../transcript-stats.ts";

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

const OPEN = { start: null, end: null };

function assistant(ts: string, usage: Record<string, number>, tools: Array<{ name: string }> = []) {
  return {
    type: "assistant",
    timestamp: ts,
    message: {
      role: "assistant",
      usage,
      content: tools.map((t) => ({ type: "tool_use", name: t.name, id: "x", input: {} })),
    },
  };
}

test("foldTranscriptEntry: sums usage + counts tool_use and agent spawns", () => {
  const acc = emptyTranscriptRunStats();
  foldTranscriptEntry(
    assistant("2026-06-23T02:30:00.000Z", { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 }, [
      { name: "Bash" },
      { name: "Agent" },
    ]),
    acc,
    OPEN,
  );
  expect(acc.input_tokens).toBe(100);
  expect(acc.output_tokens).toBe(50);
  expect(acc.cache_read_tokens).toBe(10);
  expect(acc.cache_creation_tokens).toBe(5);
  expect(acc.tools_called).toBe(2);
  expect(acc.agents_spawned).toBe(1);
});

test("foldTranscriptEntry: tool_result is_error counts a failure", () => {
  const acc = emptyTranscriptRunStats();
  foldTranscriptEntry(
    { type: "user", timestamp: "2026-06-23T02:30:00.000Z", message: { role: "user", content: [{ type: "tool_result", is_error: true, content: "boom" }] } },
    acc,
    OPEN,
  );
  expect(acc.tools_failed).toBe(1);
});

test("foldTranscriptEntry: window gate drops entries outside [start,end]", () => {
  const win = { start: Date.parse("2026-06-23T02:00:00.000Z"), end: Date.parse("2026-06-23T03:00:00.000Z") };
  const acc = emptyTranscriptRunStats();
  // before window
  foldTranscriptEntry(assistant("2026-06-23T01:00:00.000Z", { input_tokens: 999, output_tokens: 0 }, [{ name: "Bash" }]), acc, win);
  // after window
  foldTranscriptEntry(assistant("2026-06-23T04:00:00.000Z", { input_tokens: 999, output_tokens: 0 }, [{ name: "Bash" }]), acc, win);
  // inside window
  foldTranscriptEntry(assistant("2026-06-23T02:30:00.000Z", { input_tokens: 7, output_tokens: 3 }, [{ name: "Edit" }]), acc, win);
  expect(acc.input_tokens).toBe(7);
  expect(acc.tools_called).toBe(1);
});

test("foldRunStatsFromTranscript: folds manager + in-window subagent files", () => {
  const root = mkdtempSync(join(tmpdir(), "tstats-"));
  created.push(root);
  const mgr = join(root, "sess.jsonl");
  writeFileSync(
    mgr,
    [
      JSON.stringify(assistant("2026-06-23T02:10:00.000Z", { input_tokens: 100, output_tokens: 20 }, [{ name: "Agent" }])),
      JSON.stringify(assistant("2026-06-23T02:11:00.000Z", { input_tokens: 50, output_tokens: 10 }, [{ name: "Read" }])),
    ].join("\n") + "\n",
  );
  const subDir = subagentsDirFor(mgr);
  mkdirSync(subDir, { recursive: true });
  writeFileSync(
    join(subDir, "agent-1.jsonl"),
    JSON.stringify(assistant("2026-06-23T02:12:00.000Z", { input_tokens: 200, output_tokens: 40 }, [{ name: "Bash" }, { name: "Edit" }])) + "\n",
  );
  // Open-ended window (live-run semantics): the birthtime pre-filter only
  // bounds the start, so a subagent file created "now" with in-window entries
  // is included. (A terminal run with a past end is exercised via the
  // foldTranscriptEntry window-gate test above, which doesn't depend on the
  // file's real birthtime.)
  const s = foldRunStatsFromTranscript(mgr, "2026-06-23T02:00:00.000Z", null);
  expect(s.input_tokens).toBe(350); // 100 + 50 + 200
  expect(s.output_tokens).toBe(70); // 20 + 10 + 40
  expect(s.tools_called).toBe(4); // Agent + Read + Bash + Edit
  expect(s.agents_spawned).toBe(1);
});

test("foldRunStatsFromTranscript: missing transcript → zeroed stats (no throw)", () => {
  const s = foldRunStatsFromTranscript("C:/nope/missing.jsonl", null, null);
  expect(s).toEqual(emptyTranscriptRunStats());
  expect(foldRunStatsFromTranscript(null, null, null)).toEqual(emptyTranscriptRunStats());
});

test("indexRunTranscripts: keeps earliest start_ts per run, skips no-transcript records", () => {
  const text = [
    JSON.stringify({ run_id: "r1", transcript_path: "/late.jsonl", start_ts: "2026-06-23T02:05:00.000Z", kind: "subagent" }),
    JSON.stringify({ run_id: "r1", transcript_path: "/early.jsonl", start_ts: "2026-06-23T02:00:00.000Z", kind: "chain-controller" }),
    JSON.stringify({ run_id: "r2", transcript_path: null, start_ts: "2026-06-23T02:00:00.000Z", kind: "chain-controller" }),
    "not json",
  ].join("\n");
  const idx = indexRunTranscripts(text);
  expect(idx.get("r1")?.transcript_path).toBe("/early.jsonl");
  expect(idx.has("r2")).toBe(false); // no transcript_path
});

test("indexRunTranscripts: project_root filter", () => {
  const text = [
    JSON.stringify({ run_id: "r1", transcript_path: "/a.jsonl", start_ts: "t", project_root: "/projA" }),
    JSON.stringify({ run_id: "r2", transcript_path: "/b.jsonl", start_ts: "t", project_root: "/projB" }),
  ].join("\n");
  const idx = indexRunTranscripts(text, "/projA");
  expect(idx.has("r1")).toBe(true);
  expect(idx.has("r2")).toBe(false);
});

// --- collectRunToolFailures (/api/run-failures fold) ------------------------

test("collectFailuresFromFile: resolves tool name + input from the preceding tool_use", () => {
  const root = mkdtempSync(join(tmpdir(), "tfail-"));
  created.push(root);
  const f = join(root, "sess.jsonl");
  writeFileSync(
    f,
    [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-23T02:10:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "exit 1" } },
            { type: "tool_use", id: "tu_2", name: "Read", input: { file_path: "/ok" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-06-23T02:10:05.000Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", is_error: true, content: "command failed: exit 1" },
            { type: "tool_result", tool_use_id: "tu_2", is_error: false, content: "fine" },
          ],
        },
      }),
    ].join("\n") + "\n",
    "utf-8",
  );
  const { failures, truncated } = collectRunToolFailures(f, null, null);
  expect(truncated).toBe(false);
  expect(failures.length).toBe(1);
  expect(failures[0].tool_name).toBe("Bash");
  expect(failures[0].input_excerpt).toContain("exit 1");
  expect(failures[0].error_excerpt).toBe("command failed: exit 1");
  expect(failures[0].source).toBe("manager");
  expect(failures[0].ts).toBe("2026-06-23T02:10:05.000Z");
});

test("collectRunToolFailures: window-gates failures but resolves pre-window tool_use names", () => {
  const root = mkdtempSync(join(tmpdir(), "tfail-"));
  created.push(root);
  const f = join(root, "sess.jsonl");
  const use = (id: string, name: string, ts: string) =>
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
    });
  const fail = (id: string, ts: string, msg: string) =>
    JSON.stringify({
      type: "user",
      timestamp: ts,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: [{ type: "text", text: msg }] }] },
    });
  writeFileSync(
    f,
    [
      use("a", "Edit", "2026-06-23T01:00:00.000Z"),
      fail("a", "2026-06-23T01:00:01.000Z", "out of window"),
      use("b", "Bash", "2026-06-23T02:29:00.000Z"),
      fail("b", "2026-06-23T02:30:00.000Z", "in window"),
    ].join("\n") + "\n",
    "utf-8",
  );
  const { failures } = collectRunToolFailures(f, "2026-06-23T02:00:00.000Z", "2026-06-23T03:00:00.000Z");
  expect(failures.length).toBe(1);
  expect(failures[0].tool_name).toBe("Bash");
  expect(failures[0].error_excerpt).toBe("in window");
});

test("collectRunToolFailures: includes subagent files, sorts chronologically, caps + flags truncation", () => {
  const root = mkdtempSync(join(tmpdir(), "tfail-"));
  created.push(root);
  const mgr = join(root, "sess.jsonl");
  const fail = (id: string, ts: string, msg: string) =>
    JSON.stringify({
      type: "user",
      timestamp: ts,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: msg }] },
    });
  writeFileSync(mgr, fail("m1", "2026-06-23T02:20:00.000Z", "mgr fail") + "\n", "utf-8");
  const subDir = subagentsDirFor(mgr);
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, "agent-1.jsonl"), fail("s1", "2026-06-23T02:10:00.000Z", "sub fail") + "\n", "utf-8");
  const { failures } = collectRunToolFailures(mgr, "2026-06-23T02:00:00.000Z", null);
  expect(failures.map((f) => f.error_excerpt)).toEqual(["sub fail", "mgr fail"]);
  expect(failures[0].source).toBe("subagent");
  expect(failures[1].source).toBe("manager");
  // Unknown tool_use_id → null name, still captured.
  expect(failures[0].tool_name).toBeNull();

  // Cap: ask for at most 1 → truncated flag set.
  const capped = collectRunToolFailures(mgr, "2026-06-23T02:00:00.000Z", null, 1);
  expect(capped.failures.length).toBe(1);
  expect(capped.truncated).toBe(true);
});

test("collectRunToolFailures: null transcript → empty, not-flagged", () => {
  const out = collectRunToolFailures(null, null, null);
  expect(out.failures).toEqual([]);
  expect(out.truncated).toBe(false);
});

// --- collectRunBreakdown (/api/run-breakdown fold) ---------------------------

import { collectRunBreakdown } from "../transcript-stats.ts";

test("collectRunBreakdown: per-tool aggregates with durations + agent rows with matched-file token folds", () => {
  const root = mkdtempSync(join(tmpdir(), "tbreak-"));
  created.push(root);
  const mgr = join(root, "sess.jsonl");
  const use = (id: string, name: string, ts: string, input: unknown = {}) =>
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    });
  const result = (id: string, ts: string, isError = false) =>
    JSON.stringify({
      type: "user",
      timestamp: ts,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "r" }] },
    });
  writeFileSync(
    mgr,
    [
      // Two Bash calls: 5s ok + 2s failed.
      use("b1", "Bash", "2026-06-23T02:10:00.000Z", { command: "build" }),
      result("b1", "2026-06-23T02:10:05.000Z"),
      use("b2", "Bash", "2026-06-23T02:11:00.000Z", { command: "test" }),
      result("b2", "2026-06-23T02:11:02.000Z", true),
      // One Agent spawn (10s in the parent's view).
      use("a1", "Agent", "2026-06-23T02:12:00.000Z", { subagent_type: "step-executor", description: "run step 01" }),
      result("a1", "2026-06-23T02:12:10.000Z"),
    ].join("\n") + "\n",
    "utf-8",
  );
  // The spawned agent's own transcript: first entry right after the spawn.
  const subDir = subagentsDirFor(mgr);
  mkdirSync(subDir, { recursive: true });
  writeFileSync(
    join(subDir, "agent-1.jsonl"),
    [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-23T02:12:01.000Z",
        message: {
          role: "assistant",
          usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 },
          content: [{ type: "tool_use", id: "s1", name: "Read", input: { file_path: "/x" } }],
        },
      }),
      result("s1", "2026-06-23T02:12:03.000Z"),
    ].join("\n") + "\n",
    "utf-8",
  );

  const out = collectRunBreakdown(mgr, "2026-06-23T02:00:00.000Z", null);
  // Aggregates: Bash 2 calls / 1 failed / 7s total, Agent 1 call, Read 1 call (from the subagent file).
  const bash = out.tools.find((t) => t.name === "Bash")!;
  expect(bash.calls).toBe(2);
  expect(bash.failed).toBe(1);
  expect(bash.total_duration_ms).toBe(7000);
  expect(bash.max_duration_ms).toBe(5000);
  const read = out.tools.find((t) => t.name === "Read")!;
  expect(read.calls).toBe(1);
  expect(read.total_duration_ms).toBe(2000);
  // Individual calls are chronological and carry durations + sources.
  expect(out.calls_truncated).toBe(false);
  const b1 = out.calls.find((c) => c.input_excerpt?.includes("build"))!;
  expect(b1.duration_ms).toBe(5000);
  expect(b1.source).toBe("manager");
  expect(out.calls.find((c) => c.tool_name === "Read")!.source).toBe("subagent");
  // Agent row: type/description from the spawn input, duration from the
  // parent's tool_use→tool_result pair, tokens from the matched file's fold.
  expect(out.agents.length).toBe(1);
  const a = out.agents[0];
  expect(a.agent_type).toBe("step-executor");
  expect(a.description).toBe("run step 01");
  expect(a.duration_ms).toBe(10_000);
  expect(a.matched).toBe(true);
  expect(a.input_tokens).toBe(100);
  expect(a.output_tokens).toBe(40);
  expect(a.cache_read_tokens).toBe(7);
  expect(a.cache_creation_tokens).toBe(3);
  expect(a.tools_called).toBe(1);
});

test("collectRunBreakdown: unmatched spawn (no plausible file) is flagged, not zero-attributed", () => {
  const root = mkdtempSync(join(tmpdir(), "tbreak-"));
  created.push(root);
  const mgr = join(root, "sess.jsonl");
  writeFileSync(
    mgr,
    [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-23T02:10:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "a1", name: "Task", input: { subagent_type: "explorer", prompt: "look around the repo" } }],
        },
      }),
    ].join("\n") + "\n",
    "utf-8",
  );
  const out = collectRunBreakdown(mgr, null, null);
  expect(out.agents.length).toBe(1);
  expect(out.agents[0].matched).toBe(false);
  expect(out.agents[0].agent_type).toBe("explorer");
  // Prompt excerpt stands in for a missing description.
  expect(out.agents[0].description).toContain("look around");
  // No result landed → duration unknown.
  expect(out.agents[0].duration_ms).toBeNull();
});

test("collectRunBreakdown: null transcript → empty", () => {
  const out = collectRunBreakdown(null, null, null);
  expect(out.tools).toEqual([]);
  expect(out.agents).toEqual([]);
  expect(out.calls_truncated).toBe(false);
});
