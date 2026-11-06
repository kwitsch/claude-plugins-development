# universal-lint

Hook-driven plugin (plus one user-only on-demand skill): a PostToolUse `Write|Edit` `command` hook runs the just-written file's standard linter (check-only, never `--fix`/`--format`/`--write`) for Shell/Java/Kotlin/JS-TS/Python/Go/YAML/Markdown/CSS/SCSS/PHP/Rust, backed by the self-contained zero-dependency `src/hooks/lint-file.mts` (built to `plugin/hooks/lint-file.mjs`). TypeScript files (`.ts`/`.tsx`/`.mts`/`.cts`) additionally get a whole-project `tsc --noEmit` type-check. JSON is deliberately excluded.

Ported from kwitsch/claude-plugins (`plugins/universal-lint/`, 0.10.3) with the behaviour unchanged; the only functional difference is where the markdownlint MD013-off config lives (see `.claude/rules/line-length-guard.md`).

## Parts

Each part has a path-scoped rule in `.claude/rules/` (loaded when you work on matching files). Do not "fix" any behaviour documented there without reading the rule first:

- Hook `lint-file` (`src/hooks/lint-file.mts`): `hook-design.md` (one async command hook, debounce, timeout budget, runtime behaviour, npx fallback, rtk compaction, path exclusions), `typescript-check.md` (the `tsc` pass), `line-length-guard.md` (YAML/Markdown max-line-length guard), `languages.md` (SCSS limitation, PHP, Rust, why JSON is not covered).
- Skill `universal-lint` (`plugin/skills/universal-lint/`, driver `src/skills/universal-lint/lint-files.mts`): `skill-driver.md`.
- Tests: `tests.md`.

## No `userConfig` (deliberate, permanent)

- `package.json` has `"claudePlugin": {}` and no `userConfig`: the plugin ships no feature toggle. Keep it that way; this is not a stopgap expected to gain a toggle.
- The hook IS the entire plugin (read-only linting is its one behaviour); disabling it is equivalent to uninstalling the plugin, so no separate on/off switch is offered. Per-language opt-out is simply not installing that linter. An old `auto_lint: false` setting is silently ignored.
- The marketplace repo's "every feature gets a boolean `userConfig` toggle" rule has an explicit no-toggle exception for this plugin and `universal-format` (2026-07-24), for exactly this reason.

## Pitfalls

- Everything under `plugin/` that is `.mjs` or `.claude-plugin/plugin.json` is build output; edit `src/` or `package.json` and run `pnpm --filter universal-lint build`. Debug against `src/`, not the built output.
- The hook is registered as `${CLAUDE_PLUGIN_ROOT}/hooks/lint-file.mjs` without a `node` prefix: it runs through its shebang and the exec bit the build sets (0755 on every output starting with `#!`). Never turn it into a file without that bit.
- Behaviour changes need a `package.json` version bump (a change under `universal-lint/` merged to `main` is released and synced to kwitsch/claude-plugins).

## Commands

```bash
pnpm --filter universal-lint build   # src/ + package.json -> plugin/
pnpm --filter universal-lint test    # vitest over tests/*.test.mts against the built plugin/
pnpm lint                            # repo root: oxlint (also type-checks src/ and tests/)
claude plugin validate universal-lint/plugin
```
