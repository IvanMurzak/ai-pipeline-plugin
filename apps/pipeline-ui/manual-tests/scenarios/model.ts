/**
 * Per-pipeline / per-step model selection — issue #7.
 *
 * Three free scenarios exercise the resolver directly off disk:
 *   - model-step-override-wins:    step `model: opus`   beats pipeline `model: sonnet`
 *   - model-pipeline-default:      pipeline `model: haiku`, step has no FM → haiku
 *   - model-invalid-falls-through: pipeline `model: gpt-5` (garbage) → null + console.warn
 *
 * One opt-in scenario costs real (cheap) tokens:
 *   - model-haiku-end-to-end: writes a fixture pipeline with `model: haiku`
 *     on PIPELINE.md, fires /api/chat WITHOUT body.model, and asserts the
 *     assistant message reports the canonical Haiku id back to us. Same
 *     opt-in gate as scenarios/haiku-smoke.ts — added in run.ts only when
 *     `--include-haiku` is on the command line.
 *
 * These scenarios are deliberately thin wrappers around resolveChatModel —
 * tests/model-resolution.test.ts already covers the matrix exhaustively
 * with bun test. The manual-test versions exist so a human running
 * `bun manual-tests/run.ts` sees the model resolution actually fire
 * against the same harness that exercises every other v0.23.x fix.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect, expectEq } from "../harness.ts";
import type { Scenario } from "./index.ts";
import { MODEL_SHORTHAND_TO_ID } from "../../lib.ts";
import { FrontmatterCache, resolveChatModel } from "../../model-resolver.ts";

// --------------------------------------------------------------------- //
// Fixture helpers — write a minimal PIPELINE.md + steps/01-trivial.md
// shaped like the user-facing skeleton in the task spec. We inline-build
// these per scenario rather than committing them under fixtures/ because
// the manifest body is identical across all three free scenarios and only
// the frontmatter changes — keeping them in code makes the per-scenario
// diff legible. Mirrors how chat-messages-rotation-folding writes its
// rotated-archive shard inline rather than committing a sample.
// --------------------------------------------------------------------- //

const PIPELINE_BODY_TEMPLATE = (name: string): string => `
# ${name}

## End State
A fixture pipeline for testing per-step model selection. No real work happens.

## Scope
**In:** the resolver picks the right model.
**Out:** anything else.

## Project Context
N/A — fixture.

## Invariants
- Resolver picks step ?? pipeline ?? null.
`;

const STEP_BODY = `# 01 — Trivial

## Goal
Resolve model.

## Steps
1. echo "ok"

## Success Criteria
- Resolver returned the expected shorthand.

## Next
PIPELINE_COMPLETE
`;

interface FixturePaths {
  root: string;
  pipelineRoot: string;
  stepPath: string;
  cleanup: () => void;
}

/** Build a temp pipeline tree on disk with the given frontmatter on each
 *  file. Pass `null` to omit the frontmatter block entirely. Returns the
 *  paths resolveChatModel needs (pipelineRoot + first step absolute path)
 *  plus a cleanup callback the scenario should call before returning. */
function buildFixture(
  label: string,
  pipelineModel: string | null,
  stepModel: string | null,
): FixturePaths {
  const root = mkdtempSync(join(tmpdir(), `pipe-model-${label}-`));
  const pipelineRoot = join(root, ".claude", "pipeline", `model-${label}`);
  mkdirSync(join(pipelineRoot, "steps"), { recursive: true });

  const pipelineFm =
    pipelineModel === null ? "" : `---\nmodel: ${pipelineModel}\n---\n`;
  const stepFm = stepModel === null ? "" : `---\nmodel: ${stepModel}\n---\n`;

  writeFileSync(
    join(pipelineRoot, "PIPELINE.md"),
    `${pipelineFm}${PIPELINE_BODY_TEMPLATE(`model-${label}`)}`,
    "utf-8",
  );
  const stepPath = join(pipelineRoot, "steps", "01-trivial.md");
  writeFileSync(stepPath, `${stepFm}${STEP_BODY}`, "utf-8");

  return {
    root,
    pipelineRoot,
    stepPath,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

// --------------------------------------------------------------------- //
// Scenario 1 — step frontmatter overrides pipeline frontmatter.
// --------------------------------------------------------------------- //

export const modelStepOverrideWins: Scenario = {
  name: "model-step-override-wins",
  description:
    "PIPELINE.md says sonnet, step says opus — resolver picks opus (step ?? pipeline)",
  async run(_h) {
    const fx = buildFixture("step-override-wins", "sonnet", "opus");
    try {
      const cache = new FrontmatterCache();
      const out = resolveChatModel(cache, fx.pipelineRoot, fx.stepPath, null);
      let ok = true;
      ok = expectEq("resolved shorthand", out.shorthand, "opus") && ok;
      ok = expectEq("modelId is canonical opus id", out.modelId, MODEL_SHORTHAND_TO_ID.opus) && ok;
      // pipelineShorthand reports the PIPELINE.md value regardless of the
      // step-level override — server.ts stamps it on pipeline.started for
      // "UI overrode the default model" analytics.
      ok = expectEq("pipelineShorthand still surfaces sonnet", out.pipelineShorthand, "sonnet") && ok;
      return ok;
    } finally {
      fx.cleanup();
    }
  },
};

// --------------------------------------------------------------------- //
// Scenario 2 — step has no frontmatter, pipeline default applies.
// --------------------------------------------------------------------- //

export const modelPipelineDefault: Scenario = {
  name: "model-pipeline-default",
  description:
    "PIPELINE.md model: haiku, step has no frontmatter — resolver picks haiku from the pipeline default",
  async run(_h) {
    const fx = buildFixture("pipeline-default", "haiku", null);
    try {
      const cache = new FrontmatterCache();
      const out = resolveChatModel(cache, fx.pipelineRoot, fx.stepPath, null);
      let ok = true;
      ok = expectEq("resolved shorthand", out.shorthand, "haiku") && ok;
      ok = expectEq("modelId is canonical haiku id", out.modelId, MODEL_SHORTHAND_TO_ID.haiku) && ok;
      ok = expectEq("pipelineShorthand also haiku", out.pipelineShorthand, "haiku") && ok;
      return ok;
    } finally {
      fx.cleanup();
    }
  },
};

// --------------------------------------------------------------------- //
// Scenario 3 — invalid pipeline-level model warns + falls through to null.
// --------------------------------------------------------------------- //

export const modelInvalidFallsThrough: Scenario = {
  name: "model-invalid-falls-through",
  description:
    "PIPELINE.md model: gpt-5 (not a valid shorthand) — resolver returns null AND console.warn is called",
  async run(_h) {
    const fx = buildFixture("invalid", "gpt-5", null);
    try {
      const cache = new FrontmatterCache();
      // Spy on console.warn — resolveStepModel is documented to warn once
      // per unknown value so a typo surfaces in the daemon log instead of
      // silently downgrading the model. We capture the args here.
      const warnCalls: unknown[][] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnCalls.push(args);
      };
      let out;
      try {
        out = resolveChatModel(cache, fx.pipelineRoot, fx.stepPath, null);
      } finally {
        console.warn = origWarn;
      }
      let ok = true;
      ok = expectEq("shorthand is null", out.shorthand, null) && ok;
      // pipelineShorthand also resolves via resolveStepModel → also null
      // for an invalid value (and produces a second warn call).
      ok = expectEq("pipelineShorthand is null", out.pipelineShorthand, null) && ok;
      // undefined modelId is the magic value the chat handler uses to omit
      // the `model` option from query() entirely.
      ok = expect("modelId is undefined (SDK session default)", out.modelId === undefined) && ok;
      ok = expect(
        `console.warn was called (got ${warnCalls.length} call(s))`,
        warnCalls.length >= 1,
      ) && ok;
      // Sanity: the warn message should mention the bogus value somewhere.
      const joined = warnCalls.flat().map(String).join(" ");
      ok = expect("warn message mentions 'gpt-5'", joined.includes("gpt-5")) && ok;
      return ok;
    } finally {
      fx.cleanup();
    }
  },
};

// --------------------------------------------------------------------- //
// Scenario 4 — opt-in: real /api/chat with PIPELINE.md model: haiku
// and no body.model, asserting the SDK actually receives the haiku id.
// Gated in run.ts behind --include-haiku exactly like haiku-smoke.
// --------------------------------------------------------------------- //

const HAIKU_CANONICAL_ID = MODEL_SHORTHAND_TO_ID.haiku; // claude-haiku-4-5-20251001

export const modelHaikuEndToEnd: Scenario = {
  name: "model-haiku-end-to-end",
  description:
    "Real /api/chat with PIPELINE.md model: haiku (no body.model) — proves the resolver path feeds the haiku canonical id all the way into the SDK",
  async run(h) {
    // tempProject gives us a registered project with the default
    // test-pipeline already copied in. We then drop a SECOND pipeline
    // (model-haiku-e2e) next to it so scanPipelines discovers both and
    // we can target ours by name.
    const proj = await h.tempProject("model-haiku-e2e");
    const pipelineName = "model-haiku-e2e";
    const pipelineRoot = join(
      proj.project_root,
      ".claude",
      "pipeline",
      pipelineName,
    );
    mkdirSync(join(pipelineRoot, "steps"), { recursive: true });
    writeFileSync(
      join(pipelineRoot, "PIPELINE.md"),
      `---\nmodel: haiku\n---\n${PIPELINE_BODY_TEMPLATE(pipelineName)}`,
      "utf-8",
    );
    writeFileSync(
      join(pipelineRoot, "steps", "01-trivial.md"),
      STEP_BODY,
      "utf-8",
    );

    console.log(
      "    → calling /api/chat with PIPELINE.md model: haiku (will spend a few cents)...",
    );
    const start = Date.now();
    // Keep the prompt ≤ 50 tokens and explicitly forbid tool use to bound
    // cost. The resolver path is what we're testing, not the model output.
    const { events } = await h.runChat({
      projectId: proj.project_id,
      pipelineName,
      prompt:
        'Reply with the exact single word "PASS" and nothing else. Do not use any tools.',
      // CRITICAL: do NOT pass model — the resolver must populate it from
      // PIPELINE.md frontmatter. Passing body.model here would short-circuit
      // the resolver and prove nothing.
      model: null,
      timeoutMs: 90_000,
    });
    const dur = Date.now() - start;
    console.log(`    → ${events.length} SSE events received in ${dur}ms`);

    const types = events.map((e) => e.type);
    let ok = true;
    ok = expect("got chat.started", types.includes("chat.started")) && ok;
    ok = expect("got chat.completed", types.includes("chat.completed")) && ok;
    ok = expect("did NOT get chat.error", !types.includes("chat.error")) && ok;

    // The SDK emits a `system` init message first with the model it chose,
    // then any number of `assistant` messages each carrying message.model.
    // We accept the haiku canonical id appearing in EITHER location — both
    // are equivalent evidence that the resolver populated query()'s `model`.
    const initMsg = events.find(
      (e) =>
        e.type === "chat.message" &&
        (e.data as { type?: string })?.type === "system" &&
        (e.data as { subtype?: string })?.subtype === "init",
    );
    const initModel = (initMsg?.data as { model?: string } | undefined)?.model;
    const assistantModels = events
      .filter(
        (e) =>
          e.type === "chat.message" &&
          (e.data as { type?: string })?.type === "assistant",
      )
      .map(
        (e) => (e.data as { message?: { model?: string } }).message?.model,
      )
      .filter((m): m is string => typeof m === "string");
    console.log(
      `    → init.model=${initModel ?? "<none>"} assistant models=${JSON.stringify(assistantModels)}`,
    );
    const allModelStrs = [initModel, ...assistantModels].filter(
      (m): m is string => typeof m === "string",
    );
    ok = expect(
      `at least one SDK message reports a model id`,
      allModelStrs.length > 0,
    ) && ok;
    ok = expect(
      `SDK ran on the haiku canonical id (${HAIKU_CANONICAL_ID})`,
      allModelStrs.some((m) => m === HAIKU_CANONICAL_ID),
    ) && ok;

    // Also cross-check that the journal carries the resolved shorthand on
    // iteration.started (schema v3 contract — `resolved_model: "haiku"`).
    // This proves the chat handler ran the resolver, not just that the SDK
    // happened to pick haiku for some other reason.
    const journal = h.readJournal(proj);
    const iterStarted = journal.find(
      (e) => e.type === "iteration.started" && e.data && (e.data as { resolved_model?: unknown }).resolved_model !== undefined,
    );
    ok = expect(
      "iteration.started event recorded resolved_model=haiku",
      (iterStarted?.data as { resolved_model?: string } | undefined)?.resolved_model === "haiku",
    ) && ok;
    const pipeStarted = journal.find(
      (e) => e.type === "pipeline.started" && e.data && (e.data as { default_model?: unknown }).default_model !== undefined,
    );
    ok = expect(
      "pipeline.started event recorded default_model=haiku",
      (pipeStarted?.data as { default_model?: string } | undefined)?.default_model === "haiku",
    ) && ok;

    return ok;
  },
};
