---
id: F36
title: A held parse error is reported although a later edit fixed its cause on another line
status: open
priority: low
area: bug - universal-lint/src/hooks/lint-file.mts (settleFindings, gateFinding, PARSE_ERROR_RE)
---

## Status

Open. Documented since 0.16.0 as residual (9) of `.claude/rules/hook-design.md` "Settle window (F34)" ("Open (found by the final code review, not fixed)") with a candidate fix but no task; reproduced by [EVALUATION-2026-11-14](../EVALUATION-2026-11-14.md) "Bug hunt".

## Problem

A parse error is usually reported away from its cause: an unclosed quote or brace is reported at the end of the file. The settle filter keeps a held diagnostic unless a later edit rewrote exactly the line it is reported on, so the typical repair (the next Edit closes the quote on the line where it was opened) does not drop the held parse error, and Claude is woken for an error that is already gone. This is the case F34 was asked to suppress ("a finding that the next edit already repaired never wakes Claude").

## Evidence

Repro on 0.16.0 (scratch `parse-repro.mjs`, stub shellcheck, default 5 s hold):

1. Write `a.sh` with an unclosed quote on line 2; the stub reports `a.sh:4:1: error: Couldn't find end of string [SC1009]` (line 4 = EOF).
2. 1 s later an Edit replaces line 2 (`echo "$1` -> `echo "$1"`); its lint is clean (exit 0 after 49 ms).
3. The Write's hook exits 2 after 5064 ms with `universal-lint: shellcheck found issues in a.sh: a.sh:4:1: error: Couldn't find end of string [SC1009]`.

## Code locations

- `settleFindings`: `survives` (line carried through every later record) and the `gateFinding(f, survives, resolved, false)` call.
- `gateFinding`: the `keepParseErrors` parameter and the `PARSE_ERROR_RE` test on the segment and the paragraph preamble.

## Approach

The candidate from hook-design.md: when at least one later journal record exists, an own-file diagnostic whose segment or paragraph preamble matches `PARSE_ERROR_RE` counts as superseded regardless of its line. This is safe in the same sense as the line rule: every later lint keeps parse errors outside its edit range (`gateFinding`'s default `keepParseErrors = true`), so a parse error that persists after the later edit is reported by that edit's own lint. One way: turn `keepParseErrors` into a three-way mode (keep / treat as ordinary / always drop) and pass "always drop" from `settleFindings` when `later.length > 0`.

Residuals unchanged: a later lint that dies, times out or finds no tool loses the earlier parse error (F34 residual (2), accepted by the request). Not in scope: the second half of residual (9), a late FileChanged echo journaling a whole-file edit, which loses nothing (the FileChanged lint re-reports).

## Verification

- `tests/settle-process.test.mts`: the repro above exits 0 (no wake); a later edit that does not fix the parse error still gets it reported (by the later lint); an edit after a non-parse own-line finding on another line still keeps that finding.
- Unit tests in `tests/settle.test.mts` for the new mode of `gateFinding`.
- `pnpm --filter universal-lint build && pnpm --filter universal-lint test && pnpm lint`.

## Constraints

Fail open; no toggle; version bump. Update residual (9) in `hook-design.md` (net-neutral wording, see F37).

## Related

F34 (settle window), F23 (supersession), F35 (hold precheck: a parse error counts as droppable there).
