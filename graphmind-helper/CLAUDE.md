# CLAUDE.md — graphmind-helper

`plugin/` is the installable plugin. `plugin/.claude-plugin/plugin.json` and all `plugin/**/*.mjs` are build output of `src/` and `package.json` (`pnpm build`); do not edit them.

## Components

- `src/hooks/register.mts`: the function-hooks module (`hooks.json` is `{"modules": ["./register.mjs"]}`), every `$` use. Hooks: `session.start` (reset, binary toast), `session.end` (reset), `session.compact` (reset after a main-conversation compaction, machine caches kept), `prompt.submit` (briefing on the first prompt, recall on every one, as `context` entries), `tool.call` (one unmatched hook: the once-per-session nudge as `context` on the result of the first search). It ports the scripts `graphmind setup` installs as `~/.claude/hooks/graphmind-{session,prompt,search}.sh` (checked against graphmind on 2026-11-14); keep behaviour in step with them. Its decisions and engine facts: `.claude/rules/hooks-module.md`.
- `src/hooks/terms.mts`: pure helpers (term extraction, nudge rule, output budget `fit`, tool-name resolution). No `$` (the engine rejects it outside the module file).
- `src/bin/mcp.mts` + `src/bin/common.mts` + `plugin/.mcp.json`: the MCP wrapper around `graphmind mcp`; its init guard and graphmind's setup side effects: `.claude/rules/mcp-wrapper.md`.

## Decisions

- Rebuilt from three Node command hooks (0.1.0) to a mod (0.2.0): measured here, a CLI call costs about 9 ms and a Node cold start 28 ms, so the gain is the Node start per hook call (every prompt, every Grep/Glob/Agent/Bash call) and in-memory state instead of state files. The 186 ms code search is the search itself.
- Approach B (decided headless): MCP tools for status, map, recent memory and code search; `$.process.run` (no shell) only for what the tools cannot do: `memory list --priority` (the MCP list has no priority filter or star, ids are UUIDs) and `memory search --no-recall` (no such tool option; graphmind issue #112).

## Tests

`tests/register.test.mts` drives the built module with `createKit` (stubs for tool list/calls, `process.run`, fs, env, cwd, toast); `tests/terms.test.mts` the pure helpers; `tests/mcp.test.mts` spawns the built wrapper with a fake `graphmind` shell script on `PATH` and a temp `HOME`.
