---
id: F17
title: Cap trimToEdit uniqueness widening
status: done
priority: none
area: dprint/src/mcp/format.mts (trimToEdit)
---

## Status

Done, with a different failure mode than the analysis proposed: `trimToEdit` widens at most 1000 single-line steps; at step 1001 it jumps once to the widest span available (`lo`..`hi`, bounded by neighbouring non-kept hunks) instead of searching per line. Highly repetitive files therefore still format, as one large Edit, rather than failing open.

## Problem

The widening loop grows the kept span one line per iteration and on each step joins the span (`render`) and runs `original.indexOf` twice over the whole document: O(steps x document) when the hunk text is not unique within a large radius. 10k identical lines 930 ms, 20k 5.1 s, 40k 27 s, 20k lines as 10 identical 2000-line blocks 11.5 s. Runs synchronously in the PreToolUse hook and blocks the whole MCP server (cwd_changed probes queued behind it for 1.85 s). Realistic files stay at 0.1-3 ms (100 x 200-line duplicate blocks 12 ms). Reachable only with a self-repeating old_string of hundreds to thousands of lines.

## Evidence

- Capped prototypes: cap 1000 kept every result reached in <= 1000 steps and bounded worst cases to 9 ms (10k/20k identical), 19 ms (40k), 98 ms (10-block 20k) when returning null; cap 200 also nulled legit 500-line identical / 50x10-block cases, so do not go below ~250 (realistic 100 x 200-line blocks need ~200 steps).
- Existing 13 trimToEdit/lineDiff tests passed with cap 200 and 1000; 9/9 exp-big2 .ts edits unchanged.
- The analysis suggested returning null (fail open) at the cap; the implemented version jumps to the widest span (correct, large Edit) instead.

## Code locations

- `trimToEdit` in dprint/src/mcp/format.mts: counter `steps`, `if (++steps === 1001)` branch sets `bA -= aA - lo; aA = lo; bB += hi - aB; aB = hi` (jump to the widest span `lo`..`hi`), then the normal uniqueness check and widen loop; `lineDiff` (separate 25M-cell guard) is unchanged.

## Approach

Implemented: cap with `// shortcut:` comment (limit 1000, upgrade if a real workload needs more). After the jump the span is the maximal context, so the uniqueness check either succeeds or the loop returns `null` when no further widening is possible.

## Verification

- tests/mcp-format.test.mts (trimToEdit cases). Missing regression test worth adding: 20k lines of 10 identical 2000-line blocks with one changed line, assert it returns (non-null large Edit or null) in < 200 ms and, if non-null, that `oldString` occurs exactly once in `original`.
- `pnpm --filter dprint build && pnpm --filter dprint test`.

## Constraints

- Edit src/, never plugin/*.mjs; fail open; TSDoc updated on `trimToEdit` (remarks mention the cap); version bump for further changes.

## Related

- F16: other quadratic term in the Edit path.
- F08: large-file Edit costs (lineDiff).
