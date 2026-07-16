// AI Fix — background `claude -p` sessions that repair pipeline lint issues.
//
// The editor's Validate button surfaces `pipeline plan` errors/warnings; the
// AI Fix button posts them here and a headless Claude session (model chosen in
// the UI) edits the pipeline files to resolve them. The job runs in the
// background; the UI polls the job snapshot until it lands.
//
// Endpoints (wired into server.ts handleApi):
//   POST /api/editor/ai-fix       — {project_id, pipeline_root, model?, issues[]}
//                                   → 202 {job_id}
//   GET  /api/editor/ai-fix?job_id= — job snapshot {status, started_at, ...}
//
// WRITE-SCOPE: the spawned session is instructed to edit ONLY inside the
// pipeline folder, and it runs with --permission-mode acceptEdits from the
// project root — the same trust level as the launcher's `pipeline drive`
// (which also spawns `claude -p` against consumer files on user request).
// pipeline_root is containment-checked before anything is spawned.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnvelope } from "../pipeline-cli/src/lib/envelope";
import { isInsidePipelinesDir, mintId, type GetProject } from "./launcher.ts";
import { evictOldestTerminal } from "./lib.ts";

export interface AiFixDeps {
  getProject: GetProject;
  log: (msg: string) => void;
}

export type AiFixStatus = "running" | "done" | "failed";

export interface AiFixJob {
  job_id: string;
  project_id: string;
  pipeline_root: string;
  model: string;
  issues: string[];
  status: AiFixStatus;
  started_at: string;
  ended_at: string | null;
  /** Claude's final text (truncated) — what it says it fixed. */
  summary: string | null;
  error: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
}

const jobs = new Map<string, AiFixJob>();
const MAX_TERMINAL_JOBS = 20;

const ALLOWED_MODELS = new Set(["haiku", "sonnet", "opus", "fable"]);
const MAX_ISSUES = 100;
const JOB_TIMEOUT_MS = 10 * 60_000;

function evictTerminalJobs(): void {
  evictOldestTerminal(
    jobs,
    (j) => j.status !== "running",
    (j) => j.ended_at ?? j.started_at,
    (j) => j.job_id,
    MAX_TERMINAL_JOBS,
  );
}

/** The prompt handed to the headless session. Exported for tests. */
export function buildAiFixPrompt(pipelineRoot: string, issues: string[]): string {
  const list = issues.map((i) => `- ${i}`).join("\n");
  return [
    `You are fixing validation issues in a Claude-Pipeline pipeline folder.`,
    ``,
    `Pipeline root: ${pipelineRoot}`,
    ``,
    `The \`pipeline plan\` lint reported these errors/warnings:`,
    list,
    ``,
    `Rules:`,
    `- Edit files ONLY inside ${pipelineRoot} (PIPELINE.md, steps/**.md, context modules). Never touch anything else in the repository.`,
    `- Make the minimal edits that resolve each issue while preserving the pipeline's intent. Do not rewrite content that isn't implicated.`,
    `- The PIPELINE.md manifest must keep its required sections (End State, Scope, Project Context, Invariants) and stay under ~300 tokens for a leaf pipeline.`,
    `- Steps keep their frontmatter contract (step_id, depends-on, model, permission-mode are the known keys).`,
    ``,
    `When you are done, reply with a short bullet list of what you changed and why it resolves each issue.`,
  ].join("\n");
}

export async function handleStartAiFix(req: Request, deps: AiFixDeps): Promise<Response> {
  let body: { project_id?: string; pipeline_root?: string; model?: string; issues?: unknown };
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
  const issues = Array.isArray(body.issues)
    ? body.issues.filter((i): i is string => typeof i === "string" && i.trim().length > 0).slice(0, MAX_ISSUES)
    : [];
  if (issues.length === 0) return new Response("no issues to fix", { status: 400 });
  const model = (body.model ?? "sonnet").trim().toLowerCase();
  if (!ALLOWED_MODELS.has(model)) {
    return new Response(`unknown model "${model}" (haiku|sonnet|opus|fable)`, { status: 400 });
  }
  // One job per pipeline at a time — two concurrent sessions editing the same
  // files would race each other.
  for (const j of jobs.values()) {
    if (j.status === "running" && j.pipeline_root === pipelineRoot.replaceAll("\\", "/")) {
      return new Response("an AI-fix job is already running for this pipeline", { status: 409 });
    }
  }

  // Spawn FIRST — the job is registered only once the process actually exists,
  // so a spawn failure is a plain error response, not a phantom "running" job
  // that needs rolling back.
  const startedMs = Date.now();
  const argv = ["claude", "-p", "--model", model, "--permission-mode", "acceptEdits", "--output-format", "json"];
  const spawnWith = (cmd: string[]) =>
    Bun.spawn({
      cmd,
      cwd: entry.project_root,
      stdin: new TextEncoder().encode(buildAiFixPrompt(pipelineRoot, issues)),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
  let child: ReturnType<typeof spawnWith>;
  try {
    child = spawnWith(argv);
  } catch (e) {
    // Windows: `claude` may be a .cmd shim only a shell can launch (same
    // fallback `pipeline drive` uses). All argv tokens are shell-safe —
    // the prompt travels via stdin.
    if (process.platform !== "win32") return new Response(`could not spawn claude: ${e}`, { status: 500 });
    try {
      child = spawnWith(["cmd.exe", "/c", ...argv]);
    } catch (e2) {
      return new Response(`could not spawn claude: ${e2}`, { status: 500 });
    }
  }

  const job: AiFixJob = {
    job_id: mintId("fix"),
    project_id: body.project_id,
    pipeline_root: pipelineRoot.replaceAll("\\", "/"),
    model,
    issues,
    status: "running",
    started_at: new Date().toISOString(),
    ended_at: null,
    summary: null,
    error: null,
    cost_usd: null,
    duration_ms: null,
  };
  jobs.set(job.job_id, job);

  const finish = (status: AiFixStatus, fields: Partial<AiFixJob>) => {
    job.status = status;
    job.ended_at = new Date().toISOString();
    job.duration_ms = Date.now() - startedMs;
    Object.assign(job, fields);
    evictTerminalJobs();
    deps.log(`ai-fix ${job.job_id} → ${status} (${Math.round(job.duration_ms / 1000)}s)`);
  };

  void (async () => {
    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, JOB_TIMEOUT_MS);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout as ReadableStream).text(),
        new Response(child.stderr as ReadableStream).text(),
        child.exited,
      ]);
      clearTimeout(killTimer);
      if (code !== 0) {
        finish("failed", { error: (stderr || stdout || `claude exited ${code}`).slice(0, 2000) });
        return;
      }
      // Same envelope contract `pipeline drive` consumes — one shared parser.
      const env = parseEnvelope(stdout);
      finish("done", {
        summary: env?.result?.slice(0, 4000) ?? (stdout.trim().slice(0, 4000) || null),
        cost_usd: env?.total_cost_usd ?? null,
      });
    } catch (e) {
      clearTimeout(killTimer);
      finish("failed", { error: String(e).slice(0, 2000) });
    }
  })();

  return Response.json({ ok: true, job_id: job.job_id }, { status: 202 });
}

export function handleGetAiFixJob(url: URL): Response {
  const id = url.searchParams.get("job_id");
  if (!id) return new Response("missing job_id", { status: 400 });
  const job = jobs.get(id);
  if (!job) return new Response("unknown job", { status: 404 });
  return Response.json(job);
}
