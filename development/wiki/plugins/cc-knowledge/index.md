# cc-knowledge knowledge

What the wiki holds for cc-knowledge: pages for agent sessions (not shipped, English). The plugin's constraints are in its `CLAUDE.md` and `.claude/rules/`.

## Pages

- [CLAUDE.md](../../../../cc-knowledge/CLAUDE.md): the plugin's overview and rule list (loads with the plugin's files).
- [design/reroute-hook.md](design/reroute-hook.md): design: the `claude-code-guide` reroute, fail-open, one source file, the kit's any-of matcher (do not "fix" without reading this)
- [design/reference-files.md](design/reference-files.md): design: style of the reference files and why they are named `*.reference.md`
- [design/skills.md](design/skills.md): design: skill boundaries, catalog coupling, why the set is closed (do not "fix" without reading this)
- [design/maintenance-tooling.md](design/maintenance-tooling.md): design: `update-cc-references`, its validator and dispatcher, and what changed when they moved here
- [notes/migration.md](notes/migration.md): the move from kwitsch/claude-plugins into this repository: decisions, test counts, the dropped cases, the live check on 2.1.328
