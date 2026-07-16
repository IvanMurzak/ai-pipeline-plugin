/**
 * Manual-test harness — drives the pipeline-ui daemon from outside.
 *
 * Goals:
 *   1. Spin up (or attach to) the daemon.
 *   2. Create temp project directories with a tiny pipeline fixture.
 *   3. Emit synthetic events to events.jsonl exactly the way the real
 *      /pipeline:run + `pipeline event` (apps/pipeline-cli/src/lib/event.ts) + hooks emit them.
 *   4. Query the daemon's REST API (/api/runs, /api/state, ...) and
 *      assert behavior.
 *   5. Optionally fire a real /api/chat (Haiku) for an end-to-end smoke.
 *
 * No browser. No Claude Code session. Most scenarios cost $0.
 *
 * Usage from another script:
 *
 *   import { Harness } from "./harness.ts";
 *   const h = new Harness();
 *   await h.ensureDaemon();
 *   const proj = await h.tempProject("happy-path");
 *   await h.emitEvent(proj, "pipeline.started", "run-1", { ... });
 *   const runs = await h.getRuns(proj.project_id);
 *   ...
 *   await h.cleanup();
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const HOME_DIR = join(homedir(), ".claude", "pipeline-ui");
const LOCK_PATH = join(HOME_DIR, "daemon.lock");
const DAEMON_SCRIPT = resolve(import.meta.dir, "..", "server.ts");
const FIXTURE_DIR = resolve(import.meta.dir, "fixtures", "test-pipeline");

const SCHEMA_VERSION = 4;

export interface DaemonLock {
  pid: number;
  port: number;
  host: string;
  plugin_version: string;
  started_at: string;
}

export interface TempProject {
  project_id: string;
  project_root: string;
  cleanup: () => void;
}

export type EventData = Record<string, unknown>;

interface JournalEvent {
  schema: number;
  ts: string;
  type: string;
  project_root: string;
  worktree: string | null;
  run_id: string | null;
  parent_run_id: string | null;
  session_id: string | null;
  data: EventData;
}

export class Harness {
  private spawnedDaemon: ReturnType<typeof spawn> | null = null;
  private tempProjects: TempProject[] = [];
  private port = 0;

  // -----------------------------------------------------------------
  // Daemon lifecycle
  // -----------------------------------------------------------------

  async ensureDaemon(): Promise<DaemonLock> {
    const existing = await this.readLockAndProbe();
    if (existing) {
      this.port = existing.port;
      return existing;
    }
    return this.spawnDaemon();
  }

  private async readLockAndProbe(): Promise<DaemonLock | null> {
    if (!existsSync(LOCK_PATH)) return null;
    try {
      const lock = JSON.parse(readFileSync(LOCK_PATH, "utf-8")) as DaemonLock;
      const res = await fetch(`http://${lock.host}:${lock.port}/api/health`, {
        signal: AbortSignal.timeout(800),
      });
      if (!res.ok) return null;
      return lock;
    } catch {
      return null;
    }
  }

  private async spawnDaemon(): Promise<DaemonLock> {
    if (!existsSync(DAEMON_SCRIPT)) {
      throw new Error(`daemon script not found: ${DAEMON_SCRIPT}`);
    }
    mkdirSync(HOME_DIR, { recursive: true });
    const stdoutLog = join(HOME_DIR, "daemon.stdout.log");
    const stderrLog = join(HOME_DIR, "daemon.stderr.log");
    try {
      writeFileSync(stdoutLog, "");
    } catch {}
    try {
      writeFileSync(stderrLog, "");
    } catch {}
    const child = spawn("bun", [DAEMON_SCRIPT], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PIPELINE_UI_DEBUG: process.env.PIPELINE_UI_DEBUG ?? "0" },
      windowsHide: true,
    });
    child.unref();
    this.spawnedDaemon = child;

    // Poll the lock for up to ~5s.
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const lock = await this.readLockAndProbe();
      if (lock) {
        this.port = lock.port;
        return lock;
      }
    }
    throw new Error("daemon failed to come up within 5s");
  }

  baseUrl(): string {
    if (!this.port) throw new Error("ensureDaemon() not called yet");
    return `http://127.0.0.1:${this.port}`;
  }

  // -----------------------------------------------------------------
  // Project registration
  // -----------------------------------------------------------------

  /**
   * Make a temp project directory containing the fixture pipeline and
   * register it with the daemon. Returns the project_id assigned (sha1
   * prefix of the project_root path — the daemon's algorithm).
   */
  async tempProject(label: string, options?: { worktree?: boolean }): Promise<TempProject> {
    const root = mkdtempSync(join(tmpdir(), `pipe-test-${label}-`));
    this.copyFixture(root);
    // Make it look like a git repo so resolveProjectRootFromCwd succeeds.
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(root, ".git", "objects"), { recursive: true });

    let registerRoot = root;
    let worktree: string | null = null;
    if (options?.worktree) {
      // Build a worktree pointing at root.
      const wt = mkdtempSync(join(tmpdir(), `pipe-test-${label}-wt-`));
      const gitdir = join(root, ".git", "worktrees", "wt");
      mkdirSync(gitdir, { recursive: true });
      writeFileSync(join(gitdir, "commondir"), "../..");
      writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}`);
      // We also copy the fixture into the wt dir so pipelines resolve.
      this.copyFixture(wt);
      registerRoot = wt;
      worktree = wt;
    }

    // Use /api/register-cwd so the daemon walks .git for us and discovers
    // the main repo + worktree the same way the real SessionStart hook does.
    const res = await fetch(`${this.baseUrl()}/api/register-cwd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: registerRoot, project_name: label }),
    });
    if (!res.ok) {
      throw new Error(`register-cwd failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as {
      ok: boolean;
      project_id: string;
      project_root: string;
      worktree: string | null;
    };

    const cleanup = () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {}
      if (worktree) {
        try {
          rmSync(worktree, { recursive: true, force: true });
        } catch {}
      }
    };

    const entry: TempProject = {
      project_id: body.project_id,
      project_root: body.project_root,
      cleanup,
    };
    this.tempProjects.push(entry);
    return entry;
  }

  private copyFixture(toRoot: string): void {
    if (!existsSync(FIXTURE_DIR)) {
      throw new Error(
        `test fixture missing at ${FIXTURE_DIR} — did you run from the right cwd?`,
      );
    }
    const target = join(toRoot, ".claude", "pipeline", "test-pipeline");
    mkdirSync(target, { recursive: true });
    mkdirSync(join(target, "steps"), { recursive: true });
    // Copy PIPELINE.md
    writeFileSync(
      join(target, "PIPELINE.md"),
      readFileSync(join(FIXTURE_DIR, "PIPELINE.md"), "utf-8"),
    );
    // Copy step files
    for (const f of ["01-hello.md", "02-world.md", "03-done.md"]) {
      writeFileSync(
        join(target, "steps", f),
        readFileSync(join(FIXTURE_DIR, "steps", f), "utf-8"),
      );
    }
  }

  // -----------------------------------------------------------------
  // Event emission
  // -----------------------------------------------------------------

  /**
   * Append one event to <project>/.claude/pipeline/.runtime/events.jsonl.
   * Mirrors `pipeline event` exactly; same field names, same coercion behavior.
   */
  emitEvent(
    proj: TempProject,
    type: string,
    runId: string | null,
    data: EventData = {},
    opts: { worktree?: string | null; parentRunId?: string | null; sessionId?: string | null } = {},
  ): void {
    const runtime = join(proj.project_root, ".claude", "pipeline", ".runtime");
    mkdirSync(runtime, { recursive: true });
    const event: JournalEvent = {
      schema: SCHEMA_VERSION,
      ts: new Date().toISOString(),
      type,
      project_root: proj.project_root,
      worktree: opts.worktree ?? null,
      run_id: runId,
      parent_run_id: opts.parentRunId ?? null,
      session_id: opts.sessionId ?? null,
      data,
    };
    appendFileSync(join(runtime, "events.jsonl"), JSON.stringify(event) + "\n", "utf-8");
  }

  /**
   * Write a v1 (schema=1) event so we can verify backward-compatibility.
   * v1 events have no `terminal` field on iteration.completed.
   */
  emitV1Event(
    proj: TempProject,
    type: string,
    runId: string | null,
    data: EventData = {},
  ): void {
    const runtime = join(proj.project_root, ".claude", "pipeline", ".runtime");
    mkdirSync(runtime, { recursive: true });
    const event = {
      schema: 1,
      ts: new Date().toISOString(),
      type,
      project_root: proj.project_root,
      worktree: null,
      run_id: runId,
      parent_run_id: null,
      session_id: null,
      data,
    };
    appendFileSync(join(runtime, "events.jsonl"), JSON.stringify(event) + "\n", "utf-8");
  }

  /** Emit a full happy-path iteration (started + completed). */
  emitIteration(
    proj: TempProject,
    runId: string,
    index: number,
    iterationRel: string,
    opts: { next?: string | null; terminal?: boolean; outcome?: "completed" | "halted"; haltReason?: string } = {},
  ): void {
    const absIter = join(
      proj.project_root,
      ".claude",
      "pipeline",
      "test-pipeline",
      "steps",
      iterationRel,
    );
    this.emitEvent(proj, "iteration.started", runId, {
      iteration_path: absIter,
      index,
    });
    this.emitEvent(proj, "iteration.completed", runId, {
      iteration_path: absIter,
      outcome: opts.outcome ?? "completed",
      next_iteration_path: opts.next ?? null,
      has_improvement_brief: false,
      has_blocker_delegation: false,
      halt_reason: opts.haltReason ?? null,
      terminal: opts.terminal ?? false,
    });
  }

  /** A burst of tool.called events — used to test the 500-event eviction. */
  emitToolBurst(proj: TempProject, runId: string, count: number, toolName = "Read"): void {
    for (let i = 0; i < count; i++) {
      this.emitEvent(proj, "tool.called", runId, {
        tool_name: toolName,
        success: true,
        agent_spawn: false,
        tool_use_id: `tu-${runId}-${i}`,
      });
    }
  }

  // -----------------------------------------------------------------
  // API calls
  // -----------------------------------------------------------------

  async getHealth(): Promise<{
    ok: boolean;
    plugin_version: string;
    schema: number;
    projects: number;
    clients: number;
  }> {
    const res = await fetch(`${this.baseUrl()}/api/health`);
    if (!res.ok) throw new Error(`health: ${res.status}`);
    return res.json();
  }

  async getProjects(): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl()}/api/projects`);
    if (!res.ok) throw new Error(`projects: ${res.status}`);
    const j = (await res.json()) as { projects: unknown[] };
    return j.projects;
  }

  async getState(projectId: string): Promise<{
    project: { project_id: string; project_root: string };
    pipelines: unknown[];
    events: JournalEvent[];
  }> {
    const res = await fetch(`${this.baseUrl()}/api/state?project_id=${projectId}`);
    if (!res.ok) throw new Error(`state: ${res.status}`);
    return res.json();
  }

  async getRuns(
    projectId: string,
    limit = 100,
  ): Promise<Array<{
    run_id: string;
    pipeline_name: string | null;
    current_iteration_path: string | null;
    iteration_count_completed: number;
    status: string;
    started_at: string;
    last_event_at: string;
    halt_reason: string | null;
    worktree: string | null;
  }>> {
    const res = await fetch(
      `${this.baseUrl()}/api/runs?project_id=${projectId}&limit=${limit}`,
    );
    if (!res.ok) throw new Error(`runs: ${res.status}`);
    const j = (await res.json()) as { runs: unknown[] };
    return j.runs as Array<{
      run_id: string;
      pipeline_name: string | null;
      current_iteration_path: string | null;
      iteration_count_completed: number;
      status: string;
      started_at: string;
      last_event_at: string;
      halt_reason: string | null;
      worktree: string | null;
    }>;
  }

  /** Run a chat against /api/chat and collect all events. Streaming-aware. */
  async runChat(opts: {
    projectId: string;
    pipelineName?: string | null;
    prompt: string;
    model?: string | null;
    timeoutMs?: number;
  }): Promise<{
    events: Array<{ type: string; data: unknown }>;
    durationMs: number;
  }> {
    const start = Date.now();
    const events: Array<{ type: string; data: unknown }> = [];
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? 180_000,
    );
    try {
      const res = await fetch(`${this.baseUrl()}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: opts.projectId,
          pipeline_name: opts.pipelineName ?? null,
          prompt: opts.prompt,
          model: opts.model ?? null,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`chat HTTP ${res.status}: ${await res.text()}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let type = "message";
          const dataLines: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          const dataStr = dataLines.join("\n");
          let data: unknown = dataStr;
          try {
            data = JSON.parse(dataStr);
          } catch {
            /* leave raw */
          }
          events.push({ type, data });
          if (type === "chat.completed" || type === "chat.error") return { events, durationMs: Date.now() - start };
        }
      }
      return { events, durationMs: Date.now() - start };
    } finally {
      clearTimeout(timer);
    }
  }

  // -----------------------------------------------------------------
  // Inspection helpers
  // -----------------------------------------------------------------

  /** Read the on-disk events.jsonl directly (sanity check the writer path). */
  readJournal(proj: TempProject): JournalEvent[] {
    const path = join(proj.project_root, ".claude", "pipeline", ".runtime", "events.jsonl");
    if (!existsSync(path)) return [];
    const out: JournalEvent[] = [];
    const text = readFileSync(path, "utf-8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
    return out;
  }

  /** Wait for the daemon to surface a given run summary value. Polls /api/runs. */
  async waitForRun(
    projectId: string,
    runId: string,
    predicate: (run: { status: string; iteration_count_completed: number; current_iteration_path: string | null }) => boolean,
    timeoutMs = 3000,
  ): Promise<{ status: string; iteration_count_completed: number; current_iteration_path: string | null } | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const runs = await this.getRuns(projectId);
      const r = runs.find((x) => x.run_id === runId);
      if (r && predicate(r)) return r;
      await new Promise((res) => setTimeout(res, 100));
    }
    return null;
  }

  // -----------------------------------------------------------------
  // Pretty-print helpers — "see all the important data"
  // -----------------------------------------------------------------

  async snapshot(projectId: string): Promise<void> {
    const health = await this.getHealth();
    const state = await this.getState(projectId);
    const runs = await this.getRuns(projectId);
    const journal = this.readJournal({
      project_id: state.project.project_id,
      project_root: state.project.project_root,
      cleanup: () => {},
    });
    console.log("┌─ Daemon health");
    console.log("│  plugin_version:", health.plugin_version);
    console.log("│  schema:        ", health.schema);
    console.log("│  projects:      ", health.projects);
    console.log("│  clients:       ", health.clients);
    console.log("├─ Project");
    console.log("│  project_id:    ", state.project.project_id);
    console.log("│  project_root:  ", state.project.project_root);
    console.log("├─ Pipelines:    ", state.pipelines.length);
    for (const p of state.pipelines as Array<{ pipeline_name: string; iterations: string[] }>) {
      console.log(`│  • ${p.pipeline_name} (${p.iterations.length} steps)`);
    }
    console.log("├─ Runs (from /api/runs):", runs.length);
    for (const r of runs) {
      const tail = r.current_iteration_path
        ? r.current_iteration_path.split(/[\\/]/).pop()
        : "—";
      console.log(
        `│  • ${r.run_id.slice(0, 12)} ${r.pipeline_name ?? "?"} status=${r.status} completed=${r.iteration_count_completed} step=${tail}${r.worktree ? " worktree=Y" : ""}`,
      );
    }
    console.log("├─ Journal events:", journal.length);
    const counts = new Map<string, number>();
    for (const e of journal) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    for (const [t, c] of [...counts.entries()].sort()) {
      console.log(`│  • ${t}: ${c}`);
    }
    console.log("└─");
  }

  // -----------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------

  async cleanup(): Promise<void> {
    // Tell the daemon to forget each temp project we registered so the
    // registry doesn't accumulate dozens of dead entries across test runs.
    for (const p of this.tempProjects) {
      try {
        await fetch(`${this.baseUrl()}/api/unregister`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project_id: p.project_id }),
        });
      } catch {
        /* best-effort — old daemons without the endpoint just no-op */
      }
      p.cleanup();
    }
    this.tempProjects = [];
    // We intentionally do NOT stop a daemon that was already running when
    // the harness attached. We DO stop one we spawned ourselves — but the
    // daemon has its own idle-shutdown, so leaving it running is harmless.
  }
}

/** Helper: random short run id. */
export function rid(prefix = "r"): string {
  return `${prefix}-${createHash("sha1")
    .update(`${Date.now()}-${Math.random()}`)
    .digest("hex")
    .slice(0, 10)}`;
}

/** Helper: pretty-print pass/fail with a label. */
export function expectEq<T>(label: string, actual: T, expected: T): boolean {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    console.log(`    ✓ ${label}`);
    return true;
  }
  console.log(`    ✗ ${label}`);
  console.log(`       expected: ${b}`);
  console.log(`       actual:   ${a}`);
  return false;
}

export function expect(label: string, condition: boolean): boolean {
  if (condition) {
    console.log(`    ✓ ${label}`);
    return true;
  }
  console.log(`    ✗ ${label}`);
  return false;
}

/** Silence harness's reference to dirname when imported standalone. */
void dirname;
void statSync;
