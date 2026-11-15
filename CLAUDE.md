# CLAUDE.md

Development repository for Claude Code plugins. One top-level directory per plugin, named after the plugin.

`development/` holds shared developer tooling, no plugin: see `development/CLAUDE.md`.

## Layout per plugin (`<name>/`)

`plugin/` (installable plugin; `.mjs` and `.claude-plugin/plugin.json` are build output), `src/**/*.ts` (built to `plugin/` at the same path), `tests/*.test.ts` (vitest, against `plugin/`), plus:

- `package.json`: the only manifest source (`name`, `version`, `description`, `author`, `keywords`; plugin-only fields such as `userConfig` under `claudePlugin`, which is required, `{}` at least, and marks the package as a plugin) and the pnpm scripts `build` (`node ../development/scripts/build-plugin.ts`), `test`, optional `lint`. Edit here only.
- `src/bin/`: scripts used from several places (skills, hooks, MCP), built to `plugin/bin/*.mjs`, which Claude Code puts on the Bash PATH while the plugin is enabled.
- `scripts/`: optional plugin-specific build steps and dev-only tools (`.mts`, run by Node 24's type stripping, never shipped), e.g. dprint's `hooks.mts` (build) and universal-lint's `perf.mts` (hook cost measurement).
- `CLAUDE.md`: developer notes, never inside `plugin/` (a plugin-root CLAUDE.md is not loaded and triggers a validate warning). Notes for single parts go in `<name>/.claude/rules/*.md` with `paths:` relative to `<name>/` (loaded when Claude works on matching files; keep each under 40,000 characters, the on-demand load limit); `src/` holds only `.ts` (the `.mts` of unmigrated plugins: see `.claude/rules/src-typescript.md`).
- Hand-written plugin content (`SKILL.md`, `hooks/hooks.json`, `agents/*.md`, `README.md`) lives directly in `plugin/` and is edited there.

## Workspace-wide lint and test config

One config for all packages, at the repo root; no per-plugin lint or vitest config. Formatting stays with dprint (`dprint.json`); everything else is oxc.

- Lint + type check: root `.oxlintrc.json` (oxlint, type-aware) with the solution `tsconfig.json` (`tsconfig.src.json` strict, `tsconfig.tests.json` relaxed for plugin `*/tests/`); `pnpm lint` is the type check. Details: `.claude/rules/lint-config.md`.
- Build: the shared `development/scripts/build-plugin.ts` builds the plugin in the cwd (layout check, oxc-transform type stripping, oxc-minify, `plugin.json` generated from `package.json` by `plugin-manifest.ts`); a plugin's `build` script may run its own steps first; `pluginBuild.bundleHooksLib: true` in `package.json` bundles the hooks helper modules (everything `hooks.json` does not list) into one compressed `hooks/lib.mjs` (jev-api).
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
- Never edit `*/plugin/**/*.mjs` or `*/plugin/.claude-plugin/plugin.json` — change `src/` or `<name>/package.json` and run `pnpm build`. `.claude/settings.json` denies these writes.
- Version bump = edit `version` in `<name>/package.json`, then `pnpm build`. Any change under `<name>/` merged to `main` needs a bump to a version higher than on `main` that is not yet tagged `<name>-<version>` here or in kwitsch/claude-plugins, except a change of Claude memory only (`CLAUDE.md` at any depth, files under `<name>/.claude/`): it ships nothing, needs no bump and is not released (`.github/scripts/memory-only.sh`).
- New plugin: use the `scaffold-plugin` skill (`.claude/skills/scaffold-plugin/`). Never hand-copy the layout.
- Runtime code in `plugin/` must be zero-dependency Node (`node:` builtins only); `node_modules` is not shipped.
- MCP servers are dual-era (2025-11-25 `initialize` and 2026-07-28 `server/discover`, tasks only when asked): follow `.claude/rules/mcp-dual-era.md`, model `dprint/src/mcp/server.mts`.
- Commit messages: no `Co-Authored-By:` trailer, no "Generated with" footer.

## CI

PR, Dependabot, Release and Sync workflows: `.claude/rules/ci.md` (loads with `.github/**`). Job `changed-plugins` is the required status check on `main` — do not rename it.
