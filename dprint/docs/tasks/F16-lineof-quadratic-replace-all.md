---
id: F16
title: One-pass line counter for replace_all offsets
status: done
priority: none
area: dprint/src/mcp/format.mts (lineCursor, formatPre editLines computation)
---

# F16 One-pass line counter for replace_all offsets

## Status

Done. The per-occurrence `lineOf(text, idx)` (rescan from offset 0) was replaced by the module-private one-pass `lineCursor(text)`, which requires non-decreasing offsets.

## Problem

`formatPre` computed the edited line range per occurrence with `lineOf`, which walked `indexOf("\n")` from 0 on every call: O(k x N) for a replace_all with k occurrences. 5000 occurrences on a 20k-line file cost ~1.1-1.5 s of synchronous JS (20000 occurrences 3.7-4.6 s), blocking the whole server. Realistic edits (<= 200 occurrences, <= 3000 lines) cost <= 8 ms, so impact was low.

## Evidence

- Isolated, current -> cursor (median ms): 20000 lines/313 occ 67 -> 0.49; /1250 270 -> 0.50; /5000 1143 -> 0.59; /20000 4631 -> 0.91. Outputs equal.
- formatPre e2e with real dprint: updatedInput sha256 identical before/after in 15 scenarios; edge check of 80 small cases (empty, shrinking, multi-line new_string, single and replace_all) 0 mismatches.
- Note: replace_all spanning > 5000 lines still fails open (lineDiff 25M-cell guard) after paying a dprint range format (300-800 ms); a pre-check before the format would save that (not implemented, unvalidated).

## Code locations

- `lineCursor` in dprint/src/mcp/format.mts (`const lineCursor = (text) => (idx) => number`).
- `formatPre` in the same file: `const lineAt = lineCursor(O)` used in `occ.map(...)` for `[lineAt(i), lineAt(i + oldStr.length - 1)]`; asked in ascending order because `occ` is ascending and non-overlapping (comment in source). The analysis patch also used a cursor for line numbers in `M`; the current source has only the `O` cursor.

## Approach

Implemented as in the analysis patch. Invariant to preserve: offsets passed to one cursor never decrease (`occ` is ascending, non-overlapping, `oldStr` non-empty). Any new caller must respect that.

## Verification

- tests/mcp-format.test.mts and tests/mcp-server.test.mts (replace_all cases) stay green.
- Optional perf test: replace_all with 5000 occurrences in a 20k-line file, assert the lineCursor stage is < 50 ms (not needed for correctness).
- `pnpm --filter dprint build && pnpm --filter dprint test`.

## Constraints

- Edit src/, never plugin/*.mjs; TSDoc on every symbol including module-private constants (`pnpm lint`); version bump for further changes.

## Related

- F17: other O(n^2) cost in the Edit path (trimToEdit widening).
- F08: large-file Edit cost, lineDiff guard.
