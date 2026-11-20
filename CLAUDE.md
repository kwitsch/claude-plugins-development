# CLAUDE.md

Development repository for Claude Code plugins. One top-level directory per plugin, named after the plugin.

`development/` holds shared developer tooling, no plugin: see `development/CLAUDE.md`.

## Knowledge

- Before researching how Claude Code, a tool or an external API behaves, or re-deciding something, read `development/wiki/index.md`: it lists what earlier sessions verified, decided and tripped over, in the wiki and in every rule and plugin document.
- What a task establishes is written into the repository in the same change, each fact once: a constraint for certain files into a rule with `paths:`, knowledge about one plugin into that plugin's `CLAUDE.md`, rules or its wiki section `development/wiki/plugins/<plugin>/`, everything else into the wiki with the `wiki` skill (`.claude/skills/wiki/`).
- Memory files (`CLAUDE.md`, rules) load into every agent that touches a matching file, so they hold constraints only, one or two lines each. Reasons, measurements, residuals, rejected alternatives and how something was verified go to a page that is not loaded by itself (the wiki: `development/wiki/plugins/<plugin>/design/` for one plugin, the other wiki folders for what spans plugins), linked from the constraint as `[topic](relative/path.md)`; never with an `@path` import, which loads the page anyway. Keep `paths:` as narrow as the constraint's reach.
- The machine-local memory (graphmind, auto-memory) holds personal preferences and one-line pointers only, never the only copy of a fact about this repository.

## Layout per plugin (`<name>/`)

`plugin/` (installable plugin; `.mjs`, `hooks/*.js` and `.claude-plugin/plugin.json` are build output), `src/**/*.ts` (built to `plugin/`: the entries `tsdown.config.ts` lists, each one self-contained file; on the old build every file at the same path), `tests/*.test.ts` (vitest, against `plugin/`), plus:

- `package.json`: the only manifest source (`name`, `version`, `description`, `author`, `keywords`; plugin-only fields such as `userConfig` under `claudePlugin`, which is required, `{}` at least, and marks the package as a plugin) and the pnpm scripts `build` (`tsdown`; `node ../development/scripts/build-plugin.ts` in a plugin not yet migrated), `test`, optional `lint`. Edit here only.
- `tsdown.config.ts`: the plugin's entries for the standard build, `export default pluginConfig({ mods: [...], scripts: [...] })` (`.claude/rules/tsdown-build.md`).
- `src/bin/`: scripts used from several places (skills, hooks, MCP), built to `plugin/bin/*.mjs`, which Claude Code puts on the Bash PATH while the plugin is enabled.
- `scripts/`: optional plugin-specific build steps and dev-only tools (`.mts`, run by Node 24's type stripping, never shipped), e.g. dprint's `hooks.ts` (build) and universal-lint's `perf.ts` (hook cost measurement).
- `CLAUDE.md`: developer notes, never inside `plugin/` (a plugin-root CLAUDE.md is not loaded and triggers a validate warning). Notes for single parts go in `<name>/.claude/rules/*.md` with `paths:` relative to `<name>/` (loaded when Claude works on matching files; keep each under 40,000 characters, the on-demand load limit).
- Hand-written plugin content (`SKILL.md`, `hooks/hooks.json`, `agents/*.md`, `README.md`) lives directly in `plugin/` and is edited there.

## Workspace-wide lint and test config

One config for all packages, at the repo root; no per-plugin lint or vitest config. Formatting stays with dprint (`dprint.json`); everything else is oxc.

- Lint + type check: root `.oxlintrc.json` (oxlint, type-aware) with the solution `tsconfig.json` (`tsconfig.src.json` strict, `tsconfig.tests.json` relaxed for plugin `*/tests/`); `pnpm lint` is the type check. Details: `.claude/rules/lint-config.md`.
- Build (the standard, tsdown; reference plugin graphmind-helper): `pluginConfig` in `development/tsdown/index.ts` builds each entry of `tsdown.config.ts` into one self-contained file and generates `plugin.json`. Details: `.claude/rules/tsdown-build.md`.
- Build (old path, a plugin without `tsdown.config.ts`, until it is migrated): the shared `development/scripts/build-plugin.ts` builds the plugin in the cwd (layout check, oxc-transform type stripping, oxc-minify, `plugin.json` generated from `package.json` by `plugin-manifest.ts`); a plugin's `build` script may run its own steps first; `pluginBuild.bundleHooksLib: true` in `package.json` bundles the hooks helper modules (everything `hooks.json` does not list) into one compressed `hooks/lib.mjs` (jev-api). `pluginBuild.assets` lists files the layout check allows in `plugin/` beside its allowlist, by exact path (universal-format's wasm files).
- `vitest.config.mts` at the root is the one vitest config. Tooling is root devDependencies only. Details: `.claude/rules/lint-config.md`.

## Commands

```bash
pnpm install                 # once, at repo root (workspace)
pnpm -r build                # build every plugin
pnpm -r test                 # run every plugin's tests
pnpm lint                    # oxlint (lint + type check) over the workspace, then plugin-specific lint scripts
pnpm --filter <name> build   # one plugin
claude plugin validate <name>/plugin
```

## Rules

- `.mjs` (and `.js`) is build output only; every hand-written module is `.ts` (Node 24 and vitest strip the types; `src/` is compiled by `pnpm build`; a plugin not yet migrated still holds `.mts` until its first change, see `.claude/rules/src-typescript.md`).
- Never edit `*/plugin/**/*.mjs`, `*/plugin/**/*.js` or `*/plugin/.claude-plugin/plugin.json` — change `src/`, `<name>/package.json` or `<name>/tsdown.config.ts` and run `pnpm build`. `.claude/settings.json` denies these writes.
- Version bump = edit `version` in `<name>/package.json`, then `pnpm build`. A change of `<name>/package.json`, `<name>/src/` or `<name>/plugin/` merged to `main` needs a bump to a version higher than on `main` that is not yet tagged `<name>-<version>` here or in kwitsch/claude-plugins; a change of anything else under `<name>/` (tests, scripts, `CLAUDE.md`, `.claude/`) needs no bump and is not released (`.github/scripts/ships.sh`).
- New plugin: use the `scaffold-plugin` skill (`.claude/skills/scaffold-plugin/`). Never hand-copy the layout.
- Runtime code in `plugin/` must be zero-dependency Node (`node:` builtins only); `node_modules` is not shipped. One exception: a vendored third-party bundle `plugin/**/vendor/*.mjs` built by the plugin's own build step (universal-format's prettier), see `.claude/rules/plugin-build-output.md`.
- MCP servers are dual-era (2025-11-25 `initialize` and 2026-07-28 `server/discover`, tasks only when asked): follow `.claude/rules/mcp-dual-era.md`, model `dprint/src/mcp/server.ts`.
- Commit messages: no `Co-Authored-By:` trailer, no "Generated with" footer.

## CI

PR, Dependabot, Release and Sync workflows: `.claude/rules/ci.md` (loads with `.github/**`). Job `changed-plugins` is the required status check on `main` — do not rename it.
