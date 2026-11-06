---
paths:
  - "tests/**"
---

# Tests

- `tests/*.test.mts`, one file per language/tool (ported from the bats suite of kwitsch/claude-plugins, one `.bats` file per language/tool): `core`, `checkstyle`, `go`, `markdown`, `npx-fallback`, `oxlint`, `php`, `rtk`, `rust`, `stylelint`, `truncation`, `tsc`, `yaml`, `skill`; plus `registry.test.mts` (unit tests of the exported helpers of the built `plugin/hooks/lint-file.mjs`, the former `registry.test.mjs`) and `manifest.test.mts` (wiring: no `userConfig`, hooks.json, exec bit, README). The bats scaffold/marketplace/root-README checks are replaced by the repo-wide guards (layout allowlist, manifest generation, CI freshness).
- `tests/support/lint-hook.mts` is the shared harness, not a test file (vitest only runs `*.test.mts`; the subfolder follows `development/vitest/claude-engine/tests/mods/`). It is hermetic: `PATH` holds only `bash` and `node` plus the linter stubs a test adds (`makeEnv().recStub(name, exit)` records `<name> <argv>`, prints `$OUT`, exits), `HOME` and `CLAUDE_PLUGIN_DATA` are per-test temp dirs, and the built `plugin/hooks/lint-file.mjs` is spawned per run with a PostToolUse payload on stdin. `RunOptions.toolName`/`toolResponse` shape Edit payloads (`structuredPatch` hunks drive the edit-range gate).
- Tests run against the built `plugin/`: run `pnpm --filter universal-lint build` after changing `src/` before `pnpm --filter universal-lint test`. A helper used by one file stays local to that file.
