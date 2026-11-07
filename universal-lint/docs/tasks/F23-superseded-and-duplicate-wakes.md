---
id: F23
title: Superseded and duplicate findings re-wake Claude
status: open
priority: low
area: universal-lint/src/hooks/lint-file.mts (main, lintResolved, recordWrittenFor, recordWritten, fileDigest, writtenDigestPath)
---

# F23 Superseded and duplicate findings re-wake Claude

## Status

Open. real-sessions finding (adjusted: medium → low). The verifier showed that the proposed staleness check loses findings; only a narrower variant is safe. Duplicate suppression needs a user decision.

## Problem

Every Write/Edit lints immediately (no debounce, user decision). Same-file edits come in bursts; a lint that finishes after a newer edit still exits 2 and wakes Claude. Separately, the same findings text is re-emitted on every edit of a file whose problem Claude has not fixed. Each asyncRewake is an extra model turn.
Why "drop the lint if the file changed since it started" is wrong: Edit A's lint is gated to A's lines; if Edit B lands before A's lint finishes, B's lint is gated to B's lines only, so an error A introduced (still present) is reported only by A's lint.

## Evidence

Transcripts: 3154 lintable Write/Edit, 2068 same-file successive pairs, gap median 2.8 s (p25 1.48 s); 523 (16.6%) within 1.5 s (about one lint duration), 1039 within 3 s, 1497 within 10 s. Re-gating 278 historical findings with 0.14.0: 259 would wake Claude, 61 byte-identical to the previous wake for the same file (not re-derived by the verifier). Live: a rewake reaches the model 1.2 s after the edit.

## Code locations

`main` (stderr + exit 2), `recordWrittenFor`/`recordWritten` (digest at lint start), `fileDigest`, `writtenDigestPath`, `lintResolved`.

## Approach

Safe variants only: (1) drop a superseded lint only when it was a whole-file lint (Write, ranges null) and a newer Write/Edit of the same file was recorded after it started, or re-gate the superseded result against the union of both edits' ranges; (2) optional duplicate suppression: hash of the emitted text per real path under CLAUDE_PLUGIN_DATA/emitted/, skip exit 2 when identical within a short window. Ask the user before (2): re-reporting an unfixed problem may be intended.

## Verification

Test: two hook processes, file rewritten between lint start and finish by a full Write → only the newer exits 2; two disjoint Edits → both findings still reported. Duplicate test if (2) ships. Re-mine future transcripts (join `hook_blocking_error.toolUseID`): fewer wakes per lintable edit, no lost findings.

## Constraints

Must never lose a finding for the final file state. No debounce. Version bump.

## Related

F14 (larger source of avoidable wakes), F02 (false wakes), F01 (mining recipe).
