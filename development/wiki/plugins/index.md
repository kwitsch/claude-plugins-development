# Plugin sections

One section per plugin, each with its own `index.md` that links to everything the wiki holds for that plugin (task list, evaluations, design pages, other pages). This page lists every plugin with a link to its `index.md`. A section's pages are reached from its `index.md` only; `wiki-check.ts` enforces both levels. Format of task lists and evaluations: [plugin-docs-tasks.md](../../../.claude/rules/plugin-docs-tasks.md).

- [dprint](dprint/index.md): formatter hooks through an MCP server, the language-server client, the "no runner" notice. Task list, evaluation.
- [graphmind-helper](graphmind-helper/index.md): setup hooks and the MCP wrapper for graphmind.
- [inline-headroom](inline-headroom/index.md): context compression policies; evidence of Claude Code behaviour.
- [jev-api](jev-api/index.md): the System One tool `request` (`noul`, `choice` and `score` questions); the API's limits, latency and error bodies are in its rules [oversized-state.md](../../../jev-api/.claude/rules/oversized-state.md), [hooks-source.md](../../../jev-api/.claude/rules/hooks-source.md) and [http-mcp-server.md](../../../jev-api/.claude/rules/http-mcp-server.md). Task list, evaluations, Haiku calibration.
- [jevfort](jevfort/index.md): effort estimation, taking steps, cache countdown and compaction; standing user decisions are in its `CLAUDE.md`. Task list, evaluations.
- [rc-enhancement](rc-enhancement/index.md): the AskUserQuestion interaction contract (SessionStart rule hook plus a Stop-hook gate, both command hooks); design page with the gate's mechanism, costs and origin.
- [universal-format](universal-format/index.md): formatting before every Write and Edit through an MCP server with a vendored prettier. Its rules hold the constraints ([hooks-and-server.md](../../../universal-format/.claude/rules/hooks-and-server.md), [vendor-build.md](../../../universal-format/.claude/rules/vendor-build.md)); design pages, the migration note with the live check.
- [universal-lint](universal-lint/index.md): lint hooks. Its rule [lint-file.md](../../../universal-lint/.claude/rules/lint-file.md) holds the constraints; the reasons are in the design pages. Task list, evaluations, design pages.
