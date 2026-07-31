#!/usr/bin/env bun
/**
 * Pipeline UI supervisor (Phase 3).
 *
 * A thin process manager around the worker (`server.ts`). It exists for two
 * reasons:
 *   1. Crash recovery — if the worker exits unexpectedly (uncaught error,
 *      OOM, segfault), respawn it. A single-process daemon would just vanish;
 *      with the supervisor the dashboard self-heals.
 *   2. Continuity across version handoffs — when the worker hands off to a
 *      newer/older install (Phase 1 `/api/restart-to` or Phase 2 mid-session
 *      pickup), it drops a handoff file and exits instead of self-spawning a
 *      detached successor. The supervisor reads that file and spawns the new
 *      worker, so crash-recovery monitoring persists across the upgrade.
 *
 * The supervisor owns NO HTTP server, port, or lock. The worker still binds
 * the port and writes `daemon.lock` (now stamped with this supervisor's pid as
 * `supervisor_pid`). `lock.pid` remains the WORKER — it serves `/api/health`.
 * To STOP the daemon, signal `supervisor_pid` (and, on Windows where killing
 * the parent doesn't reap the child, the worker `pid` too); killing only the
 * worker just triggers a respawn.
 *
 * This is NOT a zero-downtime supervisor: handoffs/crash-respawns reuse the
 * worker's port-reclaim, so there is a sub-second reconnect, not a seamless
 * socket hand-off. (Socket inheritance with Bun on Windows was deemed too
 * risky — see CLAUDE.md.)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const DEBUG = process.env.PIPELINE_UI_DEBUG === "1";
const log = (msg: string) => DEBUG && console.error(`[pipeline-ui-supervisor] ${msg}`);

const HOME_DIR = process.env.PIPELINE_UI_HOME
  ? resolve(process.env.PIPELINE_UI_HOME)
  : join(homedir(), ".claude", "pipeline-ui");
const LOCK_PATH = join(HOME_DIR, "daemon.lock");
const HANDOFF_PATH = join(HOME_DIR, "worker-handoff.json");
const WORKER_STOP_PATH = join(HOME_DIR, "worker-stop");
const OWN_WORKER = join(import.meta.dir, "server.ts");
/** This supervisor's own script — the thing a version handoff must replace. */
const OWN_SCRIPT = join(import.meta.dir, "supervisor.ts");
/** Install dir this supervisor runs from, handed to the worker so it can stamp
 *  `supervisor_root` into the lock. Without it the SessionStart hook can only
 *  see the WORKER's version and a stale supervisor stays invisible. */
const OWN_PLUGIN_ROOT = resolve(import.meta.dir, "..", "..");

/** Port the outgoing supervisor asks its successor to reclaim across a
 *  self-handoff. Deliberately NOT `PIPELINE_UI_RECLAIM_PORT`: that one belongs
 *  to a worker spawn and is explicitly ignored for the FIRST worker, precisely
 *  so an inherited value cannot be mistaken for our own. This one is set only
 *  by a supervisor that is handing over, so its presence IS the intent. */
const SUPERVISOR_RECLAIM_ENV = "PIPELINE_UI_SUPERVISOR_RECLAIM_PORT";

// Crash-loop guard: if the worker dies this many times within the window
// without ever cleanly running, stop respawning and exit so we don't spin
// forever on a broken install. A new SessionStart will try again later.
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 5;
const RESPAWN_BACKOFF_MS = 1_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface HandoffRequest {
  target_script: string;
  reclaim_port?: number;
}

/** Read + delete the worker's handoff request, if present. */
function consumeHandoff(): HandoffRequest | null {
  if (!existsSync(HANDOFF_PATH)) return null;
  try {
    const req = JSON.parse(readFileSync(HANDOFF_PATH, "utf-8")) as HandoffRequest;
    try { unlinkSync(HANDOFF_PATH); } catch {}
    if (req && typeof req.target_script === "string") return req;
  } catch (e) {
    log(`bad handoff file: ${e}`);
    try { unlinkSync(HANDOFF_PATH); } catch {}
  }
  return null;
}

/** Read the last-known port from the lock so a crash-respawn reclaims it.
 *  Returns null for a missing/malformed lock or a non-positive port (which
 *  acquirePort would reject anyway), so the new worker picks a fresh port. */
function lastKnownPort(): number | null {
  try {
    const lock = JSON.parse(readFileSync(LOCK_PATH, "utf-8")) as { port?: number };
    return typeof lock.port === "number" && lock.port > 0 ? lock.port : null;
  } catch {
    return null;
  }
}

/** True if the worker asked us to stop (idle-shutdown / already_running).
 *  Consumes the sentinel. Distinguishes a deliberate stop from an external
 *  kill or crash — both of which we DO respawn. */
function consumeStopSentinel(): boolean {
  if (!existsSync(WORKER_STOP_PATH)) return false;
  try { unlinkSync(WORKER_STOP_PATH); } catch {}
  return true;
}

/** Normalize for cross-process path comparison — Windows is case-insensitive
 *  and mixes separators. Mirrors the helper in hooks/pipeline_ui_relay.ts. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const n = resolve(p).replaceAll("\\", "/");
    return process.platform === "win32" ? n.toLowerCase() : n;
  };
  return norm(a) === norm(b);
}

/**
 * Replace THIS supervisor with the one shipped alongside `targetWorker`.
 *
 * A version handoff used to upgrade the worker only: the supervisor kept
 * running whatever code it booted with, for as long as the machine stayed up,
 * so any fix inside supervisor.ts never reached a user who already had a
 * daemon running. (Observed live: a worker on 0.85.1 supervised by a 0.85.0
 * supervisor, hours after the upgrade.)
 *
 * The handoff already names the new worker script, and the new supervisor is
 * its sibling — so the outgoing supervisor has everything it needs to hand
 * over: spawn the successor detached, pass it the port to reclaim, and exit
 * WITHOUT spawning a worker (the successor does that).
 *
 * Returns false when there is nothing to replace (same install) or the
 * successor script is missing — the caller then keeps its current behaviour
 * and spawns the new worker itself, which is strictly the old semantics.
 */
function handOffToNewSupervisor(targetWorker: string, reclaimPort: number | null): boolean {
  const successor = join(dirname(targetWorker), "supervisor.ts");
  if (samePath(successor, OWN_SCRIPT)) return false; // same install — worker-only handoff
  if (!existsSync(successor)) {
    log(`successor supervisor missing (${successor}); staying on this one`);
    return false;
  }

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.PIPELINE_UI_RECLAIM_PORT; // belongs to a worker spawn, not to us
  if (reclaimPort !== null) env[SUPERVISOR_RECLAIM_ENV] = String(reclaimPort);
  else delete env[SUPERVISOR_RECLAIM_ENV];

  // Append rather than truncate: a supervisor handoff is rare, and when one
  // goes wrong the trail that led to it is exactly what is worth having.
  let outFd: number | null = null;
  let errFd: number | null = null;
  try { outFd = openSync(join(HOME_DIR, "daemon.stdout.log"), "a"); } catch {}
  try { errFd = openSync(join(HOME_DIR, "daemon.stderr.log"), "a"); } catch {}
  try {
    const child = spawn(process.execPath, [successor], {
      detached: true,
      stdio: ["ignore", outFd ?? "ignore", errFd ?? "ignore"],
      env,
      windowsHide: true,
    });
    child.unref();
    log(`handed off to successor supervisor ${successor} (pid ${child.pid})`);
    return true;
  } catch (e) {
    log(`failed to spawn successor supervisor: ${e}`);
    return false;
  } finally {
    if (outFd !== null) { try { closeSync(outFd); } catch {} }
    if (errFd !== null) { try { closeSync(errFd); } catch {} }
  }
}

async function main(): Promise<void> {
  mkdirSync(HOME_DIR, { recursive: true });
  // Clear any stale handoff / stop sentinel from a previous daemon generation
  // so we don't act on it at startup.
  try { if (existsSync(HANDOFF_PATH)) unlinkSync(HANDOFF_PATH); } catch {}
  try { if (existsSync(WORKER_STOP_PATH)) unlinkSync(WORKER_STOP_PATH); } catch {}

  let targetScript = OWN_WORKER;
  // Always start the FIRST worker on a fresh port — a PIPELINE_UI_RECLAIM_PORT
  // possibly inherited from an ancestor's env is not ours to reclaim. Reclaim
  // is set only by our own handoff/crash logic below. The ONE exception is a
  // port handed over by the supervisor we are replacing (its own env var, set
  // only by a deliberate handoff), so open browser tabs survive the swap.
  let reclaimPort: number | null = null;
  const inherited = Number(process.env[SUPERVISOR_RECLAIM_ENV] ?? "");
  if (Number.isInteger(inherited) && inherited > 0) {
    reclaimPort = inherited;
    log(`reclaiming port ${inherited} from the supervisor we replaced`);
  }
  // Consume it: it describes this boot only, and every child we spawn inherits
  // our environment.
  delete process.env[SUPERVISOR_RECLAIM_ENV];
  let child: ChildProcess | null = null;
  let shuttingDown = false;
  const crashes: number[] = [];

  const stop = () => {
    shuttingDown = true;
    try { child?.kill(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!shuttingDown) {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PIPELINE_UI_SUPERVISOR_PID: String(process.pid),
      // The worker stamps this into the lock so the SessionStart hook can see
      // a STALE SUPERVISOR, not just a stale worker.
      PIPELINE_UI_SUPERVISOR_ROOT: OWN_PLUGIN_ROOT,
    };
    if (reclaimPort !== null) env.PIPELINE_UI_RECLAIM_PORT = String(reclaimPort);
    else delete env.PIPELINE_UI_RECLAIM_PORT;

    log(`spawning worker ${targetScript}${reclaimPort !== null ? ` (reclaim ${reclaimPort})` : ""}`);
    // node:child_process rather than Bun.spawn, which has no windowsHide: the
    // worker then allocated its own console, and on Windows 11 - where the
    // default terminal is Windows Terminal - that console surfaces as a real
    // VISIBLE window titled with bun's exe path. Closing it kills the worker,
    // which we dutifully respawn, so it reads as a window that refuses to go
    // away. The SessionStart hook already spawns THIS process with
    // windowsHide, which is why the supervisor never had one.
    child = spawn(process.execPath, [targetScript], {
      env,
      // Inherit so the worker's boot line + logs flow to whatever the launcher
      // redirected this supervisor's stdout/stderr to (the daemon log files).
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    const code = await new Promise<number>((resolveExit) => {
      child!.once("exit", (exitCode) => resolveExit(exitCode ?? 0));
      child!.once("error", () => resolveExit(-1));
    });
    if (shuttingDown) return;

    // Decision is driven by sentinel files, NOT the exit code — the worker's
    // exit code is 0 for BOTH a deliberate idle stop and an external SIGTERM,
    // so the code alone can't tell "stop" from "respawn".
    //   1. handoff file  → spawn the new (version) worker;
    //   2. stop sentinel → deliberate stop (idle / already_running) → exit;
    //   3. neither       → crash or external kill → respawn (crash-capped).
    const handoff = consumeHandoff();
    if (handoff) {
      if (!existsSync(handoff.target_script)) {
        log(`handoff target missing (${handoff.target_script}); keeping current worker`);
        targetScript = OWN_WORKER;
      } else {
        targetScript = handoff.target_script;
      }
      reclaimPort = handoff.reclaim_port ?? lastKnownPort();
      // A version handoff replaces the WHOLE daemon, this process included —
      // otherwise supervisor.ts fixes never reach a machine whose daemon is
      // already up. The successor spawns the new worker; we must not also do
      // it, or the port would be contended by two workers.
      if (handOffToNewSupervisor(targetScript, reclaimPort)) return;
      continue;
    }

    if (consumeStopSentinel()) {
      log(`worker requested stop (idle / already_running); supervisor stopping`);
      return;
    }

    // Unexpected exit (crash or external kill) → respawn.
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > CRASH_WINDOW_MS) crashes.shift();
    if (crashes.length >= CRASH_LIMIT) {
      console.error(
        `[pipeline-ui-supervisor] worker exited unexpectedly ${crashes.length} times in ` +
          `${CRASH_WINDOW_MS / 1000}s (last code ${code}); giving up`,
      );
      return;
    }
    log(`worker exited unexpectedly (code ${code}); respawning after ${RESPAWN_BACKOFF_MS}ms`);
    // Reclaim the same port the dead worker held so open tabs reconnect.
    reclaimPort = lastKnownPort() ?? reclaimPort;
    // Respawn the SAME version that died (targetScript unchanged) — never
    // silently downgrade to OWN_WORKER after a handoff. A genuinely broken
    // version trips the cap above and the supervisor exits, letting the next
    // SessionStart reconcile afresh.
    await sleep(RESPAWN_BACKOFF_MS);
  }
}

main().catch((e) => {
  console.error(`[pipeline-ui-supervisor] fatal: ${e}`);
  process.exit(1);
});
