/**
 * detectPendingInterrupt — apps/pipeline-ui/transcript-stats.ts (design 06).
 *
 *   bun test tests/interrupt-detect.test.ts
 *
 * An Esc-interrupt fires no hook, so the transcript is the only evidence that a
 * run was abandoned. The probe must be certain: a FALSE positive retires a run
 * that is still working, which is worse than missing one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectPendingInterrupt } from "../transcript-stats.ts";

let tmpRoot: string;
let seq = 0;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-interrupt-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const T = (min: number) => `2026-07-22T12:${String(min).padStart(2, "0")}:00.000Z`;

const assistant = (ts: string) =>
  JSON.stringify({ timestamp: ts, type: "assistant", message: { role: "assistant", content: [] } });
const toolResult = (ts: string) =>
  JSON.stringify({
    timestamp: ts,
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  });
const interruptText = (ts: string) =>
  JSON.stringify({
    timestamp: ts,
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
  });
const interruptField = (ts: string) =>
  JSON.stringify({ timestamp: ts, type: "user", interruptedMessageId: "msg_123", message: { role: "user", content: [] } });
const userPrompt = (ts: string, text: string) =>
  JSON.stringify({ timestamp: ts, type: "user", message: { role: "user", content: [{ type: "text", text }] } });

/** Write a transcript file and return its path. */
function transcript(lines: string[]): string {
  const p = join(tmpRoot, `t-${seq++}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n", "utf-8");
  return p;
}

describe("detectPendingInterrupt", () => {
  test("marker text after activity ⇒ pending, and reports the interrupt's own timestamp", () => {
    const p = transcript([assistant(T(0)), interruptText(T(5))]);
    expect(detectPendingInterrupt(p, T(0))).toEqual({ interrupted: true, interrupt_ts: T(5) });
  });

  test("the structured `interruptedMessageId` alone is enough (format-drift tolerance)", () => {
    const p = transcript([assistant(T(0)), interruptField(T(5))]);
    expect(detectPendingInterrupt(p, T(0)).interrupted).toBe(true);
  });

  test("a string-valued content carrying the marker also counts", () => {
    const p = transcript([
      assistant(T(0)),
      JSON.stringify({ timestamp: T(5), type: "user", message: { role: "user", content: "[Request interrupted by user]" } }),
    ]);
    expect(detectPendingInterrupt(p, T(0)).interrupted).toBe(true);
  });

  test("activity AFTER the interrupt ⇒ NOT pending (the session was resumed)", () => {
    const p = transcript([assistant(T(0)), interruptText(T(5)), userPrompt(T(6), "keep going"), assistant(T(7))]);
    expect(detectPendingInterrupt(p, T(0))).toEqual({ interrupted: false, interrupt_ts: null });
  });

  test("a tool_result after the interrupt also counts as resumed activity", () => {
    const p = transcript([assistant(T(0)), interruptText(T(5)), toolResult(T(6))]);
    expect(detectPendingInterrupt(p, T(0)).interrupted).toBe(false);
  });

  test("tie timestamps ⇒ pending (the >= rule: an Esc cutting off that very turn)", () => {
    const p = transcript([assistant(T(5)), interruptText(T(5))]);
    expect(detectPendingInterrupt(p, T(0)).interrupted).toBe(true);
  });

  test("interrupt with no activity at all ⇒ pending", () => {
    const p = transcript([interruptText(T(5))]);
    expect(detectPendingInterrupt(p, T(0)).interrupted).toBe(true);
  });

  test("no interrupt ⇒ not pending", () => {
    const p = transcript([assistant(T(0)), toolResult(T(1)), assistant(T(2))]);
    expect(detectPendingInterrupt(p, T(0))).toEqual({ interrupted: false, interrupt_ts: null });
  });

  test("an interrupt BEFORE the window is ignored (it belongs to an earlier run)", () => {
    const p = transcript([interruptText(T(1)), assistant(T(20))]);
    expect(detectPendingInterrupt(p, T(10)).interrupted).toBe(false);
  });

  test("a null window scans everything", () => {
    const p = transcript([assistant(T(0)), interruptText(T(5))]);
    expect(detectPendingInterrupt(p, null).interrupted).toBe(true);
  });

  test("malformed lines are skipped, never abort the scan", () => {
    const p = transcript(["{not json", "", assistant(T(0)), "also not json", interruptText(T(5))]);
    expect(detectPendingInterrupt(p, T(0)).interrupted).toBe(true);
  });

  test("entries without a parseable timestamp are ignored", () => {
    const p = transcript([
      assistant(T(0)),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
    ]);
    expect(detectPendingInterrupt(p, T(0)).interrupted).toBe(false);
  });

  test("a missing file is a clean miss, never a throw", () => {
    expect(detectPendingInterrupt(join(tmpRoot, "nope.jsonl"), T(0))).toEqual({
      interrupted: false,
      interrupt_ts: null,
    });
  });

  test("the memo re-reads a GROWN file: a resume after a cached pending flips it back", () => {
    const p = transcript([assistant(T(0)), interruptText(T(5))]);
    expect(detectPendingInterrupt(p, T(0)).interrupted).toBe(true);
    // Same path, more content — size/mtime drift must invalidate the memo,
    // otherwise a resumed run would stay marked interrupted forever.
    writeFileSync(p, [assistant(T(0)), interruptText(T(5)), assistant(T(9))].join("\n") + "\n", "utf-8");
    expect(detectPendingInterrupt(p, T(0)).interrupted).toBe(false);
  });
});
