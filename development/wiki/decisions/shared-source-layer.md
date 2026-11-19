# Shared source layer for plugins

Analysis and plan for moving code that several plugins copy into one build-time shared source (analysis 2026-11-19, direction chosen by the user 2026-11-19; step 1, the build mechanism, is implemented, the shared modules are not).

## Duplicates found (grep, graphmind, normalized function bodies; not a full clone-detector run)

- Path-scope invariants: `isExcludedPath` (dprint `format.ts`, universal-format `handlers.ts`, universal-lint `lint-file.ts`), `realish` (dprint, universal-lint "port of dprint's"), `outside` / `relativeIfContains`, the scratchpad test. `hook-file-safety.md` wants these in one function.
- `walkToRoot`: identical in universal-format `util.ts` and universal-lint `lint-file.ts`.
- MCP dual-era server envelope in dprint, universal-format, jev-api (`requestedVersion` identical x3, `readVersion` identical x2, `HOOK_ONLY_META`, `CACHE_HINT`, version keys, the initialize / discover / cancel / ping / `tools/list` switch). `mcp-dual-era.md` names dprint's server as the model, i.e. copy-paste is the mechanism.
- Types `HookResult`, `RequestId`, `ToolDef` (type-only).
- Dev only: `tests/manifest.test.ts` in four plugins.
- Left alone on purpose: dprint `CONFIG_NAMES` copies (pinned by `dprint-gate.test.ts`), the bodies of `lint-file.ts`, jevfort and jev-api function-hooks code and transport.
- Realistic saving: about 400-500 of roughly 2,000 duplicated lines; the gain is one source for safety rules and protocol changes.

## Constraints that shape the mechanism

- A plugin runs from a cache copy without `node_modules`: shared code must be inlined or copied into `plugin/` at build time; a runtime npm package is out.
- `build-plugin.ts` compiles `src/` file by file; `bundleHooksLib` bundles only sibling helpers of `hooks/`. Function-hooks plugins (`$` engine, static check) stay out of the first step.
- Built `plugin/*.mjs` is committed, so a shared change already shows in each consumer's `plugin/` diff: `ships.sh` needs no change, but every consumer needs a version bump per shared change.
- universal-lint's `lint-file.mjs` is a self-contained command hook started on every edit: measure the cost of an extra module before it imports shared code.

## Decision (user, 2026-11-19): build-time shared source

- `development/shared/src/*.ts`, a workspace-internal folder, not a published package. Built (step 1, done): a plugin source imports `@shared/<name>.js`; `build-plugin.ts` compiles that module (and, transitively, the shared modules it imports) to `plugin/shared/<name>.mjs` and rewrites the import to the relative path; `tsconfig.base.json` `paths` keeps `pnpm lint` type-checking it. No `pluginBuild.shared` list (changed from the first plan): a plugin ships exactly the modules its sources import, so list and imports cannot disagree and a dropped import drops the file on the next build.
- Build failures (tested in `development/scripts/tests/build-shared.test.ts`, old output kept): unknown module, a name outside `[\w-]+(/[\w-]+)*`, a re-export or dynamic import of `@shared/` (only static imports are rewritten), a plugin source that would write the same `plugin/shared/` path, and a `bundleHooksLib` plugin (function-hooks plugins are not supported yet). ESM import cycles between shared modules are allowed (Node resolves them).
- `PLUGIN_SHARED_SRC` points the build at a fixture folder; test seam only.
- Rejected: copy plus drift check (duplication stays); published npm package (zero-dependency rule).

## Plan

1. Done: the mechanism above, with its tests, the `build-scripts` workspace package (`development/scripts`, so `pnpm -r test` runs them) and the rules `development/CLAUDE.md`, `plugin-src.md`, `lint-config.md`. `plugin/shared/*.mjs` is build output (`**/*.mjs`), so the layout check needed no change; all nine plugins rebuild byte-identical. Not done: shared code imported from a plugin's `hooks/` in a lib-bundle plugin.
2. Done for dprint 0.14.2 and universal-format 0.19.2: `development/shared/src/scope.ts` holds `isExcludedPath`, `hasClaudeInternal`, `outside`, `relativeIfContains`, `realish` (the `realpathSync.native` form of dprint) and `walkToRoot`; tests in the workspace package `shared-code` (`development/shared/tests/scope.test.ts`, run against `src/`, 11 tests; the five `isExcludedPath` tests of universal-format moved there, so its count went 213 to 208; the sixth case, from universal-lint's tests, was added). The scratchpad test stays in each plugin (dprint checks lexical and real path, universal-format lexical only: different on purpose). Not done: universal-lint (its `realish` uses non-native `realpathSync`, its copies are pinned by its own tests, and the cold-start cost of an import in `lint-file.mjs` is unmeasured).
3. `shared/mcp-core`: `createServer({ name, tools })` with envelope, cancel handling, `readVersion`. Move dprint and universal-format; jev-api last (per-call timeout and app-level cancel: maybe envelope only). Update `mcp-dual-era.md` to name the shared module as the model.
4. Shared types (`HookResult`, `RequestId`), type-only.
5. Manifest-test helpers into `development/vitest/` (no build change, no bump).
6. Per step: `pnpm lint && pnpm -r build && pnpm -r test`, `claude plugin validate`, `live-verify` of each touched plugin, version bump of every consumer.

Notes from step 2:

- `bundleHooksLib` plugins may import shared code from `mcp/` and `bin/` (dprint does, from `mcp/format.ts`), not from `hooks/`: the build refuses that (`hooksShared` guard, tested both ways).
- jev-api already has its own `src/shared/` (`plugin/shared/`): a shared module of the same name fails the build with the clash error; pick other names.

Order of value: step 2, then 3; 4 and 5 any time.

## Not checked

The jev-api server body and `build-plugin.ts` were not read in full; the two `realish` copies were not compared for identical behaviour; the load cost of an import in `lint-file.mjs` is unmeasured.
