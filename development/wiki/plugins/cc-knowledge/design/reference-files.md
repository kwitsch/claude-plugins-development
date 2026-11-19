# The bundled reference files

Why the reference files look the way they do, and what the `*.reference.md` naming is.

## Style (rule `references.md`)

- Harness reference files, not prose: imperatives and tables are cheaper to retrieve and to check against the docs than explanatory paragraphs.
- `cc-reference` reads a file by section: `Grep -n` a `##` heading, then a short `Read`. So there is no per-file line ceiling (the 500 lines are the `SKILL.md` body guideline), every topic has its own self-contained `##` section, and navigation is the section index in `SKILL.md`, not an in-file table of contents.
- No time-sensitive phrasing ("new in X.Y"): a version gate on the row stays true.
- The `verified YYYY-MM-DD` stamp is per file (the refresh stamps it). The `(CC docs read: YYYY-MM-DD)` suffix of the plugin description was dropped in the migration: a description is one short sentence ([plugin-description.md](../../../../../.claude/rules/plugin-description.md)), and the per-file stamps carry the information.
- Two or more bundled reference files live in a `references/` subfolder (`skill-folder-structure.reference.md` documents the convention; static, no verified date, not refreshed).

## Why `*.reference.md`

The layout check ([plugin-build-output.md](../../../../../.claude/rules/plugin-build-output.md), `check-plugin-layout.ts`) allows `skills/**/SKILL.md`, `skills/**/*.reference.md` and data `*.json` in `plugin/`, and the repository rule is never to edit the allowlist to fit a plugin. The files were renamed instead: `claude-code-hooks-reference.md` became `claude-code-hooks.reference.md`, `hook-handler-selection.md` and `skill-folder-structure.md` gained `.reference`, `memory-audit/analysis-workflow.md` became `analysis-workflow.reference.md`. The section-index keys in `cc-reference/SKILL.md` (`hooks-reference`, `skills-reference`, ...) are routing names, not file names, and stayed.

## Rejected

- Allowing `*.md` under `skills/**/references/` in the checker: it would let any stray markdown into a shipped plugin.
- Moving the references to `src/` as sources: they are hand-written content, no build step produces them.
