import { expect, test } from "bun:test";
import { buildAiFixChildEnv, buildAiFixPrompt, handleGetAiFixJob, handleStartAiFix } from "../aifix.ts";

test("buildAiFixPrompt embeds the pipeline root, every issue, and the write-scope rule", () => {
  const root = "C:/proj/.pipeline/demo";
  const p = buildAiFixPrompt(root, ["manifest missing End State", "step 02 has no Next"]);
  expect(p).toContain(root);
  expect(p).toContain("- manifest missing End State");
  expect(p).toContain("- step 02 has no Next");
  expect(p).toContain(`Edit files ONLY inside ${root}`);
});

test("GET unknown job → 404; missing job_id → 400", () => {
  expect(handleGetAiFixJob(new URL("http://x/api/editor/ai-fix?job_id=nope")).status).toBe(404);
  expect(handleGetAiFixJob(new URL("http://x/api/editor/ai-fix")).status).toBe(400);
});

test("start validates inputs before spawning anything", async () => {
  const deps = {
    getProject: (id: string) =>
      id === "p1" ? { project_id: "p1", project_root: "C:/definitely/not/a/project" } : undefined,
    log: () => {},
  };
  const mk = (body: unknown) =>
    new Request("http://x/api/editor/ai-fix", { method: "POST", body: JSON.stringify(body) });

  // missing fields
  expect((await handleStartAiFix(mk({}), deps)).status).toBe(400);
  // unknown project
  expect(
    (await handleStartAiFix(mk({ project_id: "zz", pipeline_root: "C:/x", issues: ["a"] }), deps)).status,
  ).toBe(404);
  // pipeline_root outside the project's pipelines dir
  expect(
    (
      await handleStartAiFix(
        mk({ project_id: "p1", pipeline_root: "C:/elsewhere/pipeline", issues: ["a"] }),
        deps,
      )
    ).status,
  ).toBe(403);
  // inside the pipelines dir but no PIPELINE.md on disk
  expect(
    (
      await handleStartAiFix(
        mk({
          project_id: "p1",
          pipeline_root: "C:/definitely/not/a/project/.pipeline/demo",
          issues: ["a"],
        }),
        deps,
      )
    ).status,
  ).toBe(404);
});

// ux-v2 b8 / T18: CLAUDE_CODE_FORWARD_SUBAGENT_TEXT must never reach the
// spawned `claude -p` session's environment, even when the parent shell
// (here: the process that launched pipeline-ui) exports it.
test("buildAiFixChildEnv deletes CLAUDE_CODE_FORWARD_SUBAGENT_TEXT even when the base env carries it", () => {
  const base = { ...process.env, CLAUDE_CODE_FORWARD_SUBAGENT_TEXT: "1", OTHER_VAR: "kept" };
  const child = buildAiFixChildEnv(base);
  expect("CLAUDE_CODE_FORWARD_SUBAGENT_TEXT" in child).toBe(false);
  expect(child.OTHER_VAR).toBe("kept");
  // The base object itself is untouched — the deletion is on the copy only.
  expect(base.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT).toBe("1");
});

test("buildAiFixChildEnv is a no-op when the variable was never set", () => {
  const base = { ...process.env };
  delete base.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT;
  const child = buildAiFixChildEnv(base);
  expect("CLAUDE_CODE_FORWARD_SUBAGENT_TEXT" in child).toBe(false);
});
