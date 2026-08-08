# Connecting to the cloud

`pipeline cloud connect` links one project to your organisation on
[ai-pipeline.dev](https://ai-pipeline.dev), so runs you start on your own
machine show up on a dashboard you can open from anywhere.

It is optional. Without it, everything runs exactly as before — see
[No account at all](#no-account-at-all) at the bottom, which is a guarantee, not
a disclaimer.

For the field-by-field list of what is uploaded once you are connected, see
[Privacy tiers](privacy-tiers.md).

---

## One command, one browser approval

```bash
pipeline cloud connect
```

```text
Connected: org 'acme', project 'acme-api' on https://api.ai-pipeline.dev.
  Binding (no secrets):  .pipeline/cloud.json
  Credential (secure):   %APPDATA%\claude-pipeline\credentials.json

  Found 47 past runs in this project.
  ↑ uploading history… 47/47 queued
  ✓ delivered — the dashboard is up to date.

  Telemetry: on — runs stream to your dashboard.
  Opt out of history: --no-history   ·   Opt out entirely: PIPELINE_SYNC_LOCAL_STATS=0
  Check anytime: pipeline stats telemetry
```

One more question follows — *"Also run cloud pipelines on this machine?"* — which
enrols this machine as a runner if you say yes. `--no-runner` skips it,
`--runner` answers yes without asking, and `--json` declines unless `--runner`
is given. Declining changes nothing about telemetry.

A browser opens once, you approve, and that is the whole ceremony. If no browser
is reachable — SSH with no X forwarding, a container, a loopback port that
cannot bind — it falls back to a device code and prints the reason. `--device`
forces that path. Declining the approval is not an error: it prints one line and
exits 0.

**Two files, and only one of them is in your project.**

| | Contents | Where |
| --- | --- | --- |
| `.pipeline/cloud.json` | `server`, `org`, `project`, `connected_at` — slugs and a URL. **No secrets.** Safe to commit. | your project |
| the credential | the access and refresh tokens | a per-user store, `0600` (`%APPDATA%\claude-pipeline\credentials.json` on Windows, `$XDG_CONFIG_HOME/claude-pipeline/credentials.json` otherwise), never printed, never in the project |

Useful flags: `--org <slug>` and `--project <slug>` (defaults derived from your
membership and the directory name), `--server <url>`, `--reauth` to force a
fresh sign-in, `--json`. For bots and CI, `PIPELINE_MACHINE_TOKEN=aip_m_…`
suppresses every prompt and browser attempt — pass `--org <slug>` with it, since
a machine credential carries no discoverable org.

---

## Your run history is uploaded on connect

The first thing you see on a new dashboard should not be an empty list, so
`connect` enumerates every **finished** run already recorded on this machine
(`.pipeline/.stats/**/runs.jsonl`), queues each one, and then makes one bounded
attempt to deliver the batch before the command returns.

Those historical records are:

- **org-tagged** with the org you just connected to, and
- marked `origin: "local"`, so the dashboard shows them as `Local` runs rather
  than pretending they were cloud-dispatched.

They go through exactly the same [privacy filter](privacy-tiers.md) as live
telemetry. A backfilled run discloses no more than a run streamed today.

If the network fails midway the exit code is still 0 and the records stay
queued: the dashboard ends up partially populated, never wrong. The source
`runs.jsonl` files are never modified by any of this, so a pass that did not
complete is simply retried on the next `pipeline cloud connect`, or drained with
`pipeline stats telemetry --drain`.

### `--no-history`

```bash
pipeline cloud connect --no-history
```

Skips the scan entirely — nothing already on disk is queued. **New runs still
stream**, because that is a different path; `--no-history` is about your past,
not your future. If you want neither, use `PIPELINE_SYNC_LOCAL_STATS=0`.

---

## Two different opt-outs

These are easy to confuse and they do unrelated things.

| Command | What it controls |
| --- | --- |
| `PIPELINE_SYNC_LOCAL_STATS=0` | **Your own runs, to your own dashboard.** Set it and nothing is queued, nothing is uploaded, and no uploader process is spawned. |
| `pipeline cloud optout [--set true\|false]` | **This organisation's contribution to cross-org aggregates** — the k-anonymity-floored statistics computed across orgs from *published* pipelines' run outcomes. It has nothing to do with your dashboard. |

`pipeline cloud optout` with no `--set` reads the current state and works for
any org role. `--set` requires the **admin** role; a lower role is refused with
the server's own reason rather than silently doing nothing. It never opens a
browser and never prompts — it reuses the credential `connect` already stored,
and tells you to run `pipeline cloud connect` if there is none.

> There is no `pipeline cloud disconnect`. To stop this project uploading,
> delete `.pipeline/cloud.json` (or set `PIPELINE_SYNC_LOCAL_STATS=0`). The
> stored credential is per-user, not per-project, and is left alone either way.

---

## Offline

Nothing about a run depends on connectivity.

```text
[drive] run.link url=https://api.ai-pipeline.dev/acme/runs/019fc762-5762-7000-a9bf-922ed8fa00be offline=true
```

The link is still printed, and it is still correct — it is composed entirely
locally from `cloud.json` and the run's own UUID, with no server round trip.
There is just nothing behind it yet. The `offline=true` marker appears when the
uploader is currently in a retry backoff.

While you are offline:

- the run proceeds at full speed; no step waits on the network;
- records accumulate in the on-disk queue at
  `.pipeline/.runtime/telemetry/outbox.jsonl`, **already filtered** — the queue
  file never holds anything the wire would not carry;
- nothing is printed about it, and no error appears.

When connectivity returns the backlog is flushed in order and the dashboard
picks the run up mid-flight. You get **exactly one** run row, not a duplicate:
every record carries `(run_id, seq)` and the server treats a replay as a no-op.

Two bounded-loss cases, both counted and both visible in
`pipeline stats telemetry`, never silent:

- **The queue reaches its bound** (10 000 records). The *oldest* records are
  dropped — a lost tail is recoverable, a run that cannot start is not.
- **The server permanently rejects a record** (a 4xx that is not about the
  credential, the clock or a rate limit). It is moved to `quarantine.jsonl`
  rather than deleted, so it can still be inspected.

### If you reconnect under a different org

Records queued under org A are tagged with org A. Reconnect to org B and those
records are **not sent** — they are held, and `pipeline stats telemetry` reports
them as a blocked queue. Reconnecting to A releases them. Without that tag, one
org's telemetry would land permanently in another's dashboard, and no deletion
window repairs data that should never have arrived.

---

## How long it is kept, and why

Run and step telemetry is retained **for as long as the organisation account it
belongs to is active, and no longer.**

The purpose is the product itself: the analytics, regression detection and
optimizer verdicts an org uses are computed over its own accumulated history,
and a corpus that is silently truncated degrades the thing you are using. That
is the linkage — the retention period is bounded by the purpose, and the purpose
lives exactly as long as the account. **When the account is deleted the purpose
lapses and the data goes**, through the deletion path below. There is no
separate archival purpose, no analytics purpose over dead accounts, and no
research purpose.

> **Plan history windows are not retention periods.** The dashboard hides runs
> older than 7 days (Free) / 90 (Pro) / 365 (Team) from the run list and
> analytics. That is a *read filter*. It deletes nothing, and a Free-plan user
> who sees seven days of history is not a user whose data is seven days old.

---

## Deleting it

Deletion is requested per **organisation** or per **project**, by a member with
the **admin** role or above. There are two ways in, and both are live.

**From the dashboard.** The nav menu has a **Delete data** entry — in the *Org*
group, shown only to admins and owners, never behind a plan. It opens a
`/deletion` overlay: choose the whole organisation or one project, type the
confirmation phrase, submit. That is the whole request. While a request is open,
a banner sits in the dashboard's own chrome — on every screen, not just that
overlay — carrying a **Cancel deletion** button that is one click from wherever
you already are. The overlay also lists past requests and their outcome.

**From the API,** with your session credential:

```text
POST /api/v1/deletion-requests   { "targetType": "project", "targetId": "<uuid>" }
POST /api/v1/deletion-requests   { "targetType": "org", "confirm": "<org-slug>" }
GET  /api/v1/deletion-requests
POST /api/v1/deletion-requests/<id>/cancel
```

- **Deleting an organisation requires typing its slug** into `confirm`, and the
  *server* checks it — not only the form — so a mis-scripted `curl` is inert. A
  project delete carries no server-side phrase; the dashboard asks you to type
  the project's **name** anyway, because a target chosen from a dropdown is
  exactly the one chosen by accident.
- **A 7-day grace period — 168 hours, not "seven calendar days",** so it means
  the same thing in every timezone and across a DST boundary. The request
  records a `scheduledPurgeAt` exactly that far out and the database refuses a
  row that says anything else. The boundary is inclusive: one millisecond before
  it you can still cancel; at it you cannot.
- **Nothing is removed until then.** `pending_deletion` is a state, not a
  partial delete — the organisation or project stays fully live, fully readable
  and still ingesting for the whole seven days.
- **The purge itself runs on a background sweep** that ticks every 15 minutes and
  re-checks the deadline under a row lock before deleting anything. That cadence
  can only make a purge slightly *later* than the deadline, never earlier, and it
  can never shorten the grace period.
- **The org's owners and admins are emailed** when a request is created, and
  again when one is cancelled. Neither email carries a cancel link — deliberately;
  see the next bullet.
- **Cancelling is permission-checked, not a link.** The cancel endpoint
  re-checks your role on the authenticated session, so forwarding the email to
  someone does not hand them the ability to cancel.
- **One open request per target.** Asking a second time returns `409` and tells
  you the deadline the first request already set.
- A project deletion explicitly removes that project's runs — and with them
  their step executions and events — plus its derived run and step rollups, its
  tasks, schedules, alert rules and the alerts they fired, and its notification
  channels. Not only the project row. The request row keeps a per-table count of
  what went, so the deletion is auditable afterwards; an organisation purge takes
  its own request row with it, so that record is the server's log line instead.
- **A purge the database refuses** — an organisation with registry purchase
  history it is not allowed to drop — is recorded as `blocked` rather than
  half-completed; the transaction rolls back whole. A blocked request is still
  **open**: it is still listed, still shown in the banner, and still cancellable.

**Telemetry that arrives during the grace period is accepted and stored.**
Refusing it would break a pipeline that is running right now, which is a promise
this product does not break. It is removed with the tree at expiry and it does
not cancel or postpone the deletion.

Deleting a resource tree is not the same primitive as erasing one person's data.
A departed employee's erasure request is handled separately — API only, no
dashboard screen — by `POST /api/v1/erasure-requests`, with
`GET /api/v1/erasure-requests` as the organisation's erasure register. It is
admin-gated the same way, and it inverts every property above: it runs
**immediately**, inside the POST that asks for it, and it is **not cancellable
by anyone** — there is no cancel route, there is no pending state a cancel could
act on, and the register rows cannot be updated or deleted by anybody, including
whoever wrote them. What it removes is one person's *attribution* from a tree
that stays alive: their user reference is nulled, and text captured at write
time becomes the tombstone `(erased)`. An open — or blocked — deletion request
neither delays an erasure nor is changed by one.

---

## No account at all

With no `.pipeline/cloud.json`, the upload subsystem is **absent, not merely
inert**:

- no link line is printed,
- no uploader process is spawned,
- nothing is queued,
- no file is created under `.pipeline/.runtime/telemetry/`,
- and the run's output is byte-identical to what it was before any of this
  existed.

`PIPELINE_SYNC_LOCAL_STATS=0` is checked at the same place and gives you the
same "absent" behaviour on a project that *is* connected.

Either way the local journal and the local stats files are still written, and
`pipeline logs -f`, `pipeline logs --chat <run-id>` and `pipeline stats` all
work offline with no account.

---

## Checking on it

```bash
pipeline stats telemetry
```

```text
Telemetry  on
Account    acme @ api.ai-pipeline.dev
Streaming  idle (no active run)
Queued     2 runs (oldest 14 min ago)
Dropped    0
Last error could not reach the server — 14 min ago
Dashboard  https://api.ai-pipeline.dev/acme/runs

Retry now: pipeline stats telemetry --drain
```

Full reference: [`docs/cli.md` in the CLI repository][cli-docs].

[cli-docs]: https://github.com/IvanMurzak/pipeline/blob/main/docs/cli.md
