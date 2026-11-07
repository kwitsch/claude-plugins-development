---
id: F33
title: watchPaths JSON size and watch count need no change; re-check on Claude Code upgrades
status: measurement-only
priority: low
area: universal-lint/src/hooks/lint-file.mts (watchPathsHandler, watchList, WATCH_LIMIT)
---

# F33 watchPaths JSON size and watch count: re-check on upgrades

## Status

Measurement-only, open. watch-filechanged finding (confirmed, low): no action needed now.

## Problem

`WATCH_LIMIT` counts files, not bytes, so the SessionStart stdout can reach about 1 MB, and Claude Code creates one watch per file. Open question: does a future Claude Code cap hook stdout or watch counts?

## Evidence

About 180-200 bytes per path: 2275 paths 412,588 bytes; 3000 paths 595 KB; 4800 paths 953 KB-1.1 MB. Real sessions parsed 34 and 63 paths (`provided 63 watchPaths`, `FileChanged: watching 63 paths`). dprint F26: Claude Code 2.1.316 parsed 1.65 MB of watchPaths correctly. `max_user_watches` here: 1,048,576.

## Code locations

`watchPathsHandler` (one `JSON.stringify` to stdout via `main`), `watchList`, `WATCH_LIMIT`.

## Approach

No change. On each Claude Code upgrade: a repo with about 4800 lintable paths, `claude -p --debug-file`, grep `provided N watchPaths` and `FileChanged: watching N paths`; the counts must match. If a cap appears, add a byte cap next to `WATCH_LIMIT` or switch to directory watchPaths (F15).

## Verification

The grep above: watching count equals path count.

## Constraints

None now.

## Related

F15, F08, F12, dprint F26.
