// @vitest-environment jsdom
/**
 * RunsOverview — the fold-preference contract, rendered (design 07 / a4 DoD).
 *
 *   bun run test
 *
 * `preferFoldCount` is unit-tested next door; this asserts the thing a unit
 * test cannot: that a row actually renders the `~` marker while only the
 * event-folded number exists, and drops it once the transcript fold for that
 * run arrives — including the case where one run is folded and its neighbour
 * is not, which is what the batch endpoint makes possible.
 *
 * The api module is mocked so the test controls exactly when the fold lands.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import type { RunState, RunStats } from "../../types";

/** What the mocked batch endpoint currently returns. Mutated per test. */
let batchResponse: Record<string, RunStats> = {};

vi.mock("../../lib/api", () => ({
  fetchRunStatsBatch: vi.fn(async () => batchResponse),
}));

// Imported AFTER the mock so the hook picks up the stub.
const { RunsOverview } = await import("../RunsOverview");

function stats(overrides: Partial<RunStats> = {}): RunStats {
  return {
    tools_called: 0,
    tools_failed: 0,
    agents_spawned: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: 0,
    ...overrides,
  } as RunStats;
}

function run(runId: string, toolsCalled: number, name = runId): RunState {
  return {
    run_id: runId,
    parent_run_id: null,
    pipeline_name: name,
    current_iteration_path: "/p/alpha/steps/01-a.md",
    current_iteration_index: 1,
    iteration_count_completed: 1,
    status: "running",
    started_at: "2026-07-22T10:00:00.000Z",
    last_event_at: "2026-07-22T10:00:05.000Z",
    halt_reason: null,
    blocker_issue_url: null,
    worktree: null,
    default_model: null,
    current_resolved_model: null,
    awaiting_input: false,
    awaiting_input_kind: null,
    stats: stats({ tools_called: toolsCalled }),
    children: [],
  };
}

function renderOverview(runs: RunState[]) {
  return render(
    <RunsOverview
      projectId="proj-1"
      runs={runs}
      driveRunsById={new Map()}
      onSelect={() => {}}
      onLaunchClick={() => {}}
      onAnswered={() => {}}
    />,
  );
}

/** The row's stat line, e.g. "1 done · ~7 tools". */
function statLine(pipelineName: string): string {
  const card = screen.getByText(pipelineName).closest("div.surface");
  if (!card) throw new Error(`no card for ${pipelineName}`);
  const line = card.querySelector("div.font-mono.text-\\[9px\\]");
  return (line?.textContent ?? "").replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  batchResponse = {};
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RunsOverview — fold-preferred tool counts", () => {
  test("shows the event count marked `~` while no transcript fold exists", async () => {
    batchResponse = {}; // nothing folded yet
    renderOverview([run("runa", 7, "alpha")]);

    await waitFor(() => expect(statLine("alpha")).toContain("tools"));
    expect(statLine("alpha")).toBe("1 done · ~7 tools");
  });

  test("drops the `~` and shows the fold's number once it arrives", async () => {
    batchResponse = { runa: stats({ tools_called: 42 }) };
    renderOverview([run("runa", 7, "alpha")]);

    // The authoritative 42 replaces the undercounting 7 — it never adds to it.
    await waitFor(() => expect(statLine("alpha")).toContain("42"));
    expect(statLine("alpha")).toBe("1 done · 42 tools");
    expect(statLine("alpha")).not.toContain("~");
    expect(statLine("alpha")).not.toContain("7 tools");
  });

  test("marks each row independently — a folded run next to an unfolded one", async () => {
    // Exactly the mixed state the batch endpoint produces when one run has a
    // bound transcript and its neighbour doesn't yet.
    batchResponse = { runa: stats({ tools_called: 42 }) };
    renderOverview([run("runa", 7, "alpha"), run("runb", 3, "beta")]);

    await waitFor(() => expect(statLine("alpha")).toContain("42"));
    expect(statLine("alpha")).toBe("1 done · 42 tools");
    expect(statLine("beta")).toBe("1 done · ~3 tools");
  });

  test("an all-zeros fold is treated as `no transcript bound`, not as zero work", async () => {
    // The hook drops empty folds, so the row must fall back to the event
    // number rather than blanking a row that did real work.
    batchResponse = { runa: stats() };
    renderOverview([run("runa", 7, "alpha")]);

    await waitFor(() => expect(statLine("alpha")).toContain("tools"));
    expect(statLine("alpha")).toBe("1 done · ~7 tools");
  });

  test("no numbers anywhere ⇒ no tools chip at all (never a bare 0)", async () => {
    batchResponse = {};
    renderOverview([run("runa", 0, "alpha")]);

    await waitFor(() => expect(statLine("alpha")).toBe("1 done"));
    expect(statLine("alpha")).not.toContain("tools");
  });

  test("the provisional marker carries the explanatory tooltip", async () => {
    batchResponse = {};
    renderOverview([run("runa", 7, "alpha")]);

    const marked = await screen.findByTitle(/provisional/i);
    expect(marked.textContent).toBe("~7");
  });
});
