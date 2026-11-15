# development/

Shared developer tooling, no plugin. Not versioned or released.

- `scripts/`: the build scripts every plugin uses, and `wiki-check.ts` (consistency check of the wiki, part of `pnpm lint` and of the PR workflow).
  - A build script compiles into memory or a temp dir and replaces `plugin/` output only after every file compiled (a failed or running build must leave the previous output intact); a hand-written import merger handles `import d, { x } from s` (default plus named); a manifest `version` must be valid semver, not any non-empty string.
  - The hooks bundler (`bundleHooksLib`, rule `.claude/rules/hooks-lib-bundle.md`) works on static imports only and must be checked against these import shapes (each once shipped a build that succeeded and a bundle that could not load): `./name.mjs?query` or `#hash`, `./a/../name.mjs`, `../hooks/name.mjs`, re-exports (`export { x } from "./name.mjs"`), dynamic `import("./name.mjs")`, an entry in a subfolder of `hooks/`, a bare builtin (`"util"`) whose name equals a helper, file names with a dot or non-ASCII letter. Fail the build on any such shape instead of dropping the file.
- `wiki/`: the repository's knowledge base for agent sessions (index, log, topic pages); its own `CLAUDE.md` says what goes there and how.
- `vitest/claude-engine/`: the workspace package `claude-engine-vitest` (no `plugin/`), the shared vitest stand-in for Claude Code's mod test kit (`claude-code/testing`), a `workspace:*` devDependency of plugins with function-hooks modules.
