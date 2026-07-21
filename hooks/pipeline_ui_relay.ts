#!/usr/bin/env bun
/**
 * Pipeline plugin — SessionStart hook for the pipeline UI daemon.
 *
 * Fires whenever Claude Code starts a session in a project that has a
 *   <cwd>/.claude/pipeline/   directory.
 *
 * Responsibilities:
 *   1. If no pipeline daemon is running (lock missing or its PID is
 *      dead), spawn one detached. Bun is required.
 *   2. If a daemon IS running but from a different plugin install dir
 *      than this hook's CLAUDE_PLUGIN_ROOT (i.e. the user upgraded or
 *      downgraded the plugin since the daemon booted), hand it off to
 *      the current version — cleanly via POST /api/restart-to, or by
 *      brute-force kill+respawn for pre-feature daemons that lack the
 *      endpoint. This is the version-reconciliation contract: the
 *      daemon should always run whatever version Claude Code currently
 *      considers installed.
 *   3. POST { project_root } to the daemon's /api/register so the
 *      project shows up in the UI immediately, before any /pipeline:*
 *      command runs.
 *   4. Append a session.opened event to the project's
 *      .runtime/events.jsonl so the UI can show "session opened by
 *      Claude Code at <ts>".
 *
 * Never blocks Claude Code — always exits 0. All errors are silent
 * unless PIPELINE_UI_DEBUG=1.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, appendFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const DEBUG = process.env.PIPELINE_UI_DEBUG === "1";
const log = (msg: string) => DEBUG && console.error(`[pipeline-ui-relay] ${msg}`);

/** Master enable switch. The UI/analytics system is ON BY DEFAULT — this hook
 *  runs UNLESS the user has explicitly opted OUT by setting PIPELINE_UI_ENABLED
 *  to a falsy value (0/false/no/off); unset/empty (and any other value) leaves
 *  it enabled. When opted out it never spawns/reconciles the daemon, registers
 *  the project, or writes session.opened. (The Bun process still launches
 *  because the registration lives in hooks.json, but it exits immediately. To
 *  remove the spawn entirely, disable the plugin.) Mirrors
 *  hooks/analytics_relay.ts. */
function pipelineUiEnabled(): boolean {
  const v = (process.env.PIPELINE_UI_ENABLED ?? "").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

const HOME_DIR = join(homedir(), ".claude", "pipeline-ui");
const LOCK_PATH = join(HOME_DIR, "daemon.lock");
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? resolve(import.meta.dir, "..");
// Launch the supervisor (Phase 3), not the worker directly — the supervisor
// gives the daemon crash-recovery and keeps monitoring across version
// handoffs. It spawns server.ts as its worker.
const DAEMON_SCRIPT = join(PLUGIN_ROOT, "apps", "pipeline-ui", "supervisor.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Normalize a path for cross-process comparison. Node and PowerShell can
 *  disagree on separator + drive-letter casing on Windows; on POSIX paths are
 *  case-sensitive so we only fold case on win32. */
function normalizePath(p: string): string {
  const n = resolve(p).replaceAll("\\", "/");
  return process.platform === "win32" ? n.toLowerCase() : n;
}

interface DaemonLock {
  pid: number;
  port: number;
  host: string;
  plugin_version: string;
  started_at: string;
  /** Install dir the daemon was launched from. Absent in locks written by
   *  daemons older than the version-reconcile feature. */
  plugin_root?: string;
  /** Managing supervisor's pid (Phase 3). `pid` above is the worker; to fully
   *  stop a supervised daemon you must kill the supervisor too, else it
   *  respawns the worker. Absent for unsupervised / pre-Phase-3 daemons. */
  supervisor_pid?: number;
}

interface HealthBody {
  ok?: boolean;
  plugin_version?: string;
  plugin_root?: string;
  pid?: number;
}

function readLock(): DaemonLock | null {
  if (!existsSync(LOCK_PATH)) return null;
  try {
    const txt = readFileSync(LOCK_PATH, "utf-8").trim();
    if (!txt) return null;
    return JSON.parse(txt);
  } catch (e) {
    log(`lock unreadable: ${e}`);
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveProjectRoot(start: string): { project_root: string; worktree: string | null } {
  let cur = resolve(start);
  for (let i = 0; i < 64; i++) {
    const git = join(cur, ".git");
    if (existsSync(git)) {
      const s = statSync(git);
      if (s.isDirectory()) return { project_root: cur, worktree: null };
      if (s.isFile()) {
        try {
          const content = readFileSync(git, "utf-8").trim();
          if (content.startsWith("gitdir:")) {
            const gitdir = resolve(cur, content.slice(7).trim());
            const commondirFile = join(gitdir, "commondir");
            if (existsSync(commondirFile)) {
              const commondir = readFileSync(commondirFile, "utf-8").trim();
              const common = resolve(gitdir, commondir);
              const mainRoot = common.endsWith(".git") ? dirname(common) : common;
              return { project_root: mainRoot, worktree: cur };
            }
          }
        } catch (e) {
          log(`failed to read .git file: ${e}`);
        }
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { project_root: resolve(start), worktree: null };
}

/** True when a `.claude/pipeline` directory exists at `start` or any
 *  ancestor up to and including `stopAt` (the resolved project root).
 *  Mirrors the same helper in hooks/analytics_relay.ts — keep them in
 *  sync. Depth- and worktree-independent so a session started anywhere
 *  inside a pipeline project (root, deep in `.claude/pipeline/…`, or a
 *  worktree under `.claude/worktrees/<name>/`) still registers + emits
 *  session.opened. Bounded at the git root so a stray `.claude/pipeline`
 *  far up the tree can't classify unrelated projects. */
function hasPipelineDirUpTo(start: string, stopAt: string): boolean {
  let cur = resolve(start);
  const stop = resolve(stopAt);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(cur, ".claude", "pipeline"))) return true;
    if (cur === stop) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return false;
}

function spawnDaemon(): void {
  if (!existsSync(DAEMON_SCRIPT)) {
    log(`daemon script not found at ${DAEMON_SCRIPT}`);
    return;
  }
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    const stdoutLog = join(HOME_DIR, "daemon.stdout.log");
    const stderrLog = join(HOME_DIR, "daemon.stderr.log");
    // Truncate logs to prevent unbounded growth, then re-open for the child
    // to append into. Without these fd handoffs the daemon's startup output
    // is lost and a failed boot is invisible.
    try { writeFileSync(stdoutLog, ""); } catch {}
    try { writeFileSync(stderrLog, ""); } catch {}
    let outFd: number | null = null;
    let errFd: number | null = null;
    try { outFd = openSync(stdoutLog, "a"); } catch {}
    try { errFd = openSync(stderrLog, "a"); } catch {}
    // Use the bun binary that's running THIS hook (process.execPath) rather
    // than relying on `bun` being on the detached child's PATH. On Windows the
    // npm-shim install exposes bun via bun.ps1/bun.cmd, not a bun.exe on PATH,
    // so node's spawn (no shell) can't resolve a bare "bun" — the daemon would
    // silently never start. server.ts's spawnSuccessor uses the same trick.
    const child = spawn(process.execPath, [DAEMON_SCRIPT], {
      detached: true,
      stdio: ["ignore", outFd ?? "ignore", errFd ?? "ignore"],
      env: { ...process.env },
      windowsHide: true,
    });
    child.unref();
    // The child holds dups of the fds; we can close ours.
    if (outFd !== null) { try { closeSync(outFd); } catch {} }
    if (errFd !== null) { try { closeSync(errFd); } catch {} }
    log(`spawned daemon pid=${child.pid}`);
  } catch (e) {
    log(`failed to spawn daemon: ${e}`);
  }
}

// Budget covers the supervisor→worker double-spawn + worker boot (which can
// include port-reclaim retries) — more than the single-process launch needed.
async function waitForDaemon(maxMs = 6000): Promise<DaemonLock | null> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const lock = readLock();
    if (lock && isProcessAlive(lock.pid)) return lock;
    await sleep(100);
  }
  return null;
}

/** Wait for a lock written by a DIFFERENT pid than `oldPid` to appear and be
 *  alive — i.e. the successor daemon took over. Returns it, or null on timeout. */
async function waitForSuccessor(oldPid: number, maxMs = 6000): Promise<DaemonLock | null> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const lock = readLock();
    if (lock && lock.pid !== oldPid && isProcessAlive(lock.pid)) return lock;
    await sleep(100);
  }
  return null;
}

function readVersionAt(pluginRoot: string): string | null {
  try {
    const m = JSON.parse(
      readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf-8"),
    );
    return typeof m.version === "string" ? m.version : null;
  } catch {
    return null;
  }
}

async function fetchHealth(lock: DaemonLock): Promise<HealthBody | null> {
  try {
    const res = await fetch(`http://${lock.host}:${lock.port}/api/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return null;
    return (await res.json()) as HealthBody;
  } catch (e) {
    log(`health fetch failed: ${e}`);
    return null;
  }
}

/** Ask a running daemon to hand off to `expectedRoot` via /api/restart-to.
 *  Returns true only when the daemon acked with restarted:true. A 404 (the
 *  daemon predates the endpoint) or any error returns false so the caller can
 *  fall back to brute-force. */
async function requestCleanHandoff(lock: DaemonLock, expectedRoot: string): Promise<boolean> {
  try {
    const res = await fetch(`http://${lock.host}:${lock.port}/api/restart-to`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid: lock.pid, plugin_root: expectedRoot }),
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      log(`restart-to returned ${res.status} (likely pre-feature daemon)`);
      return false;
    }
    const body = (await res.json()) as { ok?: boolean; restarted?: boolean };
    return body?.ok === true && body?.restarted === true;
  } catch (e) {
    log(`restart-to request failed: ${e}`);
    return false;
  }
}

/** Last-resort reconciliation for a daemon that can't hand itself off (no
 *  /api/restart-to). Kill it, clear a stale lock, and spawn a fresh daemon
 *  from this hook's plugin root. */
async function bruteForceRestart(lock: DaemonLock): Promise<void> {
  log(`brute-force restarting daemon pid=${lock.pid} supervisor=${lock.supervisor_pid ?? "none"}`);
  // Kill the SUPERVISOR first (if any) so it doesn't respawn the worker we're
  // about to kill. A supervised daemon normally reconciles via the clean
  // /api/restart-to handoff, so brute-force only reaches a supervised daemon
  // when that handoff failed — but if we killed only the worker, the live
  // supervisor would resurrect it and the upgrade would silently no-op.
  if (Number.isInteger(lock.supervisor_pid) && (lock.supervisor_pid as number) > 0) {
    try { process.kill(lock.supervisor_pid as number, "SIGTERM"); } catch {}
    try { process.kill(lock.supervisor_pid as number, "SIGKILL"); } catch {}
  }
  // Only signal a real pid. A pid of 0 (or negative) can come from an orphan
  // lock that probeOrphanDaemon synthesized when /api/health omitted pid; on
  // POSIX `process.kill(0, sig)` would signal THIS hook's own process group
  // and `isProcessAlive(0)` returns true, hanging the wait loop. Skip straight
  // to lock cleanup + respawn in that case.
  const validPid = Number.isInteger(lock.pid) && lock.pid > 0;
  if (validPid) {
    try { process.kill(lock.pid, "SIGTERM"); } catch {}
    // Wait for the old process to exit so its port frees up; the successor's
    // boot probe refuses to start while the old one still answers /api/health.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && isProcessAlive(lock.pid)) await sleep(100);
    if (isProcessAlive(lock.pid)) {
      // SIGTERM ignored (or, on Windows, didn't take) — escalate.
      try { process.kill(lock.pid, "SIGKILL"); } catch {}
      await sleep(200);
    }
  }
  // On Windows process.kill maps to TerminateProcess, so the daemon's SIGTERM
  // cleanup never ran and the lock still points at the dead pid. Remove it so
  // the successor's isExistingDaemonAlive() short-circuits to null.
  try {
    if (existsSync(LOCK_PATH)) {
      const txt = readFileSync(LOCK_PATH, "utf-8").trim();
      if (txt) {
        const stale = JSON.parse(txt) as DaemonLock;
        if (stale.pid === lock.pid) unlinkSync(LOCK_PATH);
      }
    }
  } catch (e) {
    log(`stale lock cleanup failed: ${e}`);
  }
  spawnDaemon();
}

/**
 * Ensure the running daemon matches the plugin version Claude Code currently
 * has installed (this hook's CLAUDE_PLUGIN_ROOT). Returns the lock to use for
 * the subsequent register ping — the successor's lock after a handoff, or the
 * original when no reconciliation was needed.
 *
 * Decision order:
 *   1. If the daemon advertises a plugin_root (lock or /api/health) and it
 *      matches ours → up to date, no-op (the steady-state fast path).
 *   2. plugin_root present but different → hand off to ours.
 *   3. plugin_root absent everywhere (pre-feature daemon) → compare versions;
 *      reconcile only when they differ.
 * Reconciliation tries the clean /api/restart-to handoff first, then falls
 * back to brute-force kill+respawn. Always returns a usable lock (never null)
 * so the caller's register ping still fires — matching the pre-feature
 * guarantee that a live daemon was always pinged. On a fully-failed
 * reconcile it returns the original lock; the subsequent ping is best-effort
 * and silently times out if nothing is listening.
 */
async function reconcileVersion(lock: DaemonLock, expectedRoot: string): Promise<DaemonLock> {
  let daemonRoot: string | null = lock.plugin_root ?? null;

  // Fast path: lock already tells us the root and it matches — no HTTP, no
  // version read, just two normalized string compares.
  if (daemonRoot && normalizePath(daemonRoot) === normalizePath(expectedRoot)) {
    return lock;
  }

  let daemonVersion: string | null = lock.plugin_version ?? null;
  if (!daemonRoot) {
    // Pre-feature lock (no plugin_root). Ask /api/health — a post-feature
    // daemon returns plugin_root there even if its lock predates the field.
    const health = await fetchHealth(lock);
    if (health) {
      daemonRoot = health.plugin_root ?? null;
      daemonVersion = health.plugin_version ?? daemonVersion;
    }
    if (daemonRoot && normalizePath(daemonRoot) === normalizePath(expectedRoot)) {
      return lock;
    }
  }

  // Decide whether a handoff is warranted.
  let mismatch: boolean;
  if (daemonRoot) {
    mismatch = normalizePath(daemonRoot) !== normalizePath(expectedRoot);
  } else {
    // Truly pre-feature: fall back to version comparison.
    const expectedVersion = readVersionAt(expectedRoot);
    mismatch = !!daemonVersion && !!expectedVersion && daemonVersion !== expectedVersion;
  }
  if (!mismatch) return lock;

  log(
    `daemon version mismatch (daemon root=${daemonRoot ?? "?"} v=${daemonVersion ?? "?"}, ` +
      `expected root=${expectedRoot}) — reconciling`,
  );

  if (await requestCleanHandoff(lock, expectedRoot)) {
    const successor = await waitForSuccessor(lock.pid);
    if (successor) {
      log(`clean handoff complete → pid=${successor.pid} v=${successor.plugin_version}`);
      return successor;
    }
    log(`clean handoff acked but no successor appeared; falling back to brute-force`);
  }

  await bruteForceRestart(lock);
  // Never return null: prefer the fresh successor, else whatever lock is on
  // disk now, else the original so the caller still attempts a register ping.
  return (await waitForSuccessor(lock.pid)) ?? readLock() ?? lock;
}

async function pingRegister(
  lock: DaemonLock,
  projectRoot: string,
  worktree: string | null,
): Promise<void> {
  try {
    const body = JSON.stringify({
      project_root: projectRoot,
      project_name: projectRoot.split(/[\\/]/).pop() ?? projectRoot,
      // Pass the worktree we already resolved so daemon-emitted events
      // (e.g. /api/chat) can tag this project's worktree correctly.
      // Without this they'd write worktree:null.
      worktree,
    });
    await fetch(`http://${lock.host}:${lock.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(800),
    });
  } catch (e) {
    log(`register ping failed: ${e}`);
  }
}

function appendSessionOpened(projectRoot: string, worktree: string | null): void {
  const runtime = join(projectRoot, ".claude", "pipeline", ".runtime");
  try {
    mkdirSync(runtime, { recursive: true });
  } catch (e) {
    log(`runtime mkdir failed: ${e}`);
    return;
  }
  const journal = join(runtime, "events.jsonl");
  const evt = {
    // Keep in sync with apps/pipeline-cli/src/lib/event.ts and server.ts (v2).
    schema: 2,
    ts: new Date().toISOString(),
    type: "session.opened",
    project_root: projectRoot,
    worktree,
    run_id: null,
    parent_run_id: null,
    session_id: process.env.CLAUDE_SESSION_ID ?? null,
    data: { claude_pid: process.pid },
  };
  try {
    appendFileSync(journal, JSON.stringify(evt) + "\n", "utf-8");
  } catch (e) {
    log(`journal append failed: ${e}`);
  }
}

async function main(): Promise<void> {
  if (!pipelineUiEnabled()) {
    log("PIPELINE_UI_ENABLED explicitly opted out (0/false/no/off) — not launching daemon or registering");
    return;
  }
  // Read hook payload from stdin (Claude Code hook protocol).
  // We don't actually need the payload contents — CWD is the important signal.
  try {
    process.stdin.resume();
    process.stdin.on("data", () => {});
    setTimeout(() => process.stdin.pause(), 50);
  } catch {}

  const cwd = process.cwd();

  // Resolve the project root first (maps a git worktree to its MAIN repo +
  // records the worktree tag), then gate by walking up from cwd for ANY
  // `.claude/pipeline` ancestor. A session may be started/resumed at the
  // root, deep inside `.claude/pipeline/<name>/…`, or inside a worktree
  // under `.claude/worktrees/<name>/`; the walk-up makes registration +
  // session.opened depth- and worktree-independent. Gating on a single
  // `cwd/.claude/pipeline` (or `project_root/.claude/pipeline`) would skip
  // those nested cases.
  const { project_root, worktree } = resolveProjectRoot(cwd);

  // Only act in projects that use the pipeline plugin.
  if (!hasPipelineDirUpTo(cwd, project_root)) {
    log(`no .claude/pipeline from ${cwd} up to project root ${project_root}, skipping`);
    return;
  }

  appendSessionOpened(project_root, worktree);

  let lock = readLock();
  const alive = lock && isProcessAlive(lock.pid);
  if (!alive) {
    spawnDaemon();
    lock = await waitForDaemon();
  } else if (lock) {
    // Daemon is up — make sure it's running the version Claude Code currently
    // has installed; hand it off to our CLAUDE_PLUGIN_ROOT if it drifted.
    lock = await reconcileVersion(lock, PLUGIN_ROOT);
  }
  if (lock) await pingRegister(lock, project_root, worktree);
}

main().catch((e) => log(`top-level: ${e}`)).finally(() => process.exit(0));
