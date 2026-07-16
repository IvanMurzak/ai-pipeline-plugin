/**
 * Parity test — the three copies of resolveProjectRoot MUST return the same
 * result for the same input.
 *
 * Why three copies in the first place: each hook is spawned by Claude Code
 * as a standalone bun script (see CLAUDE.md and the comment block in
 * analytics_relay.ts:51). The hooks must not import from sibling .ts files
 * at runtime, so the canonical helper in apps/pipeline-ui/lib.ts is also
 * copied into hooks/pipeline_ui_relay.ts and hooks/analytics_relay.ts.
 *
 * This test runs identical fixtures through all three implementations and
 * fails if any copy drifts. If you change one, change all three — and run
 * this test to confirm the algorithms still agree.
 *
 *   bun test tests/resolve-parity.test.ts
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { resolveProjectRootFromCwd as canonical } from "../lib.ts";

// --- Reimplementations copied verbatim from the two hook files. Update
//     these copies when (and only when) the hook files change. The whole
//     point is to detect drift between hook copies and the canonical lib.

function resolveFromHookA(start: string): { project_root: string; worktree: string | null } {
  let cur = resolve(start);
  for (let i = 0; i < 64; i++) {
    const git = join(cur, ".git");
    try {
      const s = statSync(git);
      if (s.isDirectory()) return { project_root: cur, worktree: null };
      if (s.isFile()) {
        try {
          const content = readFileSync(git, "utf-8").trim();
          if (content.startsWith("gitdir:")) {
            const gitdir = resolve(cur, content.slice(7).trim());
            const commondirFile = join(gitdir, "commondir");
            try {
              const commondir = readFileSync(commondirFile, "utf-8").trim();
              const common = resolve(gitdir, commondir);
              const mainRoot =
                common.endsWith(".git") || common.endsWith(`.git`)
                  ? dirname(common)
                  : common;
              return { project_root: mainRoot, worktree: cur };
            } catch {
              /* no commondir */
            }
          }
        } catch {
          /* unreadable */
        }
      }
    } catch {
      /* no .git here */
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { project_root: resolve(start), worktree: null };
}

function resolveFromHookB(start: string): { project_root: string; worktree: string | null } {
  let cur = resolve(start);
  for (let i = 0; i < 64; i++) {
    const git = join(cur, ".git");
    try {
      const s = statSync(git);
      if (s.isDirectory()) return { project_root: cur, worktree: null };
      if (s.isFile()) {
        try {
          const content = readFileSync(git, "utf-8").trim();
          if (content.startsWith("gitdir:")) {
            const gitdir = resolve(cur, content.slice(7).trim());
            const commondirFile = join(gitdir, "commondir");
            try {
              const commondir = readFileSync(commondirFile, "utf-8").trim();
              const common = resolve(gitdir, commondir);
              const mainRoot = common.endsWith(".git") ? dirname(common) : common;
              return { project_root: mainRoot, worktree: cur };
            } catch {
              /* no commondir */
            }
          }
        } catch {
          /* unreadable */
        }
      }
    } catch {
      /* no .git here */
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { project_root: resolve(start), worktree: null };
}

// --- Fixtures

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pipe-resolve-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveProjectRoot parity (3 copies must agree)", () => {
  test("plain repo: .git is a directory", () => {
    const proj = join(root, "plain");
    mkdirSync(join(proj, ".git", "objects"), { recursive: true });
    mkdirSync(join(proj, "src"), { recursive: true });

    const expectedRoot = resolve(proj);
    const cwd = join(proj, "src");

    const canon = canonical(cwd);
    const a = resolveFromHookA(cwd);
    const b = resolveFromHookB(cwd);

    expect(canon).toEqual({ project_root: expectedRoot, worktree: null });
    expect(a).toEqual(canon);
    expect(b).toEqual(canon);
  });

  test("worktree: .git is a file with gitdir + commondir", () => {
    const main = join(root, "main");
    mkdirSync(join(main, ".git"), { recursive: true });
    writeFileSync(join(main, ".git", "HEAD"), "ref: refs/heads/main");

    const wt = join(root, "wt");
    mkdirSync(wt, { recursive: true });
    const gitdir = join(main, ".git", "worktrees", "wt");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "commondir"), "../..");
    writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}`);

    const canon = canonical(wt);
    const a = resolveFromHookA(wt);
    const b = resolveFromHookB(wt);

    expect(canon.project_root).toBe(resolve(main));
    expect(canon.worktree).toBe(resolve(wt));
    expect(a).toEqual(canon);
    expect(b).toEqual(canon);
  });

  test("no .git anywhere: returns the start path", () => {
    const proj = join(root, "no-git");
    mkdirSync(proj, { recursive: true });

    const canon = canonical(proj);
    const a = resolveFromHookA(proj);
    const b = resolveFromHookB(proj);

    expect(canon).toEqual({ project_root: resolve(proj), worktree: null });
    expect(a).toEqual(canon);
    expect(b).toEqual(canon);
  });
});
