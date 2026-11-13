# jev-api docs (for Claude sessions)

Working documents for agent sessions. Not shipped (`plugin/` is the installable part), not user documentation. Language: English. Format rules: `.claude/rules/plugin-docs-tasks.md`.

## Layout

- `TASKS.md`: index and checklist of the performance and robustness findings (F01-F20). Start here.
- `EVALUATION-<date>.md`: a dated measurement run of the built `plugin/hooks/register.mjs` (method, machine, numbers, findings). Latest: `EVALUATION-2026-11-13.md` (plugin 0.3.1, plus its section "Re-run on 0.3.2 / jevfort 0.9.1").
- `tasks/<id>-<slug>.md`: one document per finding. Frontmatter `id`, `title`, `status` (`done|partial|docs-only|open|closed`), `priority`, `area`; sections Status, Problem, Evidence, Code locations, Approach, Verification, Constraints, Related.

## How to work a task

1. Pick an unchecked task in `TASKS.md` (highest priority first), read it and its `Related` tasks. Check it against the current code first: symbols move.
2. Read `../CLAUDE.md`. Locate code by the symbol names under `Code locations` (no line numbers on purpose).
3. Change `src/hooks/register.mts` (or, for a task with area `jevfort/...`, the jevfort sources), add the test named under `Verification` to `tests/register.test.mts`, then `pnpm lint && pnpm --filter jev-api build && pnpm --filter jev-api test`. Never edit `plugin/**/*.mjs` by hand.
4. Any change under `jev-api/` merged to `main` needs a version bump in `package.json`. jevfort calls `batch`: do not change its name, input or answer shape.
5. Set `status` in the task, say what shipped (version, test), tick it in `TASKS.md` and note new numbers in a new dated evaluation instead of editing old ones.

## Conventions

- Every owned tool call is answered (a `deny` on failure, never `next(e)`); foreign tools go to `next(e)` untouched.
- Numbers come from one WSL2 machine, an in-process harness with a fake `$` (not the Claude Code engine) and a local HTTP stub; real System One numbers only where the evaluation says so. Re-measure before relying on a number.
