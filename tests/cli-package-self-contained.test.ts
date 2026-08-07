/**
 * cli-package-self-contained.test.ts — the CLI's tests may not reach out of the
 * CLI package.
 *
 *   bun test tests/cli-package-self-contained.test.ts
 *
 * WHY THIS EXISTS. `apps/pipeline-cli` is being extracted into its own
 * repository (`.taskflow/2026-08-03-plugin-thin/02-extract-cli.md`, phase 5).
 * Anything under `apps/pipeline-cli/tests/` that reads a file ABOVE
 * `apps/pipeline-cli/` is reading something that will not travel with the
 * package — and the failure only appears after the split, in a repository where
 * nobody is looking. Twenty such files existed when this guard was written; the
 * extracted suite exited 1 because of them.
 *
 * The rule enforced here is the general one: **a test lives in the tree that
 * contains what it tests.** Hook tests live at this repository's root `tests/`
 * (beside `hooks/`); tests that need BOTH a hook and CLI source live in the
 * parent monorepo's `tests/cross-repo/`, the only tree with both on disk.
 *
 * TWO SYNTACTIC FORMS, BOTH CHECKED — this is the load-bearing part. A grep for
 * `../../../` cannot see `resolve(import.meta.dir, '..', '..', '..')`, and that
 * exact blindness is why two of the twenty files were missed by the sweep that
 * commissioned this work. Both are resolved here rather than matched.
 *
 * WHAT IS NOT FLAGGED, deliberately: bare relative strings that are DATA rather
 * than a location — `PP_EVIL: '../../../../evil.js'` (a path-traversal attack
 * fixture) and `worktree = ../../../../public/sub` (git config text). They are
 * not anchored to the file's own directory, so they reach nothing. Only two
 * mechanisms can actually reach a file: a module specifier, and a path built
 * from `import.meta.dir`. Those two are what this checks.
 */

import { describe, test, expect } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const CLI_PKG = resolve(REPO_ROOT, 'apps', 'pipeline-cli');
const CLI_TESTS = resolve(CLI_PKG, 'tests');

/**
 * The ONE permitted escape, with its reason. Keyed by `<file>::<specifier>` so
 * a second escape in an allowlisted file is still caught.
 *
 * `department-serve.test.ts` probes for pipeline-runner's `ENGINE_REGISTRY`
 * source to compare its engine→adapter table against. That probe is OPTIONAL by
 * construction — `PIPELINE_RUNNER_ENGINE_TS` first, then this path, then
 * `existsSync` decides, and `readRunnerEngineRegistry()` returns `null` when
 * neither is present, which the test treats as "nothing to compare". It is a
 * superrepo-only edit guard, it degrades to a skip everywhere else, and the
 * file's own header argues the position at length. It therefore does not block
 * the extraction the way a hook import does: nothing here must exist for the
 * suite to pass.
 */
const ALLOWED = new Map<string, string>([
  [
    'department-serve.test.ts::../../../../pipeline-runner/src/department/engine.ts',
    'optional superrepo probe; existsSync-guarded and env-overridable, returns null when absent',
  ],
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = resolve(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** `// …` and `/* … *\/` removed, so prose ABOUT a path is not read as a use of
 *  one (several files discuss `../../../pipeline-ui` in their headers). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Every module specifier: `import … from 'x'`, `import 'x'`, `export … from
 *  'x'`, `import('x')`, `require('x')`. */
function moduleSpecifiers(code: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s[^;\n]*?from\s*['"`]([^'"`]+)['"`]/g,
    /(?:^|\n)\s*import\s*['"`]([^'"`]+)['"`]/g,
    /\b(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) out.push(m[1]!);
  }
  return out;
}

/** Every path built from the file's own directory, in BOTH forms:
 *    resolve(import.meta.dir, '../../../hooks/x.ts')     — slash segments
 *    resolve(import.meta.dir, '..', '..', '..', 'hooks') — separate arguments
 *  Returned pre-joined so the caller resolves one specifier per call site. */
function selfAnchoredPaths(code: string): string[] {
  const out: string[] = [];
  const re = /\b(?:resolve|join)\(\s*import\.meta\.dir\s*((?:,\s*(?:'[^'\n]*'|"[^"\n]*"|`[^`\n$]*`))+)\s*,?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const segments = [...m[1]!.matchAll(/(?:'([^'\n]*)'|"([^"\n]*)"|`([^`\n$]*)`)/g)].map(
      (s) => s[1] ?? s[2] ?? s[3] ?? '',
    );
    if (segments.length > 0) out.push(segments.join('/'));
  }
  return out;
}

describe('apps/pipeline-cli/tests reaches nothing above apps/pipeline-cli', () => {
  // The CLI leaves this repository in plugin-thin phase 5. When it does, this
  // whole guard has nothing left to guard and should be deleted WITH it — a
  // silent skip would be indistinguishable from a passing check, so say so.
  const present = existsSync(CLI_TESTS);

  test('the CLI package is still in this repository (delete this file with it)', () => {
    expect(present, `${CLI_TESTS} is gone — apps/pipeline-cli has been extracted; delete tests/cli-package-self-contained.test.ts too`).toBe(
      true,
    );
  });

  const files = present ? walk(CLI_TESTS).filter((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f)) : [];

  test('the scan actually found test files (never passes vacuously)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test('no module specifier and no import.meta.dir path escapes the package', () => {
    const escapes: string[] = [];
    const allowedSeen = new Set<string>();

    for (const file of files) {
      const rel = relative(CLI_TESTS, file).replace(/\\/g, '/');
      const code = stripComments(readFileSync(file, 'utf-8'));
      const candidates = [
        ...moduleSpecifiers(code).filter((s) => s.startsWith('.')),
        ...selfAnchoredPaths(code),
      ];
      for (const specifier of candidates) {
        const target = resolve(dirname(file), specifier);
        const outside = relative(CLI_PKG, target).replace(/\\/g, '/');
        if (!outside.startsWith('..')) continue;
        const key = `${rel}::${specifier}`;
        if (ALLOWED.has(key)) {
          allowedSeen.add(key);
          continue;
        }
        escapes.push(`${rel} -> ${specifier}   (resolves to ${outside} relative to apps/pipeline-cli)`);
      }
    }

    expect(
      escapes,
      'these tests read files the extracted CLI will not have. Move each one to the tree that contains what it tests:\n' +
        '  hooks only            -> this repository\'s root tests/\n' +
        '  hooks AND CLI source  -> the parent monorepo\'s tests/cross-repo/\n\n' +
        escapes.join('\n'),
    ).toEqual([]);

    // An allowlist entry that no longer matches anything is a stale exemption
    // waiting to excuse a future escape. Fail rather than carry it.
    const stale = [...ALLOWED.keys()].filter((k) => !allowedSeen.has(k));
    expect(stale, `allowlisted escapes that no longer exist — delete them from ALLOWED:\n${stale.join('\n')}`).toEqual(
      [],
    );
  });

  test('no test file under apps/pipeline-cli/tests imports a hook', () => {
    const offenders = files.filter((file) => {
      const code = stripComments(readFileSync(file, 'utf-8'));
      return [...moduleSpecifiers(code).filter((s) => s.startsWith('.')), ...selfAnchoredPaths(code)].some(
        (specifier) => {
          const target = resolve(dirname(file), specifier);
          return !relative(resolve(REPO_ROOT, 'hooks'), target).startsWith('..');
        },
      );
    });
    expect(
      offenders.map((f) => relative(REPO_ROOT, f).replace(/\\/g, '/')),
      'hook tests belong beside hooks/ — this repository\'s root tests/ — not inside the CLI package',
    ).toEqual([]);
  });
});
