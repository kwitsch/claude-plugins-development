---
id: F21
title: Memoize existsSync in gateFinding
status: done
priority: low
area: universal-lint/src/hooks/lint-file.mts (gateFinding, lintResolved)
---

## Status

Shipped in 0.15.18. In `gateFinding`'s classify the pure `resolved.endsWith(path.sep + p)` test now runs before `existsSync(abs)`, so foreign paths never touch the filesystem, and the remaining stats go through a per-call `Map<abs, boolean>` memo (`exists`), fresh for every call, no cross-call cache. Gate semantics unchanged. The `ranges === null` short-circuit was not done: returning the raw finding is not byte-equal (the located path emits `text.split(/\n\s*\n/).join("\n\n")`, which turns a whitespace-only blank line into an empty one), and skipping only `existsSync` under null saves nothing once the reorder is in. Measured (orchestrator check, 2026-11-10, base = the 0.15.17 build): `gateFinding` output byte-identical to the base in 9 cases (synthetic tsc output with own, suffix-own, existing and missing foreign relative paths and absolute lines; 50, 500 and 5000 diagnostics; ranges null, one and two ranges), on ext4 and on 9P (`/mnt/c`); 500 diagnostics, median of 7: ext4 1.6 -> 1.0 ms, 9P 415 -> 2.5 ms.

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
