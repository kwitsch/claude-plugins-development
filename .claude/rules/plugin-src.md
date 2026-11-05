---
paths:
  - "*/src/**"
  - "*/scripts/**"
  - "*/tests/**"
---

# Rule: src / scripts / tests

- TypeScript lives in `src/**/*.mts` (compiled) and `scripts/*.mts` (run as-is by Node's type stripping: erasable syntax only, no `enum`/`namespace`/parameter properties; imports name the `.mts` file); `scripts/build.mts` strips types file by file with oxc-transform (`isolatedModules`) into `plugin/<same path>.mjs` and minifies it with oxc-minify (`hooks/*.mjs` neither compressed nor mangled). No type check in the build, no `declaration` output.
- Function-hooks modules (`src/hooks/*.mts`) import no engine types (`claude-code`): type the used `$`/`on` members structurally (template: `dprint/src/hooks/notice.mts`).
- Executable scripts start with `#!/usr/bin/env node`; build sets 0755.
- Import only `node:` builtins in `src/`.
- Tests: only `tests/*.test.mjs`, run by vitest (`test` from `vitest`, asserts via `node:assert/strict`), against built `plugin/` output. Function-hooks modules: `createKit` from the workspace package `claude-engine-vitest` (devDependency `workspace:*`; vitest stand-in for the official `claude-code/testing` kit, which only runs under `claude plugin test`; template: `inline-headroom/tests/register.test.mjs`). Command hooks: spawn the `.mjs` with JSON on stdin. No `*.test.ts`.
- Lint: `pnpm lint` (oxlint with the workspace-wide root `.oxlintrc.json`, no per-plugin config: TypeScript type check, type-aware rules) must pass with 0 findings; no `oxlint-disable` without a stated reason.
- After changing `src/` or `plugin.json`: `pnpm lint && pnpm build && pnpm test`, commit regenerated `plugin/` with the source.
