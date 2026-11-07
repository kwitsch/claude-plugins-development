---
id: F20
title: One readdirSync per directory in the upward config walks (9P)
status: open
priority: low
area: universal-lint/src/hooks/lint-file.mts (walkUpToCwd, walkToRoot, resolveOxlintConfig, hasProjectMarkdownlintConfig, resolveCheckstyleConfig, hasProjectYamllintConfig, resolveTsconfig, resolveCargoManifest)
---

# F20 One readdirSync per directory in the upward config walks

## Status

Open. Merges static config-walk finding (adjusted: medium → low; 0 of 4986 session Write/Edit targeted /mnt paths) and bench-other-langs markdownlint-walk finding (confirmed, low).

## Problem

`resolveOxlintConfig` checks 15 names per directory, `hasProjectMarkdownlintConfig` 10 names per directory up to `/`, checkstyle 3, each with `existsSync`. On 9P every check is a round trip of several ms, so a deep file in a /mnt/c repo pays up to a second before any linter starts. On ext4 the cost is negligible.

## Evidence

9P, depth 9-10 (N=5): resolveOxlintConfig 919-1119 ms, hasProjectMarkdownlintConfig 531-646, resolveCheckstyleConfig 146-179, resolveTsconfig 57-63, resolveCargoManifest 48-59, hasProjectYamllintConfig 21. One 9P dir: 15 existsSync 109-111 ms vs one readdirSync 8.4-8.9 ms; readdir-based oxlint walk 73-81 ms. /mnt/c cloud-init markdown walk 65-67 ms vs 13 ms. ext4: every walk under 0.6 ms (readdir can be slower there in huge dirs: 10.9 ms in a big /tmp).

## Code locations

The `walkUpToCwd`/`walkToRoot` callbacks in `resolveOxlintConfig` (`[...OXLINT_CONFIG_FILENAMES, ...ESLINT_CONFIG_FILENAMES]` existsSync), `hasProjectMarkdownlintConfig` (`MARKDOWNLINT_CONFIG_FILENAMES.some(existsSync)`), `resolveCheckstyleConfig`, `hasProjectYamllintConfig`.

## Approach

Per-process memo `dirEntries(dir): Set<string>` (one `readdirSync`, empty set on error); test candidate names in their existing precedence order. Keep `existsSync` for nested candidates (`config/checkstyle/checkstyle.xml`). Optionally only for paths under `/mnt/` (ext4 big dirs favour existsSync). Low value: markdown on /mnt/c is dominated by npx.

## Verification

registry.test.mts resolver tests unchanged (oxlint-wins-same-dir tie, unreadable-tsconfig-keeps-climbing). Walk timing on a 9P repo: oxlint and markdownlint walks ≤ about 80 ms.

## Constraints

Walk bounds unchanged (walkUpToCwd to cwd, walkToRoot to `/`, yamllint to `$HOME`; line-length-guard.md). Identical results. Version bump.

## Related

F03/F07 (add walks), F12 (realpath memo, same idea), dprint F27.
