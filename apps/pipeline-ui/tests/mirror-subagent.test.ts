/**
 * MirrorService — subagent transcript chasing.
 *
 *   bun test tests/mirror-subagent.test.ts
 *
 * When a parent transcript's assistant message contains a tool_use for
 * Agent / Task / TaskCreate with a subagent_type, the MirrorService
 * locates the corresponding subagent transcript on disk and binds it
 * under the same run_id so its messages flow into the same chat panel.
 *
 * Claude Code's subagent transcript layout (verified empirically on
 * IvanD machine 2026-05-23):
 *
 *   ~/.claude/projects/<encoded-cwd>/
 *     <session-id>.jsonl                       parent
 *     <session-id>/subagents/agent-<aid>.jsonl subagent transcript
 *     <session-id>/subagents/agent-<aid>.meta.json
 *       { "agentType": "<subagent_type>", "description": "..." }
 *
 * The parent tool_use_id is NOT preserved in the subagent meta; the
 * correlation key is filesystem mtime + agentType.
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
  appendFileSync,
  writeFileSync,
  utimesSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import {
  MirrorService,
  findSubagentTranscript,
  type AppendChatFn,
  type MirrorBindingRecord,
} from "../mirror.ts";

let tmpRoot: string;
let bindingsDir: string;
let bindingsPath: string;
let projectRoot: string;
let captured: Array<{ runId: string; uuid: string | undefined }>;
let appendChat: AppendChatFn;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "mirror-subagent-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  bindingsDir = mkdtempSync(join(tmpRoot, "bindings-"));
  bindingsPath = join(bindingsDir, "active-mirror-bindings.jsonl");
  projectRoot = mkdtempSync(join(tmpRoot, "proj-"));
  mkdirSync(join(projectRoot, ".claude", "pipeline", ".runtime"), { recursive: true });
  captured = [];
  appendChat = (_pr, rid, msg) => {
    captured.push({ runId: rid, uuid: (msg as { uuid?: string }).uuid });
  };
});

/** Build a fake ~/.claude/projects/<encoded-cwd>/ layout with a parent
 *  session jsonl and one subagent jsonl + meta. Returns the parent
 *  path. The subagent's mtime is bumped to `spawnTs + 1s` so it
 *  appears as the "latest after spawn" candidate. */
function makeProjectLayout(opts: {
  encodedCwd: string;
  sessionId: string;
  parentEntries: object[];
  subagent?: {
    agentId: string;
    agentType: string;
    entries: object[];
    /** ms since epoch — defaults to now() */
    mtimeMs?: number;
  };
}): { parentPath: string; subagentPath: string | null } {
  const projectsRoot = join(bindingsDir, ".claude", "projects", opts.encodedCwd);
  mkdirSync(projectsRoot, { recursive: true });
  const parentPath = join(projectsRoot, `${opts.sessionId}.jsonl`);
  writeFileSync(
    parentPath,
    opts.parentEntries.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
  let subagentPath: string | null = null;
  if (opts.subagent) {
    const subDir = join(projectsRoot, opts.sessionId, "subagents");
    mkdirSync(subDir, { recursive: true });
    subagentPath = join(subDir, `agent-${opts.subagent.agentId}.jsonl`);
    writeFileSync(
      subagentPath,
      opts.subagent.entries.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf-8",
    );
    writeFileSync(
      subagentPath.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({ agentType: opts.subagent.agentType, description: "test" }),
      "utf-8",
    );
    if (opts.subagent.mtimeMs !== undefined) {
      const mtime = new Date(opts.subagent.mtimeMs);
      utimesSync(subagentPath, mtime, mtime);
    }
  }
  return { parentPath, subagentPath };
}

function userEntry(uuid: string, ts: string, text = "hi"): object {
  return {
    type: "user",
    uuid,
    timestamp: ts,
    sessionId: "test-session",
    message: { role: "user", content: text },
  };
}

function assistantToolUse(uuid: string, ts: string, toolUseId: string, subagentType: string): object {
  return {
    type: "assistant",
    uuid,
    timestamp: ts,
    sessionId: "test-session",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "spawning subagent" },
        {
          type: "tool_use",
          id: toolUseId,
          name: "Agent",
          input: {
            subagent_type: subagentType,
            prompt: "do the thing",
          },
        },
      ],
    },
  };
}

function assistantText(uuid: string, ts: string, text: string): object {
  return {
    type: "assistant",
    uuid,
    timestamp: ts,
    sessionId: "child-session",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function appendBinding(b: MirrorBindingRecord): void {
  mkdirSync(dirname(bindingsPath), { recursive: true });
  appendFileSync(bindingsPath, JSON.stringify(b) + "\n", "utf-8");
}

// Spawn timestamps in these tests must be close to real wall-clock time
// because findSubagentTranscript now gates by birthtime (file creation
// time), and the test fixture creates files at "now" — there is no
// cross-platform way to backdate birthtime from Node. Using real-time
// timestamps keeps the gate honest.
function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe("findSubagentTranscript", () => {
  test("matches agent-<id>.jsonl by meta.agentType and recent mtime", () => {
    const spawnTs = nowIso(-1000);
    const { parentPath, subagentPath } = makeProjectLayout({
      encodedCwd: "C--Projects-AI-some-proj",
      sessionId: "sess-1",
      parentEntries: [userEntry("u1", spawnTs)],
      subagent: {
        agentId: "abc123",
        agentType: "pipeline-executor",
        entries: [userEntry("c1", nowIso())],
      },
    });
    const found = findSubagentTranscript(
      parentPath,
      spawnTs,
      "pipeline-executor",
    );
    expect(found).toBe(subagentPath!);
  });

  test("returns null when subagent dir does not exist", () => {
    const { parentPath } = makeProjectLayout({
      encodedCwd: "C--Projects-no-subagents",
      sessionId: "sess-x",
      parentEntries: [userEntry("u1", nowIso(-1000))],
    });
    expect(
      findSubagentTranscript(parentPath, nowIso(), "pipeline-executor"),
    ).toBeNull();
  });

  test("ignores subagents whose agentType does not match", () => {
    const { parentPath } = makeProjectLayout({
      encodedCwd: "C--Projects-mismatch",
      sessionId: "sess-y",
      parentEntries: [userEntry("u1", nowIso(-1000))],
      subagent: {
        agentId: "def456",
        agentType: "general-purpose", // wrong type
        entries: [userEntry("c1", nowIso())],
      },
    });
    expect(
      findSubagentTranscript(parentPath, nowIso(-1000), "pipeline-executor"),
    ).toBeNull();
  });

  test("plugin-namespaced spawn type (pipeline:pipeline-executor) matches bare meta.agentType", () => {
    const { parentPath, subagentPath } = makeProjectLayout({
      encodedCwd: "C--Projects-namespaced",
      sessionId: "sess-z",
      parentEntries: [userEntry("u1", nowIso(-1000))],
      subagent: {
        agentId: "ghi789",
        agentType: "pipeline-executor",
        entries: [userEntry("c1", nowIso())],
      },
    });
    const found = findSubagentTranscript(
      parentPath,
      nowIso(-1000),
      "pipeline:pipeline-executor",
    );
    expect(found).toBe(subagentPath!);
  });
});

describe("MirrorService: subagent chasing", () => {
  test("parent assistant tool_use for pipeline-executor binds the subagent transcript under same run_id", () => {
    const tParentUser = nowIso(-3000);
    const tParentSpawn = nowIso(-2000);
    const tChild1 = nowIso(-1000);
    const tChild2 = nowIso();
    const { parentPath, subagentPath } = makeProjectLayout({
      encodedCwd: "C--Projects-chase-it",
      sessionId: "sess-chase",
      parentEntries: [
        userEntry("p-user", tParentUser, "do something"),
        assistantToolUse("p-asst", tParentSpawn, "toolu_spawn_x", "pipeline-executor"),
      ],
      subagent: {
        agentId: "child001",
        agentType: "pipeline-executor",
        entries: [
          userEntry("c-user-1", tChild1, "kick off iteration"),
          assistantText("c-asst-1", tChild2, "iteration result"),
        ],
      },
    });
    appendBinding({
      event: "bound",
      tool_use_id: "toolu_parent",
      run_id: "run-chase",
      session_id: "sess-chase",
      transcript_path: parentPath,
      project_root: projectRoot,
      worktree: null,
      pipeline_name: "demo",
      iteration_path: join(projectRoot, ".claude", "pipeline", "demo", "steps", "01.md"),
      start_ts: nowIso(-5000),
      kind: "chain-controller",
      schema: 1,
    });
    const svc = new MirrorService({ bindingsPath, appendChat });
    svc.start();
    svc.tickForTest();
    svc.tickForTest(); // second tick so the chased subagent's lines get drained
    svc.stop();

    const uuids = captured.map((c) => c.uuid);
    expect(uuids).toContain("p-user");
    expect(uuids).toContain("p-asst");
    expect(uuids).toContain("c-user-1");
    expect(uuids).toContain("c-asst-1");

    // All emitted messages share the parent run_id.
    for (const c of captured) expect(c.runId).toBe("run-chase");

    // The subagent transcript appears in the service's active binding keys.
    const keys = svc.activeBindingKeys();
    const hasSubagentKey = keys.some((k) => k.startsWith("subagent:run-chase:"));
    expect(hasSubagentKey).toBe(true);
    // sanity: the subagent path was found by the locator.
    expect(subagentPath).not.toBeNull();
  });

  test("non-pipeline-executor subagent spawn (general-purpose) is still mirrored if discoverable", () => {
    // Phase 1.4 spec doesn't restrict to pipeline-executor only — once
    // a binding exists, ANY further Agent/Task spawn inside its
    // transcript is followed. This is the right behavior: a
    // pipeline-executor that internally spawns a general-purpose
    // researcher subagent should also appear in the chat panel.
    const { parentPath } = makeProjectLayout({
      encodedCwd: "C--Projects-inner-spawn",
      sessionId: "sess-inner",
      parentEntries: [
        userEntry("p-user", nowIso(-3000)),
        assistantToolUse("p-asst", nowIso(-2000), "toolu_inner", "general-purpose"),
      ],
      subagent: {
        agentId: "inner001",
        agentType: "general-purpose",
        entries: [assistantText("c-asst-1", nowIso(), "inner work done")],
      },
    });
    appendBinding({
      event: "bound",
      tool_use_id: "toolu_parent",
      run_id: "run-inner",
      session_id: "sess-inner",
      transcript_path: parentPath,
      project_root: projectRoot,
      worktree: null,
      pipeline_name: "demo",
      iteration_path: join(projectRoot, ".claude", "pipeline", "demo", "steps", "01.md"),
      start_ts: nowIso(-5000),
      kind: "chain-controller",
      schema: 1,
    });
    const svc = new MirrorService({ bindingsPath, appendChat });
    svc.start();
    svc.tickForTest();
    svc.tickForTest();
    svc.stop();

    const uuids = captured.map((c) => c.uuid);
    expect(uuids).toContain("c-asst-1");
  });

  test("missing subagent file does not crash the service", () => {
    const { parentPath } = makeProjectLayout({
      encodedCwd: "C--Projects-no-child",
      sessionId: "sess-nochild",
      parentEntries: [
        userEntry("p-user", nowIso(-2000)),
        assistantToolUse("p-asst", nowIso(-1000), "toolu_x", "pipeline-executor"),
      ],
    });
    appendBinding({
      event: "bound",
      tool_use_id: "toolu_parent",
      run_id: "run-nochild",
      session_id: "sess-nochild",
      transcript_path: parentPath,
      project_root: projectRoot,
      worktree: null,
      pipeline_name: "demo",
      iteration_path: join(projectRoot, ".claude", "pipeline", "demo", "steps", "01.md"),
      start_ts: nowIso(-5000),
      kind: "chain-controller",
      schema: 1,
    });
    const svc = new MirrorService({ bindingsPath, appendChat });
    svc.start();
    svc.tickForTest();
    svc.stop();
    // Parent messages emitted; no subagent — but service still alive.
    const uuids = captured.map((c) => c.uuid);
    expect(uuids).toContain("p-user");
    expect(uuids).toContain("p-asst");
  });
});
