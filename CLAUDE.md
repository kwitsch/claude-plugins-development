# CLAUDE.md

Development repository for Claude Code plugins. One top-level directory per plugin, named after the plugin.

`development/` holds shared developer tooling, no plugin: `development/scripts/` the build scripts every plugin uses (`build-plugin.mts`, `check-plugin-layout.mts`, `plugin-manifest.mts`); `development/vitest/claude-engine/` the workspace package `claude-engine-vitest` (no `plugin/`), the shared vitest stand-in for Claude Code's mod test kit (`claude-code/testing`), a `workspace:*` devDependency of plugins with function-hooks modules. Not versioned or released.

## Layout per plugin (`<name>/`)

`plugin/` (installable plugin; `.mjs` and `.claude-plugin/plugin.json` are build output), `src/**/*.mts` (built to `plugin/` at the same path), `tests/*.test.mts` (vitest, against `plugin/`), plus:

- `package.json`: the only manifest source (`name`, `version`, `description`, `author`, `keywords`; plugin-only fields such as `userConfig` under `claudePlugin`, which is required, `{}` at least, and marks the package as a plugin) and the pnpm scripts `build` (`node ../development/scripts/build-plugin.mts`), `test`, optional `lint`. Edit here only.
- `src/bin/`: scripts used from several places (skills, hooks, MCP), built to `plugin/bin/*.mjs`, which Claude Code puts on the Bash PATH while the plugin is enabled.
- `scripts/`: optional plugin-specific build steps (`.mts`, run by Node 24's type stripping), e.g. dprint's `hooks.mts`.
- `CLAUDE.md`: developer notes, never inside `plugin/` (a plugin-root CLAUDE.md is not loaded and triggers a validate warning). Notes for one subtree go in `src/**/CLAUDE.md` (Claude Code loads them on demand; the build skips them, they never ship).
- Hand-written plugin content (`SKILL.md`, `hooks/hooks.json`, `agents/*.md`, `README.md`) lives directly in `plugin/` and is edited there.

## Workspace-wide lint and test config

One config for all packages, at the repo root; no per-plugin lint or vitest config. Formatting stays with dprint (`dprint.json`); everything else is oxc.

- Lint + type check: root `.oxlintrc.json` (oxlint, type-aware) with the solution `tsconfig.json` (`tsconfig.src.json` strict, `tsconfig.tests.json` relaxed for plugin `*/tests/`); `pnpm lint` is the type check. Details: `.claude/rules/lint-config.md`.
- Build: the shared `development/scripts/build-plugin.mts` builds the plugin in the cwd (layout check, oxc-transform type stripping, oxc-minify, `plugin.json` generated from `package.json` by `plugin-manifest.mts`); a plugin's `build` script may run its own steps first.
- `vitest.config.mts` at the root is the one vitest config; details in `.claude/rules/lint-config.md`.
- Claude Code hook `.claude/hooks/oxlint-edited.sh` (project `.claude/settings.json`, PostToolUse `Write|Edit`, `asyncRewake`): runs `pnpm exec oxlint --deny-warnings` with the root config on each edited `.ts`/`.mts` in the background and wakes Claude with any findings.
- Tooling (`oxlint`, `oxlint-tsgolint`, `oxc-transform`, `oxc-minify`, `vitest`, `@types/node`) is a root devDependency only.

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

- `.gitattributes` marks build output and the lockfile `linguist-generated` (collapsed in PRs); `*/plugin/**/*.mjs` is also `-diff -merge`: resolve conflicts there by rebuilding.
- `.mjs` (and `.js`) is build output only; every hand-written module is `.mts` (Node 24 and vitest strip the types; `src/` is compiled by `pnpm build`).
- Never edit `*/plugin/**/*.mjs` or `*/plugin/.claude-plugin/plugin.json` — change `src/` or `<name>/package.json` and run `pnpm build`. `.claude/settings.json` denies these writes.
- Version bump = edit `version` in `<name>/package.json`, then `pnpm build`. Any change under `<name>/` merged to `main` needs a bump to a version higher than on `main` that is not yet tagged `<name>-<version>` here or in kwitsch/claude-plugins.
- New plugin: use the `scaffold-plugin` skill (`.claude/skills/scaffold-plugin/`). Never hand-copy the layout.
- Runtime code in `plugin/` must be zero-dependency Node (`node:` builtins only); `node_modules` is not shipped.
- Commit messages: no `Co-Authored-By:` trailer, no "Generated with" footer.

## CI

PR, Dependabot, Release and Sync workflows: `.claude/rules/ci.md` (loads with `.github/**`). Job `changed-plugins` is the required status check on `main` — do not rename it.
