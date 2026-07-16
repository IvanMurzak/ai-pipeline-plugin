import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTranscriptByRunId } from "../transcript-stats.ts";
import { encodeClaudeProjectDir } from "../transcripts.ts";

// findTranscriptByRunId(projectRoot, runId, startIso, endIso, homeOverride)
// scans <home>/.claude/projects/<encoded-root>/*.jsonl for the session that
// mentions the run_id, window-prefiltered by file times.

const RUN = "d9bdea14e09a";

// Claude Code's projects-dir munging replaces EVERY non-alphanumeric char
// with '-' (verified against real ~/.claude/projects entries — the whole
// observed alphabet is [a-zA-Z0-9-]). The old separator-only rule kept dots,
// so dotted project paths resolved to directories that never exist.
test("encodeClaudeProjectDir replaces every non-alphanumeric char with '-'", () => {
  expect(encodeClaudeProjectDir("C:\\Projects\\foo")).toBe("C--Projects-foo");
  expect(encodeClaudeProjectDir("C:\\p\\v6000.3.1f1")).toBe("C--p-v6000-3-1f1");
  expect(encodeClaudeProjectDir("/home/u/my_app v2")).toBe("-home-u-my-app-v2");
});

function setup(): { home: string; dir: string; projectRoot: string } {
  const home = mkdtempSync(join(tmpdir(), "tf-home-"));
  const projectRoot = "C:\\proj\\demo";
  const dir = join(home, ".claude", "projects", encodeClaudeProjectDir(projectRoot));
  mkdirSync(dir, { recursive: true });
  return { home, dir, projectRoot };
}

test("finds the transcript whose content mentions the run_id", () => {
  const { home, dir, projectRoot } = setup();
  writeFileSync(join(dir, "aaa.jsonl"), `{"type":"user","message":{"content":"hello"}}\n`);
  writeFileSync(
    join(dir, "bbb.jsonl"),
    `{"type":"user","message":{"content":"run_id = ${RUN} spawned"}}\n{"type":"assistant","message":{"content":"${RUN}"}}\n`,
  );
  const hit = findTranscriptByRunId(projectRoot, RUN, null, null, home);
  expect(hit).toBe(join(dir, "bbb.jsonl"));
});

test("prefers the file with MORE mentions (driving session beats bystander)", () => {
  const { home, dir, projectRoot } = setup();
  writeFileSync(join(dir, "bystander.jsonl"), `{"m":"saw ${RUN} once"}\n`);
  writeFileSync(join(dir, "driver.jsonl"), `{"m":"${RUN}"}\n{"m":"${RUN}"}\n{"m":"${RUN}"}\n`);
  const hit = findTranscriptByRunId(projectRoot, RUN, null, null, home);
  expect(hit).toBe(join(dir, "driver.jsonl"));
});

test("returns null when nothing mentions the run_id", () => {
  const { home, dir, projectRoot } = setup();
  writeFileSync(join(dir, "aaa.jsonl"), `{"m":"unrelated"}\n`);
  expect(findTranscriptByRunId(projectRoot, RUN, null, null, home)).toBeNull();
});

test("window pre-filter drops sessions that ended before the run started", () => {
  const { home, dir, projectRoot } = setup();
  const stale = join(dir, "old.jsonl");
  writeFileSync(stale, `{"m":"${RUN}"}\n`);
  // Session last touched an hour BEFORE the run's start.
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(stale, old, old);
  const startIso = new Date().toISOString();
  expect(findTranscriptByRunId(projectRoot, RUN, startIso, null, home)).toBeNull();
});

test("returns null for a missing projects dir (no throw)", () => {
  const home = mkdtempSync(join(tmpdir(), "tf-empty-"));
  expect(findTranscriptByRunId("C:\\nowhere\\x", RUN, null, null, home)).toBeNull();
});
