# CLAUDE.md

Development repository for Claude Code plugins. One top-level directory per plugin, named after the plugin.

`development/` holds shared developer tooling, no plugin: `development/scripts/` the build scripts every plugin uses (`build-plugin.mts`, `check-plugin-layout.mts`, `plugin-manifest.mts`); `development/vitest/claude-engine/` the workspace package `claude-engine-vitest` (no `plugin/`), the shared vitest stand-in for Claude Code's mod test kit (`claude-code/testing`), a `workspace:*` devDependency of plugins with function-hooks modules. Not versioned or released.

## Layout per plugin (`<name>/`)

| Path           | Purpose                                                                                                                                                                                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin/`      | The finished, installable plugin. `plugin/.claude-plugin/plugin.json` and every `plugin/**/*.mjs` are **build output** — never edit by hand.                                                                                                                                                             |
| `src/`         | TypeScript sources (`*.mts`). `pnpm build` compiles them to `plugin/**/*.mjs` (same relative path).                                                                                                                                                                                                      |
| `src/bin/`     | Scripts used from several places (skills, hooks, MCP). Built to `plugin/bin/*.mjs`, which Claude Code puts on the Bash PATH while the plugin is enabled.                                                                                                                                                 |
| `tests/`       | Integration tests (`*.test.mts`, vitest), run against `plugin/`.                                                                                                                                                                                                                                         |
| `scripts/`     | Optional plugin-specific build steps (`.mts`, run directly by Node 24's type stripping), e.g. dprint's `hooks.mts`.                                                                                                                                                                                      |
| `package.json` | Plugin manifest source (`name`, `version`, `description`, `author`, `keywords`; plugin-only fields such as `userConfig` under `claudePlugin`) and per-plugin pnpm scripts: `build` (`node ../development/scripts/build-plugin.mts`), `test`, optional `lint` for plugin-specific checks. Edit here only. |
| `CLAUDE.md`    | Developer notes for the plugin. Not inside `plugin/` (a plugin-root CLAUDE.md is not loaded and triggers a validate warning).                                                                                                                                                                            |

Hand-written plugin content that is not generated (`SKILL.md`, `hooks/hooks.json`, `agents/*.md`, `README.md`) lives directly in `plugin/` and is edited there.

## Workspace-wide lint and test config

One config for all packages, at the repo root; no per-plugin lint or vitest config. Formatting stays with dprint (`dprint.json`); everything else is oxc.

- `.oxlintrc.json`: oxlint, TypeScript-first, for every hand-written `.mts` (`plugin/` is ignored): the `correctness` category plus the former ESLint presets' extra rules. One run at the root (`pnpm exec oxlint`, part of `pnpm lint`) covers the whole workspace. `options.typeAware` + `options.typeCheck` run tsgolint (TypeScript 7) with the root `tsconfig.json`, a solution file referencing `tsconfig.src.json` (`*/src/`, `*/scripts/` (incl. `development/scripts/`), `development/vitest/claude-engine/`, `vitest.config.mts`: fully strict) and `tsconfig.tests.json` (`*/tests/`: no `noImplicitAny`, `allowJs`; `.oxlintrc.json` also turns off `no-unsafe-*` and `require-await` there), both extending `tsconfig.base.json` (type check only, `noEmit`; no per-plugin tsconfig; `@types/node` is a root devDependency), so `pnpm lint` is also the type check (no `tsc`, no `typecheck` script). Doc comments are not linted; `.claude/rules/tsdoc.md` covers them.
- Build: the shared `development/scripts/build-plugin.mts` builds the plugin in the cwd (layout check, oxc-transform type stripping, oxc-minify, `plugin.json` generated from `package.json` by `plugin-manifest.mts`); a plugin's `build` script may run its own steps first.
- `vitest.config.mts`: every package's `test` script is `vitest run --config "$(git rev-parse --show-toplevel)/vitest.config.mts"` (vitest does not search parent dirs for a config; the git root keeps the path the same at any depth).
- Tooling (`oxlint`, `oxlint-tsgolint`, `oxc-transform`, `oxc-minify`, `vitest`, `@types/node`) is a root devDependency only.

## Commands

```bash
pnpm install                 # once, at repo root (workspace)
pnpm -r build                # build every plugin
pnpm -r test                 # run every plugin's tests
pnpm lint                    # oxlint (lint + type check) over the workspace, then plugin-specific lint scripts
pnpm --filter < name > build # one plugin
claude plugin validate < name > /plugin
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

PR (`.github/workflows/pr.yml`): On every PR, for each plugin dir with changes (a plugin dir is one with a committed `plugin/.claude-plugin/plugin.json`): for PRs into `main` the `package.json` version must be higher than on `main` and tag `<name>-<version>` must not exist here or in kwitsch/claude-plugins; then one workspace-wide `pnpm exec oxlint` must pass, and per tested plugin `pnpm --filter <name> lint` (only if the plugin defines a `lint` script), `build` and `test` must pass and the committed `<name>/plugin/` must equal the fresh build. The tested set is pnpm's graph `...[origin/<base>]`: changed workspace packages plus their dependents, so a `development/vitest/claude-engine/` change runs its tests and re-tests every plugin using it (no version bump for those); a change in the root package itself (shared config, `development/scripts/`, lockfile, `.github/`, docs) re-checks every package. `check-plugin-fresh.sh` also runs `development/scripts/check-plugin-layout.mts` (allowlist of what `plugin/` may ship; `development/scripts/build-plugin.mts` also runs it as step 0). Job `changed-plugins` is the required status check on `main` (branch protection in GitHub settings) — do not rename it.

Dependabot (`.github/dependabot.yml`, `.github/workflows/dependabot-automerge.yml`): weekly npm (pnpm workspace) and github-actions updates. Patch and pin/digest updates get auto-merge (squash) once `changed-plugins` is green; minor/major need a manual merge. Dependabot PRs skip the version-bump check for a plugin as long as its `plugin/` is unchanged (the freshness check still catches a changed build).

Release (`.github/workflows/release.yml`): On push to `main`, tag the pushed commit `<name>-<version>` for each plugin dir the push changed, then run Sync for every changed plugin's tag (a tag that already exists is not re-created but is still synced, which makes re-runs idempotent).

Sync (`.github/workflows/sync.yml`): On tag push `<name>-<version>` or when called by Release: the tag's commit must be an ancestor of `origin/main`; build+test that plugin and require the committed `<name>/plugin/` to equal the fresh build; then open a PR in kwitsch/claude-plugins replacing `plugins/<name>` with `<name>/plugin/`; merging that PR tags `<name>-<version>` there (its `tag-on-version-bump.yml`). Needs secret `RELEASE_TOKEN`.
