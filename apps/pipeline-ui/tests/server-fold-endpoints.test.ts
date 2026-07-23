/**
 * /api/run-stats-batch + /api/run-step-stats — apps/pipeline-ui/server.ts
 * (design 07, edge case E9).
 *
 *   bun test tests/server-fold-endpoints.test.ts
 *
 * These two endpoints exist so the LIST and PER-STEP surfaces can show the
 * same transcript-grade numbers the run-level panel already does, instead of
 * the hook-event fold that undercounts. The load-bearing property is SLICING:
 * a step's numbers must contain only what happened inside that step's window.
 *
 * Own daemon with both the state dir and the home dir redirected at temp dirs
 * (transcript resolution reads the mirror-bindings file under the user home).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";

const TEST_HOME = mkdtempSync(join(tmpdir(), "pui-fe-state-"));
const FAKE_USER_HOME = mkdtempSync(join(tmpdir(), "pui-fe-home-"));
const LOCK_PATH = join(TEST_HOME, "daemon.lock");

let daemon: Subprocess | null = null;
let baseUrl = "";
let projectRoot = "";
let projectId = "";

const RUN_A = "foldruna01";
const RUN_B = "foldrunb01";

/** Step A runs 10:00:00→10:00:30, step B 10:00:40→10:01:10 — disjoint windows
 *  so a leaked call is unmistakable. */
const t = (s: string) => `2026-07-22T10:${s}.000Z`;

function journal(): string {
  return join(projectRoot, ".claude", "pipeline", ".runtime", "events.jsonl");
}

function ev(runId: string, type: string, data: Record<string, unknown>, ts: string): string {
  return (
    JSON.stringify({
      schema: 4,
      ts,
      type,
      project_root: projectRoot,
      worktree: null,
      run_id: runId,
      parent_run_id: null,
      session_id: null,
      data,
    }) + "\n"
  );
}

const assistantWithTool = (ts: string, id: string, input: number, output: number) =>
  JSON.stringify({
    timestamp: ts,
    message: {
      role: "assistant",
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: "tool_use", id, name: "Bash", input: { command: "x" } }],
    },
  });
const toolOk = (ts: string, id: string) =>
  JSON.stringify({
    timestamp: ts,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: "ok" }] },
  });

function bindTranscript(runId: string, lines: string[]): void {
  const dir = join(FAKE_USER_HOME, "transcripts");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${runId}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n", "utf-8");
  mkdirSync(join(FAKE_USER_HOME, ".claude", "pipeline-ui"), { recursive: true });
  appendFileSync(
    join(FAKE_USER_HOME, ".claude", "pipeline-ui", "active-mirror-bindings.jsonl"),
    JSON.stringify({
      schema: 1,
      run_id: runId,
      transcript_path: p,
      start_ts: t("00:00"),
      kind: "chain-controller",
      project_root: projectRoot,
    }) + "\n",
    "utf-8",
  );
}

interface StatsShape {
  tools_called: number;
  input_tokens: number;
  output_tokens: number;
}

async function waitForHealth(maxMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const txt = await Bun.file(LOCK_PATH).text();
      if (txt.trim()) {
        const lock = JSON.parse(txt);
        if ((await fetch(`http://${lock.host}:${lock.port}/api/health`)).ok) {
          baseUrl = `http://${lock.host}:${lock.port}`;
          return;
        }
      }
    } catch {
      /* keep polling */
    }
    await Bun.sleep(150);
  }
  throw new Error("fold-endpoint daemon never became healthy");
}

beforeAll(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), "pui-fe-proj-"));
  mkdirSync(join(projectRoot, ".claude", "pipeline", "alpha", "steps"), { recursive: true });
  writeFileSync(
    join(projectRoot, ".claude", "pipeline", "alpha", "PIPELINE.md"),
    "# Pipeline: alpha\n\n## End State\nDone.\n",
    "utf-8",
  );
  mkdirSync(join(projectRoot, ".claude", "pipeline", ".runtime"), { recursive: true });
  writeFileSync(journal(), "", "utf-8");

  // Run A: two steps with disjoint windows.
  appendFileSync(journal(), ev(RUN_A, "pipeline.started", { pipeline_name: "alpha" }, t("00:00")), "utf-8");
  appendFileSync(
    journal(),
    ev(RUN_A, "iteration.started", { iteration_path: "/p/alpha/steps/01-a.md", index: 1, step_id: "01-a" }, t("00:00")),
    "utf-8",
  );
  appendFileSync(
    journal(),
    ev(
      RUN_A,
      "iteration.completed",
      { iteration_path: "/p/alpha/steps/01-a.md", outcome: "completed", next_iteration_path: "/p/alpha/steps/02-b.md", step_id: "01-a" },
      t("00:30"),
    ),
    "utf-8",
  );
  appendFileSync(
    journal(),
    ev(RUN_A, "iteration.started", { iteration_path: "/p/alpha/steps/02-b.md", index: 2, step_id: "02-b" }, t("00:40")),
    "utf-8",
  );
  appendFileSync(
    journal(),
    ev(
      RUN_A,
      "iteration.completed",
      { iteration_path: "/p/alpha/steps/02-b.md", outcome: "completed", next_iteration_path: null, terminal: true, step_id: "02-b" },
      t("01:10"),
    ),
    "utf-8",
  );
  appendFileSync(journal(), ev(RUN_A, "pipeline.completed", { pipeline_name: "alpha" }, t("01:10")), "utf-8");

  // One tool call + 100/10 tokens inside step A; two calls + 200/20 in step B.
  bindTranscript(RUN_A, [
    assistantWithTool(t("00:10"), "a1", 100, 10),
    toolOk(t("00:12"), "a1"),
    assistantWithTool(t("00:45"), "b1", 100, 10),
    toolOk(t("00:46"), "b1"),
    assistantWithTool(t("00:50"), "b2", 100, 10),
    toolOk(t("00:51"), "b2"),
  ]);

  // Run B: a single step, for the batch test.
  appendFileSync(journal(), ev(RUN_B, "pipeline.started", { pipeline_name: "alpha" }, t("00:00")), "utf-8");
  appendFileSync(
    journal(),
    ev(RUN_B, "iteration.started", { iteration_path: "/p/alpha/steps/01-a.md", index: 1, step_id: "01-a" }, t("00:00")),
    "utf-8",
  );
  bindTranscript(RUN_B, [assistantWithTool(t("00:05"), "c1", 7, 3), toolOk(t("00:06"), "c1")]);

  daemon = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "..", "server.ts")],
    cwd: projectRoot,
    env: {
      ...process.env,
      PIPELINE_UI_HOME: TEST_HOME,
      PIPELINE_UI_DEBUG: "0",
      USERPROFILE: FAKE_USER_HOME,
      HOME: FAKE_USER_HOME,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForHealth();
  const reg = await fetch(`${baseUrl}/api/register-cwd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: projectRoot }),
  });
  projectId = ((await reg.json()) as { project_id: string }).project_id;
});

afterAll(async () => {
  if (daemon) {
    daemon.kill();
    try {
      await daemon.exited;
    } catch {
      /* ignore */
    }
  }
  for (const d of [TEST_HOME, FAKE_USER_HOME, projectRoot]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("/api/run-step-stats", () => {
  test("slices the fold per step window — out-of-window calls are excluded", async () => {
    const r = await fetch(`${baseUrl}/api/run-step-stats?project_id=${projectId}&run_id=${RUN_A}`);
    expect(r.ok).toBe(true);
    const body = (await r.json()) as {
      transcript_found: boolean;
      steps: { step_id: string | null; rel: string | null; stats: StatsShape }[];
    };
    expect(body.transcript_found).toBe(true);

    const byId = new Map(body.steps.map((s) => [s.step_id, s.stats]));
    // Step A's window holds exactly one call; step B's holds two. A naive
    // whole-run fold would report 3 for both.
    expect(byId.get("01-a")!.tools_called).toBe(1);
    expect(byId.get("01-a")!.input_tokens).toBe(100);
    expect(byId.get("02-b")!.tools_called).toBe(2);
    expect(byId.get("02-b")!.input_tokens).toBe(200);
  });

  test("carries the tree's rel key for each step", async () => {
    const r = await fetch(`${baseUrl}/api/run-step-stats?project_id=${projectId}&run_id=${RUN_A}`);
    const body = (await r.json()) as { steps: { rel: string | null }[] };
    expect(body.steps.map((s) => s.rel).sort()).toEqual(["01-a.md", "02-b.md"]);
  });

  test("a run with no transcript reports transcript_found:false and zeroed slices", async () => {
    const r = await fetch(`${baseUrl}/api/run-step-stats?project_id=${projectId}&run_id=nosuchrun01`);
    const body = (await r.json()) as { transcript_found: boolean; steps: unknown[] };
    expect(body.transcript_found).toBe(false);
    expect(body.steps).toEqual([]);
  });

  test("400 without params, 404 for an unknown project", async () => {
    expect((await fetch(`${baseUrl}/api/run-step-stats?project_id=${projectId}`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/run-step-stats?project_id=nope&run_id=${RUN_A}`)).status).toBe(404);
  });
});

describe("/api/run-stats-batch", () => {
  test("returns one fold per requested run", async () => {
    const r = await fetch(`${baseUrl}/api/run-stats-batch?project_id=${projectId}&runs=${RUN_A},${RUN_B}`);
    expect(r.ok).toBe(true);
    const { stats } = (await r.json()) as { stats: Record<string, StatsShape> };
    expect(stats[RUN_A]!.tools_called).toBe(3); // whole run, both steps
    expect(stats[RUN_B]!.tools_called).toBe(1);
    expect(stats[RUN_B]!.input_tokens).toBe(7);
  });

  test("agrees with the single-run endpoint (same cached computation)", async () => {
    const single = await (await fetch(`${baseUrl}/api/run-stats?project_id=${projectId}&run_id=${RUN_A}`)).json();
    const { stats } = (await (
      await fetch(`${baseUrl}/api/run-stats-batch?project_id=${projectId}&runs=${RUN_A}`)
    ).json()) as { stats: Record<string, unknown> };
    expect(stats[RUN_A]).toEqual(single);
  });

  test("duplicate ids collapse; an unknown id yields a zeroed entry, never an error", async () => {
    const { stats } = (await (
      await fetch(`${baseUrl}/api/run-stats-batch?project_id=${projectId}&runs=${RUN_A},${RUN_A},ghostrun0001`)
    ).json()) as { stats: Record<string, StatsShape> };
    expect(Object.keys(stats).sort()).toEqual([RUN_A, "ghostrun0001"].sort());
    expect(stats.ghostrun0001!.tools_called).toBe(0);
  });

  test("400 without params, 404 for an unknown project", async () => {
    expect((await fetch(`${baseUrl}/api/run-stats-batch?project_id=${projectId}`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/run-stats-batch?project_id=nope&runs=${RUN_A}`)).status).toBe(404);
  });
});
