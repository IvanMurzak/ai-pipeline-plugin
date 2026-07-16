import { describe, expect, it } from "vitest";
import { filterPipelines } from "../launch";
import type { LaunchCatalogPipeline } from "../../types";

function p(name: string, endState: string | null = null): LaunchCatalogPipeline {
  return {
    name,
    pipeline_root: `/proj/.claude/pipeline/${name}`,
    first_iteration: null,
    end_state: endState,
    mode: "sequential",
    default_model: null,
    has_targets: false,
    steps: [],
    errors: [],
    warnings: [],
  };
}

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
