/**
 * HTTP integration tests — spin up a real daemon on an ephemeral port,
 * hit every public endpoint via fetch, then tear down. Skips /api/chat
 * because that one needs the Agent SDK installed + an Anthropic key.
 *
 *   bun test tests/server.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";

// Isolate this suite's daemon onto its own state dir (lock + hash-derived seed
// port) so it never collides with — or accidentally attaches to — a real
// daemon already running on this machine, and can run in parallel with the
// other daemon suites.
const TEST_HOME = mkdtempSync(join(tmpdir(), "pui-srv-home-"));
const LOCK_PATH = join(TEST_HOME, "daemon.lock");

let daemon: Subprocess | null = null;
let baseUrl = "";
let projectRoot = "";
let projectId = "";

interface HealthBody {
  ok: boolean;
  plugin_version: string;
  schema: number;
  pid: number;
  uptime_seconds: number;
  projects: number;
  clients: number;
}

async function waitForLock(maxMs = 8000): Promise<HealthBody> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const txt = await Bun.file(LOCK_PATH).text();
      if (txt.trim()) {
        const lock = JSON.parse(txt);
        const r = await fetch(`http://${lock.host}:${lock.port}/api/health`);
        if (r.ok) {
          baseUrl = `http://${lock.host}:${lock.port}`;
          return (await r.json()) as HealthBody;
        }
      }
    } catch {
      /* keep polling */
    }
    await Bun.sleep(150);
  }
  throw new Error("daemon never became healthy");
}

beforeAll(async () => {
  // Build a tiny fixture project: one flat pipeline, one nested pipeline,
  // and a pre-seeded events.jsonl so /api/state has data to return.
  const tmp = mkdtempSync(join(tmpdir(), "pipeline-ui-srv-"));
  projectRoot = tmp;
  const pipeRoot = join(tmp, ".claude", "pipeline");

  mkdirSync(join(pipeRoot, "alpha", "steps"), { recursive: true });
  writeFileSync(
    join(pipeRoot, "alpha", "PIPELINE.md"),
    "# Pipeline: alpha\n\n## End State\nAlpha done.\n",
    "utf-8",
  );
  writeFileSync(
    join(pipeRoot, "alpha", "steps", "01-warmup.md"),
    "# 01 — Warmup\n## Goal\nWarm up.\n## Steps\n1. Step one\n## Next\nIteration 02.\n",
    "utf-8",
  );
  writeFileSync(
    join(pipeRoot, "alpha", "steps", "02-cooldown.md"),
    "# 02 — Cooldown\n## Goal\nCool down.\n",
    "utf-8",
  );

  mkdirSync(join(pipeRoot, "workflows", "beta", "steps"), { recursive: true });
  writeFileSync(
    join(pipeRoot, "workflows", "beta", "PIPELINE.md"),
    "# Pipeline: beta\n\n## End State\nBeta complete.\n",
    "utf-8",
  );
  writeFileSync(
    join(pipeRoot, "workflows", "beta", "steps", "01-go.md"),
    "# 01 — Go\n## Goal\nDo the thing.\n",
    "utf-8",
  );

  // Pre-seed an event so /api/state has at least one journal entry.
  mkdirSync(join(pipeRoot, ".runtime"), { recursive: true });
  appendFileSync(
    join(pipeRoot, ".runtime", "events.jsonl"),
    JSON.stringify({
      schema: 1,
      ts: new Date().toISOString(),
      type: "session.opened",
      project_root: tmp,
      worktree: null,
      run_id: null,
      parent_run_id: null,
      session_id: "test",
      data: { claude_pid: -1 },
    }) + "\n",
    "utf-8",
  );

  // Spawn the daemon. We don't have a real plugin install; the daemon writes
  // its lock to the real ~/.claude/pipeline-ui/. If a daemon is already
  // running there our spawn will detect the orphan via probe-and-exit (or
  // wait via isExistingDaemonAlive) — for a clean test run, expect no other
  // daemon. We use the source-tree server.ts.
  // `process.execPath` is whatever bun binary is running the tests; this
  // avoids relying on `bun` being on the spawned process's PATH (it isn't
  // when bun is installed via the npm shim on Windows).
  daemon = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "..", "server.ts")],
    cwd: projectRoot,
    env: { ...process.env, PIPELINE_UI_HOME: TEST_HOME, PIPELINE_UI_DEBUG: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for the lock file (or recovered lock).
  const health = await waitForLock();
  expect(health.ok).toBe(true);

  // Register the fixture project so /api/state etc. work.
  const reg = await fetch(`${baseUrl}/api/register-cwd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: projectRoot }),
  });
  expect(reg.ok).toBe(true);
  const regBody = (await reg.json()) as { project_id: string };
  projectId = regBody.project_id;
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
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

describe("daemon HTTP surface", () => {
  test("/api/health returns version, pid, schema", async () => {
    const r = await fetch(`${baseUrl}/api/health`);
    expect(r.ok).toBe(true);
    const j = (await r.json()) as HealthBody;
    expect(j.ok).toBe(true);
    expect(typeof j.plugin_version).toBe("string");
    // Schema v4 — see EVENTS.md. v1/v2/v3 events are still parsed (the
    // pre-seeded session.opened fixture above uses schema:1) but /api/health
    // advertises the current SCHEMA_VERSION the daemon produces.
    expect(j.schema).toBe(4);
    expect(typeof j.pid).toBe("number");
  });

  test("/api/projects lists the registered fixture", async () => {
    const r = await fetch(`${baseUrl}/api/projects`);
    const j = (await r.json()) as { projects: { project_id: string }[] };
    expect(j.projects.some((p) => p.project_id === projectId)).toBe(true);
  });

  test("/api/register-cwd is idempotent and resolves project_root", async () => {
    const r = await fetch(`${baseUrl}/api/register-cwd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: projectRoot }),
    });
    const j = (await r.json()) as { project_id: string; project_root: string };
    expect(j.project_id).toBe(projectId);
    // Normalize slashes; on Windows the server returns backslashes.
    expect(j.project_root.replaceAll("\\", "/")).toBe(projectRoot.replaceAll("\\", "/"));
  });

  test("/api/state surfaces pipelines and recent events", async () => {
    const r = await fetch(
      `${baseUrl}/api/state?project_id=${encodeURIComponent(projectId)}`,
    );
    expect(r.ok).toBe(true);
    const j = (await r.json()) as {
      pipelines: { pipeline_name: string }[];
      events: { type: string }[];
    };
    const names = j.pipelines.map((p) => p.pipeline_name).sort();
    expect(names).toEqual(["alpha", "beta"]);
    expect(j.events.length).toBeGreaterThan(0);
    expect(j.events.at(0)?.type).toBe("session.opened");
  });

  test("/api/pipeline returns one pipeline's metadata", async () => {
    const r = await fetch(
      `${baseUrl}/api/pipeline?project_id=${projectId}&name=alpha`,
    );
    const j = (await r.json()) as { iterations: string[]; end_state: string };
    expect(j.iterations).toEqual(["01-warmup.md", "02-cooldown.md"]);
    expect(j.end_state).toBe("Alpha done.");
  });

  test("/api/iteration parses sections", async () => {
    const r = await fetch(
      `${baseUrl}/api/iteration?project_id=${projectId}&name=alpha&rel=01-warmup.md`,
    );
    expect(r.ok).toBe(true);
    const j = (await r.json()) as {
      title: string;
      sections: { heading: string }[];
    };
    expect(j.title).toBe("01 — Warmup");
    expect(j.sections.map((s) => s.heading)).toEqual(["Goal", "Steps", "Next"]);
  });

  test("/api/iteration rejects path traversal", async () => {
    const r = await fetch(
      `${baseUrl}/api/iteration?project_id=${projectId}&name=alpha&rel=${encodeURIComponent("../../../../etc/passwd")}`,
    );
    expect(r.status).toBe(400);
  });

  test("/api/iteration rejects unknown pipeline", async () => {
    const r = await fetch(
      `${baseUrl}/api/iteration?project_id=${projectId}&name=nonexistent&rel=01.md`,
    );
    expect(r.status).toBe(404);
  });

  test("/api/iteration finds files under a nested-category pipeline", async () => {
    const r = await fetch(
      `${baseUrl}/api/iteration?project_id=${projectId}&name=beta&rel=01-go.md`,
    );
    expect(r.ok).toBe(true);
    const j = (await r.json()) as { title: string };
    expect(j.title).toBe("01 — Go");
  });

  test("unknown route returns 404", async () => {
    const r = await fetch(`${baseUrl}/api/does-not-exist`);
    expect(r.status).toBe(404);
  });

  test("/api/stream opens an SSE connection and emits hello", async () => {
    const ac = new AbortController();
    const r = await fetch(`${baseUrl}/api/stream`, { signal: ac.signal });
    expect(r.ok).toBe(true);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sawHello = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !sawHello) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes("event: hello")) sawHello = true;
    }
    ac.abort();
    expect(sawHello).toBe(true);
  });

  test("SSE connection survives past Bun's old 10s idle timeout", async () => {
    // Regression guard: the daemon must set idleTimeout:0 on Bun.serve.
    // With Bun's 10s default, the SSE stream (heartbeat only every 25s) was
    // force-closed at ~10s, so every browser's live feed dropped + reconnected
    // every ~10s and the dashboard stayed stale. Hold a stream open for >11s
    // and assert it does NOT close on its own.
    const ac = new AbortController();
    const r = await fetch(`${baseUrl}/api/stream`, { signal: ac.signal });
    const reader = r.body!.getReader();

    // Keep reading until a deadline past the old 10s window. Any `done:true`
    // before the deadline means the server closed the stream on its own (the
    // bug). Data frames (hello / heartbeat / broadcasts) are fine — keep
    // going. Looping (rather than a single read) makes this robust to any
    // data arriving on the stream before the deadline. We end the loop by
    // aborting, which rejects the pending read (swallowed).
    const deadlineAt = Date.now() + 11500;
    let closedEarly = false;
    const pump = (async () => {
      try {
        while (Date.now() < deadlineAt) {
          const { done } = await reader.read();
          if (done) { closedEarly = true; return; }
        }
      } catch { /* abort-induced rejection */ }
    })();
    await new Promise((res) => setTimeout(res, 11500));
    ac.abort();
    await pump;
    expect(closedEarly).toBe(false);
  }, 20000);

  describe("/api/runs/dismiss", () => {
    test("validates body + project + run", async () => {
      const bad = await fetch(`${baseUrl}/api/runs/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId }),
      });
      expect(bad.status).toBe(400);

      const unknownProj = await fetch(`${baseUrl}/api/runs/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: "deadbeef0000", run_id: "x" }),
      });
      expect(unknownProj.status).toBe(404);

      const unknownRun = await fetch(`${baseUrl}/api/runs/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId, run_id: "nosuchrun99" }),
      });
      expect(unknownRun.status).toBe(404);
    });

    test("halts a non-terminal run so it leaves Active", async () => {
      // Seed a stuck run: pipeline.started + iteration.started, no terminal.
      const runId = "dismisstest1";
      const ev = (type: string, data: Record<string, unknown>) =>
        JSON.stringify({
          schema: 3,
          ts: new Date().toISOString(),
          type,
          project_root: projectRoot,
          worktree: null,
          run_id: runId,
          parent_run_id: null,
          session_id: null,
          data,
        }) + "\n";
      const journal = join(projectRoot, ".claude", "pipeline", ".runtime", "events.jsonl");
      appendFileSync(journal, ev("pipeline.started", { pipeline_name: "alpha", first_iteration_path: "x" }), "utf-8");
      appendFileSync(journal, ev("iteration.started", { iteration_path: "01-warmup.md", index: 1 }), "utf-8");

      // It should fold to a non-terminal status.
      let runs = (await (await fetch(`${baseUrl}/api/runs?project_id=${projectId}&limit=100`)).json()) as {
        runs: { run_id: string; status: string }[];
      };
      const before = runs.runs.find((r) => r.run_id === runId);
      expect(before).toBeDefined();
      expect(["running", "improving", "scripting", "polling-blocker", "unknown"]).toContain(before!.status);

      // Dismiss it.
      const d = await fetch(`${baseUrl}/api/runs/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId, run_id: runId }),
      });
      expect(d.ok).toBe(true);

      // Now it must fold to halted (cache was invalidated by the emit).
      runs = (await (await fetch(`${baseUrl}/api/runs?project_id=${projectId}&limit=100`)).json()) as {
        runs: { run_id: string; status: string }[];
      };
      const after = runs.runs.find((r) => r.run_id === runId);
      expect(after!.status).toBe("halted");
    });
  });

  describe("liveness sweep (dead-run detection)", () => {
    const journal = () => join(projectRoot, ".claude", "pipeline", ".runtime", "events.jsonl");
    const runsDir = () => join(projectRoot, ".claude", "pipeline", ".runtime", "runs");
    const seedRun = (runId: string) => {
      const ev = (type: string, data: Record<string, unknown>) =>
        JSON.stringify({
          schema: 3, ts: new Date().toISOString(), type,
          project_root: projectRoot, worktree: null, run_id: runId,
          parent_run_id: null, session_id: null, data,
        }) + "\n";
      appendFileSync(journal(), ev("pipeline.started", { pipeline_name: "alpha" }), "utf-8");
      appendFileSync(journal(), ev("iteration.started", { iteration_path: "01-warmup.md", index: 1 }), "utf-8");
    };
    const writeLock = (runId: string, pid: number) => {
      mkdirSync(runsDir(), { recursive: true });
      writeFileSync(join(runsDir(), `${runId}.alive`), JSON.stringify({ pid, run_id: runId }), "utf-8");
    };
    // Distinct limit per test → distinct cache key → guarantees a cache miss
    // so the sweep runs synchronously before the fold in /api/runs.
    const runsAt = async (limit: number) =>
      ((await (await fetch(`${baseUrl}/api/runs?project_id=${projectId}&limit=${limit}`)).json()) as {
        runs: { run_id: string; status: string }[];
      }).runs;

    test("retires a run whose driver pid is dead, and removes the lockfile", async () => {
      // A pid beyond any real process (≈2^31) — process.kill(pid,0) throws
      // ESRCH, so it's reliably "dead" with no pid-reuse flakiness.
      const deadPid = 2_147_480_000;

      const runId = "livedead01";
      seedRun(runId);
      writeLock(runId, deadPid);

      const runs = await runsAt(151);
      expect(runs.find((r) => r.run_id === runId)?.status).toBe("halted");
      expect(existsSync(join(runsDir(), `${runId}.alive`))).toBe(false);
    });

    test("leaves a run whose driver pid is alive", async () => {
      const runId = "livealive1";
      seedRun(runId);
      writeLock(runId, process.pid); // the test runner — definitely alive

      const runs = await runsAt(152);
      expect(runs.find((r) => r.run_id === runId)?.status).not.toBe("halted");
    });

    test("ignores an untrustworthy pid (<=1)", async () => {
      const runId = "livepid1";
      seedRun(runId);
      writeLock(runId, 1); // sandbox-style $PPID — never conclusively dead

      const runs = await runsAt(153);
      expect(runs.find((r) => r.run_id === runId)?.status).not.toBe("halted");
      // lockfile must be left in place (we couldn't conclude it's dead)
      expect(existsSync(join(runsDir(), `${runId}.alive`))).toBe(true);
    });

    test("does NOT re-halt a COMPLETED run with a stale dead lockfile; drops the leftover", async () => {
      const runId = "livedone01";
      const ev = (type: string, data: Record<string, unknown>) =>
        JSON.stringify({
          schema: 3, ts: new Date().toISOString(), type,
          project_root: projectRoot, worktree: null, run_id: runId,
          parent_run_id: null, session_id: null, data,
        }) + "\n";
      appendFileSync(journal(), ev("pipeline.started", { pipeline_name: "alpha" }), "utf-8");
      appendFileSync(journal(), ev("iteration.started", { iteration_path: "01-warmup.md", index: 1 }), "utf-8");
      appendFileSync(journal(), ev("iteration.completed", { iteration_path: "01-warmup.md", outcome: "completed", next_iteration_path: null, terminal: true }), "utf-8");
      appendFileSync(journal(), ev("pipeline.completed", { pipeline_name: "alpha" }), "utf-8");
      // Stale lockfile with a dead pid left behind (clear-liveness never ran).
      writeLock(runId, 2_147_480_000);

      const runs = await runsAt(154);
      // Must stay completed — NOT re-labeled halted/abandoned.
      expect(runs.find((r) => r.run_id === runId)?.status).toBe("completed");
      // The leftover lockfile is dropped without emitting a halt.
      expect(existsSync(join(runsDir(), `${runId}.alive`))).toBe(false);
    });
  });

  describe("manager.stopped dead-run detection (event-driven, Phase 2)", () => {
    const journal = () => join(projectRoot, ".claude", "pipeline", ".runtime", "events.jsonl");
    const runsDir = () => join(projectRoot, ".claude", "pipeline", ".runtime", "runs");
    const ev = (runId: string, type: string, data: Record<string, unknown>) =>
      JSON.stringify({
        schema: 3, ts: new Date().toISOString(), type,
        project_root: projectRoot, worktree: null, run_id: runId,
        parent_run_id: null, session_id: null, data,
      }) + "\n";
    const writeLock = (runId: string, pid: number) => {
      mkdirSync(runsDir(), { recursive: true });
      writeFileSync(join(runsDir(), `${runId}.alive`), JSON.stringify({ pid, run_id: runId }), "utf-8");
    };
    const runsAt = async (limit: number) =>
      ((await (await fetch(`${baseUrl}/api/runs?project_id=${projectId}&limit=${limit}`)).json()) as {
        runs: { run_id: string; status: string; halt_reason: string | null }[];
      }).runs;

    test("(c) marks a run abandoned/halted when manager.stopped arrives with no terminal event", async () => {
      const runId = "mgrstop001";
      appendFileSync(journal(), ev(runId, "pipeline.started", { pipeline_name: "alpha", first_iteration_path: "x" }), "utf-8");
      appendFileSync(journal(), ev(runId, "iteration.started", { iteration_path: "01-warmup.md", index: 1 }), "utf-8");
      // The orchestrator stopped without a terminal event and wrote no lockfile.
      appendFileSync(journal(), ev(runId, "manager.stopped", { run_id: runId, agent_id: "agent_a" }), "utf-8");

      const runs = await runsAt(161);
      const r = runs.find((x) => x.run_id === runId);
      expect(r?.status).toBe("halted");
      expect(r?.halt_reason).toContain("abandoned");
    });

    test("does NOT halt a run that reached a terminal event before manager.stopped", async () => {
      const runId = "mgrstop002";
      appendFileSync(journal(), ev(runId, "pipeline.started", { pipeline_name: "alpha" }), "utf-8");
      appendFileSync(journal(), ev(runId, "pipeline.completed", { pipeline_name: "alpha" }), "utf-8");
      // manager.stopped arrives after the run already finished — must be a no-op.
      appendFileSync(journal(), ev(runId, "manager.stopped", { run_id: runId, agent_id: "agent_b" }), "utf-8");

      const runs = await runsAt(162);
      expect(runs.find((x) => x.run_id === runId)?.status).toBe("completed");
    });

    test("does NOT halt a run whose supervisor lockfile is still alive (Path-B blocker-wait)", async () => {
      const runId = "mgrstop003";
      appendFileSync(journal(), ev(runId, "pipeline.started", { pipeline_name: "alpha" }), "utf-8");
      appendFileSync(journal(), ev(runId, "manager.stopped", { run_id: runId, agent_id: "agent_c" }), "utf-8");
      // The /pipeline:run supervisor is still alive (the test runner pid) and
      // will re-spawn the manager after the nested-blocker resolves.
      writeLock(runId, process.pid);

      const runs = await runsAt(163);
      expect(runs.find((x) => x.run_id === runId)?.status).not.toBe("halted");
    });

    test("backward-compat: a journal with NO manager.stopped is untouched", async () => {
      const runId = "mgrstop004";
      appendFileSync(journal(), ev(runId, "pipeline.started", { pipeline_name: "alpha" }), "utf-8");
      appendFileSync(journal(), ev(runId, "iteration.started", { iteration_path: "01-warmup.md", index: 1 }), "utf-8");

      const runs = await runsAt(164);
      // No manager.stopped → the event-driven sweep emits nothing; the run
      // stays in its non-terminal state (cleared only by lockfile sweep or
      // dismiss).
      expect(runs.find((x) => x.run_id === runId)?.status).not.toBe("halted");
    });
  });
});
