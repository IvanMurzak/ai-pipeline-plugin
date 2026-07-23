/**
 * Stats backfill sweep (recovery rung T4, design 04) — apps/pipeline-ui/server.ts.
 *
 *   bun test tests/server-backfill-sweep.test.ts
 *
 * Enrichment normally lands from the Stop/SubagentStop relay, but a run can
 * miss it for ordinary reasons (session killed before Stop, machine slept,
 * stats opted out at the time). The daemon runs the SAME shared
 * `backfillProject` core at boot and every 60 s, so the numbers eventually
 * appear with the user doing nothing.
 *
 * The project registry is SEEDED before the daemon spawns — the boot pass runs
 * ~1.5 s in, so a project registered afterwards over HTTP would race it.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";

import { encodeClaudeProjectDir } from "../transcripts.ts";

const TEST_HOME = mkdtempSync(join(tmpdir(), "pui-bf-state-"));
const FAKE_USER_HOME = mkdtempSync(join(tmpdir(), "pui-bf-home-"));
const LOCK_PATH = join(TEST_HOME, "daemon.lock");

let daemon: Subprocess | null = null;
/** The project with an unenriched record — the sweep must fill it in. */
let dirtyRoot = "";
/** A project whose records are all enriched — the pre-scan must skip it, and
 *  its file must come back byte-identical. */
let cleanRoot = "";
let cleanBefore = "";

const RUN_ID = "bfsweep01";
// The transcript locator gates candidate files by birthtime/mtime against the
// run's window, so the fixture window must reach the present — a file created
// now can never overlap a window that closed minutes ago.
const started = new Date(Date.now() - 5 * 60_000).toISOString();
const ended = new Date().toISOString();
const mid = new Date(Date.now() - 60_000).toISOString();

function record(runId: string, tokens: unknown): string {
  return JSON.stringify({
    schema: 1,
    run_id: runId,
    pipeline: "demo",
    started_at: started,
    ended_at: ended,
    duration_s: 60,
    outcome: "completed",
    halt_reason: null,
    runner: "manager",
    mode: "sequential",
    steps_run: 1,
    steps: [{ id: "01-a", started_at: started, seconds: 60, outcome: "completed", model: "sonnet", effort: null }],
    improver_runs: 0,
    improver_applied: 0,
    scripts_created: 0,
    merges: 0,
    merge_conflicts: 0,
    llm_steps: 1,
    tokens,
  });
}

/** Encode a project root the way Claude Code names its transcript dir. */
function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[/\\:]/g, "-");
}

function runsJsonl(root: string): string {
  return join(root, ".claude", "pipeline", ".stats", "demo", "runs.jsonl");
}

/** A project tree with one .stats record; `tokens` decides dirty vs clean. */
function makeProject(prefix: string, runId: string, tokens: unknown): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".claude", "pipeline", ".stats", "demo", "runs"), { recursive: true });
  writeFileSync(runsJsonl(root), record(runId, tokens) + "\n", "utf-8");
  writeFileSync(
    join(root, ".claude", "pipeline", ".stats", "demo", "runs", `${runId}.log`),
    `run ${runId} — demo — COMPLETED\n`,
    "utf-8",
  );
  return root;
}

/** A manager transcript that folds to nonzero tokens for `runId`. */
function writeTranscript(root: string, runId: string): void {
  const dir = join(FAKE_USER_HOME, ".claude", "projects", encodeClaudeProjectDir(root));
  mkdirSync(dir, { recursive: true });
  const entry = (message: Record<string, unknown>) => JSON.stringify({ timestamp: mid, message }) + "\n";
  writeFileSync(
    join(dir, `${runId}.jsonl`),
    entry({
      role: "assistant",
      usage: { input_tokens: 31, output_tokens: 11, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } }],
    }) +
      entry({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "ok" }] }) +
      // The locator picks the file mentioning the run id the most times.
      entry({ role: "assistant", content: [{ type: "text", text: `run ${runId} done` }] }),
    "utf-8",
  );
}

function seedRegistry(roots: string[]): void {
  mkdirSync(TEST_HOME, { recursive: true });
  const reg: Record<string, unknown> = {};
  roots.forEach((root, i) => {
    const id = `proj${i}`;
    reg[id] = {
      project_id: id,
      project_root: root,
      project_name: `p${i}`,
      first_seen: started,
      last_seen: started,
    };
  });
  writeFileSync(join(TEST_HOME, "projects.json"), JSON.stringify(reg, null, 2), "utf-8");
}

async function waitForHealth(maxMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const txt = await Bun.file(LOCK_PATH).text();
      if (txt.trim()) {
        const lock = JSON.parse(txt);
        if ((await fetch(`http://${lock.host}:${lock.port}/api/health`)).ok) return;
      }
    } catch {
      /* keep polling */
    }
    await Bun.sleep(150);
  }
  throw new Error("backfill daemon never became healthy");
}

/** Poll until the record is enriched (the boot pass is deferred ~1.5 s). */
async function waitForEnrichment(maxMs = 15_000): Promise<Record<string, unknown> | null> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const rec = JSON.parse(readFileSync(runsJsonl(dirtyRoot), "utf-8").trim()) as Record<string, unknown>;
    if (rec.tokens !== null) return rec;
    await Bun.sleep(250);
  }
  return null;
}

beforeAll(async () => {
  dirtyRoot = makeProject("pui-bf-dirty-", RUN_ID, null);
  writeTranscript(dirtyRoot, RUN_ID);

  cleanRoot = makeProject("pui-bf-clean-", "bfclean01", {
    input: 5,
    output: 2,
    cache_read: 0,
    cache_creation: 0,
    tools_called: 1,
    tools_failed: 0,
    agents_spawned: 0,
  });
  writeTranscript(cleanRoot, "bfclean01");
  cleanBefore = readFileSync(runsJsonl(cleanRoot), "utf-8");

  seedRegistry([dirtyRoot, cleanRoot]);

  daemon = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "..", "server.ts")],
    cwd: dirtyRoot,
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
  for (const d of [TEST_HOME, FAKE_USER_HOME, dirtyRoot, cleanRoot]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

test("the boot pass enriches a seeded tokens:null record", async () => {
  const rec = await waitForEnrichment();
  expect(rec).not.toBeNull();
  const tokens = rec!.tokens as Record<string, number>;
  expect(tokens.input).toBe(31);
  expect(tokens.output).toBe(11);
  expect(tokens.tools_called).toBe(1);
}, 20_000);

test("the pre-scan leaves an already-enriched project byte-identical", async () => {
  await waitForEnrichment(); // ensure the sweep has run at least once
  expect(readFileSync(runsJsonl(cleanRoot), "utf-8")).toBe(cleanBefore);
}, 20_000);
