---
paths:
  - "*/src/**"
  - "*/scripts/**"
  - "*/tests/**"
  - "development/vitest/*/tests/**"
---

# Rule: src / scripts / tests

- `scripts/*.mts` run as-is: erasable syntax only, no `enum`/`namespace`/parameter properties; imports name the `.mts` file. `development/scripts/build-plugin.ts` strips the types of `src/` file by file (`isolatedModules`) and minifies (`hooks/*.mjs` neither compressed, mangled nor stripped of whitespace, except `hooks/lib.mjs`: see `.claude/rules/hooks-lib-bundle.md`). No type check in the build, no `declaration` output.
- Function-hooks modules (`src/hooks/*.ts`) import no engine types (`claude-code`): type the used `$`/`on` members structurally (model: `jev-api/src/hooks/register.ts`).
- Executable scripts start with `#!/usr/bin/env node`; build sets 0755.
- `src/bin/*.ts` (see root `CLAUDE.md`) needs no extra build step. Callers reference them as `${CLAUDE_PLUGIN_ROOT}/bin/<name>.mjs` (hooks.json, .mcp.json) or import them relatively (`../bin/<name>.mjs`).
- Tests (`.test.mts` until a plugin is converted; `development/vitest/*/tests/` type-checked fully strict): `test` from `vitest`, asserts via `node:assert/strict`. Function-hooks modules: `createKit` from the workspace package `claude-engine-vitest` (devDependency `workspace:*`; vitest stand-in for the official `claude-code/testing` kit, which only runs under `claude plugin test`; model: `jev-api/tests/register.test.ts`). Command hooks: spawn the `.mjs` with JSON on stdin.
- Lint: `pnpm lint` must pass with 0 findings; no `oxlint-disable` without a stated reason.
- After changing `src/` or `package.json`: `pnpm lint && pnpm build && pnpm test`, commit regenerated `plugin/` with the source.
- Build scripts: compile into memory or a temp dir and replace `plugin/` output only after every file compiled (a failed or running build must not leave no output); a hand-written import merger handles `import d, { x } from s` (default plus named); a manifest `version` must be valid semver, not any non-empty string.
