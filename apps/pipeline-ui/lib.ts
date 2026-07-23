/**
 * Pipeline UI — pure helpers extracted from server.ts so tests can exercise
 * them without booting the daemon. Nothing here owns network state or the
 * lock file; only filesystem reads and string parsing.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";

/** Transcript opt-out switch (`PIPELINE_UI_TRANSCRIPTS`). ON BY DEFAULT.
 *
 *  Gates ONLY the privacy-sensitive transcript mirroring/fold: the daemon
 *  copying Claude Code transcript CONTENT into a run's chat panel
 *  (`mirror.ts`) and folding the RAW transcripts for the per-run token/tool
 *  analytics (`/api/run-stats` / `-failures` / `-breakdown`), plus the Stop
 *  hook's transcript token tail. It does NOT gate the UI daemon, the basic
 *  pipeline-lifecycle events (`pipeline.*` / `iteration.*` / `tool.called` /
 *  `manager.stopped`), or the mirror-binding's run-correlation.
 *
 *  Orthogonal to the two neighbouring switches: `PIPELINE_UI_ENABLED` (the
 *  UI/analytics MASTER opt-out — off ⇒ everything off) and
 *  `PIPELINE_STATS_ENABLED` (the separate `.claude/pipeline/.stats/`
 *  measurement fold). Same falsy parse as `PIPELINE_UI_ENABLED`:
 *  `0`/`false`/`no`/`off` (case-insensitive, trimmed) disable it;
 *  unset/empty/any other value leaves it ON — so DEFAULT BEHAVIOUR IS
 *  UNCHANGED. Reads from an injected env map so the daemon can snapshot it
 *  once at boot and tests can vary it per case. */
export function pipelineUiTranscriptsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = (env.PIPELINE_UI_TRANSCRIPTS ?? "").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

export interface PipelineInfo {
  pipeline_name: string;
  pipeline_root: string;
  manifest_excerpt: string | null;
  end_state: string | null;
  iterations: string[];
  /** rel (as it appears in `iterations` / `shared_iterations`) → the step
   *  file's frontmatter `model:` value, verbatim (shorthand or canonical id).
   *  Only steps that declare one are present. Lets the UI show the CONFIGURED
   *  model for steps that haven't run yet — the observed per-run model comes
   *  from events and wins when both exist. */
  step_models: Record<string, string>;
  /** rel → the step file's frontmatter `effort:` value (low|medium|high|
   *  xhigh|max) — the `step_models` companion, same key contract. */
  step_efforts: Record<string, string>;
  /** rel → the step file's frontmatter `permission-mode:` value — same key
   *  contract as step_models/step_efforts. */
  step_permission_modes: Record<string, string>;
  /** For a family TARGET (a pipeline living at `<hub>/targets/<name>/`): the
   *  hub pipeline whose shared `steps/` the target's chain continues into.
   *  null for hubs and standalone pipelines. */
  family_hub: { pipeline_name: string; pipeline_root: string } | null;
  /** The family hub's steps (rel to the HUB's `steps/`) — the shared
   *  continuation a target run reaches off-plan via `Next:` chaining. Empty
   *  unless `family_hub` is set. */
  shared_iterations: string[];
}

export interface IterationSection {
  heading: string;
  body: string;
}

export interface ParsedIteration {
  title: string | null;
  sections: IterationSection[];
}

export interface MarkdownDoc {
  frontmatter: Record<string, string> | null;
  body: string;
}

/**
 * Parse an iteration markdown file into a title (first H1) + a list of
 * top-level sections keyed by their H2 heading.
 */
export function parseIterationSections(raw: string): ParsedIteration {
  const lines = raw.split(/\r?\n/);
  let title: string | null = null;
  const sections: IterationSection[] = [];
  let current: IterationSection | null = null;
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    if (h1 && !title) {
      title = h1[1].trim();
      continue;
    }
    if (h2) {
      if (current) sections.push({ ...current, body: current.body.trim() });
      current = { heading: h2[1].trim(), body: "" };
      continue;
    }
    if (current) current.body += line + "\n";
  }
  if (current) sections.push({ ...current, body: current.body.trim() });
  return { title, sections };
}

/**
 * Parse YAML-ish frontmatter from a markdown file. Recognizes only a
 * `---`-delimited block at the top with `key: value` lines; nothing fancier.
 * Tolerates leading whitespace/BOM before the opener. If the opener has no
 * matching closer within 50 lines, the whole input is treated as body.
 */
export function parseFrontmatter(raw: string): MarkdownDoc {
  const stripped = raw.replace(/^[\s﻿]+/, "");
  if (!stripped.startsWith("---")) return { frontmatter: null, body: raw };
  const lines = stripped.split(/\r?\n/);
  if (lines[0].trim() !== "---") return { frontmatter: null, body: raw };
  const limit = Math.min(lines.length, 51);
  let closeIdx = -1;
  for (let i = 1; i < limit; i++) if (lines[i].trim() === "---") { closeIdx = i; break; }
  if (closeIdx === -1) return { frontmatter: null, body: raw };
  const fm: Record<string, string> = {};
  for (let i = 1; i < closeIdx; i++) {
    const m = lines[i].match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return { frontmatter: fm, body: lines.slice(closeIdx + 1).join("\n") };
}

/**
 * Friendly shorthand → exact Anthropic model id. Step/pipeline frontmatter
 * uses the shorthand so docs stay readable as model versions roll forward.
 * The accepted vocabulary is these aliases PLUS any exact canonical id
 * (a string starting with `claude-`), which passes through unchanged.
 */
export const MODEL_SHORTHAND_TO_ID = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-8",
  fable: "claude-fable-5",
} as const;

export type ModelShorthand = keyof typeof MODEL_SHORTHAND_TO_ID;

/** True when `s` is one of the friendly aliases (case-insensitive caller). */
export function isModelShorthand(s: string): s is ModelShorthand {
  return s in MODEL_SHORTHAND_TO_ID;
}

/** True when `s` is an exact canonical Anthropic model id — any string that
 *  starts with `claude-`. Canonical ids are accepted verbatim everywhere a
 *  shorthand is, and pass through resolution unchanged. */
export function isCanonicalModelId(s: string): boolean {
  return s.startsWith("claude-");
}

/**
 * Reverse lookup: canonical Anthropic model id → shorthand. Built once at
 * module load from MODEL_SHORTHAND_TO_ID so the two stay in sync.
 */
export const MODEL_ID_TO_SHORTHAND: Record<string, ModelShorthand> = Object.fromEntries(
  Object.entries(MODEL_SHORTHAND_TO_ID).map(([k, v]) => [v, k as ModelShorthand]),
);

/**
 * Accept either a shorthand (case-insensitive: `haiku|sonnet|opus|fable`) or
 * a canonical Anthropic model id (a `claude-*` string, passed through
 * unchanged) and return the canonical id. `inherit` (case-insensitive) and
 * empty / whitespace-only input → null ("fall through to the session
 * default"). Any other unknown input passes through verbatim — the SDK /
 * Anthropic API will reject with a clearer error than a silent downgrade.
 */
export function canonicalModelId(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (lower === "inherit") return null;
  if (lower in MODEL_SHORTHAND_TO_ID) return MODEL_SHORTHAND_TO_ID[lower as ModelShorthand];
  if (t in MODEL_ID_TO_SHORTHAND) return t;
  return t;
}

/**
 * Best-effort reverse: derive the shorthand from either a shorthand or a
 * canonical id. Returns null for `inherit`, canonical ids with no shorthand
 * mapping, and unknown / empty inputs. (A canonical id that DOES map back to
 * a known tier — e.g. `claude-opus-4-8` → `opus` — yields that shorthand.)
 */
export function shorthandFromAny(input: string | null | undefined): ModelShorthand | null {
  if (!input) return null;
  const t = input.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (lower === "inherit") return null;
  if (lower in MODEL_SHORTHAND_TO_ID) return lower as ModelShorthand;
  if (t in MODEL_ID_TO_SHORTHAND) return MODEL_ID_TO_SHORTHAND[t];
  return null;
}

/**
 * Pick the effective model value for a step: step frontmatter wins over
 * pipeline frontmatter. Returns null when neither side specifies, when the
 * value is `inherit`, or when a present value is unrecognized (caller falls
 * back to the session default). Warns once on an invalid non-empty value so
 * bad values surface in the daemon log instead of silently downgrading.
 *
 * Accepted vocabulary (END-TO-END per the per-step-model design):
 *   - the friendly aliases `haiku|sonnet|opus|fable` (case-insensitive),
 *     returned lowercased;
 *   - any exact canonical Anthropic id (`claude-*`), returned VERBATIM
 *     (case preserved) so a valid id is never coerced to null;
 *   - `inherit` / absent → null (session default).
 *
 * Return type is `string | null` rather than `ModelShorthand | null`: an
 * accepted value may be a canonical id, which is not one of the aliases.
 * Callers map it to a canonical id with `canonicalModelId` and to a display
 * shorthand (when one exists) with `shorthandFromAny`.
 */
export function resolveStepModel(
  stepFrontmatter: { model?: string } | Record<string, string> | null | undefined,
  pipelineFrontmatter: { model?: string } | Record<string, string> | null | undefined,
): string | null {
  const pick = (fm: { model?: string } | Record<string, string> | null | undefined): string | null => {
    if (!fm) return null;
    const v = (fm as Record<string, string>).model;
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length === 0 ? null : t;
  };
  // Validate each level independently so an invalid step (`model: hai`)
  // falls through to a VALID pipeline default instead of shadowing it.
  // Without this, the documented `step ?? pipeline ?? session` contract
  // collapses to `session` on any typo, silently upgrading model cost.
  const validate = (raw: string | null, level: "step" | "pipeline"): string | null => {
    if (raw === null) return null;
    const norm = raw.toLowerCase();
    if (norm === "inherit") return null; // explicit "use the session default"
    if (isModelShorthand(norm)) return norm; // alias → lowercased alias
    if (isCanonicalModelId(raw)) return raw; // canonical id → pass through verbatim
    console.warn(`resolveStepModel: ignoring unknown ${level} model "${raw}"`);
    return null;
  };
  return validate(pick(stepFrontmatter), "step") ?? validate(pick(pipelineFrontmatter), "pipeline");
}

/**
 * Walk up from `start` to find the main repo's working tree, accounting for
 * git worktrees. Mirrors hooks/pipeline_ui_relay.ts and analytics_relay.ts;
 * keep these in sync per CLAUDE.md.
 */
export function resolveProjectRootFromCwd(start: string): {
  project_root: string;
  worktree: string | null;
} {
  let cur = resolve(start);
  for (let i = 0; i < 64; i++) {
    const git = join(cur, ".git");
    if (existsSync(git)) {
      const s = statSync(git);
      if (s.isDirectory()) return { project_root: cur, worktree: null };
      if (s.isFile()) {
        try {
          const content = readFileSync(git, "utf-8").trim();
          if (content.startsWith("gitdir:")) {
            const gitdir = resolve(cur, content.slice(7).trim());
            const commondirFile = join(gitdir, "commondir");
            if (existsSync(commondirFile)) {
              const commondir = readFileSync(commondirFile, "utf-8").trim();
              const common = resolve(gitdir, commondir);
              const mainRoot = common.endsWith(".git") ? dirname(common) : common;
              return { project_root: mainRoot, worktree: cur };
            }
          }
        } catch {
          /* ignore unreadable .git */
        }
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { project_root: resolve(start), worktree: null };
}

/**
 * Normalize a path for cross-process comparison. Windows paths are
 * case-insensitive, so fold case there; POSIX is exact. Used by both the
 * daemon (server.ts) and the version-reconciliation logic to decide whether
 * two plugin roots are "the same". MUST match hooks/pipeline_ui_relay.ts's
 * identically-named helper — divergent normalization would make the daemon and
 * the hook disagree about a handoff target.
 */
export function normalizePathForCompare(p: string): string {
  const n = resolve(p).replaceAll("\\", "/");
  return process.platform === "win32" ? n.toLowerCase() : n;
}

export interface InstalledPluginPick {
  installPath: string;
  version: string;
  updatedMs: number;
}

/**
 * Compare two dotted version strings numerically (segment by segment).
 * Non-numeric / missing segments count as 0. Returns >0 if a is newer.
 * Used only as a deterministic tie-breaker when two install entries share an
 * identical lastUpdated (e.g. one install operation stamped several sibling
 * project-entries at the same millisecond) — without it, the winner would
 * depend on JSON iteration order and an older own-version could shadow a newer
 * co-timestamped sibling.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = parseInt(pa[i] ?? "0", 10);
    const y = parseInt(pb[i] ?? "0", 10);
    const xv = Number.isFinite(x) ? x : 0;
    const yv = Number.isFinite(y) ? y : 0;
    if (xv !== yv) return xv - yv;
  }
  return 0;
}

/**
 * Given the text of ~/.claude/plugins/installed_plugins.json and the parent
 * directory of the running daemon's plugin root, return the installed entry
 * for THIS plugin with the newest `lastUpdated`.
 *
 * "This plugin" = any entry whose `installPath` is a sibling of the daemon's
 * plugin root (same parent dir, e.g. `.../<marketplace>/<plugin>/<version>`).
 * Matching by shared parent identifies sibling versions of the same plugin
 * without the daemon needing to know its marketplace name, and naturally
 * excludes OTHER plugins (which live under a different parent).
 *
 * This is the source of truth for Phase 2 version reconciliation: Claude Code
 * rewrites installed_plugins.json on every install/upgrade/downgrade, stamping
 * a fresh `lastUpdated`. Picking the newest-updated sibling means "follow the
 * most recent install action" — NOT highest-semver — so a deliberate downgrade
 * is honored, consistent with the daemon-tracks-installed-version invariant.
 *
 * Returns null when the JSON is unparseable or no sibling entry matches.
 */
export function pickNewestPluginSibling(
  jsonText: string,
  pluginRootParent: string,
): InstalledPluginPick | null {
  let doc: unknown;
  try {
    doc = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const parentNorm = normalizePathForCompare(pluginRootParent);
  // installed_plugins.json shape is { ...: { "<name>@<marketplace>": Entry[] } }
  // but stay permissive: collect every array we encounter and filter entries
  // by shape, so a schema tweak doesn't silently break detection.
  const buckets: unknown[][] = [];
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) buckets.push(v);
    else if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) collect(x);
    }
  };
  collect(doc);
  let best: InstalledPluginPick | null = null;
  for (const bucket of buckets) {
    for (const e of bucket) {
      if (!e || typeof e !== "object") continue;
      const installPath = (e as Record<string, unknown>).installPath;
      if (typeof installPath !== "string") continue;
      if (normalizePathForCompare(dirname(installPath)) !== parentNorm) continue;
      const luRaw = (e as Record<string, unknown>).lastUpdated;
      const parsed = typeof luRaw === "string" ? Date.parse(luRaw) : NaN;
      const updatedMs = Number.isFinite(parsed) ? parsed : 0;
      const vRaw = (e as Record<string, unknown>).version;
      const version = typeof vRaw === "string" ? vRaw : "0.0.0";
      // Newest lastUpdated wins; on an exact tie prefer the higher version so
      // the result is deterministic regardless of JSON ordering.
      if (
        !best ||
        updatedMs > best.updatedMs ||
        (updatedMs === best.updatedMs && compareVersions(version, best.version) > 0)
      ) {
        best = { installPath: resolve(installPath), version, updatedMs };
      }
    }
  }
  return best;
}

export interface PendingUpdate {
  plugin_root: string;
  version: string;
  updated_ms: number;
}

/**
 * Decide whether a PENDING plugin update exists for a running daemon: the
 * most-recently-installed sibling (per pickNewestPluginSibling) that is NOT
 * the root the daemon is running from and whose install dir passes
 * `looksComplete` (mid-extraction installs are not offered).
 *
 * This is deliberately baseline-free, unlike reconcileToNewestInstalled: the
 * auto-reconcile only reacts to installs that happen AFTER daemon boot and
 * leaves an at-boot version gap to the next SessionStart hook. This function
 * reports that gap so the UI can offer an explicit "Update & Restart".
 */
export function resolvePendingUpdate(
  installedJsonText: string,
  pluginRoot: string,
  looksComplete: (installRoot: string) => boolean,
): PendingUpdate | null {
  const newest = pickNewestPluginSibling(installedJsonText, dirname(pluginRoot));
  if (!newest) return null;
  if (normalizePathForCompare(newest.installPath) === normalizePathForCompare(pluginRoot)) {
    return null;
  }
  if (!looksComplete(newest.installPath)) return null;
  return {
    plugin_root: newest.installPath,
    version: newest.version,
    updated_ms: newest.updatedMs,
  };
}

function walkSteps(base: string, dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    const rel = full.slice(base.length + 1).replaceAll("\\", "/");
    if (e.isDirectory()) {
      walkSteps(base, full, out);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(rel);
    }
  }
}

/** Frontmatter `model:` + `effort:` + `permission-mode:` per step file, keyed
 *  by rel. Steps without a value are omitted so the JSON payload stays
 *  proportional to what's configured. One read per step file covers all maps. */
function stepMetaFor(
  pipelineRoot: string,
  rels: string[],
): {
  models: Record<string, string>;
  efforts: Record<string, string>;
  permissionModes: Record<string, string>;
} {
  const models: Record<string, string> = {};
  const efforts: Record<string, string> = {};
  const permissionModes: Record<string, string> = {};
  for (const rel of rels) {
    try {
      const raw = readFileSync(join(pipelineRoot, "steps", rel), "utf-8");
      const fm = parseFrontmatter(raw).frontmatter;
      const model = fm?.model?.trim();
      if (model) models[rel] = model;
      const effort = fm?.effort?.trim();
      if (effort) efforts[rel] = effort;
      const pm = fm?.["permission-mode"]?.trim();
      if (pm) permissionModes[rel] = pm;
    } catch {
      /* unreadable step — skip */
    }
  }
  return { models, efforts, permissionModes };
}

export function pipelineInfoFromDir(root: string, precomputedHub?: PipelineInfo): PipelineInfo {
  const manifest = join(root, "PIPELINE.md");
  let manifestText: string | null = null;
  let endState: string | null = null;
  try {
    manifestText = readFileSync(manifest, "utf-8");
    const m = manifestText.match(/##\s*End State\s*\n+([\s\S]*?)(?:\n##|\n$|$)/i);
    if (m) endState = m[1].trim().split("\n")[0]?.trim() ?? null;
  } catch {
    /* missing manifest is allowed */
  }
  const stepsDir = join(root, "steps");
  const iterations: string[] = [];
  if (existsSync(stepsDir)) {
    walkSteps(stepsDir, stepsDir, iterations);
    iterations.sort();
  }

  // Family TARGET detection: a pipeline living at `<hub>/targets/<name>/`
  // (hub has its own PIPELINE.md) chains into the hub's shared steps/ via
  // `Next:` links — surface those as shared_iterations so the UI can render
  // the run's full expected chain, not just the target-local entry steps.
  // scanPipelines passes the hub's already-built PipelineInfo so a hub's
  // steps are walked + frontmatter-read ONCE per scan, not once per target.
  let familyHub: PipelineInfo["family_hub"] = null;
  let sharedIterations: string[] = [];
  let hubMeta: ReturnType<typeof stepMetaFor> | null = null;
  const parent = dirname(root);
  if (basename(parent) === "targets") {
    const hubRoot = dirname(parent);
    if (precomputedHub && normalizePathForCompare(precomputedHub.pipeline_root) === normalizePathForCompare(hubRoot)) {
      familyHub = { pipeline_name: precomputedHub.pipeline_name, pipeline_root: precomputedHub.pipeline_root };
      sharedIterations = precomputedHub.iterations;
      hubMeta = {
        models: precomputedHub.step_models,
        efforts: precomputedHub.step_efforts,
        permissionModes: precomputedHub.step_permission_modes,
      };
    } else if (existsSync(join(hubRoot, "PIPELINE.md"))) {
      familyHub = { pipeline_name: basename(hubRoot), pipeline_root: hubRoot };
      const hubSteps = join(hubRoot, "steps");
      if (existsSync(hubSteps)) {
        walkSteps(hubSteps, hubSteps, sharedIterations);
        sharedIterations.sort();
      }
      hubMeta = stepMetaFor(hubRoot, sharedIterations);
    }
  }

  // Own keys win on a rel collision (assign hub's first, own second).
  const ownMeta = stepMetaFor(root, iterations);
  return {
    pipeline_name: basename(root),
    pipeline_root: root,
    manifest_excerpt: manifestText?.slice(0, 600) ?? null,
    end_state: endState,
    iterations,
    step_models: { ...(hubMeta?.models ?? {}), ...ownMeta.models },
    step_efforts: { ...(hubMeta?.efforts ?? {}), ...ownMeta.efforts },
    step_permission_modes: { ...(hubMeta?.permissionModes ?? {}), ...ownMeta.permissionModes },
    family_hub: familyHub,
    shared_iterations: sharedIterations,
  };
}

/**
 * Walk `<projectRoot>/.claude/pipeline/` recursively. A directory is a
 * pipeline if it contains PIPELINE.md; otherwise it's a category folder.
 */
export function scanPipelines(projectRoot: string): PipelineInfo[] {
  const pipelineDir = join(projectRoot, ".claude", "pipeline");
  if (!existsSync(pipelineDir)) return [];
  const out: PipelineInfo[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasManifest = existsSync(join(dir, "PIPELINE.md"));
    if (hasManifest) {
      const hub = pipelineInfoFromDir(dir);
      out.push(hub);
      // A family HUB can hold target sub-pipelines under targets/<name>/ —
      // each is a complete pipeline in its own right (same contract as the
      // launcher catalog's listPipelineRoots). One level only; dot-dirs
      // (e.g. targets/.common/) hold family-shared docs, not pipelines.
      // The hub's own PipelineInfo is passed down so its steps/ walk +
      // frontmatter reads happen once per scan, not once per target.
      const targetsDir = join(dir, "targets");
      let targetEntries;
      try {
        targetEntries = readdirSync(targetsDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const t of targetEntries) {
        if (!t.isDirectory() || t.name.startsWith(".")) continue;
        const targetRoot = join(targetsDir, t.name);
        if (existsSync(join(targetRoot, "PIPELINE.md"))) {
          out.push(pipelineInfoFromDir(targetRoot, hub));
        }
      }
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      visit(join(dir, e.name), depth + 1);
    }
  };
  visit(pipelineDir, 0);
  out.sort((a, b) => a.pipeline_name.localeCompare(b.pipeline_name));
  return out;
}

// --------------------------------------------------------------------
// Run summaries — fold the full events.jsonl into one row per run_id.
// Decoupled from the daemon's live-event broadcast so the UI can show
// long-term history without bloating the SSE event window.
// --------------------------------------------------------------------

export type RunSummaryStatus =
  | "running"
  | "improving"
  | "scripting"
  | "polling-blocker"
  | "completed"
  | "halted"
  | "unknown";

export interface RunSummary {
  run_id: string;
  parent_run_id: string | null;
  pipeline_name: string | null;
  current_iteration_path: string | null;
  current_iteration_index: number | null;
  iteration_count_completed: number;
  status: RunSummaryStatus;
  started_at: string;
  last_event_at: string;
  halt_reason: string | null;
  blocker_issue_url: string | null;
  worktree: string | null;
  /** DISPLAY state layered over `running` (design 05) — mirror of RunState's
   *  field in web/src/types.ts. Set by `run.awaiting_input`, cleared by ANY
   *  later event for the run. Kept OUT of RunSummaryStatus on purpose: it must
   *  never interact with terminal logic (sweeps, dismissal, completion). */
  awaiting_input: boolean;
  awaiting_input_kind: "permission" | "input" | null;
}

export interface JournalEvent {
  schema?: number;
  ts: string;
  type: string;
  run_id?: string | null;
  parent_run_id?: string | null;
  worktree?: string | null;
  data?: Record<string, unknown>;
}

/** Parse an ISO timestamp to epoch ms, or null when absent/unparseable. */
export function toEpochOrNull(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** FIFO-cap a Map (insertion order = age) — the shared eviction idiom for the
 *  daemon's bounded caches. */
export function capMap(map: Map<string, unknown>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

/** Evict the oldest TERMINAL entries of a bounded registry Map, keeping at
 *  most `max` of them (live entries are never evicted). Shared by the drive-run
 *  and AI-fix job registries. */
export function evictOldestTerminal<T>(
  map: Map<string, T>,
  isTerminal: (t: T) => boolean,
  endedAt: (t: T) => string,
  keyOf: (t: T) => string,
  max: number,
): void {
  const terminal = [...map.values()].filter(isTerminal).sort((a, b) => endedAt(a).localeCompare(endedAt(b)));
  while (terminal.length > max) {
    const oldest = terminal.shift()!;
    map.delete(keyOf(oldest));
  }
}

function pipelineNameFromPath(p: string | null | undefined): string | null {
  if (!p) return null;
  const norm = p.replaceAll("\\", "/");
  const m = norm.match(/\/([^/]+)\/steps\//);
  return m ? m[1] : null;
}

/**
 * Fold every event in a journal-line array into one summary per run_id.
 * Same fold semantics as the client's buildRunForest, kept on the server
 * so the API can return finalized history without forcing the client to
 * stream every event to derive it.
 *
 * iteration_count_completed counts ONLY outcome:"completed" iterations and
 * dedups by iteration_path so a halted→resumed-completed sequence still
 * counts as one completion, not two.
 */
/**
 * Stateful fold of journal events into per-run summaries. Use this when you
 * want to feed events incrementally (one shard at a time, or one line at a
 * time) so memory stays bounded by the active-run count, not the journal
 * size. Call addEvent for each event in chronological order, then
 * toSummaries() to materialize the public shape (newest-first).
 */
export class RunSummaryFolder {
  private map = new Map<string, MutableSummary>();

  addEvent(e: JournalEvent): void {
    const id = e.run_id ?? null;
    if (!id) return;
    let r = this.map.get(id);
    if (!r) {
      r = initSummary(id, e.ts);
      this.map.set(id, r);
    }
    r.last_event_at = e.ts;
    // Derived WAITING (design 05) — same rule as the client fold: the event
    // raises it, any later event for the run clears it.
    r.awaiting_input = e.type === "run.awaiting_input";
    if (!r.awaiting_input) r.awaiting_input_kind = null;
    if (e.parent_run_id && !r.parent_run_id) r.parent_run_id = e.parent_run_id;
    if (e.worktree && !r.worktree) r.worktree = e.worktree;
    const d = e.data ?? {};

    switch (e.type) {
      case "run.awaiting_input":
        // Display-only: status untouched, terminal logic untouched.
        r.awaiting_input_kind = d.kind === "permission" ? "permission" : "input";
        break;
      case "pipeline.started":
        r.pipeline_name = (d.pipeline_name as string) ?? r.pipeline_name;
        setSummaryStatus(r, "running");
        break;
      case "iteration.started":
      case "iteration.resumed":
        r.current_iteration_path = (d.iteration_path as string) ?? r.current_iteration_path;
        r.current_iteration_index =
          typeof d.index === "number" ? (d.index as number) : r.current_iteration_index;
        if (!r.pipeline_name) {
          r.pipeline_name = pipelineNameFromPath(r.current_iteration_path);
        }
        setSummaryStatus(r, "running");
        break;
      case "iteration.completed": {
        const path = (d.iteration_path as string | undefined) ?? null;
        if (d.outcome === "completed") {
          if (path && !r._completedPaths.has(path)) {
            r._completedPaths.add(path);
            r.iteration_count_completed += 1;
          } else if (!path) {
            r.iteration_count_completed += 1;
          }
        }
        if (d.outcome === "halted") {
          setSummaryStatus(r, "halted");
          r.halt_reason = (d.halt_reason as string) ?? r.halt_reason;
        } else if (d.outcome === "completed") {
          // Accept both null AND undefined for the "no next iteration"
          // signal so v1 producers that drop the field rather than null'ing
          // it still derive the terminal status.
          const nextIsAbsentOrNull = d.next_iteration_path == null;
          const terminal =
            d.terminal === true ||
            (nextIsAbsentOrNull && r.status === "running");
          if (terminal) {
            r._terminalReached = true;
            setSummaryStatus(r, "completed");
          }
        }
        break;
      }
      case "improver.started":
        setSummaryStatus(r, "improving");
        break;
      case "improver.completed":
        // If the chain controller is cut off here after a terminal
        // iteration, restore the terminal status so /api/runs doesn't
        // report the run stuck at 'improving' forever.
        if (r._terminalReached && r.status === "improving") {
          setSummaryStatus(r, "completed");
        }
        break;
      case "script_creator.started":
        setSummaryStatus(r, "scripting");
        break;
      case "script_creator.completed":
        if (r._terminalReached && r.status === "scripting") {
          setSummaryStatus(r, "completed");
        }
        break;
      case "blocker.delegated":
        setSummaryStatus(r, "polling-blocker");
        r.blocker_issue_url = (d.blocker_issue_url as string) ?? r.blocker_issue_url;
        break;
      case "blocker.polling":
        setSummaryStatus(r, "polling-blocker");
        break;
      case "blocker.resolved":
        setSummaryStatus(r, "running");
        break;
      case "pipeline.completed":
        setSummaryStatus(r, "completed");
        break;
      case "pipeline.halted":
        // Set _dismissed BEFORE writing status so the gate doesn't apply
        // to this case — dismiss is the halt event itself. After this,
        // setSummaryStatus is a no-op for this run.
        if (d.dismissed === true) {
          r._dismissed = true;
        }
        r.status = "halted";
        r.halt_reason = (d.halt_reason as string) ?? r.halt_reason;
        break;
    }
  }

  toSummaries(): RunSummary[] {
    const out: RunSummary[] = [...this.map.values()].map((m) => {
      const {
        _completedPaths: _drop1,
        _terminalReached: _drop2,
        _dismissed: _drop3,
        ...rest
      } = m;
      void _drop1;
      void _drop2;
      void _drop3;
      return rest;
    });
    out.sort((a, b) => (a.last_event_at < b.last_event_at ? 1 : -1));
    return out;
  }
}

interface MutableSummary extends RunSummary {
  _completedPaths: Set<string>;
  _terminalReached: boolean;
  /** Mirror of MutableRun._dismissed in web/src/lib/runs.ts. Once set, the
   *  fold treats `r.status` as sticky at "halted" — see setSummaryStatus
   *  for the gate. Set when `pipeline.halted.data.dismissed === true`. */
  _dismissed: boolean;
}

function initSummary(id: string, ts: string): MutableSummary {
  return {
    run_id: id,
    parent_run_id: null,
    pipeline_name: null,
    current_iteration_path: null,
    current_iteration_index: null,
    iteration_count_completed: 0,
    status: "unknown",
    started_at: ts,
    last_event_at: ts,
    halt_reason: null,
    blocker_issue_url: null,
    worktree: null,
    awaiting_input: false,
    awaiting_input_kind: null,
    _completedPaths: new Set<string>(),
    _terminalReached: false,
    _dismissed: false,
  };
}

/** Server-side mirror of setStatus in web/src/lib/runs.ts. Once a run is
 *  dismissed, subsequent events keep folding (stats, current iteration
 *  tracking) but status is frozen — otherwise a still-running pipeline's
 *  later iteration.started would flip status back to "running" and
 *  contradict the dismissed halt_reason. The /api/runs response and the
 *  client both depend on this — they share the fold contract. */
function setSummaryStatus(r: MutableSummary, s: RunSummaryStatus): void {
  if (r._dismissed) return;
  r.status = s;
}

export function summarizeRuns(events: JournalEvent[]): RunSummary[] {
  const folder = new RunSummaryFolder();
  for (const e of events) folder.addEvent(e);
  return folder.toSummaries();
}

/**
 * Fold a journal's full history into RunSummary[] WITHOUT holding the
 * full event array in memory. Walks shards (rotated archives + current)
 * one at a time, line by line; only the active-run state and the folder's
 * Map<run_id, summary> are resident. Use this for /api/runs against
 * long-lived projects where readJournalWithArchives would allocate
 * hundreds of MB.
 */
export function summarizeRunsFromShards(shardPaths: string[]): RunSummary[] {
  const folder = new RunSummaryFolder();
  for (const path of shardPaths) {
    streamJournalLines(path, (ev) => folder.addEvent(ev));
  }
  return folder.toSummaries();
}

/**
 * Walk a journal file line by line, parsing each non-empty line as a
 * JournalEvent and invoking `onEvent`. Tolerates malformed lines (skipped).
 * Used by summarizeRunsFromShards so /api/runs doesn't materialize the
 * full event array — only the fold state is resident.
 *
 * Implementation: a single readFileSync still happens per shard, which
 * caps memory at one shard's size (50 MB at the rotation threshold). True
 * line streaming via Bun.file().stream() is a follow-up — this is already
 * a big win over readJournalWithArchives which held EVERY shard in memory
 * simultaneously.
 */
export function streamJournalLines(
  path: string,
  onEvent: (ev: JournalEvent) => void,
): void {
  if (!existsSync(path)) return;
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      onEvent(JSON.parse(t) as JournalEvent);
    } catch {
      /* skip malformed */
    }
  }
}

/**
 * Eager variant of streamJournalLines that returns all events as an array.
 * Used by callers that need the full array (e.g. /api/state's 200-event
 * window); avoid for unbounded folds — prefer streamJournalLines + a
 * RunSummaryFolder.
 */
export function readJournalLines(path: string): JournalEvent[] {
  if (!existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: JournalEvent[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as JournalEvent);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/**
 * List rotated archive files plus the current file for a journal-style
 * .jsonl that writers rotate via rename (e.g. `events.jsonl` →
 * `events-<stamp>.jsonl`). Returns paths sorted oldest-first so the caller
 * can fold them in chronological order. The current file is last.
 *
 * `current` is the canonical path (e.g. ".../events.jsonl"). Archives are
 * files in the same directory whose basename matches `<stem>-*.jsonl` where
 * `<stem>` is the current file's stem (e.g. `events`).
 */
export function listJournalShards(current: string): string[] {
  const idx = current.lastIndexOf("/") === -1 && current.lastIndexOf("\\") === -1
    ? -1
    : Math.max(current.lastIndexOf("/"), current.lastIndexOf("\\"));
  const dir = idx >= 0 ? current.slice(0, idx) : ".";
  const base = idx >= 0 ? current.slice(idx + 1) : current;
  const stem = base.replace(/\.jsonl$/, "");
  if (!existsSync(dir)) return existsSync(current) ? [current] : [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return existsSync(current) ? [current] : [];
  }
  const archives: string[] = [];
  const rotatedRe = new RegExp(`^${stem}-[^/\\\\]+\\.jsonl$`);
  for (const name of entries) {
    if (rotatedRe.test(name)) archives.push(join(dir, name));
  }
  // Sort archives lexicographically — works because all our rotation stamps
  // are ISO-derived prefixes (chronological-lex equivalence). Append the
  // current file last so its newer rows fold over older ones.
  archives.sort();
  if (existsSync(current)) archives.push(current);
  return archives;
}

/**
 * Read every shard for a journal (rotated archives + current) as a flat
 * chronologically-ordered JournalEvent[]. Best-effort: malformed files
 * are skipped, malformed lines inside a file are skipped.
 */
export function readJournalWithArchives(current: string): JournalEvent[] {
  const out: JournalEvent[] = [];
  for (const path of listJournalShards(current)) {
    for (const ev of readJournalLines(path)) out.push(ev);
  }
  return out;
}

// --------------------------------------------------------------------
// Per-iteration analytics fold (schema v4 — step_id-keyed, overlap-safe).
//
// Attributes ambient telemetry (`tool.called`, `turn.usage`) to the
// individual iteration ("step") that produced it, per run. There are two
// modes, chosen automatically per event:
//
//   * step_id PRESENT (v4 / DAG-parallel): a step's window is the half-open
//     interval [iteration.started, iteration.completed) keyed by its
//     `step_id`. Steps may OVERLAP (a parallel ready-set spawns several at
//     once). An ambient event is attributed to the MOST-RECENTLY-STARTED
//     step that is still open (LIFO over the open set). Because windows are
//     closed by their own step's `iteration.completed` — not by the NEXT
//     step's `iteration.started` — a long-running parallel step's later
//     tools/tokens are no longer mis-windowed onto a sibling. When windows
//     don't actually overlap (sequential), this is identical to the
//     consecutive-window heuristic.
//
//   * step_id ABSENT (v1/v2/v3 / sequential): the legacy
//     consecutive-`iteration.started`-window behavior — an ambient event
//     belongs to the iteration whose `iteration.started` most recently
//     preceded it (the window runs until the NEXT `iteration.started`).
//
// The two modes are mixed-safe within one run: an event is attributed by
// whichever window is currently active under the rules above. The fold is
// per-run (events are grouped by `run_id`); ambient events with no run_id
// are ignored, matching the run-forest fold.
// --------------------------------------------------------------------

/** The subagent-spawning tool names. Single source of truth so the transcript
 *  fold's agents_spawned count and the MirrorService's subagent-chasing can't
 *  drift when Claude Code renames/adds a spawn tool. */
export const SPAWN_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task", "TaskCreate"]);
export function isAgentSpawnTool(name: unknown): boolean {
  return typeof name === "string" && SPAWN_TOOLS.has(name);
}

/** The 7 tool/token counters every analytics shape carries. Single source of
 *  truth for the field set — `IterationToolStats` (event fold, per step) and
 *  `transcript-stats.ts`'s `TranscriptRunStats` (transcript fold, per run) both
 *  build on this so a new metric is added in ONE place. */
export interface ToolTokenCounters {
  tools_called: number;
  tools_failed: number;
  agents_spawned: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  /** Total API cost in USD when a source knows it (headless drive runs fold it
   *  from the claude -p envelopes into .runtime/<run>/usage.json); absent for
   *  transcript folds, which have no per-call pricing. */
  cost_usd?: number;
}

export function emptyToolTokenCounters(): ToolTokenCounters {
  return {
    tools_called: 0,
    tools_failed: 0,
    agents_spawned: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };
}

export interface IterationToolStats extends ToolTokenCounters {
  /** The step_id when the iteration declared one (v4), else the iteration
   *  file's rel path under steps/ (or its raw iteration_path as a last
   *  resort) so the row still has a stable identity. */
  step_id: string;
  iteration_path: string | null;
}

function emptyIterToolStats(step_id: string, iteration_path: string | null): IterationToolStats {
  return { step_id, iteration_path, ...emptyToolTokenCounters() };
}

interface OpenStepWindow {
  /** Stable bucket key: the step_id (v4) or, for legacy events, a synthetic
   *  key derived from the iteration_path + a per-run sequence so repeated
   *  runs of the same sequential path get distinct windows only when needed.
   *  For the legacy path we key by iteration_path so a re-entered iteration
   *  re-opens the SAME bucket (matching the old single-active-window model). */
  key: string;
  stats: IterationToolStats;
  /** True once this step's own iteration.completed closed it. Only relevant
   *  in step_id mode — legacy mode closes the prior window when the next
   *  iteration.started arrives. */
  closed: boolean;
}

/**
 * Fold a run's events into per-iteration tool/token stats, keyed by step.
 *
 * `events` should be all events for a SINGLE run_id (the caller groups by
 * run_id; passing a mixed array still works because each event's window is
 * resolved within the order it appears, but stats from different runs would
 * share open windows — don't do that). Returns one IterationToolStats per
 * step that opened, in first-seen order.
 */
export function iterationToolStatsForRun(events: JournalEvent[]): IterationToolStats[] {
  // Insertion-ordered map of bucket-key → stats.
  const buckets = new Map<string, IterationToolStats>();
  // Stack of currently-open windows. In step_id mode several may be open at
  // once (parallel). In legacy mode at most one is open (the current one);
  // a new iteration.started closes the prior.
  const open: OpenStepWindow[] = [];

  const stepIdOf = (d: Record<string, unknown>): string | null => {
    const v = d.step_id;
    return typeof v === "string" && v.length > 0 ? v : null;
  };

  for (const e of events) {
    const d = e.data ?? {};
    switch (e.type) {
      case "iteration.started":
      case "iteration.resumed": {
        const sid = stepIdOf(d);
        const ipath = (d.iteration_path as string | undefined) ?? null;
        if (sid !== null) {
          // step_id mode: open (or re-open) THIS step's window. Don't touch
          // sibling windows — parallel steps stay open concurrently.
          let stats = buckets.get(sid);
          if (!stats) {
            stats = emptyIterToolStats(sid, ipath);
            buckets.set(sid, stats);
          } else if (!stats.iteration_path && ipath) {
            stats.iteration_path = ipath;
          }
          // A resume re-opens the window if it had closed; a fresh start of
          // an already-open step is a no-op for openness (still open).
          const existing = open.find((w) => w.key === sid);
          if (existing) {
            existing.closed = false;
          } else {
            open.push({ key: sid, stats, closed: false });
          }
        } else {
          // Legacy consecutive-window mode: the new iteration.started closes
          // the previously-active legacy window (steps never overlap here).
          // Close every still-open LEGACY window (there is normally one).
          for (let i = open.length - 1; i >= 0; i--) {
            if (open[i].key.startsWith(" legacy:")) open.splice(i, 1);
          }
          const key = ` legacy:${ipath ?? "?"}`;
          let stats = buckets.get(key);
          if (!stats) {
            stats = emptyIterToolStats(ipath ?? "(unknown)", ipath);
            buckets.set(key, stats);
          }
          // iteration.resumed must NOT reopen a window whose .started scrolled
          // out — but here we have the bucket, so just (re)activate it.
          open.push({ key, stats, closed: false });
        }
        break;
      }
      case "iteration.completed": {
        const sid = stepIdOf(d);
        if (sid !== null) {
          // Close THIS step's window only.
          const idx = open.findIndex((w) => w.key === sid);
          if (idx >= 0) open.splice(idx, 1);
        }
        // In legacy mode, iteration.completed does NOT close the window —
        // the window stays active until the next iteration.started (matching
        // the historical consecutive-`iteration.started` heuristic, under
        // which post-completed tools still belonged to the just-run step).
        break;
      }
      case "tool.called": {
        const target = activeWindow(open);
        if (!target) break;
        target.stats.tools_called += 1;
        if (d.success === false) target.stats.tools_failed += 1;
        if (d.agent_spawn === true) target.stats.agents_spawned += 1;
        break;
      }
      case "turn.usage": {
        const target = activeWindow(open);
        if (!target) break;
        target.stats.input_tokens += Number(d.input_tokens ?? 0);
        target.stats.output_tokens += Number(d.output_tokens ?? 0);
        target.stats.cache_read_tokens += Number(d.cache_read_tokens ?? 0);
        target.stats.cache_creation_tokens += Number(d.cache_creation_tokens ?? 0);
        break;
      }
    }
  }

  return [...buckets.values()];
}

/** The window an ambient (tool.called / turn.usage) event is attributed to:
 *  the MOST-RECENTLY-OPENED still-open window (LIFO). With non-overlapping
 *  windows this is just "the current step"; with overlap it deterministically
 *  picks the newest active step. Returns null when nothing is open (ambient
 *  telemetry before the first iteration.started). */
function activeWindow(open: OpenStepWindow[]): OpenStepWindow | null {
  return open.length > 0 ? open[open.length - 1] : null;
}

/**
 * Group a project's full event stream by run_id and fold each run's
 * per-iteration tool stats. Returns a Map<run_id, IterationToolStats[]>.
 * Ambient events with no run_id are ignored. Events are assumed to arrive
 * in chronological order (the journal is append-only).
 */
export function iterationToolStatsByRun(
  events: JournalEvent[],
): Map<string, IterationToolStats[]> {
  const perRun = new Map<string, JournalEvent[]>();
  for (const e of events) {
    const id = e.run_id ?? null;
    if (!id) continue;
    let arr = perRun.get(id);
    if (!arr) {
      arr = [];
      perRun.set(id, arr);
    }
    arr.push(e);
  }
  const out = new Map<string, IterationToolStats[]>();
  for (const [id, evs] of perRun) {
    out.set(id, iterationToolStatsForRun(evs));
  }
  return out;
}

// --------------------------------------------------------------------
// Per-step wall-clock timings (backs /api/run-steps).
//
// One StepTiming per step of ONE run, folded from the run's own events.
// A step's ACTIVE time is the sum of its [iteration.started|resumed →
// iteration.completed] windows, so a step that parks on needs-input and
// later resumes doesn't count the parked hours as work. A window still
// open when the fold ends surfaces as `open_since` — the UI renders that
// step as live-ticking. Windows are keyed by step_id (DAG/v4) or by
// iteration_path (sequential/legacy); in legacy mode a new
// iteration.started closes the previous step's window (same convention
// as the tool-stats fold above). pipeline.completed/halted closes every
// open window — a crashed run's last step must not tick forever.
// --------------------------------------------------------------------

export interface StepTiming {
  /** DAG step_id when the events carry one (schema v4); else null. */
  step_id: string | null;
  iteration_path: string;
  /** Path after the LAST `/steps/` segment (the iteration tree's rel key),
   *  or null when the path doesn't contain a steps/ folder. */
  rel: string | null;
  /** Number of iteration.started events (a resume is NOT a new attempt). */
  attempts: number;
  first_started_at: string;
  /** Sum of closed active windows, ms. */
  duration_ms: number;
  /** ISO of the still-open window's start — the step is running right now
   *  (as far as the journal knows). Null when all windows are closed. */
  open_since: string | null;
  last_outcome: string | null;
}

function relFromIterationPath(p: string): string | null {
  const norm = p.replaceAll("\\", "/");
  const i = norm.lastIndexOf("/steps/");
  return i >= 0 ? norm.slice(i + "/steps/".length) : null;
}

/** Fold ONE run's events (chronological) into per-step timings, first-seen order.
 *  The open-window state lives in `open_since` itself (ISO of the current
 *  window's start; null when closed) — no shadow fields to keep in sync. */
export function stepTimingsForRun(events: JournalEvent[]): StepTiming[] {
  const slots = new Map<string, StepTiming>();
  // At most ONE legacy (no-step_id) window is ever open: each legacy start
  // closes the previous one, and completes close their own.
  let openLegacy: StepTiming | null = null;
  const close = (s: StepTiming, atIso: string): void => {
    const start = toEpochOrNull(s.open_since);
    if (start === null) return;
    const end = toEpochOrNull(atIso);
    if (end !== null && end > start) s.duration_ms += end - start;
    s.open_since = null;
    if (openLegacy === s) openLegacy = null;
  };

  for (const e of events) {
    const d = e.data ?? {};
    const ipath = typeof d.iteration_path === "string" ? d.iteration_path : null;
    const sid = typeof d.step_id === "string" && d.step_id.length > 0 ? d.step_id : null;

    if (e.type === "iteration.started" || e.type === "iteration.resumed") {
      if (!ipath && !sid) continue;
      const key = sid ?? `path:${ipath}`;
      let s = slots.get(key);
      if (!s) {
        // A resume whose original start scrolled out still deserves a slot —
        // better a truncated window than a phantom zero-duration row.
        s = {
          step_id: sid,
          iteration_path: ipath ?? "(unknown)",
          rel: ipath ? relFromIterationPath(ipath) : null,
          attempts: 0,
          first_started_at: e.ts,
          duration_ms: 0,
          open_since: null,
          last_outcome: null,
        };
        slots.set(key, s);
      }
      if (e.type === "iteration.started") s.attempts += 1;
      // Legacy/sequential: a new step starting closes the previous step's
      // window (matches the tool-stats fold's consecutive-window rule).
      if (sid === null) {
        if (openLegacy && openLegacy !== s) close(openLegacy, e.ts);
        openLegacy = s;
      }
      if (s.open_since === null && toEpochOrNull(e.ts) !== null) s.open_since = e.ts;
    } else if (e.type === "iteration.completed") {
      const key = sid ?? (ipath ? `path:${ipath}` : null);
      const s = key ? slots.get(key) : null;
      if (s) {
        close(s, e.ts);
        const outcome = typeof d.outcome === "string" ? d.outcome : null;
        if (outcome) s.last_outcome = outcome;
      }
    } else if (e.type === "pipeline.completed" || e.type === "pipeline.halted") {
      for (const s of slots.values()) close(s, e.ts);
    }
  }
  return [...slots.values()];
}
