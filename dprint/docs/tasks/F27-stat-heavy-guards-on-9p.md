---
id: F27
title: Cache findConfig results to cut stat latency on 9P repos
status: done
priority: low
area: dprint/src/skills/dprint/find-config.mts (findConfig), dprint/src/mcp/format.mts (realish, scopeOf, fileWritten, fileChanged, formatPre)
---

## Status

Done in 0.12.1: `findConfig` caches found configs per start directory and re-checks them with one `existsSync`; `null` is never cached, so a config created mid-session counts at once. The `realish` cache was not added (symlink safety).

## Problem

Each hook call runs `findConfig` (up to 6 `existsSync` per directory level up to `.git`) and `realish` three times (root, scratchpad_dir, file); `formatPre`, `fileWritten` and `fileChanged` each repeat it, x3 hook calls per Write/Edit. On 9P `existsSync` cost grows with path depth (~0.5 ms/component) and `realpathSync` lstat's every prefix (quadratic in components).

## Evidence

Pinned steady state (a process holds cwd on the path: Claude Code itself and the dprint lsp child, dentries cached, ~30x faster), per hook call findConfig + 3 realish + guards: depth 0 4.0 ms, depth 3 9.6 ms, depth 8 18.3 ms; x3 per Write = 12 / 29 / 55 ms. Unpinned (first call per new effective cwd: worktree, cwd override, before the lsp child exists): findConfig at depth 8 = 350-450 ms, 3 realish 139 ms. Cached findConfig: pinned depth 8 per Write 54.9 -> 22.1 ms, depth 0 unchanged, unpinned depth 8 353 -> 5.5 ms. `realpathSync.native` gives no gain on 9P. Same 9P session: each `git check-ignore` spawn 31-40 ms and `git status` 130-330 ms, dprint lsp +9-20 ms per format: the git spawns are the bigger lever. End-to-end per Write 69 ms (depth 0) / 156 ms (depth 8) on 9P vs 9-10 ms on ext4. ext4 findConfig 7 us (root) to 343 us (8 levels): caching pointless there.

## Code locations

`findConfig` and `FoundConfig` in dprint/src/skills/dprint/find-config.mts (shared by run-dprint, scan-plugins, mcp/format and watch-paths; other scripts are one-shot processes); call sites in `fileWritten`, `fileChanged`, `formatPre` and `watchList` (watch-paths.mts) only null-check the result; `realish`, `scopeOf` in format.mts.

## Approach

1. In find-config.mts add a module-level `Map<string, FoundConfig>` keyed by `path.resolve(dir)`: on lookup return the cached hit only if `existsSync(path.join(hit.dir, hit.name))` still holds, else run the existing walk; set on a hit, delete on null; NEVER cache null (a config created mid-session, e.g. by `dprint init`, must be seen at once). Update the "Nothing is cached" remark. A stale dir/name for a nearer config created later is harmless at all call sites (they only null-check).
2. If the 3 `realish` per call (3.5-7 ms on 9P) ever matter, cache `realRoot`/`realScratch` per cwd inside `scopeOf` (not `.native`).
3. Larger lever on 9P, out of scope here: the git spawns.
   Prototype existed (~8 lines, 5/5 mid-session correctness checks: equals uncached; config removed -> null; null not cached; re-created -> seen; nearer config below cached root still answers root).

## Verification

Add tests in dprint/tests/mcp-server.test.mts: "config removed mid-session -> gate closes (format_pre {})" and "config created mid-session -> gate opens" (today only "cwd without any dprint config" and cwd_changed gating exist). Measure on /mnt/c (not ext4): fixture cwd at depth 0/3/8 below `.git`, cwd pinned by a child process, 20 reps, uncached vs cached `findConfig` + `scopeOf/inScope` timings.

## Constraints

Edit src/ not plugin/*.mjs; `pnpm --filter dprint build && pnpm --filter dprint test`; zero-dep node:; TSDoc on every symbol; fail open; version bump in dprint/plugin.json AND dprint/package.json.

## Related

F25 (`realish`), F07 (git check-ignore spawn cost, bigger on 9P), F15 (negative cache for missing dprint).
