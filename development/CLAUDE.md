# development/

Shared developer tooling, no plugin. Not versioned or released.

- `scripts/`: `plugin-manifest.ts` (package.json to plugin.json) and `check-plugin-layout.ts` (what `plugin/` may hold), both used by the tsdown build and CI; `plugin-test.ts` (runs a mod's `claude-tests/` under `claude plugin test`); `wiki-check.ts` (consistency check of the wiki, part of `pnpm lint` and of the PR workflow). The workspace package `build-scripts` tests them (`scripts/tests/`).
- `tsdown/`: the standard plugin build, workspace package `plugin-build`: `index.ts` exports `pluginConfig` for a plugin's `tsdown.config.ts` (rule `.claude/rules/tsdown-build.md`, tests in `tsdown/tests/`). Every change there rebuilds each tsdown-built plugin; one whose `plugin/` changes needs a version bump.
- `shared/src/`: code several plugins use, imported as `@shared/<name>.js`, inlined by the build ([tsdown-build.md](../.claude/rules/tsdown-build.md)), nothing ships as `plugin/shared/`. The workspace package `shared-code` (`development/shared`) tests it against `src/`. Every change there rebuilds each consumer's `plugin/`, so each needs a version bump. Reasons and plan: [shared-source-layer](wiki/decisions/shared-source-layer.md).
- `wiki/`: the repository's knowledge base for agent sessions (index, log, topic pages); its own `CLAUDE.md` says what goes there and how.
- `vitest/claude-engine/`: the workspace package `claude-engine-vitest` (no `plugin/`), the shared vitest stand-in for Claude Code's mod test kit (`claude-code/testing`), a `workspace:*` devDependency of plugins with function-hooks modules; it loads a mod by file URL (unit tests: `src/hooks/register.ts`). It also holds `claude-code-testing.d.ts`, the types of the official kit for `claude-tests/`.
