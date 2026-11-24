---
paths:
  - "assets/skills/cc-reference/**"
---

# Reference files (`assets/skills/cc-reference/references/*.reference.md`)

Harness reference files, not prose documentation. Reasons: [reference-files.md](../../../development/wiki/plugins/cc-knowledge/design/reference-files.md).

- Directives, not prose: imperatives or tables; field references (frontmatter keys, schema fields, option enumerations) in tables.
- `verified YYYY-MM-DD` in each maintained file's header, kept accurate on edit (`skill-folder-structure.reference.md` is static: no date, not refreshed).
- Forward slashes in paths. No time-sensitive phrasing: a version gate (`version >= X.Y:` prefix on the row) instead of "new in X.Y".
- No per-file line ceiling (the 500 lines are the `SKILL.md` body guideline). `cc-reference` reads a file by section (`Grep -n` a `##` heading, then a short `Read`), so every topic gets its own self-contained `##` section.
- Navigation is the section index in `SKILL.md`, not an in-file TOC: adding, renaming or removing a `##` heading updates the matching index entry.
- Two or more bundled reference files live in the `references/` subfolder, not beside `SKILL.md` (`skill-folder-structure.reference.md`).
- File names end in `.reference.md` (layout check); the refresh tooling in `.claude/skills/update-cc-references/sources.json` lists them by name.
- The hand-written files here are edited in `assets/skills/cc-reference/` (the build copies them to `plugin/`; no `src/` counterpart).
