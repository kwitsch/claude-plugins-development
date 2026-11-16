# dprint knowledge

Working documents for agent sessions. Not shipped (`plugin/` is the installable part), not user documentation. Language: English.

## Pages

- [CLAUDE.md](../../../../dprint/CLAUDE.md): the plugin's overview and rule list (loads with the plugin's files).
- [TASKS.md](TASKS.md): task list; `tasks/` holds one document per task. Start here for open work.
- [evaluations/EVALUATION-2026-11-13.md](evaluations/EVALUATION-2026-11-13.md): evaluation: dprint MCP server evaluation 2026-11-13 (plugin 0.13.0, re-run on 0.13.2)

## How to work a task

1. Pick an open task from "Remaining" in `TASKS.md` (highest priority first) and read its detail document plus the documents under its `Related` section.
2. Read `dprint/CLAUDE.md` (build rules). Locate code by the symbol names in `Code locations`; line numbers are deliberately absent because they drift.
3. Implement in `src/`, add the tests named under `Verification`, then `pnpm --filter dprint build && pnpm --filter dprint test && pnpm --filter dprint lint`. Never edit `plugin/**/*.mjs` or `plugin/.claude-plugin/plugin.json` by hand.
4. Any change under `dprint/` merged to `main` needs a version bump (`version` in `package.json`, the only manifest source).
5. Update the task: set `status` in its frontmatter, adjust `Status`/`Approach` to what shipped, and update its `TASKS.md` entry (checkbox, section, status tag: `.claude/rules/plugin-docs-tasks.md`).

## Conventions

- Every failure in the hook path fails open (returns `{}`); never block a Write/Edit.
- Measurements in the documents come from one WSL2 machine with dprint 0.64.3; re-measure before relying on a number.
