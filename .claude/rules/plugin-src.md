---
paths:
  - "*/src/**"
  - "*/scripts/**"
  - "*/tests/**"
---

# Rule: src / scripts / tests

- TypeScript lives only in `src/**/*.mts`; `tsc` emits `plugin/<same path>.mjs`, `scripts/build.mjs` minifies it (`hooks/*.mjs` unmangled). No `declaration` output.
- Function-hooks modules (`src/hooks/*.mts`) import no engine types (`claude-code`): type the used `$`/`on` members structurally (template: `dprint/src/hooks/notice.mts`).
- Executable scripts start with `#!/usr/bin/env node`; build sets 0755.
- Import only `node:` builtins in `src/`.
- Tests: only `tests/*.test.mjs`, run by vitest (`test` from `vitest`, asserts via `node:assert/strict`), against built `plugin/` output. Function-hooks modules: `createKit` from the workspace package `claude-engine-vitest` (devDependency `workspace:*`; vitest stand-in for the official `claude-code/testing` kit, which only runs under `claude plugin test`; template: `inline-headroom/tests/register.test.mjs`). Command hooks: spawn the `.mjs` with JSON on stdin. No `*.test.ts`.
- Lint: `pnpm lint` (workspace-wide root `eslint.config.mjs`, no per-plugin config: type-checked + TSDoc on everything) must pass with 0 findings; never `eslint --fix` (inserts empty doc stubs), no `eslint-disable` without a stated reason.
- After changing `src/` or `plugin.json`: `pnpm lint && pnpm build && pnpm test`, commit regenerated `plugin/` with the source.
