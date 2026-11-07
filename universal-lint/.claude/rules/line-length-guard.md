---
paths:
  - "src/hooks/**"
  - "tests/{yaml,markdown,registry}.test.mts"
---

# YAML/Markdown line-length guard (do not "fix" without reading this)

- `yamllint` (`line-length`, `error` level at 80 — NOT `warning`, despite no `--strict`) and both markdownlint tools (`MD013`, `error` at 80) ship a max-line-length rule in their bundled defaults. Left alone, every YAML/Markdown file without project linter config would get noise the project never asked for.
- `buildArgv` therefore injects a flag that disables **only that one rule**, and **only** when no project-level config for that tool exists — a project's own `.yamllint`/markdownlint config (enabled, disabled, custom max) always wins.
- **yamllint:** `hasProjectYamllintConfig(cwd)` ports yamllint's own `find_project_config_filepath` (`yamllint/cli.py`): starts at the spawn `cwd` (the project root, regardless of the linted file — yamllint has no per-file config resolution) and walks upward until the walked dir IS the user's home (checked too) or the filesystem root.
  - With nothing found it passes `-d "{extends: default, rules: {line-length: disable}}"` — single-line flow-style YAML, passed as one argv element. `-d` overrides project **and** user-global config search entirely, hence the guard.
- **markdownlint-cli2 / markdownlint:** `hasProjectMarkdownlintConfig(fileDir)` walks from the edited file's directory to the filesystem root looking for the filenames markdownlint-cli2's `--help` lists under "Configuration via:" (verified: cli2 does **not** read a `markdownlint-cli2` key from `package.json`).
  - With nothing found, `--config` points both tools at a constant config disabling only MD013 (`{"MD013": false}`, the `MARKDOWNLINT_NO_LINE_LENGTH_CONFIG` constant in `src/hooks/lint-file.mts`).
  - **Changed in the port:** in kwitsch/claude-plugins this was a loose `hooks/markdownlint-no-line-length.json` next to the script. `plugin/` may only ship the layout allowlist (no stray `.json`), so the content is a TypeScript constant and `markdownlintNoLineLengthConfigPath()` writes it to `${CLAUDE_PLUGIN_DATA}/markdownlint-no-line-length.json` (OS temp dir when unset, never the project tree) the first time it is needed: only when absent or different, atomically (temp file + `renameSync`). markdownlint takes only a file path for `--config`, which is why it must exist on disk.
  - A write failure throws; `lintFileHandler`'s catch turns it into the usual silent no-op (a broken data dir never surfaces MD013 noise).
- **`--no-globs` (markdownlint-cli2 only, F06, 0.15.5):** not a line-length rule but the same argv: `REGISTRY.markdown.chain[0]` carries the static arg `--no-globs`, placed first, before any `--config` and the file, because cli2 otherwise merges the top-level `globs` of a project `.markdownlint-cli2.*` config with the file argument and lints every matching .md of the repo on each edit; the project's rules, `ignores` and `config` still apply. Classic markdownlint has no such option and gets no flag; cli2 < 0.12.0 reads the flag as a glob matching nothing, so the file still lints (harmless, no version gate).
- **Both walkers are deliberately unbounded past `cwd`** (unlike `resolveCheckstyleConfig`/`resolveTsconfig`): yamllint's own search climbs to `$HOME`/root regardless, and cli2's per-file resolution walks past its base directory into its ancestors (`enumerateParents`). Bounding at `cwd` would misdetect "absent" for a config above the project root (workspace/monorepo) — the opposite of this guard's purpose.
- Neither tool reads `.editorconfig`, so there is no second "configured another way" check (unlike the `printWidth` guard in `universal-format`).
