/**
 * forEachFileLine — bounded-memory line walker (lib.ts).
 *
 *   bun test tests/file-line-stream.test.ts
 *
 * Replaces readFileSync + split("\n") on the journals, which the daemon walks
 * for every project once a minute. One real project's journal is 35 MB; as a
 * JS string plus a line array that is several hundred MB of transient heap per
 * sweep, which showed up as an 846 MB working-set spike against a 154 MB
 * baseline. The edges worth testing are the ones a chunked reader introduces:
 * lines and multi-byte characters that straddle a chunk boundary.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { forEachFileLine, streamJournalLines } from "../lib.ts";

// Must match LINE_READ_CHUNK_BYTES in lib.ts.
const CHUNK = 256 * 1024;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "line-stream-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents, "utf-8");
  return path;
}

function collect(path: string): string[] {
  const out: string[] = [];
  forEachFileLine(path, (line) => out.push(line));
  return out;
}

describe("forEachFileLine", () => {
  test("delivers every line, trimmed, skipping blanks", () => {
    const path = write("basic.txt", "one\n  two  \n\n\nthree\n");
    expect(collect(path)).toEqual(["one", "two", "three"]);
  });

  test("delivers a final line with no trailing newline", () => {
    const path = write("no-eol.txt", "alpha\nomega");
    expect(collect(path)).toEqual(["alpha", "omega"]);
  });

  test("strips the \\r of CRLF, as the split-based reader did", () => {
    const path = write("crlf.txt", "a\r\nb\r\n");
    expect(collect(path)).toEqual(["a", "b"]);
  });

  test("reassembles a line that spans several chunks", () => {
    const long = "x".repeat(CHUNK * 2 + 17);
    const path = write("long-line.txt", `head\n${long}\ntail\n`);

    const lines = collect(path);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("head");
    expect(lines[1]!.length).toBe(long.length);
    expect(lines[1]).toBe(long);
    expect(lines[2]).toBe("tail");
  });

  // The bug a naive chunked reader ships: buf.toString() on a boundary that
  // lands mid-character yields U+FFFD instead of the character.
  test("keeps a multi-byte character split across a chunk boundary intact", () => {
    // 'ё' is two UTF-8 bytes; place it so byte 1 ends the first chunk.
    const filler = "a".repeat(CHUNK - 1);
    const path = write("multibyte.txt", `${filler}ё-tail\nsecond\n`);

    const lines = collect(path);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`${filler}ё-tail`);
    expect(lines[0]).not.toContain("�");
    expect(lines[1]).toBe("second");
  });

  test("handles a four-byte character (emoji) on the boundary too", () => {
    const filler = "a".repeat(CHUNK - 2);
    const path = write("emoji.txt", `${filler}🚀end\n`);

    const lines = collect(path);
    expect(lines[0]).toBe(`${filler}🚀end`);
    expect(lines[0]).not.toContain("�");
  });

  test("is a no-op for a missing file and for an empty one", () => {
    expect(collect(join(dir, "nope.txt"))).toEqual([]);
    expect(collect(write("empty.txt", ""))).toEqual([]);
    expect(collect(write("blank.txt", "\n\n\n"))).toEqual([]);
  });
});

describe("streamJournalLines over the chunked reader", () => {
  test("parses events and skips malformed lines across a chunk boundary", () => {
    // Pad past one chunk so the events land in the second read.
    const padding = Array.from({ length: 4000 }, (_, i) =>
      JSON.stringify({ type: "noise", run_id: `pad-${i}`, filler: "y".repeat(60) }),
    ).join("\n");
    const path = write(
      "journal.jsonl",
      `${padding}\n{ not json\n${JSON.stringify({ type: "pipeline.started", run_id: "run-ok" })}\n`,
    );

    const types: string[] = [];
    const ids: string[] = [];
    streamJournalLines(path, (ev) => {
      types.push(String((ev as { type?: string }).type));
      ids.push(String((ev as { run_id?: string }).run_id));
    });

    expect(ids).toContain("run-ok");
    expect(types).toContain("pipeline.started");
    // 4000 padding events + the one real event; the malformed line is dropped.
    expect(ids).toHaveLength(4001);
  });
});
