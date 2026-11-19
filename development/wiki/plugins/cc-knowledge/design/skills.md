# Skill boundaries (do not "fix" without reading this)

Why the skills are split and bounded as they are (constraints: rules `skills-and-agents.md`, `lsp-audit.md`, `repository-audit.md`).

- The set is closed on purpose: lookup (`cc-reference`), review (`cc-review`), author (`cc-author`), memory (`memory-audit`), compression (`cc-compress`), LSP coverage (`lsp-audit`), the full pass (`repository-audit`). `cc-author`, `memory-audit` and `cc-author-planner` extend lookup-review into lookup-author-review from the same references, so no knowledge is duplicated and a refresh of the references improves all of them.
- `memory-audit`, `lsp-audit` and `repository-audit` have no `cc-` prefix: an intentional break of the naming symmetry, not an oversight.
- The orchestrators run inline because they dispatch agents and write files, which a forked context cannot do; detection runs as Bash at run time because load-time injection would run before the user's consent.
- `lsp-audit` writes only to the project-scope `lsp` plugin (`.claude/skills/lsp/`) because Claude Code no longer loads a project-root `.lsp.json`; it migrates a legacy root file and deletes it as the very last action, after a verified readback. The catalog `lsp-map.json` is operational data (like universal-lint's linter map), not documentation.
- `repository-audit` reuses `lsp-audit` and `memory-audit` through the `Skill` tool instead of copying their logic; its structure bar is its own policy. Every catalog id of `tool-map.json` needs an `install_<id>` recipe in the template `install.sh`, so detection never offers a tool the installer cannot install; the template carries no plugin-root token because it renders into a project-level skill outside the plugin.
- rtk (a shell-command proxy) has no role: the fetch-variant components fall back to `WebFetch`, and the shell-variant skills have no rtk-optimizable command (`memory-audit`'s `find` with compound predicates is refused by `rtk find`).
- `cc-compress` is an adaptation of `caveman-compress` (JuliusBrussee/caveman); validation and retry happen in memory so a crash never leaves a half-compressed source.
