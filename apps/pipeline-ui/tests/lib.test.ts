/**
 * Pure-helper unit tests — bun test.
 *
 *   bun test tests/lib.test.ts
 *
 * These cover the markdown parser, the worktree-aware project root walker,
 * and the recursive pipeline scanner. No daemon boot, no network.
 */

import { describe, expect, test, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  MODEL_ID_TO_SHORTHAND,
  MODEL_SHORTHAND_TO_ID,
  RunSummaryFolder,
  canonicalModelId,
  parseFrontmatter,
  parseIterationSections,
  pipelineInfoFromDir,
  resolveProjectRootFromCwd,
  resolveStepModel,
  scanPipelines,
  shorthandFromAny,
} from "../lib.ts";

describe("RunSummaryFolder — dismiss is sticky", () => {
  // Mirror of the client-side test in
  // web/src/lib/__tests__/runs.test.ts. The server fold and the client
  // fold must agree, otherwise /api/runs and the live SSE-derived run
  // forest will disagree about a dismissed run's status.
  test("pipeline.halted{dismissed:true} freezes status across later events", () => {
    const f = new RunSummaryFolder();
    const baseTs = "2026-01-01T00:00:00Z";
    const events = [
      { ts: baseTs, type: "pipeline.started", run_id: "r1", data: { pipeline_name: "x" } },
      {
        ts: "2026-01-01T00:00:05Z",
        type: "iteration.started",
        run_id: "r1",
        data: { iteration_path: "/x/steps/01.md", index: 1 },
      },
      {
        ts: "2026-01-01T00:00:10Z",
        type: "pipeline.halted",
        run_id: "r1",
        data: { halt_reason: "dismissed by user", dismissed: true },
      },
      // Pipeline kept running after the dismiss.
      {
        ts: "2026-01-01T00:00:15Z",
        type: "iteration.started",
        run_id: "r1",
        data: { iteration_path: "/x/steps/02.md", index: 2 },
      },
      { ts: "2026-01-01T00:00:25Z", type: "pipeline.completed", run_id: "r1", data: {} },
    ];
    for (const e of events) f.addEvent(e);
    const [s] = f.toSummaries();
    expect(s.status).toBe("halted");
    expect(s.halt_reason).toBe("dismissed by user");
    expect(s.current_iteration_index).toBe(2);
    expect(s.current_iteration_path).toBe("/x/steps/02.md");
    // Internal field must not leak into the public summary shape.
    expect((s as unknown as { _dismissed?: boolean })._dismissed).toBeUndefined();
  });

  test("an ordinary (non-dismissed) pipeline.halted is overridable by later iteration.started", () => {
    const f = new RunSummaryFolder();
    const events = [
      { ts: "2026-01-01T00:00:00Z", type: "pipeline.started", run_id: "r1", data: {} },
      {
        ts: "2026-01-01T00:00:05Z",
        type: "pipeline.halted",
        run_id: "r1",
        data: { halt_reason: "transient blocker" },
      },
      {
        ts: "2026-01-01T00:00:10Z",
        type: "iteration.started",
        run_id: "r1",
        data: { iteration_path: "/x/steps/01.md", index: 1 },
      },
    ];
    for (const e of events) f.addEvent(e);
    const [s] = f.toSummaries();
    expect(s.status).toBe("running");
  });
});

describe("parseIterationSections", () => {
  test("extracts title and sections", () => {
    const md = `# 01 — Hello

## Goal

Say hi.

## Steps

1. Greet
2. Wave

## Next

\`02-bye.md\`
`;
    const out = parseIterationSections(md);
    expect(out.title).toBe("01 — Hello");
    expect(out.sections.map((s) => s.heading)).toEqual(["Goal", "Steps", "Next"]);
    expect(out.sections[0].body).toBe("Say hi.");
    expect(out.sections[1].body).toContain("1. Greet");
    expect(out.sections[2].body).toBe("`02-bye.md`");
  });

  test("first H1 wins; subsequent H1s become body", () => {
    const md = `# real title

## A

body

# also looks like a title
`;
    const out = parseIterationSections(md);
    expect(out.title).toBe("real title");
    expect(out.sections.map((s) => s.heading)).toEqual(["A"]);
    expect(out.sections[0].body).toContain("# also looks like a title");
  });

  test("no headings → empty sections, null title", () => {
    const out = parseIterationSections("just some text\nno headings\n");
    expect(out.title).toBeNull();
    expect(out.sections).toEqual([]);
  });

  test("CRLF line endings work the same as LF", () => {
    const md = ["# X", "", "## A", "body"].join("\r\n");
    const out = parseIterationSections(md);
    expect(out.title).toBe("X");
    expect(out.sections[0].heading).toBe("A");
    expect(out.sections[0].body).toBe("body");
  });

  test("section bodies preserve internal blank lines but trim trailing", () => {
    const md = `# T

## A

para 1

para 2

`;
    const out = parseIterationSections(md);
    expect(out.sections[0].body).toBe("para 1\n\npara 2");
  });
});

describe("resolveProjectRootFromCwd", () => {
  let tmpRoot: string;
  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-ui-test-"));
  });
  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("plain repo: .git as directory returns its parent", () => {
    const repo = join(tmpRoot, "plain-repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const sub = join(repo, "src", "deep");
    mkdirSync(sub, { recursive: true });

    const out = resolveProjectRootFromCwd(sub);
    expect(out.project_root).toBe(repo);
    expect(out.worktree).toBeNull();
  });

  test("worktree: .git file + commondir resolves to main repo", () => {
    const mainRepo = join(tmpRoot, "main-repo");
    mkdirSync(join(mainRepo, ".git", "worktrees", "wt"), { recursive: true });
    // commondir relative to the worktree's gitdir points back at main .git
    writeFileSync(
      join(mainRepo, ".git", "worktrees", "wt", "commondir"),
      "../..\n",
      "utf-8",
    );

    const wt = join(tmpRoot, "wt-copy");
    mkdirSync(wt, { recursive: true });
    writeFileSync(
      join(wt, ".git"),
      `gitdir: ${join(mainRepo, ".git", "worktrees", "wt")}\n`,
      "utf-8",
    );

    const out = resolveProjectRootFromCwd(wt);
    expect(out.project_root).toBe(mainRepo);
    expect(out.worktree).toBe(wt);
  });

  test("no .git anywhere: returns the start path", () => {
    const lonely = join(tmpRoot, "no-git");
    mkdirSync(lonely, { recursive: true });
    const out = resolveProjectRootFromCwd(lonely);
    expect(out.project_root).toBe(lonely);
    expect(out.worktree).toBeNull();
  });
});

describe("scanPipelines + pipelineInfoFromDir", () => {
  let tmpRoot: string;
  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-ui-scan-"));
    // Project layout — flat pipelines AND nested category pipelines, plus
    // a noise dir without PIPELINE.md so we exercise both code paths.
    const pipeRoot = join(tmpRoot, ".claude", "pipeline");

    // Flat pipeline at .claude/pipeline/flat-one/
    mkdirSync(join(pipeRoot, "flat-one", "steps"), { recursive: true });
    writeFileSync(
      join(pipeRoot, "flat-one", "PIPELINE.md"),
      `# Pipeline: flat-one\n\n## End State\nAll good.\n\n## Scope\nLimited.\n`,
      "utf-8",
    );
    writeFileSync(
      join(pipeRoot, "flat-one", "steps", "01-a.md"),
      "# 01 — A\n## Goal\nThing one.\n",
      "utf-8",
    );
    writeFileSync(
      join(pipeRoot, "flat-one", "steps", "02-b.md"),
      "# 02 — B\n## Goal\nThing two.\n",
      "utf-8",
    );

    // Nested category: .claude/pipeline/workflows/nested-one/
    mkdirSync(
      join(pipeRoot, "workflows", "nested-one", "steps"),
      { recursive: true },
    );
    writeFileSync(
      join(pipeRoot, "workflows", "nested-one", "PIPELINE.md"),
      `# Pipeline: nested-one\n\n## End State\nDeep success.\n`,
      "utf-8",
    );
    writeFileSync(
      join(pipeRoot, "workflows", "nested-one", "steps", "01-x.md"),
      "# 01 — X\n",
      "utf-8",
    );

    // Noise: workflows/empty-cat/ has no PIPELINE.md and no children
    mkdirSync(join(pipeRoot, "workflows", "empty-cat"), { recursive: true });

    // Hidden dirs are ignored
    mkdirSync(join(pipeRoot, ".runtime"), { recursive: true });
  });
  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("finds both flat and nested pipelines, sorted alpha", () => {
    const out = scanPipelines(tmpRoot);
    expect(out.map((p) => p.pipeline_name)).toEqual(["flat-one", "nested-one"]);
  });

  test("does not descend into a pipeline's own subfolders past steps/", () => {
    // Add a misleading dir INSIDE the existing pipeline that also has
    // PIPELINE.md — we should NOT treat it as a separate pipeline because
    // visit() stops descending once it finds PIPELINE.md.
    mkdirSync(join(tmpRoot, ".claude", "pipeline", "flat-one", "scripts"), {
      recursive: true,
    });
    writeFileSync(
      join(tmpRoot, ".claude", "pipeline", "flat-one", "scripts", "PIPELINE.md"),
      "# Fake\n",
      "utf-8",
    );
    const out = scanPipelines(tmpRoot);
    expect(out.map((p) => p.pipeline_name).sort()).toEqual([
      "flat-one",
      "nested-one",
    ]);
  });

  test("iterations are sorted and end_state is extracted", () => {
    const out = scanPipelines(tmpRoot);
    const flat = out.find((p) => p.pipeline_name === "flat-one")!;
    expect(flat.iterations).toEqual(["01-a.md", "02-b.md"]);
    expect(flat.end_state).toBe("All good.");
    expect(flat.manifest_excerpt).toContain("# Pipeline: flat-one");
  });

  test("missing project returns empty list", () => {
    expect(scanPipelines(join(tmpRoot, "no-such-project"))).toEqual([]);
  });

  test("pipelineInfoFromDir handles a missing PIPELINE.md gracefully", () => {
    const dir = join(tmpRoot, "loose-dir");
    mkdirSync(join(dir, "steps"), { recursive: true });
    writeFileSync(join(dir, "steps", "01-foo.md"), "# 01\n", "utf-8");
    const info = pipelineInfoFromDir(dir);
    expect(info.pipeline_name).toBe("loose-dir");
    expect(info.end_state).toBeNull();
    expect(info.manifest_excerpt).toBeNull();
    expect(info.iterations).toEqual(["01-foo.md"]);
  });
});

describe("scanPipelines — target families + step_models", () => {
  let tmpRoot: string;
  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-ui-family-"));
    const pipeRoot = join(tmpRoot, ".claude", "pipeline");

    // Family HUB with shared steps (02 carries a frontmatter model).
    const hub = join(pipeRoot, "workflows", "family-hub");
    mkdirSync(join(hub, "steps"), { recursive: true });
    writeFileSync(join(hub, "PIPELINE.md"), "# Pipeline: family-hub\n\n## End State\nShipped.\n", "utf-8");
    writeFileSync(join(hub, "steps", "02-shared.md"), "---\nmodel: sonnet\n---\n# 02 — Shared\n", "utf-8");
    writeFileSync(join(hub, "steps", "03-land.md"), "# 03 — Land\n", "utf-8");

    // Target: complete sub-pipeline with its own entry step + model + effort.
    const tgt = join(hub, "targets", "tgt-a");
    mkdirSync(join(tgt, "steps"), { recursive: true });
    writeFileSync(join(tgt, "PIPELINE.md"), "# Pipeline: tgt-a\n\n## End State\nTarget done.\n", "utf-8");
    writeFileSync(
      join(tgt, "steps", "01-entry.md"),
      "---\nmodel: opus\neffort: max\npermission-mode: acceptEdits\n---\n# 01 — Entry\n",
      "utf-8",
    );

    // Family-shared docs dir + a targets/ child without PIPELINE.md — both skipped.
    mkdirSync(join(hub, "targets", ".common"), { recursive: true });
    writeFileSync(join(hub, "targets", ".common", "PIPELINE.md"), "# not a pipeline\n", "utf-8");
    mkdirSync(join(hub, "targets", "not-ready"), { recursive: true });
  });
  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("targets are cataloged alongside their hub; dot-dirs and manifest-less dirs skipped", () => {
    const out = scanPipelines(tmpRoot);
    expect(out.map((p) => p.pipeline_name).sort()).toEqual(["family-hub", "tgt-a"]);
  });

  test("a target carries family_hub + the hub's shared_iterations", () => {
    const tgt = scanPipelines(tmpRoot).find((p) => p.pipeline_name === "tgt-a")!;
    expect(tgt.iterations).toEqual(["01-entry.md"]);
    expect(tgt.family_hub?.pipeline_name).toBe("family-hub");
    expect(tgt.shared_iterations).toEqual(["02-shared.md", "03-land.md"]);
  });

  test("step_models: own + hub frontmatter models, keyed by rel", () => {
    const out = scanPipelines(tmpRoot);
    const tgt = out.find((p) => p.pipeline_name === "tgt-a")!;
    expect(tgt.step_models).toEqual({ "01-entry.md": "opus", "02-shared.md": "sonnet" });
    const hub = out.find((p) => p.pipeline_name === "family-hub")!;
    expect(hub.family_hub).toBeNull();
    expect(hub.shared_iterations).toEqual([]);
    expect(hub.step_models).toEqual({ "02-shared.md": "sonnet" });
  });

  test("step_efforts + step_permission_modes: read from frontmatter, keyed by rel", () => {
    const out = scanPipelines(tmpRoot);
    const tgt = out.find((p) => p.pipeline_name === "tgt-a")!;
    expect(tgt.step_efforts).toEqual({ "01-entry.md": "max" });
    expect(tgt.step_permission_modes).toEqual({ "01-entry.md": "acceptEdits" });
    const hub = out.find((p) => p.pipeline_name === "family-hub")!;
    expect(hub.step_efforts).toEqual({});
  });
});

describe("parseFrontmatter", () => {
  test("empty string → no frontmatter, empty body", () => {
    expect(parseFrontmatter("")).toEqual({ frontmatter: null, body: "" });
  });

  test("string with no frontmatter → body is the original input", () => {
    const input = "# Hello\n\nNo frontmatter here.\n";
    expect(parseFrontmatter(input)).toEqual({ frontmatter: null, body: input });
  });

  test("well-formed frontmatter with two keys", () => {
    const input = `---
model: opus
title: thing
---
# Body

Body text.
`;
    const out = parseFrontmatter(input);
    expect(out.frontmatter).toEqual({ model: "opus", title: "thing" });
    expect(out.body).toBe("# Body\n\nBody text.\n");
  });

  test("malformed (opener but no closer) → treated as no frontmatter", () => {
    const input = `---
model: opus
title: thing
# never closed
body text
more body
`;
    const out = parseFrontmatter(input);
    expect(out).toEqual({ frontmatter: null, body: input });
  });

  test("leading whitespace / BOM-like before the opener still parses", () => {
    const input = `﻿\n  ---
model: sonnet
---
body
`;
    const out = parseFrontmatter(input);
    expect(out.frontmatter).toEqual({ model: "sonnet" });
    expect(out.body).toBe("body\n");
  });

  test("a later --- divider in the body does NOT terminate frontmatter", () => {
    const input = `---
model: haiku
---
# Body

Some prose.

---

A divider above. Still body.
`;
    const out = parseFrontmatter(input);
    expect(out.frontmatter).toEqual({ model: "haiku" });
    expect(out.body).toContain("A divider above");
    expect(out.body).toContain("---");
  });

  test("ignores blank lines and malformed key lines inside frontmatter", () => {
    const input = `---
model: opus

not a key line
title: x
---
body`;
    const out = parseFrontmatter(input);
    expect(out.frontmatter).toEqual({ model: "opus", title: "x" });
    expect(out.body).toBe("body");
  });
});

describe("resolveStepModel", () => {
  test("step value wins over pipeline value", () => {
    expect(resolveStepModel({ model: "opus" }, { model: "sonnet" })).toBe("opus");
  });

  test("falls back to pipeline value when step has none", () => {
    expect(resolveStepModel({}, { model: "haiku" })).toBe("haiku");
    expect(resolveStepModel(null, { model: "haiku" })).toBe("haiku");
    expect(resolveStepModel(undefined, { model: "haiku" })).toBe("haiku");
  });

  test("both null → null", () => {
    expect(resolveStepModel(null, null)).toBeNull();
  });

  test("both undefined → null", () => {
    expect(resolveStepModel(undefined, undefined)).toBeNull();
  });

  test("invalid pipeline value → null and warns", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveStepModel(null, { model: "gpt-5" })).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("case-insensitive: SONNET → sonnet", () => {
    expect(resolveStepModel({ model: "SONNET" }, null)).toBe("sonnet");
  });

  test("trims whitespace: '  opus  ' → opus", () => {
    expect(resolveStepModel({ model: "  opus  " }, null)).toBe("opus");
  });

  test("does not warn when neither side specifies", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveStepModel(null, null)).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("invalid step value falls through to valid pipeline default", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveStepModel({ model: "hai" }, { model: "haiku" })).toBe("haiku");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("invalid step + invalid pipeline → null and warns for both levels", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveStepModel({ model: "hai" }, { model: "gpt-5" })).toBeNull();
      expect(warn.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("fable alias resolves to fable", () => {
    expect(resolveStepModel({ model: "fable" }, null)).toBe("fable");
    expect(resolveStepModel(null, { model: "FABLE" })).toBe("fable");
  });

  test("canonical claude-* id passes through verbatim (case preserved)", () => {
    expect(resolveStepModel({ model: "claude-opus-4-8" }, null)).toBe(
      "claude-opus-4-8",
    );
    // A canonical id we don't have a shorthand for is still ACCEPTED and
    // passed through — the SDK / API validates it, we don't reject it.
    expect(resolveStepModel(null, { model: "claude-fable-5" })).toBe(
      "claude-fable-5",
    );
    expect(resolveStepModel({ model: "claude-some-future-model" }, null)).toBe(
      "claude-some-future-model",
    );
  });

  test("inherit → null (no warning — explicit session default)", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveStepModel({ model: "inherit" }, null)).toBeNull();
      expect(resolveStepModel(null, { model: "INHERIT" })).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("step 'inherit' falls through to a valid pipeline default", () => {
    // `inherit` at the step level means "don't pin THIS step" — it must NOT
    // shadow a valid pipeline-level default (it maps to null, so the ??
    // chain reaches the pipeline value).
    expect(resolveStepModel({ model: "inherit" }, { model: "haiku" })).toBe(
      "haiku",
    );
  });
});

describe("MODEL_SHORTHAND_TO_ID", () => {
  test("contains the four expected shorthand keys", () => {
    expect(Object.keys(MODEL_SHORTHAND_TO_ID).sort()).toEqual([
      "fable",
      "haiku",
      "opus",
      "sonnet",
    ]);
  });

  test("values are the exact current canonical model ids", () => {
    expect(MODEL_SHORTHAND_TO_ID.haiku).toBe("claude-haiku-4-5-20251001");
    expect(MODEL_SHORTHAND_TO_ID.sonnet).toBe("claude-sonnet-4-6");
    expect(MODEL_SHORTHAND_TO_ID.opus).toBe("claude-opus-4-8");
    expect(MODEL_SHORTHAND_TO_ID.fable).toBe("claude-fable-5");
  });
});

describe("MODEL_ID_TO_SHORTHAND", () => {
  test("inverts MODEL_SHORTHAND_TO_ID one-for-one", () => {
    for (const [k, v] of Object.entries(MODEL_SHORTHAND_TO_ID)) {
      expect(MODEL_ID_TO_SHORTHAND[v]).toBe(k);
    }
    expect(Object.keys(MODEL_ID_TO_SHORTHAND).length).toBe(
      Object.keys(MODEL_SHORTHAND_TO_ID).length,
    );
  });
});

describe("canonicalModelId", () => {
  test("shorthand → canonical id", () => {
    expect(canonicalModelId("haiku")).toBe("claude-haiku-4-5-20251001");
    expect(canonicalModelId("sonnet")).toBe("claude-sonnet-4-6");
    expect(canonicalModelId("opus")).toBe("claude-opus-4-8");
    expect(canonicalModelId("fable")).toBe("claude-fable-5");
  });

  test("case-insensitive and trims whitespace", () => {
    expect(canonicalModelId("  HAIKU  ")).toBe("claude-haiku-4-5-20251001");
    expect(canonicalModelId("Sonnet")).toBe("claude-sonnet-4-6");
    expect(canonicalModelId("FABLE")).toBe("claude-fable-5");
  });

  test("canonical id passes through unchanged", () => {
    expect(canonicalModelId("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(canonicalModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(canonicalModelId("claude-fable-5")).toBe("claude-fable-5");
  });

  test("unknown value passes through as-is", () => {
    expect(canonicalModelId("claude-gpt-5")).toBe("claude-gpt-5");
  });

  test("inherit → null (session default)", () => {
    expect(canonicalModelId("inherit")).toBeNull();
    expect(canonicalModelId("  INHERIT  ")).toBeNull();
  });

  test("empty / whitespace-only → null", () => {
    expect(canonicalModelId("")).toBeNull();
    expect(canonicalModelId("   ")).toBeNull();
  });
});

describe("shorthandFromAny", () => {
  test("shorthand input → shorthand", () => {
    expect(shorthandFromAny("haiku")).toBe("haiku");
    expect(shorthandFromAny("sonnet")).toBe("sonnet");
    expect(shorthandFromAny("opus")).toBe("opus");
    expect(shorthandFromAny("fable")).toBe("fable");
  });

  test("canonical id input → shorthand", () => {
    expect(shorthandFromAny("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(shorthandFromAny("claude-sonnet-4-6")).toBe("sonnet");
    expect(shorthandFromAny("claude-opus-4-8")).toBe("opus");
    expect(shorthandFromAny("claude-fable-5")).toBe("fable");
  });

  test("case-insensitive and trims whitespace for shorthand", () => {
    expect(shorthandFromAny("  OPUS  ")).toBe("opus");
  });

  test("inherit → null (session default)", () => {
    expect(shorthandFromAny("inherit")).toBeNull();
    expect(shorthandFromAny("  INHERIT  ")).toBeNull();
  });

  test("unknown / empty / null → null", () => {
    // A canonical id with no shorthand mapping has no tier to report.
    expect(shorthandFromAny("claude-gpt-5")).toBeNull();
    expect(shorthandFromAny("")).toBeNull();
    expect(shorthandFromAny("   ")).toBeNull();
    expect(shorthandFromAny(null)).toBeNull();
    expect(shorthandFromAny(undefined)).toBeNull();
  });
});

describe("RunSummaryFolder — derived WAITING (design 05)", () => {
  // Mirror of the client-side test in web/src/lib/__tests__/runs.test.ts. The
  // two folds MUST agree: /api/runs and the SSE-derived forest render the same
  // badge, and a disagreement would show a run as waiting in one surface and
  // running in the other.
  const at = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, "0")}Z`;

  test("the event raises the flag; status and terminal logic stay untouched", () => {
    const f = new RunSummaryFolder();
    f.addEvent({ ts: at(0), type: "pipeline.started", run_id: "r1", data: { pipeline_name: "x" } });
    f.addEvent({ ts: at(5), type: "run.awaiting_input", run_id: "r1", data: { kind: "permission" } });
    const [s] = f.toSummaries();
    expect(s!.awaiting_input).toBe(true);
    expect(s!.awaiting_input_kind).toBe("permission");
    expect(s!.status).toBe("running");
  });

  test("any later event clears it, and the run still reaches completed", () => {
    const f = new RunSummaryFolder();
    f.addEvent({ ts: at(0), type: "pipeline.started", run_id: "r1", data: { pipeline_name: "x" } });
    f.addEvent({ ts: at(5), type: "run.awaiting_input", run_id: "r1", data: { kind: "input" } });
    f.addEvent({ ts: at(9), type: "pipeline.completed", run_id: "r1", data: {} });
    const [s] = f.toSummaries();
    expect(s!.awaiting_input).toBe(false);
    expect(s!.awaiting_input_kind).toBeNull();
    expect(s!.status).toBe("completed");
  });

  test("an ambient event (no run_id) creates no summary", () => {
    const f = new RunSummaryFolder();
    f.addEvent({ ts: at(0), type: "run.awaiting_input", run_id: null, data: { kind: "input" } });
    expect(f.toSummaries()).toHaveLength(0);
  });
});
