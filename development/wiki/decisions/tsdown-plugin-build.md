# tsdown plugin build standard

Why plugins are built with tsdown into self-contained files, how each kind of output is minified, what the build checks, and what was rejected (user decision 2026-11-20; graphmind-helper 0.2.3 is the reference plugin).

## Decision (user, 2026-11-20)

1. Every `.mjs`/`.js` in a plugin's `plugin/` is built by tsdown as one self-contained, zero-dependency file: dependencies and the plugin's own helper modules are inlined, `node:` builtins stay external. No separate `lib.mjs`, no `plugin/shared/` copy.
2. MCP servers and command hooks are fully minified (mangle and compress) and start with a shebang line. Command hooks stay in `plugin/hooks/`, named after the hook that calls them.
3. A mod (function-hooks entry) ships as `plugin/hooks/register.js`, self-contained, compressed but not mangled.
4. `plugin.json` is generated from `package.json` by a tsdown plugin in the repo's own build (`pluginConfig`, removed 2026-11-24); one shared config helper keeps a plugin's `tsdown.config.ts` at a few lines.
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
- Tested in the former `plugin-config.test.ts` of that build (build 2026-11-20, 16 tests).

## Given up against the old build

- "Replace `plugin/` only after every file compiled": a build that fails after another entry was written leaves `plugin/` partly updated. The next successful build repairs it, and CI and Sync always build fresh.
- `PLUGIN_SHARED_SRC` (the old build's test seam for a fixture shared folder): the helper's test uses the real `development/shared/src`.

## Rejected

- Extending `build-plugin.ts` to bundle with the installed rolldown 1.2.16 (no new dependency, one build path): the user asked for tsdown and for the loose scripts to go, the 403-line script would need a second, graph-based bundling mode beside its helper merger, and the minify matrix was verified with tsdown 0.23.7 / rolldown 1.3.3 only.
- One tsdown config with all entries and the minify level chosen per output: shared chunks and one `minify` per build (see "One build per entry").
- Entries by convention (every `src/bin/*.ts` a script, mods read from `hooks.json`): needs an exclusion rule for helper modules or a file move; the explicit list is shorter than the rule.
- Building into a temp directory and swapping it into `plugin/`: extra copy code for a property git already gives.

## Migration finished (2026-11-20)

- All eight plugins build with `pluginConfig`. The PR that migrated cc-knowledge, dprint, jev-api, jevfort, rc-enhancement, universal-format and universal-lint removed `build-plugin.ts` and its tests, `pluginBuild.bundleHooksLib` and `compressHookScripts`, the root `oxc-transform`, `oxc-minify` and `oxc-parser` devDependencies, the rules `hooks-lib-bundle.md`, `plugin-src.md`, `src-typescript.md` and the skill `convert-plugin-ts`.
- `plugin-manifest.ts` and `check-plugin-layout.ts` stay in `development/scripts/`: CI calls the layout check by that path (this corrects the earlier plan to move them).
- The root `rolldown` stays pinned at 1.2.16 for the vendor step.

## The vendor option

- universal-format's prettier bundle (`plugin/mcp/vendor/*.mjs`) is built by the plugin's own step after tsdown. It must stay external to the entries that import it and outside the stale-output removal, so `pluginConfig` takes `vendor: ["mcp/vendor"]`.
- Mechanism: a rolldown `resolveId` plugin returns a relative import of `src/<dir>/index.js` as `{ id, external: true }`, with the specifier computed from the entry's output directory. A `renderChunk` rewrite is the fallback for a case `resolveId` does not see.
- Vitest side: `vitest.config.mts` maps `./vendor/index.js` to the built `plugin/mcp/vendor/index.mjs`, so unit tests load the built bundle (the types stay in `src/mcp/vendor/index.d.ts`).
- Rejected A: a computed runtime `import(new URL(...))`. The module is inlined into two outputs at different depths and imported from `src/` by unit tests; the static import and `BUNDLED_PRETTIER_VERSION` would become asynchronous, and a missing bundle would fail only at runtime.
- Rejected B: bundling prettier with tsdown. The three plugin loaders must stay dynamic `import()`s, which makes several chunks and fails the one-file check; inlined statically it puts about 6 MB into each of two outputs and loads all of it at every start.

## Command hooks that several events call

- dprint `hooks/watch-paths` (SessionStart, CwdChanged) and universal-lint `hooks/lint-file` (six events) cannot be named after the hook that calls them. Each is one file in `plugin/hooks/` named after what it does: a documented deviation from the rule.

## Pitfall: work at import in an inlined module

- universal-lint's main guard compared `process.argv[1]` with `import.meta.url`. Inlined into `lint-files.mjs`, both name the driver, so the driver would have started the hook's stdin loop.
- Fixed by the entry/library split (`lint-file.ts` only calls `lint-core.ts`), guarded by the open-stdin test. Rejected D: teaching the guard the output name.

## Skills-only plugins

- A plugin with no source entry (`hook`, `mods` and `mcp` all absent) has no build in the standard. `scaffold-plugin` stops and reports; a follow-up when the first one is wanted.

## Not checked

- rolldown renames colliding top-level names with a `$1` suffix when it merges modules; whether the engine's static check accepts such identifiers is unknown. Measured 2026-11-20: `grep -c '\$1\b' <plugin>/plugin/hooks/register.js` gives cc-knowledge 0, dprint 0, jevfort 0, jev-api 2; `claude plugin validate <plugin>/plugin` passes for all four, and `pnpm --filter <plugin> test:plugin` passes for the same four mods (cc-knowledge 3, dprint 5, jev-api 5, jevfort 8 tests). The `$1` identifiers of jev-api were not exercised beyond that.
- A change limited to the former repo-local build got no `changed-plugins` status (paths-ignore) and was not tested by CI, like `development/scripts/**`; since 2026-11-25 pr.yml has no `paths-ignore`.

## Superseded by the published preset (2026-11-24)

All eight plugins build with `@kwitsch/tsdown-preset-claude-code` (exact, beside `tsdown` 0.23.7, devDependencies of each plugin): seven on 0.2.0, universal-format on 0.3.0. The repo-local `pluginConfig` build, its manifest generator `plugin-manifest.ts`, their tests and the root `tsdown`/`rolldown` devDependencies are deleted. The decisions above hold where the preset does the same (self-contained outputs, the minify matrix, `@shared` inlined through `overrides.alias`); "The vendor option" and its vitest alias are gone. The constraints are in [tsdown-build.md](../../../.claude/rules/tsdown-build.md).

- Why 0.2.0: only it has `bundles` and `files`, which build universal-format's vendored prettier bundle and copy its wasm files; on 0.1.2 that plugin would have kept the old build, and two build systems would have coexisted. graphmind-helper went from 0.1.2 to 0.2.0.
- Why universal-format is on 0.3.0: on 0.2.0 `files` kept the source file mode (two wasm files from the pnpm store came out 0755) and the layout check rejected the bare builtin imports (`fs`, `path`, ...) of prettier's chunks, which only `overrides.nodeProtocol: true` worked around. Reported as preset issue kwitsch/rolldown-plugin-claude-code#11; 0.3.0 writes `files` with a fixed mode 0644 and accepts the bundled builtins, so universal-format needs neither a chmod step nor `nodeProtocol`. The other seven stay on 0.2.0 until a bump is wanted for its own sake.
- Hand-written shipped files moved to `<name>/assets/`, hooks and MCP servers to `hooks.template.json` / `mcp.template.json`; the preset empties `plugin/` before each build.
- `claudePlugin` is forwarded as `manifest` in every `tsdown.config.ts`: the preset (0.2.0 and 0.3.0, checked in `dist/`) ignores that key and would drop jev-api's `userConfig` and jevfort's `dependencies`.
- cc-knowledge's skill scripts moved from `skills/<skill>/scripts/<name>.mjs` to `skills/<skill>/<name>.mjs` with their data and reference files: the preset has no subfolder for skill scripts.
- Command hooks are generated as `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/<name>.mjs"]`; Claude Code runs that form ([claude-code-command-hooks.md](../facts/claude-code-command-hooks.md#command-and-args), live 2.1.331, 2026-11-24, rc-enhancement and universal-lint).
- Not covered any more: the cross-plugin test that `plugin.json` equals the manifest derived from `package.json` went with `plugin-manifest.ts`; the preset's own tests and CI's layout check remain.
- Rejected: staying on 0.1.2 with universal-format on the old build (two builds, the old build and its tests kept alive for one plugin); keeping `scripts/vendor.ts` as a post-build step (its external `./vendor/index.js` fails the preset's import check unless bypassed); converting rc-enhancement's and universal-lint's command hooks to mods (behaviour change: exit-2 semantics, `asyncRewake`, per-event timeouts); one pull request per plugin (eight bumps over eight PRs and a ninth, development-only PR that CI ignores and needs an admin merge).

## Build output not committed (user, 2026-11-25)

`<name>/plugin/` is git-ignored build output: the 145 tracked files of the nine plugins left the index, `.gitignore` lists `*/plugin/`, and `.gitattributes` lost its `plugin/` rules. pr.yml builds every changed plugin, and Sync builds the plugin it publishes in its own job before the rsync; both run `development/scripts/check-plugin-layout.ts` directly. The freshness wrapper `.github/scripts/check-plugin-fresh.sh` is deleted. Constraints: root `CLAUDE.md` (version bump) and [ci.md](../../../.claude/rules/ci.md).

- When a plugin ships: `.github/scripts/ships.sh <dir> <from> <to>` prints `ship` (build inputs and version changed), `content` (inputs only), `version` (version only) or `none`. Release tags and syncs only on `ship` and checks that itself, since an admin merge can bypass the PR check; `content` and `version` are notices there, so a failed `tag` job never skips the syncs of other plugins in the same push. The PR check fails on `content` unless Dependabot opened the PR (the existing "not higher than on main" error) and warns on `version`. `ships-notice.sh` words those annotations once for both workflows.
- Why each build input counts (the list itself is in [ci.md](../../../.claude/rules/ci.md)): `assets/` is copied to `plugin/`; the templates generate `hooks/hooks.json` and `.mcp.json`; `tsdown.config.ts` holds build options; of `package.json` the manifest fields go into `plugin.json`, `scripts.build` runs build steps and `devDependencies` pin `tsdown`, the preset and bundled packages such as universal-format's prettier (compared as jq-normalised JSON, the whole `devDependencies` object counts), while `version` and every script but `build` change no output (a `build` script that runs another script of the package.json is not followed); `development/shared/src/` is inlined into a plugin whose `tsdown.config.ts` aliases `@shared`. Not inputs: `tests/`, `claude-tests/`, `scripts/` (dprint's `claude-code-hook-types` writes the committed `src/mcp/hook-inputs.d.ts`, so its effect shows under `src/`), `CLAUDE.md`, `.claude/`, `plugin/`.
- Dependabot (user, q1): its PRs skip the bump check entirely. The next version bump of that plugin ships the build they changed, because `ships.sh` also counts the inputs changed since the previous release tag `<name>-<old version>` (review fix, user 2026-11-25); without a tag it compares only the range.
- Shared source (user, q2, revised 2026-11-25 on the review finding): a change of `development/shared/src/` makes every `@shared` plugin a changed plugin (`changed-plugins.sh`), so CI demands each one's bump, and pr.yml, release.yml and dependabot-automerge.yml no longer carry `paths-ignore: development/**` (a development-only PR gets `changed-plugins` and is tested; wiki.yml is redundant with pr.yml's wiki check and stays).
- Not detected: a root `pnpm-lock.yaml`-only change (a transitive build-tool update); it ships with the next real release. A plugin that needs such a release urgently gets a hand-pushed `<name>-<version>` tag (sync.yml's manual path stays as the override) or a real input change.
- Tests on the built `plugin/` need a build first in a fresh clone or worktree (`pnpm -r build`, then `pnpm -r test`); documented only. Reviewers no longer see the shipped bytes in a PR; accepted.
- Reasons: 145 generated files in every diff, merge conflicts on every parallel branch, a mandatory rebuild-and-commit step, and a check (`check-plugin-fresh.sh`) that only policed that duplication; the user rule that a release needs both a source change and a version change, and that a PR changing sources without a bump fails CI.
- Rejected: keeping the committed build (status quo); building base and head in the PR job and comparing (exact, but double build time, a second checkout and install, a comparison script); Release handing its build to Sync as an artifact (Sync also runs on a hand-pushed tag without one); `ships.sh` as a content-only exit 0/1 with the version comparison inline in both workflows (the rule written twice, could drift); exit codes for the four states (a `set -e` failure would be misread as a state); `scripts/` as a build input; splitting `devDependencies` per entry (a maintained per-plugin list); failing release.yml on `content` (every Dependabot merge lands there, and a failed `tag` job skips the other plugins' syncs); a `pretest` build or vitest globalSetup; uploading the built `plugin/` as a PR artifact.
- Verified 2026-11-25: a clean clone without `*/plugin/`, after `pnpm install --frozen-lockfile && pnpm -r build`, reproduced `origin/main`'s committed `plugin/` of all nine plugins byte for byte, with the same exec bits and universal-format's three wasm files.
