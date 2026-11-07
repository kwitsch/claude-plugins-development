---
id: F21
title: Memoize existsSync in gateFinding
status: open
priority: low
area: universal-lint/src/hooks/lint-file.mts (gateFinding, lintResolved)
---

# F21 Memoize existsSync in gateFinding

## Status

Open. static finding (confirmed, low; 9P case absent from real sessions).

## Problem

For every located line with a relative path that is not the edited file, `gateFinding`'s classify step calls `existsSync(abs)` without memoizing per path. With `ranges === null` (Write, FileChanged, driver) the full split/classify pass changes nothing except blank-line normalization. It runs on the untruncated output (up to the 10 MB maxBuffer).

## Evidence

Synthetic tsc output, 1/5 own file, 50 distinct foreign files: ext4 500 diags 2.6-3.6 ms, 20,000 diags (2-2.4 MB) 92-103 ms; base on 9P, 500 diags 975-1151 ms (almost all existsSync). `truncate` on 2.4 MB: 0.4-0.9 ms.

## Code locations

`gateFinding` (classify: `!path.isAbsolute(p) && !existsSync(abs) && resolved.endsWith(path.sep + p)`), called per finding from `lintResolved` before `truncate`.

## Approach

Memoize `existsSync` per abs path in a Map inside `gateFinding`, and evaluate the cheap `resolved.endsWith(sep + p)` before `existsSync`. Short-circuit `ranges === null` only after confirming byte-equal output (truncate collapses 3+ newlines anyway).

## Verification

Existing edit-range gate tests (core/tsc) green; new unit test with repeated foreign paths. 9P 500 diags ≤ about 130 ms.

## Constraints

Edit-range gate semantics are a user decision: unchanged, including the suffix fallback and parse-error keep. Version bump.

## Related

F14 (gate effectiveness), F27.
