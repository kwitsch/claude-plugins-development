# CLAUDE.md

Development repository for Claude Code plugins. One top-level directory per plugin, named after the plugin.

`development/` holds shared developer tooling, no plugin: see `development/CLAUDE.md`.

## Knowledge

- Before researching how Claude Code, a tool or an external API behaves, or re-deciding something, read `development/wiki/index.md`: it lists what earlier sessions verified, decided and tripped over, in the wiki and in every rule and plugin document.
- What a task establishes is written into the repository in the same change, each fact once: a constraint for certain files into a rule with `paths:`, knowledge about one plugin into that plugin's `CLAUDE.md`, rules or its wiki section `development/wiki/plugins/<plugin>/`, everything else into the wiki with the `wiki` skill (`.claude/skills/wiki/`).
- Memory files (`CLAUDE.md`, rules) load into every agent that touches a matching file, so they hold constraints only, one or two lines each. Reasons, measurements, residuals, rejected alternatives and how something was verified go to a page that is not loaded by itself (the wiki: `development/wiki/plugins/<plugin>/design/` for one plugin, the other wiki folders for what spans plugins), linked from the constraint as `[topic](relative/path.md)`; never with an `@path` import, which loads the page anyway. Keep `paths:` as narrow as the constraint's reach.
- The machine-local memory (graphmind, auto-memory) holds personal preferences and one-line pointers only, never the only copy of a fact about this repository.

## Layout per plugin (`<name>/`)

`plugin/` (installable plugin, git-ignored build output, never committed: `pnpm build` empties it and regenerates it from `src/`, `assets/`, the templates and `package.json`), `src/**/*.ts` (built to `plugin/`: the entries the templates and `tsdown.config.ts` name, each one self-contained file), `tests/*.test.ts` (vitest, against `src/`; process tests spawn `plugin/`), `claude-tests/*.test.ts` (mods: `claude plugin test` on the built plugin, `pnpm --filter <name> test:plugin`), plus:

- `package.json`: the only manifest source (`name`, `version`, `description`, `author`, `keywords`; plugin-only fields such as `userConfig` under `claudePlugin`, which is required, `{}` at least, and marks the package as a plugin) and the pnpm scripts `build` (`tsdown`), `test`, optional `lint` and, for a mod, `test:plugin`. Edit here only.
- `tsdown.config.ts`: `export default await pluginConfig({ ..., manifest: claudePlugin })` from the published preset `@kwitsch/tsdown-preset-claude-code` (`.claude/rules/tsdown-build.md`); `hooks.template.json` / `mcp.template.json`: the hooks and MCP servers, commands as relative `.ts` paths.
- `src/bin/`: scripts used from several places (skills, hooks, MCP), listed under `scripts.bin`, built to `plugin/bin/*.mjs`, which Claude Code puts on the Bash PATH while the plugin is enabled.
- `scripts/`: optional plugin-specific build steps and dev-only tools (`.ts`, run by Node 24's type stripping, never shipped), e.g. universal-lint's `perf.ts` (hook cost measurement).
- `CLAUDE.md`: developer notes, never inside `plugin/` (a plugin-root CLAUDE.md is not loaded and triggers a validate warning). Notes for single parts go in `<name>/.claude/rules/*.md` with `paths:` relative to `<name>/` (loaded when Claude works on matching files; keep each under 40,000 characters, the on-demand load limit).
- Hand-written plugin content (`SKILL.md`, `agents/*.md`, `README.md`, skill data) lives in `assets/` at its `plugin/` path and is edited there; the build copies it.

## Workspace-wide lint and test config

One config for all packages, at the repo root; no per-plugin lint or vitest config. Formatting stays with dprint (`dprint.json`); everything else is oxc.

- Lint + type check: root `.oxlintrc.json` (oxlint, type-aware) with the solution `tsconfig.json` (`tsconfig.src.json` strict, `tsconfig.tests.json` relaxed for plugin `*/tests/` and `*/claude-tests/`); `pnpm lint` is the type check. Details: `.claude/rules/lint-config.md`.
- Build: `tsdown` with the published preset `@kwitsch/tsdown-preset-claude-code` (Node 26) builds each entry into one self-contained file, generates `plugin.json` from `package.json` (plus `claudePlugin`, passed as `manifest`), `hooks/hooks.json` and `.mcp.json` from the templates, and copies `assets/`; a plugin's `build` script may run its own steps before `tsdown`. `pluginBuild.assets` lists files the CI layout check (`development/scripts/check-plugin-layout.ts`) allows in `plugin/` beside its allowlist, by exact path (universal-format's wasm files). Details: `.claude/rules/tsdown-build.md`.
- `vitest.config.mts` at the root is the one vitest config. Tooling is root devDependencies only, except the build preset and `tsdown`, pinned in each plugin. Details: `.claude/rules/lint-config.md`.

## Commands

```bash
pnpm install                 # once, at repo root (workspace)
pnpm -r build                # build every plugin
pnpm -r test                 # run every plugin's tests; needs a built plugin/ (pnpm -r build) in a fresh clone or worktree
pnpm lint                    # oxlint (lint + type check) over the workspace, then plugin-specific lint scripts
pnpm --filter <name> build   # one plugin
pnpm --filter <name> test:plugin   # a mod's integration tests (needs claude)
claude plugin validate <name>/plugin
```

## Rules

- `.mjs` and `plugin/hooks/*.js` are build output only; every hand-written module is `.ts` (Node 24 and vitest strip the types; `src/` is built by `pnpm build`).
- Never edit anything under `*/plugin/` — change `src/`, `assets/`, the templates, `<name>/tsdown.config.ts` or `<name>/package.json` and run `pnpm build` (the build empties `plugin/`); it is git-ignored, never commit it. `.claude/settings.json` denies writes to `*/plugin/**/*.mjs`, `*/plugin/hooks/*.js` and `*/plugin/.claude-plugin/plugin.json`.
- Version bump = edit `version` in `<name>/package.json`. A PR into `main` that changes a plugin's build inputs (the list is in `.claude/rules/ci.md`) must bump it higher than on `main` and not yet tagged `<name>-<version>` here or in kwitsch/claude-plugins (Dependabot excepted); a plugin is released only when a push changes both its build inputs and its version (`.github/scripts/ships.sh`). Tests, scripts, `CLAUDE.md`, `.claude/` need no bump and are not released.
- New plugin: use the `scaffold-plugin` skill (`.claude/skills/scaffold-plugin/`). Never hand-copy the layout.
- Runtime code in `plugin/` must be zero-dependency Node (`node:` builtins only); `node_modules` is not shipped. One exception: a vendored third-party bundle `plugin/**/vendor/*.mjs` built by the preset's `bundles` option (universal-format's prettier), see `.claude/rules/plugin-build-output.md`.
- MCP servers are dual-era (2025-11-25 `initialize` and 2026-07-28 `server/discover`, tasks only when asked): follow `.claude/rules/mcp-dual-era.md`, model `dprint/src/mcp/server.ts`.
- Commit messages: no `Co-Authored-By:` trailer, no "Generated with" footer.

## CI

PR, Dependabot, Release and Sync workflows: `.claude/rules/ci.md` (loads with `.github/**`). Job `changed-plugins` is the required status check on `main` — do not rename it.
