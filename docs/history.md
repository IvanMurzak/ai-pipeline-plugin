# Source of the design

> Moved verbatim from the plugin `CLAUDE.md` — load-bearing contracts, loaded on demand. Follow each bullet's lockstep rules and bump the plugin `version` in `plugin.json` on any meaningful change (see `CLAUDE.md`).

The two agents were ported from `ai-game-developer-infra/.claude/agents/pipeline-*.md`, where they were bound to that project's specific directory layout and category names (`unity-project/`, `server/`). The extraction changes:

1. All concrete category names and pipeline-name examples were replaced with generic placeholders (`<category>`, `<pipeline-name>`).
2. Folder-structure diagrams now explicitly show `<project-cwd>/.claude/pipeline/` as the root, making clear that pipelines belong to the consumer project.
3. An explicit "Location of pipelines" section at the top of each agent binds the pipeline root to the consumer project's CWD and forbids writes to `${CLAUDE_PLUGIN_ROOT}`.
4. Success-criteria examples no longer reference specific build tools (like `dotnet build`) — they describe the shape of a good criterion instead, so the agent picks commands from the consumer project's own conventions.
5. User-invocable skills (`/pipeline:design`, `/pipeline:run`) were added as thin routers over the two subagents.
