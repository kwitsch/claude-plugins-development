---
paths:
  - "assets/skills/repository-audit/**"
  - "src/skills/repository-audit/**"
---

# repository-audit

Mechanics are in `SKILL.md` and `assets/skills/repository-audit/detect-tools.reference.md` (script contract, output schemas, atomic write), not restated here.

## Boundaries

- Reuse `lsp-audit` and `memory-audit` verbatim through the `Skill` tool, sequentially; never re-implement their logic.
- The structure check is report-only. Its bar (root `CLAUDE.md`, `.claude/rules/`) is this skill's own policy, not drawn from `cc-reference`; a missing item becomes a manual to-do pointing at `cc-author`, never generated content.
- `Edit`/`Write` apply only the `memory-audit` manual to-dos (`suggested_fix: null`) the user selects (`--fix` selects all). The only other writes go through `detect-tools`: `--write` creates `<ROOT>/.claude/skills/init-dev-environment/` only when it is absent; `--add <ids>` rewrites only that directory's `SKILL.md` and `install.sh`, only when its tool list is readable, only adding confirmed detected tools (never removing one).
- Never run the generated `install.sh` from this skill.

## Catalog and template coupling

- Every `tool-map.json` id needs an `install_<id>` recipe in `templates/init-dev-environment/install.sh` (tested). A recipe that needs a prerequisite runtime also appears in the template's confirm-step prerequisite note.
- Every non-`npx` server in `lsp-audit`'s `lsp-map.json` needs a `tool-map.json` entry.
- A `tool-map.json` entry may carry `rootFiles`: root-relative paths (e.g. `.config/dprint.json`) checked at the project root only; `files` stays basename-anywhere.
- The template renders into a project-level skill outside the plugin: no `CLAUDE_PLUGIN_ROOT` and no dynamic-injection syntax in it (tested).
- `SKILL.md.tmpl` and `install.sh` are not build output and not run by this repository: they ship as listed `pluginBuild.assets` in `package.json` (exact paths). `install.sh` keeps git mode 100644 as in the original; the generated copy takes its mode from the script's own rules (`--write` 0755 directory, `--add` keeps the replaced file's mode).
