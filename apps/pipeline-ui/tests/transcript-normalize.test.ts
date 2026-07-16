/**
 * Tests for apps/pipeline-ui/transcript-normalize.ts.
 *
 *   bun test tests/transcript-normalize.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  normalizeTranscriptEntry,
  normalizeTranscriptText,
} from "../transcript-normalize.ts";

const T0 = "2026-05-23T10:00:00.000Z";
const T1 = "2026-05-23T10:00:01.000Z";
const T2 = "2026-05-23T10:00:02.000Z";

function userEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    parentUuid: "p-1",
    isSidechain: true,
    promptId: "prompt-1",
    agentId: "agent-a",
    type: "user",
    message: { role: "user", content: "hello world" },
    uuid: "uuid-user-1",
    timestamp: T0,
    userType: "external",
    entrypoint: "cli",
    cwd: "C:/some/where",
    sessionId: "sess-1",
    version: "1.0.0",
    gitBranch: "main",
    ...overrides,
  };
}

function assistantEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    parentUuid: "p-2",
    isSidechain: true,
    agentId: "agent-a",
    requestId: "req-1",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I will do the thing." },
        { type: "tool_use", id: "toolu_x", name: "Bash", input: { command: "ls" } },
      ],
    },
    type: "assistant",
    uuid: "uuid-assistant-1",
    timestamp: T1,
    userType: "external",
    entrypoint: "cli",
    cwd: "C:/some/where",
    sessionId: "sess-1",
    version: "1.0.0",
    gitBranch: "main",
    ...overrides,
  };
}

describe("normalizeTranscriptEntry", () => {
  test("user message: passthrough with strip of CC-internal fields", () => {
    const n = normalizeTranscriptEntry(userEntry());
    expect(n).not.toBeNull();
    expect(n!.uuid).toBe("uuid-user-1");
    expect(n!.ts).toBe(T0);
    const msg = n!.msg;
    expect(msg.type).toBe("user");
    expect(msg.message).toEqual({ role: "user", content: "hello world" });
    expect(msg.session_id).toBe("sess-1");
    // Stripped fields are absent.
    expect("parentUuid" in msg).toBe(false);
    expect("isSidechain" in msg).toBe(false);
    expect("agentId" in msg).toBe(false);
    expect("promptId" in msg).toBe(false);
    expect("cwd" in msg).toBe(false);
    expect("gitBranch" in msg).toBe(false);
    expect("version" in msg).toBe(false);
    expect("entrypoint" in msg).toBe(false);
    expect("userType" in msg).toBe(false);
  });

  test("assistant message with tool_use content survives intact", () => {
    const n = normalizeTranscriptEntry(assistantEntry());
    expect(n).not.toBeNull();
    const msg = n!.msg as { message?: { content?: unknown[] } };
    expect(msg.message?.content).toHaveLength(2);
    expect((msg.message!.content![1] as { type: string }).type).toBe("tool_use");
  });

  test("attachment entries are skipped", () => {
    const entry = {
      type: "attachment",
      attachment: { type: "deferred_tools_delta", addedNames: ["WebFetch"] },
      uuid: "u-att",
      timestamp: T0,
    };
    expect(normalizeTranscriptEntry(entry)).toBeNull();
  });

  test("file-history-snapshot, permission-mode, summary are skipped", () => {
    for (const type of ["file-history-snapshot", "permission-mode", "summary"]) {
      const entry = { type, uuid: `u-${type}`, timestamp: T0 };
      expect(normalizeTranscriptEntry(entry)).toBeNull();
    }
  });

  test("unknown top-level type is skipped", () => {
    expect(normalizeTranscriptEntry({ type: "weird-future-type", timestamp: T0 })).toBeNull();
  });

  test("missing type → skipped", () => {
    expect(normalizeTranscriptEntry({ timestamp: T0 })).toBeNull();
  });

  test("non-object input → skipped", () => {
    expect(normalizeTranscriptEntry(null)).toBeNull();
    expect(normalizeTranscriptEntry(42)).toBeNull();
    expect(normalizeTranscriptEntry("hello")).toBeNull();
  });

  test("entry strictly before startTs is skipped", () => {
    const entry = userEntry({ timestamp: T0 });
    expect(normalizeTranscriptEntry(entry, { startTs: T1 })).toBeNull();
    expect(normalizeTranscriptEntry(entry, { startTs: T0 })).not.toBeNull();
  });

  test("entry strictly after endTs is skipped", () => {
    const entry = userEntry({ timestamp: T2 });
    expect(normalizeTranscriptEntry(entry, { endTs: T1 })).toBeNull();
    expect(normalizeTranscriptEntry(entry, { endTs: T2 })).not.toBeNull();
  });

  test("non-parseable entry timestamp → skipped when a startTs gate is active (scope safety)", () => {
    // Garbage timestamps must NOT bypass the start_ts window — otherwise
    // a CC sentinel like `timestamp: "pending"` could leak historical
    // entries into the current run's chat panel.
    const entry = userEntry({ timestamp: "not-a-date" });
    expect(normalizeTranscriptEntry(entry, { startTs: T1 })).toBeNull();
    // But with NO startTs gate, the entry is still mirrored (the ts
    // field is populated via the now() fallback elsewhere).
    expect(normalizeTranscriptEntry(entry, {})).not.toBeNull();
  });

  test("user message with only an empty tool_result block is skipped", () => {
    const entry = userEntry({
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "" }],
      },
    });
    expect(normalizeTranscriptEntry(entry)).toBeNull();
  });

  test("user message with a non-empty tool_result block is kept", () => {
    const entry = userEntry({
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "some output" }],
      },
    });
    expect(normalizeTranscriptEntry(entry)).not.toBeNull();
  });

  test("entry without uuid → uuid field is null", () => {
    const entry = userEntry();
    delete (entry as { uuid?: unknown }).uuid;
    const n = normalizeTranscriptEntry(entry);
    expect(n).not.toBeNull();
    expect(n!.uuid).toBeNull();
  });

  test("entry without timestamp gets a now() fallback", () => {
    const entry = userEntry();
    delete (entry as { timestamp?: unknown }).timestamp;
    const n = normalizeTranscriptEntry(entry);
    expect(n).not.toBeNull();
    expect(Number.isFinite(Date.parse(n!.ts))).toBe(true);
  });
});

describe("normalizeTranscriptText (generator)", () => {
  test("processes multi-line JSONL, skips blank lines and malformed JSON", () => {
    const lines = [
      JSON.stringify(userEntry({ uuid: "u-1" })),
      "",
      "not-json-at-all",
      JSON.stringify(assistantEntry({ uuid: "u-2" })),
      JSON.stringify({ type: "attachment", uuid: "u-3", timestamp: T2 }),
    ].join("\n");
    const out = Array.from(normalizeTranscriptText(lines));
    expect(out.map((m) => m.uuid)).toEqual(["u-1", "u-2"]);
  });

  test("respects the startTs window across multiple entries", () => {
    const lines = [
      JSON.stringify(userEntry({ uuid: "u-pre", timestamp: T0 })),
      JSON.stringify(assistantEntry({ uuid: "u-on", timestamp: T1 })),
      JSON.stringify(userEntry({ uuid: "u-post", timestamp: T2 })),
    ].join("\n");
    const out = Array.from(normalizeTranscriptText(lines, { startTs: T1 }));
    expect(out.map((m) => m.uuid)).toEqual(["u-on", "u-post"]);
  });
});
