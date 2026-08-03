# Running pipelines

Four ways to run a pipeline. They differ in **where you start them from**, not in
what they do — the same pipeline, the same steps, the same result.

Every one of them streams live to your cloud dashboard once you have run
`pipeline cloud connect`.

## Terminology

| Term | Meaning |
| --- | --- |
| **Pipeline** | The workflow definition — what to do, in `.claude/pipeline/<name>/` |
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

## 1. From Claude Code — `/pipeline:run`

The main path. You already know which pipeline you want.

```
/pipeline:run .claude/pipeline/support-answer/steps/01-triage.md
```

Claude runs the chain step by step in fresh contexts, showing progress as it
goes, and prints a dashboard link at the start.

**Use it when:** you are working in Claude Code and you know the pipeline.

---

## 2. From Claude Code — `/pipeline:dispatch`

Same as above, but you describe the task and let it pick the pipeline.

```
/pipeline:dispatch Answer ticket #482 about the refund policy
```

It matches your description against every pipeline in the project, picks the
best fit (or a chain of them), and runs it without asking.

To see the match *before* running it, use `/pipeline:find` instead — it shows
the ranked candidates and waits for your confirmation.

**Use it when:** you have a task, not a pipeline name.

---

## 3. From the terminal — `pipeline drive`

No Claude Code session needed. Runs headless.

```
pipeline drive support-answer
```

```
▶ support-answer
  live at ai-pipeline.dev/acme/runs/8fk2qp

  ✓ 01-triage          12s
  ✓ 02-search          34s
  ⠋ 03-draft-answer    running…
```

If a step needs your input, the run parks and tells you how to answer. Resume
with the same command.

**Use it when:** scripting, CI, or you just prefer the terminal.

---

## 4. From the cloud — dispatch to a runner

> **Not shipped yet.** The dashboard's Launch button is not wired up. This
> section describes the intended shape; the other three methods work today.

Start a run from the dashboard and have it execute somewhere else.

```
Dashboard → Run → pick project and pipeline
```

The work is queued in the cloud and a runner picks it up. There are two kinds
of runner:

| Runner | Who provides the machine | Price |
| --- | --- | --- |
| **Your own** — `pipeline-runner` installed on your laptop, workstation, or server | You | **Free** |
| **Hosted** — we run it for you, nothing to install | Us | Paid |

**Use it when:** launching from your phone, on a schedule, or from a GitHub
webhook — anywhere you are not sitting at the machine that does the work.

To use your own machine:

```
bun add -g @baizor/pipeline-runner
pipeline-runner register --url https://ai-pipeline.dev --token <token> --label my-laptop
pipeline-runner service install
```

Once registered, it appears on the dashboard and can receive work.

---

## What reaches the dashboard

Once connected (`pipeline cloud connect`), every method above sends the same
thing:

- step progress, timings, and outcomes
- token counts and cost
- tool-call and failure counts
- the pipeline structure and which step failed

And nothing else. Prompts, transcripts, your code, file paths, tool arguments
and outputs, and error text never leave your machine — see
https://ai-pipeline.dev/docs/privacy for the exact list.

Runs started on your own machine are labelled **Local**; runs dispatched from
the cloud are labelled **Cloud**. Both appear in the same list.

**How often it updates.** From `/pipeline:run` and `/pipeline:dispatch`, the
dashboard follows along inside a step — you see tool activity as it happens.
From `pipeline drive` and cloud dispatch, it updates when each step finishes.
Both are live; the first is finer-grained.

To turn telemetry off entirely:

```
PIPELINE_SYNC_LOCAL_STATS=0
```

To check what has been sent:

```
pipeline stats telemetry
```

---

## Which one should I use?

| You want to… | Use |
| --- | --- |
| Run a pipeline you know, from Claude Code | `/pipeline:run` |
| Describe a task and let it choose | `/pipeline:dispatch` |
| See the match before it runs | `/pipeline:find` |
| Run from a terminal or a script | `pipeline drive` |
| Launch from your phone or a schedule, on your own machine | Cloud dispatch + your own runner (free) |
| Same, without providing a machine | Cloud dispatch + hosted runner (paid) |
