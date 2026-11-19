# Test kit versus the real engine

Where the workspace test kit `claude-engine-vitest` and the official kit behave differently from a real Claude Code session, so a green test is read correctly.

What the kit offers and how it deviates from the official kit: [README.md](../../vitest/claude-engine/README.md) of the package. How plugin tests are built: [hook-tests.md](../../../.claude/rules/hook-tests.md).

## Dispatch

- In the kit a mod's `$.<ns>.<method>` call runs only the hooks of plugins loaded at or above the caller, then the test stubs. A cross-plugin `$.tool.call` therefore cannot reach another plugin loaded inline beneath it: stub the other plugin's tool. The real engine runs `$.tool.call` through every hook but the calling one, whatever the load order (kit source, typings 2.1.322).
- In the kit a mod's `$.tool.call` resolves to the stub's `value` and rejects with its `deny`; the real engine resolves `{ deny }`. A fake for another plugin's tool answers `{ value: { result } }`, or `{ value: { deny } }` to model production, and passes other tools on with `next(e)`. A stub that returns a bare `{ result }` to a mod call fails the test (kit source, binary 2.1.322).
- The kit has no core `tool.register`: stub it. An answer of `{ value: undefined }` crashes code that reads `r.value.tool` (`claude plugin test` 2.1.322).
- Kit matchers compare with `===` and nested objects field by field; an array leaf is any-of (added with the cc-knowledge migration, 2026-11-19); `RegExp` leaves, which the engine supports, are not implemented (kit source).
- The kit replaces a stub's thrown error message with `no implementation for <event>` (kit source).

## Timing

- `settle()` waits on dispatch, render and clock activity, not on the module's dynamic import. A test whose first `$` call is left pending (a timeout race) must load the module first with an awaited call such as `await $.session.start(...)`; afterwards one `mock.clock` advance drains everything (kit source).
- Hook time limits do not exist in the kit, and hooks run on the same thread: budget overruns and "lingering" reports can only be seen in a real session (kit README).

## Official kit (`claude plugin test`)

- A `session.start` stub must return `{ cwd }`; `claude-engine-vitest` accepts `{}`, `claude plugin test` refuses it (`returned no { cwd }`) (2.1.322).
- A hook's own `{ isError: true, result }` answer reaches the caller unchanged in the official kit, while a real session drops the flag before the model sees it (2.1.322).
- To compare stand-in and engine, copy `plugin/` to a scratch directory, swap the test's imports to `claude-code/testing` and run `claude plugin test <copy>`.

## What only a real session shows

- The static check of the hooks module (`claude plugin validate <plugin>/plugin`) and the loading of a bundled `lib.mjs`.
- Type-checking of `userConfig` values before the module loads.
- Everything about permissions, hook tiers and `cc-plugin-sec-default`.

Recipe for a real session: the `live-verify` skill.
