/**
 * Supervisor (Phase 3) integration tests: crash-recovery + lock stamping.
 *
 * Spawns supervisor.ts on an isolated PIPELINE_UI_HOME (own lock + seed port),
 * confirms it brings up a worker that serves /api/health and stamps
 * supervisor_pid into the lock, then KILLS the worker and asserts the
 * supervisor respawns a fresh worker (new pid, same port).
 *
 *   bun test tests/supervisor.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";

const TEST_HOME = mkdtempSync(join(tmpdir(), "pui-sup-home-"));
const LOCK_PATH = join(TEST_HOME, "daemon.lock");
const SUPERVISOR_TS = join(import.meta.dir, "..", "supervisor.ts");

interface Lock {
  pid: number;
  port: number;
  host: string;
  supervisor_pid?: number;
}
interface Health { ok: boolean; pid: number }

let supervisor: Subprocess | null = null;

function readLock(): Lock | null {
  try {
    const txt = readFileSync(LOCK_PATH, "utf-8").trim();
    return txt ? (JSON.parse(txt) as Lock) : null;
  } catch {
    return null;
  }
}

async function health(lock: Lock): Promise<Health | null> {
  try {
    const r = await fetch(`http://${lock.host}:${lock.port}/api/health`);
    return r.ok ? ((await r.json()) as Health) : null;
  } catch {
    return null;
  }
}

/** Wait for a healthy worker whose pid is NOT in `excludePids`. */
async function waitForWorker(excludePids: number[], maxMs = 15000): Promise<Lock> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const lock = readLock();
    if (lock && !excludePids.includes(lock.pid)) {
      const h = await health(lock);
      if (h?.ok) return lock;
    }
    await Bun.sleep(200);
  }
  throw new Error("no healthy worker appeared");
}

beforeAll(async () => {
  supervisor = Bun.spawn({
    cmd: [process.execPath, SUPERVISOR_TS],
    cwd: tmpdir(),
    env: { ...process.env, PIPELINE_UI_HOME: TEST_HOME, PIPELINE_UI_DEBUG: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
}, 30000);

afterAll(async () => {
  // Kill the worker first (so the supervisor doesn't respawn it), then the
  // supervisor, then clean the isolated home.
  const lock = readLock();
  if (lock?.pid) { try { process.kill(lock.pid, "SIGKILL"); } catch {} }
  if (supervisor) {
    supervisor.kill();
    try { await supervisor.exited; } catch {}
  }
  if (lock?.supervisor_pid) { try { process.kill(lock.supervisor_pid, "SIGKILL"); } catch {} }
  try { if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH); } catch {}
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
}, 30000);

describe("supervisor", () => {
  test("brings up a worker and stamps supervisor_pid into the lock", async () => {
    const lock = await waitForWorker([]);
    expect(lock.pid).toBeGreaterThan(0);
    // The lock's supervisor_pid must be the supervisor process we spawned.
    expect(lock.supervisor_pid).toBe(supervisor!.pid as number);
    // pid (worker) and supervisor_pid must be different processes.
    expect(lock.pid).not.toBe(lock.supervisor_pid);
  }, 30000);

  test("respawns the worker after a hard kill / crash (SIGKILL → same port)", async () => {
    const before = await waitForWorker([]);
    const oldPid = before.pid;
    const oldPort = before.port;

    // Hard kill: no cleanup runs, the lock keeps the dead pid+port, so the
    // supervisor reclaims that port.
    process.kill(oldPid, "SIGKILL");

    const after = await waitForWorker([oldPid]);
    expect(after.pid).not.toBe(oldPid);
    expect(after.port).toBe(oldPort);
    expect(after.supervisor_pid).toBe(supervisor!.pid as number);
  }, 30000);

  test("respawns after SIGTERM too (exit 0 must NOT be read as a clean stop)", async () => {
    const before = await waitForWorker([]);
    const oldPid = before.pid;

    // On POSIX a SIGTERM runs the worker's cleanup → exit 0; on Windows it's a
    // hard terminate. Either way there's NO stop-sentinel, so the supervisor
    // must treat it as an external kill and respawn — the regression the
    // sentinel-driven decision fixes (exit code 0 alone is ambiguous).
    process.kill(oldPid, "SIGTERM");

    const after = await waitForWorker([oldPid]);
    expect(after.pid).not.toBe(oldPid);
    expect(after.supervisor_pid).toBe(supervisor!.pid as number);
  }, 30000);
});
