/**
 * Pure-helper tests for src/lib/format.ts.
 *
 *   cd apps/pipeline-ui/web && bun run test
 */

import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import {
  compactNumber,
  elapsed,
  eventSignature,
  iterationIndexFromPath,
  iterationLabel,
  pipelineNameFromIterationPath,
  relativeTime,
} from "../format";

describe("pipelineNameFromIterationPath", () => {
  test("flat layout", () => {
    expect(
      pipelineNameFromIterationPath(
        "/project/.claude/pipeline/ui-smoke/steps/01-x.md",
      ),
    ).toBe("ui-smoke");
  });

  test("nested-category layout: returns the LEAF name, not the category", () => {
    expect(
      pipelineNameFromIterationPath(
        "/project/.claude/pipeline/workflows/ui-smoke/steps/01-x.md",
      ),
    ).toBe("ui-smoke");
  });

  test("nested twice: still picks the immediate parent of steps/", () => {
    expect(
      pipelineNameFromIterationPath(
        "/project/.claude/pipeline/a/b/leaf/steps/01.md",
      ),
    ).toBe("leaf");
  });

  test("windows-style backslashes are normalized", () => {
    expect(
      pipelineNameFromIterationPath(
        "C:\\proj\\.claude\\pipeline\\workflows\\ui-smoke\\steps\\01-x.md",
      ),
    ).toBe("ui-smoke");
  });

  test("returns null on a path without /steps/", () => {
    expect(pipelineNameFromIterationPath("/something/else.md")).toBeNull();
  });

  test("returns null on null / undefined", () => {
    expect(pipelineNameFromIterationPath(null)).toBeNull();
    expect(pipelineNameFromIterationPath(undefined)).toBeNull();
  });
});

describe("iterationIndexFromPath", () => {
  test("extracts simple numeric prefix", () => {
    expect(iterationIndexFromPath("01-count-files.md")).toBe("01");
    expect(iterationIndexFromPath("/a/b/steps/02-foo.md")).toBe("02");
  });

  test("extracts alphanumeric suffix like 03a", () => {
    expect(iterationIndexFromPath("03a-review.md")).toBe("03a");
  });

  test("returns null on no leading number", () => {
    expect(iterationIndexFromPath("foo.md")).toBeNull();
  });

  test("handles null / undefined", () => {
    expect(iterationIndexFromPath(null)).toBeNull();
    expect(iterationIndexFromPath(undefined)).toBeNull();
  });
});

describe("iterationLabel", () => {
  test("returns filename without .md", () => {
    expect(iterationLabel("/a/b/01-foo.md")).toBe("01-foo");
  });

  test("normalizes windows backslashes", () => {
    expect(iterationLabel("C:\\a\\b\\01-foo.md")).toBe("01-foo");
  });

  test("dash placeholder on empty input", () => {
    expect(iterationLabel(null)).toBe("—");
    expect(iterationLabel(undefined)).toBe("—");
  });
});

describe("eventSignature", () => {
  test("changes when any keyed field changes", () => {
    const base = {
      ts: "2026-01-01T00:00:00Z",
      type: "iteration.started",
      run_id: "abc",
      _project_id: "p1",
      data: { iteration_path: "/x/01.md" },
    };
    const a = eventSignature(base);
    expect(a).toBe(eventSignature(base));
    expect(a).not.toBe(eventSignature({ ...base, ts: "later" }));
    expect(a).not.toBe(eventSignature({ ...base, type: "iteration.completed" }));
    expect(a).not.toBe(eventSignature({ ...base, run_id: "def" }));
    expect(a).not.toBe(eventSignature({ ...base, _project_id: "p2" }));
    expect(a).not.toBe(
      eventSignature({ ...base, data: { iteration_path: "/x/02.md" } }),
    );
  });

  test("handles missing optional fields", () => {
    const sig = eventSignature({ ts: "t", type: "pipeline.completed" });
    expect(sig).toBe("|t|pipeline.completed||");
  });
});

describe("compactNumber", () => {
  test.each([
    [0, "0"],
    [42, "42"],
    [999, "999"],
    [1_000, "1.0k"],
    [9_999, "10.0k"],
    [12_345, "12k"],
    [1_500_000, "1.50M"],
    [1_500_000_000, "1.50B"],
  ])("compactNumber(%i) === %s", (n, expected) => {
    expect(compactNumber(n)).toBe(expected);
  });
});

describe("relativeTime / elapsed", () => {
  const FIXED_NOW = new Date("2026-01-01T12:00:00Z").getTime();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("relativeTime within 5 seconds is 'just now'", () => {
    expect(relativeTime(new Date(FIXED_NOW - 2_000).toISOString())).toBe("just now");
  });

  test("relativeTime within a minute is seconds", () => {
    expect(relativeTime(new Date(FIXED_NOW - 30_000).toISOString())).toBe("30s ago");
  });

  test("relativeTime within an hour is minutes", () => {
    expect(relativeTime(new Date(FIXED_NOW - 5 * 60_000).toISOString())).toBe(
      "5m ago",
    );
  });

  test("relativeTime within a day is hours", () => {
    expect(relativeTime(new Date(FIXED_NOW - 2 * 3_600_000).toISOString())).toBe(
      "2h ago",
    );
  });

  test("relativeTime over a day is days", () => {
    expect(relativeTime(new Date(FIXED_NOW - 48 * 3_600_000).toISOString())).toBe(
      "2d ago",
    );
  });

  // elapsed renders through durationMs — THE one duration format (42s ·
  // 7m 05s · 3h 12m), shared with step chips and the analytics header.
  test("elapsed formats short durations", () => {
    expect(elapsed(new Date(FIXED_NOW - 30_000).toISOString(), null)).toBe("30s");
    expect(elapsed(new Date(FIXED_NOW - 90_000).toISOString(), null)).toBe("1m 30s");
    expect(elapsed(new Date(FIXED_NOW - 2 * 3_600_000).toISOString(), null)).toBe(
      "2h 00m",
    );
  });

  test("elapsed honors `toIso` when provided", () => {
    const from = "2026-01-01T10:00:00Z";
    const to = "2026-01-01T10:05:00Z";
    expect(elapsed(from, to)).toBe("5m 00s");
  });
});
