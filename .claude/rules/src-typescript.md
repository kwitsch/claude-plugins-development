---
paths:
  - "*/src/**"
  - "*/tests/**"
  - "development/**"
---

# Rule: TypeScript sources are `.ts`

graphmind indexes `.ts` symbols (signatures and types) but no `.mts` symbols (checked 2026-11-15: `graphmind outline` of a `.mts` source is empty, of the same code as `.ts` it lists every function and type). New sources must therefore be `.ts`.

- No new `.mts` file in any `src/` directory, and no new `.mts` under `development/`. Hand-written sources under `<name>/src/` are `.ts`.
- **First change in a plugin that still holds `.mts` converts that plugin in the same change.** When a change touches a plugin with `.mts` under `src/` or `tests/`, rename its `src/**/*.mts` and `tests/*.test.mts` to `.ts` in that change, not as a follow-up.
- Import specifiers in `.ts` sources: relative siblings as `./name.js` (TypeScript NodeNext resolves it to `name.ts`). `development/scripts/build-plugin.ts` rewrites every relative `.js` import of a source to `.mjs`, so the shipped code keeps `./name.mjs` and `bundleHooksLib` works unchanged.
- Scripts that Node runs directly (`development/scripts/*.ts`) import their siblings with the real extension (`./plugin-manifest.ts`); `allowImportingTsExtensions` is set in `tsconfig.base.json`.
- The build accepts `.ts` and `.mts` in `src/` during the transition; `.d.ts` / `.d.mts` are not built.
- A conversion is done only when all of these hold:
  1. `git status -- <name>/plugin` is empty after `pnpm --filter <name> build` (the shipped `.mjs` are byte-identical, so the rewrite changed nothing shipped);
  2. `pnpm lint`, `pnpm -r test` pass;
  3. `claude plugin validate <name>/plugin` passes;
  4. a live `claude -p --plugin-dir <name>/plugin` session loads the hooks and answers a tool call (`.claude/skills/live-verify`);
  5. `graphmind build` in the worktree lists the plugin's `src/**/*.ts` symbols with their types.
     A failure of 1 to 5 points at the build script, and every later plugin would hit it too: fix the script before converting the next plugin.
- Tests: `vitest` runs `*.test.ts` as well as `*.test.mts`; the kit `claude-engine-vitest` loads mods by `new URL("./mods/<name>.ts", ...)`.
- A `build` script path in `<name>/package.json` that changes (the `.mts` to `.ts` rename of `development/scripts/`) is a change under `<name>/` for every plugin: each one needs a version bump and a rebuilt `plugin/` (only `plugin.json` changes) before the PR can merge.
- A conversion that bundles the hooks (`pluginBuild.bundleHooksLib`) also moves the tests to the standard of `.claude/rules/hook-tests.md`.
