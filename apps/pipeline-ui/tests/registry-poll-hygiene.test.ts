/**
 * Registry hygiene + journal-poll tiering — lib.ts helpers.
 *
 *   bun test tests/registry-poll-hygiene.test.ts
 *
 * Regression: nothing ever removed a project from the daemon registry, and the
 * journal poll stat'd every registered project every 400ms. Measured on a real
 * install that was 666 registered projects, 494 of them deleted temp dirs —
 * roughly 1.6k filesystem calls a second, three quarters of them on paths that
 * could not produce an event, every one through the AV filter driver.
 */

import { describe, expect, test } from "bun:test";

import { deadProjectIds, shouldPollJournal } from "../lib.ts";

describe("deadProjectIds", () => {
  const registry = {
    live: { project_root: "C:/projects/live" },
    gone: { project_root: "C:/tmp/recon-e2e-1223630386" },
    alsoGone: { project_root: "C:/tmp/writer-envelope/proj-DyZ9fS" },
  };
  const onlyLiveExists = (p: string) => p === "C:/projects/live";

  test("selects exactly the entries whose root is missing", () => {
    expect(deadProjectIds(registry, onlyLiveExists).sort()).toEqual(["alsoGone", "gone"]);
  });

  test("drops nothing when every root is present", () => {
    expect(deadProjectIds(registry, () => true)).toEqual([]);
  });

  test("leaves a malformed entry alone rather than guessing", () => {
    const broken = { weird: {} as { project_root: string } };
    expect(deadProjectIds(broken, () => false)).toEqual([]);
  });
});

describe("shouldPollJournal", () => {
  const HOT_MS = 5 * 60_000;
  const now = 1_000_000;

  test("polls a project whose journal moved inside the hot window", () => {
    expect(shouldPollJournal(now - 1_000, now, false, HOT_MS)).toBe(true);
  });

  test("skips a project that has been quiet longer than the window", () => {
    expect(shouldPollJournal(now - HOT_MS - 1, now, false, HOT_MS)).toBe(false);
  });

  test("skips a project whose journal has never been read", () => {
    expect(shouldPollJournal(undefined, now, false, HOT_MS)).toBe(false);
  });

  // The cold sweep is what keeps a run that starts while fsWatch is asleep
  // from going unnoticed, so it must ignore the hot/cold distinction.
  test("the cold sweep visits everything", () => {
    expect(shouldPollJournal(undefined, now, true, HOT_MS)).toBe(true);
    expect(shouldPollJournal(now - HOT_MS - 1, now, true, HOT_MS)).toBe(true);
    expect(shouldPollJournal(0, now, true, HOT_MS)).toBe(true);
  });

  // A tail that exists but never grew records lastChangeAt: 0.
  test("treats a never-grown journal as cold", () => {
    expect(shouldPollJournal(0, now, false, HOT_MS)).toBe(false);
  });
});
