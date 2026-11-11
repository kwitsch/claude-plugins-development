---
id: F12
title: Cheapen the watch list's per-file scope check (extension first, per-dir realpath cache)
status: done
priority: medium
area: universal-lint/src/hooks/lint-file.mts (watchList, scopedTarget, realish, isExcludedPath, watchPathsHandler)
---

## Status

Done in 0.15.11. Shipped: `scopedTarget` checks the extension (`EXT_MAP`/`TYPE_CHECK_EXTS`, pure string work) right after `path.resolve`, before any filesystem call; every later step returns null or throws into null, so the result is unchanged for every caller. `watchList` passes a per-call memo through the existing `roots` argument (`roots.dirs`, lexical dirname -> `realish(dirname)`): each lintable entry costs one `lstatSync` (missing -> dropped; symlinked leaf -> today's full `realish`) plus one cached JS `realish` per distinct directory, and the redundant `existsSync` is skipped in that mode. PostToolUse, the skill driver and FileChanged call `scopedTarget` without `dirs`. The memo holds for one `watchList` call, so a directory replaced by a symlink during the scan keeps its earlier real path for the files after it (today each file re-resolves). Harmless: `watchPaths` is only the subscription list; every FileChanged re-runs `scopedTarget` without the memo before linting. Tests: `registry.test.mts` "scopedTarget: roots.dirs gives the same result as the plain call"; `file-detection.test.mts` SessionStart cases for an outside-symlinked directory (excluded), an inside-symlinked directory (lexical path kept) and escaping/dangling/inside leaf links plus a deleted tracked file. Identity: stdout and stderr byte-identical, 0.15.10 (committed build output of `f5934e0`) vs 0.15.11, on synthetic 2k, 5k (4,990 lintable), 12k (4,000 lintable), 20k and 50k (over the limit), 20k with 4,900 lintable, a depth-25 tree, an edge-case fixture (with and without a scratchpad inside cwd), this repo, and the 9P repos `/mnt/c/repos/blocky-dev`, `/mnt/c/repos/claude-plugins`, `/mnt/c/repos/copilot-qa-suite`. Measured (2026-11-08, SessionStart medians of 1 warm-up + 5 runs, base -> new): synthetic 12k 490 -> 139 ms (target ~250 ms: met); 20k with 4,900 lintable 735 -> 184 ms; blocky-dev 2190 -> 801 ms (target ~800 ms: missed by 1 ms); claude-plugins 1033 -> 452 ms; `perf.mts` SessionStart fixture 48 -> 47 ms, this repo 64 -> 56 ms. The targets were derived from the `.native` variant; `.native` is a possible follow-up only with its own JS/native equivalence proof on 9P.

## Problem

`watchList` calls `scopedTarget` for every `git ls-files -co` entry. `scopedTarget` runs `realish` (JS `realpathSync`, one lstat per path component) before the cheap extension check, then `existsSync`. Non-lintable files pay the full realpath; on 9P every stat costs milliseconds. SessionStart/CwdChanged are synchronous (`timeout: 30`) and awaited before the session starts, so this delays startup and every persistent `cd`. Extrapolated (not measured), a 9P repo with about 2,000-3,500 listed files exceeds 30 s: the hook is killed and nothing is watched.

## Evidence

- SessionStart end to end: /mnt/c blocky-dev (266 listed) 2320-2711 ms, /mnt/c claude-plugins (77) 1200-1272 ms, copilot-qa (89) 1344-1922 ms; ext4 repos 56-90 ms; synthetic 5k 340 ms, deep 8k 700 ms, 12k (4k lintable) 595-611 ms. About 8-14 ms per listed file on 9P.
- In-process filter, current vs variants (median of 5): 5k 261-271 → ext-first 139 → ext-first + `realpathSync.native` 90 → per-dir native realpath cache 77; 20k 963-1038 → dir-cache 158; 50k 2490-2558 → dir-cache 364; 9P claude-plugins 905-1005 → 396; 9P blocky-dev 1627-2291 → 784. On blocky-dev JS realpath over all 266 entries 768-1808 ms, native 480-491 ms.
- lstat-only is wrong: tracked `d/a.ts` with `d` later replaced by a symlink to `../outside` is still listed by `git ls-files -co`; current code drops it, lstat-only keeps it (out-of-scope watch path).
- Alternative measured: `git ls-files -s -z` mode-based (realpath only for mode 120000 and untracked) 171 ms on blocky-dev, same 242 paths, but it relies on the same false "no entries below a symlinked dir" premise; verify before using.

## Code locations

`watchList` (`out.split("\0")…flatMap(rel => scopedTarget(cwd, rel, scratchpad, roots))`); `scopedTarget` (order: realish → relative/isExcludedPath → scratchpad → EXT_MAP/TYPE_CHECK_EXTS → existsSync); `realish`.

## Approach

1. In `scopedTarget`, move the `EXT_MAP`/`TYPE_CHECK_EXTS` check before `realish` (pure string work; also helps PostToolUse/FileChanged on unsupported files).
2. In `watchList` only: per call, memoize the JS `realish(dirname)` per directory (not `realpathSync.native`: native and JS realpath are not proven equivalent on 9P/case-insensitive mounts), passed to `scopedTarget` as `roots.dirs`; the file's real path is `join(dirReal, basename)` after one `lstatSync` (missing → drop; symlink leaf → full `realish`). Then apply the real-relative `isExcludedPath` and scratchpad checks as now.
3. Re-derive the SessionStart/CwdChanged budget sentence in hook-design.md (F29).

## Verification

Sorted watchPaths byte-identical before/after on synthetic repos (2k-50k, deep), the 9P repos, this repo and the symlinked-dir edge case. file-detection.test.mts edge cases stay green (escaping/dangling links, scratchpad inside cwd, excluded dirs, WATCH_LIMIT); add the "tracked file under a dir replaced by an outside symlink stays excluded" case. Timing: blocky-dev ≤ about 800 ms, 12k ≤ about 250 ms.

## Constraints

`scopedTarget` is the shared, security-relevant scope rule (real-path scope is a user decision): semantics must stay identical. Zero-dependency; TSDoc; version bump.

## Related

F08 (same loop), F15 (re-emission multiplies this cost), F19, F29, dprint F25/F27.
