---
id: F08
title: Large not-yet-formatted files make every Edit slow (documented only)
status: docs-only
priority: low
area: dprint/src/mcp/format.mts (formatPre, trimToEdit, lineDiff); docs: dprint/plugin/README.md
---

# F08 Large not-yet-formatted files make every Edit slow (documented only)

## Status

Docs-only. No code change for F08 itself. `dprint/plugin/README.md` states: "Every Edit formats the whole file, so Edits on large files that were never formatted are slow; run `/dprint:dprint fmt` once on them." `dprint/CLAUDE.md` has no sentence on it. F01+F03 already cut the formatted 3000-line case from ~3 requests to 1 (~1.75 s -> ~0.55 s), which is the only code-side relief.

## Problem

When the file on disk is not dprint-formatted, the whole-document format changes nearly every line, so `lineDiff(O, out)` has no common prefix/suffix and the O(n*m) table covers the whole file. Guard: `a.length * b.length > 25_000_000` throws "diff too large" (caught in `formatPre`, returns `{}`). The guard is span-based, not changed-line based: a >5000-line file with one deviation near the top and one near the bottom also fails open. Consequences: 3000-line unformatted .ts Edit ~1.75 s (before F01/F03; real session 1.3 s on a 2976-line file); >= ~5000-line span: one dprint format (0.75-1 s) wasted, `{}` returned, the file stays unformatted and EVERY later Edit pays again (20000-line file: 819-955 ms per Edit, 5 consecutive Edits).

## Evidence

Medians (before F01/F03): 500 lines all-dirty 93 ms; 3000 lines 1755 ms (3 x ~550 ms requests + ~100 ms diff); 5000 lines 1993 ms; 20000 lines ~857 ms then `{}` + stderr `format_pre failed open: diff too large`; 1 MB (37k lines) ~1.3 s then `{}`. lineDiff all-lines-differ: 9M cells 57 ms, 25M cells 157 ms (+22 MB), above 25M throws in 0.1 ms. Dominant cost is dprint's own work on dirty content (see F09), not the JS diff.

## Code locations

- `formatPre` Edit branch (the lsp request is awaited before `trimToEdit` can reject)
- `trimToEdit`, `lineDiff` (the 25M-cell guard)
- `README.md` bullet "Every Edit formats the whole file..." in `dprint/plugin/README.md`

## Approach

Done: documentation of the first-format advice. Optional, not done, only if the user asks:

- Memoise "diff too large" so repeat Edits skip the dprint request. The analysis rejects digest-keyed memo (keyed on digest(O)) because Claude's landed Edit changes the file so the next call misses. Candidate variant a2: a Set of real paths marked on "diff too large", skip the dprint call only while `digest(O)` equals the digest `fileWritten` recorded, clear on Write/file_changed/successful trim. Passed 123 tests in a prototype but its timing benchmark (second Edit < 10 ms) never completed; unvalidated, do not apply on current evidence.
- A one-line stderr/toast hint to run the fmt skill (critic suggestion; the user is otherwise never told). No toast channel exists in the MCP server today, only stderr.
  Trap: any change must keep fail-open semantics and never return a trimmed edit that was not verified.

## Verification

Docs: confirm the README line exists (`grep -n "never formatted" dprint/plugin/README.md`). If code is attempted: stub-based test with a document whose diff exceeds the guard (or lower the guard via a test-only seam), assert second Edit makes no lsp request; plus the F01/F03 test set.

## Constraints

README edits live in `dprint/plugin/README.md` (hand-written, not build output). Code: edit `src/`, never `plugin/**/*.mjs`; `pnpm --filter dprint build && pnpm --filter dprint test`; fail open; TSDoc; version bump in both `dprint/plugin.json` and `dprint/package.json` when anything under `dprint/` changes.

## Related

F01, F03 (reduce the request count), F09 (why dirty documents are slow in dprint), F10 (clean-file cost), F16/F17 (JS-side O(n^2) paths in the same functions).
