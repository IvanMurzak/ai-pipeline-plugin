#!/usr/bin/env bun
/**
 * Pipeline plugin — SessionStart hook: mesh background notifier
 * (department-mesh design, task a1, the Q2 owner override —
 * 12-user-workflows.md Persona B: "a parked task announces itself instead
 * of waiting to be polled").
 *
 * Two independent, best-effort jobs — neither may ever block Claude Code
 * startup or throw past main():
 *
 *   1. ENSURE THE DAEMON IS RUNNING. Spawns `pipeline mesh notify`
 *      (apps/pipeline-cli/src/commands/mesh.ts) detached, so it keeps
 *      polling the caller's open department-mesh tasks and firing OS-level
 *      toasts even after THIS Claude Code session ends — a plain MCP client
 *      has no push channel once the session that opened `/mcp` is gone, so
 *      the plugin ships one. Single-instance-guarded by a pid+started_at
 *      lock file at <credential-dir>/mesh-notify-daemon.lock (same per-user
 *      directory apps/pipeline-cli/src/lib/cloud-config.ts already uses for
 *      the cloud credential store) — never spawned twice; respawned if the
 *      previous instance died. Deliberately far simpler than
 *      pipeline_ui_relay.ts's daemon: no HTTP health checks, no version
 *      handoff — the notifier has no listening port and nothing project-
 *      scoped to reconcile, so "is the pid alive" is the whole contract.
 *
 *   2. DRAIN PENDING NOTIFICATIONS. The daemon durably queues every newly
 *      detected INPUT_REQUIRED/AUTH_REQUIRED or terminal transition (see
 *      lib/mesh-notify.ts's pending-notification journal) so nothing is
 *      lost even if the OS toast was missed, dismissed, or unsupported on
 *      the machine. This hook drains that queue and surfaces it as
 *      SessionStart additionalContext — the durable fallback channel, shown
 *      the next time Claude Code opens ANY session, in ANY project (mesh
 *      tasks are org-scoped, not project-scoped, and SessionStart fires for
 *      every session regardless of cwd — code.claude.com/docs/en/hooks.md).
 *      Draining is itself the "shown once" contract: a second SessionStart
 *      with nothing new pending emits no context, so this never repeats.
 *
 * No-ops entirely (spawns nothing, drains nothing) if the user has never run
 * `pipeline cloud connect` — no credential store file means there is nothing
 * to poll yet, and spawning a daemon that would only ever no-op is wasted
 * work re-attempted (cheaply) on every future SessionStart once a credential
 * does appear.
 *
 * Gated by PIPELINE_MESH_NOTIFY_ENABLED — ON BY DEFAULT, same falsy-value
 * opt-out convention as PIPELINE_UI_ENABLED (0/false/no/off disables; any
 * other value, including unset, leaves it enabled).
 *
 * Stdin payload / stdout contract: SessionStart hook
 * (https://code.claude.com/docs/en/hooks.md) — stdin carries
 * { session_id, cwd, hook_event_name: "SessionStart", source, ... }; stdout
 * on a non-empty pending queue is
 * { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

import {
  credentialDir,
  credentialFilePath,
  realFs,
  type HomeContext,
} from "../apps/pipeline-cli/src/lib/cloud-config.ts";
import {
  drainPendingNotifications,
  notifyLockPath,
  notificationBody,
  type TaskNotification,
} from "../apps/pipeline-cli/src/lib/mesh-notify.ts";

const DEBUG = process.env.PIPELINE_UI_DEBUG === "1";
const log = (msg: string) => DEBUG && console.error(`[mesh_notifier_relay] ${msg}`);

/** Master enable switch — mirrors pipeline_ui_relay.ts's pipelineUiEnabled():
 *  ON by default; only an explicit falsy value opts out. */
export function meshNotifyEnabled(): boolean {
  const v = (process.env.PIPELINE_MESH_NOTIFY_ENABLED ?? "").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? resolve(import.meta.dir, "..");
const CLI_ENTRY = join(PLUGIN_ROOT, "apps", "pipeline-cli", "src", "cli.ts");

interface DaemonLock {
  pid: number;
  started_at: string;
}

function homeCtx(): HomeContext {
  return { platform: process.platform, env: process.env, homedir: homedir() };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(lockPath: string): DaemonLock | null {
  if (!existsSync(lockPath)) return null;
  try {
    const txt = readFileSync(lockPath, "utf-8").trim();
    if (!txt) return null;
    const parsed = JSON.parse(txt) as Partial<DaemonLock>;
    if (typeof parsed.pid !== "number") return null;
    return { pid: parsed.pid, started_at: String(parsed.started_at ?? "") };
  } catch (e) {
    log(`lock unreadable: ${e}`);
    return null;
  }
}

/** Spawn `pipeline mesh notify` detached, using the SAME bun binary that is
 *  running this hook (process.execPath) rather than trusting a bare `bun` on
 *  the detached child's PATH — the Windows npm-shim trap
 *  pipeline_ui_relay.ts's spawnDaemon already documents (bun ships as
 *  bun.ps1/bun.cmd there, not bun.exe on PATH, so a shell-less spawn of the
 *  bare name silently never starts). */
function spawnNotifyDaemon(lockPath: string): void {
  if (!existsSync(CLI_ENTRY)) {
    log(`cli entry not found at ${CLI_ENTRY}`);
    return;
  }
  try {
    const dir = credentialDir(homeCtx());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, [CLI_ENTRY, "mesh", "notify"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
      windowsHide: true,
    });
    child.unref();
    if (typeof child.pid === "number") {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: child.pid, started_at: new Date().toISOString() } satisfies DaemonLock, null, 2) + "\n",
      );
      log(`spawned mesh-notify daemon pid=${child.pid}`);
    }
  } catch (e) {
    log(`failed to spawn mesh-notify daemon: ${e}`);
  }
}

/** Ensures a live notify daemon exists, spawning one if the lock is absent
 *  or points at a dead pid. Best-effort — any failure here still lets the
 *  drain step (job 2) run, since that reads a journal file the daemon may
 *  have already populated in a previous session. */
export function ensureDaemonRunning(ctx: HomeContext): void {
  const lockPath = notifyLockPath(ctx);
  const lock = readLock(lockPath);
  if (lock && isProcessAlive(lock.pid)) {
    log(`daemon already running pid=${lock.pid}`);
    return;
  }
  spawnNotifyDaemon(lockPath);
}

/** Build the SessionStart additionalContext string for a drained batch of
 *  notifications. Capped at 10 lines so a burst never floods context; the
 *  rest are still counted in the summary line. Exported for unit tests. */
export function buildAdditionalContext(notifications: TaskNotification[]): string {
  const SHOWN = 10;
  const lines = notifications.slice(0, SHOWN).map((n) => `- ${notificationBody(n)}`);
  const more = notifications.length > SHOWN ? `\n…and ${notifications.length - SHOWN} more.` : "";
  const plural = notifications.length === 1 ? "" : "s";
  return (
    `You have ${notifications.length} department-mesh task update${plural} since you were last here:\n` +
    `${lines.join("\n")}${more}\n` +
    `Use the mesh MCP server's tasks.get/tasks.list (run /mcp first if not yet connected) to see details or respond.`
  );
}

async function main(): Promise<void> {
  if (!meshNotifyEnabled()) {
    log("PIPELINE_MESH_NOTIFY_ENABLED disabled — no-op");
    return;
  }

  const ctx = homeCtx();
  const credPath = credentialFilePath(ctx);
  if (!existsSync(credPath)) {
    log("no cloud credential store yet ('pipeline cloud connect' never run) — no-op");
    return;
  }

  // Job 1 — best-effort, never blocks job 2.
  try {
    ensureDaemonRunning(ctx);
  } catch (e) {
    log(`ensureDaemonRunning threw: ${e}`);
  }

  // Job 2 — drain + surface.
  let pending: TaskNotification[] = [];
  try {
    pending = drainPendingNotifications({ fs: realFs, platform: ctx.platform, env: ctx.env, homedir: ctx.homedir });
  } catch (e) {
    log(`drainPendingNotifications threw: ${e}`);
    return;
  }
  if (pending.length === 0) {
    log("no pending mesh notifications");
    return;
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: buildAdditionalContext(pending),
      },
    }) + "\n",
  );
}

// Only run when invoked as a script (e.g. `bun hooks/mesh_notifier_relay.ts`),
// NOT when imported by a test file — same guard as prompt_match_relay.ts.
if (import.meta.path === Bun.main) {
  main()
    .catch((e) => log(`top-level: ${e}`))
    .finally(() => process.exit(0));
}
