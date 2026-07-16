/**
 * Pipeline UI — Claude Code transcript endpoints.
 *
 * Extracted from server.ts so the boot module stays smaller. These handlers
 * only depend on:
 *   - a project lookup (we accept a `getProject(pid)` callback)
 *   - filesystem access under `~/.claude/projects/<encoded>/`
 *
 * No SSE state, no chat state, no registry mutation. Easy to unit-test by
 * passing a getProject stub.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TranscriptEntry {
  /** Stable id usable as the `id` query param to /api/transcript.
   *  Either `<session-uuid>` or `<session-uuid>/<subagent-filename>`. */
  id: string;
  kind: "session" | "subagent";
  session_id: string;
  subagent_id?: string;
  /** Absolute path on disk. Kept for debugging but the UI shouldn't need it. */
  path: string;
  size_bytes: number;
  modified_at: string;
  /** First H1-style hint from the transcript, when we can scrape one. */
  preview?: string;
}

export interface ProjectLike {
  project_root: string;
}

export type GetProject = (project_id: string) => ProjectLike | undefined;

/**
 * Encode an absolute filesystem path the way Claude Code does for its
 * `~/.claude/projects/<encoded>/` directory: replace EVERY non-alphanumeric
 * character with `-`. So `C:\Projects\foo` → `C--Projects-foo` and
 * `C:\p\v6000.3.1f1` → `C--p-v6000-3-1f1`. (Verified against real projects
 * dirs — the whole observed alphabet is [a-zA-Z0-9-]; the old separator-only
 * rule kept dots, so any project path containing `.` or `_` resolved to a
 * directory that never exists and every transcript feature silently no-op'd.)
 */
export function encodeClaudeProjectDir(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, "-");
}

/** `~/.claude/projects` — the single definition of where Claude Code keeps
 *  session transcripts (transcript-stats' run_id scan reuses it). The optional
 *  override exists for tests. */
export function claudeProjectsDir(homeOverride?: string): string {
  const home = homeOverride ?? process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  return join(home, ".claude", "projects");
}

export function listTranscriptsForProject(projectRoot: string): TranscriptEntry[] {
  const dir = join(claudeProjectsDir(), encodeClaudeProjectDir(projectRoot));
  if (!existsSync(dir)) return [];
  const out: TranscriptEntry[] = [];

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  // Top-level session files.
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".jsonl")) {
      const sessionId = e.name.replace(/\.jsonl$/, "");
      const full = join(dir, e.name);
      try {
        const st = statSync(full);
        out.push({
          id: sessionId,
          kind: "session",
          session_id: sessionId,
          path: full,
          size_bytes: st.size,
          modified_at: st.mtime.toISOString(),
        });
      } catch {
        /* skip */
      }
    }
  }

  // Subagent files under <session>/subagents/<agent-id>.jsonl.
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sessionId = e.name;
    const subDir = join(dir, sessionId, "subagents");
    if (!existsSync(subDir)) continue;
    let subEntries;
    try {
      subEntries = readdirSync(subDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const se of subEntries) {
      if (!se.isFile() || !se.name.endsWith(".jsonl")) continue;
      const full = join(subDir, se.name);
      try {
        const st = statSync(full);
        out.push({
          id: `${sessionId}/${se.name.replace(/\.jsonl$/, "")}`,
          kind: "subagent",
          session_id: sessionId,
          subagent_id: se.name.replace(/\.jsonl$/, ""),
          path: full,
          size_bytes: st.size,
          modified_at: st.mtime.toISOString(),
        });
      } catch {
        /* skip */
      }
    }
  }

  out.sort((a, b) => (a.modified_at < b.modified_at ? 1 : -1));
  return out;
}

export function handleListTranscripts(url: URL, getProject: GetProject): Response {
  const pid = url.searchParams.get("project_id");
  if (!pid) return new Response("missing project_id", { status: 400 });
  const entry = getProject(pid);
  if (!entry) return new Response("unknown project", { status: 404 });
  // Clamp limit, treating non-numeric / NaN as the default. Without
  // Number.isFinite the Number("abc") → NaN path propagates through
  // Math.min/Math.max and `.slice(0, NaN)` silently returns [].
  const rawLimit = Number(url.searchParams.get("limit") ?? 100);
  const limit = Math.max(
    1,
    Math.min(1000, Number.isFinite(rawLimit) ? rawLimit : 100),
  );
  const all = listTranscriptsForProject(entry.project_root);
  const transcripts = all.slice(0, limit);
  return Response.json({ transcripts, total: all.length });
}

/**
 * Read a single transcript file and return its messages in a UI-friendly
 * shape. Truncates the response body at MAX_BYTES so a runaway transcript
 * doesn't choke the browser.
 */
export async function handleReadTranscript(url: URL, getProject: GetProject): Promise<Response> {
  const pid = url.searchParams.get("project_id");
  const id = url.searchParams.get("id");
  if (!pid || !id) return new Response("missing params", { status: 400 });
  const entry = getProject(pid);
  if (!entry) return new Response("unknown project", { status: 404 });
  // Reject path traversal — `id` can only contain UUIDs, dashes, and one
  // optional `/<subagent>` segment.
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/.test(id)) {
    return new Response("invalid id", { status: 400 });
  }
  const baseDir = join(claudeProjectsDir(), encodeClaudeProjectDir(entry.project_root));
  if (!existsSync(baseDir)) return new Response("no transcripts", { status: 404 });

  // Resolve `id` → file path. Session form: `<uuid>` → `<uuid>.jsonl`.
  // Subagent form: `<session-uuid>/<subagent-id>` → `<uuid>/subagents/<subagent-id>.jsonl`.
  let filePath: string;
  if (id.includes("/")) {
    const [sessionId, subagentId] = id.split("/", 2);
    filePath = join(baseDir, sessionId, "subagents", subagentId + ".jsonl");
  } else {
    filePath = join(baseDir, id + ".jsonl");
  }
  if (!filePath.startsWith(baseDir)) return new Response("forbidden", { status: 403 });
  if (!existsSync(filePath)) return new Response("not found", { status: 404 });

  const MAX_BYTES = 2_000_000;
  let raw: string;
  let truncated = false;
  let stSize: number;
  let stMtime: Date;
  try {
    const st = statSync(filePath);
    stSize = st.size;
    stMtime = st.mtime;
    if (st.size > MAX_BYTES) {
      // Tail-read via Bun.file().slice() — reading the whole file just to
      // discard 98% of it spiked daemon RSS by the full file size on every
      // request and blocked the event loop on big Claude Code sessions.
      const start = st.size - MAX_BYTES;
      raw = await Bun.file(filePath).slice(start, st.size).text();
      truncated = true;
    } else {
      raw = await Bun.file(filePath).text();
    }
  } catch (e) {
    return new Response(`read failed: ${e}`, { status: 500 });
  }

  const lines = raw.split("\n");
  if (truncated && lines.length > 0) lines.shift();
  const messages: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      /* skip malformed */
    }
  }
  return Response.json({
    id,
    path: filePath,
    size_bytes: stSize,
    modified_at: stMtime.toISOString(),
    truncated,
    messages,
  });
}
