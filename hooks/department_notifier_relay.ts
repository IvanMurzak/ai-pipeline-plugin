#!/usr/bin/env bun
/**
 * Pipeline plugin — SessionStart hook: department background notifier
 * (department-mesh design, task a1, the Q2 owner override —
 * 12-user-workflows.md Persona B: "a parked task announces itself instead
 * of waiting to be polled").
 *
 * RENAME NOTE (a11, simplified-onboarding — 08-terminology.md / D10 / D31):
 * this file was `hooks/mesh_notifier_relay.ts`; the daemon it spawns is now
 * `pipeline department notify` (the old `pipeline mesh notify` spelling
 * still works as a deprecated, warning alias — `commands/mesh.ts`). Citations
 * to `department-mesh` design-doc file names (`12-user-workflows.md`, …) are
 * left as-is — that design folder keeps its original name (D17).
 *
 * Two independent, best-effort jobs — neither may ever block Claude Code
 * startup or throw past main():
 *
 *   1. ENSURE THE DAEMON IS RUNNING. Spawns `pipeline department notify`
 *      (apps/pipeline-cli/src/commands/department-notify.ts) detached, so it
 *      keeps polling the caller's open department tasks and firing OS-level
 *      toasts even after THIS Claude Code session ends — a plain MCP client
 *      has no push channel once the session that opened `/mcp` is gone, so
 *      the plugin ships one. Single-instance-guarded by a pid+started_at
 *      lock file at <credential-dir>/department-notify-daemon.lock (same
 *      per-user directory apps/pipeline-cli/src/lib/cloud-config.ts already
 *      uses for the cloud credential store) — never spawned twice; respawned
 *      if the previous instance died. Deliberately far simpler than
 *      pipeline_ui_relay.ts's daemon: no HTTP health checks, no version
 *      handoff — the notifier has no listening port and nothing project-
 *      scoped to reconcile, so "is the pid alive" is the whole contract.
 *
 *   2. DRAIN PENDING NOTIFICATIONS. The daemon durably queues every newly
 *      detected INPUT_REQUIRED/AUTH_REQUIRED or terminal transition (see
 *      lib/department-notify.ts's pending-notification journal) so nothing is
 *      lost even if the OS toast was missed, dismissed, or unsupported on
 *      the machine. This hook drains that queue and surfaces it as
 *      SessionStart additionalContext — the durable fallback channel, shown
 *      the next time Claude Code opens ANY session, in ANY project
 *      (department tasks are org-scoped, not project-scoped, and
 *      SessionStart fires for every session regardless of cwd —
 *      code.claude.com/docs/en/hooks.md). Draining is itself the "shown
 *      once" contract: a second SessionStart with nothing new pending emits
 *      no context, so this never repeats.
 *
 * No-ops entirely (spawns nothing, drains nothing) if the user has never run
 * `pipeline cloud connect` — no credential store file means there is nothing
 * to poll yet, and spawning a daemon that would only ever no-op is wasted
 * work re-attempted (cheaply) on every future SessionStart once a credential
 * does appear.
 *
 * Gated by PIPELINE_DEPARTMENT_NOTIFY_ENABLED — ON BY DEFAULT, same
 * falsy-value opt-out convention as PIPELINE_UI_ENABLED (0/false/no/off
 * disables; any other value, including unset, leaves it enabled). The old
 * name, PIPELINE_MESH_NOTIFY_ENABLED, is still READ as a fallback when the
 * new one is unset — a shell profile or service unit set up before a11 keeps
 * working — and its use prints a one-line deprecation warning to stderr.
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
} from "../apps/pipeline-cli/src/lib/department-notify.ts";

const DEBUG = process.env.PIPELINE_UI_DEBUG === "1";
const log = (msg: string) => DEBUG && console.error(`[department_notifier_relay] ${msg}`);

const NOTIFY_ENABLED_ENV = "PIPELINE_DEPARTMENT_NOTIFY_ENABLED";
const NOTIFY_ENABLED_ENV_LEGACY = "PIPELINE_MESH_NOTIFY_ENABLED";

function isFalsy(v: string): boolean {
  return v === "0" || v === "false" || v === "no" || v === "off";
}

/** Master enable switch — mirrors pipeline_ui_relay.ts's pipelineUiEnabled():
 *  ON by default; only an explicit falsy value opts out. Reads the new env
 *  var first; falls back to the deprecated `PIPELINE_MESH_NOTIFY_ENABLED`
 *  (a11/08-terminology.md tier-3 dual-accept window) when the new one is
 *  unset, warning once on stderr — never gated by PIPELINE_UI_DEBUG, since a
 *  real user relying on the old name should see this even without debug on. */
export function departmentNotifyEnabled(): boolean {
  const primary = (process.env[NOTIFY_ENABLED_ENV] ?? "").trim().toLowerCase();
  if (primary !== "") return !isFalsy(primary);

  const legacy = (process.env[NOTIFY_ENABLED_ENV_LEGACY] ?? "").trim().toLowerCase();
  if (legacy !== "") {
    console.error(
      `[department_notifier_relay] ${NOTIFY_ENABLED_ENV_LEGACY} is deprecated — use ${NOTIFY_ENABLED_ENV} instead.`,
    );
    return !isFalsy(legacy);
  }
  return true;
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

/** Spawn `pipeline department notify` detached, using the SAME bun binary
 *  that is running this hook (process.execPath) rather than trusting a bare
 *  `bun` on the detached child's PATH — the Windows npm-shim trap
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
    const child = spawn(process.execPath, [CLI_ENTRY, "department", "notify"], {
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
      log(`spawned department-notify daemon pid=${child.pid}`);
    }
  } catch (e) {
    log(`failed to spawn department-notify daemon: ${e}`);
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
    `You have ${notifications.length} department task update${plural} since you were last here:\n` +
    `${lines.join("\n")}${more}\n` +
    `Use the departments MCP server's tasks.get/tasks.list (run /mcp first if not yet connected) to see details or respond.`
  );
}

async function main(): Promise<void> {
  if (!departmentNotifyEnabled()) {
    log(`${NOTIFY_ENABLED_ENV} disabled — no-op`);
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
    log("no pending department notifications");
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

// Only run when invoked as a script (e.g. `bun hooks/department_notifier_relay.ts`),
// NOT when imported by a test file — same guard as prompt_match_relay.ts.
if (import.meta.path === Bun.main) {
  main()
    .catch((e) => log(`top-level: ${e}`))
    .finally(() => process.exit(0));
}
