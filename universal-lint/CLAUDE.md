# universal-lint

Hook-driven plugin (plus one user-only on-demand skill): six `command` hooks share one entry, `plugin/hooks/lint-file.mjs` (a 3-line entry `src/hooks/lint-file.ts`; the logic is `src/hooks/lint-core.ts`, inlined by tsdown into the self-contained, zero-dependency build), which dispatches on the event. PostToolUse `Write|Edit` runs the just-written file's standard linter (check-only, never `--fix`/`--format`/`--write`) for Shell/Java/Kotlin/JS-TS/Python/Go/YAML/Markdown/CSS/SCSS/PHP/Rust; SessionStart/CwdChanged print the cwd's lintable git files as `watchPaths`; FileChanged lints a watched file changed outside Write/Edit; Stop/SubagentStop lint the files whose edits no report has covered yet (a subagent's edits are linted only there, so its findings reach the subagent and not the main conversation). TypeScript files (`.ts`/`.tsx`/`.mts`/`.cts`) additionally get a whole-project `tsc --noEmit` type-check. JSON is deliberately excluded.

## Parts

Two layers. The path-scoped rules in `.claude/rules/` load when you work on matching files and hold the constraints only. The design pages in `development/wiki/plugins/universal-lint/design/` hold the reasons, measurements, accepted residuals and rejected alternatives; they are not loaded by themselves. Do not "fix" any behaviour of an area without reading its design page first:

- Hook `lint-file` (`src/hooks/lint-core.ts`, entry `src/hooks/lint-file.ts`): rule `lint-file.md`, one section per area, each naming its design page:
  - `development/wiki/plugins/universal-lint/design/hook-design.md`: six command hooks with one entry, command hooks instead of an MCP server, timeout budget, runtime behaviour, measured per-event cost and the `scripts/perf.ts` harness.
  - `development/wiki/plugins/universal-lint/design/settle-window.md`: who gets a finding and when (owner routing, the journal of pending edits, the quiet-time hold, the Stop/SubagentStop sweep; F34, F40).
  - `development/wiki/plugins/universal-lint/design/edit-range-gate.md`: Edit-range gate. `development/wiki/plugins/universal-lint/design/file-detection.md`: scope, watch list, FileChanged gates, slot cap, project-check lock, digest store, path exclusions. `development/wiki/plugins/universal-lint/design/npx-and-local-bin.md`: local `node_modules/.bin`, npx fallback, PATH probe cache.
  - `development/wiki/plugins/universal-lint/design/typescript-check.md` (the `tsc` pass), `development/wiki/plugins/universal-lint/design/line-length-guard.md` (YAML/Markdown max-line-length guard).
  - `development/wiki/plugins/universal-lint/design/languages.md` (why JSON is not covered) and one page per language: `lang-jsts.md`, `lang-css.md`, `lang-php.md`, `lang-rust.md`, `lang-go.md`.
- Skill `universal-lint` (`assets/skills/universal-lint/`, driver `src/skills/universal-lint/lint-files.ts`): rule `skill-driver.md`.
- Tests: rule `tests.md`.
- Comments in `src/` still name the design pages by their old path `.claude/rules/<name>.md`; the file names are unchanged. Correct them with the next source change (a comment-only change of `src/` would force a release).

## No `userConfig` (deliberate, permanent)

- `package.json` has `"claudePlugin": {}` and no `userConfig`: the plugin ships no feature toggle. Keep it that way; this is not a stopgap expected to gain a toggle.
- The hook IS the entire plugin (read-only linting is its one behaviour); disabling it is equivalent to uninstalling the plugin, so no separate on/off switch is offered. Per-language opt-out is simply not installing that linter. An old `auto_lint: false` setting is silently ignored.
- The marketplace repo's "every feature gets a boolean `userConfig` toggle" rule has an explicit no-toggle exception for this plugin and `universal-format` (2026-07-24), for exactly this reason.

## Pitfalls

- Debug against `src/`, not the built output.
- The hooks are generated from `hooks.template.json` (`command: "./src/hooks/lint-file.ts"`) as `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/lint-file.mjs"]`; the built entry keeps its shebang and the exec bit the preset sets on a script output (0755).
- `lint-core.ts` must not start work at import: the skill driver inlines it, and a top-level `main()` there would start the hook's stdin loop in the driver (`tests/skill.test.ts` guards it). Keep the entry a separate file.
