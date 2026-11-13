# dprint docs (for Claude sessions)

Working documents for agent sessions. Not shipped (`plugin/` is the installable part), not user documentation. Language: English.

## Layout

- `TASKS.md`: index and checklist of all performance tasks (F01-F29). Start here.
- `EVALUATION-<date>.md`: a dated measurement run of the built server (method, numbers, comparison with the task documents, new findings). Latest: `EVALUATION-2026-11-13.md` (plugin 0.13.0, re-run on 0.13.2).
- `tasks/<id>-<slug>.md`: one detail document per task. Frontmatter: `id`, `title`, `status` (`done|partial|docs-only|open|closed`; closed = decided not to do, or a measurement record), `priority`, `area`. Sections: Status, Problem, Evidence, Code locations, Approach, Verification, Constraints, Related.

## How to work a task

1. Pick an unchecked task in `TASKS.md` (highest priority first) and read its detail document plus the documents under its `Related` section.
2. Read `../CLAUDE.md` (build rules). Locate code by the symbol names in `Code locations`; line numbers are deliberately absent because they drift.
3. Implement in `src/`, add the tests named under `Verification`, then `pnpm --filter dprint build && pnpm --filter dprint test && pnpm --filter dprint lint`. Never edit `plugin/**/*.mjs` or `plugin/.claude-plugin/plugin.json` by hand.
4. Any change under `dprint/` merged to `main` needs a version bump (`version` in `package.json`, the only manifest source).
5. Update the task: set `status` in its frontmatter, adjust `Status`/`Approach` to what shipped, and tick it in `TASKS.md` (move it to the done section).

## Conventions

- Every failure in the hook path fails open (returns `{}`); never block a Write/Edit.
- Measurements in the documents come from one WSL2 machine with dprint 0.64.3; re-measure before relying on a number.
