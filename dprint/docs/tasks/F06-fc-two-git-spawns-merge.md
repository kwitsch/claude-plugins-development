---
id: F06
title: One git spawn per FileChanged event
status: done
priority: none
area: dprint/src/mcp/format.mts (fileChanged, isGitIgnored)
---

## Status

Done (release dprint 0.8.0). `fileChanged` runs a single `git --no-optional-locks status --porcelain --untracked-files=normal --ignored=matching -- <file>` (cwd = dirname of the file): empty stdout (tracked and unchanged) or stdout starting with `!!` (ignored) skips; any git failure (no git, not a repo, timeout) means format. `isGitIgnored` (`git check-ignore -q`) is kept and used only by `formatPre`.

## Problem

Previously every event that passed the digest check ran `git check-ignore` and then `git status --porcelain`: two sequential spawns (2.8-16 ms each depending on index size; 100k-file repo 12 + 22 ms).

## Evidence

Decision parity 21/21 fixture cases (ignored dir -> `!! dir/`, pattern, info/exclude, core.excludesFile, nested repo, negated pattern, tracked-in-ignored-dir -> empty, not a repo -> format). `--ignored=matching` costs the same as plain status (pathspec prunes the walk); traditional `--ignored` costs 231 ms @100k, unusable. Saving 34-51% of the skip path (-3.1 ms small repo, -5 ms 20k files, -17 ms 100k); 50-event burst wall -30..-47%; 521 events -> 521 git spawns instead of 1042. Trap found: `--ignored=matching` is rejected ("Unsupported combination of ignored and untracked-files arguments") when `status.showUntrackedFiles=no` is configured, so `--untracked-files=normal` is mandatory; without it git dies for such users and everything (incl. gitignored files) would be formatted. As a side effect untracked files under that config are now formatted instead of treated as unchanged. Git older than 2.16 fails the call -> falls through to format (dprint lsp itself still honours .gitignore).

## Code locations

- `fileChanged` (the `execFileAsync("git", [...status...])` block and the `stdout === "" || stdout.startsWith("!!")` check)
- `isGitIgnored` (formatPre only), `execFileAsync`
- test: "file_changed leaves a file alone that is unchanged against the git index" in `tests/mcp-server.test.mts` (tracked-unchanged skip, modified format, gitignored skip)

## Approach

Implemented as described: one status spawn answers both questions. formatPre keeps its separate `git check-ignore` (different question and Write targets may not exist yet; see F07).

## Verification

`pnpm --filter dprint build && pnpm --filter dprint test`. Optional missing test: set `status.showUntrackedFiles=no` (global git config via `GIT_CONFIG_GLOBAL`) and assert an untracked file is formatted and an ignored one is skipped.

## Constraints

Edit `src/`, not `plugin/**/*.mjs`; zero-dep node builtins; fail open on git errors (format); TSDoc; version bump in both `dprint/plugin.json` and `dprint/package.json`.

## Related

F05 (burst queue in the same function), F07 (formatPre keeps check-ignore), F13 (spawn work blocks the event loop).
