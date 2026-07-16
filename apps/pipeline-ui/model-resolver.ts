/**
 * Pipeline UI — per-pipeline / per-step model resolution for /api/chat.
 *
 * Extracted from server.ts so tests can exercise the resolution path
 * without booting the daemon (server.ts is an entry-point script that
 * calls bootDaemon() at import time).
 *
 * Contract: step ?? pipeline ?? session, with an explicit caller
 * override winning over everything. Returns the canonical Anthropic
 * model id when known, or `undefined` to mean "fall through to the
 * SDK's session default".
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalModelId,
  parseFrontmatter,
  resolveStepModel,
  shorthandFromAny,
} from "./lib.ts";

/** Cached parse of one PIPELINE.md / iteration file's frontmatter. mtimeMs
 *  is the file's mtime at parse time; we invalidate when it changes. */
interface FrontmatterCacheEntry {
  mtimeMs: number;
  frontmatter: Record<string, string> | null;
}

/**
 * Normalize a filesystem path into a stable cache key. On Windows the
 * project_root used for invalidatePrefix arrives with backslashes
 * (path.resolve output), while step-file paths can arrive with forward
 * slashes (server.ts replaceAll-normalizes them). Without normalization
 * the two forms key the same file twice and prefix invalidation silently
 * misses half the entries.
 *
 * Lowercase the drive letter on Windows (drive letters are
 * case-insensitive on NTFS but startsWith is not) for the same reason.
 */
function normalizeKey(path: string): string {
  let p = path.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(p)) p = p[0].toLowerCase() + p.slice(1);
  return p;
}

/**
 * Read + parseFrontmatter a single file with an mtime-keyed cache. Missing
 * files cache as `null` so a re-check after the same mtime is still O(1).
 * Callers (server.ts) also invalidate explicitly on `file.changed`.
 *
 * All path inputs are normalized to a single canonical form (forward
 * slashes + lowercase drive letter on Windows) so callers can pass
 * either separator style without leaking duplicate entries.
 */
export class FrontmatterCache {
  private map = new Map<string, FrontmatterCacheEntry>();

  /** Drop a single path's cache entry — call from the file.changed watcher
   *  in server.ts when a PIPELINE.md or steps/*.md is rewritten. */
  invalidate(path: string): void {
    this.map.delete(normalizeKey(path));
  }

  /** Drop every entry whose key is `prefix` or sits under `prefix/`. Used
   *  when the pipeline-tree watcher fires for a project — cheaper than
   *  trying to derive which exact file changed. Requires a `/` boundary so
   *  invalidatePrefix("/proj/a") does NOT wipe "/proj/abc/..." entries. */
  invalidatePrefix(prefix: string): void {
    const norm = normalizeKey(prefix);
    const withSep = norm.endsWith("/") ? norm : norm + "/";
    for (const key of this.map.keys()) {
      if (key === norm || key.startsWith(withSep)) this.map.delete(key);
    }
  }

  /** Parse `path`'s frontmatter, using the cache when the file's mtime
   *  hasn't changed since the last read. Returns null for missing files
   *  (still cached, keyed by mtimeMs=-1 sentinel). */
  read(path: string): Record<string, string> | null {
    const key = normalizeKey(path);
    if (!existsSync(path)) {
      const hit = this.map.get(key);
      if (hit && hit.mtimeMs === -1) return hit.frontmatter;
      this.map.set(key, { mtimeMs: -1, frontmatter: null });
      return null;
    }
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return null;
    }
    const hit = this.map.get(key);
    if (hit && hit.mtimeMs === mtimeMs) return hit.frontmatter;
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      return null;
    }
    const fm = parseFrontmatter(raw).frontmatter;
    this.map.set(key, { mtimeMs, frontmatter: fm });
    return fm;
  }
}

/** Returned from resolveChatModel so callers can both pass the canonical id
 *  to the SDK AND emit the resolved value on the iteration.started event. */
export interface ChatModelResolution {
  /** The resolved model VALUE for this call, used as the event's
   *  `resolved_model`. May be a friendly alias (`haiku|sonnet|opus|fable`),
   *  a canonical `claude-*` id (passed through verbatim), or null when
   *  nothing identifiable was chosen (session default). Derived from
   *  frontmatter (step ?? pipeline) when no explicit override is given, or
   *  from the explicit override itself. */
  shorthand: string | null;
  /** The canonical Anthropic model id to pass to query({ options.model }).
   *  `undefined` means "fall through to the SDK's session default" —
   *  callers should spread this conditionally, not pass `undefined` as a
   *  literal value. */
  modelId: string | undefined;
  /** The pipeline-level model value (from PIPELINE.md frontmatter) or null
   *  when absent/`inherit`/invalid. May be an alias OR a canonical id.
   *  Surfaced separately so the daemon can stamp it on the pipeline.started
   *  `default_model` regardless of which step ran first. */
  pipelineShorthand: string | null;
}

/**
 * Resolve which model `/api/chat` should pass to query() for one chat
 * invocation. Contract:
 *
 *   1. `explicitModel` from the caller (UI's body.model) ALWAYS wins.
 *   2. Otherwise: step frontmatter ?? pipeline frontmatter ?? null.
 *   3. `null` from step 2 maps to `modelId: undefined`, signaling the
 *      caller to omit the `model` option entirely (SDK session default).
 *
 * `pipelineRoot` / `firstIterationAbsPath` may be null when the chat
 * isn't associated with a pipeline; in that case the resolution still
 * runs but returns nulls (and respects the explicit override).
 */
export function resolveChatModel(
  cache: FrontmatterCache,
  pipelineRoot: string | null,
  firstIterationAbsPath: string | null,
  explicitModel: string | null | undefined,
): ChatModelResolution {
  // Always read the pipeline frontmatter when we have a root, even when
  // explicitModel wins — the caller may still want to stamp it on
  // pipeline.started for analytics ("UI overrode the default model").
  const pipelineFm = pipelineRoot
    ? cache.read(join(pipelineRoot, "PIPELINE.md"))
    : null;
  const stepFm = firstIterationAbsPath ? cache.read(firstIterationAbsPath) : null;

  // Pipeline-level value stands alone — we report it on pipeline.started
  // regardless of what the step says. May be an alias OR a canonical id.
  const pipelineShorthand = resolveStepModel(null, pipelineFm);

  const trimmedExplicit = typeof explicitModel === "string" ? explicitModel.trim() : "";
  if (trimmedExplicit.length > 0) {
    // Caller override — accept any alias (haiku|sonnet|opus|fable), any
    // canonical `claude-*` id, or `inherit`. canonicalModelId() maps
    // alias→id, returns null for `inherit`, and passes unknown ids through
    // so the SDK / Anthropic API surfaces a clear error on typos. The event
    // value (`shorthand`) is derived independently via shorthandFromAny so
    // the journal records a known tier when the override maps to one (an
    // alias, or a canonical id that reverse-maps); an unknown canonical id
    // (e.g. `claude-gpt-5`) yields null there but still passes through as
    // the modelId so the SDK call is honored.
    const overrideModelId = canonicalModelId(trimmedExplicit);
    return {
      shorthand: shorthandFromAny(trimmedExplicit),
      modelId: overrideModelId ?? undefined,
      pipelineShorthand,
    };
  }

  const resolved = resolveStepModel(stepFm, pipelineFm);
  if (resolved === null) {
    return { shorthand: null, modelId: undefined, pipelineShorthand };
  }
  return {
    // resolved is an alias OR a canonical id; record it verbatim as the
    // event value, and map it to a canonical id for the SDK.
    shorthand: resolved,
    modelId: canonicalModelId(resolved) ?? undefined,
    pipelineShorthand,
  };
}

/** The platform's reasoning-effort levels (mirrors plan.ts EFFORT_LEVELS —
 *  duplicated because pipeline-ui does not import from pipeline-cli). */
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Validate one raw effort value: a known level (lowercased) or null. */
function validEffort(v: string | null | undefined): string | null {
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  return EFFORT_LEVELS.has(t) ? t : null;
}

/**
 * The `effort:` companion to resolveChatModel, for the Agent-SDK chat path
 * (query() accepts options.effort). Contract: explicit caller override ??
 * step frontmatter ?? pipeline frontmatter ?? null (= omit the option so
 * the SDK uses the session's effort). Invalid values resolve to null —
 * never throw, never block the chat.
 */
export function resolveChatEffort(
  cache: FrontmatterCache,
  pipelineRoot: string | null,
  firstIterationAbsPath: string | null,
  explicitEffort: string | null | undefined,
): string | null {
  const explicit = validEffort(explicitEffort);
  if (explicit) return explicit;
  const stepFm = firstIterationAbsPath ? cache.read(firstIterationAbsPath) : null;
  const fromStep = validEffort(stepFm?.effort);
  if (fromStep) return fromStep;
  const pipelineFm = pipelineRoot ? cache.read(join(pipelineRoot, "PIPELINE.md")) : null;
  return validEffort(pipelineFm?.effort);
}
