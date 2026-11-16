# jev-api knowledge

Working documents for agent sessions. Not shipped (`plugin/` is the installable part), not user documentation. Language: English. Format rules: `.claude/rules/plugin-docs-tasks.md`.

## Pages

- [CLAUDE.md](../../../../jev-api/CLAUDE.md): the plugin's overview and rule list (loads with the plugin's files).
- [TASKS.md](TASKS.md): task list; `tasks/` holds one document per task. Start here for open work.
- [evaluations/EVALUATION-2026-11-13.md](evaluations/EVALUATION-2026-11-13.md): evaluation: jev-api evaluation 2026-11-13 (plugin 0.3.1)
- [evaluations/EVALUATION-2026-11-15.md](evaluations/EVALUATION-2026-11-15.md): evaluation: jev-api evaluation 2026-11-15 (plugin 0.5.0)
- [notes/haiku-calibration.md](notes/haiku-calibration.md): note: Haiku fallback: history and calibration

## How to work a task

1. Pick an open task from "Remaining" in `TASKS.md` (highest priority first), read it and its `Related` tasks. Check it against the current code first: symbols move.
2. Read `jev-api/CLAUDE.md`. Locate code by the symbol names under `Code locations` (no line numbers on purpose).
3. Change `src/hooks/register.ts` (or, for a task with area `jevfort/...`, the jevfort sources), add the test named under `Verification` to `tests/register.test.ts`, then `pnpm lint && pnpm --filter jev-api build && pnpm --filter jev-api test`. Never edit `plugin/**/*.mjs` by hand.
4. Any change under `jev-api/` merged to `main` needs a version bump in `package.json`. jevfort calls `batch`: do not change its name, input or answer shape.
5. Set `status` in the task, say what shipped (version, test), update its `TASKS.md` entry (checkbox, section, status tag: `.claude/rules/plugin-docs-tasks.md`) and note new numbers in a new dated evaluation instead of editing old ones.

## Conventions

- Every owned tool call is answered (a `deny` on failure, never `next(e)`); foreign tools go to `next(e)` untouched.
- Numbers come from one WSL2 machine, an in-process harness with a fake `$` (not the Claude Code engine) and a local HTTP stub; real System One numbers only where the evaluation says so. Re-measure before relying on a number.
