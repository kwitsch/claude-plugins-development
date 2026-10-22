---
paths:
  - "*/src/**"
  - "*/scripts/**"
  - "*/tests/**"
---

# Rule: src / scripts / tests

- `src/` holds `*.mts` files; `tsc` emits `plugin/<same path>.mjs`. Keep the directory structure identical to the target location in `plugin/` (e.g. `src/hooks/session-start.mts` → `plugin/hooks/session-start.mjs`).
- Executable scripts start with `#!/usr/bin/env node`; `scripts/build.mjs` sets mode 0755 on emitted files with a shebang.
- Import only `node:` builtins in `src/` — the built plugin ships without `node_modules`.
- `tests/*.test.mjs` use `node:test` and exercise the built `plugin/` output (run `pnpm build` first). Hook tests spawn the `.mjs` with a JSON payload on stdin and assert on stdout / exit code.
- After changing `src/` or `plugin.json`: `pnpm build && pnpm test`, then commit the regenerated `plugin/` files together with the source.
