---
id: F25
title: Cut watch-paths SessionStart/CwdChanged cost on large repos
status: done
priority: low
area: dprint/src/mcp/format.mts (realish), dprint/src/mcp/watch-paths.mts (watchList, execFileSync timeout)
---

# F25 Cut watch-paths SessionStart/CwdChanged cost on large repos

## Status

Done in 0.12.1: `realish` uses `realpathSync.native` (one syscall), `dprintFilePaths` times out after 3 s and returns the list sorted.

## Problem

`watch-paths.mjs` runs on every SessionStart (startup/resume/clear/compact) and every persistent CwdChanged. On a 4951-file repo it costs 320-540 ms end-to-end (230 ms on an idle machine), 69 MB RSS, an ~880 KB JSON; 76% of in-process time is `lines.filter(inScope)` = one `realpathSync` per path (259 ms for 4951 paths, 432 ms with 8-level paths). Claude then creates ~5000 inotify watches (max_user_watches here is 1,048,576; a distro default of 8192 would break at 2 sessions) and re-creates the whole watcher on every cd. Above `WATCH_LIMIT` (5000, applied to the RAW `dprint file-paths` count before the scope filter) FileChanged is silently off for that cwd (stderr line only). When `dprint file-paths` hangs (unreachable plugin host, F14) the hook stalls the full 10 s timeout (10,083 ms measured).

## Evidence

Medians ms (orig / realpathSync.native / dir-cached): 39 files 86/83/85; 500 files 127/115/120; 2k 334/195/154; 5k 457/286/246; 5k with 8-level dirs 604/386/221. Output byte-identical (sorted watchPaths, 4951 paths; 16 symlink/missing/excluded edge cases), 123/123 tests pass for all variants. Floor ~ node boot+imports 40 + `dprint file-paths` 35 + lstat/resolve 60 + spawn 12 ms. Real hook: 419 ms on 4951 files, 610 ms on 4952 long-path files, 95-137 ms on 132 files; inotify watches = files + 3. On /mnt/c (9P) `.native` is NOT faster (62 vs 64 ms at depth 8). Unverified: `dprint file-paths` output order changes every run; if Claude compares the list unsorted every CwdChanged would re-create the watcher (F24: sort the output).

## Code locations

- `realish` (module const) in dprint/src/mcp/format.mts, used by `scopeOf`/`inScope`.
- `watchList` in dprint/src/mcp/watch-paths.mts: `execFileSync(... timeout: 10_000 ...)` and `WATCH_LIMIT` check before `inScope` filtering.

## Approach

1. `realish`: `realpathSync` -> `realpathSync.native` (halves the pass, identical results; no gain on 9P). Optional: per-Scope Map of directory realpaths plus an `lstat` decision per file (~15 lines, 246 ms flat / 221 ms deep at 5k); it touches the shared security-relevant `inScope` helper, take it only if the cost proves user-visible.
2. Lower the `dprint file-paths` `execFileSync` timeout from 10_000 to ~3_000 ms (cap the SessionStart stall; see F14).
3. Keep `WATCH_LIMIT` as is (cheap early exit ~110 ms; counting is by design).
   Not recommended: splitting `scopeOf`/`inScope` out of format.mts (saves ~15 ms of imports).

## Verification

`pnpm --filter dprint build && pnpm --filter dprint test`; compare sorted watchPaths before/after on a generated 5k-file repo (git init, dprint.json copy, 50 dirs x 99 files) with `node plugin/mcp/watch-paths.mjs` and the SessionStart JSON on stdin, 15 timed runs; symlink edge cases (link out of cwd, dangling link, scratchpad in cwd) must stay identical. Existing test: "watch-paths.mjs prints the in-cwd dprint file paths as watchPaths ...".

## Constraints

Edit src/ not plugin/*.mjs; `pnpm --filter dprint build && pnpm --filter dprint test`; fail open (stdout JSON object or nothing, exit 0); zero-dep node:; TSDoc on every symbol; version bump in dprint/plugin.json AND dprint/package.json; watch-paths.mts must not import server.mjs.

## Related

F24 (list shape/size and sorting), F26 (JSON size, refuted), F14 (hang -> timeout cap), F27 (same `realish` on 9P).
