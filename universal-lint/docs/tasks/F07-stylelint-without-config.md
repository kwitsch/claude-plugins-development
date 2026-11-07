---
id: F07
title: Skip stylelint when the project has no stylelint config
status: open
priority: medium
area: universal-lint/src/hooks/lint-file.mts (REGISTRY.css, runChainLint, classifyExit 'stylelint', walkToRoot)
---

# F07 Skip stylelint when the project has no stylelint config

## Status

Open. bench-other-langs finding (adjusted: high → medium; 0 css/scss edits in 2915 transcripts, no stylelint config in ~/repos).

## Problem

Without a stylelint config, stylelint exits 78 (`ConfigurationError: No configuration provided`), which `classifyExit` maps to skip. The hook still pays PATH probes, an rtk probe and npx every time: about 1 s per .css/.scss edit for a guaranteed no-op, in the common case of a project without stylelint.

## Evidence

No-config fixture: hook median 988-1035 ms (.css) and 960-994 ms (.scss), exit 0, no output. Trace: npx 818 ms + rtk rewrite 23 ms + accessSync 95 ms, all wasted. Direct cached bin exits 78 in 153 ms; npx stylelint 755 ms. With a config: hook 996 ms exit 2; direct 224 ms, npx 853 ms.

## Code locations

`runChainLint` (selectLintTool → buildArgv → runLintTool, no config gate for css); `classifyExit` case `stylelint`; `REGISTRY.css`; the existing precedents `hasProjectMarkdownlintConfig`, `walkToRoot`.

## Approach

Add a name-only pre-check before spawning: walk from the file's directory to the filesystem root (unbounded, like the markdownlint guard) for cosmiconfig's stylelint search places: `.stylelintrc`, `.stylelintrc.{json,yaml,yml,js,cjs,mjs,ts}`, `stylelint.config.{js,cjs,mjs,ts}`, and a `stylelint` key in `package.json`. None found → skip silently. Document it in languages.md.

## Verification

Test: no config → the stylelint stub records no call; `.stylelintrc.json` (also in a parent dir, and a package.json key) → called. Bench: no-config .css about 45 ms with no npx in the trace; the config fixture still reports `property-no-unknown`.

## Constraints

The name list must track stylelint's cosmiconfig search places; a missed name would silently skip a configured project, so prefer a superset. Fail open. Version bump.

## Related

F03 (same pattern for eslint), F09 (npx cost), F20 (walk cost on 9P).
