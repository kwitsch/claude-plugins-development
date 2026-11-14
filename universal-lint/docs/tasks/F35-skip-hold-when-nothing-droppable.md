---
id: F35
title: Skip the settle hold when no held diagnostic can be dropped
status: done
priority: medium
area: universal-lint/src/hooks/lint-file.mts (settleFindings, gateFinding)
---

## Status

Done in 0.16.1 (shipped together with F36). Found by [EVALUATION-2026-11-14](../EVALUATION-2026-11-14.md) "Settle hold" on 0.16.0.

## Problem

`settleFindings` holds every finding for `SETTLE_MS` (5 s) and only then filters it. The filter can drop nothing but own-file diagnostics on a located line (`gateFinding(f, survives, resolved, false)`): diagnostics in other files and text without a located line are kept by design (F34 decision "one rule for foreign and unlocated findings: never dropped"). A lint whose findings consist only of such text is therefore held 5 s and then reported unchanged: Claude wakes 5 s later for no gain, and the hook process stays parked (about 56 MB RSS) for that time.

Typical cases: tsc errors in importing files after an Edit of an exported symbol (the edited file itself type-checks), go vet / cargo diagnostics located in a sibling file or crate, phpstan's table format and any other format the location regexes miss.

## Evidence

0.16.0 against 0.15.30, stub shellcheck, `.sh` Write, 10 runs (EVALUATION-2026-11-14):

| Finding text                                    | 0.15.30 median ms | 0.16.0 median (p90) ms | Output after the hold |
| ----------------------------------------------- | ----------------: | ---------------------: | --------------------- |
| own line (`a.sh:2:6: note: ... [SC2086]`)       |                54 |            5061 (5062) | droppable             |
| foreign file only (`other.sh:3:1: note: ...`)   |           not run |            5081 (5086) | byte-identical        |
| unlocated only (`shellcheck: unlocated-marker`) |           not run |            5078 (5085) | byte-identical        |

0.15.30 has no hold, so the foreign and unlocated rows were run on 0.16.0 only; the 0.15.30 own-line figure (and 0.16.0 with `UNIVERSAL_LINT_SETTLE_MS=0`: 54 ms) is the no-hold reference. Parked hook RSS during the hold: 56.0-56.1 MB.

## Code locations

- `settleFindings`: the early return before `settleWaitMs()`/`sleep`.
- `gateFinding`: its predicate form (third parameter `ranges` as a function) and `keepParseErrors = false` are what the post-hold filter uses.
- Callers unchanged: `lintFileHandler`, `fileChangedHandler`.

## Approach

Before the hold, ask whether the filter could drop anything at all: run `gateFinding(f, () => false, resolved, false)` per finding (a predicate that rejects every own-file located line, the worst case for the finding). When that returns each finding with unchanged text, no later edit can change the result: return `findings` at once, without a hold. Otherwise hold as today; a lint with mixed findings (own-file plus foreign) keeps the hold, so its findings are still reported together.

Cost: one extra gate pass over the finding text (regexes plus memoized `existsSync`), sub-millisecond against a 5 s saving. No change to the journal, the anchor or the hold length.

Update the contract in `.claude/rules/hook-design.md` "Settle window (F34)" (net-neutral wording, the file is over its limit, see F37) and the README sentence "the hook holds them for a 5 second settle window" if it then needs a qualifier.

## Verification

- `tests/settle-process.test.mts` (real hook processes, stub shellcheck, `UNIVERSAL_LINT_SETTLE_MS` 700-2000): a foreign-file-only finding and an unlocated-only finding exit 2 well below the hold; a mixed finding (own line plus foreign) is still held and its own-line part still dropped by a later edit of that line.
- Unit test in `tests/settle.test.mts` for the precheck (own-file located, foreign, unlocated, parse error).
- Re-run the settle bench rows of EVALUATION-2026-11-14 (method in its "How it was measured"): foreign-only and unlocated-only back to the 0.15.30 figure (about 54 ms).
- `pnpm --filter universal-lint build && pnpm --filter universal-lint test && pnpm lint`.

## Result

`settleFindings` runs `gateFinding(f, () => false, resolved, "drop")` per finding before the hold ("drop", not `false` as first drafted: F36 made a parse error droppable, so it keeps the hold) and returns `findings` at once when every finding keeps its text; an error in the precheck holds as before.

Verified by `tests/settle.test.mts` ("findings the filter cannot drop ... are not held", failed before the change: 400 ms hold on foreign/unlocated findings, now under 200 ms; own-line, parse error and mixed findings still held for at least 380 ms) and `tests/settle-process.test.mts` (real hook processes, hold 1500 ms: foreign-only and unlocated-only exit 2 under 1000 ms, mixed exits 2 after at least 1400 ms). The EVALUATION bench rows were not re-run; the test thresholds replace them.

## Constraints

Fail open (any error in the precheck: hold as today). No toggle (CLAUDE.md "No userConfig"). Keeps the F34 user request intact: only findings that the filter cannot drop skip the hold. Version bump.

## Related

F34 (settle window), F23 (superseded and duplicate wakes), F36 (parse errors in the hold), F37 (hook-design.md size).
