/**
 * hooks/run-hook.sh — the POSIX-sh binary-resolution shim every
 * hooks/hooks.json command routes through.
 *
 * WHY THIS EXISTS: Claude Code runs plugin hooks through non-interactive
 * /bin/sh, which does not source ~/.zshrc. On macOS a global install lands in
 * ~/.bun/bin, and PATH only gains that entry from the interactive shell rc —
 * so a bare `pipeline hook <name>` hook command fails with "pipeline: command
 * not found" whenever Claude Code is launched from the Dock/Finder rather
 * than a terminal. run-hook.sh resolves the binary's absolute path itself
 * (PATH → $BUN_INSTALL/bin → ~/.bun/bin → /opt/homebrew/bin → /usr/local/bin)
 * and `exec`s into it, so it must be exercised as a REAL shell script (not
 * imported as TS) — this file drives it with `sh`, a stubbed PATH/HOME/
 * BUN_INSTALL, and fake `pipeline` binaries planted at each candidate
 * location.
 *
 * WHAT CHANGED IN plugin-thin `p6`, AND WHAT DID NOT. The shim used to
 * resolve `bun`, because the five relays were `.ts` scripts in this
 * repository's `hooks/` directory and ran as `bun <relay>.ts`. They are now
 * subcommands of the CLI (`pipeline hook <name>`, in `IvanMurzak/pipeline`),
 * so the shim resolves `pipeline` instead. NOTHING ELSE about it changed:
 * same probe order, same `exec` passthrough, same `--loud` contract, same
 * committed mode. The bug it prevents was never about which binary sat at the
 * end of the chain.
 *
 * Coverage:
 *   - each of the 3 env-controllable candidates (PATH, $BUN_INSTALL/bin,
 *     ~/.bun/bin) resolves to ITS OWN stub, proving the lookup chain reaches
 *     each rung (candidates 4/5 are fixed absolute Homebrew paths that
 *     cannot be safely exercised by planting files at real system locations
 *     from a test — covered instead by the source-text check below and by
 *     the fact the "not found" tests prove nothing earlier in the chain
 *     false-positives on this machine).
 *   - resolution ORDER: PATH beats $BUN_INSTALL beats ~/.bun/bin.
 *   - stdin, argv, and exit code all pass through `exec` untouched (Claude
 *     Code feeds hook JSON on stdin and reads the relay's own stdout/exit
 *     code — the shim must never buffer or rewrite them).
 *   - pipeline-not-found: quiet mode (every hook except the primary
 *     SessionStart entry) exits 0 with NO output; --loud mode (SessionStart
 *     only) exits 0 with exactly ONE actionable stderr line that NAMES THE
 *     INSTALL COMMAND. After `p6` this plugin ships no code of its own, so
 *     that line is the entire safety net for a user who has not installed
 *     the CLI — "not found" alone would not be actionable.
 *   - pipeline PRESENT BUT TOO OLD (the plugin-thin release blocker): a CLI
 *     with no `hook` subcommand answers `unknown command 'hook'` with exit 2,
 *     and a non-zero PreToolUse exit BLOCKS THE TOOL CALL. The shim must turn
 *     that into exit 0 — while STILL PROPAGATING a genuine non-zero from a
 *     CLI that does have the subcommand, because a PreToolUse deny is a
 *     correct non-zero exit and swallowing it would disable a safety control.
 *     Both directions are asserted below with two different fake CLIs; a
 *     blanket `exit 0` fails the second one.
 *   - hooks/hooks.json wiring: every one of the 10 hook commands routes
 *     through the shim and invokes `hook <name>` for one of the five real
 *     relays (no bare `bun ` and no `.ts` path survives), and --loud appears
 *     on exactly one of the two SessionStart entries (two loud entries would
 *     print the warning twice per session).
 *   - the committed file mode is 100755 — a non-executable shim reintroduces
 *     the exact bug this fixes on a fresh clone.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PLUGIN_ROOT = resolve(import.meta.dir, '..');
const SCRIPT = join(PLUGIN_ROOT, 'hooks', 'run-hook.sh');
const SH = typeof Bun !== 'undefined' ? Bun.which('sh') : null;

/** The subcommand names hooks.json is allowed to invoke. Restated here rather
 *  than imported: the CLI that implements them is a different repository and
 *  is not on disk in this checkout — which is exactly why the two-sided parity
 *  check (these names EXIST in the CLI) lives in the parent monorepo's
 *  `tests/cross-repo/` suite instead. What this file can prove alone is that
 *  hooks.json invokes the shim, in the `hook <name>` shape, for names from a
 *  closed set. */
const RELAYS = [
  'analytics-relay',
  'stats-relay',
  'session-relay',
  'department-notifier-relay',
  'prompt-match-relay',
];

const created: string[] = [];
afterAll(() => {
  while (created.length) {
    try {
      rmSync(created.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

/** Plants a fake `pipeline` at <dir>/pipeline that reports its own label,
 *  echoes argv and stdin back on stdout (so passthrough is provable), and
 *  exits with the given code. Reads stdin with the `read` SHELL BUILTIN (not
 *  `cat`) — the tests deliberately restrict PATH to just this stub's own
 *  directory to pin candidate resolution, so an external `cat` would be
 *  unresolvable and falsely look like a stdin-passthrough failure. */
function mkStubPipeline(dir: string, label: string, exitCode = 0): void {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'pipeline');
  const script = ['#!/bin/sh', `printf 'STUB=${label} ARGS=%s\\n' "$*"`, 'IFS= read -r line', "printf 'STDIN=%s\\n' \"$line\"", `exit ${exitCode}`, ''].join('\n');
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

/** Runs run-hook.sh under `sh` with a FULLY explicit env (never inherits the
 *  real PATH/HOME — this test's whole point is controlling candidate
 *  resolution precisely). */
function run(args: string[], env: Record<string, string>, stdin = ''): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(SH!, [SCRIPT, ...args], { env, input: stdin, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// resolution chain — each env-controllable candidate, plus ordering
// ---------------------------------------------------------------------------

describe.skipIf(!SH)('run-hook.sh resolution chain (sh: ' + (SH ?? 'unavailable — suite skipped') + ')', () => {
  test('candidate 1 (PATH): resolved via `command -v pipeline`; argv + stdin + exit code pass through exec untouched', () => {
    const dir = mkTmp('shim-path-');
    const pathDir = join(dir, 'pathdir');
    mkStubPipeline(pathDir, 'PATH', 7);
    const r = run(['hook', 'analytics-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') }, 'hook-json-on-stdin');
    expect(r.status).toBe(7); // exit code from the resolved binary, not swallowed
    expect(r.stdout).toContain('STUB=PATH');
    expect(r.stdout).toContain('ARGS=hook analytics-relay');
    expect(r.stdout).toContain('STDIN=hook-json-on-stdin');
  }, 15000);

  test('candidate 2 ($BUN_INSTALL/bin): used when PATH has no pipeline', () => {
    const dir = mkTmp('shim-businstall-');
    const emptyPath = join(dir, 'empty');
    mkdirSync(emptyPath, { recursive: true });
    const installDir = join(dir, 'install');
    mkStubPipeline(join(installDir, 'bin'), 'BUN_INSTALL');
    const r = run(['hook', 'session-relay'], { PATH: emptyPath, BUN_INSTALL: installDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('STUB=BUN_INSTALL');
  }, 15000);

  test('candidate 3 (~/.bun/bin): used when PATH and $BUN_INSTALL have no pipeline (default install location)', () => {
    const dir = mkTmp('shim-home-');
    const emptyPath = join(dir, 'empty');
    mkdirSync(emptyPath, { recursive: true });
    const home = join(dir, 'home');
    mkStubPipeline(join(home, '.bun', 'bin'), 'HOME');
    const r = run(['hook', 'session-relay'], { PATH: emptyPath, HOME: home }); // BUN_INSTALL intentionally absent
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('STUB=HOME');
  }, 15000);

  test('order: PATH wins over $BUN_INSTALL and ~/.bun/bin when all three exist', () => {
    const dir = mkTmp('shim-order-a-');
    const pathDir = join(dir, 'pathdir');
    mkStubPipeline(pathDir, 'PATH');
    const installDir = join(dir, 'install');
    mkStubPipeline(join(installDir, 'bin'), 'BUN_INSTALL');
    const home = join(dir, 'home');
    mkStubPipeline(join(home, '.bun', 'bin'), 'HOME');
    const r = run(['hook', 'session-relay'], { PATH: pathDir, BUN_INSTALL: installDir, HOME: home });
    expect(r.stdout).toContain('STUB=PATH');
  }, 15000);

  test('order: $BUN_INSTALL wins over ~/.bun/bin when PATH has no pipeline', () => {
    const dir = mkTmp('shim-order-b-');
    const emptyPath = join(dir, 'empty');
    mkdirSync(emptyPath, { recursive: true });
    const installDir = join(dir, 'install');
    mkStubPipeline(join(installDir, 'bin'), 'BUN_INSTALL');
    const home = join(dir, 'home');
    mkStubPipeline(join(home, '.bun', 'bin'), 'HOME');
    const r = run(['hook', 'session-relay'], { PATH: emptyPath, BUN_INSTALL: installDir, HOME: home });
    expect(r.stdout).toContain('STUB=BUN_INSTALL');
  }, 15000);

  test('the probe order in the source still lists all five candidates, in order', () => {
    // Candidates 4 and 5 are absolute system paths a test may not plant files
    // at. Their presence — and the ORDER of the whole chain — is read off the
    // script text instead, so a reordering or a dropped rung fails here even
    // though the last two rungs cannot be executed.
    const src = readFileSync(SCRIPT, 'utf-8');
    const order = [
      'command -v pipeline',
      '"$BUN_INSTALL/bin/pipeline"',
      '"$HOME/.bun/bin/pipeline"',
      '/opt/homebrew/bin/pipeline',
      '/usr/local/bin/pipeline',
    ];
    let cursor = -1;
    for (const needle of order) {
      const at = src.indexOf(needle, cursor + 1);
      expect(at, `probe candidate missing or out of order: ${needle}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  // ---------------------------------------------------------------------------
  // pipeline nowhere to be found
  // ---------------------------------------------------------------------------

  test('pipeline not found, no --loud (quiet — used by every hook except the primary SessionStart entry): exits 0 with ZERO output', () => {
    const dir = mkTmp('shim-notfound-quiet-');
    const emptyPath = join(dir, 'empty');
    mkdirSync(emptyPath, { recursive: true });
    const home = join(dir, 'home-empty');
    mkdirSync(home, { recursive: true });
    const r = run(['hook', 'analytics-relay'], { PATH: emptyPath, HOME: home });
    expect(r.status).toBe(0); // never fails the (non-blocking) hook
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  }, 15000);

  test('pipeline not found, --loud (SessionStart primary entry only): exits 0 with exactly ONE line that names the install command', () => {
    const dir = mkTmp('shim-notfound-loud-');
    const emptyPath = join(dir, 'empty');
    mkdirSync(emptyPath, { recursive: true });
    const home = join(dir, 'home-empty');
    mkdirSync(home, { recursive: true });
    const r = run(['--loud', 'hook', 'session-relay'], { PATH: emptyPath, HOME: home });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const lines = r.stderr.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('pipeline');
    // ACTIONABLE, not merely descriptive: the exact package to install, the
    // command that installs it, and the escape hatch for a non-standard
    // location. This plugin cannot work without the CLI after plugin-thin
    // `p6`, so this one line is the whole recovery path.
    expect(lines[0]).toContain('@baizor/pipeline');
    expect(lines[0]).toContain('add -g');
    expect(lines[0]).toContain('BUN_INSTALL');
  }, 15000);

  test('missing arguments (malformed hooks.json entry) degrades to a silent no-op, never crashes', () => {
    const dir = mkTmp('shim-noargs-');
    const pathDir = join(dir, 'pathdir');
    mkStubPipeline(pathDir, 'PATH');
    const r = run([], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(''); // the stub was never invoked
  }, 15000);
});

// ---------------------------------------------------------------------------
// version skew: the CLI is installed, but predates `pipeline hook <name>`
//
// THE RELEASE BLOCKER, in one sentence: after plugin-thin `p6` hooks.json
// invokes `pipeline hook <name>`, so a user whose PLUGIN updates while their
// globally installed CLI does not gets `unknown command 'hook'` → exit 2 → a
// BLOCKED TOOL CALL on nearly every turn. The shim is the only part of the
// chain that runs before the CLI, so the mitigation lives there.
//
// The hard part is not exiting 0 — it is exiting 0 for THIS reason only. A
// real PreToolUse deny is also a non-zero exit and is CORRECT; swallowing it
// would silently disable a safety control. The shim therefore asks the CLI a
// second, read-only question after a failure (`pipeline hook --help`, which
// succeeds on a CLI that has the subcommand and is refused by one that does
// not) instead of guessing from the exit code. Both fakes below answer that
// probe the way the real CLIs do — the old one from
// `apps/pipeline-cli/src/cli.ts`'s `unknown command '${command}'` default
// branch, the new one from `IvanMurzak/pipeline`'s `runHook`, whose `--help`
// prints usage on stdout and returns 0.
// ---------------------------------------------------------------------------

/** A fake OLD `pipeline`: no `hook` subcommand at all, so every invocation —
 *  the relay call AND the shim's capability probe — is refused at the top
 *  level with the CLI's real message and exit 2. Appends each argv to `log`
 *  so the test can prove the probe never re-ran the relay. */
function mkStubOldCli(dir: string, log: string): void {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'pipeline');
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${log.replace(/\\/g, '/')}'`,
    `printf "pipeline: unknown command '%s'\\n" "$1" >&2`,
    "printf 'OLD-CLI-USAGE\\n' >&2",
    'exit 2',
    '',
  ].join('\n');
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

/** A fake NEW `pipeline`: knows `hook`, so `hook --help` prints usage on
 *  stdout and exits 0. Its relay exits with `relayExit` — 2 models a genuine
 *  PreToolUse deny, which MUST still reach Claude Code. */
function mkStubNewCli(dir: string, log: string, relayExit: number): void {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'pipeline');
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${log.replace(/\\/g, '/')}'`,
    'if [ "$1" = "hook" ] && [ "$2" = "--help" ]; then',
    "  printf 'pipeline hook <name>\\n'",
    '  exit 0',
    'fi',
    "printf 'DENY: edit is out of scope for this run\\n' >&2",
    `exit ${relayExit}`,
    '',
  ].join('\n');
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

function readLog(log: string): string[] {
  try {
    return readFileSync(log, 'utf-8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

describe.skipIf(!SH)('run-hook.sh vs. an out-of-date CLI (plugin-thin release blocker)', () => {
  test('OLD CLI, quiet: `unknown command \'hook\'` + exit 2 becomes exit 0 — the tool call is NOT blocked', () => {
    const dir = mkTmp('shim-oldcli-quiet-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubOldCli(pathDir, log);
    const r = run(['hook', 'analytics-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') }, '{"hook_event_name":"PreToolUse"}');
    expect(r.status).toBe(0); // was 2 before the fix: a blocked tool call on every turn
    // Quiet mode adds NOTHING of its own. The old CLI's own refusal still
    // passes through verbatim (suppressing it would mean capturing the real
    // run's stderr, which is exactly the buffering this shim may not do) —
    // but exactly ONCE: the probe's copy is captured, not leaked.
    expect(r.stderr.split('OLD-CLI-USAGE').length - 1).toBe(1);
    expect(r.stderr).not.toContain('@baizor/pipeline');
    // Nothing may reach stdout — Claude Code parses hook stdout as JSON, so a
    // leaked `hook --help` from the probe would corrupt it.
    expect(r.stdout).toBe('');
  }, 15000);

  test('OLD CLI, --loud (SessionStart): exit 0 plus exactly ONE line naming the upgrade command', () => {
    const dir = mkTmp('shim-oldcli-loud-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubOldCli(pathDir, log);
    const r = run(['--loud', 'hook', 'session-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const ours = r.stderr.split('\n').filter((l) => l.includes('pipeline plugin:'));
    expect(ours.length).toBe(1); // one line, not a flood
    expect(ours[0]).toContain('too old');
    // ACTIONABLE: the exact package and both install paths a user may have
    // used, exactly as the not-found line does.
    expect(ours[0]).toContain('@baizor/pipeline');
    expect(ours[0]).toContain('bun add -g');
    expect(ours[0]).toContain('npm i -g');
  }, 15000);

  test('the capability probe is read-only: it re-runs `hook --help`, NEVER the relay (no duplicate journal writes)', () => {
    const dir = mkTmp('shim-oldcli-probe-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubOldCli(pathDir, log);
    const r = run(['hook', 'stats-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(0);
    expect(readLog(log)).toEqual(['hook stats-relay', 'hook --help']);
  }, 15000);

  // ── the other direction: what must STILL fail ────────────────────────────

  test('NEW CLI, genuine deny: a non-zero exit from a CLI that HAS `hook` still propagates (a blanket `exit 0` fails here)', () => {
    const dir = mkTmp('shim-newcli-deny-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubNewCli(pathDir, log, 2); // 2 = PreToolUse deny — the tool call MUST be blocked
    const r = run(['hook', 'analytics-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('DENY: edit is out of scope for this run');
    expect(r.stderr).not.toContain('pipeline plugin:'); // not a version-skew warning
    // Deliberately asserts nothing about HOW the shim decided: this is the
    // invariant that must hold before this fix and after it, and it is the
    // test a blanket `exit 0` — or any future "just don't block" shortcut —
    // turns red on. The probe mechanics are pinned separately below.
  }, 15000);

  test('NEW CLI, genuine deny, --loud: still propagates — the loud/quiet flag governs the MESSAGE, never the status', () => {
    const dir = mkTmp('shim-newcli-deny-loud-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubNewCli(pathDir, log, 2);
    const r = run(['--loud', 'hook', 'session-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(2);
    expect(r.stderr).not.toContain('pipeline plugin:');
  }, 15000);

  test('NEW CLI, arbitrary failure code: propagated verbatim, not normalised', () => {
    const dir = mkTmp('shim-newcli-fail-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubNewCli(pathDir, log, 9);
    const r = run(['hook', 'analytics-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(9);
    // The probe DID run (the failure had to be classified) and its answer —
    // `hook --help` exits 0, so this CLI has the subcommand — was honoured.
    expect(readLog(log)).toEqual(['hook analytics-relay', 'hook --help']);
  }, 15000);

  test('success costs nothing: a relay that exits 0 is never probed (one spawn, as before the fix)', () => {
    const dir = mkTmp('shim-newcli-ok-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubNewCli(pathDir, log, 0);
    const r = run(['hook', 'analytics-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(0);
    expect(readLog(log)).toEqual(['hook analytics-relay']); // no probe on the hot path
  }, 15000);

  test('non-`hook` invocations are untouched: an old CLI refusing `plan` still exits 2', () => {
    // The blanket-exit-0 blast radius is deliberately confined to the one
    // subcommand that is on the "must never block the session" contract. A
    // skill shelling through the shim wants its failure to surface.
    const dir = mkTmp('shim-oldcli-nonhook-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubOldCli(pathDir, log);
    const r = run(['plan', '--json'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(2);
    expect(readLog(log)).toEqual(['plan --json']); // exec'd, never probed
  }, 15000);
});

// ---------------------------------------------------------------------------
// hooks/hooks.json wiring — static, runs regardless of `sh` availability
// ---------------------------------------------------------------------------

describe('hooks/hooks.json wiring', () => {
  test('all 10 hook commands route through run-hook.sh and invoke `hook <relay>`; no `.ts` relay path and no bare `bun ` survives', () => {
    const raw = readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const commands: string[] = [];
    for (const entries of Object.values(parsed.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) commands.push(hook.command);
      }
    }
    expect(commands.length).toBe(10);
    for (const cmd of commands) {
      expect(cmd).toContain('hooks/run-hook.sh');
      expect(/^bun[ "]/.test(cmd)).toBe(false); // the old bare-bun form must not survive anywhere
      // The relays left this repository in plugin-thin `p6`. A command still
      // naming a `.ts` file would point at something that no longer exists.
      expect(cmd, `hooks.json still invokes a .ts relay path: ${cmd}`).not.toContain('.ts');
      const invoked = RELAYS.filter((r) => cmd.endsWith(` hook ${r}`));
      expect(invoked.length, `not exactly one \`hook <relay>\` invocation in: ${cmd}`).toBe(1);
    }
  });

  test('every relay this plugin depends on is actually registered somewhere', () => {
    // The inverse of the check above: a relay that no hook event invokes is a
    // relay that silently never runs, which for the journal writers means the
    // telemetry chain stops with no test failing.
    const raw = readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf-8');
    for (const relay of RELAYS) {
      expect(raw, `no hooks.json command invokes \`hook ${relay}\``).toContain(` hook ${relay}`);
    }
  });

  test('--loud appears on exactly one SessionStart entry', () => {
    const raw = readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const commands: string[] = [];
    for (const entries of Object.values(parsed.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) commands.push(hook.command);
      }
    }
    const loudCount = commands.filter((c) => c.includes('--loud')).length;
    expect(loudCount).toBe(1); // two loud SessionStart entries would print the warning twice per session
    expect(parsed.hooks.SessionStart![0]!.hooks[0]!.command).toContain('--loud');
  });
});

// ---------------------------------------------------------------------------
// committed file mode — a non-executable shim reintroduces the exact bug
// ---------------------------------------------------------------------------

describe('hooks/run-hook.sh committed file mode', () => {
  test('git tracks the shim as mode 100755 (executable)', () => {
    const r = spawnSync('git', ['ls-files', '-s', 'hooks/run-hook.sh'], { cwd: PLUGIN_ROOT, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^100755\s/);
  });
});
