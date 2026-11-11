---
id: F23
title: Superseded and duplicate findings re-wake Claude
status: done
priority: low
area: universal-lint/docs/tasks/F23-superseded-and-duplicate-wakes.md, universal-lint/docs/TASKS.md
---

## Status

Closed docs-only in 0.15.20. The only safe superseded-lint drop (a newer whole-file lint that reaches a verdict covers an older lint of the same file) still loses findings when that newer lint times out, is killed or skips. A 2026-11-10 local re-mining found 0 same-file pairs with a newer Write within 1.5 s or 3 s, and 7 of the 1934 same-file pairs within 10 s. Duplicate suppression was rejected by the user. No code shipped. 0.15.20 because the root CLAUDE.md version rule applies to any change under `universal-lint/`.

## Problem

Every Write/Edit lints immediately (no debounce, user decision). Same-file edits come in bursts; a lint that finishes after a newer edit still exits 2 and wakes Claude. Separately, the same findings text is re-emitted on every edit of a file whose problem Claude has not fixed. Each asyncRewake is an extra model turn.
Why "drop the lint if the file changed since it started" is wrong: Edit A's lint is gated to A's lines; if Edit B lands before A's lint finishes, B's lint is gated to B's lines only, so an error A introduced (still present) is reported only by A's lint.

## Evidence

Transcripts: 3154 lintable Write/Edit, 2068 same-file successive pairs, gap median 2.8 s (p25 1.48 s); 523 (16.6%) within 1.5 s (about one lint duration), 1039 within 3 s, 1497 within 10 s. Re-gating 278 historical findings with 0.14.0: 259 would wake Claude, 61 byte-identical to the previous wake for the same file (not re-derived by the verifier). Live: a rewake reaches the model 1.2 s after the edit.

### Re-measured

Mined 2026-11-10 over 696 local sessions: 4120 lintable Write/Edit events and 2437 same-file successive pairs. The mining script is kept outside the repo; method: F01 recipe, same-file successive lintable Write/Edit pairs by gap, classified by the kind of the newer tool.

Denominators: 2437 is every same-file successive lintable Write/Edit pair regardless of gap. 1934 is the subset of those pairs with a gap of 10 s or less, all four kind combinations (1895 Edit -> Edit, 1 Edit -> Write, 32 Write -> Edit, 6 Write -> Write). 7 is the newer-Write pairs among those 1934 (1 Edit -> Write + 6 Write -> Write).

- Same-file pairs whose newer call is a Write: 0 within 1.5 s, 0 within 3 s, 7 of the 1934 same-file pairs within 10 s.
- The re-mining finds 717 same-file pairs within 1.5 s, all Edit -> Edit (the original doc's 523 came from the older, unclassified corpus). The narrowed rule keeps both lints of an Edit -> Edit pair by design, so the drop would remove none of them.

## Code locations

`main` (stderr + exit 2), `recordWrittenFor`/`recordWritten` (digest at lint start), `fileDigest`, `writtenDigestPath`, `lintResolved` (returns `{}` for both clean and skipped), `editRanges` (null = whole file: Write, non-Edit, malformed patch), `gateFinding` (range gate; its kept set is monotone in the ranges).

## Decision

Closed docs-only; every PostToolUse lint that finds something still exits 2.

1. Narrowed rule: only a newer whole-file lint (Write; `editRanges` returns null) that reaches a verdict covers an older lint of the same file. A newer Edit is gated to its own hunks and covers nothing beyond them (the Edit A / Edit B counterexample in Problem; the same holds for an older Write followed by a newer Edit). Re-gating against the union of both edits' ranges is monotone in the ranges, so it keeps everything the older gate kept and can never remove a wake.
2. Residual: the drop has to be decided when the older lint finishes, before the newer one has a verdict. If the newer lint then times out, is killed or skips (no config, tool missing, `tsc` budget), a problem still present in the final file state that is reported today is reported by nobody. That breaks "never lose a finding for the final file state", and the drop fires exactly in the same-file burst where CPU contention raises the timeout risk. A done-marker saves nothing without a wait (the newer lint B starts after the older A and runs the same tools, so A normally finishes without a verdict from B to read) and is a forbidden PostToolUse wait with one. A findings hand-off needs a per-path store, ownership and timeout handling: more code than the feature.
3. Measurement: the drop targets newer-Write pairs, and there are almost none (0 within 1.5 s, 0 within 3 s, 7 of the 1934 same-file pairs within 10 s; Re-measured above). The benefit is near zero.
4. Duplicates (USER DECISION 2026-11-10): duplicate suppression is not shipped and gets no follow-up task. Re-reporting an unfixed problem is intended: a byte-identical gated Edit finding means the problem lines were re-touched and left broken, and for a Write the whole-file problem survived a rewrite. A suppressed duplicate becomes a lost finding once context compaction drops the earlier report, which conflicts with "never lose a finding for the final file state". The original "short window" is a time window, which the no-debounce decision rules out. The window-free variant needs a clean-vs-skipped verdict channel out of `lintResolved` plus an `emitted/` store, for an unverified 61 of 259.

### Alternatives considered

- A. Whole-file drop with a `.write` marker: a PostToolUse whole-file lint (`editRanges(input) === null`) writes `written/<hashPath(real)>.write` (`session_id`, cwd, `randomUUID()`) next to the digest; after `lintFileHandler` returns, `main` drops the exit 2 if the marker no longer holds its own UUID. Safe against the Edit counterexample (a newer Edit never writes the marker). Rejected (USER DECISION 2026-11-10): when the newer Write's lint times out, is killed or skips, the older lint's still-present findings are reported by nobody; measured benefit near zero.
- A2. Drop only after the newer lint signals "done with a verdict" (done-marker): without a wait it saves nothing; with a wait it is a PostToolUse wait, forbidden by the no-debounce decision of 2026-11-06.
- A3. Hand-off, A passes its findings to B and B reports the union: removes the loss but needs a per-path findings store, ownership and timeout handling across processes; more code than the feature.
- B. Re-gate the older result against the union of both edits' ranges: `gateFinding` keeps a finding if it hits any range, so a union can never remove a wake; line numbers shifted by the newer edit make it unsafe anyway. Useless.
- C. Naive staleness drop ("file changed since start"): loses findings, see the Edit A / Edit B counterexample in Problem. Already rejected by the verifier.
- D. Duplicate suppression (hash of emitted text per real path under `CLAUDE_PLUGIN_DATA/emitted/`): rejected by the user, reasons in Decision item 4.

## Verification

No code changed, so no new tests. The rebuilt `plugin/hooks/lint-file.mjs` is byte-identical; the existing suite stays green.

## Constraints

Must never lose a finding for the final file state. No debounce. A reopened drop must not decide before the covering lint has a verdict, and must not wait on PostToolUse. Version bump.

## Reopen trigger

- Superseded drop: re-mine 0.15.x transcripts (F01 recipe, join `hook_blocking_error.toolUseID`); reopen only if same-file pairs whose newer call is a Write within 1.5 s reach >= 5% of same-file pairs (all-gap total, the same convention as the original 523 (16.6%) of 2068) AND a verdict-safe design without a PostToolUse wait exists.
- Duplicate suppression: reopen only on a verified >= 25% byte-identical consecutive wakes for the same file in a 0.15.x re-mining AND a user request for fewer reminders.

## Related

F14 (larger source of avoidable wakes), F02 (false wakes), F01 (mining recipe), F13 (FileChanged dedup that is not a debounce).
