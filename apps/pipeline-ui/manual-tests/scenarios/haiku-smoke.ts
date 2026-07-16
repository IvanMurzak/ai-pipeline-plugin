/**
 * Opt-in Haiku smoke test — invokes the real /api/chat with the cheapest
 * Claude model to verify the end-to-end SDK path works.
 *
 * Cost: ~$0.001-0.01 per invocation (a few hundred Haiku tokens).
 *
 * Skipped by default. Run with --include-haiku to opt in.
 */

import type { Scenario } from "./index.ts";
import { expect } from "../harness.ts";

export const haikuSmoke: Scenario = {
  name: "haiku-smoke",
  description:
    "Real /api/chat call with claude-haiku-4-5-20251001 — minimal prompt, verifies SDK chain works end-to-end",
  async run(h) {
    const proj = await h.tempProject("haiku-smoke");
    console.log("    → calling /api/chat with Haiku (will spend a few cents)...");
    const start = Date.now();
    const { events } = await h.runChat({
      projectId: proj.project_id,
      pipelineName: null,
      prompt:
        'Reply with the exact single word "PASS" and nothing else. Do not use any tools.',
      model: "claude-haiku-4-5-20251001",
      timeoutMs: 90_000,
    });
    const dur = Date.now() - start;
    console.log(`    → ${events.length} SSE events received in ${dur}ms`);
    const types = events.map((e) => e.type);
    let ok = true;
    ok = expect("got chat.started", types.includes("chat.started")) && ok;
    ok = expect("got chat.completed", types.includes("chat.completed")) && ok;
    ok = expect("did NOT get chat.error", !types.includes("chat.error")) && ok;
    // Verify at least one assistant message arrived
    const assistantMessages = events.filter(
      (e) =>
        e.type === "chat.message" &&
        (e.data as { type?: string })?.type === "assistant",
    );
    ok = expect("at least one assistant message", assistantMessages.length > 0) && ok;
    // Verify the text contains PASS
    const allText = assistantMessages
      .flatMap((e) => {
        const m = e.data as {
          message?: {
            content?: Array<{ type?: string; text?: string }>;
          };
        };
        return (m.message?.content ?? [])
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string);
      })
      .join(" ");
    console.log(
      `    → assistant text: ${JSON.stringify(allText.slice(0, 200))}`,
    );
    ok = expect("assistant said PASS", /\bPASS\b/i.test(allText)) && ok;
    return ok;
  },
};
