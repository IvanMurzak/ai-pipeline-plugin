import { describe, expect, it } from "vitest";
import {
  collectLaunchVars,
  filterPipelines,
  initialVarValues,
  missingRequiredVars,
  pipelineVariables,
} from "../launch";
import type { LaunchCatalogPipeline, LaunchCatalogVariable } from "../../types";

function p(
  name: string,
  endState: string | null = null,
  variables?: LaunchCatalogVariable[],
): LaunchCatalogPipeline {
  return {
    name,
    pipeline_root: `/proj/.claude/pipeline/${name}`,
    first_iteration: null,
    end_state: endState,
    mode: "sequential",
    default_model: null,
    has_targets: false,
    steps: [],
    ...(variables ? { variables } : {}),
    errors: [],
    warnings: [],
  };
}

const v = (
  name: string,
  required: boolean,
  def: string | null = null,
  description = "",
): LaunchCatalogVariable => ({ name, description, required, default: def });

const CATALOG = [
  p("workflows/implement-task", "Task implemented in the run's external worktree"),
  p("workflows/release/targets/unreal-mcp", "Release shipped and pointer bumped"),
  p("unreal-cli-install-extension", "Extension installed via CLI"),
  p("create-extension", "A new engine extension exists"),
];

describe("filterPipelines", () => {
  it("returns everything for an empty/whitespace query", () => {
    expect(filterPipelines(CATALOG, "")).toHaveLength(4);
    expect(filterPipelines(CATALOG, "   ")).toHaveLength(4);
  });

  it("matches by name substring, case-insensitive", () => {
    const hits = filterPipelines(CATALOG, "IMPLEMENT");
    expect(hits.map((x) => x.name)).toEqual(["workflows/implement-task"]);
  });

  it("requires EVERY whitespace-separated term to match (name or end-state)", () => {
    const hits = filterPipelines(CATALOG, "unreal install");
    expect(hits.map((x) => x.name)).toEqual(["unreal-cli-install-extension"]);
  });

  it("matches against the end_state text too", () => {
    const hits = filterPipelines(CATALOG, "pointer bumped");
    expect(hits.map((x) => x.name)).toEqual(["workflows/release/targets/unreal-mcp"]);
  });

  it("returns empty when a term matches nothing", () => {
    expect(filterPipelines(CATALOG, "godot install")).toHaveLength(0);
  });
});

describe("launch variables", () => {
  const support = p("support-answer", "Question answered", [
    v("PP_QUESTION", true, null, "the support question"),
    v("PP_DOCS_DIR", false, "./docs", "where to look"),
    v("PP_EMPTY", false, "", "empty default"),
  ]);

  it("pipelineVariables reads defensively — [] on a null or pre-variable pipeline", () => {
    expect(pipelineVariables(null)).toEqual([]);
    expect(pipelineVariables(p("no-vars"))).toEqual([]);
    expect(pipelineVariables(support)).toHaveLength(3);
  });

  it("initialVarValues prefills each variable with its default ('' when none)", () => {
    expect(initialVarValues(support)).toEqual({
      PP_QUESTION: "", // required, no default
      PP_DOCS_DIR: "./docs",
      PP_EMPTY: "", // empty-string default preserved
    });
    expect(initialVarValues(null)).toEqual({});
  });

  it("collectLaunchVars sends only DECLARED, non-empty values; undefined when nothing set", () => {
    // Untouched defaults → PP_QUESTION empty (dropped), the rest sent.
    expect(collectLaunchVars(support, initialVarValues(support))).toEqual({ PP_DOCS_DIR: "./docs" });
    // The support-answer flow: a spaced question + a custom docs dir.
    expect(
      collectLaunchVars(support, {
        PP_QUESTION: "How do I reset my password?",
        PP_DOCS_DIR: "C:/kb/support docs",
      }),
    ).toEqual({ PP_QUESTION: "How do I reset my password?", PP_DOCS_DIR: "C:/kb/support docs" });
    // Unknown/undeclared names are never forwarded (the server would 400 them).
    expect(collectLaunchVars(support, { PP_QUESTION: "x", NOPE: "y" })).toEqual({ PP_QUESTION: "x" });
    // Nothing declared / all empty → omit the field entirely (defaults apply).
    expect(collectLaunchVars(p("no-vars"), {})).toBeUndefined();
    expect(collectLaunchVars(support, { PP_QUESTION: "", PP_DOCS_DIR: "", PP_EMPTY: "" })).toBeUndefined();
  });

  it("missingRequiredVars flags only empty REQUIRED variables", () => {
    expect(missingRequiredVars(support, initialVarValues(support))).toEqual(["PP_QUESTION"]);
    expect(missingRequiredVars(support, { PP_QUESTION: "  " })).toEqual(["PP_QUESTION"]); // whitespace-only
    expect(missingRequiredVars(support, { PP_QUESTION: "hi" })).toEqual([]);
    expect(missingRequiredVars(p("no-vars"), {})).toEqual([]);
  });
});
