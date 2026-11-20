---
paths:
  - "*/tests/**"
---

# Rule: how plugin tests are built

Learned while moving jevfort's tests to the standard of jev-api (2026-11-15). Complements `hook-caches-and-tests.md` (what a regression test must prove).

- **Test only through the entry.** A test imports the built hooks entry through the kit (`claude-engine-vitest`), `plugin/hooks/register.js` on the tsdown build and `plugin/hooks/register.mjs` on the old build, never `src/`: the bundle exports only what the entry takes, and a test on `src/` does not test what ships. Pure helpers are tested through what they cause in a hook (the question sent to Jev, the band, `session.compact`, a tool result). The only exceptions, old build only, are built modules outside `hooks/` (`plugin/shared/*.mjs`) and names that `plugin/hooks/lib.mjs` exports because the entry takes them.
- **Shared fake environment in `tests/support/*.ts`.** A plugin with several test files binds the kit once there (`makeKit(options)`) and exports the fakes and helpers; a test file does not copy them. Support modules import no `src/` either.
- **One `setup()` per test.** `on()` after the test's first `$` call throws, and a second `setup()` stacks hooks. Several cases in one test run through state the fake reads at call time (a getter, a shared array that the test mutates), set before the first `$` call.
- **Tables and loops of tests for like cases.** Many paths, prompts or scores belong in a table of rows, one test per row (`for (const c of rows) test(...)`), not in one test that calls `setup()` in a loop.
- **No placeholder tests.** A test with no real assertion (`expect(true)`) does not stay. An assertion that has no equivalent through a hook gets a comment at the nearest test saying what was lost and why.
- **Count after a rewrite.** Compare the number of tests (and assertions) before and after moving tests to a new style; a drop means cases were lost. Say in the commit message what changed on purpose. When the rewrite collapses a dimension (several tools or types into one), also delete each guard of the collapsed code in the built `plugin/` (`git show main:<plugin>/plugin/hooks/lib.mjs` shows which mutants the old suite killed) and run the tests: a guard whose test needed the second item has none left (jev-api 0.7.0, [log](../../development/wiki/log.md)).
- **A failure that appears only in the parallel run** is checked alone first (the plugin's own `pnpm test`, repeated) and then in a second full run, before the test or the code is changed. Say in the report that it was a flake.
- **Typed fixtures.** Fixtures take the engine's structural types (`SessionMessage`, `tool_use_id`), not loose objects; a new type check (a `.mts` to `.ts` conversion) shows missing fields and an unavailable `lib` method (ES2022 has no `isWellFormed`) as lint errors, fix them in the fixture, not with a cast.
