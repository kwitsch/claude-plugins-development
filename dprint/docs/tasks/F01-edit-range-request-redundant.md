---
id: F01
title: Drop the rangeFormatting request from the Edit path
status: done
priority: none
area: dprint/src/mcp/format.mts (formatPre), dprint/src/mcp/lsp.mts (DprintLsp.format/formatNow)
---

# F01 Drop the rangeFormatting request from the Edit path

## Status

Done (branch feature/performance-analysis-fixes, release dprint 0.8.0). `formatPre` Edit branch sends no `rangeFormatting`; it issues one whole-document `textDocument/formatting` of the edited text M. `DprintLsp.format(uri, text)` has no `range` parameter and no RpcError fallback.

## Problem

The old Edit branch sent `rangeFormatting(M, range)`, then `format(M)` and `format(R)` for verification: three sequential full-document lsp requests, each re-sending the full text via `didOpen`. dprint 0.64.3 with `@dprint/typescript` 0.96.1 ignores the range (a range over one line fixed a dirty line 80 lines away; range result === whole result in every .ts case), so request 1 and 2 computed the same thing. The RpcError->whole() fallback was unreachable with real dprint (it never answers rangeFormatting with a JSON-RPC error; yaml answers `null`, see F02).

## Evidence

Bench (real dprint 0.64.3, N=15, baseline -> patched, formatPre median ms): 500-line .ts needing reformat 20.3 -> 13.0; 3000 lines 109.6 -> 68.6; 20000 lines 862 -> 589; real 732-line format.mts 31.8 -> 20.7. No-change Edits and Writes unchanged (1 request). `updatedInput` byte-identical for every .ts case; 123/123 tests passed unchanged. Per-request cost on a formatted .ts: 300 lines ~4 ms, 3000 lines ~35 ms, 20k lines ~260 ms, 1 MB ~630 ms.
Behaviour changes accepted: `@dprint/json` honours the range, so an Edit on an all-dirty JSON file now yields a whole-file edit (as .ts always did); markdown list-marker Edit now yields dprint's canonical text instead of a not-dprint-clean result; YAML Edits are formatted (F02).

## Code locations

- `formatPre` (Edit branch: `applyEdit`, `lineCursor`, `lsp.format(uri, M)`, `changed`, `trimToEdit`)
- `DprintLsp.format`, `DprintLsp.formatNow` (only `textDocument/formatting` is sent)
- tests: `tests/mcp-server.test.mjs` stub `dprint lsp` (modes `ok`, `range-null`, `hang`, `crash`)

## Approach

Implemented: Edit branch computes M = applyEdit(O, ...), `F = await lsp.format(uri, M)`, `out = changed(F, M)` (null -> `{}`), `r = trimToEdit(O, out, editLines)`, `R = O.replace(r.oldString, () => r.newString)`; verification reuses `out` as the left side (see F03 for when it is skipped). The range computation, `LspRange` use in format.mts and the rangeFormatting + RpcError fallback in lsp.mts were removed.
Trap kept open: if a future dprint/TS plugin honours the range (`rangeHonoured` true), whole-document-first may be revisited; F10 says to re-measure after each plugin upgrade. Known pre-existing gap: a whitespace-only Edit that dprint formats back to the on-disk text gives 0 hunks -> `trimToEdit` null -> `{}` and the sloppy edit lands unformatted (Claude Code rejects old_string == new_string, nothing better is possible).

## Verification

`pnpm --filter dprint build && pnpm --filter dprint test`. Tests: "Edit: only the edited line region comes back", "Edit: whole-file reformat by the stub -> far hunks dropped", "rangeFormatting answering null (yaml plugin) -> Edit still formatted" in `tests/mcp-server.test.mjs`. Optional: assert the stub receives exactly one `textDocument/formatting` and no `rangeFormatting` per changed Edit on a clean file.

## Constraints

Edit `src/`, never `plugin/**/*.mjs`; zero-dep node builtins; fail open (`{}`) on every error; TSDoc on every symbol (`pnpm --filter dprint lint`); version bump in `dprint/plugin.json` AND `dprint/package.json` (already 0.8.0).

## Related

F02 (same change fixes YAML), F03 (stacks: skip verification when lossless, leaving 1 request), F10 (whole-document cost on a no-change Edit remains), F09 (dprint-side cost of dirty documents).
