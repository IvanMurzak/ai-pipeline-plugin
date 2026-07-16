/**
 * Pure logic for the "Connect to cloud" CTA (T2-13).
 *
 * The dashboard has no data seam yet to detect a project's
 * `.claude/pipeline/cloud.json` binding (ProjectEntry / ProjectState carry no
 * such field — see types.ts / EVENTS.md), so callers always pass
 * `undefined` for `connected` today. This module exists so the
 * invite-vs-connected decision is unit-testable now and the component only
 * needs a one-line prop change once a real seam lands (e.g. a
 * `cloud_connected` flag threaded onto ProjectEntry/ProjectState from the
 * daemon, which would read the binding file off disk).
 *
 * FOLLOW-UP (flagged, not implemented here): wire that seam up server-side —
 * this module and CloudConnectCta.tsx are ready to consume it as soon as it
 * exists, no invention of a new backend endpoint was done to unblock T2-13.
 */

/** The exact command the CTA tells the user to run — the real, shipped
 *  device-flow command from T1-16 (`apps/pipeline-cli/src/commands/cloud.ts`).
 *  It writes a secrets-free `.claude/pipeline/cloud.json` binding. */
export const CLOUD_CONNECT_COMMAND = "pipeline cloud connect";

export type CloudConnectView = "connected" | "invite";

/**
 * Decide which face of the CTA to render.
 *  - `true`  → a data seam positively confirmed the binding file exists for
 *    the active project.
 *  - `false` / `null` / `undefined` → not confirmed connected (no seam yet,
 *    the check hasn't resolved, or it positively found no binding) — always
 *    falls back to the static invite. Never claim "connected" without
 *    positive confirmation.
 */
export function cloudConnectView(connected: boolean | null | undefined): CloudConnectView {
  return connected === true ? "connected" : "invite";
}
