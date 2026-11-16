# Plugin sections

What the wiki holds per plugin: task list (`TASKS.md`, `tasks/`), dated evaluations and design pages; format and rules in [plugin-docs-tasks.md](../../../.claude/rules/plugin-docs-tasks.md). The plugin's `CLAUDE.md` and rules stay in its directory.

- dprint: [wiki section](dprint/README.md), [CLAUDE.md](../../../dprint/CLAUDE.md). Formatter hooks through an MCP server, the language-server client, the "no runner" notice.
- inline-headroom: [CLAUDE.md](../../../inline-headroom/CLAUDE.md). Context compression policies; evidence of Claude Code behaviour: [claude-code-verification.md](inline-headroom/claude-code-verification.md), [linux-token-efficiency-concepts.md](inline-headroom/linux-token-efficiency-concepts.md).
- jev-api: [wiki section](jev-api/README.md), [CLAUDE.md](../../../jev-api/CLAUDE.md). The System One question tools; the API's limits, latency and error bodies are in its rules [oversized-state.md](../../../jev-api/.claude/rules/oversized-state.md), [hooks-source.md](../../../jev-api/.claude/rules/hooks-source.md) and [http-mcp-server.md](../../../jev-api/.claude/rules/http-mcp-server.md).
- jevfort: [wiki section](jevfort/README.md), [CLAUDE.md](../../../jevfort/CLAUDE.md). Effort estimation, taking steps, cache countdown and compaction; standing user decisions are in its `CLAUDE.md`.
- universal-lint: [wiki section](universal-lint/README.md), [CLAUDE.md](../../../universal-lint/CLAUDE.md). Lint hooks. Its rule [lint-file.md](../../../universal-lint/.claude/rules/lint-file.md) holds the constraints; the reasons are in the design pages under `design/`, for example who gets a finding and when in [settle-window.md](universal-lint/design/settle-window.md).
