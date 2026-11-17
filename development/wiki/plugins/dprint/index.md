# dprint knowledge

Working documents for agent sessions. Not shipped (`plugin/` is the installable part), not user documentation. Language: English.

## Pages

- [CLAUDE.md](../../../../dprint/CLAUDE.md): the plugin's overview and rule list (loads with the plugin's files).
- [TASKS.md](TASKS.md): task list; `tasks/` holds one document per task. Start here for open work.
- [evaluations/EVALUATION-2026-11-13.md](evaluations/EVALUATION-2026-11-13.md): evaluation: dprint MCP server evaluation 2026-11-13 (plugin 0.13.0, re-run on 0.13.2)

- [notes/hook-only-tools-audit.md](notes/hook-only-tools-audit.md): audit of the MCP server tools (all nine hook-only and hidden from the model), live check on 2.1.326

## How to work a task

See [how-to-work-a-task.md](../how-to-work-a-task.md).

## Conventions

- Every failure in the hook path fails open (returns `{}`); never block a Write/Edit.
- Measurements in the documents come from one WSL2 machine with dprint 0.64.3; re-measure before relying on a number.
