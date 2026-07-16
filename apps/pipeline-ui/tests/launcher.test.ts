/**
 * Run-launcher integration tests — a real daemon + real `pipeline drive`
 * subprocesses, with the executor faked through the documented
 * PIPELINE_DRIVE_EXECUTOR_CMD template seam (the same canned-envelope fake
 * pipeline-cli's drive tests use). Covers: the /api/pipelines catalog, a
 * launch that runs to completion (task delivery + per-step model overrides),
 * the needs-input park → /api/runs/answer resume loop, and the containment
 * guard. Auth helpers are unit-tested directly (no second daemon needed).
 *
 *   bun test tests/launcher.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";
import { isInsidePipelinesDir, parseDriveFinal } from "../launcher";
import { checkAuth, maybeSetTokenCookie, resolveHostConfig } from "../auth";

const TEST_HOME = mkdtempSync(join(tmpdir(), "pui-launch-home-"));
const LOCK_PATH = join(TEST_HOME, "daemon.lock");

let daemon: Subprocess | null = null;
let baseUrl = "";
let projectRoot = "";
let projectId = "";
let demoRoot = "";
let askRoot = "";

// Same canned-envelope fake as pipeline-cli's drive tests: reads the spawn
// prompt on stdin, logs the call + argv, prints a prescribed claude JSON
// envelope from <pipeline-root>/canned/<step>.envelope[.n].json.
const ENVELOPE_EXECUTOR = `import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
const prompt = await Bun.stdin.text();
const m = /^step_record_file = (.+)$/m.exec(prompt);
if (!m) process.exit(9);
const recordFile = m[1].trim();
const root = dirname(dirname(dirname(dirname(recordFile))));
const stepId = basename(recordFile, '.json');
const canned = join(root, 'canned');
mkdirSync(canned, { recursive: true });
appendFileSync(join(canned, 'calls.log'), stepId + '\\n');
const n = readFileSync(join(canned, 'calls.log'), 'utf8').split('\\n').filter((l) => l === stepId).length;
writeFileSync(join(canned, 'prompt-' + stepId + '-' + n + '.txt'), prompt);
writeFileSync(join(canned, 'args-' + stepId + '-' + n + '.txt'), JSON.stringify(process.argv.slice(2)));
const perCall = join(canned, stepId + '.envelope.' + n + '.json');
const env = existsSync(perCall) ? perCall : join(canned, stepId + '.envelope.json');
if (!existsSync(env)) process.exit(7);
process.stdout.write(readFileSync(env, 'utf8'));
process.exit(0);
`;

function envelope(structured: unknown): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify(structured),
    session_id: "sess-x",
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    structured_output: structured,
  });
}

function canned(root: string, file: string, structured: unknown): void {
  mkdirSync(join(root, "canned"), { recursive: true });
  writeFileSync(join(root, "canned", file), envelope(structured), "utf8");
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
  throw new Error("daemon never became healthy");
}

interface DriveRunSnap {
  run_id: string;
  status: string;
  pipeline_name: string;
  question: { text: string; context: string | null; options: string[] | null } | null;
  awaiting_iteration: string | null;
  halt_reason: string | null;
}

async function pollRun(runId: string, until: (r: DriveRunSnap) => boolean, maxMs = 30_000): Promise<DriveRunSnap> {
  const start = Date.now();
  let last: DriveRunSnap | undefined;
  while (Date.now() - start < maxMs) {
    const r = await fetch(`${baseUrl}/api/drive-runs?project_id=${projectId}`);
    if (r.ok) {
      const j = (await r.json()) as { runs: DriveRunSnap[] };
      last = j.runs.find((x) => x.run_id === runId);
      if (last && until(last)) return last;
    }
    await Bun.sleep(200);
  }
  throw new Error(`run ${runId} never reached the expected state; last=${JSON.stringify(last)}`);
}

beforeAll(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), "pui-launch-proj-"));
  const pipeBase = join(projectRoot, ".claude", "pipeline");

  // demo: two plain sequential steps.
  demoRoot = join(pipeBase, "demo");
  mkdirSync(join(demoRoot, "steps"), { recursive: true });
  writeFileSync(join(demoRoot, "PIPELINE.md"), "# P: demo\n\n## End State\nDemo shipped.\n", "utf8");
  writeFileSync(join(demoRoot, "steps", "01-build.md"), "---\nmodel: haiku\n---\n# 01 build\n", "utf8");
  writeFileSync(join(demoRoot, "steps", "02-verify.md"), "# 02 verify\n", "utf8");

  // ask: one step that asks a question first.
  askRoot = join(pipeBase, "ask");
  mkdirSync(join(askRoot, "steps"), { recursive: true });
  writeFileSync(join(askRoot, "PIPELINE.md"), "# P: ask\n\n## End State\nQuestion answered.\n", "utf8");
  writeFileSync(join(askRoot, "steps", "01-ask.md"), "# 01 ask\n", "utf8");

  // The fake executor lives OUTSIDE the pipelines dir (it must not show up in
  // the catalog walk).
  const execPath = join(projectRoot, "envelope-executor.ts");
  writeFileSync(execPath, ENVELOPE_EXECUTOR, "utf8");

  daemon = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "..", "server.ts")],
    cwd: projectRoot,
    env: {
      ...process.env,
      PIPELINE_UI_HOME: TEST_HOME,
      PIPELINE_UI_DEBUG: "0",
      // The drive children inherit this: executor spawns hit the fake. The
      // {model} token lets a test assert per-step model overrides arrive.
      PIPELINE_DRIVE_EXECUTOR_CMD: `bun ${execPath} --model {model}`,
      // Keep the fixture daemon's own env from disabling event emission.
      PIPELINE_UI_ENABLED: "1",
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
  expect(reg.ok).toBe(true);
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
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
});

describe("launcher", () => {
  test("/api/pipelines returns the catalog with steps + models", async () => {
    const r = await fetch(`${baseUrl}/api/pipelines?project_id=${projectId}`);
    expect(r.ok).toBe(true);
    const j = (await r.json()) as { pipelines: Array<Record<string, any>> };
    const demo = j.pipelines.find((p) => p.name === "demo");
    expect(demo).toBeDefined();
    expect(demo!.end_state).toBe("Demo shipped.");
    expect(demo!.steps.length).toBe(2);
    expect(demo!.steps[0].model).toBe("haiku");
    expect(demo!.steps[0].rel).toBe("01-build.md");
    expect(demo!.first_iteration.endsWith("01-build.md")).toBe(true);
    expect(j.pipelines.some((p) => p.name === "ask")).toBe(true);
  });

  test("launch → drive runs to completion; task + model override delivered", async () => {
    const plan01 = "01-build";
    const plan02 = "02-verify";
    canned(demoRoot, `${plan01}.envelope.json`, {
      outcome: "completed",
      next_iteration: join(demoRoot, "steps", "02-verify.md"),
    });
    canned(demoRoot, `${plan02}.envelope.json`, { outcome: "completed", next_iteration: "PIPELINE_COMPLETE" });

    const r = await fetch(`${baseUrl}/api/runs/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        pipeline_root: demoRoot,
        task_text: "Ship the demo widget",
        model_overrides: { "02-verify": "sonnet" },
      }),
    });
    expect(r.status).toBe(202);
    const { run_id } = (await r.json()) as { run_id: string };

    const done = await pollRun(run_id, (x) => x.status !== "running");
    expect(done.status).toBe("completed");
    expect(done.pipeline_name).toBe("demo");

    // Task text landed in the run's task.md and the prompt references it.
    const taskFile = join(demoRoot, ".runtime", run_id, "task.md");
    expect(readFileSync(taskFile, "utf8")).toBe("Ship the demo widget");
    const prompt1 = readFileSync(join(demoRoot, "canned", `prompt-${plan01}-1.txt`), "utf8");
    expect(prompt1).toContain(`task_file = ${taskFile}`);

    // Per-step override reached the executor argv via the {model} token:
    // 01-build keeps its haiku frontmatter, 02-verify got the sonnet override.
    const args1 = JSON.parse(readFileSync(join(demoRoot, "canned", `args-${plan01}-1.txt`), "utf8")) as string[];
    const args2 = JSON.parse(readFileSync(join(demoRoot, "canned", `args-${plan02}-1.txt`), "utf8")) as string[];
    expect(args1[args1.indexOf("--model") + 1]).toBe("haiku");
    expect(args2[args2.indexOf("--model") + 1]).toBe("sonnet");

    // launch.json persisted for restart recovery.
    const launch = JSON.parse(readFileSync(join(demoRoot, ".runtime", run_id, "launch.json"), "utf8"));
    expect(launch.status).toBe("completed");

    // /api/run-stats falls back to drive's envelope-usage fold (no transcript
    // binding exists for a headless run) — tokens + cost surface instead of
    // zeros. Two steps × (in 1 / out 2 / $0.01).
    const stats = await fetch(`${baseUrl}/api/run-stats?project_id=${projectId}&run_id=${run_id}`);
    expect(stats.ok).toBe(true);
    const sj = (await stats.json()) as Record<string, number>;
    expect(sj.input_tokens).toBe(2);
    expect(sj.output_tokens).toBe(4);
    expect(sj.cost_usd).toBeCloseTo(0.02);
  }, 60_000);

  test("needs-input parks the run with the question; /api/runs/answer resumes the SAME session", async () => {
    canned(askRoot, "01-ask.envelope.json", {
      outcome: "needs-input",
      question: { text: "Which region?", context: "no region configured", options: ["eu", "us"] },
    });
    canned(askRoot, "01-ask.envelope.2.json", { outcome: "completed", next_iteration: "PIPELINE_COMPLETE" });

    const r = await fetch(`${baseUrl}/api/runs/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, pipeline_root: askRoot }),
    });
    expect(r.status).toBe(202);
    const { run_id } = (await r.json()) as { run_id: string };

    const parked = await pollRun(run_id, (x) => x.status !== "running");
    expect(parked.status).toBe("awaiting-input");
    expect(parked.question?.text).toBe("Which region?");
    expect(parked.question?.options).toEqual(["eu", "us"]);
    expect(parked.awaiting_iteration?.endsWith("01-ask.md")).toBe(true);

    // Answering while parked re-enters drive with --resume --answer.
    const a = await fetch(`${baseUrl}/api/runs/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, run_id, answer: "eu" }),
    });
    expect(a.status).toBe(202);
    const done = await pollRun(run_id, (x) => x.status !== "running");
    expect(done.status).toBe("completed");

    // The resumed executor call carried --resume with the pinned session id.
    const args1 = JSON.parse(readFileSync(join(askRoot, "canned", "args-01-ask-1.txt"), "utf8")) as string[];
    const args2 = JSON.parse(readFileSync(join(askRoot, "canned", "args-01-ask-2.txt"), "utf8")) as string[];
    const pinned = args1[args1.indexOf("--session-id") + 1];
    expect(args2[args2.indexOf("--resume") + 1]).toBe(pinned);
    const prompt2 = readFileSync(join(askRoot, "canned", "prompt-01-ask-2.txt"), "utf8");
    expect(prompt2).toContain("Answer to your question: eu");

    // Answering a non-awaiting run is a 409.
    const again = await fetch(`${baseUrl}/api/runs/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, run_id, answer: "eu" }),
    });
    expect(again.status).toBe(409);
  }, 60_000);

  test("launch refuses a pipeline_root outside the project's pipelines dir", async () => {
    const r = await fetch(`${baseUrl}/api/runs/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, pipeline_root: projectRoot }),
    });
    expect(r.status).toBe(403);
  });

  test("/api/runs/stop cancels a parked drive run and halts it in the journal", async () => {
    // Third call for 01-ask falls back to the base envelope (needs-input) —
    // the run parks again, this time we STOP instead of answering.
    const r = await fetch(`${baseUrl}/api/runs/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, pipeline_root: askRoot }),
    });
    expect(r.status).toBe(202);
    const { run_id } = (await r.json()) as { run_id: string };
    await pollRun(run_id, (x) => x.status === "awaiting-input");

    const stop = await fetch(`${baseUrl}/api/runs/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, run_id }),
    });
    expect(stop.ok).toBe(true);
    expect(((await stop.json()) as { drive_killed: boolean }).drive_killed).toBe(true);

    const halted = await pollRun(run_id, (x) => x.status === "halted");
    expect(halted.halt_reason).toBe("stopped by user");

    // The synthetic pipeline.halted reached the journal → the runs summary
    // flips to halted too (this is what clears stale runs from Active).
    const start = Date.now();
    let summaryStatus = "";
    while (Date.now() - start < 10_000) {
      const runs = await fetch(`${baseUrl}/api/runs?project_id=${projectId}&limit=50`);
      const j = (await runs.json()) as { runs: Array<{ run_id: string; status: string; halt_reason: string | null }> };
      const mine = j.runs.find((x) => x.run_id === run_id);
      if (mine?.status === "halted") {
        summaryStatus = mine.status;
        break;
      }
      await Bun.sleep(300);
    }
    expect(summaryStatus).toBe("halted");

    // Answering a stopped run is refused.
    const late = await fetch(`${baseUrl}/api/runs/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, run_id, answer: "eu" }),
    });
    expect(late.status).toBe(409);

    // Stopping an unknown run in a known project → 404.
    const nope = await fetch(`${baseUrl}/api/runs/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, run_id: "does-not-exist" }),
    });
    expect(nope.status).toBe(404);
  }, 60_000);
});

describe("editor", () => {
  test("list + read + save + conflict + reread round-trip", async () => {
    const list = await fetch(
      `${baseUrl}/api/editor/list?project_id=${projectId}&pipeline_root=${encodeURIComponent(demoRoot)}`,
    );
    expect(list.ok).toBe(true);
    const files = ((await list.json()) as { files: string[] }).files;
    expect(files[0]).toBe("demo/PIPELINE.md");
    expect(files).toContain("demo/steps/01-build.md");

    const read = await fetch(`${baseUrl}/api/editor/file?project_id=${projectId}&path=demo/PIPELINE.md`);
    expect(read.ok).toBe(true);
    const f = (await read.json()) as { content: string; sha1: string };
    expect(f.content).toContain("Demo shipped.");

    // Save with the loaded sha1 → ok.
    const newContent = f.content + "\n## Invariants\n- edited from the UI\n";
    const put = await fetch(`${baseUrl}/api/editor/file`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, path: "demo/PIPELINE.md", content: newContent, expected_sha1: f.sha1 }),
    });
    expect(put.ok).toBe(true);

    // A second save with the STALE sha1 → 409 conflict.
    const stale = await fetch(`${baseUrl}/api/editor/file`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, path: "demo/PIPELINE.md", content: "x", expected_sha1: f.sha1 }),
    });
    expect(stale.status).toBe(409);

    // Disk reflects the accepted write.
    expect(readFileSync(join(demoRoot, "PIPELINE.md"), "utf8")).toContain("edited from the UI");
  });

  test("write guards: traversal, absolute, forbidden dirs, bad extension, manifest delete", async () => {
    const put = (path: string) =>
      fetch(`${baseUrl}/api/editor/file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId, path, content: "x" }),
      });
    expect((await put("../outside.md")).status).toBe(400);
    expect((await put("demo/../../escape.md")).status).toBe(400);
    expect((await put("C:/evil.md")).status).toBe(400);
    expect((await put(".runtime/hack.md")).status).toBe(403);
    expect((await put("demo/.stats/hack.md")).status).toBe(403);
    expect((await put("demo/steps/evil.exe")).status).toBe(403);

    const del = await fetch(`${baseUrl}/api/editor/file`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, path: "demo/PIPELINE.md" }),
    });
    expect(del.status).toBe(403);
  });

  test("create-step scaffolds the next NN-*.md from the designer template; validate lints the plan", async () => {
    const r = await fetch(`${baseUrl}/api/editor/create-step`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, pipeline_root: demoRoot, title: "Package the build" }),
    });
    expect(r.ok).toBe(true);
    const j = (await r.json()) as { rel: string; filename: string };
    expect(j.filename).toBe("03-package-the-build.md");
    const content = readFileSync(join(demoRoot, "steps", j.filename), "utf8");
    for (const section of ["## Goal", "## Context", "## Inputs", "## Steps", "## Success Criteria", "## Next"]) {
      expect(content).toContain(section);
    }

    const v = await fetch(`${baseUrl}/api/editor/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, pipeline_root: demoRoot }),
    });
    expect(v.ok).toBe(true);
    const vj = (await v.json()) as { ok: boolean; steps: string[] };
    expect(vj.ok).toBe(true);
    expect(vj.steps).toContain("03-package-the-build");

    // Deleting a regular step file works.
    const del = await fetch(`${baseUrl}/api/editor/file`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, path: j.rel }),
    });
    expect(del.ok).toBe(true);
    expect(existsSync(join(demoRoot, "steps", j.filename))).toBe(false);
  });
});

describe("auth helpers (pure)", () => {
  test("resolveHostConfig: loopback default; non-loopback without token falls back with a warning", () => {
    expect(resolveHostConfig({})).toEqual({ host: "127.0.0.1", token: null, warning: null });
    expect(resolveHostConfig({ PIPELINE_UI_HOST: "0.0.0.0" }).host).toBe("127.0.0.1");
    expect(resolveHostConfig({ PIPELINE_UI_HOST: "0.0.0.0" }).warning).toContain("PIPELINE_UI_TOKEN");
    const ok = resolveHostConfig({ PIPELINE_UI_HOST: "0.0.0.0", PIPELINE_UI_TOKEN: "s3cret" });
    expect(ok).toEqual({ host: "0.0.0.0", token: "s3cret", warning: null });
  });

  test("checkAuth: header, query, and cookie all pass; anything else is 401; no token = no-op", () => {
    const url = new URL("http://x/api/health");
    expect(checkAuth(new Request(url), url, null)).toBeNull();
    expect(checkAuth(new Request(url), url, "t")?.status).toBe(401);
    expect(checkAuth(new Request(url, { headers: { authorization: "Bearer t" } }), url, "t")).toBeNull();
    const qUrl = new URL("http://x/?token=t");
    expect(checkAuth(new Request(qUrl), qUrl, "t")).toBeNull();
    expect(checkAuth(new Request(url, { headers: { cookie: "a=b; pipeline_ui_token=t" } }), url, "t")).toBeNull();
    expect(checkAuth(new Request(url, { headers: { cookie: "pipeline_ui_token=wrong" } }), url, "t")?.status).toBe(401);
  });

  test("maybeSetTokenCookie pins the cookie only on a valid ?token= request", () => {
    const tokened = new URL("http://x/?token=t");
    const res = maybeSetTokenCookie(new Response("ok"), tokened, "t");
    expect(res.headers.get("set-cookie")).toContain("pipeline_ui_token=t");
    const plain = maybeSetTokenCookie(new Response("ok"), new URL("http://x/"), "t");
    expect(plain.headers.get("set-cookie")).toBeNull();
  });

  test("isInsidePipelinesDir + parseDriveFinal guards", () => {
    const proj = resolve(tmpdir(), "p");
    expect(isInsidePipelinesDir(proj, join(proj, ".claude", "pipeline", "x"))).toBe(true);
    expect(isInsidePipelinesDir(proj, join(proj, ".claude", "pipeline"))).toBe(true);
    expect(isInsidePipelinesDir(proj, proj)).toBe(false);
    expect(isInsidePipelinesDir(proj, join(proj, ".claude", "pipeline", "..", "..", "secrets"))).toBe(false);
    expect(parseDriveFinal('{"status":"completed"}')).toEqual({ status: "completed" });
    expect(parseDriveFinal("noise\n{\n  \"status\": \"blocked\"\n}")).toEqual({ status: "blocked" });
    expect(parseDriveFinal("")).toBeNull();
    expect(parseDriveFinal("[1]")).toBeNull();
  });
});
