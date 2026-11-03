---
id: F03
title: Skip the Edit verification formats when the trim reproduces dprint's output
status: done
priority: none
area: dprint/src/mcp/format.mts (formatPre, trimToEdit)
---

# F03 Skip the Edit verification formats when the trim reproduces dprint's output

## Status

Done (release dprint 0.8.0). In the `formatPre` Edit branch the verification is `if (R !== out && out !== ((await lsp.format(uri, R)) ?? R)) return {};`: when R === out no extra format runs. A changed Edit on a clean file therefore costs exactly one lsp request.

## Problem

The verification exists to catch a trim that dropped or duplicated content. When R (= O with the trimmed edit applied) equals out (dprint's full result for the edited text M), nothing was dropped by construction; the old code then compared format(M) with format(format(M)), which is only a dprint idempotency check. Two whole-document formats per changed Edit were wasted.

## Evidence

Bench (real dprint 0.64.3, interleaved A/B, median ms): 500-line clean .ts 28.7 -> 12.5; 2000 lines 97.5 -> 36.5; 3000 lines 154 -> 55; real 732-line format.mts 38.2 -> 15.9; 20000 lines ~1011 -> 357. 0 decision flips (R === out and verification false) in 5 test Edits + 25 bench rows; `updatedInput` byte-identical; idempotency probe 0/36 non-idempotent md/json/yaml/ts snippets; 123/123 tests. No gain (old path runs unchanged) when R !== out: other dirty regions in the file, missing final newline, extra trailing blank lines, unformatted file.

## Code locations

- `formatPre` (Edit branch, comment above the verification condition)
- `trimToEdit`, `lineDiff` (produce r; R computed with `O.replace(r.oldString, () => r.newString)`)
- `changed`

## Approach

Implemented: single added condition `R !== out &&` before the two verification formats; `out` is the non-null whole format of M (reused from F01), so the remaining verification is one `format(R)` compared with `out`. Residual risk accepted: a non-idempotent plugin now gets `updatedInput` where it used to get `{}`. The test "Edit whose trim would drop the deleted repeated line -> {}" still returns `{}` because there R !== out.

## Verification

`pnpm --filter dprint build && pnpm --filter dprint test`. Optional extra test (not present): count `textDocument/formatting` requests in the stub for a clean-file Edit with R === out and assert exactly 1. Measure with an A/B of the built formatPre on a 2000-line clean .ts (expect ~35 ms, previously ~100 ms).

## Constraints

Edit `src/`, never `plugin/**/*.mjs`; zero-dep; fail open; TSDoc; version bump in both `plugin.json` and `package.json`.

## Related

F01 (whole-document-first; together = 1 request), F08 (unformatted files still take the slow path), F09 (dirty-document cost per request).
