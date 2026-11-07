# universal-lint docs (for Claude sessions)

Working documents for agent sessions. Not shipped (`plugin/` is the installable part), not user documentation. Language: English.

## Layout

- `TASKS.md`: index and staged checklist of all performance tasks (F01-F33), with dependencies. Start here.
- `tasks/<id>-<slug>.md`: one detail document per task. Frontmatter: `id`, `title`, `status` (`done|partial|open|docs-only|measurement-only`), `priority`, `area`. Sections: Status, Problem, Evidence, Code locations, Approach, Verification, Constraints, Related.

## How to work a task

1. Pick the first unchecked task in `TASKS.md` (stage order, then priority) whose dependencies are done. Read its detail document plus the documents under its `Related` section.
2. Read `../CLAUDE.md` and the rule files it names, at least `../.claude/rules/hook-design.md` (fail-open contract, timeout budget, edit-range gate, file detection) and `../.claude/rules/languages.md`. Several tasks touch documented user decisions; the task says so under `Constraints`. Ask before changing one.
3. Locate code by the symbol names in `Code locations` (`src/hooks/lint-file.mts` unless stated otherwise); line numbers are deliberately absent because they drift.
4. Re-measure the baseline numbers the task cites (see F01) before and after the change. The numbers in these documents are from one machine and one day.
5. Implement in `src/`, add the tests named under `Verification`, then run `pnpm --filter universal-lint build && pnpm --filter universal-lint test && pnpm lint`. Never edit `plugin/**/*.mjs` or `plugin/.claude-plugin/plugin.json` by hand.
6. Any change under `universal-lint/` merged to `main` needs a version bump: `version` in `universal-lint/package.json` (the only manifest source), then `pnpm --filter universal-lint build`.
7. Update the rule file that documents the changed behaviour (usually `hook-design.md` or `languages.md`; keep each rule file under 40,000 characters).
8. Update the task: set `status` in its frontmatter, adjust `Status`/`Approach` to what shipped, and tick it in `TASKS.md` (move it to the done section).

## Conventions

- Fail open everywhere in the hook path: every guard failure, skip, missing tool, timeout or internal error ends with no output and exit `0`. Only real findings produce the `universal-lint…: …` text on stderr with exit `2` (asyncRewake). A false finding is worse than a missed one, because it wakes Claude.
- Linting never modifies the user's files or repo (no `--fix`, no installs into the project tree). Persistent plugin state goes under `${CLAUDE_PLUGIN_DATA || os.tmpdir()}` only, written atomically (temp file + `renameSync`, as `recordWritten` does), and an unreadable cache means "probe again".
- No debounce for Write/Edit (user decision 2026-11-06): every Write/Edit lints right away in its own process. No `userConfig` (permanent). Command hooks, no MCP server (user decision 2026-11-06).
- Runtime code stays zero-dependency Node (`node:` builtins only). New symbols get TSDoc (`.claude/rules/tsdoc.md` at the repo root).
- Measurements come from one WSL2 machine (12 cores, 9.7 GB RAM) on 2026-11-07 with universal-lint 0.14.0; its PATH has 63 entries, 44 of them Windows dirs on `/mnt/c` (9P), which inflates every PATH scan. Re-measure before relying on a number. The harness is `universal-lint/scripts/perf.mts` (F01); 0.15.4 numbers are in `.claude/rules/hook-design.md` "Measured cost".
