import type {
  ProjectEntry,
  ProjectState,
  PipelineInfo,
  IterationDetail,
  RunSummary,
  RunStats,
  RunFailuresResponse,
  RunBreakdownResponse,
  LaunchCatalogPipeline,
  DriveRunSnapshot,
  RunStepsResponse,
  AiFixJob,
} from "../types";

const base = ""; // same-origin

// --- Run launcher --------------------------------------------------------

/** Launchable-pipeline catalog: every pipeline root with its planned steps +
 *  resolved models, so the launch form can offer per-step overrides. */
export async function fetchLaunchPipelines(projectId: string): Promise<LaunchCatalogPipeline[]> {
  const r = await fetch(`${base}/api/pipelines?project_id=${encodeURIComponent(projectId)}`);
  if (!r.ok) throw new Error(`pipelines: ${r.status}`);
  const j = (await r.json()) as { pipelines: LaunchCatalogPipeline[] };
  return j.pipelines ?? [];
}

export interface LaunchRequest {
  project_id: string;
  pipeline_root: string;
  task_text?: string;
  task_file?: string;
  default_model?: string;
  model_overrides?: Record<string, string>;
  default_effort?: string;
  effort_overrides?: Record<string, string>;
  /** Declared `${PP_*}` values (name → value). Omit for a defaults-only run. */
  vars?: Record<string, string>;
}

/** Launch a headless run (`pipeline drive`). Resolves with the minted run_id;
 *  progress arrives via journal events + drive.run SSE broadcasts. */
export async function launchRun(reqBody: LaunchRequest): Promise<{ run_id: string }> {
  const r = await fetch(`${base}/api/runs/launch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
  });
  if (!r.ok) throw new Error(`launch: ${r.status} ${await r.text().catch(() => "")}`);
  return r.json();
}

/** Answer a parked needs-input question — the SAME executor session resumes. */
export async function answerRun(projectId: string, runId: string, answer: string): Promise<void> {
  const r = await fetch(`${base}/api/runs/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, run_id: runId, answer }),
  });
  if (!r.ok) throw new Error(`answer: ${r.status} ${await r.text().catch(() => "")}`);
}

export async function fetchDriveRuns(projectId: string): Promise<DriveRunSnapshot[]> {
  const r = await fetch(`${base}/api/drive-runs?project_id=${encodeURIComponent(projectId)}`);
  if (!r.ok) throw new Error(`drive-runs: ${r.status}`);
  const j = (await r.json()) as { runs: DriveRunSnapshot[] };
  return j.runs ?? [];
}

// --- Speech-to-text --------------------------------------------------------

export interface SttStatus {
  available: boolean;
  provider: string | null;
  model: string | null;
}

export async function fetchSttStatus(): Promise<SttStatus> {
  const r = await fetch(`${base}/api/transcribe/status`);
  if (!r.ok) return { available: false, provider: null, model: null };
  return r.json();
}

/** Send recorded audio to the daemon's STT proxy; resolves with the text. */
export async function transcribeAudio(blob: Blob, lang?: string): Promise<string> {
  const r = await fetch(`${base}/api/transcribe${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`, {
    method: "POST",
    headers: { "Content-Type": blob.type || "audio/webm" },
    body: blob,
  });
  if (!r.ok) throw new Error(`transcribe: ${r.status} ${await r.text().catch(() => "")}`);
  const j = (await r.json()) as { text: string };
  return j.text ?? "";
}

// --- Pipeline editor -------------------------------------------------------

export interface EditorFile {
  path: string;
  content: string;
  sha1: string;
  size: number;
  modified_at: string;
}

export async function fetchEditorFiles(projectId: string, pipelineRoot: string): Promise<string[]> {
  const r = await fetch(
    `${base}/api/editor/list?project_id=${encodeURIComponent(projectId)}&pipeline_root=${encodeURIComponent(pipelineRoot)}`,
  );
  if (!r.ok) throw new Error(`editor list: ${r.status}`);
  const j = (await r.json()) as { files: string[] };
  return j.files ?? [];
}

export async function fetchEditorFile(projectId: string, path: string): Promise<EditorFile> {
  const r = await fetch(
    `${base}/api/editor/file?project_id=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`,
  );
  if (!r.ok) throw new Error(`editor read: ${r.status}`);
  return r.json();
}

/** Save a file. Throws {conflict:true, current_sha1} on a 409 (someone else
 *  edited it since we loaded). */
export async function saveEditorFile(
  projectId: string,
  path: string,
  content: string,
  expectedSha1?: string,
): Promise<{ sha1: string }> {
  const r = await fetch(`${base}/api/editor/file`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, path, content, expected_sha1: expectedSha1 }),
  });
  if (r.status === 409) {
    const j = (await r.json()) as { current_sha1: string };
    const err = new Error("conflict") as Error & { conflict: boolean; current_sha1: string };
    err.conflict = true;
    err.current_sha1 = j.current_sha1;
    throw err;
  }
  if (!r.ok) throw new Error(`editor save: ${r.status} ${await r.text().catch(() => "")}`);
  return r.json();
}

export async function deleteEditorFile(projectId: string, path: string): Promise<void> {
  const r = await fetch(`${base}/api/editor/file`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, path }),
  });
  if (!r.ok) throw new Error(`editor delete: ${r.status} ${await r.text().catch(() => "")}`);
}

export async function createStep(
  projectId: string,
  pipelineRoot: string,
  title: string,
): Promise<{ rel: string; filename: string }> {
  const r = await fetch(`${base}/api/editor/create-step`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, pipeline_root: pipelineRoot, title }),
  });
  if (!r.ok) throw new Error(`create-step: ${r.status} ${await r.text().catch(() => "")}`);
  return r.json();
}

export interface ValidateResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  steps: string[];
  mode?: string;
}

export async function validatePipeline(projectId: string, pipelineRoot: string): Promise<ValidateResult> {
  const r = await fetch(`${base}/api/editor/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, pipeline_root: pipelineRoot }),
  });
  if (!r.ok) throw new Error(`validate: ${r.status}`);
  return r.json();
}

/** Accurate per-run tool/token stats, folded server-side from the raw
 *  manager+subagent transcripts (the hook-event stats undercount badly). */
export async function fetchRunStats(projectId: string, runId: string): Promise<RunStats> {
  const r = await fetch(
    `${base}/api/run-stats?project_id=${encodeURIComponent(projectId)}&run_id=${encodeURIComponent(runId)}`,
  );
  if (!r.ok) throw new Error(`run-stats: ${r.status}`);
  return r.json();
}

export async function fetchRuns(
  projectId: string,
  limit = 100,
): Promise<RunSummary[]> {
  const r = await fetch(
    `${base}/api/runs?project_id=${encodeURIComponent(projectId)}&limit=${limit}`,
  );
  if (!r.ok) throw new Error(`runs: ${r.status}`);
  const j = (await r.json()) as { runs: RunSummary[] };
  return j.runs ?? [];
}

/** Manually clear a run the user knows is dead. The daemon appends a synthetic
 *  pipeline.halted so the run folds to terminal and leaves the Active list. */
export async function dismissRun(projectId: string, runId: string): Promise<void> {
  const r = await fetch(`${base}/api/runs/dismiss`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, run_id: runId }),
  });
  if (!r.ok) throw new Error(`dismiss: ${r.status}`);
}

/** Stop/cancel a run: kills the daemon-launched drive child when there is
 *  one, and appends the synthetic halt in every case (covers stale runs). */
export async function stopRun(projectId: string, runId: string): Promise<void> {
  const r = await fetch(`${base}/api/runs/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, run_id: runId }),
  });
  if (!r.ok) throw new Error(`stop: ${r.status} ${await r.text().catch(() => "")}`);
}

/** Per-step wall-clock timings for one run, folded server-side from the FULL
 *  journal history (works for runs whose events left the live window). */
export async function fetchRunSteps(projectId: string, runId: string): Promise<RunStepsResponse> {
  const r = await fetch(
    `${base}/api/run-steps?project_id=${encodeURIComponent(projectId)}&run_id=${encodeURIComponent(runId)}`,
  );
  if (!r.ok) throw new Error(`run-steps: ${r.status}`);
  return r.json();
}

/** Per-failure detail behind the FAIL analytics tile: every tool_result error
 *  from the run's transcripts, with the tool's name + input and error text. */
export async function fetchRunFailures(projectId: string, runId: string): Promise<RunFailuresResponse> {
  const r = await fetch(
    `${base}/api/run-failures?project_id=${encodeURIComponent(projectId)}&run_id=${encodeURIComponent(runId)}`,
  );
  if (!r.ok) throw new Error(`run-failures: ${r.status}`);
  return r.json();
}

/** TOOLS/AGENTS drill-down behind the analytics tiles: per-tool aggregates +
 *  individual timed calls, and one row per spawned agent with its tokens. */
export async function fetchRunBreakdown(projectId: string, runId: string): Promise<RunBreakdownResponse> {
  const r = await fetch(
    `${base}/api/run-breakdown?project_id=${encodeURIComponent(projectId)}&run_id=${encodeURIComponent(runId)}`,
  );
  if (!r.ok) throw new Error(`run-breakdown: ${r.status}`);
  return r.json();
}

// --- AI Fix (editor validate → background claude -p) -----------------------

export async function startAiFix(
  projectId: string,
  pipelineRoot: string,
  model: string,
  issues: string[],
): Promise<{ job_id: string }> {
  const r = await fetch(`${base}/api/editor/ai-fix`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, pipeline_root: pipelineRoot, model, issues }),
  });
  if (!r.ok) throw new Error(`ai-fix: ${r.status} ${await r.text().catch(() => "")}`);
  return r.json();
}

export async function fetchAiFixJob(jobId: string): Promise<AiFixJob> {
  const r = await fetch(`${base}/api/editor/ai-fix?job_id=${encodeURIComponent(jobId)}`);
  if (!r.ok) throw new Error(`ai-fix job: ${r.status}`);
  return r.json();
}

export async function fetchProjects(): Promise<ProjectEntry[]> {
  const r = await fetch(`${base}/api/projects`);
  if (!r.ok) throw new Error(`projects: ${r.status}`);
  const j = await r.json();
  return j.projects ?? [];
}

export async function fetchProjectState(projectId: string): Promise<ProjectState> {
  const r = await fetch(`${base}/api/state?project_id=${encodeURIComponent(projectId)}`);
  if (!r.ok) throw new Error(`state: ${r.status}`);
  return r.json();
}

export async function fetchPipeline(projectId: string, name: string): Promise<PipelineInfo> {
  const r = await fetch(
    `${base}/api/pipeline?project_id=${encodeURIComponent(projectId)}&name=${encodeURIComponent(name)}`,
  );
  if (!r.ok) throw new Error(`pipeline: ${r.status}`);
  return r.json();
}

export async function fetchIteration(
  projectId: string,
  name: string,
  rel: string,
  /** The pipeline's root — disambiguates duplicate basenames server-side.
   *  Older daemons ignore the extra param (name-only fallback). */
  root?: string | null,
): Promise<IterationDetail> {
  const r = await fetch(
    `${base}/api/iteration?project_id=${encodeURIComponent(projectId)}&name=${encodeURIComponent(
      name,
    )}&rel=${encodeURIComponent(rel)}${root ? `&root=${encodeURIComponent(root)}` : ""}`,
  );
  if (!r.ok) throw new Error(`iteration: ${r.status}`);
  return r.json();
}

export interface ChatSessionRecord {
  run_id: string;
  sdk_session_id: string;
  project_root: string;
  pipeline_name: string | null;
  iteration_path: string | null;
  prompt: string;
  ts: string;
}

export interface TranscriptEntry {
  id: string;
  kind: "session" | "subagent";
  session_id: string;
  subagent_id?: string;
  path: string;
  size_bytes: number;
  modified_at: string;
}

export interface TranscriptBody {
  id: string;
  path: string;
  size_bytes: number;
  modified_at: string;
  truncated: boolean;
  messages: unknown[];
}

export async function fetchTranscripts(
  projectId: string,
  limit = 100,
): Promise<{ transcripts: TranscriptEntry[]; total: number }> {
  const r = await fetch(
    `${base}/api/transcripts?project_id=${encodeURIComponent(projectId)}&limit=${limit}`,
  );
  if (!r.ok) throw new Error(`transcripts: ${r.status}`);
  return r.json();
}

export async function fetchTranscript(
  projectId: string,
  id: string,
): Promise<TranscriptBody> {
  const r = await fetch(
    `${base}/api/transcript?project_id=${encodeURIComponent(projectId)}&id=${encodeURIComponent(id)}`,
  );
  if (!r.ok) throw new Error(`transcript: ${r.status}`);
  return r.json();
}

/**
 * Full SDK-message transcript for a single chat run. The shape of each entry
 * mirrors whatever the daemon forwarded on its SSE stream — assistant / user /
 * tool_use / result / system messages — so the UI can convert it into its
 * internal ChatItem shape.
 */
export async function fetchChatMessages(
  projectId: string,
  runId: string,
): Promise<unknown[]> {
  const r = await fetch(
    `${base}/api/chat/messages?project_id=${encodeURIComponent(projectId)}&run_id=${encodeURIComponent(runId)}`,
  );
  if (!r.ok) throw new Error(`chat messages: ${r.status}`);
  const j = (await r.json()) as { messages: unknown[] };
  return j.messages ?? [];
}

export async function fetchChatSessions(
  projectId: string,
): Promise<ChatSessionRecord[]> {
  const r = await fetch(
    `${base}/api/chat/sessions?project_id=${encodeURIComponent(projectId)}`,
  );
  if (!r.ok) throw new Error(`chat sessions: ${r.status}`);
  const j = (await r.json()) as { sessions: ChatSessionRecord[] };
  return j.sessions ?? [];
}

/**
 * Open an SSE-streaming chat session. POSTs the prompt, then reads the
 * `text/event-stream` body chunk-by-chunk. `onEvent` fires per parsed event.
 * Returns a cleanup function that aborts the stream.
 */
export function streamChat(
  body: {
    project_id: string;
    pipeline_name?: string | null;
    prompt: string;
    /** Optional Claude model id (e.g. "claude-haiku-4-5-20251001"). */
    model?: string | null;
  },
  onEvent: (type: string, data: unknown) => void,
): { cancel: () => void } {
  return streamSseFromPost(`${base}/api/chat`, body, onEvent);
}

/**
 * Resume a previously-interrupted SDK chat session by run_id. The daemon
 * looks up the original sdk_session_id from chat-sessions.jsonl and passes
 * it through to the SDK as `resume`. Optional `prompt` is sent as the new
 * user turn; if omitted, the daemon uses a "continue where you left off"
 * default.
 */
export function streamChatResume(
  body: {
    project_id: string;
    run_id: string;
    prompt?: string;
    /** Optional model override; same shape as /api/chat — accepts an alias
     *  (haiku|sonnet|opus|fable), a canonical Anthropic `claude-*` id, or
     *  `inherit`. */
    model?: string | null;
  },
  onEvent: (type: string, data: unknown) => void,
): { cancel: () => void } {
  return streamSseFromPost(`${base}/api/chat/resume`, body, onEvent);
}

function streamSseFromPost(
  url: string,
  body: unknown,
  onEvent: (type: string, data: unknown) => void,
): { cancel: () => void } {
  const controller = new AbortController();
  (async () => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        onEvent("chat.error", { message: `HTTP ${res.status}: ${await res.text().catch(() => "")}` });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // SSE frames are separated by a blank line. Each frame can have multiple
      // `event:` / `data:` lines; we only emit when we see the terminator.
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
          onEvent(type, data);
        }
      }
    } catch (e: unknown) {
      if ((e as { name?: string })?.name === "AbortError") return;
      onEvent("chat.error", { message: String(e) });
    }
  })();
  return { cancel: () => controller.abort() };
}

export async function fetchHealth(): Promise<{
  ok: boolean;
  plugin_version: string;
  schema: number;
  uptime_seconds: number;
  projects: number;
  clients: number;
}> {
  const r = await fetch(`${base}/api/health`);
  if (!r.ok) throw new Error(`health: ${r.status}`);
  return r.json();
}

export interface UpdateStatus {
  current_version: string;
  current_plugin_root: string;
  update: { plugin_root: string; version: string } | null;
  restarting: boolean;
}

export async function fetchUpdateStatus(): Promise<UpdateStatus> {
  const r = await fetch(`${base}/api/update-status`);
  if (!r.ok) throw new Error(`update-status: ${r.status}`);
  return r.json();
}

/** Ask the daemon to restart itself — into the pending update when one is
 *  installed, else from its current root. The daemon broadcasts a `restart`
 *  SSE frame before exiting; useReloadOnRestart picks the page up from there. */
export async function postRestart(): Promise<{ ok: boolean; to_version: string | null }> {
  const r = await fetch(`${base}/api/restart`, { method: "POST" });
  if (!r.ok) throw new Error(`restart: ${r.status}`);
  return r.json();
}
