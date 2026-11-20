---
paths:
  - "*/tests/**"
  - "*/claude-tests/**"
---

# Rule: how plugin tests are built

Learned while moving jevfort's tests to the standard of jev-api (2026-11-15). Complements `hook-caches-and-tests.md` (what a regression test must prove).

- **Two layers.** Unit tests import `src/**/*.ts` (the kit loads `src/hooks/register.ts`); a name from an inlined module is imported from its own src file, never re-exported for tests. Process-level tests (MCP servers, command hooks) spawn the built `plugin/**/*.mjs`. A mod also has `claude-tests/*.test.ts` on `claude-code/testing`, run by `development/scripts/plugin-test.ts` (`pnpm --filter <name> test:plugin`) on a temp copy of `plugin/`, covering what only the built output shows (loading, every registered event, static check). [test-layers](../../development/wiki/decisions/test-layers.md)
- **Shared fake environment in `tests/support/*.ts`.** A plugin with several test files binds the kit once there (`makeKit(options)`) and exports the fakes and helpers; a test file does not copy them.
- **One `setup()` per test.** `on()` after the test's first `$` call throws, and a second `setup()` stacks hooks. Several cases in one test run through state the fake reads at call time (a getter, a shared array that the test mutates), set before the first `$` call.
- **Tables and loops of tests for like cases.** Many paths, prompts or scores belong in a table of rows, one test per row (`for (const c of rows) test(...)`), not in one test that calls `setup()` in a loop.
- **No placeholder tests.** A test with no real assertion (`expect(true)`) does not stay. An assertion that has no equivalent through a hook gets a comment at the nearest test saying what was lost and why.
- **Count after a rewrite.** Compare the number of tests (and assertions) before and after moving tests to a new style; a drop means cases were lost. Say in the commit message what changed on purpose. When the rewrite collapses a dimension (several tools or types into one), also delete each guard of the collapsed code in `src/` and run the unit tests: a guard whose test needed the second item has none left (jev-api 0.7.0, [log](../../development/wiki/log.md)).
- **A failure that appears only in the parallel run** is checked alone first (the plugin's own `pnpm test`, repeated) and then in a second full run, before the test or the code is changed. Say in the report that it was a flake.
- **Typed fixtures.** Fixtures take the engine's structural types (`SessionMessage`, `tool_use_id`), not loose objects; the type check shows missing fields and an unavailable `lib` method (ES2022 has no `isWellFormed`) as lint errors, fix them in the fixture, not with a cast.
