# taskflow knowledge

What the wiki holds for taskflow: pages for agent sessions (not shipped, English). The plugin's constraints are in its `CLAUDE.md` and `.claude/rules/`.

## Pages

- [CLAUDE.md](../../../../taskflow/CLAUDE.md): the plugin's overview and rule list (loads with the plugin's files).
- [design/workflows.md](design/workflows.md): design: why the workflow scripts, agents and result files are built the way they are (run by name, unpinned models, no narration, English artifacts, lean review, scribe checks, scribe write path (Write, printf retry), graphmind path, shipped as `pluginBuild.assets`)
- [design/dispatch-task.md](design/dispatch-task.md): design: why `dispatch-task` is a fork, forces `--permission-mode auto`, uses a fixed heredoc delimiter and passes `--skip-branch-check` (do not "fix" without reading this)
- [notes/migration.md](notes/migration.md): the move from kwitsch/claude-plugins into this repository: base commit, version 2.2.1, the Node port of the merge script, the layout outcome, test counts and the dropped cases
