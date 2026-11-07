---
id: F08
title: Stop the watch-list filter once WATCH_LIMIT is exceeded
status: open
priority: medium
area: universal-lint/src/hooks/lint-file.mts (watchList, WATCH_LIMIT)
---

# F08 Stop the watch-list filter once WATCH_LIMIT is exceeded

## Status

Open. watch-filechanged finding (confirmed, medium) plus the static missed item (same observation).

## Problem

`watchList` scopes every listed file and only then compares the count with `WATCH_LIMIT` (5000), returning `[]` above it. In large repos the synchronous SessionStart/CwdChanged hook spends seconds building a list it throws away.

## Evidence

SessionStart end to end, empty output with the "above 5000" note: 20k-file repo (9092 lintable) 1059-1180 ms, 50k-file repo (22730 lintable) 2518-2960 ms, 109 MB RSS; 20,000 lintable .ts: watchList 849 ms. In-process early break at 5001: 20k 1038 → 587 ms, 50k 2558 → 598 ms.

## Code locations

`watchList` (the `split("\0")…flatMap(scopedTarget)` loop followed by the `list.length > WATCH_LIMIT` check); `WATCH_LIMIT`.

## Approach

Replace the flatMap with a loop that adds to a Set and breaks once `size > WATCH_LIMIT`, then writes the existing stderr note worded as "more than 5000". The limit still counts in-scope lintable files. Note: past about 50k-100k long paths `git ls-files` hits the 10 MB maxBuffer (ENOBUFS) and the code already returns `[]`.

## Verification

Existing watch-list tests in file-detection.test.mts unchanged; add a test with a generated repo of 5002 in-scope files asserting no stdout. Bench: 20k ≤ about 600 ms, 50k ≤ about 700 ms, same empty stdout.

## Constraints

No stdout when the list is empty; only the stderr note wording changes. Version bump.

## Related

F12 (same loop, do together), F29 (SessionStart budget line), F33.
