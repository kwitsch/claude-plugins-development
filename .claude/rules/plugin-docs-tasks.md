---
paths:
  - "*/docs/**"
---

# Rule: `<plugin>/docs/` (task lists and evaluations for agent sessions)

Pattern from `dprint/docs/` (analysis findings worked off as tasks). Not shipped, not user documentation, English.

- `TASKS.md` is the index with checkboxes (Done / Remaining / Closed without code); `tasks/<id>-<slug>.md` holds one task. Frontmatter: `id`, `title`, `status` (`done|partial|docs-only|open|closed`), `priority`, `area`. Sections: Status, Problem, Evidence, Code locations, Approach, Verification, Constraints, Related. No `# Heading` in the body: the frontmatter `title` already counts as the H1 (markdownlint MD025 on every file otherwise).
- Check every open task against the **current** code before working it: docs drift (moved files, renamed symbols, a manifest file that no longer exists, rules that moved). Obsolete or "do not do" tasks get `status: closed` with the reason, not silent deletion. Keep the old paragraph under "Earlier state:" when a task is finished.
- Update status, the section of `TASKS.md` and the evaluation together in the commit that ships the work; every finished task carries the test that proves it and the version that shipped it.
- Evaluations are dated documents (`EVALUATION-<date>.md`): method, one-machine numbers (median/p90, 5+ repetitions where cheap, built output, real tool versions), comparison with the earlier figures, remaining findings, a "Bug hunt" and a "Live validation" section stating exactly what was and was not run. Re-run after large changes; do not edit old numbers.
- A decision that needs the user is made by a read-only decision agent (opus, high) when the user is unavailable, and the reasoning goes into the task document.
