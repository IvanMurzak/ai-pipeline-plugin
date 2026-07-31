/**
 * Bindings-journal compaction — mirror.ts.
 *
 *   bun test tests/bindings-compaction.test.ts
 *
 * Regression: ~/.claude/pipeline-ui/active-mirror-bindings.jsonl is appended to
 * by the PostToolUse hook once per bound tool call, machine-wide, and nothing
 * ever trimmed it. On a working machine it had reached 6.5 MB / 11,755 lines,
 * and server.ts re-parses the whole file whenever it is asked about a run it
 * has not indexed yet.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { BINDINGS_MAX_LINES, MirrorService, compactBindingsFile } from "../mirror.ts";

let tmpRoot: string;
let dir: string;
let bindingsPath: string;
let projectRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "cc-bindings-compact-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpRoot, "case-"));
  bindingsPath = join(dir, "active-mirror-bindings.jsonl");
  projectRoot = mkdtempSync(join(tmpRoot, "proj-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function record(n: number, transcriptPath = join(dir, `t-${n}.jsonl`)): string {
  return JSON.stringify({
    event: "bound",
    tool_use_id: `toolu_${n}`,
    run_id: `run-${n}`,
    session_id: `session-${n}`,
    transcript_path: transcriptPath,
    project_root: projectRoot,
    worktree: null,
    pipeline_name: "demo",
    iteration_path: join(projectRoot, ".claude", "pipeline", "demo", "steps", "01-x.md"),
    start_ts: "2026-05-23T10:00:00.000Z",
    kind: "bypass-spawn",
    schema: 1,
  });
}

function writeRecords(count: number): void {
  const lines = Array.from({ length: count }, (_, i) => record(i));
  writeFileSync(bindingsPath, `${lines.join("\n")}\n`, "utf-8");
}

function lineCount(path: string): number {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0).length;
}

describe("compactBindingsFile", () => {
  test("trims to the newest maxLines records, keeping order", () => {
    writeRecords(50);

    expect(compactBindingsFile(bindingsPath, 10)).toBe(40);

    expect(lineCount(bindingsPath)).toBe(10);
    const kept = readFileSync(bindingsPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    // Newest kept, oldest dropped, order preserved.
    expect(kept[0].run_id).toBe("run-40");
    expect(kept.at(-1)!.run_id).toBe("run-49");
  });

  test("leaves a file under the ceiling byte-identical", () => {
    writeRecords(5);
    const before = readFileSync(bindingsPath, "utf-8");

    expect(compactBindingsFile(bindingsPath, 10)).toBe(0);
    expect(readFileSync(bindingsPath, "utf-8")).toBe(before);
  });

  test("is a no-op when the journal does not exist yet", () => {
    expect(compactBindingsFile(join(dir, "nope.jsonl"), 10)).toBe(0);
  });

  test("leaves no temp file behind", () => {
    writeRecords(30);
    compactBindingsFile(bindingsPath, 5);

    const strays = readFileSync(bindingsPath, "utf-8");
    expect(strays.length).toBeGreaterThan(0);
    expect(existsSync(`${bindingsPath}.compact-${process.pid}.tmp`)).toBe(false);
  });

  test("ships a sane default ceiling", () => {
    expect(BINDINGS_MAX_LINES).toBeGreaterThan(0);
    expect(BINDINGS_MAX_LINES).toBeLessThan(11_755);
  });
});

describe("MirrorService.compactBindings", () => {
  // The tailer tracks a byte offset into the bindings file. Shrinking the file
  // under it looks exactly like a rotation, so without the offset resync the
  // next tick re-ingests every surviving record and re-emits chat messages the
  // UI has already shown.
  test("does not make the tailer re-emit messages it already mirrored", () => {
    const transcript = join(dir, "session-live.jsonl");
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(
      transcript,
      `${JSON.stringify({
        parentUuid: null,
        isSidechain: true,
        type: "user",
        message: { role: "user", content: "hello" },
        uuid: "u-1",
        timestamp: "2026-05-23T10:00:01.000Z",
        userType: "external",
        sessionId: "session-live",
        version: "1.0.0",
        cwd: projectRoot,
      })}\n`,
      "utf-8",
    );

    const live = JSON.parse(record(999, transcript));
    live.session_id = "session-live";
    writeFileSync(bindingsPath, `${JSON.stringify(live)}\n`, "utf-8");

    const captured: unknown[] = [];
    const svc = new MirrorService({
      bindingsPath,
      enabled: true,
      appendChat: (_root, _runId, msg) => {
        captured.push(msg);
      },
    });
    svc.start();
    svc.tickForTest();
    const afterFirstDrain = captured.length;
    expect(afterFirstDrain).toBeGreaterThan(0);

    // Grow the journal past the ceiling, then compact it back down.
    const padding = Array.from({ length: 60 }, (_, i) => record(i)).join("\n");
    writeFileSync(bindingsPath, `${JSON.stringify(live)}\n${padding}\n`, "utf-8");
    expect(svc.compactBindings(10)).toBeGreaterThan(0);

    svc.tickForTest();
    svc.stop();

    expect(captured.length).toBe(afterFirstDrain);
  });
});
