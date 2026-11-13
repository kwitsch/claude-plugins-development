---
id: F15
title: Test-suite runtime
status: closed
priority: none
area: jev-api/tests/register.test.mts
---

## Status

Closed 2026-11-13 (measurement record): the suite is fast; the gaps are failure paths, which the open tasks name under Verification.

## Problem

Check whether `pnpm --filter jev-api test` is slow or flaky, and whether the performance-relevant paths are tested.

## Evidence

Proven (vitest, 3 runs with `JEV_URL` unset, 2 with it set, Node v24.22.2):

| Run                                  | Tests                | vitest Duration              | Wall (incl. pnpm) | Max RSS    |
| ------------------------------------ | -------------------- | ---------------------------- | ----------------- | ---------- |
| `JEV_URL` unset (live block skipped) | 68 passed, 4 skipped | 0.51-1.03 s (first run cold) | 1.25-2.06 s       | 187-254 MB |
| `JEV_URL` set (4 live requests)      | 72 passed            | 0.92-1.21 s                  | 1.69-1.95 s       | n/a        |

Slowest offline test 11 ms ("invalid input is rejected without a request"); the live block costs 73-298 ms per test (real requests). The timeout tests use the kit's mock clock, so 20-30 s timeouts cost nothing. Not tested today: a hanging or retried registration (F02, F03), a pre-aborted signal (F05), listener removal (F06), the Haiku `maxTokens` for large questions (F04).

## Code locations

- `tests/register.test.mts`

## Approach

None for runtime. Add the tests named in F02-F07 with those tasks.

## Verification

None.

## Constraints

The live block must stay opt-in (`JEV_URL` in the shell); no URL in the repo.

## Related

F02, F03, F04, F05, F06.
