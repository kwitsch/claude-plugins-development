---
id: F29
title: Bound the per-Bash watch-list mtime scan in bash_finished
status: open
priority: low
area: dprint/src/mcp/format.mts (bashFinished, cachedWatchList, watchCache), dprint/src/mcp/watch-list.mts (dprintFilePaths)
---

# F29 Bound the per-Bash watch-list mtime scan in bash_finished

## Status

Open. Found in the 2026-11-13 evaluation ([../EVALUATION-2026-11-13.md](../EVALUATION-2026-11-13.md)), plugin 0.13.0. Not prototyped.

## Problem

`bashFinished` runs after every Bash call (PostToolUse `Bash`, timeout 30 s). It filters the cached watch list of the cwd with one synchronous `statSync(f.fp).mtimeMs` per file to find files the Bash call touched. The cost is linear in the watch-list size (up to `WATCH_LIMIT` = 5000 files), paid on every Bash call whether it changed anything or not, and it blocks the server event loop: a `format_pre` or `file_changed` arriving meanwhile waits. On ext4 it is small; on 9P (a repo under `/mnt/c` in WSL2, see F27) a stat costs ~0.7 ms even with the cwd pinned, so a 5k-file repo would pay seconds per Bash call. The first Bash call per cwd additionally lists the files (`dprint file-paths` plus one `inScope` realpath per file, also synchronous after the listing).

## Evidence

One WSL2 machine, real dprint 0.64.3, built server over stdio (evaluation 2026-11-13):

- 4951-file ext4 repo (50 dirs x 99 files): later Bash calls 14.1-14.4 ms median (p90 15.0), first Bash call 128-135 ms; 106-file repo 0.5-1.3 ms.
- Server RSS +11-15 MB with the 4951-entry list cached.
- `statSync` probe, same loop shape: ext4 3-5 us per file; 9P `/mnt/c/Windows/System32` (2000 entries, read-only) 0.67-0.71 ms pinned, 1.53-1.59 ms unpinned. Extrapolated to 4951 files: ~3.3 s pinned / ~7.6 s unpinned per Bash call. NOT measured end-to-end on a 9P repo (no repo was created on `/mnt/c`); System32 may stat slower than a typical source tree.
- F27 for comparison: on 9P a `git status` costs 130-330 ms, a `git check-ignore` spawn 31-40 ms.

## Code locations

- `bashFinished` in dprint/src/mcp/format.mts: `(await cachedWatchList(sc)).filter((f) => statSync(f.fp).mtimeMs > since - 1000)`.
- `cachedWatchList` / `watchCache` in dprint/src/mcp/format.mts (list read once per cwd, cleared by `setCwd`; the F24 shortcut comment lives there).
- `dprintFilePaths` / `WATCH_LIMIT` in dprint/src/mcp/watch-list.mts.

## Approach

Prototype and measure first; pick one:

1. Candidates from git: one `git --no-optional-locks status --porcelain --untracked-files=normal -z` in the root, intersect with the watch list (Set of `fp`), then `statSync` only those for the mtime filter. Cost: one git spawn (~5 ms ext4, 130-330 ms 9P) plus stats of dirty files only. Equivalent outcome: `formatOnDisk` already skips files git reports unchanged against the index or ignored. Fallback to the full scan when git fails (no repository). Check renames (`R` lines carry two paths) and paths with spaces (`-z`).
2. Keep the scan but make it asynchronous (`fs.promises.stat` with bounded concurrency): unblocks the event loop, does not cut the total time on 9P.
3. Skip the scan above a list-size threshold (stderr line) and rely on FileChanged: loses the "Bash output is not stale" guarantee for big repos.

Trap: the mtime window (`since - 1000`) must stay; a file already dirty before the Bash call must not be reported as reformatted by this call unless it changed (option 1 still applies the mtime filter to the candidates).

## Verification

- Existing tests "bash_finished formats a file the Bash call changed and names it; ..." and "bash_finished: already formatted, stale mtime and missing bash_started give {}" stay green; add one for a renamed file and one for a cwd without git (fallback).
- Measure with the evaluation harness: bash_started/bash_finished on the 4951-file repo (median of 11 later calls) before/after; if possible repeat on a repo under `/mnt/c` with the cwd pinned.
- `pnpm --filter dprint build && pnpm --filter dprint test && pnpm --filter dprint lint`.

## Constraints

Edit `src/`, never `plugin/**/*.mjs`; zero-dep `node:` builtins; fail open (`{}`); TSDoc on every symbol; `watch-list.mts` must not import `format.mts` or `server.mts`; version bump in `dprint/package.json`.

## Related

F24 (the watch-list cache shares its staleness), F25 (listing cost, `WATCH_LIMIT`), F27 (9P stat cost), F13 (event-loop blocking during bursts), F28 (no test pins this path's cost).
