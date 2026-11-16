# jevfort knowledge (for Claude sessions)

Working documents for agent sessions. Not shipped (`plugin/` is the installable part), not user documentation. Language: English. Format rules: `.claude/rules/plugin-docs-tasks.md`.

## Pages

- [CLAUDE.md](../../../../jevfort/CLAUDE.md): the plugin's overview and rule list (loads with the plugin's files).
- [TASKS.md](TASKS.md): task list; `tasks/` holds one document per task. Start here for open work.
- [EVALUATION-2026-11-14-2.md](EVALUATION-2026-11-14-2.md): jevfort evaluation 2026-11-14 (2), after the worklist (plugin 0.11.0, jev-api 0.3.2)
- [EVALUATION-2026-11-14-3.md](EVALUATION-2026-11-14-3.md): jevfort evaluation 2026-11-14 (3), after the option removal (plugin 0.12.0, jev-api 0.3.2)
- [EVALUATION-2026-11-14-F01.md](EVALUATION-2026-11-14-F01.md): jevfort evaluation 2026-11-14, F01 (plugin 0.11.0, jev-api 0.3.2)
- [EVALUATION-2026-11-14-F04.md](EVALUATION-2026-11-14-F04.md): jevfort evaluation 2026-11-14, F04 (plugin 0.11.0)
- [EVALUATION-2026-11-14.md](EVALUATION-2026-11-14.md): jevfort evaluation 2026-11-14 (plugin 0.10.1, jev-api 0.3.2)
- [EVALUATION-2026-11-15-live-notes.md](EVALUATION-2026-11-15-live-notes.md): Evaluation 2026-11-15: live notes moved out of CLAUDE.md

## How to work a task

1. Pick an open task from "Remaining" in `TASKS.md` (highest priority first), read it and its `Related` tasks. Check it against the current code first: symbols move.
2. Read `jevfort/CLAUDE.md` and `jevfort/.claude/rules/register-hooks.md` (every `$` use lives in `src/hooks/register.ts`; storage calls must run in-frame). Locate code by the symbol names under `Code locations` (no line numbers on purpose).
3. Change `src/hooks/*.ts`, add the test named under `Verification` (kit tests in `tests/register.test.ts`, `tests/phase3.test.ts`, pure ones in `tests/policy.test.ts`/`tests/candidates.test.ts`), then `pnpm lint && pnpm --filter jevfort build && pnpm --filter jevfort test`. Never edit `plugin/**/*.mjs` by hand.
4. Any change under `jevfort/` merged to `main` needs a version bump in `package.json`. jev-api's `batch` name, input and answer shape stay as they are.
5. Set `status` in the task, say what shipped (version, test), update its `TASKS.md` entry (checkbox, section, status tag: `.claude/rules/plugin-docs-tasks.md`) and note new numbers in a new dated evaluation instead of editing old ones.

## Conventions

- Every Jev failure falls back to Claude Code's own behaviour; no hook may fail because of Jev, the store or a cosmetic feature.
- Numbers come from one WSL2 machine, an in-process harness with a fake `$` (not the Claude Code engine) and the real System One endpoint through jev-api's built hook where the evaluation says so. Re-measure before relying on a number.
