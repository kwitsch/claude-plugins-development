---
id: F27
title: Test the performance-relevant hook paths
status: open
priority: low
area: universal-lint/tests/*.test.mts, universal-lint/tests/support/lint-hook.mts
---

# F27 Test the performance-relevant hook paths

## Status

Open. static finding (confirmed, low). Companion to the code tasks: add each test together with the task it guards.

## Problem

No test asserts probe counts per process or session, that a hung linter is cut off at its timeout without leaving a grandchild, that output above the 1 MB spawnSync default survives (`MAX_BUFFER_BYTES`), stdin robustness for large or late payloads, multi-file driver behaviour (probe and tsc counts), FileChanged concurrency, or bounded syscall/spawn counts for watchList, gateFinding and the config walks. Regressions in any of the tasks here would pass CI.

## Evidence

grep of tests/*.test.mts for `timeout|maxBuffer|ENOBUFS|sleep|rewrite` matches only manifest.test.mts (hooks.json timeout) and rtk.test.mts (rewrite stubs for routing, 7 tests). skill.test.mts has 11 tests, none counts probes or spawns; truncation.test.mts covers `MAX_CONTEXT_CHARS` only; file-detection.test.mts covers `WATCH_LIMIT` but not cost. Same gap pattern as dprint F28.

## Code locations

tests/rtk.test.mts, skill.test.mts, truncation.test.mts, npx-fallback.test.mts, file-detection.test.mts, tsc.test.mts; tests/support/lint-hook.mts (`recStub`, `rtkStub`).

## Approach

Stub-based tests, each under 1 s:

1. rtk banner (F02): fast-failing rtk `lint` stub → npx runs, no finding.
2. Local bin (F04): `node_modules/.bin/<tool>` stub called, npx not.
3. stdin (F05): 512 KB payload written late through a pipe → linted, digest present.
4. Slots (F10): 20 concurrent FileChanged, max overlap ≤ K.
5. Probe persistence (F11/F17): two fresh processes, one PATH scan / one `rtk rewrite`.
6. Timeout (F18): in-process timeout seam (dprint F28 `timeoutMs` precedent), stub forking `sleep` → `{}`, no surviving child.
7. A stub printing 2 MB plus a located line → finding surfaced and truncated.
8. Driver (F16): 3 .ts files → probe and tsc counts.

## Verification

`pnpm --filter universal-lint build && pnpm --filter universal-lint test`; each new test must fail when the guarded behaviour is broken on purpose.

## Constraints

Tests run against the built plugin/; only test seams go into src; harness stays hermetic (PATH = bash/node/git plus stubs); no production env override; no tight wall-clock budgets (CI flakiness). Version bump only if src changes.

## Related

F02, F04, F05, F10, F11, F16, F17, F18, F21, dprint F28.
