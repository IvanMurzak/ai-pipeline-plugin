// Pipeline editor — the daemon-side backend for editing pipeline files from
// the browser: the PIPELINE.md manifest, steps/NN-*.md iterations, context
// modules, and per-pipeline scripts.
//
// Endpoints (wired into server.ts handleApi):
//   GET    /api/editor/list?project_id=&pipeline_root=   — editable files of one pipeline
//   GET    /api/editor/file?project_id=&path=<rel>       — content + sha1 (optimistic concurrency token)
//   PUT    /api/editor/file                              — {project_id, path, content, expected_sha1?}
//   DELETE /api/editor/file                              — {project_id, path} (never PIPELINE.md)
//   POST   /api/editor/create-step                       — {project_id, pipeline_root, title} → next NN-*.md from the designer template
//   POST   /api/editor/validate                          — {project_id, pipeline_root} → computePlan errors/warnings
//
// WRITE-SCOPE CONTRACT (defense in depth, tested):
//   - every path is RELATIVE to <project>/.claude/pipeline and must resolve
//     back inside it (no `..`, no absolute paths, symlink-agnostic resolve);
//   - runtime/measurement dot-dirs (.runtime, .stats, .feedback) are
//     read-and-write FORBIDDEN — the run machinery owns them;
//   - extension allow-list (.md/.py/.json/.yaml/.yml/.sh/.ps1/.txt), 1 MB cap;
//   - deleting PIPELINE.md is refused (it would orphan the whole pipeline).

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { computePlan } from "../pipeline-cli/src/lib/plan";
import type { GetProject } from "./launcher";
import { isInsidePipelinesDir } from "./launcher";
import { normalizePathForCompare } from "./lib.ts";

const MAX_BYTES = 1_000_000;
const ALLOWED_EXT = new Set([".md", ".py", ".json", ".yaml", ".yml", ".sh", ".ps1", ".txt"]);
const FORBIDDEN_DIRS = new Set([".runtime", ".stats", ".feedback"]);

export interface EditorDeps {
  getProject: GetProject;
  broadcast: (msg: { type: string; data: unknown }) => void;
  /** Invalidate the pipeline/catalog caches for a project after a write. */
  invalidate: (projectRoot: string) => void;
  log: (msg: string) => void;
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i).toLowerCase();
}

/** Resolve a pipelines-dir-relative path with every guard applied. Returns the
 *  absolute path or an error Response. */
export function resolveEditorPath(projectRoot: string, rel: string): { full: string } | { error: Response } {
  if (!rel || rel.includes("\0")) return { error: new Response("invalid path", { status: 400 }) };
  const norm = rel.replaceAll("\\", "/");
  if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm) || norm.split("/").includes("..")) {
    return { error: new Response("invalid path (absolute or traversal)", { status: 400 }) };
  }
  for (const part of norm.split("/")) {
    if (FORBIDDEN_DIRS.has(part)) {
      return { error: new Response(`forbidden path segment: ${part}`, { status: 403 }) };
    }
  }
  if (!ALLOWED_EXT.has(extOf(norm))) {
    return { error: new Response(`extension not editable (allowed: ${[...ALLOWED_EXT].join(" ")})`, { status: 403 }) };
  }
  const base = resolve(projectRoot, ".claude", "pipeline");
  const full = resolve(base, norm);
  // Shared daemon path normalizer — containment checks must not each grow
  // their own Windows case-fold variant.
  if (!normalizePathForCompare(full).startsWith(normalizePathForCompare(base) + "/")) {
    return { error: new Response("path escapes the pipelines dir", { status: 403 }) };
  }
  return { full };
}

/** Relative (to the pipelines dir) editable files of one pipeline root:
 *  PIPELINE.md, root-level context modules, steps/**, scripts/**. */
export function listEditableFiles(projectRoot: string, pipelineRoot: string): string[] {
  const base = resolve(projectRoot, ".claude", "pipeline");
  const root = resolve(pipelineRoot);
  const out: string[] = [];
  const relOf = (p: string) => p.slice(base.length + 1).replaceAll("\\", "/");
  const scan = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".") || n === "targets" || n === "node_modules") continue;
      const full = join(dir, n);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) scan(full, depth + 1);
      else if (ALLOWED_EXT.has(extOf(n)) && st.size <= MAX_BYTES) out.push(relOf(full));
    }
  };
  scan(root, 0);
  // Manifest first, then steps in order, then the rest.
  return out.sort((a, b) => {
    const w = (p: string) => (p.endsWith("PIPELINE.md") ? 0 : p.includes("/steps/") ? 1 : 2);
    return w(a) - w(b) || a.localeCompare(b);
  });
}

export function handleEditorList(url: URL, deps: EditorDeps): Response {
  const pid = url.searchParams.get("project_id");
  const pipelineRoot = url.searchParams.get("pipeline_root");
  if (!pid || !pipelineRoot) return new Response("missing params", { status: 400 });
  const entry = deps.getProject(pid);
  if (!entry) return new Response("unknown project", { status: 404 });
  if (!isInsidePipelinesDir(entry.project_root, pipelineRoot)) {
    return new Response("pipeline_root is outside the project's pipelines dir", { status: 403 });
  }
  return Response.json({ files: listEditableFiles(entry.project_root, pipelineRoot) });
}

export function handleEditorRead(url: URL, deps: EditorDeps): Response {
  const pid = url.searchParams.get("project_id");
  const rel = url.searchParams.get("path");
  if (!pid || !rel) return new Response("missing params", { status: 400 });
  const entry = deps.getProject(pid);
  if (!entry) return new Response("unknown project", { status: 404 });
  const r = resolveEditorPath(entry.project_root, rel);
  if ("error" in r) return r.error;
  if (!existsSync(r.full)) return new Response("not found", { status: 404 });
  const st = statSync(r.full);
  if (st.size > MAX_BYTES) return new Response("file too large to edit here", { status: 413 });
  const content = readFileSync(r.full, "utf8");
  return Response.json({
    path: rel.replaceAll("\\", "/"),
    content,
    sha1: sha1(content),
    size: st.size,
    modified_at: st.mtime.toISOString(),
  });
}

export async function handleEditorWrite(req: Request, deps: EditorDeps): Promise<Response> {
  let body: { project_id?: string; path?: string; content?: string; expected_sha1?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch (e) {
    return new Response(`bad request: ${e}`, { status: 400 });
  }
  if (!body.project_id || !body.path || typeof body.content !== "string") {
    return new Response("missing project_id, path or content", { status: 400 });
  }
  if (body.content.length > MAX_BYTES) return new Response("content too large", { status: 413 });
  const entry = deps.getProject(body.project_id);
  if (!entry) return new Response("unknown project", { status: 404 });
  const r = resolveEditorPath(entry.project_root, body.path);
  if ("error" in r) return r.error;

  // Optimistic concurrency: refuse to clobber someone else's edit.
  if (existsSync(r.full) && body.expected_sha1) {
    const current = sha1(readFileSync(r.full, "utf8"));
    if (current !== body.expected_sha1) {
      return Response.json({ ok: false, conflict: true, current_sha1: current }, { status: 409 });
    }
  }
  try {
    mkdirSync(dirname(r.full), { recursive: true });
    writeFileSync(r.full, body.content, "utf8");
  } catch (e) {
    return new Response(`write failed: ${e}`, { status: 500 });
  }
  deps.invalidate(entry.project_root);
  deps.broadcast({ type: "file.changed", data: { project_id: body.project_id, path: body.path } });
  deps.log(`editor write: ${body.path}`);
  return Response.json({ ok: true, sha1: sha1(body.content) });
}

export async function handleEditorDelete(req: Request, deps: EditorDeps): Promise<Response> {
  let body: { project_id?: string; path?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch (e) {
    return new Response(`bad request: ${e}`, { status: 400 });
  }
  if (!body.project_id || !body.path) return new Response("missing project_id or path", { status: 400 });
  const entry = deps.getProject(body.project_id);
  if (!entry) return new Response("unknown project", { status: 404 });
  const r = resolveEditorPath(entry.project_root, body.path);
  if ("error" in r) return r.error;
  if (body.path.replaceAll("\\", "/").endsWith("PIPELINE.md")) {
    return new Response("refusing to delete a pipeline manifest", { status: 403 });
  }
  if (!existsSync(r.full)) return new Response("not found", { status: 404 });
  try {
    unlinkSync(r.full);
  } catch (e) {
    return new Response(`delete failed: ${e}`, { status: 500 });
  }
  deps.invalidate(entry.project_root);
  deps.broadcast({ type: "file.changed", data: { project_id: body.project_id, path: body.path } });
  return Response.json({ ok: true });
}

/** The designer-contract iteration skeleton (agents/pipeline-designer.md §
 *  required sections, in order). */
export function stepTemplate(title: string): string {
  return `# ${title}

## Goal
<!-- One or two sentences stating exactly what this iteration achieves. -->

## Context
- <!-- Links to prior iterations / project files this one depends on (absolute paths). -->

## Inputs
- <!-- Files to read; data, parameters, or decisions already made; preconditions. -->

## Steps
1. <!-- Concrete, ordered actions. Exact file paths, function names, commands. -->

## Success Criteria
- <!-- Verifiable, objective, binary. "Test X passes." "Command W exits 0." -->

## Next
<!-- Absolute path of the next iteration, or PIPELINE_COMPLETE. -->
`;
}

function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "step";
}

export async function handleEditorCreateStep(req: Request, deps: EditorDeps): Promise<Response> {
  let body: { project_id?: string; pipeline_root?: string; title?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch (e) {
    return new Response(`bad request: ${e}`, { status: 400 });
  }
  if (!body.project_id || !body.pipeline_root || !body.title?.trim()) {
    return new Response("missing project_id, pipeline_root or title", { status: 400 });
  }
  const entry = deps.getProject(body.project_id);
  if (!entry) return new Response("unknown project", { status: 404 });
  if (!isInsidePipelinesDir(entry.project_root, body.pipeline_root)) {
    return new Response("pipeline_root is outside the project's pipelines dir", { status: 403 });
  }
  const stepsDir = join(resolve(body.pipeline_root), "steps");
  let next = 1;
  try {
    for (const n of readdirSync(stepsDir)) {
      const m = /^(\d+)-/.exec(n);
      if (m) next = Math.max(next, Number(m[1]) + 1);
    }
  } catch {
    // no steps dir yet — created below
  }
  const filename = `${String(next).padStart(2, "0")}-${slugify(body.title)}.md`;
  const full = join(stepsDir, filename);
  if (existsSync(full)) return new Response(`already exists: ${filename}`, { status: 409 });
  try {
    mkdirSync(stepsDir, { recursive: true });
    writeFileSync(full, stepTemplate(body.title.trim()), "utf8");
  } catch (e) {
    return new Response(`create failed: ${e}`, { status: 500 });
  }
  deps.invalidate(entry.project_root);
  deps.broadcast({ type: "file.changed", data: { project_id: body.project_id, path: filename } });
  const base = resolve(entry.project_root, ".claude", "pipeline");
  return Response.json({ ok: true, rel: full.slice(base.length + 1).replaceAll("\\", "/"), filename });
}

export async function handleEditorValidate(req: Request, deps: EditorDeps): Promise<Response> {
  let body: { project_id?: string; pipeline_root?: string };
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
  try {
    const plan = computePlan(resolve(body.pipeline_root));
    return Response.json({
      ok: plan.errors.length === 0,
      errors: plan.errors ?? [],
      warnings: plan.warnings ?? [],
      steps: plan.steps.map((s) => s.step_id),
      mode: plan.mode,
    });
  } catch (e) {
    return Response.json({ ok: false, errors: [String(e instanceof Error ? e.message : e)], warnings: [], steps: [] });
  }
}
