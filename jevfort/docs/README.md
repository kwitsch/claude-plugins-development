# jevfort docs (for Claude sessions)

Working documents for agent sessions. Not shipped (`plugin/` is the installable part), not user documentation. Language: English. Format rules: `.claude/rules/plugin-docs-tasks.md`.

## Layout

- `TASKS.md`: index and checklist of the performance findings (F01-F14). Start here.
- `EVALUATION-<date>.md`: a dated measurement run of the built `plugin/hooks/*.mjs` (method, machine, numbers, findings). Latest: `EVALUATION-2026-11-14-2.md` (plugin 0.11.0, jev-api 0.3.2, after the worklist); the first analysis: `EVALUATION-2026-11-14.md` (0.10.1).
- `tasks/<id>-<slug>.md`: one document per finding. Frontmatter `id`, `title`, `status` (`done|partial|docs-only|open|closed`), `priority`, `area`; sections Status, Problem, Evidence, Code locations, Approach, Verification, Constraints, Related.

## How to work a task

1. Pick an unchecked task in `TASKS.md` (highest priority first), read it and its `Related` tasks. Check it against the current code first: symbols move.
2. Read `../CLAUDE.md` and `../.claude/rules/register-hooks.md` (every `$` use lives in `src/hooks/register.mts`; storage calls must run in-frame). Locate code by the symbol names under `Code locations` (no line numbers on purpose).
3. Change `src/hooks/*.mts`, add the test named under `Verification` (kit tests in `tests/register.test.mts`, `tests/phase3.test.mts`, pure ones in `tests/policy.test.mts`/`tests/candidates.test.mts`), then `pnpm lint && pnpm --filter jevfort build && pnpm --filter jevfort test`. Never edit `plugin/**/*.mjs` by hand.
4. Any change under `jevfort/` merged to `main` needs a version bump in `package.json`. jev-api's `batch` name, input and answer shape stay as they are.
5. Set `status` in the task, say what shipped (version, test), tick it in `TASKS.md` and note new numbers in a new dated evaluation instead of editing old ones.

## Conventions

- Every Jev failure falls back to Claude Code's own behaviour; no hook may fail because of Jev, the store or a cosmetic feature.
- Numbers come from one WSL2 machine, an in-process harness with a fake `$` (not the Claude Code engine) and the real System One endpoint through jev-api's built hook where the evaluation says so. Re-measure before relying on a number.
