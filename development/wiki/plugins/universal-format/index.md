# universal-format knowledge

What the wiki holds for universal-format: pages for agent sessions (not shipped, English). The plugin's constraints are in its `CLAUDE.md` and `.claude/rules/`.

## Pages

- [CLAUDE.md](../../../../universal-format/CLAUDE.md): the plugin's overview and rule list (loads with the plugin's files).
- [design/hook-design.md](design/hook-design.md): design: the one PreToolUse hook, its input template, the Edit swap, what was removed (do not "fix" without reading this)
- [design/scope-and-base.md](design/scope-and-base.md): design: `cwd` as a hint, the base directory, path exclusions, worktrees (do not "fix" without reading this)
- [design/dprint-gate.md](design/dprint-gate.md): design: deferring to dprint in a dprint-governed working directory
- [design/bundled-prettier.md](design/bundled-prettier.md): design: one bundled prettier, no resolver, lazy plugins, `.prettierignore` as the only ignore source (do not "fix" without reading this)
- [design/printwidth-guard.md](design/printwidth-guard.md): design: no line-length limit for JSON and YAML without a project config
- [design/caches.md](design/caches.md): design: config and ignore caches, refreshed when a written config file has landed
- [design/cli-formatters.md](design/cli-formatters.md): design: Kotlin, Python, Go and Rust through their CLI on stdin
- [design/vendor-build.md](design/vendor-build.md): design: the vendored prettier bundle, its wasm files and why it is built this way
- [notes/migration.md](notes/migration.md): the move from kwitsch/claude-plugins into this repository: what changed, test counts, the live check on 2.1.326

## Conventions

- Every failure in the hook path fails open (answers `{}`); never block or delay a Write/Edit beyond the format itself.
- Measurements come from one WSL2 machine; the older ones were taken on the bun-built single-file server of the former repository and are marked so. Re-measure before relying on a number.
