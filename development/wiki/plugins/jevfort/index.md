# jevfort knowledge

Working documents for agent sessions. Not shipped (`plugin/` is the installable part), not user documentation. Language: English. Format rules: `.claude/rules/plugin-docs-tasks.md`.

## Pages

- [CLAUDE.md](../../../../jevfort/CLAUDE.md): the plugin's overview and rule list (loads with the plugin's files).
- [TASKS.md](TASKS.md): task list; `tasks/` holds one document per task. Start here for open work.
- [design/step-effort.md](design/step-effort.md): design: per-step effort (`stepEffort`): why only Opus/Sonnet, the fallback order, why only before a model call and why the delta runs from Jev's last answer, latency, rejected alternatives
- [evaluations/EVALUATION-2026-11-14-f01.md](evaluations/EVALUATION-2026-11-14-f01.md): evaluation: jevfort evaluation 2026-11-14, F01 (plugin 0.11.0, jev-api 0.3.2)
- [evaluations/EVALUATION-2026-11-14-f04.md](evaluations/EVALUATION-2026-11-14-f04.md): evaluation: jevfort evaluation 2026-11-14, F04 (plugin 0.11.0)
- [evaluations/EVALUATION-2026-11-14-option-removal.md](evaluations/EVALUATION-2026-11-14-option-removal.md): evaluation: jevfort evaluation 2026-11-14 (3), after the option removal (plugin 0.12.0, jev-api 0.3.2)
- [evaluations/EVALUATION-2026-11-14-worklist.md](evaluations/EVALUATION-2026-11-14-worklist.md): evaluation: jevfort evaluation 2026-11-14 (2), after the worklist (plugin 0.11.0, jev-api 0.3.2)
- [evaluations/EVALUATION-2026-11-14.md](evaluations/EVALUATION-2026-11-14.md): evaluation: jevfort evaluation 2026-11-14 (plugin 0.10.1, jev-api 0.3.2)
- [evaluations/EVALUATION-2026-11-15-live-notes.md](evaluations/EVALUATION-2026-11-15-live-notes.md): evaluation: Evaluation 2026-11-15: live notes moved out of CLAUDE.md

## How to work a task

See [how-to-work-a-task.md](../how-to-work-a-task.md).

## Task conventions

- Read `jevfort/.claude/rules/register-hooks.md`: every `$` use lives in `src/hooks/register.ts`, storage calls must run in-frame. Code is in `src/hooks/*.ts`; kit tests are in `tests/register.test.ts` and `tests/phase3.test.ts`, pure ones in `tests/policy.test.ts` and `tests/candidates.test.ts`.
- jev-api's `request` name, input and answer shape stay as they are.

## Conventions

- Every Jev failure falls back to Claude Code's own behaviour; no hook may fail because of Jev, the store or a cosmetic feature.
- Numbers come from one WSL2 machine, an in-process harness with a fake `$` (not the Claude Code engine) and the real System One endpoint through jev-api's built hook where the evaluation says so. Re-measure before relying on a number.
