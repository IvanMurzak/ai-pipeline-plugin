// Run launcher — the daemon-side backend for launching pipeline runs from the
// browser, built on the interactive headless runner (`pipeline drive`).
//
// Endpoints (wired into server.ts handleApi):
//   GET  /api/pipelines?project_id=      — launchable-pipeline catalog: every
//        pipeline root under <project>/.claude/pipeline (incl. targets/<t>),
//        each with its computePlan() steps + resolved models so the UI can
//        offer per-step model overrides before launch.
//   POST /api/runs/launch                — {project_id, pipeline_root, task_text?,
//        task_file?, default_model?, model_overrides?, default_effort?,
//        effort_overrides?, start?} → spawn
//        `pipeline drive` (cwd = project root, PIPELINE_UI_ENABLED inherited so
//        per-iteration events light the dashboard up), track the child, 202
//        {run_id}. Exit 4 (awaiting-input) surfaces the executor's question.
//   POST /api/runs/answer                — {project_id, run_id, answer} →
//        re-enter the parked run: `pipeline drive --resume --start <iteration>
//        --answer <text>` — the SAME executor session continues.
//   GET  /api/drive-runs?project_id=     — snapshots of daemon-launched runs
//        (status, question when awaiting, exit summary).
//
// Every state change broadcasts {type:"drive.run", data:<snapshot>} over SSE.
// A per-run launch.json (+ drive.log) is persisted under
// <pipeline_root>/.runtime/<run_id>/ so an answer can be delivered even after
// a daemon restart (the in-memory map is a cache, not the source of truth).
//
// WRITE-SCOPE CONTRACT: this module writes ONLY under a registered project's
// .claude/pipeline/ tree (runtime artifacts of the run), never anywhere else
// in the consumer project. pipeline_root is validated to resolve inside the
// project's pipelines dir before anything is spawned or written.
//
// Auth (resolveHostConfig/checkAuth): the daemon binds 127.0.0.1 by default.
// PIPELINE_UI_HOST widens the bind (e.g. 0.0.0.0 for phone access) but then
// PIPELINE_UI_TOKEN is MANDATORY — without it the config falls back to
// loopback with a loud warning. When a token is configured every request must
// carry it (Authorization: Bearer, ?token=, or the cookie the first
// tokened page-load sets).

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computePlan } from "../pipeline-cli/src/lib/plan";
import { splitSections } from "../pipeline-cli/src/lib/match";
import { extractQuestion } from "../pipeline-cli/src/lib/step-schema";
import type { EnvelopeUsage } from "../pipeline-cli/src/lib/envelope";
import { evictOldestTerminal, normalizePathForCompare } from "./lib.ts";

// ---------------------------------------------------------------------------
// Deps + types
// ---------------------------------------------------------------------------

export interface LauncherProject {
  project_id: string;
  project_root: string;
}

export type GetProject = (projectId: string) => LauncherProject | undefined;

export interface LauncherDeps {
  getProject: GetProject;
  broadcast: (msg: { type: string; data: unknown }) => void;
  /** ${CLAUDE_PLUGIN_ROOT} — used to locate apps/pipeline-cli/src/cli.ts. */
  pluginRoot: string;
  log: (msg: string) => void;
}

export interface CatalogStep {
  step_id: string;
  path: string;
  rel: string;
  model: string | null;
  /** Resolved reasoning effort (step ?? pipeline default ?? null = inherit). */
  effort: string | null;
}

export interface CatalogPipeline {
  name: string;
  pipeline_root: string;
  first_iteration: string | null;
  end_state: string | null;
  mode: string;
  default_model: string | null;
  /** Pipeline-level `effort:` frontmatter, null = inherit. */
  default_effort: string | null;
  has_targets: boolean;
  steps: CatalogStep[];
  errors: string[];
  warnings: string[];
}

export type DriveRunStatus = "running" | "completed" | "halted" | "blocked" | "awaiting-input" | "failed";

export interface DriveRunSnapshot {
  run_id: string;
  project_id: string;
  pipeline_root: string;
  pipeline_name: string;
  start_path: string;
  status: DriveRunStatus;
  exit_code: number | null;
  launched_at: string;
  ended_at: string | null;
  /** Present while status === awaiting-input. */
  question: { text: string; context: string | null; options: string[] | null } | null;
  awaiting_iteration: string | null;
  halt_reason: string | null;
  task_file: string | null;
}

interface DriveRun extends DriveRunSnapshot {
  stdout: string;
  stderr: string;
  /** Set by stopDriveRun: the user cancelled and the snapshot is already
   *  finalized — the child's exit handler must not overwrite that verdict.
   *  Snapshot-excluded, like stdout/stderr. */
  userStopped?: boolean;
}

const driveRuns = new Map<string, DriveRun>();

/** Live child processes of runs THIS daemon spawned, keyed by run_id. Not part
 *  of the snapshot (process handles aren't serializable); used by /api/runs/stop
 *  to actually kill a running `pipeline drive`. */
const driveChildren = new Map<string, { kill: () => void }>();

/** The daemon is one long-lived process per machine — never let the in-memory
 *  run map grow without bound. launch.json on disk stays the durable record;
 *  only the most recent terminal runs are kept for /api/drive-runs. */
const MAX_TERMINAL_DRIVE_RUNS = 50;
function evictTerminalDriveRuns(): void {
  evictOldestTerminal(
    driveRuns,
    (r) => r.status !== "running" && r.status !== "awaiting-input",
    (r) => r.ended_at ?? r.launched_at,
    (r) => r.run_id,
    MAX_TERMINAL_DRIVE_RUNS,
  );
}

/** Short unique id for daemon-minted objects (drive runs, AI-fix jobs). */
export function mintId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------------------------------------------------------------------
// Pipeline catalog
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["steps", "scripts", "node_modules"]);

/** Every directory under <pipelines-dir> that holds a PIPELINE.md — category
 *  folders recurse, target families contribute each targets/<name>/ as its own
 *  launchable pipeline, dot-dirs (.runtime/.stats/.hooks/.feedback/.common) are
 *  skipped. */
export function listPipelineRoots(projectRoot: string): Array<{ name: string; root: string }> {
  const base = join(projectRoot, ".claude", "pipeline");
  const out: Array<{ name: string; root: string }> = [];
  const walk = (dir: string, relParts: string[], depth: number): void => {
    if (depth > 5) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const isPipeline = names.includes("PIPELINE.md");
    if (isPipeline) out.push({ name: relParts.join("/") || ".", root: dir });
    for (const n of names) {
      if (n.startsWith(".") || SKIP_DIRS.has(n)) continue;
      // Inside a pipeline only targets/ may hold nested pipelines.
      if (isPipeline && n !== "targets") continue;
      const child = join(dir, n);
      let st;
      try {
        st = statSync(child);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      // Category folders recurse; inside a pipeline, only targets/<name>/
      // contributes nested (sub-)pipelines. `targets` stays in the name
      // (alpha/targets/ios) — unambiguous and matches the on-disk layout.
      walk(child, [...relParts, n], depth + 1);
    }
  };
  walk(base, [], 0);
  return out;
}

/** First non-empty line of the manifest's `## End State` section (via the
 *  matcher's shared section splitter — one manifest grammar, not a bespoke
 *  regex that can drift on CRLF/edge cases). */
export function readEndState(pipelineRoot: string): string | null {
  try {
    const text = readFileSync(join(pipelineRoot, "PIPELINE.md"), "utf8");
    const section = splitSections(text)["End State"] ?? "";
    const line = section
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return line ?? null;
  } catch {
    return null;
  }
}

interface CatalogCacheEntry {
  at: number;
  data: CatalogPipeline[];
}
const catalogCache = new Map<string, CatalogCacheEntry>();
const CATALOG_TTL_MS = 10_000;

export function buildCatalog(projectRoot: string): CatalogPipeline[] {
  const hit = catalogCache.get(projectRoot);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.data;
  const out: CatalogPipeline[] = [];
  for (const { name, root } of listPipelineRoots(projectRoot)) {
    try {
      const plan = computePlan(root);
      const stepsDir = join(root, "steps");
      out.push({
        name,
        pipeline_root: root.replaceAll("\\", "/"),
        first_iteration: plan.steps[0]?.path?.replaceAll("\\", "/") ?? null,
        end_state: readEndState(root),
        mode: plan.mode,
        default_model: plan.default_model ?? null,
        default_effort: plan.default_effort ?? null,
        has_targets: existsSync(join(root, "targets")),
        steps: plan.steps.map((s) => ({
          step_id: s.step_id,
          path: s.path.replaceAll("\\", "/"),
          rel: s.path.startsWith(stepsDir) ? s.path.slice(stepsDir.length + 1).replaceAll("\\", "/") : s.path.replaceAll("\\", "/"),
          model: s.model ?? null,
          effort: s.effort ?? null,
        })),
        errors: plan.errors ?? [],
        warnings: plan.warnings ?? [],
      });
    } catch (e) {
      out.push({
        name,
        pipeline_root: root.replaceAll("\\", "/"),
        first_iteration: null,
        end_state: readEndState(root),
        mode: "unknown",
        default_model: null,
        default_effort: null,
        has_targets: existsSync(join(root, "targets")),
        steps: [],
        errors: [`plan failed: ${e instanceof Error ? e.message : String(e)}`],
        warnings: [],
      });
    }
  }
  catalogCache.set(projectRoot, { at: Date.now(), data: out });
  return out;
}

/** Drop the catalog cache for a project (file watcher fires on pipeline edits). */
export function invalidateCatalog(projectRoot?: string): void {
  if (projectRoot === undefined) catalogCache.clear();
  else catalogCache.delete(projectRoot);
}

export function handleListPipelines(url: URL, getProject: GetProject): Response {
  const pid = url.searchParams.get("project_id");
  if (!pid) return new Response("missing project_id", { status: 400 });
  const entry = getProject(pid);
  if (!entry) return new Response("unknown project", { status: 404 });
  return Response.json({ pipelines: buildCatalog(entry.project_root) });
}

// ---------------------------------------------------------------------------
// Launch / answer
// ---------------------------------------------------------------------------

/** pipeline_root must resolve INSIDE the project's pipelines dir. Uses the
 *  daemon's shared path normalizer (normalizePathForCompare) — containment
 *  checks must not each grow their own Windows case-fold variant. */
export function isInsidePipelinesDir(projectRoot: string, pipelineRoot: string): boolean {
  const nBase = normalizePathForCompare(resolve(projectRoot, ".claude", "pipeline"));
  const nTarget = normalizePathForCompare(pipelineRoot);
  return nTarget === nBase || nTarget.startsWith(nBase + "/");
}

function snapshot(run: DriveRun): DriveRunSnapshot {
  const { stdout: _o, stderr: _e, userStopped: _u, ...snap } = run;
  return snap;
}

function pipelineNameOf(projectRoot: string, pipelineRoot: string): string {
  const base = resolve(projectRoot, ".claude", "pipeline").replaceAll("\\", "/");
  const root = resolve(pipelineRoot).replaceAll("\\", "/");
  const inside = normalizePathForCompare(root).startsWith(normalizePathForCompare(base) + "/");
  return inside ? root.slice(base.length + 1) : root;
}

function runtimeDir(pipelineRoot: string, runId: string): string {
  return join(pipelineRoot, ".runtime", runId);
}

function persistLaunchJson(run: DriveRun): void {
  try {
    const dir = runtimeDir(run.pipeline_root, run.run_id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "launch.json"), JSON.stringify(snapshot(run), null, 2), "utf8");
  } catch {
    // best-effort — the in-memory map still serves the session
  }
}

function appendDriveLog(run: DriveRun, chunk: string): void {
  try {
    appendFileSync(join(runtimeDir(run.pipeline_root, run.run_id), "drive.log"), chunk, "utf8");
  } catch {
    // best-effort
  }
}

/** Parse drive's final stdout JSON (pretty-printed single object). */
export function parseDriveFinal(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    // Tolerate stray leading noise: parse from the first '{'.
    const i = text.indexOf("{");
    if (i < 0) return null;
    try {
      const v = JSON.parse(text.slice(i));
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}

function statusFromExit(code: number | null, final: Record<string, unknown> | null): DriveRunStatus {
  if (code === 0) return "completed";
  if (code === 3) return "blocked";
  if (code === 4) return "awaiting-input";
  if (code === 1) return "halted";
  if (final && typeof final.status === "string") {
    const s = final.status;
    if (s === "completed" || s === "blocked" || s === "awaiting-input" || s === "halted") return s;
  }
  return "failed";
}

function spawnDrive(run: DriveRun, args: string[], deps: LauncherDeps): void {
  const cli = join(deps.pluginRoot, "apps", "pipeline-cli", "src", "cli.ts");
  const entryProject = deps.getProject(run.project_id);
  const cwd = entryProject?.project_root ?? process.cwd();
  run.status = "running";
  run.exit_code = null;
  run.ended_at = null;
  run.question = null;
  run.userStopped = false;
  run.stdout = "";
  driveRuns.set(run.run_id, run);
  persistLaunchJson(run);
  deps.broadcast({ type: "drive.run", data: snapshot(run) });

  const child = Bun.spawn({
    cmd: [process.execPath, cli, "drive", ...args],
    cwd,
    env: {
      ...process.env,
      // Events must flow to the journal so the dashboard lights up live.
      PIPELINE_UI_ENABLED: process.env.PIPELINE_UI_ENABLED ?? "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  driveChildren.set(run.run_id, child);

  const pump = async (stream: ReadableStream<Uint8Array> | null, sink: (s: string) => void) => {
    if (!stream) return;
    const dec = new TextDecoder();
    for await (const chunk of stream) sink(dec.decode(chunk));
  };
  const stdoutDone = pump(child.stdout as ReadableStream<Uint8Array>, (s) => {
    // Normally stdout is just drive's final JSON, but a custom --executor-cmd
    // may print arbitrarily — keep the TAIL (the final JSON is printed last)
    // so a chatty template can't grow the daemon's memory unbounded.
    run.stdout = (run.stdout + s).slice(-1_000_000);
  });
  const stderrDone = pump(child.stderr as ReadableStream<Uint8Array>, (s) => {
    run.stderr = (run.stderr + s).slice(-40_000);
    appendDriveLog(run, s);
  });

  void (async () => {
    const code = await child.exited;
    driveChildren.delete(run.run_id);
    await Promise.allSettled([stdoutDone, stderrDone]);
    // A user stop (stopDriveRun) already finalized the snapshot as halted —
    // don't let the killed child's exit code overwrite that verdict.
    if (run.userStopped) return;
    const final = parseDriveFinal(run.stdout);
    run.exit_code = code;
    run.ended_at = new Date().toISOString();
    run.status = statusFromExit(code, final);
    if (run.status === "awaiting-input" && final) {
      // Same defensive narrowing drive itself uses for needs-input records.
      run.question = extractQuestion(final, "the step asked for input");
      run.awaiting_iteration = typeof final.iteration_path === "string" ? final.iteration_path : run.start_path;
    } else {
      run.question = null;
    }
    if ((run.status === "halted" || run.status === "failed") && final && typeof final.reason === "string") {
      run.halt_reason = final.reason;
    }
    if (run.status === "failed" && run.halt_reason === null) {
      run.halt_reason = `drive exited ${code}; see drive.log`;
    }
    persistLaunchJson(run);
    evictTerminalDriveRuns();
    deps.broadcast({ type: "drive.run", data: snapshot(run) });
    deps.log(`drive run ${run.run_id} → ${run.status} (exit ${code})`);
  })();
}

export async function handleLaunchRun(req: Request, deps: LauncherDeps): Promise<Response> {
  let body: {
    project_id?: string;
    pipeline_root?: string;
    start?: string;
    task_text?: string;
    task_file?: string;
    default_model?: string;
    model_overrides?: Record<string, string>;
    default_effort?: string;
    effort_overrides?: Record<string, string>;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch (e) {
    return new Response(`bad request: ${e}`, { status: 400 });
  }
  if (!body.project_id || !body.pipeline_root) {
    return new Response("missing project_id or pipeline_root", { status: 400 });
  }
  const entry = deps.getProject(body.project_id);
  if (!entry) return new Response("unknown project", { status: 404 });
  if (!isInsidePipelinesDir(entry.project_root, body.pipeline_root)) {
    return new Response("pipeline_root is outside the project's pipelines dir", { status: 403 });
  }
  const pipelineRoot = resolve(body.pipeline_root);
  if (!existsSync(join(pipelineRoot, "PIPELINE.md"))) {
    return new Response("no PIPELINE.md at pipeline_root", { status: 404 });
  }
  let plan;
  try {
    plan = computePlan(pipelineRoot);
  } catch (e) {
    return new Response(`plan failed: ${e}`, { status: 422 });
  }
  if (plan.errors?.length) {
    return Response.json({ ok: false, errors: plan.errors }, { status: 422 });
  }
  const start = body.start ?? plan.steps[0]?.path;
  if (!start) return new Response("pipeline has no steps", { status: 422 });
  if (body.task_file && !existsSync(body.task_file)) {
    return new Response(`task_file does not exist: ${body.task_file}`, { status: 400 });
  }

  const runId = mintId("drv");
  const args = ["--root", pipelineRoot, "--run-id", runId, "--start", start, "--json"];
  if (body.default_model) args.push("--default-model", body.default_model);
  for (const [stepId, model] of Object.entries(body.model_overrides ?? {})) {
    if (stepId && model) args.push("--model", `${stepId}=${model}`);
  }
  if (body.default_effort) args.push("--default-effort", body.default_effort);
  for (const [stepId, effort] of Object.entries(body.effort_overrides ?? {})) {
    if (stepId && effort) args.push("--effort", `${stepId}=${effort}`);
  }
  if (body.task_text && body.task_text.trim()) args.push("--task", body.task_text);
  else if (body.task_file) args.push("--task-file", body.task_file);

  const run: DriveRun = {
    run_id: runId,
    project_id: body.project_id,
    pipeline_root: pipelineRoot.replaceAll("\\", "/"),
    pipeline_name: pipelineNameOf(entry.project_root, pipelineRoot),
    start_path: start.replaceAll("\\", "/"),
    status: "running",
    exit_code: null,
    launched_at: new Date().toISOString(),
    ended_at: null,
    question: null,
    awaiting_iteration: null,
    halt_reason: null,
    task_file: body.task_file ? resolve(body.task_file).replaceAll("\\", "/") : body.task_text ? "(inline)" : null,
    stdout: "",
    stderr: "",
  };
  spawnDrive(run, args, deps);
  return Response.json({ ok: true, run_id: runId, status: run.status }, { status: 202 });
}

export async function handleAnswerRun(req: Request, deps: LauncherDeps): Promise<Response> {
  let body: { project_id?: string; run_id?: string; answer?: string; pipeline_root?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch (e) {
    return new Response(`bad request: ${e}`, { status: 400 });
  }
  if (!body.project_id || !body.run_id || !body.answer || !body.answer.trim()) {
    return new Response("missing project_id, run_id or answer", { status: 400 });
  }
  const entry = deps.getProject(body.project_id);
  if (!entry) return new Response("unknown project", { status: 404 });

  // In-memory first; fall back to the persisted launch.json (daemon restart).
  let run = driveRuns.get(body.run_id);
  if (!run && body.pipeline_root) {
    if (!isInsidePipelinesDir(entry.project_root, body.pipeline_root)) {
      return new Response("pipeline_root is outside the project's pipelines dir", { status: 403 });
    }
    try {
      const persisted = JSON.parse(
        readFileSync(join(runtimeDir(resolve(body.pipeline_root), body.run_id), "launch.json"), "utf8"),
      ) as DriveRunSnapshot;
      run = { ...persisted, stdout: "", stderr: "" };
    } catch {
      // fall through to 404
    }
  }
  if (!run) return new Response("unknown run (pass pipeline_root to recover a persisted one)", { status: 404 });
  if (run.status !== "awaiting-input") {
    return new Response(`run is ${run.status}, not awaiting-input`, { status: 409 });
  }
  const iteration = run.awaiting_iteration ?? run.start_path;
  const args = [
    "--root",
    run.pipeline_root,
    "--run-id",
    run.run_id,
    "--resume",
    "--start",
    iteration,
    "--answer",
    body.answer,
    "--json",
  ];
  spawnDrive(run, args, deps);
  return Response.json({ ok: true, run_id: run.run_id, status: run.status }, { status: 202 });
}

export function handleListDriveRuns(url: URL, getProject: GetProject): Response {
  const pid = url.searchParams.get("project_id");
  if (!pid) return new Response("missing project_id", { status: 400 });
  if (!getProject(pid)) return new Response("unknown project", { status: 404 });
  const runs = [...driveRuns.values()]
    .filter((r) => r.project_id === pid)
    .sort((a, b) => (a.launched_at < b.launched_at ? 1 : -1))
    .map(snapshot);
  return Response.json({ runs });
}

// ---------------------------------------------------------------------------
// Headless usage fallback for /api/run-stats
// ---------------------------------------------------------------------------

/** The exact shape drive's emptyUsage()/addUsage() write to usage.json — the
 *  type is imported from envelope.ts so a new field there shows up here. */
export type DriveUsage = EnvelopeUsage & { cost_usd: number };

// run_id → resolved pipeline root (or null when none was found). Positive hits
// are stable for a run's lifetime; negatives are retried after a short TTL —
// /api/run-stats polls live runs every 4s and each miss would otherwise
// re-walk every pipeline root's directory tree.
const driveRootCache = new Map<string, { root: string | null; at: number }>();
const DRIVE_ROOT_NEGATIVE_TTL_MS = 15_000;

/** A headless run has no bound transcript for the stats fold, but drive
 *  accumulates envelope usage into .runtime/<run>/usage.json — find it via
 *  the in-memory run map first, then by scanning the project's pipeline
 *  roots. Null when the run left no usage file (manager-driven run). */
export function findDriveUsage(projectRoot: string, runId: string): DriveUsage | null {
  const read = (pipelineRoot: string): DriveUsage | null => {
    try {
      const v = JSON.parse(readFileSync(join(pipelineRoot, ".runtime", runId, "usage.json"), "utf8")) as Record<
        string,
        unknown
      >;
      const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
      return {
        input: num(v.input),
        output: num(v.output),
        cache_read: num(v.cache_read),
        cache_creation: num(v.cache_creation),
        cost_usd: num(v.cost_usd),
      };
    } catch {
      return null;
    }
  };
  const resolveRoot = (): string | null => {
    const known = driveRuns.get(runId);
    if (known) return resolve(known.pipeline_root);
    const cached = driveRootCache.get(runId);
    if (cached && (cached.root !== null || Date.now() - cached.at < DRIVE_ROOT_NEGATIVE_TTL_MS)) {
      return cached.root;
    }
    const found =
      listPipelineRoots(projectRoot).find(({ root }) => existsSync(join(root, ".runtime", runId)))?.root ?? null;
    driveRootCache.set(runId, { root: found, at: Date.now() });
    return found;
  };
  const root = resolveRoot();
  return root ? read(root) : null;
}

// ---------------------------------------------------------------------------
// Stop (user cancel)
// ---------------------------------------------------------------------------

const STOP_REASON = "stopped by user";

/** Stop a daemon-launched drive run: kill the live child process (if this
 *  daemon owns one) and finalize the snapshot as halted. Returns true when a
 *  drive run was found and stopped/marked; false when the run_id isn't a
 *  drive run this daemon knows (the caller then falls back to the journal
 *  dismiss). Safe to call for an already-terminal drive run (no-op, true). */
export function stopDriveRun(runId: string, broadcast: (msg: { type: string; data: unknown }) => void): boolean {
  const run = driveRuns.get(runId);
  if (!run) return false;
  const child = driveChildren.get(runId);
  const wasLive = run.status === "running" || run.status === "awaiting-input";
  if (wasLive) {
    run.userStopped = true;
    run.status = "halted";
    run.halt_reason = STOP_REASON;
    run.ended_at = new Date().toISOString();
    run.question = null;
    persistLaunchJson(run);
    evictTerminalDriveRuns();
    broadcast({ type: "drive.run", data: snapshot(run) });
  }
  if (child) {
    try {
      child.kill();
    } catch {
      // already exited — the exit handler cleans the map
    }
  }
  return true;
}

// Host binding + token auth moved to ./auth.ts — it is daemon-wide middleware
// (server.ts applies it to every request), not a launcher concern.
