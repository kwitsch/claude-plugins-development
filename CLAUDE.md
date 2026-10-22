# CLAUDE.md

Development repository for Claude Code plugins. One top-level directory per plugin, named after the plugin.

## Layout per plugin (`<name>/`)

| Path            | Purpose                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `plugin.json`   | Source of truth for the plugin manifest (`name`, `version`, `description`, `author`, …). Edit here only. |
| `plugin/`       | The finished, installable plugin. `plugin/.claude-plugin/plugin.json` and every `plugin/**/*.mjs` are **build output** — never edit by hand. |
| `src/`          | TypeScript sources (`*.mts`). `pnpm build` compiles them to `plugin/**/*.mjs` (same relative path).     |
| `tests/`        | Integration tests (`*.test.mjs`, `node:test`), run against `plugin/`.                                    |
| `scripts/`      | Build scripts (`build.mjs`).                                                                             |
| `package.json`  | Per-plugin pnpm scripts: `build`, `test`, `typecheck`.                                                   |
| `CLAUDE.md`     | Developer notes for the plugin. Not inside `plugin/` (a plugin-root CLAUDE.md is not loaded and triggers a validate warning). |

Hand-written plugin content that is not generated (`SKILL.md`, `hooks/hooks.json`, `agents/*.md`, `README.md`) lives directly in `plugin/` and is edited there.

## Commands

```bash
pnpm install                    # once, at repo root (workspace)
pnpm -r build                   # build every plugin
pnpm -r test                    # run every plugin's tests
pnpm --filter <name> build      # one plugin
claude plugin validate <name>/plugin
```

## Rules

- Never edit `*/plugin/**/*.mjs` or `*/plugin/.claude-plugin/plugin.json` — change `src/` or `<name>/plugin.json` and run `pnpm build`. `.claude/settings.json` denies these writes.
- Version bump = edit `version` in both `<name>/plugin.json` and `<name>/package.json` (must match; `pnpm build` and CI fail otherwise), then `pnpm build`.
- New plugin: use the `scaffold-plugin` skill (`.claude/skills/scaffold-plugin/`). Never hand-copy the layout.
- Runtime code in `plugin/` must be zero-dependency Node (`node:` builtins only); `node_modules` is not shipped.
- Commit messages: no `Co-Authored-By:` trailer, no "Generated with" footer.

## CI

PR (`.github/workflows/pr.yml`): On every PR, for each plugin dir with changes: `plugin.json` and `package.json` versions must match, then `pnpm --filter <name> build` and `test` must pass.

On tag push `<name>-<version>` (`.github/workflows/sync.yml`): build+test that plugin, then open a PR in kwitsch/claude-plugins replacing `plugins/<name>` with `<name>/plugin/`. Needs secret `RELEASE_TOKEN`.
