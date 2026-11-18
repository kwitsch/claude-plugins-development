# jev-api knowledge

Working documents for agent sessions. Not shipped (`plugin/` is the installable part), not user documentation. Language: English. Format rules: `.claude/rules/plugin-docs-tasks.md`.

## Pages

- [CLAUDE.md](../../../../jev-api/CLAUDE.md): the plugin's overview and rule list (loads with the plugin's files).
- [TASKS.md](TASKS.md): task list; `tasks/` holds one document per task. Start here for open work.
- [evaluations/EVALUATION-2026-11-13.md](evaluations/EVALUATION-2026-11-13.md): evaluation: jev-api evaluation 2026-11-13 (plugin 0.3.1)
- [evaluations/EVALUATION-2026-11-15.md](evaluations/EVALUATION-2026-11-15.md): evaluation: jev-api evaluation 2026-11-15 (plugin 0.5.0)
- [notes/haiku-calibration.md](notes/haiku-calibration.md): note: Haiku fallback: history and calibration

## How to work a task

See [how-to-work-a-task.md](../how-to-work-a-task.md).

## Task conventions

- Read `jev-api/.claude/rules/hooks-source.md` first: the code is in `src/hooks/register.ts` and its modules (for a task with area `jevfort/...`, the jevfort sources); the test goes into `tests/register.test.ts`.
- jevfort calls `request`: do not change its name, input or answer shape.

## Conventions

- Every owned tool call is answered (a `deny` on failure, never `next(e)`); foreign tools go to `next(e)` untouched.
- Numbers come from one WSL2 machine, an in-process harness with a fake `$` (not the Claude Code engine) and a local HTTP stub; real System One numbers only where the evaluation says so. Re-measure before relying on a number.
