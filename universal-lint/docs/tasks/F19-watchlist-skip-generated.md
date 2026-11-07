---
id: F19
title: Keep linguist-generated files out of watchPaths
status: open
priority: low
area: universal-lint/src/hooks/lint-file.mts (watchList, isExcludedPath), universal-lint/.claude/rules/hook-design.md
---

# F19 Keep linguist-generated files out of watchPaths

## Status

Open. Merges watch-filechanged finding (adjusted: medium → low) and real-sessions finding (confirmed, low). Adds a new exclusion policy next to the deliberately narrow `isExcludedPath`: needs a user decision.

## Problem

Tracked build output and codegen are watched. When a build rewrites them differently from HEAD, FileChanged lints minified/generated code that the project's linter usually ignores. This repo marks `*/plugin/**/*.mjs` (and plugin.json, hook-inputs.d.mts, pnpm-lock.yaml) `linguist-generated`, and `.oxlintrc.json` ignores `**/plugin/**`. In practice the build also unlinks and recreates them, which drops them from the watch list (F15), so they are both wasted work and inconsistently watched.

## Evidence

This repo's watch list: 161 paths, 17 `plugin/**/*.mjs` among them. A scratch clone with 17 built .mjs modified: 17 failed rtk oxlint + 17 `npx --yes oxlint` (675-955 ms each), 1.97 s wall, 16.9 s CPU, 2.6 GB summed RSS, all exit 0. Identical rebuild: 186 ms / 1.8 s CPU (git-status skip). One FileChanged on a modified built .mjs: 693-824 ms (direct oxlint 53-61 ms). `git ls-files -co -z | git check-attr -z --stdin linguist-generated`: 22 entries in 7-10 ms here, 80 ms at 20k.

## Code locations

`watchList` (after `git ls-files`, before the scope loop); `isExcludedPath` (deliberately narrow, hook-design.md "Path exclusions").

## Approach

In `watchList`, pipe the listed paths through one `git check-attr -z --stdin linguist-generated` (execFileSync with `input`, `GIT_TIMEOUT_MS`); drop entries whose value is `set`/`true`. On git failure keep today's list. Watch-list only: Write/Edit of such a file still lints. Document as a watch-list-only exclusion. Most of the per-event cost already disappears with F04 (about 100 ms per ignored file), so weigh the policy cost against that.

## Verification

file-detection test: a repo with `.gitattributes` `gen/** linguist-generated` and lintable files in gen/ and src/ → only src/ in watchPaths. This repo: 161 → 144 paths. Timing: + ≤ 100 ms at 20k entries.

## Constraints

User decision (new policy; linguist-generated is a convention, not universal). Pure watch-list filter; fail open on git errors. Version bump.

## Related

F04, F12, F15, F08.
