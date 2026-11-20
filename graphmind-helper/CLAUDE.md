# CLAUDE.md — graphmind-helper

## Components

- `src/hooks/register.ts`: the function-hooks module (`hooks.json` is `{"modules": ["./register.js"]}`), every `$` use. Hooks: `session.start` (reset, binary toast), `session.end` (reset), `session.compact` (reset after a main-conversation compaction, machine caches kept), `prompt.submit` (briefing on the first prompt, recall on every one, as `context` entries), `tool.call` (one unmatched hook: the once-per-session nudge as `context` on the result of the first search). It ports the scripts `graphmind setup` installs as `~/.claude/hooks/graphmind-{session,prompt,search}.sh` (checked against graphmind on 2026-11-14); keep behaviour in step with them. Its decisions and engine facts: `.claude/rules/hooks-module.md`.
- `src/hooks/terms.ts`: pure helpers (term extraction, nudge rule, output budget `fit`, tool-name resolution, `binaryPaths`). No `$` (the engine rejects it outside the module file).
- `src/bin/mcp.ts` + `src/bin/common.ts` + `plugin/.mcp.json`: the MCP wrapper around `graphmind mcp`; its init guard and graphmind's setup side effects: `.claude/rules/mcp-wrapper.md`.

## Source layout

- Built with tsdown (`tsdown.config.ts`, root rule `.claude/rules/tsdown-build.md`): the mod entry `src/hooks/register.ts` ships as `plugin/hooks/register.js` (compressed, not mangled) with `terms.ts` and `@shared/graphmind-paths.js` inlined and holds every `$` use; the script entry `src/bin/mcp.ts` ships as `plugin/bin/mcp.mjs` (minified, shebang) with `common.ts` inlined.
- `src/bin/common.ts` is no entry: inlined into `mcp.mjs`; tests import it directly.
- The entry `register.ts` never imports `@shared`; inlined helpers may ([design/decisions.md](../development/wiki/plugins/graphmind-helper/design/decisions.md)).

## Decisions

- Why the plugin is a mod, why MCP tools plus two CLI calls, and where `binaryDirs` lives: [design/decisions.md](../development/wiki/plugins/graphmind-helper/design/decisions.md).

## Tests

`tests/support/kit.ts` binds `claude-engine-vitest` to the source `src/hooks/register.ts` (`makeKit`, stubs for tool list/calls, `process.run`, fs, env, cwd, toast); `tests/register.test.ts` covers the hooks' behaviour, `tests/terms.test.ts` the term, recall, code, nudge, budget and tool-name rules through the hooks; `tests/mcp.test.ts` imports the pure functions from `src/bin/common.ts` and `src/bin/mcp.ts` and spawns the built `plugin/bin/mcp.mjs` with a fake `graphmind` shell script on `PATH` and a temp `HOME`. `binaryDirs` is tested in `development/shared/tests/graphmind-paths.test.ts`. `pnpm --filter graphmind-helper test:plugin` (`development/scripts/plugin-test.ts`, needs `claude`; run it before merge, CI does not) runs `claude-tests/register.test.ts` (official `claude-code/testing` kit, type-checked through the ambient declaration in `development/vitest/claude-engine/`) with `claude plugin test` on a temp copy of `plugin/`: every event the built `register.js` registers.
