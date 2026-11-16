---
paths:
  - "development/wiki/plugins/**"
---

# Rule: `development/wiki/plugins/<plugin>/` (task lists and evaluations for agent sessions)

Pattern from `development/wiki/plugins/dprint/` (analysis findings worked off as tasks). Not shipped, not user documentation, English.

- Every plugin has a section `development/wiki/plugins/<plugin>/` with its own `index.md` (title, one sentence, a `## Pages` list that links every page of the section except `tasks/*`: `TASKS.md`, evaluations, design pages) and an entry `[<plugin>](<plugin>/index.md)` in `plugins/index.md`. A new plugin gets both when it is scaffolded. `wiki-check.ts` enforces it.
- `TASKS.md` (same shape in every plugin): `# <plugin> tasks`, a short header (source of the findings, links to evaluations), then exactly the sections `## Remaining` (status `open`, `partial`, `docs-only`, `measurement-only`; checkbox `[ ]`), `## Done` (`done`) and `## Closed without code` (`closed`), both with `[x]`; an empty section says `None.`. Entries sorted by id, one line `- [ ] [F23](tasks/F23-slug.md) <status> <priority>: <title>` with the status in backticks (status and priority repeat the frontmatter, the title is its `title`). Optional `## Notes` and `## Dependencies` last. The entry moves section, checkbox and tag whenever the task's `status` changes. `wiki-check.ts` compares `TASKS.md` with the `tasks/` frontmatter.
- `tasks/<id>-<slug>.md` holds one task. Frontmatter: `id`, `title`, `status` (`done|partial|docs-only|open|closed|measurement-only`), `priority` (`high|medium|low|none`), `area`. Sections: Status, Problem, Evidence, Code locations, Approach, Verification, Constraints, Related. No `# Heading` in the body: the frontmatter `title` already counts as the H1 (markdownlint MD025 on every file otherwise).
- Check every open task against the **current** code before working it: docs drift (moved files, renamed symbols, a manifest file that no longer exists, rules that moved). Obsolete or "do not do" tasks get `status: closed` with the reason, not silent deletion. Keep the old paragraph under "Earlier state:" when a task is finished.
- Update status, the section of `TASKS.md` and the evaluation together in the commit that ships the work; every finished task carries the test that proves it and the version that shipped it.
- Evaluations are dated documents (`EVALUATION-<date>.md`): method, one-machine numbers (median/p90, 5+ repetitions where cheap, built output, real tool versions), comparison with the earlier figures, remaining findings, a "Bug hunt" and a "Live validation" section stating exactly what was and was not run. Re-run after large changes; do not edit old numbers.
- A decision that needs the user is made by a read-only decision agent (opus, high) when the user is unavailable, and the reasoning goes into the task document.
