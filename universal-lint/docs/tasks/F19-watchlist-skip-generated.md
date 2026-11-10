---
id: F19
title: Keep linguist-generated files out of watchPaths
status: done
priority: low
area: universal-lint/docs/tasks/F19-watchlist-skip-generated.md, universal-lint/docs/TASKS.md
---

# F19 Keep linguist-generated files out of watchPaths

## Status

Closed docs-only in 0.15.16 (user decision, 2026-11-10). Re-measured after F04/F09: not worth a new exclusion policy; no code shipped. 0.15.16 because the root CLAUDE.md version rule applies to any change under `universal-lint/` (F15 precedent).

## Problem

Tracked build output and codegen are watched. When a build rewrites them differently from HEAD, FileChanged lints minified/generated code that the project's linter usually ignores. This repo marks `*/plugin/**/*.mjs` (and plugin.json, hook-inputs.d.mts, pnpm-lock.yaml) `linguist-generated`, and `.oxlintrc.json` ignores `**/plugin/**`. In practice the build also unlinks and recreates them, which drops them from the watch list (F15), so they are both wasted work and inconsistently watched.

## Evidence

Pre-F04/F09 (as filed): this repo's watch list was 161 paths, 17 `plugin/**/*.mjs` among them. A scratch clone with 17 built .mjs modified: 17 failed rtk oxlint + 17 `npx --yes oxlint` (675-955 ms each), 1.97 s wall, 16.9 s CPU, 2.6 GB summed RSS, all exit 0. Identical rebuild: 186 ms / 1.8 s CPU (git-status skip). One FileChanged on a modified built .mjs: 693-824 ms (direct oxlint 53-61 ms). `git ls-files -co -z | git check-attr -z --stdin linguist-generated`: 22 entries in 7-10 ms here, 80 ms at 20k.

Re-measured on base 1b51a89 (committed plugin/, WSL2, load uncontrolled, small n):

| Quantity                                               | As filed (pre-F04/F09)                       | Now                                                                                                                                                                                                                        |
| ------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| This repo's watch list (SessionStart, cwd = repo root) | 161 paths, 17 `plugin/**/*.mjs`              | 198 paths; 19 `linguist-generated` (17 `*/plugin/**/*.mjs`, `dprint/src/mcp/hook-inputs.d.mts`, `pnpm-lock.yaml`); 179 with the filter                                                                                     |
| `git ls-files -co --exclude-standard`                  | 22 generated                                 | 225 entries, 22 generated (the extra 3 are `*/plugin/.claude-plugin/plugin.json`, not lintable)                                                                                                                            |
| `git check-attr -z --stdin linguist-generated`         | 7-10 ms (22 entries), 80 ms at 20k           | ~3 ms at 225 entries (spawn-dominated, shell `time`); ~32 ms at a synthetic 20,250 entries (shell `time`, 3 runs)                                                                                                          |
| SessionStart hook end to end                           | 68 ms                                        | ~63-65 ms                                                                                                                                                                                                                  |
| Lint of one rewritten generated `.mjs`                 | 693-824 ms per FileChanged (rtk + npx route) | ~125-235 ms (PostToolUse Write route, 2 samples; git gate excluded)                                                                                                                                                        |
| Findings from that lint                                | none (exit 0)                                | none: `.oxlintrc.json` `ignorePatterns` `**/plugin/**` plus `--no-error-on-unmatched-pattern`; `oxlint -c .oxlintrc.json --no-error-on-unmatched-pattern universal-lint/plugin/hooks/lint-file.mjs` exits 0 with no output |

Not measured: end-to-end FileChanged on a modified generated file (scratch repo blocked by the worktree guard), `tsc` on `hook-inputs.d.mts`, a 10-run median per row, the Node-side `execFileSync` time of check-attr at 20k (shell-level is ~32 ms).

## Decision

Not adopted (user decision, 2026-11-10). Reasons:

- No findings: `.oxlintrc.json` ignores `**/plugin/**` with `--no-error-on-unmatched-pattern`, so the ~125-235 ms is invisible background CPU under `asyncRewake`.
- F15 already drops unlink+recreated build output from the watch.
- `linguist-generated` means "collapse in GitHub diffs", not "don't lint".
- A watch-list-only exception breaks the shared-scope / deliberately narrow exclusion policy (hook-design.md "Path exclusions") and creates a Write-vs-Bash asymmetry that is hard to diagnose.
- Cost of adopting: a second git spawn and 10 s timeout window per SessionStart/CwdChanged in every repo, plus code, tests and ~900 bytes in a rules file near its 40,000-byte limit.

## Reopen trigger

Reconsider only if a generated file's FileChanged lint is shown to put findings into Claude's context (e.g. yamllint on a lockfile), and then as a per-linter / ignore-config concern, not a watch-list attribute filter.

## Code locations

`watchList` (after `git ls-files`, before the scope loop); `isExcludedPath` (deliberately narrow, hook-design.md "Path exclusions").

## Approach

Proposed (not adopted): in `watchList`, after the scope loop on the in-scope list (before the scope loop would run check-attr before the F08 early stop), pipe the listed paths through one `git check-attr -z --stdin linguist-generated` (execFileSync with `input`, `GIT_TIMEOUT_MS`); drop entries whose value is `set`/`true`. On git failure keep today's list. Watch-list only: Write/Edit of such a file still lints. Document as a watch-list-only exclusion. Most of the per-event cost already disappears with F04 (about 100 ms per ignored file), so weigh the policy cost against that.

## Verification

Proposed (not adopted): file-detection test: a repo with `.gitattributes` `gen/** linguist-generated` and lintable files in gen/ and src/ → only src/ in watchPaths. This repo: 161 → 144 paths as filed (198 → 179 now). Timing: + ≤ 100 ms at 20k entries.

## Constraints

User decision (new policy; linguist-generated is a convention, not universal). Pure watch-list filter; fail open on git errors. Version bump.

## Related

F04, F12, F15, F08.
