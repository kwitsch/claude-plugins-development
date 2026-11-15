---
paths:
  - "src/hooks/**"
  - "tests/stylelint.test.ts"
---

# CSS/SCSS: stylelint

## `.scss` limitation (accepted)

- `stylelint` runs with `args: []`, so no `customSyntax` and its default CSS-only parser (v14 dropped by-extension syntax inferral). SCSS needs e.g. `postcss-scss` (usually via `stylelint-config-standard-scss`), which this plugin can't bundle without a dependency the target may lack.
- Without an SCSS-aware `customSyntax`, ordinary SCSS (`//` comments, `$variables`, `&`-nesting, `#{...}`) can surface as bogus `CssSyntaxError` "issues". `.css` is unaffected.

## CSS/SCSS: no stylelint config = no lint (F07, 0.15.6)

- `.css`/`.scss` run `REGISTRY.css` (stylelint) only when `hasStylelintConfig` finds a config; otherwise `lintResolved` runs no chain lint (no PATH probe, no `node_modules/.bin` lookup, no `npx --yes stylelint`): stylelint without a config only exits 78 (skip) after about 1 s.
- Search places = stylelint 18.0.0's (cosmiconfig 10 defaults, verified in its source): `STYLELINT_CONFIG_FILENAMES` (`.stylelintrc`, `.stylelintrc.{json,yaml,yml,js,ts,cjs,mjs}`, `.config/stylelintrc`, `.config/stylelintrc.{json,yaml,yml,js,ts,cjs,mjs}`, `stylelint.config.{js,ts,cjs,mjs}`) or a `package.json` with a non-null top-level `stylelint` key, from the file's dir up to `/`, and again from the payload cwd up to `/` (stylelint falls back to searching its cwd, which a symlinked file path can leave off the first walk) (`walkToRoot`; stylelint's own walk stops at `$HOME`, so this is a superset), else an existing stylelint global config dir (`$XDG_CONFIG_HOME/stylelint` or `~/.config/stylelint`, `~/Library/Preferences/stylelint`; stylelint reads `config`/`config.{json,yaml,yml,js,ts,cjs,mjs}` in it, the hook only checks that the directory exists). Update the list when stylelint's search places change: a missed name silently skips a configured project.
- `package.json` is parsed (`devDependencies.stylelint` does not count); an unreadable or invalid one counts as a config (fail open). Unlike `package.json#eslintConfig` (F03), stylelint honours its key.
- Accepted: names count by existence only (an empty `.stylelintrc`, which stylelint ignores, still costs the run that exits 78), and so does a global config dir without a config file in it; `.cts`/`.mts` names are not stylelint search places and do not count; a cosmiconfig meta config (`.config/config.*` or a `package.json` `cosmiconfig` key adding search places) and the Windows global dir are not checked.
