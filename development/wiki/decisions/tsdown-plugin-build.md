# tsdown plugin build standard

Why plugins are built with tsdown into self-contained files, how each kind of output is minified, what the build checks, and what was rejected (user decision 2026-11-20; graphmind-helper 0.2.3 is the reference plugin).

## Decision (user, 2026-11-20)

1. Every `.mjs`/`.js` in a plugin's `plugin/` is built by tsdown as one self-contained, zero-dependency file: dependencies and the plugin's own helper modules are inlined, `node:` builtins stay external. No separate `lib.mjs`, no `plugin/shared/` copy.
2. MCP servers and command hooks are fully minified (mangle and compress) and start with a shebang line. Command hooks stay in `plugin/hooks/`, named after the hook that calls them.
3. A mod (function-hooks entry) ships as `plugin/hooks/register.js`, self-contained, compressed but not mangled.
4. `plugin.json` is generated from `package.json` by a tsdown plugin in `development/tsdown/`; one shared config helper keeps a plugin's `tsdown.config.ts` at a few lines.
5. `@shared` imports resolve through an alias in that helper and are allowed in any bundled file.

- Reason: one build standard on the pnpm ecosystem instead of the loose scripts in `development/scripts/`, replaced step by step; a shipped script that is one file has no relative import that can miss its target.
- The constraints are in the rule [tsdown-build.md](../../../.claude/rules/tsdown-build.md); this page holds the reasons.

## Minify matrix for a mod (live 2.1.329, tsdown 0.23.7 / rolldown 1.3.3)

Claude Code's static check reads the names `$`, `on`, `next` and `register` in a hooks module, so not every minify level loads. Measured on graphmind-helper's entry:

- `minify: true`: rejected by the static check.
- `minify: { mangle: { toplevel: false } }`: rejected (a mangled `e` shadows `$`).
- `minify: { mangle: false, compress: true }`: loads, 11.2 kB. This is the shape `pluginConfig` uses for mods.
- `minify: false`: loads, 24.7 kB.
- `minify: "dce-only"`: loads, 24.7 kB.
- tsdown 0.23.7 / rolldown 1.3.3 has no per-name mangle exclusion (typings), so a mod is never mangled.
- Scripts (MCP servers, command hooks, bin scripts) run in plain Node and take `minify: true` (build 2026-11-20: graphmind-helper's `bin/mcp.mjs` 2.2 kB).
- Other tool behaviour: [build-lint-and-format-tools.md](../facts/build-lint-and-format-tools.md). Engine evidence and the load of a `.js` hooks module: [mods-engine-verification.md](../facts/mods-engine-verification.md).

## One build per entry

- `pluginConfig()` returns one tsdown config per entry (`UserConfig[]`). With several entries in one build rolldown moves a module that two entries share into a chunk, and `minify` is one option per build, so mods and scripts could not differ (typings 0.23.7).
- Entries are listed by kind in `tsdown.config.ts` (`mods`, `scripts`), not derived from file names: graphmind-helper's `src/bin/common.ts` is a helper, not an entry.
- The shebang comes from line 1 of the source and is checked by the build, not injected: rolldown keeps an entry's hashbang and tsdown sets mode 0755 on such output (build 2026-11-20, log line "Granting execute permission").
- Output is byte-stable across runs (build 2026-11-20, graphmind-helper built twice).
- `./x.js` and `@shared/x.js` specifiers resolve to the `.ts` sources (build 2026-11-20).
- Options used (typings 0.23.7): `deps.alwaysBundle: [/./]` with `deps.onlyBundle: false`, `alias`, `outExtensions`, `minify`, `clean: false`, `target: "es2022"` (kept from the old build). rolldown's plugin types are taken from tsdown (`Rolldown.Plugin`), because the root `rolldown` is another version.

## What the build checks

- Before anything is written: the entry list (at least one entry, shape `[\w-]+(/[\w-]+)*`, no duplicate within a kind, the source exists), `package.json` through `pluginManifest`, the layout of `plugin/` through `check-plugin-layout.ts` (its allowlist gained `hooks/[^/]+\.js`; it rejects symlinks).
- Per entry, before its file is written: exactly one chunk (a dynamic `import()` or an emitted asset adds one); only `node:` specifiers among its static and dynamic imports (catches a bare `fs`, a dependency left external, a missed `@shared`); a script starts with `#!`, a mod does not.
- After the first entry is written: every regular `.mjs`/`.js` below `plugin/` that is neither an entry's output nor listed in `pluginBuild.assets` is deleted (a stale committed file would ship), then `plugin.json` is written, byte-identical to the old build's.
- Tested in `development/tsdown/tests/plugin-config.test.ts` (build 2026-11-20, 16 tests).

## Given up against the old build

- "Replace `plugin/` only after every file compiled": a build that fails after another entry was written leaves `plugin/` partly updated. `plugin/` is committed, so `git status` shows it, the next successful build repairs it, and CI compares the committed output with a fresh build.
- `PLUGIN_SHARED_SRC` (the old build's test seam for a fixture shared folder): the helper's test uses the real `development/shared/src`.

## Rejected

- Extending `build-plugin.ts` to bundle with the installed rolldown 1.2.16 (no new dependency, one build path): the user asked for tsdown and for the loose scripts to go, the 403-line script would need a second, graph-based bundling mode beside its helper merger, and the minify matrix was verified with tsdown 0.23.7 / rolldown 1.3.3 only.
- One tsdown config with all entries and the minify level chosen per output: shared chunks and one `minify` per build (see "One build per entry").
- Entries by convention (every `src/bin/*.ts` a script, mods read from `hooks.json`): needs an exclusion rule for helper modules or a file move; the explicit list is shorter than the rule.
- Building into a temp directory and swapping it into `plugin/`: extra copy code for a property git already gives.

## Coexistence and the last migration

- A plugin with `tsdown.config.ts` is on the standard. cc-knowledge, dprint, jev-api, jevfort, rc-enhancement, universal-format and universal-lint still build with `development/scripts/build-plugin.ts`, which is unchanged. One PR per plugin.
- The PR that migrates the last plugin removes `build-plugin.ts` and its tests, `pluginBuild.bundleHooksLib` and `compressHookScripts`, the root `oxc-transform`, `oxc-minify` and `oxc-parser` devDependencies and the old-build rules; `plugin-manifest.ts` and `check-plugin-layout.ts` move into `development/tsdown/`.
- Open until then: vendored bundles (`plugin/**/vendor/*.mjs`, universal-format) under tsdown, where the stale-output removal spares only `pluginBuild.assets`; a plugin without source entries (skills only); the root `rolldown` stays pinned at 1.2.16 for the vendor step, so the lockfile holds two rolldown versions.

## Not checked

- rolldown renames colliding top-level names with a `$1` suffix when it merges modules; whether the engine's static check accepts such identifiers is unknown. graphmind-helper's output passes `claude plugin validate`; other plugins are unchecked.
- A change limited to `development/tsdown/**` gets no `changed-plugins` status (paths-ignore) and is not tested by CI, like `development/scripts/**`.
