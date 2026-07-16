import { describe, expect, it } from "vitest";
import { buildPipelineTree, pipelinesUnder } from "../pipelineTree";

describe("buildPipelineTree", () => {
  it("flat names stay flat", () => {
    const t = buildPipelineTree(["beta", "alpha"]);
    expect(t.map((n) => n.seg)).toEqual(["alpha", "beta"]);
    expect(t[0].pipeline).toBe("alpha");
    expect(t[0].children).toEqual([]);
  });

  it("category folders nest; folders sort before plain pipelines", () => {
    const t = buildPipelineTree(["zeta", "workflows/implement-task", "workflows/release", "audits/security"]);
    expect(t.map((n) => n.seg)).toEqual(["audits", "workflows", "zeta"]);
    const workflows = t[1];
    expect(workflows.pipeline).toBeNull(); // pure folder
    expect(workflows.children.map((c) => c.pipeline)).toEqual(["workflows/implement-task", "workflows/release"]);
  });

  it("a target-family hub is BOTH a pipeline and a folder", () => {
    const t = buildPipelineTree(["alpha", "alpha/targets/ios", "alpha/targets/android"]);
    expect(t).toHaveLength(1);
    const alpha = t[0];
    expect(alpha.pipeline).toBe("alpha");
    expect(alpha.children).toHaveLength(1);
    const targets = alpha.children[0];
    expect(targets.seg).toBe("targets");
    expect(targets.pipeline).toBeNull();
    expect(targets.children.map((c) => c.seg)).toEqual(["android", "ios"]);
    expect(pipelinesUnder(alpha)).toBe(3);
  });

  it("{path, name} items: nodes nest by PATH but carry the pipeline NAME", () => {
    // What PipelineTree.tsx feeds now: real on-disk paths + flat names, so
    // duplicate basenames in different categories stay distinct rows.
    const t = buildPipelineTree([
      { path: "godot-extension/create-extension", name: "create-extension" },
      { path: "unity-extension/create-extension", name: "create-extension" },
      { path: "workflows/implement-task", name: "implement-task" },
      { path: "workflows/implement-task/targets/ctx", name: "ctx" },
    ]);
    expect(t.map((n) => n.seg)).toEqual(["godot-extension", "unity-extension", "workflows"]);
    expect(t[0].children[0].pipeline).toBe("create-extension");
    expect(t[1].children[0].pipeline).toBe("create-extension");
    const hub = t[2].children[0];
    expect(hub.pipeline).toBe("implement-task");
    expect(hub.children[0].seg).toBe("targets");
    expect(hub.children[0].children[0].pipeline).toBe("ctx");
  });
});
