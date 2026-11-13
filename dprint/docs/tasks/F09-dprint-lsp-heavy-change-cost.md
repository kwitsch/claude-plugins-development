---
id: F09
title: dprint lsp formatting cost scales with the amount of change (dprint-side)
status: done
priority: low
area: dprint upstream (crates/dprint/src/commands/lsp/text.rs get_edits); client side: dprint/src/mcp/lsp.mts DprintLsp.formatNow
---

# F09 dprint lsp formatting cost scales with the amount of change (dprint-side)

## Status

Done in 0.12.1: the README sentence (up to ~0.5 s dprint diff deadline, ~0.3-0.5 ms per KB) was added to `plugin/README.md` next to the F08 sentence. Earlier state: Docs-only; not fixable client-side. Current docs: `dprint/plugin/README.md` only has the F08 sentence ("Edits on large files that were never formatted are slow; run `/dprint:dprint fmt` once"); `dprint/CLAUDE.md` and README contain NO sentence about the ~0.5 s dirty-document plateau or the 500 ms diff deadline (verified by grep). Remaining action, if wanted: add that sentence and file the upstream report.

## Problem

`textDocument/formatting` returns a text diff computed inside dprint: `TextDiff::configure().deadline(now + 500 ms).diff_chars(a, b)`; on deadline expiry dprint returns one whole-document edit (second shortcut: formatted text with > 3x the source's newlines). Cost therefore follows the amount of change, not file size, and plateaus at ~clean time + ~500 ms. 500-line all-dirty .ts: 385 ms vs 22.6 ms clean (6.1x slower than `dprint fmt --stdin` at 63 ms); 3000 lines: +4 ms at 1% dirty, +38 at 5%, +153 at 10%, +500 at >= 25%; 2976-line all-dirty file 1.3 s (3 requests) vs 29 ms clean in real sessions (~45x). 20000 lines all-dirty 1.4 s via lsp (CLI 2.2 s, so the CLI loses there). Applies to Writes with a different style than the repo config, FileChanged on files from other tools, and Edits of unformatted files (rangeFormatting is diffed against the full document too).

## Evidence

Source read from dprint main (`crates/dprint/src/commands/lsp/text.rs`). CLI vs lsp matrix: CLI wins only in the 300-3000-line heavily-changed band; for clean documents the lsp is 1.3-4x faster (e.g. 2000 lines clean 24 vs 65 ms). Realistic-file rows (indent/quote style mismatch, 62-66% lines differing) did not complete. Frequency in real work unknown. Burst budget: 50 heavily unformatted 500-line files ~19 s serialized on one child; ~50 x 1 MB JSON (1.1 s each) would reach the 60 s FileChanged hook timeout (`plugin/hooks/hooks.json`; untested).

## Code locations

- `DprintLsp.formatNow` (single `textDocument/formatting` request; the edit set is applied by `applyTextEdits`)
- `fileChanged` queue constants `MAX_ACTIVE_CHANGES`, `MAX_WAITING_CHANGES`, `MAX_CHANGED_BYTES` (bound the burst damage)

## Approach

No plugin code change. (1) Document: all-dirty documents cost up to ~0.5 s extra per format because of dprint's 500 ms char-diff deadline. (2) File upstream at dprint/dprint with two fixtures (500-line and 3000-line all-dirty TS): suggest `diff_lines` or a line-level pre-pass before `diff_chars`, or an earlier size/ratio bail-out. (3) CLI hybrid (`dprint fmt --stdin`) only after a frequency gate: log durations and changed-line fraction in real sessions; only if >= 10% of format_pre calls exceed 200 ms consider racing the CLI against the lsp for Writes of 300-3000 lines; never for clean or > 5000-line documents. `fmt --stdin` ignores .gitignore/excludes, so the plugin's own guards would be needed. The change volume is only known after formatting, so the CLI cannot be chosen a priori.

## Verification

Docs: `grep -n "500 ms" dprint/plugin/README.md dprint/CLAUDE.md` should hit once the sentence is added. Reproduce: generate a clean and an all-dirty 500-line TS (`export const fN = (a: number, b: number) => a + b * N;` vs spaced/no-semicolon variant), time `DprintLsp.format` on both against a real dprint 0.64.x.

## Constraints

Docs edits only in `dprint/plugin/README.md` / `dprint/CLAUDE.md`; any change under `dprint/` still needs a version bump in both `dprint/plugin.json` and `dprint/package.json`. Code (if a hybrid is ever built): `src/`, zero-dep, fail open, TSDoc, `pnpm --filter dprint build && pnpm --filter dprint test`.

## Related

F01, F03 (fewer requests per Edit), F08 (large unformatted Edit), F05 (burst time), F04 (memory of the same big documents).
