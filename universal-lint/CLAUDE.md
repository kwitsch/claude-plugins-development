# universal-lint

Hook-driven plugin (plus one user-only on-demand skill): four `command` hooks share one entry, `src/hooks/lint-file.mts` (self-contained, zero-dependency, built to `plugin/hooks/lint-file.mjs`), which dispatches on the event. PostToolUse `Write|Edit` runs the just-written file's standard linter (check-only, never `--fix`/`--format`/`--write`) for Shell/Java/Kotlin/JS-TS/Python/Go/YAML/Markdown/CSS/SCSS/PHP/Rust; SessionStart/CwdChanged print the cwd's lintable git files as `watchPaths`; FileChanged lints a watched file changed outside Write/Edit. TypeScript files (`.ts`/`.tsx`/`.mts`/`.cts`) additionally get a whole-project `tsc --noEmit` type-check. JSON is deliberately excluded.

## Parts

Each part has a path-scoped rule in `.claude/rules/` (loaded when you work on matching files). Do not "fix" any behaviour documented there without reading the rule first:

- Hook `lint-file` (`src/hooks/lint-file.mts`):
  - `hook-design.md`: four command hooks with one entry, command hooks instead of an MCP server, timeout budget, runtime behaviour, measured per-event cost and the `scripts/perf.mts` harness.
  - `settle-window.md`: the settle window (F34).
  - `edit-range-gate.md`: Edit-range gate. `file-detection.md`: scope, watch list, FileChanged gates, slot cap, project-check lock, digest store, path exclusions. `npx-and-local-bin.md`: local `node_modules/.bin`, npx fallback, PATH probe cache.
  - `typescript-check.md` (the `tsc` pass), `line-length-guard.md` (YAML/Markdown max-line-length guard).
  - `languages.md` (why JSON is not covered) and one file per language: `lang-jsts.md`, `lang-css.md`, `lang-php.md`, `lang-rust.md`, `lang-go.md`.
- Skill `universal-lint` (`plugin/skills/universal-lint/`, driver `src/skills/universal-lint/lint-files.mts`): `skill-driver.md`.
- Tests: `tests.md`.

## No `userConfig` (deliberate, permanent)

- `package.json` has `"claudePlugin": {}` and no `userConfig`: the plugin ships no feature toggle. Keep it that way; this is not a stopgap expected to gain a toggle.
- The hook IS the entire plugin (read-only linting is its one behaviour); disabling it is equivalent to uninstalling the plugin, so no separate on/off switch is offered. Per-language opt-out is simply not installing that linter. An old `auto_lint: false` setting is silently ignored.
- The marketplace repo's "every feature gets a boolean `userConfig` toggle" rule has an explicit no-toggle exception for this plugin and `universal-format` (2026-07-24), for exactly this reason.

## Pitfalls

- Debug against `src/`, not the built output.
- The hook is registered as `${CLAUDE_PLUGIN_ROOT}/hooks/lint-file.mjs` without a `node` prefix: it runs through its shebang and the exec bit the build sets (0755 on every output starting with `#!`). Never turn it into a file without that bit.
