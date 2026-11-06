---
paths:
  - "tests/**"
---

# Tests

- `tests/*.test.mts`, one file per language/tool (ported from the bats suite of kwitsch/claude-plugins, one `.bats` file per language/tool): `core`, `checkstyle`, `go`, `markdown`, `npx-fallback`, `php`, `rtk`, `rust`, `stylelint`, `truncation`, `tsc`, `yaml`, `debounce`, `skill`; plus `registry.test.mts` (unit tests of the exported helpers of the built `plugin/hooks/lint-file.mjs`, the former `registry.test.mjs`) and `manifest.test.mts` (wiring: no `userConfig`, hooks.json, exec bit, README). The bats scaffold/marketplace/root-README checks are replaced by the repo-wide guards (layout allowlist, manifest generation, CI freshness).
- `tests/support/lint-hook.mts` is the shared harness, not a test file (vitest only runs `*.test.mts`; the subfolder follows `development/vitest/claude-engine/tests/mods/`). It is hermetic: `PATH` holds only `bash` and `node` plus the linter stubs a test adds (`makeEnv().recStub(name, exit)` records `<name> <argv>`, prints `$OUT`, exits), `HOME` and `CLAUDE_PLUGIN_DATA` are per-test temp dirs, and the built `plugin/hooks/lint-file.mjs` is spawned per run with a PostToolUse payload on stdin. The harness runs the hook with `UNIVERSAL_LINT_DEBOUNCE_MS=0` unless a test sets it.
- Tests run against the built `plugin/`: run `pnpm --filter universal-lint build` after changing `src/` before `pnpm --filter universal-lint test`. A helper used by one file stays local to that file.
- The debounce tests use windows of 0 to 400 ms (the real default of 5000 ms is only observed for ~300 ms, then the child is killed).
