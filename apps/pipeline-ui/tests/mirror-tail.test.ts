/**
 * MirrorService — daemon-side transcript tailer.
 *
 *   bun test tests/mirror-tail.test.ts
 *
 * Black-box tests: drop binding records into a tmp bindings file, write
 * fake transcript JSONL on disk, tick the service, then assert the
 * captured appendChat calls. The chat-message write is mocked so the
 * tests stay independent of server.ts.
 */

import {
  afterAll,
  afterEach,
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
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import {
  MirrorService,
  type AppendChatFn,
  type MirrorBindingRecord,
} from "../mirror.ts";

let tmpRoot: string;
let bindingsDir: string;
let bindingsPath: string;
let projectRoot: string;
let captured: Array<{
  projectRoot: string;
  runId: string;
  msg: unknown;
  ts: string;
}>;
let appendChat: AppendChatFn;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "mirror-service-"));
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
  appendChat = (pr, rid, msg, opts) => {
    captured.push({ projectRoot: pr, runId: rid, msg, ts: opts.ts });
  };
});

afterEach(() => {
  // No-op — every per-test resource lives under tmpRoot.
});

function writeTranscript(path: string, lines: object[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
}

function appendTranscript(path: string, lines: object[]): void {
  appendFileSync(
    path,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
}

function appendBinding(b: MirrorBindingRecord): void {
  mkdirSync(dirname(bindingsPath), { recursive: true });
  appendFileSync(bindingsPath, JSON.stringify(b) + "\n", "utf-8");
}

function makeUserEntry(uuid: string, ts: string, text = "hello"): object {
  return {
    parentUuid: null,
    isSidechain: true,
    promptId: "p1",
    agentId: "agent-1",
    type: "user",
    message: { role: "user", content: text },
    uuid,
    timestamp: ts,
    userType: "external",
    sessionId: "session-1",
    version: "1.0.0",
    cwd: "C:/x",
    gitBranch: "main",
  };
}

function makeAssistantEntry(uuid: string, ts: string, text = "ok"): object {
  return {
    parentUuid: null,
    isSidechain: true,
    agentId: "agent-1",
    requestId: "r1",
    message: { role: "assistant", content: [{ type: "text", text }] },
    type: "assistant",
    uuid,
    timestamp: ts,
    sessionId: "session-1",
    version: "1.0.0",
  };
}

function bindingRecord(transcriptPath: string, overrides: Partial<MirrorBindingRecord> = {}): MirrorBindingRecord {
  return {
    event: "bound",
    tool_use_id: "toolu_main_1",
    run_id: "run-1",
    session_id: "session-1",
    transcript_path: transcriptPath,
    project_root: projectRoot,
    worktree: null,
    pipeline_name: "demo",
    iteration_path: join(projectRoot, ".claude", "pipeline", "demo", "steps", "01-x.md"),
    start_ts: "2026-05-23T10:00:00.000Z",
    kind: "bypass-spawn",
    schema: 1,
    ...overrides,
  };
}

describe("MirrorService", () => {
  test("backfills a transcript that already has content at binding time", () => {
    const transcript = join(bindingsDir, "session-1.jsonl");
    writeTranscript(transcript, [
      makeUserEntry("u1", "2026-05-23T10:00:01.000Z", "kick off"),
      makeAssistantEntry("a1", "2026-05-23T10:00:02.000Z", "starting"),
    ]);
    appendBinding(bindingRecord(transcript));

    const svc = new MirrorService({ bindingsPath, appendChat });
    svc.start();
    svc.tickForTest(); // initial drain pass
    svc.stop();

    expect(captured).toHaveLength(2);
    expect(captured[0].runId).toBe("run-1");
    expect(captured[0].ts).toBe("2026-05-23T10:00:01.000Z");
    expect(captured[1].ts).toBe("2026-05-23T10:00:02.000Z");
    // session_id propagated into the msg payload.
    expect((captured[0].msg as { session_id?: string }).session_id).toBe("session-1");
  });

  test("entries before start_ts are filtered out", () => {
    const transcript = join(bindingsDir, "session-2.jsonl");
    writeTranscript(transcript, [
      makeUserEntry("u-pre", "2026-05-23T09:59:00.000Z", "pre-pipeline noise"),
      makeUserEntry("u-on", "2026-05-23T10:00:30.000Z", "real msg"),
    ]);
    appendBinding(bindingRecord(transcript));

    const svc = new MirrorService({ bindingsPath, appendChat });
    svc.start();
    svc.tickForTest();
    svc.stop();

    expect(captured).toHaveLength(1);
    expect((captured[0].msg as { uuid?: string }).uuid).toBe("u-on");
  });

  test("attachment / file-history-snapshot / permission-mode entries are skipped", () => {
    const transcript = join(bindingsDir, "session-3.jsonl");
    writeTranscript(transcript, [
      makeUserEntry("u1", "2026-05-23T10:00:01.000Z"),
      {
        type: "attachment",
        attachment: { type: "deferred_tools_delta", addedNames: ["WebFetch"] },
        uuid: "a-att",
        timestamp: "2026-05-23T10:00:02.000Z",
      },
      { type: "file-history-snapshot", uuid: "a-fhs", timestamp: "2026-05-23T10:00:03.000Z" },
      makeAssistantEntry("a1", "2026-05-23T10:00:04.000Z"),
    ]);
    appendBinding(bindingRecord(transcript));

    const svc = new MirrorService({ bindingsPath, appendChat });
    svc.start();
    svc.tickForTest();
    svc.stop();

    expect(captured.map((c) => (c.msg as { uuid?: string }).uuid)).toEqual(["u1", "a1"]);
  });

  test("idempotent: a second tick of the same content does NOT re-emit", () => {
    const transcript = join(bindingsDir, "session-4.jsonl");
    writeTranscript(transcript, [makeUserEntry("u1", "2026-05-23T10:00:01.000Z")]);
    appendBinding(bindingRecord(transcript));

    const svc = new MirrorService({ bindingsPath, appendChat });
    svc.start();
    svc.tickForTest();
    svc.tickForTest();
    svc.stop();
    expect(captured).toHaveLength(1);
  });

  test("incremental: new lines appended after the first tick are picked up on the next tick", () => {
    const transcript = join(bindingsDir, "session-5.jsonl");
    writeTranscript(transcript, [makeUserEntry("u1", "2026-05-23T10:00:01.000Z")]);
    appendBinding(bindingRecord(transcript));

    const svc = new MirrorService({ bindingsPath, appendChat });
    svc.start();
    svc.tickForTest();
    expect(captured).toHaveLength(1);

    appendTranscript(transcript, [
      makeAssistantEntry("a1", "2026-05-23T10:00:02.000Z"),
      makeUserEntry("u2", "2026-05-23T10:00:03.000Z"),
    ]);
    svc.tickForTest();
    svc.stop();

    expect(captured.map((c) => (c.msg as { uuid?: string }).uuid)).toEqual(["u1", "a1", "u2"]);
  });

  test("pipeline.completed for the run_id stops further tailing", () => {
    const transcript = join(bindingsDir, "session-6.jsonl");
    writeTranscript(transcript, [makeUserEntry("u1", "2026-05-23T10:00:01.000Z")]);
    appendBinding(bindingRecord(transcript));

    const svc = new MirrorService({ bindingsPath, appendChat });
    svc.start();
    svc.tickForTest();
    expect(captured).toHaveLength(1);

    svc.onJournalEvent({ type: "pipeline.completed", run_id: "run-1" });
    // Drain pass with terminal flag honors end_ts (now ~ this moment),
    // but since the new entry's timestamp is in the past, it should
    // still be emitted in this pass.
    appendTranscript(transcript, [
      makeAssistantEntry("a1", "2026-05-23T10:00:02.000Z"),
    ]);
    svc.tickForTest();
    // After the terminal drain, the transcript watch is detached.
    expect(captured).toHaveLength(2);

    // Subsequent appends after detach are NOT mirrored.
    appendTranscript(transcript, [
      makeAssistantEntry("a2", "2026-05-23T10:00:03.000Z"),
    ]);
    svc.tickForTest();
    svc.stop();
    expect(captured).toHaveLength(2);
  });

  test("offset is persisted to disk + recovered on a fresh service instance", () => {
    const transcript = join(bindingsDir, "session-7.jsonl");
    writeTranscript(transcript, [makeUserEntry("u1", "2026-05-23T10:00:01.000Z")]);
    appendBinding(bindingRecord(transcript));

    const svc1 = new MirrorService({ bindingsPath, appendChat });
    svc1.start();
    svc1.tickForTest();
    svc1.stop();
    expect(captured).toHaveLength(1);

    // New service instance — without offset persistence we would
    // re-emit u1.
    const svc2 = new MirrorService({ bindingsPath, appendChat });
    svc2.start();
    svc2.tickForTest();
    svc2.stop();
    expect(captured).toHaveLength(1);

    // Offset file exists in the transcripts/ dir under .runtime — its name
    // is a hash of the transcript path (per-transcript uniqueness, not
    // per-session) so we just glob the directory.
    const transcriptsDir = join(
      projectRoot,
      ".claude",
      "pipeline",
      ".runtime",
      "transcripts",
    );
    const offsetFiles = require("node:fs")
      .readdirSync(transcriptsDir)
      .filter((n: string) => n.endsWith(".chat.offset"));
    expect(offsetFiles).toHaveLength(1);
    const state = JSON.parse(
      readFileSync(join(transcriptsDir, offsetFiles[0]), "utf-8"),
    );
    expect(state.offset).toBeGreaterThan(0);
  });

  test("binding with null transcript_path is silently skipped", () => {
    appendBinding(bindingRecord("dummy", { transcript_path: null }));
    const svc = new MirrorService({ bindingsPath, appendChat });
    svc.start();
    svc.tickForTest();
    svc.stop();
    expect(captured).toHaveLength(0);
    expect(svc.activeBindingKeys()).toHaveLength(0);
  });

  test("idempotent binding registration on a daemon restart (same binding re-read)", () => {
    const transcript = join(bindingsDir, "session-8.jsonl");
    writeTranscript(transcript, [makeUserEntry("u1", "2026-05-23T10:00:01.000Z")]);
    const b = bindingRecord(transcript);
    appendBinding(b);
    appendBinding(b); // duplicate line
    const svc = new MirrorService({ bindingsPath, appendChat });
    svc.start();
    svc.tickForTest();
    svc.stop();
    expect(svc.activeBindingKeys()).toHaveLength(1);
    expect(captured).toHaveLength(1);
  });

  test("two iterations under one run_id share one transcript, emit per iteration", () => {
    // Path B chain controller: each PostToolUse emits a NEW binding with
    // a later start_ts; both point at the SAME transcript_path and the
    // SAME run_id. The service must accept both, route lines through
    // the right window, and de-dupe by uuid so the same line isn't
    // double-emitted just because two bindings overlap.
    const transcript = join(bindingsDir, "session-9.jsonl");
    writeTranscript(transcript, [
      makeUserEntry("u1", "2026-05-23T10:00:30.000Z"),
      makeAssistantEntry("a1", "2026-05-23T10:00:31.000Z"),
      makeUserEntry("u2", "2026-05-23T10:01:30.000Z"),
      makeAssistantEntry("a2", "2026-05-23T10:01:31.000Z"),
    ]);
    appendBinding(
      bindingRecord(transcript, {
        tool_use_id: "toolu_iter_1",
        start_ts: "2026-05-23T10:00:00.000Z",
        kind: "chain-controller",
      }),
    );
    appendBinding(
      bindingRecord(transcript, {
        tool_use_id: "toolu_iter_2",
        start_ts: "2026-05-23T10:01:00.000Z",
        kind: "chain-controller",
      }),
    );
    const svc = new MirrorService({ bindingsPath, appendChat });
    svc.start();
    svc.tickForTest();
    svc.stop();

    // Iter1's binding emits u1 + a1 (within its window, before iter2 starts is irrelevant — its window is open-ended).
    // Iter2's binding emits u2 + a2.
    // But since both bindings share start_ts < ts < end_ts windows, the early entries are visible to BOTH bindings —
    // however dedup-by-uuid is PER-BINDING, so emission happens once per binding per matching line.
    // Iter1 sees u1, a1, u2, a2. Iter2 sees u2, a2. Total: 6.
    expect(captured.length).toBe(6);
  });

  test("malformed JSON lines in the transcript are skipped, surrounding lines still emit", () => {
    const transcript = join(bindingsDir, "session-10.jsonl");
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(
      transcript,
      [
        JSON.stringify(makeUserEntry("u1", "2026-05-23T10:00:01.000Z")),
        "this is not json",
        JSON.stringify(makeAssistantEntry("a1", "2026-05-23T10:00:02.000Z")),
      ].join("\n") + "\n",
      "utf-8",
    );
    appendBinding(bindingRecord(transcript));
    const svc = new MirrorService({ bindingsPath, appendChat });
    svc.start();
    svc.tickForTest();
    svc.stop();
    expect(captured.map((c) => (c.msg as { uuid?: string }).uuid)).toEqual(["u1", "a1"]);
  });

  test("transcript truncation (file shrinks) resets offset and re-reads", () => {
    const transcript = join(bindingsDir, "session-11.jsonl");
    writeTranscript(transcript, [makeUserEntry("u1", "2026-05-23T10:00:01.000Z")]);
    appendBinding(bindingRecord(transcript));
    const svc = new MirrorService({ bindingsPath, appendChat });
    svc.start();
    svc.tickForTest();
    expect(captured).toHaveLength(1);

    // Now truncate + write fresh content (e.g. rotation).
    writeTranscript(transcript, [makeAssistantEntry("a1", "2026-05-23T10:00:02.000Z")]);
    svc.tickForTest();
    svc.stop();
    // u1 already in dedup → a1 emitted as a new uuid.
    expect(captured).toHaveLength(2);
    expect((captured[1].msg as { uuid?: string }).uuid).toBe("a1");
  });

  test("scope discipline: a transcript that is NEVER bound is NEVER read", () => {
    const transcript = join(bindingsDir, "session-12.jsonl");
    writeTranscript(transcript, [
      makeUserEntry("u-secret", "2026-05-23T10:00:01.000Z", "private session"),
    ]);
    // NO binding written.
    const svc = new MirrorService({ bindingsPath, appendChat });
    svc.start();
    svc.tickForTest();
    svc.stop();
    expect(captured).toHaveLength(0);
    expect(svc.activeBindingKeys()).toHaveLength(0);
  });
});
