/**
 * Unit tests for pickNewestPluginSibling — the pure core of Phase 2 version
 * reconciliation. It reads installed_plugins.json text + the daemon's plugin
 * root parent dir and returns the sibling install entry with the newest
 * lastUpdated (most-recent install action wins; NOT highest semver).
 *
 *   bun test tests/version-reconcile-pick.test.ts
 */

import { describe, expect, test } from "bun:test";
import { resolve, join, dirname } from "node:path";
import { pickNewestPluginSibling, normalizePathForCompare, resolvePendingUpdate } from "../lib.ts";

// A realistic cache parent: .../cache/<marketplace>/<plugin>/. Use resolve so
// the fixture paths are absolute on whatever OS runs the test.
const PARENT = resolve("/cache/ivan-private-plugins/pipeline");
const sib = (version: string) => join(PARENT, version);
const OTHER = resolve("/cache/ivan-private-plugins/other-plugin");

function doc(entries: Array<{ installPath: string; version: string; lastUpdated?: string }>): string {
  return JSON.stringify({
    plugins: {
      "pipeline@ivan-private-plugins": entries,
    },
  });
}

describe("pickNewestPluginSibling", () => {
  test("picks the entry with the newest lastUpdated", () => {
    const got = pickNewestPluginSibling(
      doc([
        { installPath: sib("0.25.1"), version: "0.25.1", lastUpdated: "2026-05-01T00:00:00Z" },
        { installPath: sib("0.27.0"), version: "0.27.0", lastUpdated: "2026-05-23T00:00:00Z" },
      ]),
      PARENT,
    );
    expect(got).not.toBeNull();
    expect(got!.version).toBe("0.27.0");
    expect(normalizePathForCompare(got!.installPath)).toBe(normalizePathForCompare(sib("0.27.0")));
  });

  test("honors a downgrade: newest action wins even if its version is lower", () => {
    // 0.27.0 was installed earlier; the user just downgraded to 0.26.0, so
    // 0.26.0 has the newer lastUpdated and MUST win (not highest-semver).
    const got = pickNewestPluginSibling(
      doc([
        { installPath: sib("0.27.0"), version: "0.27.0", lastUpdated: "2026-05-20T00:00:00Z" },
        { installPath: sib("0.26.0"), version: "0.26.0", lastUpdated: "2026-05-23T00:00:00Z" },
      ]),
      PARENT,
    );
    expect(got!.version).toBe("0.26.0");
  });

  test("ignores entries belonging to a different plugin (different parent)", () => {
    const got = pickNewestPluginSibling(
      doc([
        { installPath: sib("0.25.1"), version: "0.25.1", lastUpdated: "2026-05-01T00:00:00Z" },
        // Newer timestamp but a DIFFERENT plugin — must be excluded.
        { installPath: join(OTHER, "9.9.9"), version: "9.9.9", lastUpdated: "2026-05-23T00:00:00Z" },
      ]),
      PARENT,
    );
    expect(got!.version).toBe("0.25.1");
  });

  test("returns null when no sibling matches the parent", () => {
    const got = pickNewestPluginSibling(
      doc([{ installPath: join(OTHER, "1.0.0"), version: "1.0.0", lastUpdated: "2026-05-23T00:00:00Z" }]),
      PARENT,
    );
    expect(got).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(pickNewestPluginSibling("{not json", PARENT)).toBeNull();
  });

  test("treats a missing lastUpdated as epoch 0 (loses to any timestamped entry)", () => {
    const got = pickNewestPluginSibling(
      doc([
        { installPath: sib("0.27.0"), version: "0.27.0" }, // no lastUpdated
        { installPath: sib("0.25.1"), version: "0.25.1", lastUpdated: "2026-05-01T00:00:00Z" },
      ]),
      PARENT,
    );
    expect(got!.version).toBe("0.25.1");
    expect(got!.updatedMs).toBeGreaterThan(0);
  });

  test("tolerates a flat top-level array shape (no plugins wrapper)", () => {
    const flat = JSON.stringify([
      { installPath: sib("0.27.0"), version: "0.27.0", lastUpdated: "2026-05-23T00:00:00Z" },
    ]);
    const got = pickNewestPluginSibling(flat, PARENT);
    expect(got).not.toBeNull();
    expect(got!.version).toBe("0.27.0");
  });

  test("breaks an exact lastUpdated tie by higher version (deterministic)", () => {
    // Same millisecond, two sibling versions — the newer version must win
    // regardless of array order, so an older own-version can't shadow it.
    const ts = "2026-05-23T00:00:00.000Z";
    const ascending = pickNewestPluginSibling(
      doc([
        { installPath: sib("0.26.0"), version: "0.26.0", lastUpdated: ts },
        { installPath: sib("0.28.0"), version: "0.28.0", lastUpdated: ts },
      ]),
      PARENT,
    );
    const descending = pickNewestPluginSibling(
      doc([
        { installPath: sib("0.28.0"), version: "0.28.0", lastUpdated: ts },
        { installPath: sib("0.26.0"), version: "0.26.0", lastUpdated: ts },
      ]),
      PARENT,
    );
    expect(ascending!.version).toBe("0.28.0");
    expect(descending!.version).toBe("0.28.0");
  });

  test("skips entries without a string installPath", () => {
    const d = JSON.stringify({
      plugins: { "pipeline@x": [{ version: "0.27.0", lastUpdated: "2026-05-23T00:00:00Z" }] },
    });
    expect(pickNewestPluginSibling(d, PARENT)).toBeNull();
  });
});

describe("resolvePendingUpdate", () => {
  const complete = () => true;
  const RUNNING = sib("0.25.1");

  test("reports the newest sibling when it differs from the running root", () => {
    const got = resolvePendingUpdate(
      doc([
        { installPath: RUNNING, version: "0.25.1", lastUpdated: "2026-05-01T00:00:00Z" },
        { installPath: sib("0.27.0"), version: "0.27.0", lastUpdated: "2026-05-23T00:00:00Z" },
      ]),
      RUNNING,
      complete,
    );
    expect(got).not.toBeNull();
    expect(got!.version).toBe("0.27.0");
    expect(normalizePathForCompare(got!.plugin_root)).toBe(normalizePathForCompare(sib("0.27.0")));
  });

  test("returns null when the running root IS the newest install", () => {
    const got = resolvePendingUpdate(
      doc([
        { installPath: sib("0.24.0"), version: "0.24.0", lastUpdated: "2026-05-01T00:00:00Z" },
        { installPath: RUNNING, version: "0.25.1", lastUpdated: "2026-05-23T00:00:00Z" },
      ]),
      RUNNING,
      complete,
    );
    expect(got).toBeNull();
  });

  test("same-root comparison is case-insensitive on Windows", () => {
    if (process.platform !== "win32") return;
    const got = resolvePendingUpdate(
      doc([{ installPath: RUNNING.toUpperCase(), version: "0.25.1", lastUpdated: "2026-05-23T00:00:00Z" }]),
      RUNNING.toLowerCase(),
      complete,
    );
    expect(got).toBeNull();
  });

  test("returns null when the pending target is incomplete (mid-extraction)", () => {
    const got = resolvePendingUpdate(
      doc([
        { installPath: RUNNING, version: "0.25.1", lastUpdated: "2026-05-01T00:00:00Z" },
        { installPath: sib("0.27.0"), version: "0.27.0", lastUpdated: "2026-05-23T00:00:00Z" },
      ]),
      RUNNING,
      () => false,
    );
    expect(got).toBeNull();
  });

  test("returns null with no siblings at all (source checkout)", () => {
    expect(resolvePendingUpdate(doc([]), RUNNING, complete)).toBeNull();
    expect(resolvePendingUpdate("{not json", RUNNING, complete)).toBeNull();
  });

  test("a pending DOWNGRADE is also reported (most-recent install wins)", () => {
    const got = resolvePendingUpdate(
      doc([
        { installPath: sib("0.27.0"), version: "0.27.0", lastUpdated: "2026-05-01T00:00:00Z" },
        { installPath: sib("0.26.0"), version: "0.26.0", lastUpdated: "2026-05-23T00:00:00Z" },
      ]),
      sib("0.27.0"),
      complete,
    );
    expect(got!.version).toBe("0.26.0");
  });
});
