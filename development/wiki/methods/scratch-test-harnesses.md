# Testing a modified or older plugin build without touching the repository

How to run a plugin's tests against a changed copy (a repro, a mutant, an older version) from the session scratchpad.

Used by read-only bug hunts, mutation checks and A/B measurements. Paths below: `<repo>` is the checkout root, `<scratch>` a directory in the session scratchpad. The config path must be absolute.

## A repro test for a function-hooks plugin

- Put a `*.test.ts` into `<scratch>` that imports `createKit` from the absolute path `<repo>/development/vitest/claude-engine/index.ts` and the built `plugin/hooks/*.mjs` by file URL.
- Run it from the plugin directory: `npx vitest run --root <scratch> --config <repo>/vitest.config.mts <file> --silent=false`.

## The plugin's own tests against a modified copy

- In `<scratch>`: `node_modules/claude-engine-vitest` and `node_modules/vitest` as symlinks to `<repo>/development/vitest/claude-engine` and `<repo>/node_modules/vitest`; copies of `<plugin>/plugin` and of the test file as `<scratch>/plugin` and `<scratch>/tests`.
- From the repository root: `./node_modules/.bin/vitest run --root <scratch> --config <repo>/vitest.config.mts`.
- Variant with the plugin's own dependencies: `<scratch>/pkg/{tests,plugin/hooks}/`, `pkg/node_modules` as a symlink to `<plugin>/node_modules`, a `pkg/package.json` holding `{"type":"module"}`.

## Mutation check

- Change one thing in the copied `plugin/**/*.mjs` per run and run the tests (about 2.4 s per mutant for jev-api); a mutant that passes shows an assertion that cannot fail.
- A `p.catch(() => undefined)` right before a synchronous `Promise.race([p, ...])` is redundant (the race attaches a handler), so removing it is an equivalent mutant, not a test gap.

## A/B measurement against an older version

- Clone the merge base into the scratchpad (`git clone --no-checkout`, then checkout), symlink the worktree's root `node_modules` into it, and run each version's own measurement script alternately, so load affects both sides alike.
- Use the built output and real tool versions, at least five repetitions where cheap, and report median and p90 with the machine's load (`.claude/rules/plugin-docs-tasks.md`).

## Compare with the real engine

- [test-kit-vs-engine.md](../facts/test-kit-vs-engine.md) lists what the kit cannot show; `claude plugin test <copy>` runs a ported kit test on the engine.
