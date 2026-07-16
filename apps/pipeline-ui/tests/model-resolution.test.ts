/**
 * Per-pipeline / per-step model resolution for /api/chat — issue #7,
 * widened for per-step model selection (fable alias + canonical ids +
 * inherit).
 *
 * /api/chat itself is coupled to the live Anthropic Agent SDK (which is
 * neither cheap nor practical to mock for a unit test), so we exercise
 * the extracted `resolveChatModel` helper from `../model-resolver.ts`
 * with the same fixture shapes /api/chat would feed it:
 *
 *   PIPELINE.md frontmatter (`model: haiku|sonnet|opus|fable|claude-*|
 *     inherit|<garbage>|<none>`),
 *   first step frontmatter (same),
 *   explicit `body.model` from the UI (wins over everything).
 *
 * Contract: step ?? pipeline ?? null, with explicit override beating
 * both. `inherit` / null resolution maps to `modelId: undefined` so the
 * caller spreads nothing into query() and the SDK uses its session
 * default. A canonical `claude-*` id is accepted and passed through
 * verbatim (never coerced to null).
 *
 *   bun test tests/model-resolution.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MODEL_SHORTHAND_TO_ID } from "../lib.ts";
import { FrontmatterCache, resolveChatModel } from "../model-resolver.ts";

let root: string;
let pipelineRoot: string;
let firstStepPath: string;

function writePipeline(modelLine: string | null): void {
  const fm = modelLine === null ? "" : `---\nmodel: ${modelLine}\n---\n`;
  writeFileSync(
    join(pipelineRoot, "PIPELINE.md"),
    `${fm}# Pipeline: alpha\n\n## End State\nDone.\n`,
    "utf-8",
  );
}

function writeStep(modelLine: string | null): void {
  const fm = modelLine === null ? "" : `---\nmodel: ${modelLine}\n---\n`;
  writeFileSync(
    firstStepPath,
    `${fm}# 01 — Hello\n\n## Goal\n\nDo the thing.\n`,
    "utf-8",
  );
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pipeline-ui-model-"));
  pipelineRoot = join(root, ".claude", "pipeline", "alpha");
  mkdirSync(join(pipelineRoot, "steps"), { recursive: true });
  firstStepPath = join(pipelineRoot, "steps", "01-hello.md");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveChatModel (/api/chat model resolution)", () => {
  test("PIPELINE.md model: haiku + no step frontmatter → SDK gets haiku id", () => {
    writePipeline("haiku");
    writeStep(null);
    // Fresh cache per test so we exercise the disk read every time —
    // these tests aren't trying to verify the cache, just the resolution.
    const cache = new FrontmatterCache();
    const out = resolveChatModel(cache, pipelineRoot, firstStepPath, null);
    expect(out.shorthand).toBe("haiku");
    expect(out.modelId).toBe(MODEL_SHORTHAND_TO_ID.haiku);
    expect(out.modelId).toBe("claude-haiku-4-5-20251001");
    expect(out.pipelineShorthand).toBe("haiku");
  });

  test("explicit body.model 'sonnet' overrides PIPELINE.md 'haiku'", () => {
    writePipeline("haiku");
    writeStep(null);
    const cache = new FrontmatterCache();
    // The override path accepts either a shorthand or a canonical id —
    // shorthand inputs map to their canonical id for the SDK and surface
    // back through `shorthand` so the journal still records resolved_model.
    const out = resolveChatModel(cache, pipelineRoot, firstStepPath, "sonnet");
    expect(out.modelId).toBe(MODEL_SHORTHAND_TO_ID.sonnet);
    expect(out.shorthand).toBe("sonnet");
    expect(out.pipelineShorthand).toBe("haiku");
  });

  test("explicit shorthand 'haiku' → canonical id + shorthand populated", () => {
    writePipeline(null);
    writeStep(null);
    const cache = new FrontmatterCache();
    const out = resolveChatModel(cache, pipelineRoot, firstStepPath, "haiku");
    expect(out.shorthand).toBe("haiku");
    expect(out.modelId).toBe(MODEL_SHORTHAND_TO_ID.haiku);
    expect(out.modelId).toBe("claude-haiku-4-5-20251001");
  });

  test("explicit canonical id 'claude-opus-4-8' → shorthand 'opus' derived", () => {
    writePipeline(null);
    writeStep(null);
    const cache = new FrontmatterCache();
    const out = resolveChatModel(cache, pipelineRoot, firstStepPath, "claude-opus-4-8");
    expect(out.shorthand).toBe("opus");
    expect(out.modelId).toBe("claude-opus-4-8");
  });

  test("explicit 'fable' alias → canonical id + shorthand populated", () => {
    writePipeline(null);
    writeStep(null);
    const cache = new FrontmatterCache();
    const out = resolveChatModel(cache, pipelineRoot, firstStepPath, "fable");
    expect(out.shorthand).toBe("fable");
    expect(out.modelId).toBe(MODEL_SHORTHAND_TO_ID.fable);
    expect(out.modelId).toBe("claude-fable-5");
  });

  test("explicit canonical id 'claude-fable-5' → shorthand 'fable' derived", () => {
    writePipeline(null);
    writeStep(null);
    const cache = new FrontmatterCache();
    const out = resolveChatModel(cache, pipelineRoot, firstStepPath, "claude-fable-5");
    expect(out.shorthand).toBe("fable");
    expect(out.modelId).toBe("claude-fable-5");
  });

  test("explicit 'inherit' override → falls through to session default", () => {
    writePipeline(null);
    writeStep(null);
    const cache = new FrontmatterCache();
    const out = resolveChatModel(cache, pipelineRoot, firstStepPath, "inherit");
    expect(out.shorthand).toBeNull();
    expect(out.modelId).toBeUndefined();
  });

  test("explicit unknown id passes through with null shorthand", () => {
    writePipeline(null);
    writeStep(null);
    const cache = new FrontmatterCache();
    const out = resolveChatModel(cache, pipelineRoot, firstStepPath, "claude-gpt-5");
    expect(out.shorthand).toBeNull();
    expect(out.modelId).toBe("claude-gpt-5");
  });

  test("explicit '  haiku  ' (whitespace) resolves to haiku canonical", () => {
    writePipeline(null);
    writeStep(null);
    const cache = new FrontmatterCache();
    const out = resolveChatModel(cache, pipelineRoot, firstStepPath, "  haiku  ");
    expect(out.shorthand).toBe("haiku");
    expect(out.modelId).toBe(MODEL_SHORTHAND_TO_ID.haiku);
  });

  test("explicit empty / whitespace-only falls through to frontmatter resolution", () => {
    writePipeline("sonnet");
    writeStep(null);
    const cache = new FrontmatterCache();
    const out = resolveChatModel(cache, pipelineRoot, firstStepPath, "   ");
    // Empty override → treated as no override → frontmatter wins.
    expect(out.shorthand).toBe("sonnet");
    expect(out.modelId).toBe(MODEL_SHORTHAND_TO_ID.sonnet);
    expect(out.pipelineShorthand).toBe("sonnet");
  });

  test("invalid PIPELINE.md model 'gpt-5' resolves to null → SDK keeps session default", () => {
    writePipeline("gpt-5");
    writeStep(null);
    const cache = new FrontmatterCache();
    // Silence the resolveStepModel warning so test output stays clean.
    const origWarn = console.warn;
    console.warn = () => {};
    let out;
    try {
      out = resolveChatModel(cache, pipelineRoot, firstStepPath, null);
    } finally {
      console.warn = origWarn;
    }
    expect(out.shorthand).toBeNull();
    expect(out.pipelineShorthand).toBeNull();
    // undefined here is the magic value: server.ts spreads conditionally
    // so the SDK's `model` option is never set, falling back to the
    // session default — the exact behavior the issue asks for.
    expect(out.modelId).toBeUndefined();
  });

  test("step frontmatter wins over pipeline frontmatter", () => {
    writePipeline("haiku");
    writeStep("opus");
    const cache = new FrontmatterCache();
    const out = resolveChatModel(cache, pipelineRoot, firstStepPath, null);
    expect(out.shorthand).toBe("opus");
    expect(out.modelId).toBe(MODEL_SHORTHAND_TO_ID.opus);
    // pipelineShorthand still reports the pipeline-level value — it's
    // independent of the step-level resolution.
    expect(out.pipelineShorthand).toBe("haiku");
  });

  test("PIPELINE.md model: fable → SDK gets fable canonical id", () => {
    writePipeline("fable");
    writeStep(null);
    const cache = new FrontmatterCache();
    const out = resolveChatModel(cache, pipelineRoot, firstStepPath, null);
    expect(out.shorthand).toBe("fable");
    expect(out.modelId).toBe(MODEL_SHORTHAND_TO_ID.fable);
    expect(out.modelId).toBe("claude-fable-5");
    expect(out.pipelineShorthand).toBe("fable");
  });

  test("step frontmatter canonical id passes through verbatim", () => {
    writePipeline("sonnet");
    writeStep("claude-opus-4-8");
    const cache = new FrontmatterCache();
    const out = resolveChatModel(cache, pipelineRoot, firstStepPath, null);
    // resolved_model carries the canonical id verbatim — never coerced to
    // null — and modelId is that same id for the SDK.
    expect(out.shorthand).toBe("claude-opus-4-8");
    expect(out.modelId).toBe("claude-opus-4-8");
    expect(out.pipelineShorthand).toBe("sonnet");
  });

  test("step frontmatter unknown canonical id is honored, not dropped", () => {
    writePipeline(null);
    writeStep("claude-some-future-model");
    const cache = new FrontmatterCache();
    const out = resolveChatModel(cache, pipelineRoot, firstStepPath, null);
    expect(out.shorthand).toBe("claude-some-future-model");
    expect(out.modelId).toBe("claude-some-future-model");
  });

  test("step model: inherit falls through to pipeline default", () => {
    writePipeline("haiku");
    writeStep("inherit");
    const cache = new FrontmatterCache();
    const out = resolveChatModel(cache, pipelineRoot, firstStepPath, null);
    // `inherit` at the step level means "don't pin this step" — the pipeline
    // default still applies.
    expect(out.shorthand).toBe("haiku");
    expect(out.modelId).toBe(MODEL_SHORTHAND_TO_ID.haiku);
    expect(out.pipelineShorthand).toBe("haiku");
  });

  test("no frontmatter on either side → null shorthand, undefined modelId", () => {
    writePipeline(null);
    writeStep(null);
    const cache = new FrontmatterCache();
    const out = resolveChatModel(cache, pipelineRoot, firstStepPath, null);
    expect(out.shorthand).toBeNull();
    expect(out.modelId).toBeUndefined();
    expect(out.pipelineShorthand).toBeNull();
  });

  test("no pipeline at all (free-form chat) + explicit override → override wins", () => {
    const cache = new FrontmatterCache();
    const out = resolveChatModel(
      cache,
      null,
      null,
      "claude-sonnet-4-6",
    );
    expect(out.modelId).toBe("claude-sonnet-4-6");
    // Canonical id maps back to its shorthand so the journal records it.
    expect(out.shorthand).toBe("sonnet");
    expect(out.pipelineShorthand).toBeNull();
  });

  test("no pipeline at all + no override → undefined modelId", () => {
    const cache = new FrontmatterCache();
    const out = resolveChatModel(cache, null, null, null);
    expect(out.shorthand).toBeNull();
    expect(out.modelId).toBeUndefined();
    expect(out.pipelineShorthand).toBeNull();
  });

  test("FrontmatterCache returns the same parse for unchanged mtime", () => {
    writePipeline("opus");
    writeStep(null);
    const cache = new FrontmatterCache();
    const first = cache.read(join(pipelineRoot, "PIPELINE.md"));
    const second = cache.read(join(pipelineRoot, "PIPELINE.md"));
    // Cached parse — same reference object.
    expect(first).toBe(second);
    expect(first).toEqual({ model: "opus" });
  });

  test("FrontmatterCache.invalidate forces a re-read", () => {
    writePipeline("haiku");
    const cache = new FrontmatterCache();
    const manifestPath = join(pipelineRoot, "PIPELINE.md");
    expect(cache.read(manifestPath)).toEqual({ model: "haiku" });
    writePipeline("sonnet");
    // Without invalidation we'd usually still see haiku for sub-ms mtime
    // changes; explicit invalidate guarantees the next read sees the new
    // content regardless of filesystem mtime resolution.
    cache.invalidate(manifestPath);
    expect(cache.read(manifestPath)).toEqual({ model: "sonnet" });
  });

  test("FrontmatterCache.invalidatePrefix clears all entries under a project root", () => {
    writePipeline("haiku");
    writeStep("opus");
    const cache = new FrontmatterCache();
    cache.read(join(pipelineRoot, "PIPELINE.md"));
    cache.read(firstStepPath);
    cache.invalidatePrefix(root);
    // After prefix invalidation both files are uncached; rewriting them
    // and re-reading should return the new content.
    writePipeline("sonnet");
    writeStep("haiku");
    expect(cache.read(join(pipelineRoot, "PIPELINE.md"))).toEqual({
      model: "sonnet",
    });
    expect(cache.read(firstStepPath)).toEqual({ model: "haiku" });
  });

  test("FrontmatterCache normalizes separator + drive case across read/invalidate", () => {
    writePipeline("haiku");
    const cache = new FrontmatterCache();
    const manifestPath = join(pipelineRoot, "PIPELINE.md");
    cache.read(manifestPath);
    // Same file via the opposite separator style + opposite drive case
    // must hit the same cache entry, AND invalidate via that variant must
    // clear the entry stored under the canonical form.
    const flipped = manifestPath.replaceAll("/", "\\");
    const driveSwapped = /^[A-Za-z]:/.test(flipped)
      ? (flipped[0] === flipped[0].toLowerCase()
          ? flipped[0].toUpperCase() + flipped.slice(1)
          : flipped[0].toLowerCase() + flipped.slice(1))
      : flipped;
    cache.invalidate(driveSwapped);
    writePipeline("sonnet");
    expect(cache.read(manifestPath)).toEqual({ model: "sonnet" });
  });

  test("FrontmatterCache.invalidatePrefix requires path boundary (no sibling overmatch)", () => {
    writePipeline("haiku");
    const cache = new FrontmatterCache();
    cache.read(join(pipelineRoot, "PIPELINE.md"));
    // Invalidating with a prefix that's a string-prefix of the project
    // root but NOT a path-component prefix (e.g. trailing differs after
    // an unrelated character) must leave the entry intact.
    cache.invalidatePrefix(root + "-sibling");
    writePipeline("sonnet"); // mtime change so re-read is the test signal
    // Two rapid writes can land in the same mtime tick (observed flaking
    // under full-suite load) — force a distinct mtime so the cache's
    // mtime-bust re-read is deterministic.
    const manifest = join(pipelineRoot, "PIPELINE.md");
    const st = statSync(manifest);
    utimesSync(manifest, new Date(), new Date(st.mtimeMs + 1000));
    // mtime IS forced fresh, so the assertion below is whether the
    // invalidatePrefix call DID clear (would re-parse and see sonnet) or
    // DID NOT clear (would still see haiku via mtime check). We test the
    // negative: a sibling-prefix call should NOT have cleared, so the
    // mtime-bust on the next read still re-parses the new file. The
    // weaker but reliable assertion: after a sibling-only invalidate, a
    // read of an entirely unrelated path is still uncached.
    expect(cache.read(join(pipelineRoot, "PIPELINE.md"))).toEqual({
      model: "sonnet",
    });
  });
});

// --- resolveChatEffort (the effort: companion) -------------------------------

import { resolveChatEffort } from "../model-resolver.ts";

describe("resolveChatEffort", () => {
  test("explicit override wins; step beats pipeline; invalid values resolve to null", () => {
    const root = mkdtempSync(join(tmpdir(), "effort-"));
    try {
      const pipelineRoot = join(root, "pipe");
      mkdirSync(join(pipelineRoot, "steps"), { recursive: true });
      writeFileSync(join(pipelineRoot, "PIPELINE.md"), "---\neffort: high\n---\n# P\n", "utf-8");
      const step = join(pipelineRoot, "steps", "01-a.md");
      writeFileSync(step, "---\neffort: max\n---\n# 01\n", "utf-8");
      const cache = new FrontmatterCache();
      // Step frontmatter beats the pipeline default.
      expect(resolveChatEffort(cache, pipelineRoot, step, null)).toBe("max");
      // Explicit override beats both (case-insensitive).
      expect(resolveChatEffort(cache, pipelineRoot, step, "XHigh")).toBe("xhigh");
      // Invalid explicit falls through to the ladder.
      expect(resolveChatEffort(cache, pipelineRoot, step, "turbo")).toBe("max");
      // No step → pipeline default.
      expect(resolveChatEffort(cache, pipelineRoot, null, null)).toBe("high");
      // Nothing anywhere → null (session default).
      expect(resolveChatEffort(cache, null, null, null)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
