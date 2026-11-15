# development/

Shared developer tooling, no plugin. Not versioned or released.

- `scripts/`: the build scripts every plugin uses.
- `vitest/claude-engine/`: the workspace package `claude-engine-vitest` (no `plugin/`), the shared vitest stand-in for Claude Code's mod test kit (`claude-code/testing`), a `workspace:*` devDependency of plugins with function-hooks modules.
