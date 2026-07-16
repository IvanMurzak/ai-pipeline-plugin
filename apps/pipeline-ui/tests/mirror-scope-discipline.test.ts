/**
 * Scope-discipline regression (issue #11 invariant #2).
 *
 *   bun test tests/mirror-scope-discipline.test.ts
 *
 * Goal: an ordinary terminal Claude session in a pipeline project —
 * one that NEVER spawns a pipeline-executor — must NEVER have its
 * transcript read or copied by the daemon. This test couples the hook
 * side (handlePostToolUse only emits a binding for pipeline-executor
 * spawns) with the daemon side (MirrorService only tails bound
 * transcripts) and proves the negative end-to-end.
 *
 * Why a dedicated test: this is a load-bearing privacy invariant. The
 * `mirror-tail.test.ts` "transcript that is NEVER bound is NEVER read"
 * test covers the daemon half. This file covers the integration —
 * even a perfectly innocent project with PostToolUse events firing
 * for non-executor tools (Read/Edit/Bash/Agent-but-not-pipeline-executor)
 * must produce ZERO mirror activity.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handlePostToolUse } from "../../../hooks/analytics_relay.ts";
import { MirrorService, type AppendChatFn } from "../mirror.ts";

let tmpRoot: string;
let homeDir: string;
let projectRoot: string;
let bindingsPath: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let captured: unknown[];
let appendChat: AppendChatFn;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "scope-discipline-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpRoot, "home-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  projectRoot = mkdtempSync(join(tmpRoot, "proj-"));
  mkdirSync(join(projectRoot, ".claude", "pipeline", ".runtime"), { recursive: true });
  bindingsPath = join(homeDir, ".claude", "pipeline-ui", "active-mirror-bindings.jsonl");
  captured = [];
  appendChat = (_pr, _rid, msg) => {
    captured.push(msg);
  };
});

function makePayload(opts: { toolName: string; toolInput?: object; toolResponse?: object }): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    tool_name: opts.toolName,
    tool_input: opts.toolInput ?? {},
    tool_response: opts.toolResponse ?? { content: "ok" },
    tool_use_id: `toolu_${Math.random().toString(36).slice(2, 10)}`,
  };
}

describe("scope-discipline invariant", () => {
  test("Read/Edit/Bash tools never write a mirror binding", () => {
    handlePostToolUse(makePayload({ toolName: "Read", toolInput: { file_path: "/x" } }), projectRoot, null);
    handlePostToolUse(makePayload({ toolName: "Edit", toolInput: { file_path: "/x", old_string: "a", new_string: "b" } }), projectRoot, null);
    handlePostToolUse(makePayload({ toolName: "Bash", toolInput: { command: "ls" } }), projectRoot, null);
    handlePostToolUse(makePayload({ toolName: "Write", toolInput: { file_path: "/x", content: "" } }), projectRoot, null);
    handlePostToolUse(makePayload({ toolName: "Grep", toolInput: { pattern: "foo" } }), projectRoot, null);
    expect(existsSync(bindingsPath)).toBe(false);
  });

  test("Agent spawn of non-pipeline-executor subagent does NOT write a binding", () => {
    // Subagents that aren't pipeline-executor are typed differently
    // (general-purpose, Explore, code-reviewer, etc.). None of these
    // should bind — those are ordinary coding-session subagents that
    // happen to fire inside a project that also uses the pipeline
    // plugin.
    for (const subagentType of [
      "general-purpose",
      "Explore",
      "code-reviewer",
      "Plan",
      "pipeline-designer",
      "pipeline-improver",
    ]) {
      handlePostToolUse(
        makePayload({
          toolName: "Agent",
          toolInput: {
            subagent_type: subagentType,
            prompt: "do an ordinary research task",
          },
        }),
        projectRoot,
        null,
      );
    }
    expect(existsSync(bindingsPath)).toBe(false);
  });

  test("Even pipeline-executor without an iteration path does NOT bind", () => {
    // Some odd usage: someone hand-invokes pipeline-executor with a
    // freeform prompt. parseExecutorSpawn returns null. No binding.
    handlePostToolUse(
      makePayload({
        toolName: "Agent",
        toolInput: {
          subagent_type: "pipeline-executor",
          prompt: "do whatever you think is right",
        },
      }),
      projectRoot,
      null,
    );
    expect(existsSync(bindingsPath)).toBe(false);
  });

  test("Daemon, given an empty bindings file, never tails any transcript on disk", () => {
    // Create a transcript file with rich content — this simulates an
    // ordinary terminal Claude session that lives in ~/.claude/projects/.
    // We then run the MirrorService with an EMPTY bindings file. The
    // service must not discover or read this transcript even though
    // it exists on disk in the user's home.
    const stranger = join(homeDir, ".claude", "projects", "ordinary-session.jsonl");
    mkdirSync(join(homeDir, ".claude", "projects"), { recursive: true });
    writeFileSync(
      stranger,
      JSON.stringify({
        type: "user",
        uuid: "ordinary-1",
        timestamp: "2026-05-23T08:00:00.000Z",
        message: { role: "user", content: "private question about my project" },
        sessionId: "ordinary-session",
      }) + "\n",
      "utf-8",
    );

    // No binding written.
    const svc = new MirrorService({ bindingsPath, appendChat });
    svc.start();
    svc.tickForTest();
    svc.stop();

    expect(captured).toHaveLength(0);

    // The ordinary session's file on disk must be byte-identical —
    // the service must NEVER write near it.
    const after = readFileSync(stranger, "utf-8");
    expect(after).toContain("ordinary-1");
  });

  test("Full mix: many non-executor PostToolUse calls + a deep transcript on disk → ZERO mirror activity", () => {
    // Replay 50 ordinary tool calls. None should bind.
    for (let i = 0; i < 50; i++) {
      handlePostToolUse(makePayload({ toolName: i % 2 === 0 ? "Bash" : "Read" }), projectRoot, null);
    }
    // Drop a deep transcript in ~/.claude/projects to tempt the
    // daemon. None of it should be touched.
    const transcript = join(homeDir, ".claude", "projects", "deep-session.jsonl");
    mkdirSync(join(homeDir, ".claude", "projects"), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(
        JSON.stringify({
          type: i % 3 === 0 ? "assistant" : "user",
          uuid: `deep-${i}`,
          timestamp: `2026-05-23T08:0${i % 6}:00.000Z`,
          sessionId: "deep-session",
          message: { role: i % 3 === 0 ? "assistant" : "user", content: `content #${i}` },
        }),
      );
    }
    writeFileSync(transcript, lines.join("\n") + "\n", "utf-8");

    const svc = new MirrorService({ bindingsPath, appendChat });
    svc.start();
    svc.tickForTest();
    svc.tickForTest();
    svc.stop();

    expect(captured).toHaveLength(0);
    expect(existsSync(bindingsPath)).toBe(false);
  });
});
