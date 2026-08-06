# Departments — remote MCP entry + background notifier

Source: `department-mesh` design, task `a1` (`.claude-plugin/plugin.json`'s `mcpServers` entry +
`apps/pipeline-cli/src/lib/department-notify.ts` / `src/lib/os-notify.ts` / `src/commands/department-notify.ts` +
`hooks/department_notifier_relay.ts`). Read this before editing any of those files.

RENAME NOTE (a11, simplified-onboarding — 08-terminology.md / D10 / D31): this file was
`docs/mesh-mcp.md`. "mesh"/"fleet" are gone from every user-facing surface and from this doc's own
prose; citations to `department-mesh` design-doc file names (`12-user-workflows.md`, …) are left
as-is — that design folder keeps its original name (D17) — and citations to files in the PRIVATE
`cloud/` repo (`cloud/apps/api/src/modules/mesh/…`) are left as-is too, since that repo's own
tier-2 rename has not landed yet (as of this writing those files are still literally named that).

This plugin ships two related but separately-authenticated pieces that make the Claude Code plugin a
first-class client of [ai-pipeline.dev](https://ai-pipeline.dev) departments:

1. A **remote MCP server entry** so Claude Code itself can call the departments' tools (`departments.list`,
   `tasks.send`, `tasks.wait`, …) inside a live session.
2. A **background notifier** — a small local daemon that watches your open department tasks and surfaces
   `INPUT_REQUIRED`/`AUTH_REQUIRED` and terminal transitions even after the session that created the
   task has ended.

They do not share code and, deliberately, do not share a transport. Read on for why.

## 1. The remote MCP server entry

`.claude-plugin/plugin.json` declares:

```json
"mcpServers": {
  "ai-pipeline-departments": {
    "type": "http",
    "url": "https://api.ai-pipeline.dev/mcp",
    "timeout": 120000
  }
}
```

**The server key was `ai-pipeline-mesh` before a11.** This is NOT a cosmetic rename: the key is
embedded in every tool's callable name (`mcp__plugin_<plugin>_<server>__<tool>`), so it appears in a
user's `permissions.allow`, a skill's `allowed-tools`, a subagent's `tools` list, and hook matchers —
renaming it silently breaks every one of those. Stored OAuth credentials are also keyed by the server
name (`claude mcp logout <name>` takes the name), so a renamed server is a NEW server with no grant:
**every connected user re-consents, once.** This was deliberately sequenced as a tier-3 change
(08-terminology.md §2, D10's revision) rather than shipped as an incidental tier-1 rename.

**The key reached installed users in plugin `0.85.0` (a12), not in the commit that renamed it.** That
commit changed this file and `plugin.json`'s key without touching `plugin.json`'s `version`, and
Claude Code caches an installed plugin by `name@version` — so every already-installed user kept the
old manifest and the legacy key until the next bump, which was verified live before 0.85.0 (`claude
mcp list` after `pipeline init` still reported `ai-pipeline-mesh`). If you rename this key again,
**the version bump is part of the rename, not a follow-up.** The control plane's matching
`serverInfo.name` rename (`c13`) is on the same release train, so the two halves agree in the field
from 0.85.0 on.

- `"type": "http"` is a **remote** Streamable HTTP server, not a stdio `command`. Claude Code performs
  its own OAuth 2.1 discovery + browser consent flow against a remote http/sse server that answers a
  bare request with `401` and a `WWW-Authenticate` challenge — nothing in this plugin implements any
  part of that dance. This is D14 in the design (`04-mcp-gateway.md` §1, `13-mcp-authorization.md` §8):
  a stdio bridge was explicitly rejected because it can only ever serve the process that spawned it and
  its natural credential (a PAT) would have been a long-lived, unscoped secret on disk — exactly what
  the OAuth design exists to avoid.
- `"timeout": 120000` (ms) is deliberately larger than the departments' `tasks.wait` long-poll ceiling of 45 s
  (`04-mcp-gateway.md` §3.6) so a single long-poll tool call has headroom under Claude Code's per-request
  first-byte timer, which otherwise defaults to 60 s.

**One-time connect cost — 2 steps, 1 browser hop, no manual token handling** (Persona B,
`12-user-workflows.md`):

| # | Step | Surface |
|---|---|---|
| 0a | Run `/mcp` (or just delegate — Claude Code triggers discovery automatically on first tool use) | Claude Code |
| 0b | Log in if needed, pick your org if you belong to more than one, approve | Browser (1 hop) |

After that, per-task cost is 1 step in the happy path (ask in natural language; the agent calls
`departments.list`/`tasks.send` itself), 2 with exactly one clarification round trip, 0 browser hops.
Nothing in this plugin's own code implements or tests this flow — it is entirely Claude Code's built-in
remote-MCP OAuth client. There is no unit-testable surface here beyond "the manifest declares the right
shape", which `.github/scripts/validate-manifest.py` and the plugin's own manual connect test cover.

## 2. The background notifier (Q2)

**Why it exists.** `tasks.wait` caps at 45 s by design, so a live session loops it invisibly — but if the
originating Claude Code session ends while a task is parked (`INPUT_REQUIRED`) or finishes after you've
moved on, a plain MCP client has no push channel to tell you. `12-user-workflows.md`'s Q2 owner override
closes that gap: "the plugin ships a background notifier that surfaces `INPUT_REQUIRED` (and terminal)
transitions across sessions — so a parked task announces itself instead of waiting to be polled."

### Why it does NOT use the `/mcp` tool surface

This is the one deliberate, documented deviation from a literal reading of the design text (which names
`tasks.list`/`tasks.wait` — the MCP tool names). The full reasoning lives in the header comment of
`apps/pipeline-cli/src/lib/department-notify.ts`; the short version:

- The notifier is a **headless background process** with no browser to complete an OAuth consent flow
  in. Claude Code's own OAuth client (§1 above) lives entirely inside Claude Code's process and isn't a
  credential this plugin's own code can read out-of-process.
- At `a1`'s implementation time the OAuth 2.1 authorization server (`c12`) had not landed —
  `a1` only `depends_on: [c6]`, by design, so the two build in parallel. There is no live path today for
  *any* headless process to mint an MCP-audience token.
- The functionally-equivalent REST surface already exists — `GET /api/v1/dept-tasks`
  (`cloud/apps/api/src/modules/mesh/routes.ts`) — authenticated by the exact credential store this task
  was told to use (`apps/pipeline-cli/src/lib/cloud-config.ts`'s PAT, populated by `pipeline cloud
  connect`'s device flow). Persona B's step budget shows **zero** additional user-facing setup for the
  notifier, which only holds if it reuses an already-established credential instead of running a second
  OAuth dance nobody asked for.

The polling/diff/journal logic is written behind a small seam (`fetchMe`/`fetchOpenTasks` in
`department-notify.ts`) so swapping the transport to real `tasks.list`/`tasks.wait` JSON-RPC calls later is a
localized change, not a redesign. Full cross-session live proof (a real parked task, a real OAuth token,
a real cross-session notification) is deferred to the `e3` P2 gate, once `c12`/`c13`/`d6` have landed.

### Architecture

```
hooks/department_notifier_relay.ts  (SessionStart, every session, any project)
  │
  ├─ job 1: ensureDaemonRunning() — pid-lock-guarded, spawns `pipeline department notify` detached
  │           lock: <credential-dir>/department-notify-daemon.lock  { pid, started_at }
  │
  └─ job 2: drainPendingNotifications() — reads + clears the pending queue,
              emits it as SessionStart additionalContext (shown once, self-limiting)

apps/pipeline-cli/src/commands/department-notify.ts   `pipeline department notify [--interval-ms] [--once] [--json]`
  │  (also reachable via commands/department.ts's `notify` verb, and via the
  │   DEPRECATED, hidden `pipeline mesh notify` alias in commands/mesh.ts)
  │
  └─ pollLoop() (lib/department-notify.ts)
       │
       └─ pollOnce() — per stored credential (cloud-config.ts's CredentialStore):
            1. GET /api/v1/me           → user id + org list
            2. GET /api/v1/dept-tasks   → X-Org-Id per org, filtered to `originPrincipal ===
                                           "user:<id>"` and NOTIFY_STATES (INPUT_REQUIRED,
                                           AUTH_REQUIRED, COMPLETED, FAILED, CANCELED, REJECTED)
            3. diff against the journal's `seen` cursor (state + stateVersion per task)
            4. new/changed → TaskNotification, appended to the durable `pending` queue
               (capped at MAX_PENDING_NOTIFICATIONS, oldest dropped first)
            5. onNotification callback → best-effort OS toast (lib/os-notify.ts)

Journal + lock files: <credential-dir>/department-notify-state.json, department-notify-daemon.lock
  (same per-user directory cloud-config.ts already uses for the credential store —
  outside any project, one instance per machine per user)
```

### Delivery is two independent channels, on purpose

1. **OS-level toast** (`lib/os-notify.ts`) — fired the moment the daemon detects a transition, whether
   or not Claude Code is even running. Best-effort: `darwin` → `osascript display notification`,
   `linux` → `notify-send`, `win32` → a `System.Windows.Forms.NotifyIcon` balloon via PowerShell (no
   extra module required). An unrecognized platform, a missing binary, or any spawn failure is swallowed
   — this channel is never required for correctness.
2. **SessionStart `additionalContext`** (`hooks/department_notifier_relay.ts`) — the durable fallback. Every
   notification lands in the pending journal regardless of whether the toast succeeded; the next time you
   open Claude Code, in *any* project (department tasks are org-scoped, not project-scoped, and SessionStart
   fires for every session regardless of cwd), the hook drains the queue and injects it as context. This
   is also the "shown once" contract: a second SessionStart with nothing new pending stays silent.

### Authentication

The notifier reuses `cloud-config.ts`'s `CredentialStore` verbatim — the same PAT `pipeline cloud
connect`'s device flow already writes. No separate consent step, no new credential file. It calls
`GET /api/v1/me` to resolve the user id + org list (needed because `X-Org-Id` must be a UUID, and the
credential store only keeps a display `org_slug`), then `GET /api/v1/dept-tasks` per org with
`X-Org-Id: <uuid>` and `Authorization: Bearer <PAT>`. An expired or invalid credential is skipped with a
recorded error, never thrown — one bad server/org never aborts the whole poll cycle.

### Gating and single-instance guard

- `PIPELINE_DEPARTMENT_NOTIFY_ENABLED` — on by default, same falsy-value convention (`0`/`false`/`no`/`off`)
  as `PIPELINE_UI_ENABLED`. The old name, `PIPELINE_MESH_NOTIFY_ENABLED`, is still READ as a fallback
  when the new one is unset (a11's tier-3 dual-accept window — 08-terminology.md §3) — using it prints a
  one-line deprecation warning to stderr.
- No-ops entirely (spawns nothing, drains nothing) until `credentialFilePath()` exists — i.e. until
  `pipeline cloud connect` has run once. Re-checked cheaply on every SessionStart.
- The daemon is spawned via `process.execPath` (the same bun binary running the hook), not a bare `bun`
  on the detached child's PATH — the same Windows npm-shim trap the deleted dashboard's launcher hook's
  `spawnDaemon()` already documents.
- Single-instance guard is a pid+`started_at` lock file, checked with `process.kill(pid, 0)` (the same
  liveness idiom the analytics relay's telemetry-daemon lock uses). Deliberately far simpler than the
  deleted dashboard daemon it was contrasted with: no
  HTTP health endpoint, no version-handoff protocol — the notifier has no listening port and nothing
  project-scoped to reconcile, so "is the pid alive" is the whole contract.

### The deprecated `pipeline mesh notify` alias

`commands/mesh.ts` (a11) keeps the pre-rename spelling working for anyone with an existing service
definition or shell profile: it is a thin, permanent-until-a-tier-3-drop pass-through that prints a
deprecation warning to stderr naming `pipeline department notify`, then delegates to the exact same
`runDepartmentNotify` function `commands/department-notify.ts` exports — there is no separate logic to
keep in sync. It is deliberately NOT listed in `cli.ts`'s `--help` output.

### Testing notes

- `tests/department-notify.test.ts` — the poll/diff/journal core, fully injected (scripted fetch, real fs over
  a tmp home via `PIPELINE_CLOUD_HOME`, fake clock/sleep). Covers: first-seen notification, dedup on an
  unchanged state+version, a second notification on a state transition, non-notify states never
  journaled, cross-principal filtering, expired/invalid credential handling, multi-org polling, the
  pending-queue cap, and `pollLoop`'s error isolation (a throwing fetch or a throwing `onNotification`
  handler never aborts the loop).
- `tests/os-notify.test.ts` — `buildOsNotifyCommand` is pure (no I/O) and exhaustively tested per
  platform, including quoting/escaping and length clipping; `sendOsNotification` is tested against an
  injected fake spawn.
- `tests/department-notify-cli.test.ts` — the `pipeline department notify` CLI entry: arg parsing, `--once` output shapes.
- `tests/mesh.test.ts` — the deprecated `pipeline mesh notify` alias: warns, points at the new name, and
  still delegates end-to-end.
- `tests/hook-department-notifier.test.ts` — the hook's pure helpers (`departmentNotifyEnabled`,
  `buildAdditionalContext`) plus subprocess end-to-end tests spawning the real hook file. **Deliberately
  does NOT exercise the real daemon-spawn code path** — doing so would fork a genuine detached
  `pipeline department notify` process (a poll loop hitting the network forever) inside `bun test`. Every test
  either gates out before that branch (no credential store) or pre-seeds the lock file with the test
  process's own pid (always alive), so `ensureDaemonRunning` takes the "already running" early return.
  The real spawn path is smoke-tested manually and is proven at the `e3` gate — the same deferral
  the deleted dashboard's launcher hook already accepted.

Full cross-session live proof — a real parked task on a real deployed cloud, a real OAuth-connected
Claude Code session, the daemon actually detecting the transition and a real toast/context injection
firing in a later session — is out of scope for unit/integration tests and is verified at the `e3` P2
gate (`c6`, `c12`, `d6`, `a1`, `c13` all landed).
