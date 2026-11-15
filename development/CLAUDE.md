# development/

Shared developer tooling, no plugin. Not versioned or released.

- `scripts/`: the build scripts every plugin uses, and `wiki-check.ts` (consistency check of the wiki, part of `pnpm lint` and of the PR workflow).
- `wiki/`: the repository's knowledge base for agent sessions (index, log, topic pages); its own `CLAUDE.md` says what goes there and how.
- `vitest/claude-engine/`: the workspace package `claude-engine-vitest` (no `plugin/`), the shared vitest stand-in for Claude Code's mod test kit (`claude-code/testing`), a `workspace:*` devDependency of plugins with function-hooks modules.
