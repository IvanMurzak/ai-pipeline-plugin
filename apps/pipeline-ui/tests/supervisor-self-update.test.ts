/**
 * Supervisor self-update: a version handoff replaces the SUPERVISOR too.
 *
 * @serial — real supervisor + worker processes on an isolated PIPELINE_UI_HOME;
 * flakes under N-way CPU load, same as supervisor.test.ts / restart-to.test.ts.
 *
 * Regression: a version handoff upgraded the WORKER only. The supervisor kept
 * running whatever code it booted with for as long as the machine stayed up,
 * so a fix inside supervisor.ts could never reach a user who already had a
 * daemon running. Seen live: a worker on 0.85.1 supervised by a 0.85.0
 * supervisor, hours after the upgrade — and the SessionStart hook could not
 * see it either, because the lock only reported the worker's install.
 *
 * The handoff already names the new worker script, and the new supervisor is
 * its sibling, so the outgoing supervisor has everything it needs to hand over.
 * The successor here is a stub that records what it was given: the real
 * supervisor.ts is what is under test, not the one being spawned.
 *
 *   bun test tests/supervisor-self-update.test.ts
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";

const TEST_HOME = mkdtempSync(join(tmpdir(), "pui-selfupd-home-"));
const FAKE_INSTALL = mkdtempSync(join(tmpdir(), "pui-selfupd-next-"));
const LOCK_PATH = join(TEST_HOME, "daemon.lock");
const HANDOFF_PATH = join(TEST_HOME, "worker-handoff.json");
const SUPERVISOR_TS = join(import.meta.dir, "..", "supervisor.ts");

/** Where the stub successor records that it ran, and with what. */
const MARKER = join(FAKE_INSTALL, "successor-ran.json");

interface Lock {
  pid: number;
  port: number;
  host: string;
  supervisor_pid?: number;
  supervisor_root?: string;
}

let supervisor: Subprocess | null = null;

function readLock(): Lock | null {
  try {
    const txt = readFileSync(LOCK_PATH, "utf-8").trim();
    return txt ? (JSON.parse(txt) as Lock) : null;
  } catch {
    return null;
  }
}

async function healthy(lock: Lock): Promise<boolean> {
  try {
    const r = await fetch(`http://${lock.host}:${lock.port}/api/health`);
    return r.ok;
  } catch {
    return false;
  }
}

async function waitForWorker(excludePids: number[], maxMs = 20000): Promise<Lock> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const lock = readLock();
    if (lock && !excludePids.includes(lock.pid) && (await healthy(lock))) return lock;
    await Bun.sleep(200);
  }
  throw new Error("no healthy worker appeared");
}

async function waitFor(predicate: () => boolean, maxMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (predicate()) return;
    await Bun.sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  // A "newer install": a supervisor.ts stub that records its argv/env and
  // exits, plus a server.ts so the outgoing supervisor's existence check on
  // the handoff target passes.
  mkdirSync(FAKE_INSTALL, { recursive: true });
  writeFileSync(
    join(FAKE_INSTALL, "supervisor.ts"),
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(MARKER)}, JSON.stringify({`,
      "  reclaim: process.env.PIPELINE_UI_SUPERVISOR_RECLAIM_PORT ?? null,",
      "  home: process.env.PIPELINE_UI_HOME ?? null,",
      "  worker_reclaim: process.env.PIPELINE_UI_RECLAIM_PORT ?? null,",
      "}));",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(join(FAKE_INSTALL, "server.ts"), "// stand-in worker; never executed by this test\n", "utf-8");

  supervisor = Bun.spawn({
    cmd: [process.execPath, SUPERVISOR_TS],
    cwd: tmpdir(),
    env: { ...process.env, PIPELINE_UI_HOME: TEST_HOME, PIPELINE_UI_DEBUG: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
}, 40000);

afterAll(async () => {
  const lock = readLock();
  if (lock?.pid) { try { process.kill(lock.pid, "SIGKILL"); } catch {} }
  if (supervisor) {
    supervisor.kill();
    try { await supervisor.exited; } catch {}
  }
  if (lock?.supervisor_pid) { try { process.kill(lock.supervisor_pid, "SIGKILL"); } catch {} }
  try { if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH); } catch {}
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  try { rmSync(FAKE_INSTALL, { recursive: true, force: true }); } catch {}
}, 40000);

test("the worker reports the supervisor's install dir, so a stale one is visible", async () => {
  const lock = await waitForWorker([]);
  // Without this the lock only ever described the WORKER, and a supervisor
  // left behind on an older install was undetectable from outside.
  expect(typeof lock.supervisor_root).toBe("string");
  expect(existsSync(join(lock.supervisor_root!, "apps", "pipeline-ui", "supervisor.ts"))).toBe(true);
}, 40000);

test("a handoff to another install replaces the supervisor, not just the worker", async () => {
  const before = await waitForWorker([]);
  const supervisorPid = supervisor!.pid as number;
  expect(before.supervisor_pid).toBe(supervisorPid);

  // Exactly what the worker drops on a version handoff: the successor worker's
  // path plus the port to reclaim.
  writeFileSync(
    HANDOFF_PATH,
    JSON.stringify({ target_script: join(FAKE_INSTALL, "server.ts"), reclaim_port: before.port }),
    "utf-8",
  );
  // Then it exits — which is what wakes the supervisor's loop.
  process.kill(before.pid, "SIGKILL");

  // The successor supervisor from the OTHER install must run...
  await waitFor(() => existsSync(MARKER), 30000, "the successor supervisor to start");
  const got = JSON.parse(readFileSync(MARKER, "utf-8")) as {
    reclaim: string | null;
    home: string | null;
    worker_reclaim: string | null;
  };

  // ...carrying the port to reclaim, so open browser tabs survive the swap...
  expect(got.reclaim).toBe(String(before.port));
  // ...on the same daemon home...
  expect(got.home).toBe(TEST_HOME);
  // ...and NOT carrying the worker-scoped reclaim var, which is deliberately
  // ignored for a first worker and would silently do nothing.
  expect(got.worker_reclaim).toBeNull();

  // ...and the outgoing supervisor must be gone, having spawned NO worker of
  // its own — two supervisors would contend for the port.
  await waitFor(() => supervisor!.exitCode !== null || supervisor!.killed, 20000, "the old supervisor to exit");
  expect(supervisor!.exitCode === null && !supervisor!.killed).toBe(false);
}, 60000);
