---
id: F08
title: Stop the watch-list filter once WATCH_LIMIT is exceeded
status: done
priority: medium
area: universal-lint/src/hooks/lint-file.mts (watchList, WATCH_LIMIT)
---

## Status

Done in 0.15.7. Shipped: `watchList` builds the `Set` of in-scope lintable files in a `for` loop over the `git ls-files -co --exclude-standard -z` output and returns `[]` plus the stderr note the moment `size > WATCH_LIMIT` (still strictly `>`: exactly 5000 distinct files are watched, 5001 are not), so the scan stops after the 5001st distinct in-scope lintable file instead of scoping every listed file first. Observable behaviour is otherwise unchanged (same watched paths in the same order under the limit; empty stdout, exit 0 and the stderr note over it). The note now reads `universal-lint: watch list: more than 5000 files, FileChanged linting off for this cwd` (the exact count is no longer known). Tests (`tests/file-detection.test.mts`): the existing 5001-file stub test asserts `/more than 5000/` (its only change); new: a real git repo with 5002 lintable files prints nothing and the note, and a stub-git boundary case (5000 names each listed twice) still watches exactly 5000 files with no note, which guards `>` versus `>=` and the count being the Set size, not the raw line count. Measured (2026-11-07, same machine and session, medians of 1 warm-up + 5 runs, fixture and numbers in this doc; hook-design.md "Measured cost" points here), 0.15.6 -> 0.15.7: 20k files (10,000 lintable) 751 -> 419 ms, 50k files (25,000 lintable) 1757 -> 434 ms, exit 0, empty stdout. Under-limit identity checked against the 0.15.6 build on flat repos of 1000 and 5000 lintable files (sorted `watchPaths` identical, no note); a 5001-file repo prints nothing and the note in both builds. Accepted: the saving scales with lintable density (a repo with few lintable files, or one dominated by non-lintable files, is still scanned in full, F12's cost); `git ls-files` still runs to completion and its output is still split in full (about 40 ms on a 50k-file repo); the 10 MB `maxBuffer` (ENOBUFS) path is unchanged and still returns `[]`; `scopedTarget`, `realish` and the per-file cost are untouched (F12).

## Problem

`watchList` scopes every listed file and only then compares the count with `WATCH_LIMIT` (5000), returning `[]` above it. In large repos the synchronous SessionStart/CwdChanged hook spends seconds building a list it throws away.

## Evidence

SessionStart end to end, empty output with the "above 5000" note: 20k-file repo (9092 lintable) 1059-1180 ms, 50k-file repo (22730 lintable) 2518-2960 ms, 109 MB RSS; 20,000 lintable .ts: watchList 849 ms. In-process early break at 5001: 20k 1038 → 587 ms, 50k 2558 → 598 ms.

## Code locations

`watchList` (the `for` loop over `out.split("\0")` calling `scopedTarget`, with the in-loop `list.size > WATCH_LIMIT` check); `WATCH_LIMIT`.

## Approach

Shipped: one loop adds each in-scope absolute path to a `Set` and returns `[]` plus the note right after the `add` that makes `size > WATCH_LIMIT`; no `break` plus post-loop check. It is exactly equivalent to the old result: a Set only grows and de-duplicates, so "size exceeds the limit at some point in the loop" is the same predicate as "final de-duplicated length exceeds the limit", the returned array has the same elements in the same insertion order, and the note is written in the same situation (once, only over the limit). The count must be the Set size, never the raw split length, because unmerged index entries are listed once per stage. The limit still counts in-scope lintable files, so a raw pre-count of `git ls-files` lines cannot replace it. Not done: streaming or killing `git ls-files`, an extension check before `realish` and a per-directory realpath cache (F12).

## Verification

Existing watch-list tests unchanged apart from the note regex; new tests: 5002 in-scope files in a real repo assert no stdout and the note, and 5000 distinct names listed twice are still watched. Bench: 20k ≤ about 600 ms, 50k ≤ about 700 ms, same empty stdout. Result: 20k 751 -> 419 ms, 50k 1757 -> 434 ms (0.15.6 -> 0.15.7, same session). Under-limit identity: 1000 and 5000 lintable files give byte-identical sorted `watchPaths` in both builds.

## Constraints

No stdout when the list is empty; only the stderr note wording changes. Version bump.

## Related

F12 (same loop, now bounded by this early stop; F12 still owns the per-file cost), F29 (SessionStart budget line), F33.
