# universal-lint

Mod plus MCP server (plus one user-only on-demand skill). A function-hooks mod `plugin/hooks/register.js` sends each Write/Edit to one stdio MCP server per session, `plugin/mcp/server.mjs` (server `lint`), which runs the file's standard linter (check-only, never `--fix`/`--format`/`--write`) for Shell/Java/Kotlin/JS-TS/Python/Go/YAML/Markdown/CSS/SCSS/PHP/Rust and keeps all cross-event state in memory. The server answers the edit's `context` or, for a turn's last edits, the `stop` block; the mod runs the idle wake. `mcp_tool` hooks call the server for FileChanged (`file_changed`), Stop and SubagentStop (`stop`) and UserPromptSubmit (`prompt_submitted`); the command hook `plugin/hooks/watch-paths.mjs` alone prints the watch list for SessionStart and CwdChanged. FileChanged lints a watched file changed outside Write/Edit; Stop/SubagentStop report the findings of the agent's own edits (a subagent's edits are journaled and linted only at its SubagentStop). TypeScript files (`.ts`/`.tsx`/`.mts`/`.cts`) additionally get a whole-project `tsc --noEmit` type-check. JSON is deliberately excluded.

## Parts

Two layers. The path-scoped rules in `.claude/rules/` load when you work on matching files and hold the constraints only. The design pages in `development/wiki/plugins/universal-lint/design/` hold the reasons, measurements, accepted residuals and rejected alternatives; they are not loaded by themselves. Do not "fix" any behaviour of an area without reading its design page first:

- Server and lint core (`src/mcp/server.ts`, `src/mcp/handlers.ts`, `src/hooks/lint-core.ts`): rule `lint-file.md`, one section per area, each naming its design page:
  - `development/wiki/plugins/universal-lint/design/hook-design.md`: the surface of 0.18.0 (mod, server, `mcp_tool` hooks, the watch-list command hook), the session key, server lifetime and residuals, timeout budget, runtime behaviour, measured cost and the `scripts/perf.ts` harness, the reversal of the 2026-11-06 decision.
  - `development/wiki/plugins/universal-lint/design/settle-window.md`: who gets a finding and when (owner routing, the journal of pending edits, the quiet-time hold, the Stop/SubagentStop sweep, delivery matrix).
  - `development/wiki/plugins/universal-lint/design/edit-range-gate.md`: Edit-range gate. `development/wiki/plugins/universal-lint/design/file-detection.md`: scope, watch list, FileChanged gates, slot cap, project-check lock, digest store, path exclusions, worktree scope base. `development/wiki/plugins/universal-lint/design/npx-and-local-bin.md`: local `node_modules/.bin`, npx fallback, PATH probe memo.
  - `development/wiki/plugins/universal-lint/design/typescript-check.md` (the `tsc` pass), `development/wiki/plugins/universal-lint/design/line-length-guard.md` (YAML/Markdown max-line-length guard).
  - `development/wiki/plugins/universal-lint/design/languages.md` (why JSON is not covered) and one page per language: `lang-jsts.md`, `lang-css.md`, `lang-php.md`, `lang-rust.md`, `lang-go.md`.
- Mod (`src/hooks/register.ts`): its constraints are in `lint-file.md` (the hook contract) and `development/wiki/plugins/universal-lint/design/hook-design.md`.
- Skill `universal-lint` (`assets/skills/universal-lint/`, driver `src/skills/universal-lint/lint-files.ts`): rule `skill-driver.md`.
- Tests: rule `tests.md`.

## No `userConfig` (deliberate, permanent)

- `package.json` has `"claudePlugin": {}` and no `userConfig`: the plugin ships no feature toggle. Keep it that way; this is not a stopgap expected to gain a toggle.
- The hook IS the entire plugin (read-only linting is its one behaviour); disabling it is equivalent to uninstalling the plugin, so no separate on/off switch is offered. Per-language opt-out is simply not installing that linter. An old `auto_lint: false` setting is silently ignored.
- The marketplace repo's "every feature gets a boolean `userConfig` toggle" rule has an explicit no-toggle exception for this plugin and `universal-format` (2026-07-24), for exactly this reason.

## Pitfalls

- Debug against `src/`, not the built output.
- The hooks are generated from `hooks.template.json` (the `mcp_tool` hooks name the `lint` server; the watch-list command is `./src/hooks/watch-paths.ts`, built to `plugin/hooks/watch-paths.mjs`, with the shebang and exec bit the preset sets). The mod is `./src/hooks/register.ts`, built to `plugin/hooks/register.js`; the server is `./src/mcp/server.ts` (`mcp.template.json`), built to `plugin/mcp/server.mjs`. Never edit a built file.
- `lint-core.ts` must not start work at import: the skill driver inlines it, and a top-level server start or stdin loop there would run in the driver (`tests/skill.test.ts` guards it). Keep each entry (`server.ts`, `watch-paths.ts`, `lint-files.ts`) a separate file.
- Tests: `claude-tests/` holds the mod tests run by `claude plugin test` on the built plugin (`pnpm --filter universal-lint test:plugin`, needs `claude`); `tests/` holds the unit and process tests (`pnpm --filter universal-lint test`, which needs a built `plugin/`).
