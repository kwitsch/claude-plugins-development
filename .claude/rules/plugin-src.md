---
paths:
  - "*/src/**"
  - "*/scripts/**"
  - "*/tests/**"
  - "development/vitest/*/tests/**"
---

# Rule: src / scripts / tests

- `scripts/*.mts` run as-is: erasable syntax only, no `enum`/`namespace`/parameter properties; imports name the `.mts` file. `development/scripts/build-plugin.ts` strips the types of `src/` file by file (`isolatedModules`) and minifies (`hooks/*.mjs` neither compressed, mangled nor stripped of whitespace, except `hooks/lib.mjs`: see `.claude/rules/hooks-lib-bundle.md`). No type check in the build, no `declaration` output.
- Hand-written modules are `.ts`, never a new `.mts`. The first change in a plugin that still holds `.mts` under `src/` or `tests/` converts that plugin in the same change (skill `convert-plugin-ts`; `src-typescript.md` loads with any `.mts` file).
- Import specifiers in `.ts` sources: relative siblings as `./name.js` (TypeScript NodeNext resolves it to `name.ts`; the build rewrites it to `./name.mjs`). Scripts that Node runs directly (`development/scripts/*.ts`) import their siblings with the real extension (`./plugin-manifest.ts`).
- Porting a shell script or CLI glue to Node, or reading Claude Code's own config files (`settings.json`, `.claude.json`): read [porting-shell-to-node.md](../../development/wiki/pitfalls/porting-shell-to-node.md) first (grep versus JS regex, what `command -v` and `$(...)` did for you, `CLAUDE_CONFIG_DIR`, output budgets).
- Function-hooks modules (`src/hooks/*.ts`) import no engine types (`claude-code`): type the used `$`/`on` members structurally (model: `jev-api/src/hooks/register.ts`).
- Executable scripts start with `#!/usr/bin/env node`; build sets 0755.
- `src/bin/*.ts` (see root `CLAUDE.md`) needs no extra build step. Callers reference them as `${CLAUDE_PLUGIN_ROOT}/bin/<name>.mjs` (hooks.json, .mcp.json) or import them relatively (`../bin/<name>.mjs`).
- Tests (`.test.mts` until a plugin is converted; `development/vitest/*/tests/` type-checked fully strict): `test` from `vitest`, asserts via `node:assert/strict`. Function-hooks modules: `createKit` from the workspace package `claude-engine-vitest` (devDependency `workspace:*`; vitest stand-in for the official `claude-code/testing` kit, which only runs under `claude plugin test`; model: `jev-api/tests/register.test.ts`). Command hooks: spawn the `.mjs` with JSON on stdin.
- Lint: `pnpm lint` must pass with 0 findings; no `oxlint-disable` without a stated reason.
- After changing `src/` or `package.json`: `pnpm lint && pnpm build && pnpm test`, commit regenerated `plugin/` with the source.
