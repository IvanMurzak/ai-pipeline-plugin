/**
 * Interrupt watchdog + stats backfill sweep — apps/pipeline-ui/server.ts
 * (design 06 / design 04 rung T4).
 *
 *   bun test tests/server-watchdog.test.ts
 *
 * Spins up its OWN daemon with both `PIPELINE_UI_HOME` and the home-dir env
 * (`USERPROFILE`/`HOME`) pointed at temp dirs — the watchdog resolves
 * transcripts through the mirror-bindings file, which lives under the user
 * home, and a test must never write into the real one.
 *
 * The sweeps fire on the /api/runs hot path (and a 60 s timer we don't wait
 * for), so each case seeds state and then reads /api/runs with a distinct
 * `limit` — a distinct cache key, guaranteeing the sweep runs before the fold.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";

const TEST_HOME = mkdtempSync(join(tmpdir(), "pui-wd-state-"));
const FAKE_USER_HOME = mkdtempSync(join(tmpdir(), "pui-wd-home-"));
const LOCK_PATH = join(TEST_HOME, "daemon.lock");

let daemon: Subprocess | null = null;
let baseUrl = "";
let projectRoot = "";
let projectId = "";

/** Old enough to clear WATCHDOG_QUIET_MS (30 s) — the sweep deliberately never
 *  probes a run that is still emitting events. */
const QUIET_AGO = () => new Date(Date.now() - 120_000).toISOString();

function bindingsPath(): string {
  return join(FAKE_USER_HOME, ".claude", "pipeline-ui", "active-mirror-bindings.jsonl");
}

function journalPath(): string {
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

/** A non-terminal run whose last event is old enough to be probed. */
function seedQuietRun(runId: string): void {
  const ts = QUIET_AGO();
  appendFileSync(journalPath(), ev(runId, "pipeline.started", { pipeline_name: "alpha" }, ts), "utf-8");
  appendFileSync(
    journalPath(),
    ev(runId, "iteration.started", { iteration_path: "01-warmup.md", index: 1 }, ts),
    "utf-8",
  );
}

/** Write a transcript for `runId` and bind it, so resolveRunTranscript finds it. */
function bindTranscript(runId: string, lines: string[]): string {
  const dir = join(FAKE_USER_HOME, "transcripts");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${runId}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n", "utf-8");
  mkdirSync(join(FAKE_USER_HOME, ".claude", "pipeline-ui"), { recursive: true });
  appendFileSync(
    bindingsPath(),
    JSON.stringify({
      schema: 1,
      run_id: runId,
      transcript_path: p,
      start_ts: QUIET_AGO(),
      kind: "chain-controller",
      project_root: projectRoot,
    }) + "\n",
    "utf-8",
  );
  return p;
}

const assistantAt = (ts: string) =>
  JSON.stringify({ timestamp: ts, type: "assistant", message: { role: "assistant", content: [] } });
const interruptAt = (ts: string) =>
  JSON.stringify({
    timestamp: ts,
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
  });

async function runsAt(limit: number): Promise<{ run_id: string; status: string; halt_reason?: string | null }[]> {
  const r = await fetch(`${baseUrl}/api/runs?project_id=${projectId}&limit=${limit}`);
  const text = await r.text();
  try {
    return (JSON.parse(text) as { runs: { run_id: string; status: string; halt_reason?: string | null }[] }).runs;
  } catch {
    throw new Error(`/api/runs ${r.status}: ${text.slice(0, 300)}`);
  }
}

async function waitForLock(maxMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const txt = await Bun.file(LOCK_PATH).text();
      if (txt.trim()) {
        const lock = JSON.parse(txt);
        const r = await fetch(`http://${lock.host}:${lock.port}/api/health`);
        if (r.ok) {
          baseUrl = `http://${lock.host}:${lock.port}`;
          return;
        }
      }
    } catch {
      /* keep polling */
    }
    await Bun.sleep(150);
  }
  throw new Error("watchdog daemon never became healthy");
}

beforeAll(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), "pui-wd-proj-"));
  const pipeRoot = join(projectRoot, ".claude", "pipeline");
  mkdirSync(join(pipeRoot, "alpha", "steps"), { recursive: true });
  writeFileSync(join(pipeRoot, "alpha", "PIPELINE.md"), "# Pipeline: alpha\n\n## End State\nDone.\n", "utf-8");
  writeFileSync(join(pipeRoot, "alpha", "steps", "01-warmup.md"), "# 01\n## Goal\nGo.\n", "utf-8");
  mkdirSync(join(pipeRoot, ".runtime"), { recursive: true });
  writeFileSync(journalPath(), "", "utf-8");

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

  await waitForLock();
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

describe("interrupt watchdog (Esc detection, design 06)", () => {
  test("retires a quiet run whose transcript ends in a pending interrupt", async () => {
    const runId = "wdinterrupt";
    seedQuietRun(runId);
    bindTranscript(runId, [assistantAt(QUIET_AGO()), interruptAt(QUIET_AGO())]);

    const run = (await runsAt(201)).find((r) => r.run_id === runId);
    expect(run?.status).toBe("halted");
    expect(run?.halt_reason).toContain("interrupted by user");
  });

  test("is idempotent — a second sweep does not append a second halt", async () => {
    const runId = "wdidem";
    seedQuietRun(runId);
    bindTranscript(runId, [assistantAt(QUIET_AGO()), interruptAt(QUIET_AGO())]);

    await runsAt(202);
    await runsAt(203);
    const halts = readFileSync(journalPath(), "utf-8")
      .split("\n")
      .filter((l) => l.includes(`"run_id":"${runId}"`) && l.includes('"pipeline.halted"'));
    expect(halts).toHaveLength(1);
  });

  test("leaves a run whose transcript shows activity AFTER the interrupt (resumed)", async () => {
    const runId = "wdresumed";
    seedQuietRun(runId);
    bindTranscript(runId, [
      assistantAt(new Date(Date.now() - 180_000).toISOString()),
      interruptAt(new Date(Date.now() - 150_000).toISOString()),
      assistantAt(new Date(Date.now() - 120_000).toISOString()),
    ]);

    expect((await runsAt(204)).find((r) => r.run_id === runId)?.status).not.toBe("halted");
  });

  test("leaves a run with no resolvable transcript (nothing to conclude from)", async () => {
    const runId = "wdnotranscript";
    seedQuietRun(runId);

    expect((await runsAt(205)).find((r) => r.run_id === runId)?.status).not.toBe("halted");
  });

  test("respects the quiet period — a still-emitting run is never probed", async () => {
    const runId = "wdnoisy";
    // Interrupted transcript, but the run emitted an event just now.
    bindTranscript(runId, [assistantAt(QUIET_AGO()), interruptAt(QUIET_AGO())]);
    const now = new Date().toISOString();
    appendFileSync(journalPath(), ev(runId, "pipeline.started", { pipeline_name: "alpha" }, now), "utf-8");
    appendFileSync(journalPath(), ev(runId, "iteration.started", { iteration_path: "01-warmup.md", index: 1 }, now), "utf-8");

    expect((await runsAt(206)).find((r) => r.run_id === runId)?.status).not.toBe("halted");
  });

  test("does not touch an already-terminal run", async () => {
    const runId = "wdterminal";
    const ts = QUIET_AGO();
    appendFileSync(journalPath(), ev(runId, "pipeline.started", { pipeline_name: "alpha" }, ts), "utf-8");
    appendFileSync(journalPath(), ev(runId, "pipeline.completed", { pipeline_name: "alpha" }, ts), "utf-8");
    bindTranscript(runId, [assistantAt(ts), interruptAt(ts)]);

    const run = (await runsAt(207)).find((r) => r.run_id === runId);
    expect(run?.status).toBe("completed"); // never re-labelled halted
  });
});
