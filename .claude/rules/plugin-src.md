---
paths:
  - "*/src/**"
  - "*/scripts/**"
  - "*/tests/**"
  - "development/vitest/*/tests/**"
---

# Rule: src / scripts / tests

- TypeScript lives in `src/**/*.ts` (compiled; a plugin not yet converted still has `.mts`, see `.claude/rules/src-typescript.md`; a relative import reads `./x.js`) and `scripts/*.mts` (run as-is by Node's type stripping: erasable syntax only, no `enum`/`namespace`/parameter properties; imports name the `.mts` file); `development/scripts/build-plugin.ts` strips types file by file with oxc-transform (`isolatedModules`) into `plugin/<same path>.mjs` and minifies it with oxc-minify (`hooks/*.mjs` neither compressed, mangled nor stripped of whitespace, except `hooks/lib.mjs` under `pluginBuild.bundleHooksLib`: compressed and stripped of whitespace, not mangled). No type check in the build, no `declaration` output.
- Function-hooks modules (`src/hooks/*.ts`) import no engine types (`claude-code`): type the used `$`/`on` members structurally (model: `jev-api/src/hooks/register.ts`).
- Executable scripts start with `#!/usr/bin/env node`; build sets 0755.
- Plugin scripts used from several places (skills, hooks, MCP server) live in `src/bin/*.ts` -> `plugin/bin/*.mjs` (same build, no extra step). Claude Code puts `plugin/bin/` on the Bash tool's PATH while the plugin is enabled. Callers reference them as `${CLAUDE_PLUGIN_ROOT}/bin/<name>.mjs` (hooks.json, .mcp.json) or import them relatively (`../bin/<name>.mjs`).
- Tests: only `tests/*.test.ts` (`.test.mts` until a plugin is converted) (plugin `tests/` type-checked in relaxed mode, `development/vitest/*/tests/` fully strict; see `.claude/rules/lint-config.md`), run by vitest (`test` from `vitest`, asserts via `node:assert/strict`), against built `plugin/` output. Function-hooks modules: `createKit` from the workspace package `claude-engine-vitest` (devDependency `workspace:*`; vitest stand-in for the official `claude-code/testing` kit, which only runs under `claude plugin test`; model: `jev-api/tests/register.test.ts`). Command hooks: spawn the `.mjs` with JSON on stdin.
- Lint: `pnpm lint` at the repo root (oxlint with the workspace-wide root `.oxlintrc.json`, no per-plugin config: TypeScript type check, type-aware rules) must pass with 0 findings; no `oxlint-disable` without a stated reason.
- After changing `src/` or `package.json`: `pnpm lint && pnpm build && pnpm test`, commit regenerated `plugin/` with the source.
- Build scripts: compile into memory or a temp dir and replace `plugin/` output only after every file compiled (a failed or running build must not leave no output); a hand-written import merger handles `import d, { x } from s` (default plus named); a manifest `version` must be valid semver, not any non-empty string.
