/**
 * /api/restart-to + version-reconciliation integration tests.
 *
 * @serial — real daemon boot with bounded health-waits; state-isolated (own
 * PIPELINE_UI_HOME → own lock + seed port) but flakes under N-way CPU load,
 * so the parallel test runner runs this file solo after the pool drains.
 *
 * Spins up a real daemon on the shared lock/port (same harness as
 * server.test.ts — so it assumes no OTHER pipeline-ui daemon is running),
 * exercises the input validation, then performs ONE real handoff to an
 * equivalent-but-different plugin_root and verifies a successor takes over.
 *
 *   bun test tests/restart-to.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";

// Isolate this suite onto its OWN daemon state dir via PIPELINE_UI_HOME so it
// can't collide with server.test.ts on the shared ~/.claude/pipeline-ui lock +
// seed port. The seed port is derived from the home dir, so a unique home also
// means a unique port — the runner can execute both daemon suites in parallel
// without either killing the other's daemon. (This was the CI flake: the
// shared lock/port made the two suites fight, so neither became healthy.)
const TEST_HOME = mkdtempSync(join(tmpdir(), "pui-home-"));
const LOCK_PATH = join(TEST_HOME, "daemon.lock");
// server.ts lives at apps/pipeline-ui/server.ts; the plugin root is two up.
const PLUGIN_ROOT = resolve(import.meta.dir, "..", "..", "..");
const SERVER_TS = join(import.meta.dir, "..", "server.ts");

interface HealthBody {
  ok: boolean;
  plugin_version: string;
  plugin_root: string;
  schema: number;
  pid: number;
}

interface Lock {
  pid: number;
  port: number;
  host: string;
  plugin_root?: string;
}

let daemon: Subprocess | null = null;
let baseUrl = "";
let originalPid = 0;

function normalizePath(p: string): string {
  const n = resolve(p).replaceAll("\\", "/");
  return process.platform === "win32" ? n.toLowerCase() : n;
}

/** Remove a junction (Windows) or symlink (POSIX) WITHOUT following it into
 *  its target. rmdir removes a junction reparse point; unlink removes a POSIX
 *  symlink. Never use recursive rm here — on some runtimes it would descend
 *  through the link and delete the REAL repo dirs the junctions point at. */
function removeLink(p: string): void {
  try { rmdirSync(p); return; } catch { /* not a junction / not present */ }
  try { unlinkSync(p); } catch { /* not a symlink / not present */ }
}

/** Tear down the symlinked alternate plugin root safely: drop the junctions
 *  first, then the (now-empty) container dir. */
function safeRemoveAltRoot(altRoot: string): void {
  for (const name of ["apps", ".claude-plugin"]) removeLink(join(altRoot, name));
  try { rmdirSync(altRoot); } catch { /* best effort */ }
}

function readLock(): Lock | null {
  try {
    const txt = readFileSync(LOCK_PATH, "utf-8").trim();
    return txt ? (JSON.parse(txt) as Lock) : null;
  } catch {
    return null;
  }
}

async function waitForLock(maxMs = 8000): Promise<HealthBody> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const lock = readLock();
    if (lock) {
      try {
        const r = await fetch(`http://${lock.host}:${lock.port}/api/health`);
        if (r.ok) {
          baseUrl = `http://${lock.host}:${lock.port}`;
          return (await r.json()) as HealthBody;
        }
      } catch {
        /* keep polling */
      }
    }
    await Bun.sleep(150);
  }
  throw new Error("daemon never became healthy");
}

/** Wait for a lock whose pid differs from `oldPid` and answers /api/health. */
async function waitForSuccessor(oldPid: number, maxMs = 8000): Promise<HealthBody | null> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const lock = readLock();
    if (lock && lock.pid !== oldPid) {
      try {
        const r = await fetch(`http://${lock.host}:${lock.port}/api/health`);
        if (r.ok) {
          baseUrl = `http://${lock.host}:${lock.port}`;
          return (await r.json()) as HealthBody;
        }
      } catch {
        /* keep polling */
      }
    }
    await Bun.sleep(150);
  }
  return null;
}

/** Kill any daemon recorded in the shared lock and remove it, so this suite
 *  starts from a clean slate regardless of what a prior daemon-spawning test
 *  file (e.g. server.test.ts) left behind. They share one lock + one seed
 *  port, so without this the prior daemon's leftovers (or a port still in
 *  TIME_WAIT) slow our boot enough to blow a tight hook timeout in CI. */
async function resetDaemonState(): Promise<void> {
  const lock = readLock();
  if (lock?.pid) {
    try { process.kill(lock.pid, "SIGKILL"); } catch {}
  }
  try { if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH); } catch {}
  // Brief pause so the OS releases the listening socket before we rebind.
  await Bun.sleep(300);
}

// Explicit generous timeouts: the daemon does liveness probes + may walk past
// a seed port held in TIME_WAIT by a prior test file's daemon, so boot can
// take several seconds on slow CI. waitForLock's 8s budget must fit INSIDE the
// hook timeout — the default 5s would kill beforeAll before waitForLock even
// finishes (the original cause of the CI flake).
beforeAll(async () => {
  await resetDaemonState();
  daemon = Bun.spawn({
    cmd: [process.execPath, SERVER_TS],
    cwd: tmpdir(),
    // PIPELINE_UI_HOME isolates this daemon's lock + seed port from every other
    // suite. The successor spawned during a handoff inherits it (spawnSuccessor
    // forwards process.env), so the whole handoff stays inside TEST_HOME.
    env: { ...process.env, PIPELINE_UI_HOME: TEST_HOME, PIPELINE_UI_DEBUG: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const health = await waitForLock();
  expect(health.ok).toBe(true);
  originalPid = health.pid;
}, 30000);

afterAll(async () => {
  // Kill whatever daemon currently holds the lock (the successor after a
  // handoff is detached and is NOT the `daemon` subprocess), plus the
  // original subprocess if it's somehow still alive.
  const lock = readLock();
  if (lock?.pid) {
    try { process.kill(lock.pid, "SIGKILL"); } catch {}
  }
  if (daemon) {
    daemon.kill();
    try { await daemon.exited; } catch {}
  }
  try { if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH); } catch {}
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
}, 30000);

describe("/api/health plugin_root", () => {
  test("advertises the install dir the daemon runs from", async () => {
    const r = await fetch(`${baseUrl}/api/health`);
    const j = (await r.json()) as HealthBody;
    expect(typeof j.plugin_root).toBe("string");
    expect(normalizePath(j.plugin_root)).toBe(normalizePath(PLUGIN_ROOT));
  });
});

describe("/api/restart-to validation", () => {
  test("rejects a non-JSON / malformed body", async () => {
    const r = await fetch(`${baseUrl}/api/restart-to`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(r.status).toBe(400);
  });

  test("rejects a body missing pid/plugin_root", async () => {
    const r = await fetch(`${baseUrl}/api/restart-to`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plugin_root: PLUGIN_ROOT }),
    });
    expect(r.status).toBe(400);
  });

  test("rejects a pid that targets a different daemon (409)", async () => {
    const r = await fetch(`${baseUrl}/api/restart-to`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid: originalPid + 999999, plugin_root: PLUGIN_ROOT }),
    });
    expect(r.status).toBe(409);
  });

  test("rejects a plugin_root with no apps/pipeline-ui/server.ts (400)", async () => {
    const bogus = mkdtempSync(join(tmpdir(), "pui-bogus-root-"));
    try {
      const r = await fetch(`${baseUrl}/api/restart-to`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid: originalPid, plugin_root: bogus }),
      });
      expect(r.status).toBe(400);
    } finally {
      rmSync(bogus, { recursive: true, force: true });
    }
  });

  test("same-root request is an explicit no-op (restarted:false)", async () => {
    const r = await fetch(`${baseUrl}/api/restart-to`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid: originalPid, plugin_root: PLUGIN_ROOT }),
    });
    expect(r.ok).toBe(true);
    const j = (await r.json()) as { ok: boolean; restarted: boolean };
    expect(j.ok).toBe(true);
    expect(j.restarted).toBe(false);
    // Daemon must NOT have restarted — pid unchanged.
    const lock = readLock();
    expect(lock?.pid).toBe(originalPid);
  });
});

describe("real handoff", () => {
  test("hands off to an equivalent alternate plugin_root", async () => {
    // Build an alternate root that resolves to a DIFFERENT path but contains
    // the same daemon code via symlinks. Skip gracefully if the platform
    // forbids symlink/junction creation (unprivileged Windows without
    // developer mode).
    const altRoot = mkdtempSync(join(tmpdir(), "pui-alt-root-"));
    let linked = false;
    try {
      symlinkSync(join(PLUGIN_ROOT, "apps"), join(altRoot, "apps"), "junction");
      symlinkSync(
        join(PLUGIN_ROOT, ".claude-plugin"),
        join(altRoot, ".claude-plugin"),
        "junction",
      );
      linked = true;
    } catch (e) {
      console.warn(`skipping real-handoff test — cannot create symlinks: ${e}`);
    }
    if (!linked) {
      safeRemoveAltRoot(altRoot);
      return;
    }

    try {
      const before = readLock();
      expect(before?.pid).toBe(originalPid);

      const r = await fetch(`${baseUrl}/api/restart-to`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid: originalPid, plugin_root: altRoot }),
      });
      expect(r.ok).toBe(true);
      const j = (await r.json()) as { ok: boolean; restarted: boolean };
      expect(j.restarted).toBe(true);

      // A successor with a fresh pid must take over and be healthy — this
      // proves the full handoff sequence (stop server → delete lock → spawn
      // detached successor → exit) worked end to end.
      //
      // We deliberately do NOT assert that successor.plugin_root === altRoot:
      // the daemon derives PLUGIN_ROOT from `import.meta.dir`, and Bun
      // resolves that through the symlinks this test uses to build altRoot, so
      // it reports the real repo path. In production the plugin cache is real
      // directories (no symlinks), so PLUGIN_ROOT is the cache path as
      // intended — verified by the /api/health test above against the real
      // install. Here we only assert the restart actually happened.
      const successor = await waitForSuccessor(originalPid);
      expect(successor).not.toBeNull();
      expect(successor!.ok).toBe(true);
      expect(successor!.pid).not.toBe(originalPid);
      expect(typeof successor!.plugin_root).toBe("string");
    } finally {
      // Kill the successor and tidy up the symlinked root.
      const lock = readLock();
      if (lock?.pid) {
        try { process.kill(lock.pid, "SIGKILL"); } catch {}
      }
      safeRemoveAltRoot(altRoot);
    }
  }, 30000);
});
