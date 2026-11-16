---
id: F11
title: Test-suite runtime
status: closed
priority: none
area: jevfort/tests
---

## Status

Closed 2026-11-14: measurement record, no code action.

## Problem

Question answered: how long `pnpm --filter jevfort test` takes and whether any test waits on real time.

## Evidence

Proven: 3 runs with `JEV_URL` and `TYPESAFE_API_KEY` unset: 196 tests in 8 files passed; vitest 4.22 s (first, cold) / 1.61 s / 1.64 s, wall 5.11 / 2.47 / 2.47 s, max RSS 298-399 MB. Slowest test: `relevant ... stays fast on a pasted log` 186 ms (a 2 MB prompt on purpose); every other test 43 ms or less. No real-time waits found in the per-test times.

## Code locations

- `tests/*.test.mts`; root `vitest.config.mts`.

## Approach

None.

## Verification

None needed.

## Constraints

None.

## Related

None.
