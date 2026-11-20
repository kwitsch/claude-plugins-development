# CLAUDE.md — graphmind-helper

## Components

- `src/hooks/register.ts`: the function-hooks module (`hooks.json` is `{"modules": ["./register.mjs"]}`), every `$` use. Hooks: `session.start` (reset, binary toast), `session.end` (reset), `session.compact` (reset after a main-conversation compaction, machine caches kept), `prompt.submit` (briefing on the first prompt, recall on every one, as `context` entries), `tool.call` (one unmatched hook: the once-per-session nudge as `context` on the result of the first search). It ports the scripts `graphmind setup` installs as `~/.claude/hooks/graphmind-{session,prompt,search}.sh` (checked against graphmind on 2026-11-14); keep behaviour in step with them. Its decisions and engine facts: `.claude/rules/hooks-module.md`.
- `src/hooks/terms.ts`: pure helpers (term extraction, nudge rule, output budget `fit`, tool-name resolution, `binaryPaths`). No `$` (the engine rejects it outside the module file).
- `src/bin/mcp.ts` + `src/bin/common.ts` + `plugin/.mcp.json`: the MCP wrapper around `graphmind mcp`; its init guard and graphmind's setup side effects: `.claude/rules/mcp-wrapper.md`.

## Source layout

- Entry `src/hooks/register.ts` ships unminified as `plugin/hooks/register.mjs` and holds every `$` use; the helper `src/hooks/terms.ts` is bundled into the compressed `plugin/hooks/lib.mjs` (`pluginBuild.bundleHooksLib`, rule `.claude/rules/hooks-lib-bundle.md`).
- `binaryDirs` comes from `@shared/graphmind-paths.js` (`development/shared/src/graphmind-paths.ts`, shipped as `plugin/shared/graphmind-paths.mjs`), imported by `terms.ts` and `src/bin/common.ts`; the entry never imports `@shared` and takes `binaryPaths` from `terms.ts`.

## Decisions

- Why the plugin is a mod, why MCP tools plus two CLI calls, and where `binaryDirs` lives: [design/decisions.md](../development/wiki/plugins/graphmind-helper/design/decisions.md).

## Tests

`tests/support/kit.ts` binds `claude-engine-vitest` to the built `plugin/hooks/register.mjs` (`makeKit`, stubs for tool list/calls, `process.run`, fs, env, cwd, toast); `tests/register.test.ts` covers the hooks' behaviour, `tests/terms.test.ts` the term, recall, code, nudge, budget and tool-name rules through the hooks; `tests/mcp.test.ts` spawns the built wrapper with a fake `graphmind` shell script on `PATH` and a temp `HOME` and imports `plugin/bin/*.mjs`. `binaryDirs` is tested in `development/shared/tests/graphmind-paths.test.ts`.
