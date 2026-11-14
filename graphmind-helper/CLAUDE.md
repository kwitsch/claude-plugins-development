# CLAUDE.md — graphmind-helper

`plugin/` is the installable plugin. `plugin/.claude-plugin/plugin.json` and all `plugin/**/*.mjs` are build output of `src/` and `package.json` (`pnpm build`); do not edit them.

## Components

- `src/hooks/register.mts`: the function-hooks module (`hooks.json` is `{"modules": ["./register.mjs"]}`), every `$` use. Hooks: `session.start` (reset, binary toast), `session.end` (reset), `prompt.submit` (briefing on the first prompt, recall on every one, as `context` entries), `tool.call` (one unmatched hook: the once-per-session nudge as `context` on the result of the first search). It ports the scripts `graphmind setup` installs as `~/.claude/hooks/graphmind-{session,prompt,search}.sh` (checked against graphmind on 2026-11-14); keep behaviour in step with them.
- `src/hooks/terms.mts`: pure helpers (term extraction, nudge rule, output budget `fit`, tool-name resolution). No `$` (the engine rejects it outside the module file).
- `src/bin/mcp.mts` + `src/bin/common.mts` + `plugin/.mcp.json`: wrapper that runs `init --skip-build`, a detached `build`, then `graphmind mcp` with inherited stdio. It passes graphmind's own server through, so the repo's dual-era MCP rule does not apply. The binary's directory list is `binaryDirs` in `terms.mts`, used by the module and (imported as `../hooks/terms.mjs`) by `findGraphmind` in the wrapper.

## Decisions

- Rebuilt from three Node command hooks (0.1.0) to a mod (0.2.0): measured here, a CLI call costs about 9 ms and a Node cold start 28 ms, so the gain is the Node start per hook call (every prompt, every Grep/Glob/Agent/Bash call) and in-memory state instead of state files. The 186 ms code search is the search itself.
- Approach B (decided headless): MCP tools for status, map, recent memory and code search; `$.process.run` (no shell) only for what the tools cannot do: `memory list --priority` (the MCP list has no priority filter or star, ids are UUIDs) and `memory search --no-recall` (no such tool option; graphmind issue #112).
- Tool names differ per server: the plugin's own is `mcp__plugin_graphmind-helper_graphmind__gm_*`, a `graphmind setup` server `mcp__graphmind__gm_*`. `resolveTools` matches the `__gm_*` suffix on a server whose name holds `graphmind`, the plugin's own first, so both work.
- Readiness = `gm_status` with `project: <session cwd>` answers (it errors "not registered" otherwise); positive answers are cached for the conversation, negative ones 30 s (the wrapper may register the project a moment later). Tool listing cached 30 s once found (no engine event reports a changed list).
- The briefing waits for the first `prompt.submit`: the MCP server starts concurrently with `session.start`.
- Init stays in the MCP wrapper (before the server starts); guarded: inside a git work tree, not `$HOME`, only when `graphmind which` fails.
- Without the binary the module adds nothing, the wrapper exits 1 (the server shows as failed in `/mcp`), the toast explains.
- Dedupe: the module adds nothing when `~/.claude/settings.json` names the setup's scripts (read once per conversation).
- `$.tool.call` and `$.process.run` run in-frame of a hook (permission checks otherwise prompt); all of them are awaited inside `prompt.submit`/`tool.call`. Every failure fails open (the prompt or result passes unchanged).

## Live-verified (`claude -p`, Claude Code 2.1.325, 2026-11-14; setup hooks kept out by a temp `HOME` plus `CLAUDE_CONFIG_DIR` and `--setting-sources project`)

- The module loads (`graphmind-helper@inline`, events session.start/session.end/prompt.submit/tool.call) and the plugin's MCP server connects as `plugin:graphmind-helper:graphmind`; `$.tool.call` reaches its tools as `mcp__plugin_graphmind-helper_graphmind__gm_*`.
- A real MCP tool result is `{ result: [{ type: "text", text }], text }`, not a string (a first build read only strings and silently added nothing): `textOf` reads `text`, then a string `result`, then the text parts.
- The first-prompt briefing (a `context` entry returned from `prompt.submit`) reaches the model verbatim. The nudge (`context` on a `tool.call` result) reaches it too, shown to the model as "tool.call hook additional context".
- Not exercised live: a `graphmind setup` server (name `mcp__graphmind__*`, only in the kit test), the setup-hooks dedupe, an unregistered project and init, the 10th-prompt checkpoint.

## Tests

`tests/register.test.mts` drives the built module with `createKit` (stubs for tool list/calls, `process.run`, fs, env, cwd, toast); `tests/terms.test.mts` the pure helpers; `tests/mcp.test.mts` spawns the built wrapper with a fake `graphmind` shell script on `PATH` and a temp `HOME`.
