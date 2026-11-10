---
id: F20
title: One readdirSync per directory in the upward config walks (9P)
status: done
priority: low
area: universal-lint/src/hooks/lint-file.mts (walkUpToCwd, walkToRoot, resolveOxlintConfig, hasProjectMarkdownlintConfig, hasStylelintConfig, resolveCheckstyleConfig, hasProjectYamllintConfig, resolveTsconfig, resolveCargoManifest)
---

# F20 One readdirSync per directory in the upward config walks

## Status

Shipped in 0.15.17. Every upward config walk (oxlint/eslint, eslint-root, markdownlint, yamllint, stylelint incl. the `package.json` probe, checkstyle, tsconfig, Cargo, `localBin`, `runNpx`) probes through `configExists(dir, name)`. When the walked path lexically starts with `/mnt/` (never realpath) one `readdirSync` per directory and process is memoized as a set of upper-cased names; a name whose first path segment is not listed is skipped, every listed hit is confirmed by `existsSync`, and a `readdirSync` error stores `null` (plain `existsSync` for that directory). Elsewhere `configExists` is today's `existsSync`. A symlinked path from ext4 into `/mnt` keeps today's probes (correct, slow); `/mnt/wsl*`, `/mnt` data disks and non-WSL `/mnt` mounts take the readdir branch (correct, cost differs). The memo lives per process and is never invalidated; the skill driver's batch sees one listing per directory. Nothing the process does writes into the project tree (npx installs into the npm cache; tsc buildinfo and the MD013 config go to `CLAUDE_PLUGIN_DATA`/tmpdir); an external install mid-batch makes at most one lint fall through to the npx-cached bin, the next event sees the bin.

Re-measured 2026-11-10 (WSL2 6.18.33.2, node v24.22.2), microbench over the same ancestor chain: 9P, 9 levels (`/mnt/c/repos/blocky-dev/.git/logs/refs/remotes`), oxlint + eslint-root + markdownlint walks 433-466 ms with `existsSync`, 19.2-19.8 ms with the memoized prefilter, identical hits; ext4, 11 levels: 1.2-4.2 ms vs 0.3-0.8 ms (sub-ms either way). About 2.4 ms per 9P miss today, not the 7-8 ms quoted in Evidence (the ratio reproduced, the absolute numbers did not). `readdirSync` on ext4: `/home/kwitsch` 0.03 ms, `/tmp` (24,130 entries) 16 ms; huge Windows dir (System32) 20.3 ms of probes vs 19.3 ms readdir. Shipped build: `resolveOxlintConfig(deep, root)` + `resolveOxlintConfig(deep, "/")` + `hasProjectMarkdownlintConfig(deep)` median of 5 fresh processes 20.8 ms (base 0.15.16 475.7 ms); identity run over 45 directories of /mnt/c/repos/blocky-dev (`.git` and `node_modules` pruned, batches of 50 per fresh process, resolvers in the hook's order): 0 differences; `scripts/perf.mts 5` on ext4 unchanged within noise.

Gate decision: only `/mnt/` paths take the readdir branch. ext4 gains nothing measurable and an ungated memo would cost about 16 ms per hook under a huge ancestor such as `/tmp`, where every test and perf fixture lives. Tests force the branch on ext4 through `configExists`'s optional `prefilter` argument.

Not taken: the approach below (exact-name set, empty set on readdir error, membership as existence) changes results: 9P is case-insensitive (`existsSync` finds `ESLint.config.js` for `eslint.config.js`, an exact set misses it), a dangling symlink is listed but does not exist (it would select a broken `.oxlintrc.json`), and an x-without-r directory makes `readdirSync` throw while `existsSync` of a child succeeds (an empty set is a false negative). Hence prefilter plus `existsSync` confirm, upper-case folding (NTFS upcase direction) and `null` on error.

## Problem

`resolveOxlintConfig` checks 15 names per directory, `hasProjectMarkdownlintConfig` 10 names per directory up to `/`, checkstyle 3, each with `existsSync`. On 9P every check is a round trip of several ms, so a deep file in a /mnt/c repo pays up to a second before any linter starts. On ext4 the cost is negligible.

## Evidence

9P, depth 9-10 (N=5): resolveOxlintConfig 919-1119 ms, hasProjectMarkdownlintConfig 531-646, resolveCheckstyleConfig 146-179, resolveTsconfig 57-63, resolveCargoManifest 48-59, hasProjectYamllintConfig 21. One 9P dir: 15 existsSync 109-111 ms vs one readdirSync 8.4-8.9 ms; readdir-based oxlint walk 73-81 ms. /mnt/c cloud-init markdown walk 65-67 ms vs 13 ms. ext4: every walk under 0.6 ms (readdir can be slower there in huge dirs: 10.9 ms in a big /tmp).

## Code locations

The `walkUpToCwd`/`walkToRoot` callbacks in `resolveOxlintConfig` (`[...OXLINT_CONFIG_FILENAMES, ...ESLINT_CONFIG_FILENAMES]` existsSync), `hasProjectMarkdownlintConfig` (`MARKDOWNLINT_CONFIG_FILENAMES.some(existsSync)`), `hasStylelintConfig` (`STYLELINT_CONFIG_FILENAMES` plus the `package.json` `stylelint` key, F07), `resolveCheckstyleConfig`, `hasProjectYamllintConfig`.

## Approach

Per-process memo `dirEntries(dir): Set<string>` (one `readdirSync`, empty set on error); test candidate names in their existing precedence order. Keep `existsSync` for nested candidates (`config/checkstyle/checkstyle.xml`). Optionally only for paths under `/mnt/` (ext4 big dirs favour existsSync). Low value: markdown on /mnt/c is dominated by npx.

## Verification

registry.test.mts resolver tests unchanged (oxlint-wins-same-dir tie, unreadable-tsconfig-keeps-climbing). Walk timing on a 9P repo: oxlint and markdownlint walks ≤ about 80 ms.

## Constraints

Walk bounds unchanged (walkUpToCwd to cwd, walkToRoot to `/`, yamllint to `$HOME`; line-length-guard.md). Identical results. Version bump.

## Related

F03/F07 (add walks), F12 (realpath memo, same idea), dprint F27.
