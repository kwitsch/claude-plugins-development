---
id: F39
title: settle-process.test.mts now sets the test suite's wall time
status: open
priority: low
area: universal-lint/tests/settle-process.test.mts (dev loop, no runtime change)
---

## Status

Open. Found by [EVALUATION-2026-11-14b](../EVALUATION-2026-11-14b.md) "Test suite" on 0.16.1. Test-only, no hook change.

## Problem

`tests/settle-process.test.mts` spawns real hook processes and waits out each settle hold (`UNIVERSAL_LINT_SETTLE_MS` 700-3000 ms per test). Its tests run one after the other, so the file's duration is roughly the sum of the holds. F35 and F36 added four such tests (10 -> 14), which made it the slowest file of the suite. vitest runs the files in parallel, so the slowest file is the suite's wall time: every `pnpm --filter universal-lint test` of every later task pays the extra seconds, several times per task (red, green, review).

The 2026-11-14 evaluation stated "the 39 settle tests add no wall time"; that held for 0.16.0 (file-detection.test.mts was the slowest file) and no longer does.

## Evidence

vitest JSON reporter, same machine and load (load average 7.5-8.4, other processes running), one run each (EVALUATION-2026-11-14b):

| Version | settle-process.test.mts | tests in it | slowest other file             | suite (first start to last end) |
| ------- | ----------------------: | ----------: | ------------------------------ | ------------------------------: |
| 0.16.0  |                  17.4 s |          10 | file-detection.test.mts 22.4 s |                          22.5 s |
| 0.16.1  |                  25.5 s |          14 | file-detection.test.mts 22.1 s |                          25.5 s |

Per-test durations in 0.16.1: 0.09-3.15 s, the sum of the file's tests is 25.5 s; the four new tests take 1.71, 2.22, 2.09 and 2.11 s. Three default-reporter runs of 0.16.1: vitest 24.12-24.47 s (0.16.0 on 2026-11-14 at load about 2: 19.41-19.74 s). The settle-process time is hold-bound (sleeps), so it barely shrinks at low load, while file-detection.test.mts does (its longest test is a fixed 10 s slot give-up); at low load the gap is larger than the 3 s measured here.

## Code locations

- `tests/settle-process.test.mts`: the top-level `test(...)` calls and their `start(...)` helpers with `UNIVERSAL_LINT_SETTLE_MS`.
- Root `vitest.config.mts` (shared by every package; do not change it for one file).

## Approach

Run the independent process tests of this file concurrently (`test.concurrent`, or `describe.concurrent` around them), after checking that each test builds its own fixture (temp project, `CLAUDE_PLUGIN_DATA`, stub linter) and shares no module-level state. Expected: the file drops to about its longest test (about 3-4 s), and the suite wall time falls back to the next slowest file (file-detection.test.mts, about 22 s under load, about 19 s at low load).

If a test's timing assertion (for example "exit under 1000 ms" for the F35 skip, "at least 1400 ms" for a held finding) turns flaky under the extra concurrency, keep that test sequential or widen the hold for it rather than the threshold; do not loosen a threshold so far that it no longer proves the skip.

Alternative if concurrency is not safe: shorten the holds of the tests that only need "held at all" (700 ms is enough where no second edit has to land inside the window).

## Verification

- `pnpm --filter universal-lint test` three times: all tests pass every time; vitest duration below the file-detection.test.mts duration plus 1 s.
- vitest JSON reporter (`npx vitest run --config ../vitest.config.mts --reporter=json --outputFile=<f>` in `universal-lint/`): settle-process.test.mts no longer the slowest file.
- `pnpm lint` exit 0.

## Constraints

Tests only; no change to `src/` or `plugin/`. Every existing assertion stays (no test removed to save time). Any change under `universal-lint/` merged to `main` needs a version bump (root CLAUDE.md), so ship it with another change or bump the patch version.

## Related

F27 (tests of the performance-relevant paths), F34 (settle window), F35 and F36 (added the four tests).
