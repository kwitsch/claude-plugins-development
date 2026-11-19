# Shared source layer for plugins

Analysis and plan for moving code that several plugins copy into one build-time shared source (analysis 2026-11-19, direction chosen by the user 2026-11-19; not implemented yet).

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

- `development/shared/src/*.ts`, a workspace-internal folder, not a published package. A plugin opts in with `pluginBuild.shared: ["scope", "mcp-core"]`; `build-plugin.ts` compiles those files to `plugin/shared/*.mjs` and rewrites the imports; a `tsconfig` path keeps `pnpm lint` type-checking them.
- Rejected: copy plus drift check (duplication stays); published npm package (zero-dependency rule).

## Plan

1. Record the mechanism in `decisions/repo-tooling.md` (relation to the vendored bundles, `plugin-build-output.md` layout allowlist, `check-plugin-layout.ts`); add a build test for a missing or cyclic shared module and a failing build check in CI before any plugin moves.
2. `shared/scope`: `isExcludedPath`, `realish`, `outside`, `walkToRoot`, scratchpad test, one test file with every never-format case. Move dprint and universal-format; universal-lint after measuring cold start.
3. `shared/mcp-core`: `createServer({ name, tools })` with envelope, cancel handling, `readVersion`. Move dprint and universal-format; jev-api last (per-call timeout and app-level cancel: maybe envelope only). Update `mcp-dual-era.md` to name the shared module as the model.
4. Shared types (`HookResult`, `RequestId`), type-only.
5. Manifest-test helpers into `development/vitest/` (no build change, no bump).
6. Per step: `pnpm lint && pnpm -r build && pnpm -r test`, `claude plugin validate`, `live-verify` of each touched plugin, version bump of every consumer.

Order of value: step 2, then 3; 4 and 5 any time.

## Not checked

The jev-api server body and `build-plugin.ts` were not read in full; the two `realish` copies were not compared for identical behaviour; the load cost of an import in `lint-file.mjs` is unmeasured.
