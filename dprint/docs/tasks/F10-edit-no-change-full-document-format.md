---
id: F10
title: Even a no-change TS Edit formats the whole document (dprint-side sizing)
status: done
priority: low
area: dprint upstream (@dprint/typescript ignores ranges); client side: dprint/src/mcp/format.mts formatPre
---

## Status

Done in 0.12.1: covered by the same README sentence as F09. Earlier state (before 0.12.1): Docs-only. Docs at that time: only the README sentence "Every Edit formats the whole file ..." (`dprint/plugin/README.md`) and the Edit description in `dprint/CLAUDE.md` ("Edit: whole-file `formatting` of the edited text"). The per-size numbers (below) are NOT in README or CLAUDE.md (verified by grep). Remaining action, if wanted: add one sizing line.

## Problem

For dprint 0.64.3 + @dprint/typescript 0.96.1 a range is ignored (range result === whole result at 50/500/3000 lines), so the cheapest Edit branch (no change, 1 request) costs a full parse+print scaling linearly with file size: ~0.33-0.45 ms/KB, ~11-16 ms per 1000 lines. Since F01 the plugin sends a whole-document request anyway, so this cost is unchanged by F01/F03 and cannot be removed without dprint honouring ranges or an incremental protocol. Transport is not the bottleneck (1 MB request encode+parse 2.9 ms, response 6.9 ms; transport-only baseline 2-5% of the request).

## Evidence

Medians ms, whole-document request / formatPre end-to-end no-change Edit: 53 lines 1.7 / 5.5; 501 lines 7.0 / 9.9; 3001 lines (73 KB) 33 / 38; 20001 lines (498 KB) 263 / 268; 40001 lines (998 KB) 518 / 578. Realistic denser corpus: 564 lines 7.2 / 12.0; 3036 lines 37 / 48; 19997 lines 257 / 362. Child CPU time equals wall time. Files up to ~1000 lines stay under ~15 ms per Edit; only >= 3000 lines (38-48 ms) and generated 20k-line files (0.27-0.36 s) are noticeable.

## Code locations

- `formatPre` Edit branch (`lsp.format(uri, M)`)
- `DprintLsp.formatNow`

## Approach

No code change. Suggested doc line for `dprint/CLAUDE.md` (and README if wanted): "format_pre on TypeScript performs a full-document parse+print per Write/Edit even when nothing changes, because dprint 0.64.3 / @dprint/typescript 0.96.1 ignore the rangeFormatting range: ~0.3-0.5 ms per KB (~5 ms at 50 lines, ~10 ms at 500, ~40 ms at 3000, ~0.3 s at 20k lines, ~0.6 s at 1 MB)." After each dprint or TS-plugin upgrade, probe whether `textDocument/rangeFormatting` is honoured (unformatted text, range over 2 middle lines vs whole formatting, compare changed lines); if it is, revisit the whole-document-first choice of F01 (note JSON plugin already honours ranges, TS and markdown do not).

## Verification

Docs: `grep -n "per KB" dprint/CLAUDE.md` once added. Re-measure: warm `DprintLsp` child, formatted synthetic .ts of 500/3000/20000 lines, 12 reps, median of `format()` (null result); expect the numbers above within ~10%.

## Constraints

Docs edits in `dprint/CLAUDE.md` / `dprint/plugin/README.md` only; any change under `dprint/` needs a version bump in both `dprint/plugin.json` and `dprint/package.json` (and `pnpm --filter dprint build` must still pass).

## Related

F01 (whole-document-first decision, depends on range being ignored), F09 (dirty-document cost), F08 (large unformatted Edit).
