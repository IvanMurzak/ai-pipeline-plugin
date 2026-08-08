# Running pipelines

There is more than one place to start a pipeline. They differ in **where you
start it from**, not in what it does — the same pipeline, the same steps, the
same result. What they differ in besides that is **how finely the run is
reported**, and this page says so per surface rather than promising parity
everywhere.

Once you have run `pipeline cloud connect`, runs stream to your dashboard on
[ai-pipeline.dev](https://ai-pipeline.dev). That dashboard is the UI — hosted,
installable as a web app, nothing to run on your machine. Without an account,
`pipeline logs` shows you the same runs in the terminal; see
[Watching without an account](#watching-without-an-account).

> The dashboard is served at **`api.ai-pipeline.dev`**, not at the apex — the
> apex is the marketing site and has no run-detail route. Every link the CLI
> prints already points at the right host; this note only matters if you are
> hand-editing a URL.

> **The plugin requires the `pipeline` CLI.** Since **v0.93.0** this plugin
> ships no code of its own: its skills, its agents and all five of its hooks are
> CLI subcommands (`pipeline hook <name>`). Install it with
> `bun add -g @baizor/pipeline` (or `npm i -g @baizor/pipeline`). If the CLI is
> missing or too old to know the `hook` subcommand, the plugin **will not block
> your session** — a shim detects that case and exits cleanly — but every hook
> **silently does nothing**, which costs you the tool-call granularity described
> below. A `SessionStart` warning names the upgrade command once per session;
> that line is the whole safety net, so it is worth reading.

## Terminology

| Term | Meaning |
| --- | --- |
| **Pipeline** | The workflow definition — what to do, in `.pipeline/<name>/` |
| **Run** | One execution of a pipeline |
| **Step** | One iteration inside a run |
| **Department** | A long-lived service that accepts work from your team or the cloud |
| **Request** | One unit of work sent to a department |
| **Message** | One exchange inside a request |

A request can start a run. A run contains steps. That is the whole hierarchy.

```
Request (department)
  ├─ Message, Message, …
  └─ Run (pipeline)
       └─ Step
```

---

## The launch surfaces, and what each reports

| # | Surface | How you start it | Live granularity | Status |
| --- | --- | --- | --- | --- |
| 1 | Claude Code, pipeline known | `/pipeline:run <step>` | run · step · **tool call** | shipped |
| 2 | Claude Code, matched from a description | `/pipeline:dispatch <text>` (`/pipeline:find` to confirm first) | run · step · **tool call** | shipped |
| 3 | Terminal, headless | `pipeline drive <pipeline>` | run · step · **tool call** | shipped |
| 4 | ~~Local browser dashboard~~ | ~~`pipeline ui`~~ | — | **removed** — see below |
| 5 | Cloud dispatch → **your own** runner | Dashboard → Run | run · step · tool call | **not shipped** — free when it is |
| 6 | Cloud dispatch → **hosted** runner | Dashboard → Run | run · step · tool call | **not built** — paid when it is |
| 7 | **Codex** | the Codex `pipeline` skill → the same npm CLI | run · step **only** | shipped |

Rows 5 and 6 are unwired: the dashboard's Launch panel is a stub that fails on
mount. Nothing about them works today, and no amount of local setup changes
that.

**Row 4 no longer exists.** Earlier versions shipped a local browser dashboard
(`pipeline ui`, `/pipeline:ui`, a background Bun daemon serving a React app).
All of it was deleted: the hosted dashboard is better at the shared 90%, and the
two local capabilities with no cloud equivalent moved into the CLI as
`pipeline logs --chat` and `pipeline fix` before it went.

---

## From Claude Code — `/pipeline:run` (surface 1)

The main path. You already know which pipeline you want.

```
/pipeline:run .pipeline/support-answer/steps/01-triage.md
```

Claude runs the chain step by step in fresh contexts, showing progress as it
goes. The plugin's hooks observe the session, so the dashboard follows along
*inside* a step: every tool call and every token tally is attributed to the step
that made it.

**Use it when:** you are working in Claude Code and you know the pipeline.

---

## From Claude Code — `/pipeline:dispatch` (surface 2)

Same as above, but you describe the task and let it pick the pipeline.

```
/pipeline:dispatch Answer ticket #482 about the refund policy
```

It matches your description against every pipeline in the project, picks the
best fit (or a chain of them), and runs it without asking. To see the match
*before* running it, use `/pipeline:find` instead — it shows the ranked
candidates and waits for your confirmation.

**Use it when:** you have a task, not a pipeline name.

---

## From the terminal — `pipeline drive` (surface 3)

No Claude Code session needed. Runs headless.

```
pipeline drive support-answer
```

When the project is connected, `drive` prints the run's dashboard link as its
**second** line of progress, before step 1. It is the only surface that prints
one today — from Claude Code you open the dashboard yourself:

```text
[drive] run.started run_id=019fc762-5762-7000-a9bf-922ed8fa00be pipeline_root=… experimental=true
[drive] run.link url=https://api.ai-pipeline.dev/acme/runs/019fc762-5762-7000-a9bf-922ed8fa00be
[drive] step.started …
```

(Progress goes to stderr, one `key=value` line per event; `--json` emits the
same events as JSON objects instead.)

The URL carries the **full run UUID**. It is composed entirely locally — org
slug out of `.pipeline/cloud.json`, UUID minted on your machine — so no server
round trip is involved and there is nothing about it that can later fail to
resolve. It is correct the moment it is printed, online or off.

> **There is no short form of a run URL.** Earlier drafts described a derived
> short code in place of the UUID; it was withdrawn and never shipped. Any
> documentation or output showing a run URL whose last segment is not a full
> UUID is stale.

Each step runs as a real Claude Code session with the plugin's hooks active, and
`drive` pre-binds that session to the run and step before spawning it — so tool
calls are attributed correctly here too, and the run gets the same tool-call
granularity as surfaces 1 and 2. `drive` additionally parses the child's output
stream live, which is why you see tool activity scroll past in your terminal
rather than a wall of silence per step.

If a step needs your input, the run parks and tells you how to answer. Resume
with the same command plus `--resume --answer "<text>"`.

**Use it when:** scripting, CI, or you just prefer the terminal.

---

## From Codex — the `pipeline` skill (surface 7)

The [Codex plugin](https://github.com/IvanMurzak/pipeline-codex) delegates to
*the installed `pipeline` CLI*. It ships no CLI of its own, no hooks and no
setup: because the uploader, the queue and the cloud identity all live in the
CLI, telemetry works with **zero Codex-specific configuration**.

**Be clear about what you get.** Codex runs produce the same **run** and **step**
rows on the dashboard as a Claude Code user's. They do **not** produce
tool-call or per-turn token events — no `tool.called`, no `turn.usage` — because
those come from Claude Code's hook system, which Codex does not have. There is
no configuration that turns this on, and claiming parity would be false.

---

## From the cloud — dispatch to a runner (surfaces 5 and 6)

> **Not shipped.** The dashboard's Launch button is a stub that fails on mount.
> This section describes the intended shape; surfaces 1–3 and 7 work today.

Start a run from the dashboard and have it execute somewhere else. The work is
queued in the cloud and a runner picks it up. There are two kinds of runner:

| Runner | Who provides the machine | Price |
| --- | --- | --- |
| **Your own** — `pipeline-runner` installed on your laptop, workstation or server | You | **Free** |
| **Hosted** — we run it for you, nothing to install | Us | Paid — **not built** |

Registering your machine as a runner already works — `pipeline cloud connect`
asks *"Also run cloud pipelines on this machine?"* and, if you say yes, mints
the credential, registers the machine and installs the service for you, with no
dashboard visit and no token to copy. It just has nothing to dispatch to it yet.

The manual equivalent, if you would rather do it by hand:

```bash
bun add -g @baizor/pipeline-runner
pipeline-runner register --url https://api.ai-pipeline.dev --token <runner-token> \
    --label repo:acme/api
pipeline-runner service install
```

`--url` is the **control-plane** base URL (`api.ai-pipeline.dev`), not the
marketing apex, and `--label` takes repeatable `key:value` pairs used for
matching — `os:<detected>` is always added for you.

---

## What reaches the dashboard

Once connected (`pipeline cloud connect`), every surface above sends the same
kind of thing:

- step progress, timings and outcomes
- token counts and cost
- tool-call and failure counts (surfaces 1, 2 and 3)
- the pipeline structure, and which step failed

And nothing else. Prompts, transcripts, your code, tool arguments, tool output,
error text and absolute file paths never leave your machine. That is not a
policy statement — it is a positive allowlist, and
**[Privacy tiers](privacy-tiers.md) lists it field by field**, with the shipped
filter's real output.

Runs started on your own machine are labelled **Local**; runs dispatched from
the cloud would be labelled **Cloud**. Both appear in the same list. Unknown
token counts render as `—`, never `0` — a zero is a claim, a dash is an absence.

To turn uploading off entirely:

```bash
PIPELINE_SYNC_LOCAL_STATS=0
```

To see what has been sent, what is queued and what was dropped:

```bash
pipeline stats telemetry
```

Connecting, history upload, retention, deletion and offline behaviour are all in
[Connecting to the cloud](cloud-connect.md).

---

## Watching without an account

Local execution never requires a cloud account, and neither does watching a run.
Every surface above writes an append-only journal at
`<project>/.pipeline/.runtime/events.jsonl`, and two commands read it — both
read-only, both offline, neither starting any background process:

```bash
pipeline logs -f                 # tail the run live, one line per event
pipeline logs --chat <run-id>    # render a finished run's transcript
```

`logs -f` is the live view: step starts and finishes, tool calls, parked
questions, halts. `logs --chat` is the post-mortem — it renders the Claude Code
transcript of a run that executed headless (`pipeline drive`), whose steps ran
as separate processes and whose subagent transcripts otherwise sit unread on
disk. Both read only what is already on your machine and upload nothing.

---

## Which one should I use?

| You want to… | Use |
| --- | --- |
| Run a pipeline you know, from Claude Code | `/pipeline:run` |
| Describe a task and let it choose | `/pipeline:dispatch` |
| See the match before it runs | `/pipeline:find` |
| Run from a terminal or a script | `pipeline drive` |
| Run from Codex | the Codex `pipeline` skill — run and step reporting, no tool-call detail |
| Watch a run with no cloud account | `pipeline logs -f` |
| Launch from your phone or a schedule | not yet — cloud dispatch is unshipped |
