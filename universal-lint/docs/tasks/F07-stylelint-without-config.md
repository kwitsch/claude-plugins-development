---
id: F07
title: Skip stylelint when the project has no stylelint config
status: done
priority: medium
area: universal-lint/src/hooks/lint-file.mts (lintResolved, hasStylelintConfig, STYLELINT_CONFIG_FILENAMES, walkToRoot), universal-lint/.claude/rules/languages.md
---

# F07 Skip stylelint when the project has no stylelint config

## Status

Done in 0.15.6. Shipped: a no-config gate in `lintResolved` (`noCssConfig`, next to F03's `noJstsConfig`): a `.css`/`.scss` file runs `REGISTRY.css` (stylelint) only when the new non-exported `hasStylelintConfig(fileDir, cwd)` finds a config, so a config-less project pays no PATH probe, no `node_modules/.bin` lookup and no `npx --yes stylelint` (PostToolUse, FileChanged and the skill driver all pass through `lintResolved`). `hasStylelintConfig` walks the existing `walkToRoot` from the file's dir up to `/`, and again from the payload cwd up to `/` (stylelint falls back to searching its cwd, which a symlinked file path can leave off the first walk), for a `STYLELINT_CONFIG_FILENAMES` name or a `package.json` with a non-null top-level `stylelint` key, and when that finds nothing checks whether stylelint's global config dir exists (`$XDG_CONFIG_HOME/stylelint` or `~/.config/stylelint`, `~/Library/Preferences/stylelint`). `classifyExit`, `REGISTRY.css`, `selectLintTool`, `runLintTool`, `localBin`, the npx fallback and `walkToRoot` are unchanged. Tests (`tests/stylelint.test.mts`): the 6 existing stylelint tests got a `.stylelintrc.json`; 10 new: no config anywhere (with a `package.json` carrying only `devDependencies.stylelint`) spawns neither stylelint nor npx, 8 config placements run stylelint on `src/a.css`: `.stylelintrc.json` in cwd, `src/.stylelintrc`, `.stylelintrc.yaml` above cwd, `.config/stylelintrc.json`, `stylelint.config.mjs`, a `package.json` `stylelint` key, an invalid `package.json`, and `~/.config/stylelint/config.json`; and a config in cwd with the file reached through a symlinked dir outside cwd (found only by the cwd walk). Departure from the Approach: the name list also carries cosmiconfig's eight `.config/stylelintrc*` places and stylelint's global config dir (verified in stylelint 18.0.0 / cosmiconfig 10.0.1; the dir counts by its existence, not by the `config*` files stylelint reads in it), and an unreadable or invalid `package.json` counts as a config (fail open). Accepted: names count by existence only (an empty `.stylelintrc`, which stylelint ignores, still costs the run that exits 78), and so does a global config dir without a config file in it; `.cts`/`.mts` names are not stylelint search places and do not count; a cosmiconfig meta config (`.config/config.*` or a `package.json` `cosmiconfig` key adding search places) and the Windows global dir are not checked. Measured with `node universal-lint/scripts/perf.mts 5`, medians in ms, before (0.15.5) -> after (0.15.6), same machine and session: `.css Write (no stylelint config)` real PATH 852 -> 50, no /mnt 771 -> 46. Real stylelint through npx (`.stylelintrc.json` with `property-no-unknown`, `a.css` = `.a{colr:red;}`): with the config exit 2 and the `property-no-unknown` finding in the output; after removing the config exit 0, no output, 50 ms.

## Problem

Without a stylelint config, stylelint exits 78 (`ConfigurationError: No configuration provided`), which `classifyExit` maps to skip. The hook still pays PATH probes, an rtk probe and npx every time: about 1 s per .css/.scss edit for a guaranteed no-op, in the common case of a project without stylelint.

## Evidence

No-config fixture: hook median 988-1035 ms (.css) and 960-994 ms (.scss), exit 0, no output. Trace: npx 818 ms + rtk rewrite 23 ms + accessSync 95 ms, all wasted. Direct cached bin exits 78 in 153 ms; npx stylelint 755 ms. With a config: hook 996 ms exit 2; direct 224 ms, npx 853 ms.

## Code locations

`runChainLint` (selectLintTool → buildArgv → runLintTool, no config gate for css); `classifyExit` case `stylelint`; `REGISTRY.css`; the existing precedents `hasProjectMarkdownlintConfig`, `walkToRoot`.

## Approach

Shipped as a name-and-key pre-check before spawning (`hasStylelintConfig`, gated in `lintResolved` like F03's `noJstsConfig`): walk from the file's directory, then from the payload cwd, to the filesystem root (unbounded, like the markdownlint guard; `walkToRoot`) for stylelint 18.0.0's cosmiconfig search places: `.stylelintrc`, `.stylelintrc.{json,yaml,yml,js,ts,cjs,mjs}`, `.config/stylelintrc`, `.config/stylelintrc.{json,yaml,yml,js,ts,cjs,mjs}`, `stylelint.config.{js,ts,cjs,mjs}`, and a non-null top-level `stylelint` key in a parsed `package.json` (`devDependencies.stylelint` does not count; an unreadable or invalid one counts); when the walk finds nothing, an existing stylelint global config dir (`$XDG_CONFIG_HOME/stylelint` or `~/.config/stylelint`, `~/Library/Preferences/stylelint`) counts. None found → skip silently. Documented in languages.md. The rtk mentions in Problem and Evidence describe 0.14.x: rtk support was removed in 0.15.0, so the waste left in 0.15.5 was the PATH, local-bin or `npx --yes stylelint` run that exits 78 (skip).

## Verification

Test: no config → the stylelint stub records no call; `.stylelintrc.json` (also in a parent dir, and a package.json key) → called. Bench: no-config .css about 45 ms with no npx in the trace; the config fixture still reports `property-no-unknown`.

## Constraints

The name list must track stylelint's cosmiconfig search places; a missed name would silently skip a configured project, so prefer a superset. Fail open. Version bump.

## Related

F03 (same pattern for eslint), F09 (npx cost), F20 (walk cost on 9P).
