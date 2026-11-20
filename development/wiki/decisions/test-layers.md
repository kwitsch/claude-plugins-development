# Test layers: unit tests on src, integration tests on the built plugin

How plugin tests split into a vitest unit layer on the TypeScript sources and a `claude plugin test` integration layer on the built `plugin/`, why, and what was rejected (user decision 2026-11-20; graphmind-helper 0.2.4 is the reference plugin).

## Decision (user, 2026-11-20)

1. Unit tests stay vitest (`test` from `vitest`, asserts from `node:assert/strict`, `claude-engine-vitest` for mods) and import `src/**/*.ts`; the kit loads `src/hooks/register.ts`. A name from an inlined module is imported from its own src file; an entry never re-exports for tests.
2. Process-level tests (MCP servers, command hooks) spawn the built `plugin/**/*.mjs`, because they run as processes.
3. A mod also has integration tests in `<plugin>/claude-tests/*.test.ts` on the official kit `claude-code/testing`, run by `development/scripts/plugin-test.ts` (`pnpm --filter <plugin> test:plugin`): it copies `plugin/` to a temp dir and the tests into `<tmp>/test/`, then runs `claude plugin test <tmp>`. They cover what only the built output shows: the bundle loads, every registered event fires, Claude Code's static check runs.
4. Other plugins move to this at their next test change (like the `.ts` conversion); no rewrite up front.

- Reason: unit tests on the sources are fast and precise, show a failure without a rebuild and need no re-export just for tests (graphmind-helper's `src/bin/mcp.ts` re-exported two names of the inlined `common.ts` until 0.2.4). Only Claude Code sees the bundle, `hooks.json` and the static check, so that layer runs in the engine's own kit.
- The constraints are in the rule [hook-tests.md](../../../.claude/rules/hook-tests.md); this page holds the reasons.

## Tooling

- `vitest.config.mts` aliases `@shared` to `development/shared/src`, mirroring `tsconfig.base.json` `paths` like the existing `@scripts` alias: `src/` modules import `@shared/<name>.js`, which vitest cannot resolve otherwise. No `vite-tsconfig-paths` dependency.
- `vitest.config.mts` excludes `**/claude-tests/**`: vitest's default include picked up `claude-tests/register.test.ts` and failed with `Cannot find package 'claude-code/testing'` (measured 2026-11-20).
- `claude-tests/` are type-checked: `development/vitest/claude-engine/claude-code-testing.d.ts` declares the module `claude-code/testing` from `claude-engine-vitest`'s own types (`test`, `mock`, `expect`); `.oxlintrc.json` relaxes `*/claude-tests/**` like `*/tests/**`.
- `claude-engine-vitest` needed no change: `createKit({ module })` loads any URL vitest can import, `.ts` included (its own suite loads `tests/mods/probe.ts`).
- The kit has no static check (no such code in `development/vitest/claude-engine/`), so it never refuses unbundled `src/`; Claude Code applies the check to `plugin/` only (`claude plugin validate`, `claude plugin test`).
- The runner is one file, `development/scripts/plugin-test.ts`, run from the plugin folder by its `test:plugin` script (hoisted on review of PR #133; first written per plugin).

## Facts that shaped it

- `claude plugin test` skips symlinks and finds hardlinks only per file, so the tests are copied, not linked. Mutation checks on the built `register.js` (a top-level throw, a broken `hooks.json`, an undefined handler, a changed result) each failed the run (live 2.1.329, 2026-11-20); removing the `session.end` registration fails graphmind-helper's reset test.
- The official kit's exports, its run without credentials and what it can stub: [test-kit-vs-engine.md](../facts/test-kit-vs-engine.md) (Official kit).

## CI (decided in review, 2026-11-20)

- CI runs no integration tests: `.github/workflows/pr.yml` is unchanged and the required `changed-plugins` job runs `pnpm test` (the unit layer) only. A plugin with a `test:plugin` script runs it locally before merge (constraint in [ci.md](../../../.claude/rules/ci.md)).
- Reason: installing `claude` and running `claude plugin test` on `ubuntu-latest` is unverified; an installer download or pinned-binary failure inside the required check would block every PR that touches such a plugin.
- Rejected: a step in `changed-plugins` (that failure would sit in the required check); a separate non-required job (the same unverified install, so it waits for the same check).
- Follow-up: wire `test:plugin` into CI once installing `claude` and the run are verified on a runner.

## Rejected

- A. All tests on the built output (the rule until 2026-11-20): tests what ships, but forces re-exports from entries for tests, hides failures behind a rebuild, and still sees neither the static check nor real loading.
- B. Only `claude plugin test`: one layer in the real engine, but the official kit runs only with the `claude` binary (absent in CI), is slower and has no vitest or `node:assert` ecosystem.
- C. A per-plugin vitest config or `vite-tsconfig-paths` for `@shared`: the repository allows one vitest config, and a dependency for one alias line breaks the reuse ladder.
- D. Untyped `claude-tests/` (oxlint ignore): the official kit exports the `claude-engine-vitest` surface, so a declaration derived from its types is a few lines and catches stub-shape mistakes before a `claude` run.

## Residuals

- Unit tests no longer see bundling effects (inlining, `@shared` inlined); only `claude-tests/` and `claude plugin validate` do.
- The declaration drifts if the official kit changes; the kit README tracks the same API.
- CI does not enforce the integration tests until the follow-up; a PR can merge with a failing `claude-tests/` run if its author skips `test:plugin`.
