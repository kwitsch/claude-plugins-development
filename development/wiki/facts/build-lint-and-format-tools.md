# oxlint, oxc, eslint and the dprint CLI

Behaviour of the tools this repository builds, lints and formats with, where it differs from what one would assume.

The workspace setup itself: [lint-config.md](../../../.claude/rules/lint-config.md). The linters universal-lint runs for users are described in that plugin's `lang-*.md` rules.

## oxlint and oxc

- `pnpm exec oxlint` prints nothing on a clean run (exit 0). To confirm a file is covered, plant a type error (2026-11).
- oxlint 1.91 ignores a nested `oxlint.config.ts` without `-c`, and rejects `options.typeAware` in any config that is not the root config (`only supported in the root config`). A checkout nested inside another checkout, such as a worktree under `.claude/worktrees/`, counts as nested when oxlint is started from the outer root: lint from inside the worktree or pass `-c` (1.91.0).
- oxlint 1.91 finds `tsgolint` only on `PATH` or in the spawn cwd's `node_modules/.bin`, not next to its own install. Spawned from a cwd without `node_modules` it exits 1 with `Failed to find tsgolint executable` (1.91, pnpm shim).
- `oxc-minify` with `codegen.removeWhitespace: true` rewrites every string literal as a template literal. Code that another program reads statically for string literals must be built without it (0.157).

## eslint

- eslint 10 looks up its flat config from the linted file's directory; eslint 9 and older resolve it from the spawn cwd (10.14, probed 2026-11-07).

## dprint CLI (0.64.3)

- `dprint file-paths` prints physical, symlink-resolved absolute paths even when run from a symlinked cwd.
- File-extension matching of `dprint file-paths` and `dprint fmt` is case-sensitive: `Up.TS` is skipped. `dprint lsp` did format such a file, so the two routes disagree (checked 2026-11-15 through the dprint plugin's language-server client).
- The CLI and the language server strip a UTF-8 BOM when formatting (checked 2026-11-15); a config file with a BOM is rejected.
- `dprint lsp` honours the config's `excludes`: no edits for excluded files (checked 2026-11-15).
- `DPRINT_INSTALL` names the installer's target directory.
- The repository's `dprint.json` orders `package.json` keys; a `pnpm add` afterwards appends keys in another order. CI does not run `dprint check`, so run `dprint fmt <name>/package.json` after adding a dependency.

## claude-code-hook-types and the tsdown preset

- `claude-code-hook-types` writes `export interface McpToolHookInputs` keyed by server then tool, with literal types for fixed template values and `string` for every `${…}` placeholder, keys sorted, every key required, and a union when two hooks call one tool with different input shapes (binary 0.1.1).
- `claude-code-hook-types` does no placeholder or event validation: a `${…}` that does not exist for its event passes (binary 0.1.1).
- The template's `hookTypes` path must match `/\.m?ts$/` and stay inside the template's directory; `--check` exits 1 with `hook-types-stale` when the file is stale or missing, a malformed `mcp_tool` hook (no `server`/`tool`/`input`) is `hook-input-invalid` and nothing is written (binary 0.1.1).
- `@kwitsch/tsdown-preset-claude-code` / core 0.2.0 pass unknown top-level hooks-template keys through into the rendered `hooks.json` (binary 0.2.0).
- Preset 0.4.1 strips `hookTypes` from `hooks.json` and emits the error `hook-types-stale` when the file is missing or differs, CRLF normalized (binary 0.4.1).
