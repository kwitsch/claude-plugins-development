---
paths:
  - "*/src/**"
  - "*/scripts/**"
  - "*/tests/**"
  - "development/vitest/*/tests/**"
---

# Rule: src / scripts / tests

- TypeScript lives in `src/**/*.mts` (compiled) and `scripts/*.mts` (run as-is by Node's type stripping: erasable syntax only, no `enum`/`namespace`/parameter properties; imports name the `.mts` file); `development/scripts/build-plugin.mts` strips types file by file with oxc-transform (`isolatedModules`) into `plugin/<same path>.mjs` and minifies it with oxc-minify (`hooks/*.mjs` neither compressed, mangled nor stripped of whitespace). No type check in the build, no `declaration` output.
- Function-hooks modules (`src/hooks/*.mts`) import no engine types (`claude-code`): type the used `$`/`on` members structurally (template: `dprint/src/hooks/notice.mts`).
- Executable scripts start with `#!/usr/bin/env node`; build sets 0755.
- Plugin scripts used from several places (skills, hooks, MCP server) live in `src/bin/*.mts` -> `plugin/bin/*.mjs` (same build, no extra step). Claude Code puts `plugin/bin/` on the Bash tool's PATH while the plugin is enabled: executables there start with `#!/usr/bin/env node` (build sets 0755). Callers reference them as `${CLAUDE_PLUGIN_ROOT}/bin/<name>.mjs` (hooks.json, .mcp.json) or import them relatively (`../bin/<name>.mjs`). Function-hooks modules (`src/hooks/*.mts`) still import nothing: they inline what they need.
- Import only `node:` builtins in `src/`.
- `.mjs` is build output only: every hand-written module (sources, scripts, tests, test fixtures, configs) is `.mts`.
- Tests: only `tests/*.test.mts` (plugin `tests/` type-checked in relaxed mode, `development/vitest/*/tests/` fully strict; see root `CLAUDE.md`), run by vitest (`test` from `vitest`, asserts via `node:assert/strict`), against built `plugin/` output. Function-hooks modules: `createKit` from the workspace package `claude-engine-vitest` (devDependency `workspace:*`; vitest stand-in for the official `claude-code/testing` kit, which only runs under `claude plugin test`; template: `inline-headroom/tests/register.test.mts`). Command hooks: spawn the `.mjs` with JSON on stdin.
- Lint: `pnpm lint` at the repo root (oxlint with the workspace-wide root `.oxlintrc.json`, no per-plugin config: TypeScript type check, type-aware rules) must pass with 0 findings; no `oxlint-disable` without a stated reason.
- After changing `src/` or `plugin.json`: `pnpm lint && pnpm build && pnpm test`, commit regenerated `plugin/` with the source.
