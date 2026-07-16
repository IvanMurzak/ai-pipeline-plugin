#!/usr/bin/env bun
/**
 * Manual-test runner.
 *
 * Usage:
 *   bun manual-tests/run.ts                 # run all $0-cost scenarios
 *   bun manual-tests/run.ts --include-haiku # also fire one real Haiku chat
 *   bun manual-tests/run.ts --only=<name>   # run just one scenario
 *   bun manual-tests/run.ts --snapshot      # print a snapshot of every temp project at the end
 *
 * The harness reuses the running pipeline-ui daemon if one is up; otherwise
 * it spawns one. Every scenario uses a fresh temp project so they don't
 * cross-contaminate, and temp projects are cleaned up at the end.
 */

import { Harness } from "./harness.ts";
import { allScenarios, type Scenario } from "./scenarios/index.ts";
import { haikuSmoke } from "./scenarios/haiku-smoke.ts";
import { chatAbortNoTokenLeak } from "./scenarios/deep.ts";
import { modelHaikuEndToEnd } from "./scenarios/model.ts";

interface Args {
  includeHaiku: boolean;
  only: string | null;
  snapshot: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { includeHaiku: false, only: null, snapshot: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--include-haiku") a.includeHaiku = true;
    else if (arg.startsWith("--only=")) a.only = arg.slice("--only=".length);
    else if (arg === "--snapshot") a.snapshot = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: bun manual-tests/run.ts [--include-haiku] [--only=<name>] [--snapshot]");
      process.exit(0);
    } else {
      console.error(`unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const harness = new Harness();

  console.log("┌─ Pipeline UI manual-test harness");
  const lock = await harness.ensureDaemon();
  console.log(
    `│  daemon: pid=${lock.pid} port=${lock.port} version=${lock.plugin_version}`,
  );
  console.log("└─");

  let scenarios: Scenario[] = [...allScenarios];
  if (args.includeHaiku) {
    scenarios.push(haikuSmoke);
    // chat-abort scenario is also Haiku-backed (proves the abort doesn't
    // leak tokens beyond the disconnect point); group it with the smoke.
    scenarios.push(chatAbortNoTokenLeak);
    // Issue #7 end-to-end — proves PIPELINE.md `model: haiku` actually
    // reaches the SDK without an explicit body.model override. Also
    // Haiku-backed, so gated on the same flag.
    scenarios.push(modelHaikuEndToEnd);
  }
  if (args.only) {
    scenarios = scenarios.filter((s) => s.name === args.only);
    if (scenarios.length === 0) {
      console.error(`no scenario matches --only=${args.only}`);
      process.exit(2);
    }
  }

  const results: Array<{ name: string; pass: boolean; duration_ms: number; error?: string }> = [];
  for (const s of scenarios) {
    console.log(`\n▶ ${s.name}`);
    console.log(`  ${s.description}`);
    const start = Date.now();
    let pass = false;
    let err: string | undefined;
    try {
      pass = await s.run(harness);
    } catch (e) {
      pass = false;
      err = e instanceof Error ? e.stack ?? e.message : String(e);
      console.log(`    ✗ threw: ${err.split("\n")[0]}`);
    }
    const duration_ms = Date.now() - start;
    results.push({ name: s.name, pass, duration_ms, error: err });
    console.log(`  → ${pass ? "PASS" : "FAIL"} (${duration_ms}ms)`);
  }

  if (args.snapshot) {
    console.log("\n┌─ Final snapshot");
    const projs = await harness.getProjects();
    console.log(`│  ${projs.length} projects registered in daemon`);
    console.log("└─");
  }

  await harness.cleanup();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log("\n┌─ Summary");
  console.log(`│  ${passed}/${results.length} passed${failed > 0 ? `, ${failed} failed` : ""}`);
  if (failed > 0) {
    console.log("│  Failed:");
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`│    • ${r.name}${r.error ? ` — ${r.error.split("\n")[0]}` : ""}`);
    }
  }
  console.log("└─");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("harness failed:", e);
  process.exit(1);
});
