/**
 * /api/update-status + /api/restart integration tests.
 *
 * @serial — real daemon boot with bounded health-waits; flakes under N-way
 * CPU load, so the parallel test runner runs this file solo (see
 * restart-to.test.ts for the same pragma).
 *
 * Same harness pattern as restart-to.test.ts: an isolated PIPELINE_UI_HOME
 * gives this suite its own lock + seed port, so it can run alongside the
 * other daemon-spawning suites. Exercises the update-status shape (no
 * installed_plugins.json in a source checkout → update:null) and ONE real
 * same-root self-restart, verifying a successor with a fresh pid takes over
 * on the same port — the exact mechanism behind the UI's "Update & Restart"
 * button and `pipeline ui --restart`.
 *
 *   bun test tests/restart-self.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";

const TEST_HOME = mkdtempSync(join(tmpdir(), "pui-home-"));
const LOCK_PATH = join(TEST_HOME, "daemon.lock");
const PLUGIN_ROOT = resolve(import.meta.dir, "..", "..", "..");
const SERVER_TS = join(import.meta.dir, "..", "server.ts");

interface HealthBody {
  ok: boolean;
  plugin_version: string;
  plugin_root: string;
  pid: number;
}

interface UpdateStatusBody {
  current_version: string;
  current_plugin_root: string;
  update: { plugin_root: string; version: string } | null;
  restarting: boolean;
}

interface Lock {
  pid: number;
  port: number;
  host: string;
}

let daemon: Subprocess | null = null;
let baseUrl = "";
let originalPid = 0;

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

beforeAll(async () => {
  daemon = Bun.spawn({
    cmd: [process.execPath, SERVER_TS],
    cwd: tmpdir(),
    env: {
      ...process.env,
      PIPELINE_UI_HOME: TEST_HOME,
      PIPELINE_UI_DEBUG: "0",
      // Point at a nonexistent installed_plugins.json so update-status is
      // deterministic (update:null) regardless of the host machine's real
      // plugin cache.
      PIPELINE_UI_INSTALLED_PLUGINS_PATH: join(TEST_HOME, "no-such-installed_plugins.json"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const health = await waitForLock();
  expect(health.ok).toBe(true);
  originalPid = health.pid;
}, 30000);

afterAll(async () => {
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

describe("/api/update-status", () => {
  test("reports current version/root and no pending update without a plugin cache", async () => {
    const r = await fetch(`${baseUrl}/api/update-status`);
    expect(r.ok).toBe(true);
    const j = (await r.json()) as UpdateStatusBody;
    expect(typeof j.current_version).toBe("string");
    expect(j.current_version.length).toBeGreaterThan(0);
    expect(j.current_plugin_root.replaceAll("\\", "/").toLowerCase()).toBe(
      PLUGIN_ROOT.replaceAll("\\", "/").toLowerCase(),
    );
    expect(j.update).toBeNull();
    expect(j.restarting).toBe(false);
  });
});

describe("POST /api/restart", () => {
  test("same-root self-restart hands off to a fresh pid on the same port", async () => {
    const before = readLock();
    expect(before?.pid).toBe(originalPid);
    const portBefore = before!.port;

    const r = await fetch(`${baseUrl}/api/restart`, { method: "POST" });
    expect(r.ok).toBe(true);
    const j = (await r.json()) as {
      ok: boolean;
      restarted: boolean;
      updated: boolean;
      from_version: string;
      to_version: string;
    };
    expect(j.ok).toBe(true);
    expect(j.restarted).toBe(true);
    // No pending update in this environment → same-root re-exec.
    expect(j.updated).toBe(false);
    expect(j.to_version).toBe(j.from_version);

    const successor = await waitForSuccessor(originalPid);
    expect(successor).not.toBeNull();
    expect(successor!.ok).toBe(true);
    expect(successor!.pid).not.toBe(originalPid);
    // Port reclaim: open tabs must reconnect to the SAME url.
    expect(readLock()!.port).toBe(portBefore);
  }, 30000);
});
